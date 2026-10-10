import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UntrustedContentGuardStatus,
  assessUntrustedContentInfluenceV1,
  normalizeUntrustedContentSourceV1,
} from '../src/core/untrusted-content-guard.js';

const T0 = '2026-09-25T02:45:00.000Z';
const T1 = '2026-09-25T02:46:00.000Z';
const T2 = '2026-09-25T02:47:00.000Z';
const SHA = 'b'.repeat(64);

function source(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: 'source-web-1',
    sourceKind: 'WEB_PAGE',
    sourceOrigin: 'https://example.com',
    artifactRef: {
      schemaVersion: 1,
      artifactId: 'artifact-untrusted-1',
      kind: 'web-snapshot',
      uri: 'artifact://web/source-web-1',
      mediaType: 'text/html',
      sha256: SHA,
      sizeBytes: 1024,
      createdAt: T0,
      producerInvocationId: null,
      sensitive: false,
    },
    observedAt: T0,
    ...overrides,
  };
}

function ceiling(overrides = {}) {
  return {
    schemaVersion: 1,
    envelopeId: 'ceiling-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    allowedCapabilityIds: ['web.read', 'project.write'],
    allowedToolIds: ['browser.inspect', 'project.save'],
    allowedProviderIds: ['browser', 'project'],
    allowedOutboundOrigins: ['https://example.com', 'https://api.example.net'],
    createdAt: T0,
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    schemaVersion: 1,
    influenceId: 'influence-1',
    agentId: 'agent-1',
    jobId: 'job-1',
    sourceId: 'source-web-1',
    sourceArtifactId: 'artifact-untrusted-1',
    sourceSha256: SHA,
    sourceObservedAt: T0,
    requestedCapabilityIds: ['web.read'],
    requestedToolIds: ['browser.inspect'],
    requestedProviderIds: ['browser'],
    requestedCredentialRefIds: [],
    outboundOrigins: ['https://example.com'],
    createdAt: T1,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    source: source(),
    ceiling: ceiling(),
    proposal: proposal(),
    assessedAt: T2,
    ...overrides,
  };
}

test('untrusted content remains data and a within-ceiling proposal grants no authority', () => {
  const result = assessUntrustedContentInfluenceV1(request());

  assert.equal(result.status, UntrustedContentGuardStatus.SAFE_FOR_POLICY);
  assert.equal(result.contentTrust, 'UNTRUSTED_DATA');
  assert.equal(result.instructionAuthority, 'NONE');
  assert.equal(result.authorityAmplificationAllowed, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.policyDecisionGranted, false);
  assert.equal(result.credentialSelectionAuthorized, false);
  assert.equal(result.requiresCanonicalPolicyDecision, true);
  assert.equal(result.requiresCanonicalProviderAdmission, true);
  assert.equal(result.requiresCanonicalVerificationForConsequentialEffects, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.signals, []);
  assert.equal(result.sourceSha256, SHA);
  assert.equal(result.sourceObservedAt, T0);
});

test('explicitly allowed cross-origin influence is surfaced but still only safe for policy', () => {
  const result = assessUntrustedContentInfluenceV1(request({
    proposal: proposal({ outboundOrigins: ['https://api.example.net'] }),
  }));

  assert.equal(result.status, UntrustedContentGuardStatus.SAFE_FOR_POLICY);
  assert.deepEqual(result.signals, ['CROSS_ORIGIN_OUTBOUND']);
  assert.deepEqual(result.violations, []);
  assert.equal(result.executionAuthorized, false);
});

test('outbound destination not in the explicit ceiling fails closed and reports cross-origin signal', () => {
  const result = assessUntrustedContentInfluenceV1(request({
    proposal: proposal({ outboundOrigins: ['https://attacker.invalid'] }),
  }));

  assert.equal(result.status, UntrustedContentGuardStatus.BLOCKED);
  assert.deepEqual(result.signals, ['CROSS_ORIGIN_OUTBOUND']);
  assert.deepEqual(result.violations, [{
    code: 'OUTBOUND_ORIGIN_ESCALATION',
    values: [],
  }]);
});

