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
    values: ['https://attacker.invalid'],
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
    { code: 'CAPABILITY_AUTHORITY_ESCALATION', values: ['gmail.send'] },
    { code: 'TOOL_AUTHORITY_ESCALATION', values: ['gmail.send'] },
    { code: 'PROVIDER_AUTHORITY_ESCALATION', values: ['gmail'] },
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
    values: ['credential-owner-mail'],
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
    /unknown field: policyDecision/,
  );

  const symbolCeiling = ceiling();
  symbolCeiling[Symbol('allow')] = true;
  assert.throws(
    () => assessUntrustedContentInfluenceV1(request({ ceiling: symbolCeiling })),
    /unknown field: Symbol\(allow\)/,
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
      new RegExp(`unknown field: ${field}`),
    );
  }
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