test('capability, tool and provider authority cannot be added by external content', () => {
  const result = assessUntrustedContentInfluenceV1(request({
    proposal: proposal({
      requestedCapabilityIds: ['web.read', 'gmail.send'],
      requestedToolIds: ['browser.inspect', 'gmail.send'],
      requestedProviderIds: ['browser', 'gmail'],
      outboundOrigins: [],
    }),
  }));

  assert.equal(result.status, UntrustedContentGuardStatus.BLOCKED);
  assert.deepEqual(result.violations, [
    { code: 'CAPABILITY_AUTHORITY_ESCALATION', values: [] },
    { code: 'TOOL_AUTHORITY_ESCALATION', values: [] },
    { code: 'PROVIDER_AUTHORITY_ESCALATION', values: [] },
  ]);
});

test('untrusted content cannot select even an opaque credential reference', () => {
  const result = assessUntrustedContentInfluenceV1(request({
    proposal: proposal({
      requestedCredentialRefIds: ['credential-owner-mail'],
      outboundOrigins: [],
    }),
  }));

  assert.equal(result.status, UntrustedContentGuardStatus.BLOCKED);
  assert.deepEqual(result.violations, [{
    code: 'UNTRUSTED_CREDENTIAL_SELECTION',
    values: [],
  }]);
  assert.equal(result.credentialSelectionAuthorized, false);
});

test('network egress from a source without network provenance is surfaced deterministically', () => {
  const result = assessUntrustedContentInfluenceV1(request({
    source: source({ sourceKind: 'DOCUMENT', sourceOrigin: '' }),
    proposal: proposal({ outboundOrigins: ['https://api.example.net'] }),
  }));

  assert.equal(result.status, UntrustedContentGuardStatus.SAFE_FOR_POLICY);
  assert.deepEqual(result.signals, ['UNATTRIBUTED_SOURCE_OUTBOUND']);
});

test('proposal identity, provenance and chronology are causally bound', () => {
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      proposal: proposal({ agentId: 'agent-other' }),
    })),
    /identity does not match authority ceiling/,
  );
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      proposal: proposal({ sourceId: 'source-other' }),
    })),
    /sourceId does not match source/,
  );
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      source: source({ observedAt: T2 }),
      proposal: proposal({ sourceObservedAt: T2 }),
    })),
    /proposal predates source observation/,
  );
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      ceiling: ceiling({ createdAt: T2 }),
    })),
    /proposal predates authority ceiling/,
  );
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({ assessedAt: T0 })),
    /assessment predates proposal/,
  );
});

test('proposal is bound to exact source artifact, digest and observation boundary', () => {
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      source: source({
        artifactRef: { ...source().artifactRef, artifactId: 'artifact-untrusted-other' },
      }),
    })),
    /exact source material observation/,
  );

  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      source: source({
        artifactRef: { ...source().artifactRef, sha256: 'c'.repeat(64) },
      }),
    })),
    /exact source material observation/,
  );

  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      source: source({ observedAt: T1 }),
    })),
    /exact source material observation/,
  );
});

test('source requires exact material provenance and never accepts noncanonical origin aliases', () => {
  const normalized = normalizeUntrustedContentSourceV1(source());
  assert.equal(normalized.contentTrust, 'UNTRUSTED_DATA');
  assert.equal(normalized.instructionAuthority, 'NONE');
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.artifactRef), true);

  assert.throws(
    () => normalizeUntrustedContentSourceV1(source({ sourceOrigin: 'https://example.com/' })),
    /canonical HTTP\(S\) origin/,
  );
  assert.throws(
    () => normalizeUntrustedContentSourceV1(source({
      artifactRef: { ...source().artifactRef, sha256: '' },
    })),
    /requires sha256/,
  );
  assert.throws(
    () => normalizeUntrustedContentSourceV1(source({
      artifactRef: { ...source().artifactRef, sizeBytes: 0 },
    })),
    /requires non-empty material/,
  );
});

test('authority envelopes reject accessors, hidden fields, symbols and array getter execution', () => {
  let reads = 0;
  const hostileRequest = request();
  Object.defineProperty(hostileRequest, 'proposal', {
    enumerable: true,
    get() {
      reads += 1;
      return proposal();
    },
  });
  assert.throws(
    () => assessUntrustedContentInfluenceV1(hostileRequest),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  const hiddenProposal = proposal();
  Object.defineProperty(hiddenProposal, 'policyDecision', {
    enumerable: false,
    value: 'ALLOW',
  });
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({ proposal: hiddenProposal })),
    /contains an unknown field/,
  );

  const symbolCeiling = ceiling();
  symbolCeiling[Symbol('allow')] = true;
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({ ceiling: symbolCeiling })),
    /contains an unknown field/,
  );

  const capabilities = new Proxy(['web.read'], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = assessUntrustedContentInfluenceV1(request({
    proposal: proposal({ requestedCapabilityIds: capabilities }),
  }));
  assert.equal(result.status, UntrustedContentGuardStatus.SAFE_FOR_POLICY);
  assert.equal(reads, 0);
});

test('untrusted proposal cannot smuggle owner-policy or execution fields through exact schema', () => {
  for (const [field, value] of [
    ['policyDecision', 'ALLOW'],
    ['executionAuthorized', true],
    ['instructionAuthority', 'OWNER'],
    ['credentialSecret', 'not-a-real-secret'],
  ]) {
    assert.throws(
      () => assessUntrustedContentInfluenceV1(request({
        proposal: { ...proposal(), [field]: value },
      })),
      /contains an unknown field/,
    );
  }
});

test('unknown untrusted schema keys never leak names or invoke getters in diagnostics', () => {
  const marker = 'PRIVATE_OWNER_SECRET_MARKER_812';
  const contaminated = proposal();
  Object.defineProperty(contaminated, marker, {
    enumerable: false,
    value: 'OWNER_ALLOW',
  });
  const input = request({ proposal: contaminated });
  assert.throws(() => assessUntrustedContentInfluenceV1(input), error => {
    assert.match(error.message, /contains an unknown field/);
    assert.doesNotMatch(error.message, /PRIVATE_OWNER_SECRET_MARKER_812|OWNER_ALLOW/);
    return true;
  });
  const persisted = JSON.parse(JSON.stringify(request({
    proposal: { ...proposal(), [marker]: 'OWNER_ALLOW' },
  })));
  assert.throws(() => assessUntrustedContentInfluenceV1(persisted), error => {
    assert.match(error.message, /contains an unknown field/);
    assert.doesNotMatch(JSON.stringify({ error: error.message }), /PRIVATE_OWNER_SECRET_MARKER_812/);
    return true;
  });
  const symbol = proposal();
  symbol[Symbol('PRIVATE_ACCESS_TOKEN_LABEL')] = 'ALLOW';
  assert.throws(() => assessUntrustedContentInfluenceV1(request({ proposal: symbol })),
    error => /contains an unknown field/.test(error.message) && !error.message.includes('PRIVATE_ACCESS_TOKEN_LABEL'));

  let reads = 0;
  const getters = proposal();
  Object.defineProperty(getters, marker, {
    enumerable: true,
    get() { reads += 1; throw new Error('PRIVATE_GETTER_EXECUTED'); },
  });
  assert.throws(() => assessUntrustedContentInfluenceV1(request({ proposal: getters })),
    /contains an unknown field/);
  assert.equal(reads, 0);
  assert.equal(assessUntrustedContentInfluenceV1(request()).executionAuthorized, false);
});

test('arrays are dense, bounded and exact without coercion', () => {
  const sparse = [];
  sparse.length = 2;
  sparse[1] = 'web.read';
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      proposal: proposal({ requestedCapabilityIds: sparse }),
    })),
    /must not be sparse/,
  );

  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      proposal: proposal({ requestedCapabilityIds: [' web.read'] }),
    })),
    /is invalid/,
  );

  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({
      ceiling: ceiling({
        allowedOutboundOrigins: Array.from({ length: 129 }, (_, index) => `https://x${index}.example`),
      }),
    })),
    /bounded plain array/,
  );
});

test('all denied escalation kinds redact attacker-controlled names across persisted restart', () => {
  const secret = 'SECRET_OWNER_POLICY_REFERENCE_313';
  const input = request({
    proposal: proposal({
      requestedCapabilityIds: ['web.read', secret],
      requestedToolIds: ['browser.inspect', secret],
      requestedProviderIds: ['browser', secret],
      outboundOrigins: ['https://secret-owner-policy-reference-313.invalid'],
      requestedCredentialRefIds: [secret],
    }),
  });
  const denied = assessUntrustedContentInfluenceV1(input);
  assert.equal(denied.status, UntrustedContentGuardStatus.BLOCKED);
  assert.deepEqual(denied.violations.map(item => item.code), [
    'CAPABILITY_AUTHORITY_ESCALATION',
    'TOOL_AUTHORITY_ESCALATION',
    'PROVIDER_AUTHORITY_ESCALATION',
    'OUTBOUND_ORIGIN_ESCALATION',
    'UNTRUSTED_CREDENTIAL_SELECTION',
  ]);
  assert.ok(denied.violations.every(item => Array.isArray(item.values) && item.values.length === 0));
  assert.doesNotMatch(JSON.stringify(denied), /SECRET_OWNER_POLICY_REFERENCE_313|secret-owner-policy-reference-313/u);
  assert.equal(denied.executionAuthorized, false);
  assert.equal(denied.policyDecisionGranted, false);
  assert.equal(denied.instructionAuthority, 'NONE');
  assert.deepEqual(assessUntrustedContentInfluenceV1(structuredClone(input)), denied);
  assert.equal(Object.isFrozen(denied.violations), true);
});

test('credential selection denial cannot echo untrusted reference data through logs or restart', () => {
  const hostileRef = 'SECRET_CREDENTIAL_REFERENCE_OWNER';
  const input = request({
    proposal: proposal({ requestedCredentialRefIds: [hostileRef], outboundOrigins: [] }),
  });
  const denied = assessUntrustedContentInfluenceV1(input);
  assert.equal(denied.status, UntrustedContentGuardStatus.BLOCKED);
  assert.deepEqual(denied.violations, [{ code: 'UNTRUSTED_CREDENTIAL_SELECTION', values: [] }]);
  assert.equal(denied.credentialSelectionAuthorized, false);
  assert.equal(denied.executionAuthorized, false);
  assert.equal(denied.policyDecisionGranted, false);
  assert.equal(denied.instructionAuthority, 'NONE');
  assert.doesNotMatch(JSON.stringify(denied), /SECRET_CREDENTIAL_REFERENCE_OWNER/u);
  assert.deepEqual(assessUntrustedContentInfluenceV1(structuredClone(input)), denied);
});

test('explicit null authority and credential lists fail closed instead of becoming empty permissions', () => {
  const cases = [
    { ceiling: ceiling({ allowedCapabilityIds: null }) },
    { ceiling: ceiling({ allowedToolIds: null }) },
    { ceiling: ceiling({ allowedProviderIds: null }) },
    { ceiling: ceiling({ allowedOutboundOrigins: null }) },
    { proposal: proposal({ requestedCapabilityIds: null }) },
    { proposal: proposal({ requestedToolIds: null }) },
    { proposal: proposal({ requestedProviderIds: null }) },
    { proposal: proposal({ requestedCredentialRefIds: null }) },
    { proposal: proposal({ outboundOrigins: null }) },
  ];
  for (const override of cases) {
    const input = request(override);
    assert.throws(() => assessUntrustedContentInfluenceV1(input), /bounded plain array/);
    assert.throws(() => assessUntrustedContentInfluenceV1(structuredClone(input)), /bounded plain array/);
  }
  const allowed = assessUntrustedContentInfluenceV1(request({
    proposal: proposal({ requestedCredentialRefIds: [], outboundOrigins: [] }),
  }));
  assert.equal(allowed.status, UntrustedContentGuardStatus.SAFE_FOR_POLICY);
  assert.equal(allowed.executionAuthorized, false);
  assert.equal(allowed.instructionAuthority, 'NONE');
});


test('S2 explicit null source origin is not silently downgraded to missing provenance', () => {
  const input = request({ source: source({ sourceOrigin: null }) });
  assert.throws(() => assessUntrustedContentInfluenceV1(input), /canonical HTTP\(S\) origin/);
  assert.throws(() => assessUntrustedContentInfluenceV1(JSON.parse(JSON.stringify(input))),
    /canonical HTTP\(S\) origin/);
  const omitted = source();
  delete omitted.sourceOrigin;
  const safe = assessUntrustedContentInfluenceV1(request({ source: omitted }));
  assert.equal(safe.contentTrust, 'UNTRUSTED_DATA');
  assert.equal(safe.instructionAuthority, 'NONE');
  assert.equal(safe.executionAuthorized, false);
  assert.equal(safe.policyDecisionGranted, false);
});

test('S2 hostile proxy inspection exceptions never echo untrusted content or authorize policy', () => {
  const marker = 'PRIVATE_SOURCE_TRAP_MESSAGE';
  const cases = [
    new Proxy(request(), { ownKeys() { throw Error(marker); } }),
    request({ source: new Proxy(source(), {
      getOwnPropertyDescriptor() { throw Error(marker); },
    }) }),
    request({ proposal: proposal({
      requestedToolIds: new Proxy([], { getPrototypeOf() { throw Error(marker); } }),
    }) }),
    request({ ceiling: ceiling({
      allowedCapabilityIds: new Proxy([], { ownKeys() { throw Error(marker); } }),
    }) }),
  ];
  for (const input of cases) {
    assert.throws(() => assessUntrustedContentInfluenceV1(input),
      error => error instanceof Error && !error.message.includes(marker));
  }
  const valid = request();
  const assessed = assessUntrustedContentInfluenceV1(valid);
  assert.equal(assessed.instructionAuthority, 'NONE');
  assert.equal(assessed.executionAuthorized, false);
  assert.equal(assessed.policyDecisionGranted, false);
  assert.deepEqual(assessed, assessUntrustedContentInfluenceV1(JSON.parse(JSON.stringify(valid))));
});

test('S2 explicit undefined authority/proposal lists are malformed rather than silently omitted', () => {
  const fields = [
    ['ceiling', 'allowedCapabilityIds'],
    ['ceiling', 'allowedToolIds'],
    ['ceiling', 'allowedProviderIds'],
    ['ceiling', 'allowedOutboundOrigins'],
    ['proposal', 'requestedCapabilityIds'],
    ['proposal', 'requestedToolIds'],
    ['proposal', 'requestedProviderIds'],
    ['proposal', 'requestedCredentialRefIds'],
    ['proposal', 'outboundOrigins'],
  ];
  for (const [objectKey, field] of fields) {
    const malformed = request();
    malformed[objectKey][field] = undefined;
    assert.throws(() => assessUntrustedContentInfluenceV1(malformed), /bounded plain array/);
    assert.throws(() => assessUntrustedContentInfluenceV1(structuredClone(malformed)), /bounded plain array/);
    const nullRestart = request();
    nullRestart[objectKey][field] = null;
    assert.throws(
      () => assessUntrustedContentInfluenceV1(JSON.parse(JSON.stringify(nullRestart))),
      /bounded plain array/,
    );
  }

  const sourceWithoutOrigin = request();
  sourceWithoutOrigin.source.sourceOrigin = undefined;
  assert.throws(() => assessUntrustedContentInfluenceV1(sourceWithoutOrigin), /canonical HTTP\(S\) origin/);
  assert.throws(() => assessUntrustedContentInfluenceV1(structuredClone(sourceWithoutOrigin)), /canonical HTTP\(S\) origin/);

  const legacy = request();
  delete legacy.source.sourceOrigin;
  for (const field of fields.filter(([objectKey]) => objectKey === 'proposal').map(([, field]) => field)) {
    delete legacy.proposal[field];
  }
  const assessed = assessUntrustedContentInfluenceV1(legacy);
  assert.equal(assessed.status, UntrustedContentGuardStatus.SAFE_FOR_POLICY);
  assert.equal(assessed.instructionAuthority, 'NONE');
  assert.equal(assessed.executionAuthorized, false);
  assert.equal(assessed.policyDecisionGranted, false);
  assert.equal(assessed.credentialSelectionAuthorized, false);
  assert.deepEqual(assessed, assessUntrustedContentInfluenceV1(JSON.parse(JSON.stringify(legacy))));
});


test('S2 assessment object getter and hostile descriptor traps fail without leaking diagnostics', () => {
  const marker = 'PRIVATE_INJECTION_TRAP_MUST_NOT_LEAK_410';
  let getterReads = 0;
  const inputWithGetter = request();
  Object.defineProperty(inputWithGetter, 'proposal', {
    enumerable: true,
    get() { getterReads += 1; throw new Error(marker); },
  });
  assert.throws(() => assessUntrustedContentInfluenceV1(inputWithGetter), error => {
    assert.match(error.message, /enumerable own data property/u);
    assert.doesNotMatch(error.message, /PRIVATE_INJECTION_TRAP_MUST_NOT_LEAK_410/u);
    return true;
  });
  assert.equal(getterReads, 0);

  const hostile = new Proxy(proposal(), {
    ownKeys() { throw new Error(marker); },
  });
  assert.throws(() => assessUntrustedContentInfluenceV1(request({ proposal: hostile })), error => {
    assert.match(error.message, /property descriptors cannot be safely inspected/u);
    assert.doesNotMatch(error.message, /PRIVATE_INJECTION_TRAP_MUST_NOT_LEAK_410/u);
    return true;
  });

  const persisted = JSON.parse(JSON.stringify(request({
    proposal: proposal({ requestedCredentialRefIds: ['credential.owner-secret'] }),
  })));
  const denied = assessUntrustedContentInfluenceV1(persisted);
  assert.equal(denied.status, UntrustedContentGuardStatus.BLOCKED);
  assert.equal(denied.executionAuthorized, false);
  assert.equal(denied.credentialSelectionAuthorized, false);
  assert.equal(denied.instructionAuthority, 'NONE');
  assert.deepEqual(denied.violations.map(item => item.code), ['UNTRUSTED_CREDENTIAL_SELECTION']);
  assert.doesNotMatch(JSON.stringify(denied), /credential.owner-secret/u);
});


test('S2 exact source digest must reject noncanonical upper/whitespace aliases before policy', () => {
  const exact = request();
  assert.equal(assessUntrustedContentInfluenceV1(exact).status, UntrustedContentGuardStatus.SAFE_FOR_POLICY);
  for (const sha256 of [SHA.toUpperCase(), ' ' + SHA, SHA + '\\n']) {
    const hostile = request({ source: source({ artifactRef: { ...source().artifactRef, sha256 } }) });
    assert.throws(() => assessUntrustedContentInfluenceV1(hostile), /canonical lowercase sha256/);
    assert.equal(hostile.proposal?.executionAuthorized, undefined);
  }
  assert.equal(assessUntrustedContentInfluenceV1(JSON.parse(JSON.stringify(exact))).executionAuthorized, false);
});
