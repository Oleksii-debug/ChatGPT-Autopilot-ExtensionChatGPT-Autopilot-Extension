import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ObservationStatus,
  PolicyDecisionKind,
  VerificationStatus,
  capabilityV1FromRegistry,
  normalizeArtifactRefV1,
  normalizeCapabilityV1,
  normalizeCredentialRefV1,
  normalizeObservationV1,
  normalizePolicyDecisionV1,
  normalizeSpecialistHandoffV1,
  normalizeToolDescriptorV1,
  normalizeToolInvocationV1,
  normalizeVerificationV1,
  toolDescriptorV1FromAgentProvider,
  assertToolInvocationAuthorizedV1,
  assertSpecialistHandoffScopedV1,
} from '../src/core/universal-agent-contracts.js';
import {
  AgentProviderId,
  CapabilityId,
  getAgentProvider,
} from '../src/core/capability-registry.js';

const AT = '2026-09-19T03:00:00Z';


test('Plan-1 S1: empty optional effect and approval references cannot be erased on restart', () => {
  const cases = [
    [normalizePolicyDecisionV1, {
      schemaVersion: 1, decisionId: 'decision-empty-ref',
      invocationId: 'invoke-empty-ref', decision: PolicyDecisionKind.ALLOW,
      reasonCode: 'OWNER_OK', decidedAt: AT,
    }, ['approvalId']],
    [normalizeToolInvocationV1, {
      schemaVersion: 1, invocationId: 'invoke-empty-ref', toolId: 'fs.read',
      providerId: 'native-companion', requestedCapabilityIds: ['filesystem.read'],
      policyDecisionId: 'decision-empty-ref', arguments: {}, createdAt: AT,
    }, ['parentInvocationId']],
    [normalizeArtifactRefV1, {
      schemaVersion: 1, artifactId: 'artifact-empty-ref', kind: 'file',
      uri: 'artifact://run/empty-ref', createdAt: AT,
    }, ['producerInvocationId']],
    [normalizeVerificationV1, {
      schemaVersion: 1, verificationId: 'verification-empty-ref',
      invocationId: 'invoke-empty-ref', status: VerificationStatus.NOT_APPLICABLE,
      reasonCode: 'NO_EFFECT', verifiedAt: AT,
    }, ['observationId', 'verifierId', 'verificationAuthorityId', 'effectId', 'executionId']],
    [normalizeSpecialistHandoffV1, {
      schemaVersion: 1, handoffId: 'handoff-empty-ref',
      specialistId: 'specialist-empty-ref', goal: 'Check persisted references',
      requestedCapabilityIds: ['filesystem.read'], createdAt: AT,
    }, ['parentInvocationId']],
  ];
  for (const [normalize, original, optionalKeys] of cases) {
    const legacy = normalize(original);
    assert.deepEqual(normalize(JSON.parse(JSON.stringify(legacy))), legacy,
      'canonical absent references must remain compatible after cold JSON restart');
    for (const key of optionalKeys) {
      const corrupt = { ...original, [key]: '' };
      assert.throws(() => normalize(corrupt), error => {
        assert.match(error.message, new RegExp(key + ' is invalid'));
        return true;
      }, key + ' must not silently become an absent durable identity');
      assert.deepEqual(corrupt, { ...original, [key]: '' },
        'rejected identity may not mutate incoming persisted data');
      const present = normalize({ ...original, ...(key === 'approvalId' ? { decision: PolicyDecisionKind.REQUIRE_APPROVAL } : {}), [key]: 'known-ref-1' });
      assert.equal(present[key], 'known-ref-1');
      assert.deepEqual(normalize(JSON.parse(JSON.stringify(present))), present,
        'a real exact reference must survive restart without aliasing');
    }
  }
});


test('Plan-1 S1: credential scope authority stays exact and unique across restart', () => {
  const base = credential();
  const accepted = normalizeCredentialRefV1({
    ...base, scope: ['drive.file', 'drive.metadata.readonly'],
  });
  assert.deepEqual(accepted.scope, ['drive.file', 'drive.metadata.readonly']);
  assert.ok(Object.isFrozen(accepted.scope));
  assert.deepEqual(normalizeCredentialRefV1(JSON.parse(JSON.stringify(accepted))), accepted,
    'canonical scope authority must be stable through a cold JSON restart');

  for (const scope of [
    [' drive.file'], ['drive.file '], ['drive.file\t'],
    ['drive.file', 'drive.file'], ['drive.file', ' drive.file'],
  ]) {
    const corrupt = credential({ scope });
    const prior = JSON.parse(JSON.stringify(corrupt));
    assert.throws(() => normalizeCredentialRefV1(corrupt), /scope/,
      'credential scope must never be trimmed or deduplicated into new authority');
    assert.deepEqual(corrupt, prior, 'failed credential admission must not mutate caller data');
    assert.throws(() => normalizeCredentialRefV1(JSON.parse(JSON.stringify(corrupt))), /scope/,
      'persisted corrupt scope must remain rejected after cold restart');
  }

  const secret = 'UNTRUSTED_SCOPE_SECRET_MUST_NOT_LEAK';
  assert.throws(() => normalizeCredentialRefV1(credential({ scope: [secret + ' '] })), error => {
    assert.doesNotMatch(error.message, /UNTRUSTED_SCOPE_SECRET_MUST_NOT_LEAK/);
    return true;
  });
});

test('Plan-1 S1: credential expiry cannot be erased by empty timestamp on recovery', () => {
  const legacy = credential();
  delete legacy.expiresAt;
  const absent = normalizeCredentialRefV1(legacy);
  assert.equal(absent.expiresAt, null);
  assert.deepEqual(normalizeCredentialRefV1(JSON.parse(JSON.stringify(absent))), absent);
  for (const expiresAt of ['', ' ', 0, false]) {
    const corrupt = { ...legacy, expiresAt };
    assert.throws(() => normalizeCredentialRefV1(corrupt), /expiresAt must be an ISO timestamp/);
    assert.deepEqual(corrupt, { ...legacy, expiresAt },
      'rejected expiration must not mutate durable credential references');
  }
  const active = normalizeCredentialRefV1({ ...legacy, expiresAt: '2026-09-19T04:00:00Z' });
  assert.ok(Object.isFrozen(active));
  assert.equal(active.expiresAt, '2026-09-19T04:00:00.000Z');
  assert.deepEqual(normalizeCredentialRefV1(JSON.parse(JSON.stringify(active))), active);
});

test('Plan-1 S1: corrupt capability risk metadata cannot downgrade on restart', () => {
  const legacy = { schemaVersion: 1, capabilityId: 'fs.read' };
  const absent = normalizeCapabilityV1(legacy);
  assert.equal(absent.riskClass, 'R0');
  assert.deepEqual(absent.attributes, {});
  assert.deepEqual(normalizeCapabilityV1(JSON.parse(JSON.stringify(absent))), absent);
  for (const [key, value] of [
    ['riskClass', null], ['riskClass', undefined],
    ['attributes', null], ['attributes', undefined],
  ]) {
    const corrupt = { ...legacy, [key]: value };
    assert.throws(() => normalizeCapabilityV1(corrupt), error => {
      assert.match(error.message, /riskClass must be text|attributes contains corrupt explicitly present data/);
      return true;
    }, 'corrupt explicit capability authority must not be normalized to a default');
    assert.deepEqual(corrupt, { ...legacy, [key]: value });
  }
  const explicit = normalizeCapabilityV1({
    ...legacy, riskClass: 'R2', attributes: { userApproved: false, scope: ['workspace.read'] },
  });
  assert.equal(explicit.riskClass, 'R2');
  assert.equal(Object.isFrozen(explicit.attributes.scope), true);
  assert.deepEqual(normalizeCapabilityV1(JSON.parse(JSON.stringify(explicit))), explicit);
});

test('Plan-1 S1: observation data presence is exact across cold restart and corruption', () => {
  const base = {
    schemaVersion: 1, observationId: 'obs-data-presence',
    invocationId: 'invoke-data-presence', status: ObservationStatus.OK,
    observedAt: AT,
  };
  const legacy = normalizeObservationV1(base);
  assert.deepEqual(legacy.data, {}, 'only absent legacy data may be defaulted');
  assert.deepEqual(normalizeObservationV1(JSON.parse(JSON.stringify(legacy))), legacy);

  for (const bad of [null, undefined]) {
    const corrupt = { ...base, data: bad };
    assert.throws(() => normalizeObservationV1(corrupt), error => {
      assert.match(error.message, /data contains corrupt explicitly present data/);
      assert.doesNotMatch(error.message, /invocation-data-presence/);
      return true;
    }, 'explicit corruption must not become empty success evidence');
    assert.deepEqual(corrupt, { ...base, data: bad }, 'input must not be mutated');
  }

  const healthy = normalizeObservationV1({
    ...base,
    data: { result: { evidenceId: 'effect-record-1', unchanged: true } },
  });
  assert.ok(Object.isFrozen(healthy));
  assert.ok(Object.isFrozen(healthy.data.result));
  assert.equal(healthy.data.result.evidenceId, 'effect-record-1');
  assert.deepEqual(normalizeObservationV1(JSON.parse(JSON.stringify(healthy))), healthy,
    'valid nested observation evidence must survive an exact JSON restart');
});


test('Plan-1 S1: artifact location identity survives JSON restart without whitespace or control-byte aliases', () => {
  const canonical = artifact({ artifactId: 'artifact-uri-stable', uri: 'artifact://job-1/report.txt' });
  const normalized = normalizeArtifactRefV1(canonical);
  assert.equal(normalized.uri, canonical.uri);
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(normalizeArtifactRefV1(JSON.parse(JSON.stringify(normalized))), normalized);

  const hostile = [
    ' ' + canonical.uri,
    canonical.uri + ' ',
    '\t' + canonical.uri,
    canonical.uri + '\n',
    canonical.uri + '\u0000',
    canonical.uri + '\u007f',
    '',
    null,
    undefined,
    42,
    'x'.repeat(4097),
  ];
  for (const value of hostile) {
    const bad = { ...canonical, uri: value };
    assert.throws(() => normalizeArtifactRefV1(bad), error => {
      assert.match(error.message, /uri must be an exact canonical artifact location/);
      assert.doesNotMatch(error.message, /job-1\/report/);
      return true;
    }, 'corrupt artifact locations must fail closed rather than change on restart');
    assert.throws(() => normalizeObservationV1({
      schemaVersion: 1, observationId: 'obs-uri', invocationId: 'invoke-uri',
      status: ObservationStatus.OK, artifactRefs: [bad], observedAt: AT,
    }), /uri must be an exact canonical artifact location/);
    assert.throws(() => normalizeSpecialistHandoffV1({
      schemaVersion: 1, handoffId: 'handoff-uri', specialistId: 'specialist-uri',
      goal: 'Read independently evidenced artifact', requestedCapabilityIds: ['filesystem.read'],
      artifactRefs: [bad], credentialRefs: [], createdAt: AT,
    }), /uri must be an exact canonical artifact location/);
  }

  const observation = normalizeObservationV1({
    schemaVersion: 1, observationId: 'obs-uri-valid', invocationId: 'invoke-uri',
    status: ObservationStatus.OK, artifactRefs: [canonical], observedAt: AT,
  });
  assert.equal(observation.artifactRefs[0].uri, canonical.uri);
  assert.deepEqual(normalizeObservationV1(JSON.parse(JSON.stringify(observation))), observation);
});

test('Plan-1 S1: hostile Proxy reflection traps never disclose secret error text or authorize evidence', () => {
  const secret = 'PRIVATE-AGENT-CONTRACT-PROXY-DIAGNOSTIC-SECRET';
  let trapInvocations = 0;
  const failTrap = () => {
    trapInvocations += 1;
    throw new Error(secret);
  };
  const assertRedacted = error => {
    assert.match(error.message, /cannot be safely inspected/);
    assert.doesNotMatch(error.message, /PRIVATE-AGENT-CONTRACT-PROXY-DIAGNOSTIC-SECRET/);
    return true;
  };

  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const source = {
      schemaVersion: 1, capabilityId: 'cap-owner-read',
      description: 'Read only', riskClass: 'R0', attributes: {},
    };
    const hostile = new Proxy(source, { [trap]: failTrap });
    assert.throws(() => normalizeCapabilityV1(hostile), assertRedacted,
      trap + ' must fail closed before any capability is admitted');
  }

  const invocation = {
    schemaVersion: 1, invocationId: 'invoke-proxy-trap',
    toolId: 'file.read', providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'], policyDecisionId: 'decision-1',
    arguments: { fileRef: 'workspace:report.txt' }, createdAt: AT,
  };
  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const hostileList = new Proxy(['filesystem.read'], { [trap]: failTrap });
    assert.throws(
      () => normalizeToolInvocationV1({ ...invocation, requestedCapabilityIds: hostileList }),
      assertRedacted,
      trap + ' must fail closed for authority-bearing capability arrays',
    );
  }

  for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
    const hostileArgs = new Proxy({ fileRef: 'workspace:report.txt' }, { [trap]: failTrap });
    assert.throws(() => normalizeToolInvocationV1({ ...invocation, arguments: hostileArgs }),
      assertRedacted, trap + ' must fail closed for nested effect arguments');
  }
  assert.equal(trapInvocations, 9, 'each negative case must reach exactly one hostile reflection trap');

  const legal = normalizeToolInvocationV1(invocation);
  assert.equal(legal.arguments.fileRef, 'workspace:report.txt');
  assert.equal(Object.isFrozen(legal.arguments), true);
  assert.equal(Object.isFrozen(legal.requestedCapabilityIds), true);
  assert.deepEqual(normalizeToolInvocationV1(JSON.parse(JSON.stringify(legal))), legal,
    'valid authority-free contract normalization remains stable after JSON cold restart');
});

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: 'artifact-1',
    kind: 'text-report',
    uri: 'artifact://run-1/report.txt',
    mediaType: 'text/plain',
    sha256: 'a'.repeat(64),
    sizeBytes: 123,
    createdAt: AT,
    producerInvocationId: 'invoke-1',
    sensitive: false,
    ...overrides,
  };
}

function credential(overrides = {}) {
  return {
    schemaVersion: 1,
    credentialId: 'cred-1',
    brokerId: 'native-broker',
    kind: 'oauth',
    scope: ['drive.file'],
    expiresAt: '2026-09-19T04:00:00Z',
    ...overrides,
  };
}

test('Plan-1: specialist handoff resource ceilings distinguish absent legacy data from corrupt persisted values', () => {
  const base = {
    schemaVersion: 1,
    handoffId: 'handoff-resource-fence-1',
    specialistId: 'specialist-1',
    goal: 'Read an owner-scoped document',
    requestedCapabilityIds: ['filesystem.read'],
    artifactRefs: [],
    credentialRefs: [],
    createdAt: AT,
  };
  const legacy = normalizeSpecialistHandoffV1(base);
  for (const key of ['maxModelCalls', 'maxRuntimeSeconds', 'maxCostUsdMicros']) {
    assert.equal(legacy[key], 0, key + ' legacy absence must keep its documented default');
  }
  assert.equal(Object.isFrozen(legacy), true);

  for (const key of ['maxModelCalls', 'maxRuntimeSeconds', 'maxCostUsdMicros']) {
    for (const value of [null, undefined, -0, -1, 1.5, Number.NaN, Infinity, '10']) {
      assert.throws(
        () => normalizeSpecialistHandoffV1({ ...base, [key]: value }),
        new RegExp(key + ' is invalid'),
        key + ' must reject an explicitly present non-canonical resource ceiling',
      );
    }
  }

  const explicit = normalizeSpecialistHandoffV1({
    ...base,
    maxModelCalls: 3,
    maxRuntimeSeconds: 120,
    maxCostUsdMicros: 500,
  });
  const restarted = normalizeSpecialistHandoffV1(JSON.parse(JSON.stringify(explicit)));
  assert.deepEqual(restarted, explicit, 'cold restart must preserve exact resource ceilings');
  assert.equal(Object.isFrozen(restarted), true);
  assert.throws(
    () => normalizeSpecialistHandoffV1({ ...JSON.parse(JSON.stringify(explicit)), maxCostUsdMicros: null }),
    /maxCostUsdMicros is invalid/,
    'a corrupt post-restart budget may not be replaced with an implicit default',
  );
});

test('nested contract data and list boundaries reject accessors without executing them', () => {
  let reads = 0;

  const capabilities = ['filesystem.read'];
  Object.defineProperty(capabilities, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'filesystem.read';
    },
  });
  assert.throws(() => normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 'invoke-array-accessor',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: capabilities,
    policyDecisionId: 'decision-1',
    arguments: {},
    createdAt: AT,
  }), /data properties/);
  assert.equal(reads, 0, 'array entry getter must never execute');

  const nested = {};
  Object.defineProperty(nested, 'pathRef', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'workspace:README.md';
    },
  });
  assert.throws(() => normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 'invoke-nested-accessor',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: { request: nested },
    createdAt: AT,
  }), /enumerable own data properties/);
  assert.equal(reads, 0, 'nested JSON getter must never execute');

  const hiddenKnown = {
    schemaVersion: 1,
    decisionId: 'decision-hidden',
    invocationId: 'invoke-1',
    decision: PolicyDecisionKind.DENY,
    reasonCode: 'OWNER_DENY',
    decidedAt: AT,
  };
  Object.defineProperty(hiddenKnown, 'decision', {
    enumerable: false,
    configurable: true,
    value: PolicyDecisionKind.ALLOW,
  });
  assert.throws(() => normalizePolicyDecisionV1(hiddenKnown), /enumerable own data properties/);

  const sparse = [];
  sparse.length = 1;
  assert.throws(() => normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 'invoke-sparse-capabilities',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: sparse,
    policyDecisionId: 'decision-1',
    arguments: {},
    createdAt: AT,
  }), /dense data-only array/);

  assert.throws(() => normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 'invoke-nonfinite-json',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: { score: Number.NaN },
    createdAt: AT,
  }), /non-finite number/);

  const protoNamedArguments = {};
  Object.defineProperty(protoNamedArguments, '__proto__', {
    enumerable: true,
    configurable: true,
    value: { marker: 'data-not-prototype' },
  });
  const normalizedProtoNamed = normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 'invoke-proto-named-json',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: protoNamedArguments,
    createdAt: AT,
  });
  assert.equal(Object.getPrototypeOf(normalizedProtoNamed.arguments), Object.prototype);
  assert.equal(Object.hasOwn(normalizedProtoNamed.arguments, '__proto__'), true);
  assert.deepEqual(normalizedProtoNamed.arguments.__proto__, { marker: 'data-not-prototype' });
});

test('CapabilityV1 and ToolDescriptorV1 adapt existing registry truth without creating a second registry', () => {
  const provider = getAgentProvider(AgentProviderId.CHATGPT_BROWSER);
  const tool = toolDescriptorV1FromAgentProvider(provider, {
    toolId: 'chatgpt.submit',
    description: 'Existing hardened browser interaction authority.',
  });
  assert.equal(tool.providerId, AgentProviderId.CHATGPT_BROWSER);
  assert.deepEqual(tool.capabilityIds, provider.capabilities);
  assert.equal(tool.capabilityIds.includes(CapabilityId.VERIFIED_PROMPT_SUBMIT), true);
  assert.ok(Object.isFrozen(tool));

  const capability = capabilityV1FromRegistry(CapabilityId.VERIFIED_PROMPT_SUBMIT, {
    description: 'Verified prompt submission through existing Core authority.',
    riskClass: 'R1',
  });
  assert.equal(capability.capabilityId, CapabilityId.VERIFIED_PROMPT_SUBMIT);
  assert.equal(capability.riskClass, 'R1');
});

test('generic contracts reject unknown authority-bearing fields instead of silently widening semantics', () => {
  assert.throws(() => normalizeCapabilityV1({
    schemaVersion: 1,
    capabilityId: 'filesystem.read',
    description: 'Read',
    riskClass: 'R1',
    attributes: {},
    arbitraryAdminPower: true,
  }), /unknown field/);

  assert.throws(() => normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: 'fs.read',
    providerId: 'native-companion',
    label: 'Read file',
    capabilityIds: ['filesystem.read'],
    readOnly: true,
    shell: 'powershell -Command *',
  }), /unknown field/);
});

test('ToolDescriptorV1 requires unique bounded capabilities and ToolInvocationV1 binds policy decision before execution', () => {
  assert.throws(() => normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: 'fs.read',
    providerId: 'native-companion',
    label: 'Read file',
    capabilityIds: ['filesystem.read', 'filesystem.read'],
  }), /duplicates/);

  const invocation = normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 'invoke-1',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: { pathRef: 'workspace:README.md' },
    createdAt: AT,
  });
  assert.equal(invocation.policyDecisionId, 'decision-1');
  assert.deepEqual(invocation.arguments, { pathRef: 'workspace:README.md' });
  assert.ok(Object.isFrozen(invocation));

  assert.throws(() => normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 'invoke-2',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: '',
    arguments: {},
    createdAt: AT,
  }), /policyDecisionId/);
});

test('universal authority and evidence identifiers reject leading or trailing whitespace aliases', () => {
  const baseInvocation = {
    schemaVersion: 1,
    invocationId: 'invoke-1',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: {},
    createdAt: AT,
  };

  for (const [field, value] of [
    ['invocationId', ' invoke-1'],
    ['toolId', 'fs.read '],
    ['providerId', ' native-companion'],
    ['policyDecisionId', 'decision-1 '],
  ]) {
    assert.throws(
      () => normalizeToolInvocationV1({ ...baseInvocation, [field]: value }),
      /invalid/u,
      `${field} must not be normalized from a whitespace alias`,
    );
  }

  assert.throws(
    () => normalizeToolInvocationV1({
      ...baseInvocation,
      requestedCapabilityIds: [' filesystem.read'],
    }),
    /invalid/u,
  );

  assert.throws(
    () => normalizeArtifactRefV1(artifact({ artifactId: ' artifact-1' })),
    /artifactId is invalid/u,
  );
  assert.throws(
    () => normalizeArtifactRefV1(artifact({ producerInvocationId: 'invoke-1 ' })),
    /producerInvocationId is invalid/u,
  );

  assert.throws(
    () => normalizePolicyDecisionV1({
      schemaVersion: 1,
      decisionId: ' decision-1',
      invocationId: 'invoke-1',
      decision: PolicyDecisionKind.DENY,
      reasonCode: 'OWNER_DENY',
      decidedAt: AT,
    }),
    /decisionId is invalid/u,
  );

  assert.throws(
    () => normalizeCredentialRefV1(credential({ credentialId: 'cred-1 ' })),
    /credentialId is invalid/u,
  );

  const canonical = normalizeToolInvocationV1(baseInvocation);
  assert.equal(canonical.invocationId, 'invoke-1');
  assert.equal(canonical.toolId, 'fs.read');
  assert.equal(canonical.providerId, 'native-companion');
  assert.equal(canonical.policyDecisionId, 'decision-1');
});

test('PolicyDecisionV1 approval authority is explicit and cannot appear on allow/deny decisions', () => {
  const approval = normalizePolicyDecisionV1({
    schemaVersion: 1,
    decisionId: 'decision-approval',
    invocationId: 'invoke-1',
    decision: PolicyDecisionKind.REQUIRE_APPROVAL,
    reasonCode: 'RISK_R2',
    reason: 'Owner approval required.',
    approvalId: 'approval-1',
    decidedAt: AT,
  });
  assert.equal(approval.approvalId, 'approval-1');

  assert.throws(() => normalizePolicyDecisionV1({
    schemaVersion: 1,
    decisionId: 'decision-bad',
    invocationId: 'invoke-1',
    decision: PolicyDecisionKind.REQUIRE_APPROVAL,
    reasonCode: 'RISK_R2',
    decidedAt: AT,
  }), /requires approvalId/);

  assert.throws(() => normalizePolicyDecisionV1({
    schemaVersion: 1,
    decisionId: 'decision-bad-2',
    invocationId: 'invoke-1',
    decision: PolicyDecisionKind.ALLOW,
    reasonCode: 'POLICY_OK',
    approvalId: 'approval-should-not-exist',
    decidedAt: AT,
  }), /only valid/);
});

test('ArtifactRefV1 is bounded evidence metadata, not embedded artifact bytes', () => {
  const value = normalizeArtifactRefV1(artifact());
  assert.equal(value.sha256, 'a'.repeat(64));
  assert.equal(value.uri, 'artifact://run-1/report.txt');

  assert.throws(() => normalizeArtifactRefV1(artifact({ sha256: 'not-a-digest' })), /sha256/);
  assert.throws(() => normalizeArtifactRefV1({
    ...artifact(),
    bytesBase64: 'AAAA',
  }), /unknown field/);
});

test('ObservationV1 can reference normalized artifacts and VerificationV1 binds to exact observation/invocation', () => {
  const observation = normalizeObservationV1({
    schemaVersion: 1,
    observationId: 'obs-1',
    invocationId: 'invoke-1',
    status: ObservationStatus.OK,
    summary: 'Read completed.',
    data: { bytesRead: 123 },
    artifactRefs: [artifact()],
    observedAt: AT,
  });
  assert.equal(observation.artifactRefs.length, 1);
  assert.equal(observation.artifactRefs[0].artifactId, 'artifact-1');

  const verification = normalizeVerificationV1({
    schemaVersion: 1,
    verificationId: 'verify-1',
    invocationId: 'invoke-1',
    observationId: 'obs-1',
    status: VerificationStatus.VERIFIED,
    reasonCode: 'POSTCONDITION_MATCH',
    summary: 'Expected postcondition observed.',
    evidenceArtifactIds: ['artifact-1'],
    verifiedAt: AT,
    verifierId: 'independent-verifier-1',
    verificationAuthorityId: 'decision-1',
    effectId: 'invoke-1',
    executionId: 'invoke-1:attempt:1',
    attempt: 1,
  });
  assert.equal(verification.observationId, observation.observationId);
  assert.deepEqual({
    verifierId: verification.verifierId,
    verificationAuthorityId: verification.verificationAuthorityId,
    effectId: verification.effectId,
    executionId: verification.executionId,
    attempt: verification.attempt,
  }, {
    verifierId: 'independent-verifier-1',
    verificationAuthorityId: 'decision-1',
    effectId: 'invoke-1',
    executionId: 'invoke-1:attempt:1',
    attempt: 1,
  });

  assert.throws(() => normalizeVerificationV1({
    schemaVersion: 1,
    verificationId: 'verify-bad',
    invocationId: 'invoke-1',
    observationId: '',
    status: VerificationStatus.VERIFIED,
    reasonCode: 'POSTCONDITION_MATCH',
    verifiedAt: AT,
  }), /observationId/);
});

test('CredentialRefV1 is opaque: secret/token/password/value fields are structurally impossible', () => {
  const value = normalizeCredentialRefV1(credential());
  assert.deepEqual(value.scope, ['drive.file']);
  assert.equal(JSON.stringify(value).includes('token'), false);

  for (const forbidden of ['token', 'secret', 'password', 'value']) {
    assert.throws(() => normalizeCredentialRefV1({
      ...credential(),
      [forbidden]: 'sensitive-material',
    }), /unknown field/);
  }
});

test('SpecialistHandoffV1 grants only explicit requested capabilities and opaque references with bounded budgets', () => {
  const handoff = normalizeSpecialistHandoffV1({
    schemaVersion: 1,
    handoffId: 'handoff-1',
    specialistId: 'coding-specialist',
    goal: 'Repair the bounded workspace defect and return evidence.',
    requestedCapabilityIds: ['workspace.read', 'workspace.write'],
    artifactRefs: [artifact()],
    credentialRefs: [credential()],
    maxModelCalls: 20,
    maxRuntimeSeconds: 1800,
    maxCostUsdMicros: 2_000_000,
    createdAt: AT,
    parentInvocationId: 'invoke-parent',
  });
  assert.deepEqual(handoff.requestedCapabilityIds, ['workspace.read', 'workspace.write']);
  assert.equal(handoff.maxModelCalls, 20);
  assert.equal(handoff.credentialRefs[0].credentialId, 'cred-1');

  assert.throws(() => normalizeSpecialistHandoffV1({
    schemaVersion: 1,
    handoffId: 'handoff-empty',
    specialistId: 'coding-specialist',
    goal: 'Do work.',
    requestedCapabilityIds: [],
    createdAt: AT,
  }), /must not be empty/);

  assert.throws(() => normalizeSpecialistHandoffV1({
    schemaVersion: 1,
    handoffId: 'handoff-admin',
    specialistId: 'coding-specialist',
    goal: 'Do work.',
    requestedCapabilityIds: ['workspace.read'],
    createdAt: AT,
    unrestrictedCapabilities: true,
  }), /unknown field/);
});

test('nested invalid evidence and credential references fail the whole contract', () => {
  assert.throws(() => normalizeObservationV1({
    schemaVersion: 1,
    observationId: 'obs-bad',
    invocationId: 'invoke-1',
    status: 'OK',
    artifactRefs: [artifact({ sha256: 'bad' })],
    observedAt: AT,
  }), /artifactRefs\[0\]/);

  assert.throws(() => normalizeSpecialistHandoffV1({
    schemaVersion: 1,
    handoffId: 'handoff-bad',
    specialistId: 'coding-specialist',
    goal: 'Do work.',
    requestedCapabilityIds: ['workspace.read'],
    credentialRefs: [{ ...credential(), token: 'leak' }],
    createdAt: AT,
  }), /credentialRefs\[0\].*unknown field/);
});

test('large unbounded invocation data is rejected', () => {
  assert.throws(() => normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 'invoke-large',
    toolId: 'generic.tool',
    providerId: 'provider-1',
    requestedCapabilityIds: ['generic.read'],
    policyDecisionId: 'decision-1',
    arguments: { payload: 'x'.repeat(300_000) },
    createdAt: AT,
  }), /too large/);
});


test('normalized authority envelopes are recursively immutable', () => {
  const observation = normalizeObservationV1({
    schemaVersion: 1,
    observationId: 'obs-frozen',
    invocationId: 'invoke-frozen',
    status: 'OK',
    data: { nested: { value: 1 } },
    artifactRefs: [artifact()],
    observedAt: AT,
  });
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.data), true);
  assert.equal(Object.isFrozen(observation.data.nested), true);
  assert.equal(Object.isFrozen(observation.artifactRefs), true);
  assert.equal(Object.isFrozen(observation.artifactRefs[0]), true);
  assert.throws(() => { observation.data.nested.value = 2; }, TypeError);
});

test('nested reference collections reject non-array shapes with stable contract errors', () => {
  assert.throws(() => normalizeObservationV1({
    schemaVersion: 1,
    observationId: 'obs-shape',
    invocationId: 'invoke-1',
    status: 'OK',
    artifactRefs: 'artifact-1',
    observedAt: AT,
  }), /artifactRefs must be a bounded plain array/);

  assert.throws(() => normalizeSpecialistHandoffV1({
    schemaVersion: 1,
    handoffId: 'handoff-shape',
    specialistId: 'coding-specialist',
    goal: 'Do work.',
    requestedCapabilityIds: ['workspace.read'],
    credentialRefs: { credentialId: 'cred-1' },
    createdAt: AT,
  }), /credentialRefs must be a bounded plain array/);
});


test('Tool invocation authorization consistency blocks mismatched decision, provider and capability amplification', () => {
  const tool = {
    schemaVersion: 1,
    toolId: 'fs.read',
    providerId: 'native-companion',
    label: 'Read workspace file',
    capabilityIds: ['filesystem.read'],
    readOnly: true,
  };
  const invocation = {
    schemaVersion: 1,
    invocationId: 'invoke-auth-1',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-auth-1',
    arguments: { pathRef: 'workspace:README.md' },
    createdAt: AT,
  };
  const decision = {
    schemaVersion: 1,
    decisionId: 'decision-auth-1',
    invocationId: 'invoke-auth-1',
    decision: 'ALLOW',
    reasonCode: 'POLICY_OK',
    decidedAt: AT,
  };

  const authorized = assertToolInvocationAuthorizedV1({
    invocation,
    policyDecision: decision,
    toolDescriptor: tool,
    grantedCapabilityIds: ['filesystem.read'],
  });
  assert.equal(authorized.invocation.invocationId, 'invoke-auth-1');
  assert.equal(Object.isFrozen(authorized), true);

  assert.throws(() => assertToolInvocationAuthorizedV1({
    invocation,
    policyDecision: { ...decision, decision: 'DENY' },
    toolDescriptor: tool,
    grantedCapabilityIds: ['filesystem.read'],
  }), /not authorized/);

  assert.throws(() => assertToolInvocationAuthorizedV1({
    invocation,
    policyDecision: { ...decision, decisionId: 'decision-other' },
    toolDescriptor: tool,
    grantedCapabilityIds: ['filesystem.read'],
  }), /policyDecisionId does not match/);

  assert.throws(() => assertToolInvocationAuthorizedV1({
    invocation: { ...invocation, providerId: 'other-provider' },
    policyDecision: decision,
    toolDescriptor: tool,
    grantedCapabilityIds: ['filesystem.read'],
  }), /providerId does not match/);

  assert.throws(() => assertToolInvocationAuthorizedV1({
    invocation: { ...invocation, requestedCapabilityIds: ['filesystem.write'] },
    policyDecision: decision,
    toolDescriptor: { ...tool, capabilityIds: ['filesystem.read', 'filesystem.write'] },
    grantedCapabilityIds: ['filesystem.read'],
  }), /exceeds granted capabilities/);
});

test('Specialist handoff cannot amplify parent capability grant', () => {
  const handoff = {
    schemaVersion: 1,
    handoffId: 'handoff-scope-1',
    specialistId: 'coding-specialist',
    goal: 'Inspect and patch bounded workspace code.',
    requestedCapabilityIds: ['workspace.read', 'workspace.write'],
    createdAt: AT,
  };
  assert.equal(
    assertSpecialistHandoffScopedV1(handoff, ['workspace.read', 'workspace.write', 'tests.run']).handoffId,
    'handoff-scope-1',
  );
  assert.throws(
    () => assertSpecialistHandoffScopedV1(handoff, ['workspace.read']),
    /exceeds granted capabilities/,
  );
});

test('untrusted universal-agent contracts fail closed on type-coerced authority and evidence fields', () => {
  for (const schemaVersion of ['1', true]) {
    assert.throws(() => normalizeCapabilityV1({
      schemaVersion,
      capabilityId: 'filesystem.read',
      description: 'Read',
      riskClass: 'R1',
      attributes: {},
    }), /schemaVersion/);
  }

  assert.throws(() => normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 1,
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: {},
    createdAt: AT,
  }), /invocationId must be text/);

  assert.throws(() => normalizePolicyDecisionV1({
    schemaVersion: 1,
    decisionId: 'decision-1',
    invocationId: 'invoke-1',
    decision: true,
    reasonCode: 'POLICY_OK',
    decidedAt: AT,
  }), /decision must be text/);

  assert.throws(() => normalizeObservationV1({
    schemaVersion: 1,
    observationId: 'obs-1',
    invocationId: 'invoke-1',
    status: true,
    observedAt: AT,
  }), /status must be text/);

  assert.throws(() => normalizeArtifactRefV1(artifact({ sha256: 123 })), /sha256 must be text/);
  assert.throws(() => normalizeArtifactRefV1(artifact({ sizeBytes: '123' })), /sizeBytes is invalid/);
  assert.throws(() => normalizeArtifactRefV1(artifact({ sizeBytes: '' })), /sizeBytes is invalid/);

  assert.throws(() => normalizeVerificationV1({
    schemaVersion: 1,
    verificationId: 'verify-1',
    invocationId: 'invoke-1',
    observationId: 'obs-1',
    status: VerificationStatus.VERIFIED,
    reasonCode: 'POSTCONDITION_MATCH',
    verifiedAt: AT,
    attempt: '1',
  }), /attempt is invalid/);
});

test('universal-agent contract objects reject exotic prototypes and symbol authority while allowing null-prototype data records', () => {
  const exotic = Object.create({
    schemaVersion: 1,
    capabilityId: 'filesystem.admin',
    riskClass: 'R0',
  });
  exotic.description = 'Inherited authority must not be trusted.';
  exotic.attributes = {};
  assert.throws(() => normalizeCapabilityV1(exotic), /plain object/);

  const symbolAuthority = {
    schemaVersion: 1,
    capabilityId: 'filesystem.read',
    description: 'Read',
    riskClass: 'R1',
    attributes: {},
  };
  symbolAuthority[Symbol('admin')] = true;
  assert.throws(() => normalizeCapabilityV1(symbolAuthority), /unknown field/);

  const nullPrototype = Object.assign(Object.create(null), {
    schemaVersion: 1,
    capabilityId: 'filesystem.read',
    description: 'Read',
    riskClass: 'R1',
    attributes: {},
  });
  const normalized = normalizeCapabilityV1(nullPrototype);
  assert.equal(normalized.capabilityId, 'filesystem.read');
  assert.equal(normalized.riskClass, 'R1');
});



test('universal-agent contract boundary rejects accessor-backed and hidden fields without executing getters', () => {
  let decisionReads = 0;
  const policy = {
    schemaVersion: 1,
    decisionId: 'decision-accessor',
    invocationId: 'invoke-accessor',
    reasonCode: 'POLICY_OK',
    decidedAt: AT,
  };
  Object.defineProperty(policy, 'decision', {
    enumerable: true,
    configurable: true,
    get() {
      decisionReads += 1;
      return decisionReads === 1 ? 'DENY' : 'ALLOW';
    },
  });
  assert.throws(() => normalizePolicyDecisionV1(policy), /own data properties/);
  assert.equal(decisionReads, 0, 'decision getter must never execute at the authority boundary');

  let statusReads = 0;
  const observation = {
    schemaVersion: 1,
    observationId: 'obs-accessor',
    invocationId: 'invoke-accessor',
    observedAt: AT,
  };
  Object.defineProperty(observation, 'status', {
    enumerable: true,
    configurable: true,
    get() {
      statusReads += 1;
      return 'OK';
    },
  });
  assert.throws(() => normalizeObservationV1(observation), /own data properties/);
  assert.equal(statusReads, 0, 'status getter must never execute at the evidence boundary');

  let digestReads = 0;
  const artifactWithAccessor = artifact();
  Object.defineProperty(artifactWithAccessor, 'sha256', {
    enumerable: true,
    configurable: true,
    get() {
      digestReads += 1;
      return '0'.repeat(64);
    },
  });
  assert.throws(() => normalizeArtifactRefV1(artifactWithAccessor), /own data properties/);
  assert.equal(digestReads, 0, 'evidence digest getter must never execute');

  const hiddenAuthority = {
    schemaVersion: 1,
    capabilityId: 'filesystem.read',
    description: 'Read',
    riskClass: 'R1',
    attributes: {},
  };
  Object.defineProperty(hiddenAuthority, 'hiddenAuthority', {
    enumerable: false,
    configurable: true,
    value: 'filesystem.admin',
  });
  assert.throws(
    () => normalizeCapabilityV1(hiddenAuthority),
    /enumerable own data properties|unknown field/,
  );
});

test('universal contract arrays consume descriptor snapshots without ordinary Proxy reads', () => {
  let reads = 0;
  const trackReads = target => new Proxy(target, {
    get(object, property, receiver) {
      reads += 1;
      return Reflect.get(object, property, receiver);
    },
  });

  const requestedCapabilityIds = trackReads(['filesystem.read']);
  const invocation = normalizeToolInvocationV1({
    schemaVersion: 1,
    invocationId: 'invoke-proxy-array',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds,
    policyDecisionId: 'decision-proxy-array',
    arguments: {},
    createdAt: AT,
  });
  assert.deepEqual(invocation.requestedCapabilityIds, ['filesystem.read']);
  assert.equal(reads, 0, 'capability array must not perform ordinary caller reads');

  reads = 0;
  const artifactRefs = trackReads([artifact({ artifactId: 'artifact-proxy-array' })]);
  const observation = normalizeObservationV1({
    schemaVersion: 1,
    observationId: 'observation-proxy-array',
    invocationId: 'invoke-proxy-array',
    status: ObservationStatus.OK,
    summary: '',
    data: {},
    artifactRefs,
    observedAt: AT,
  });
  assert.equal(observation.artifactRefs[0].artifactId, 'artifact-proxy-array');
  assert.equal(reads, 0, 'artifact-ref array must not perform ordinary caller reads');

  reads = 0;
  const evidenceArtifactIds = trackReads(['evidence-proxy-array']);
  const verification = normalizeVerificationV1({
    schemaVersion: 1,
    verificationId: 'verification-proxy-array',
    invocationId: 'invoke-proxy-array',
    observationId: 'observation-proxy-array',
    status: VerificationStatus.VERIFIED,
    reasonCode: 'POSTCONDITION_MATCH',
    summary: '',
    evidenceArtifactIds,
    verifiedAt: AT,
    verifierId: 'verifier-proxy-array',
    verificationAuthorityId: 'authority-proxy-array',
    effectId: 'effect-proxy-array',
    executionId: 'execution-proxy-array',
    attempt: 1,
  });
  assert.deepEqual(verification.evidenceArtifactIds, ['evidence-proxy-array']);
  assert.equal(reads, 0, 'evidence array must not perform ordinary caller reads');
});

test('Plan-1: universal authority, artifact and credential chronology rejects shorthand and calendar rollover', () => {
  const invocation = {
    schemaVersion: 1,
    invocationId: 'invoke-chrono-1',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: {},
    createdAt: AT,
  };
  const decision = {
    schemaVersion: 1,
    decisionId: 'decision-chrono-1',
    invocationId: 'invoke-chrono-1',
    decision: PolicyDecisionKind.DENY,
    reasonCode: 'OWNER_DENY',
    decidedAt: AT,
  };
  for (const invalid of [
    '0', '2026-09-19', '2026-09-19T03:00:00',
    '2026-02-30T03:00:00Z', '2026-13-01T03:00:00Z',
    '2026-09-19T24:00:00Z', '2026-09-19T03:00:00.1234Z',
    '2026-09-19T03:00:00+25:00',
  ]) {
    for (const [name, verify] of [
      ['tool invocation', () => normalizeToolInvocationV1({ ...invocation, createdAt: invalid })],
      ['policy decision', () => normalizePolicyDecisionV1({ ...decision, decidedAt: invalid })],
      ['artifact', () => normalizeArtifactRefV1(artifact({ createdAt: invalid }))],
      ['credential expiry', () => normalizeCredentialRefV1(credential({ expiresAt: invalid }))],
    ]) {
      assert.throws(verify, /timestamp|calendar date/i, name + ' accepted ' + invalid);
    }
  }
  const canonical = normalizeToolInvocationV1({
    ...invocation, createdAt: '2026-09-19T05:00:00+02:00',
  });
  assert.equal(canonical.createdAt, '2026-09-19T03:00:00.000Z');
  assert.equal(
    normalizeArtifactRefV1(artifact({ createdAt: '2026-09-18T22:00:00-05:00' })).createdAt,
    '2026-09-19T03:00:00.000Z',
  );
});


test('Plan-1 S1: universal agent contracts redact untrusted property names without invoking accessors', () => {
  const secret = 'OWNER-CREDENTIAL-SECRET-MUST-NOT-BE-LOGGED';
  let reads = 0;
  const unknownField = artifact();
  Object.defineProperty(unknownField, secret, {
    enumerable: true,
    get() { reads += 1; throw new Error('unsafe getter invoked'); },
  });
  assert.throws(() => normalizeArtifactRefV1(unknownField), error => {
    assert.match(error.message, /unknown field|enumerable own data properties/);
    assert.doesNotMatch(error.message, /OWNER-CREDENTIAL|SECRET-MUST-NOT|unsafe getter invoked/);
    return true;
  });

  const symbolic = artifact();
  Object.defineProperty(symbolic, Symbol(secret), { enumerable: true, value: 'ALLOW' });
  assert.throws(() => normalizeArtifactRefV1(symbolic), error => {
    assert.match(error.message, /unknown field|enumerable own data properties/);
    assert.doesNotMatch(error.message, /OWNER-CREDENTIAL|SECRET-MUST-NOT/);
    return true;
  });
  assert.equal(reads, 0);
});


test('Plan-1 S1: exact effect and artifact numeric identity rejects JSON-lossy negative zero', () => {
  const invocation = {
    schemaVersion: 1,
    invocationId: 'invoke-numeric-canonical',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: { offset: 0 },
    createdAt: AT,
  };
  assert.deepEqual(normalizeToolInvocationV1(invocation).arguments, { offset: 0 });
  for (const argumentsValue of [{ offset: -0 }, { nested: [{ offset: -0 }] }]) {
    assert.throws(
      () => normalizeToolInvocationV1({ ...invocation, arguments: argumentsValue }),
      /non-canonical negative zero/,
      'effect arguments must not change identity after JSON persistence',
    );
  }
  assert.equal(normalizeArtifactRefV1(artifact({ sizeBytes: 0 })).sizeBytes, 0);
  assert.throws(
    () => normalizeArtifactRefV1(artifact({ sizeBytes: -0 })),
    /sizeBytes.*invalid/,
    'sizeBytes -0 must not be normalized into zero across restart',
  );
});


test('Plan-1 S1: extended ISO year preserves exact UTC chronology across cold serialization', () => {
  const invocation = {
    schemaVersion: 1,
    invocationId: 'invoke-year-10000',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: {},
    createdAt: '+010000-01-01T00:00:00.001Z',
  };
  const normalized = normalizeToolInvocationV1(invocation);
  assert.equal(normalized.createdAt, '+010000-01-01T00:00:00.001Z');
  assert.equal(
    normalizeToolInvocationV1({ ...invocation, createdAt: '9999-12-31T23:59:59.999Z' }).createdAt,
    '9999-12-31T23:59:59.999Z',
  );
  assert.equal(
    normalizeToolInvocationV1({ ...invocation, createdAt: '+010000-01-01T01:00:00+01:00' }).createdAt,
    '+010000-01-01T00:00:00.000Z',
  );
  assert.equal(
    normalizeToolInvocationV1(JSON.parse(JSON.stringify(normalized))).createdAt,
    normalized.createdAt,
  );
  for (const invalid of [
    '10000-01-01T00:00:00Z',
    '+010000-02-30T00:00:00Z',
    '+010000-01-01T24:00:00Z',
    '+010000-01-01T00:00:00+25:00',
  ]) {
    assert.throws(() => normalizeToolInvocationV1({ ...invocation, createdAt: invalid }),
      /timestamp|calendar date/i);
  }
});


test('Plan-1 S1: nested contract JSON diagnostics never expose attacker-owned member names', () => {
  const secret = 'PRIVATE-PROVIDER-TOKEN-NEVER-LOG';
  const invocation = {
    schemaVersion: 1,
    invocationId: 'invoke-nested-redaction',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1',
    arguments: {},
    createdAt: AT,
  };

  // Both undefined and negative zero are invalid durable effect arguments.
  // The rejection must identify the contract field, not an attacker key.
  for (const invalidValue of [undefined, -0, Infinity]) {
    const nested = { [secret]: invalidValue };
    assert.throws(
      () => normalizeToolInvocationV1({
        ...invocation, arguments: { request: { nested } },
      }),
      error => {
        assert.match(error.message, /arguments/);
        assert.doesNotMatch(error.message, /PRIVATE-PROVIDER|TOKEN-NEVER-LOG/);
        return true;
      },
    );
  }

  let getterReads = 0;
  const hostile = {};
  Object.defineProperty(hostile, secret, {
    enumerable: true,
    get() { getterReads += 1; throw new Error('private getter payload'); },
  });
  assert.throws(
    () => normalizeToolInvocationV1({
      ...invocation, arguments: { request: { hostile } },
    }),
    error => {
      assert.match(error.message, /enumerable own data properties/);
      assert.doesNotMatch(error.message, /PRIVATE-PROVIDER|private getter payload/);
      return true;
    },
  );
  assert.equal(getterReads, 0, 'validation must not execute an untrusted getter');

  const valid = normalizeToolInvocationV1({
    ...invocation, arguments: { request: { [secret]: 'opaque-data' } },
  });
  assert.equal(valid.arguments.request[secret], 'opaque-data');
  assert.equal(
    normalizeToolInvocationV1(JSON.parse(JSON.stringify(valid))).arguments.request[secret],
    'opaque-data',
    'valid durable argument identity must survive cold JSON restart',
  );
});


test('Plan-1 S1: tool policy authorization envelope rejects accessor, alias and inherited authority before effects', () => {
  const invocation = {
    schemaVersion: 1,
    invocationId: 'invoke-envelope-1',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-envelope-1',
    arguments: { fileRef: 'workspace:README.md' },
    createdAt: AT,
  };
  const policyDecision = {
    schemaVersion: 1,
    decisionId: 'decision-envelope-1',
    invocationId: 'invoke-envelope-1',
    decision: 'ALLOW',
    reasonCode: 'OWNER_APPROVED',
    decidedAt: AT,
  };
  const toolDescriptor = {
    schemaVersion: 1,
    toolId: 'fs.read',
    providerId: 'native-companion',
    label: 'Read file',
    capabilityIds: ['filesystem.read'],
    readOnly: true,
  };
  const authorized = { invocation, policyDecision, toolDescriptor, grantedCapabilityIds: ['filesystem.read'] };
  let reads = 0;
  for (const name of ['invocation', 'policyDecision', 'toolDescriptor', 'grantedCapabilityIds']) {
    const hostile = { ...authorized };
    Object.defineProperty(hostile, name, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('PRIVATE-OWNER-SECRET-GETTER');
      },
    });
    assert.throws(
      () => assertToolInvocationAuthorizedV1(hostile),
      error => {
        assert.match(error.message, /data properties/);
        assert.doesNotMatch(error.message, /PRIVATE-OWNER-SECRET-GETTER/);
        return true;
      },
      name,
    );
  }
  assert.equal(reads, 0, 'never evaluate untrusted authority wrapper accessors');

  const secret = 'PRIVATE-OWNER-SECRET-ALIAS';
  const unknownAuthority = { ...authorized, [secret]: { permission: 'ALLOW' } };
  assert.throws(
    () => assertToolInvocationAuthorizedV1(unknownAuthority),
    error => {
      assert.match(error.message, /unknown field/);
      assert.doesNotMatch(error.message, /PRIVATE-OWNER-SECRET/);
      return true;
    },
  );
  const symbolAuthority = { ...authorized, [Symbol(secret)]: 'ALLOW' };
  assert.throws(() => assertToolInvocationAuthorizedV1(symbolAuthority), /unknown field/);
  const inheritedAuthority = Object.assign(Object.create({ policyDecision }), {
    invocation, toolDescriptor, grantedCapabilityIds: ['filesystem.read'],
  });
  assert.throws(() => assertToolInvocationAuthorizedV1(inheritedAuthority), /plain object/);
  const nonEnumerable = { ...authorized };
  Object.defineProperty(nonEnumerable, 'policyDecision', { value: policyDecision, enumerable: false });
  assert.throws(() => assertToolInvocationAuthorizedV1(nonEnumerable), /data properties/);

  const verified = assertToolInvocationAuthorizedV1(authorized);
  assert.equal(verified.policyDecision.decision, PolicyDecisionKind.ALLOW);
  assert.deepEqual(verified.grantedCapabilityIds, ['filesystem.read']);
  assert.equal(Object.isFrozen(verified), true);
  const cold = assertToolInvocationAuthorizedV1(JSON.parse(JSON.stringify(authorized)));
  assert.deepEqual(cold, verified, 'valid authorization identity survives JSON cold restart');

  assert.throws(
    () => assertToolInvocationAuthorizedV1({ ...authorized, policyDecision: { ...policyDecision, decision: 'DENY' } }),
    /not authorized/,
    'hardened intake must not relax the canonical owner policy',
  );
});


test('Plan-1 S1: canonical registry adapters reject hostile options without executing getters', () => {
  const secret = 'PRIVATE-ADAPTER-OWNER-TOKEN';
  let reads = 0;
  for (const field of ['description', 'riskClass', 'attributes']) {
    const options = {};
    Object.defineProperty(options, field, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(secret);
      },
    });
    assert.throws(
      () => capabilityV1FromRegistry('filesystem.read', options),
      error => {
        assert.match(error.message, /data properties/);
        assert.doesNotMatch(error.message, /PRIVATE-ADAPTER/);
        return true;
      },
    );
  }

  const provider = getAgentProvider(AgentProviderId.CHATGPT_BROWSER);
  for (const field of ['toolId', 'label', 'description', 'readOnly']) {
    const options = { toolId: 'chatgpt.inspect' };
    Object.defineProperty(options, field, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(secret);
      },
    });
    assert.throws(
      () => toolDescriptorV1FromAgentProvider(provider, options),
      error => {
        assert.match(error.message, /data properties/);
        assert.doesNotMatch(error.message, /PRIVATE-ADAPTER/);
        return true;
      },
    );
  }
  assert.equal(reads, 0, 'neither adapter may execute option getters');

  const symbolOptions = { toolId: 'chatgpt.inspect', [Symbol(secret)]: 'filesystem.write' };
  assert.throws(() => toolDescriptorV1FromAgentProvider(provider, symbolOptions), /unknown field/);
  assert.throws(
    () => capabilityV1FromRegistry('filesystem.read', { description: 'Read', [secret]: 'R0' }),
    error => {
      assert.match(error.message, /unknown field/);
      assert.doesNotMatch(error.message, /PRIVATE-ADAPTER/);
      return true;
    },
  );
  const inherited = Object.assign(Object.create({ readOnly: true }), { toolId: 'chatgpt.inspect' });
  assert.throws(() => toolDescriptorV1FromAgentProvider(provider, inherited), /plain object/);
  const validTool = toolDescriptorV1FromAgentProvider(provider, {
    toolId: 'chatgpt.inspect',
    label: 'Inspect page',
    description: 'Read-only visual inspection',
    readOnly: true,
  });
  assert.equal(validTool.readOnly, true);
  assert.equal(validTool.providerId, AgentProviderId.CHATGPT_BROWSER);
  assert.deepEqual(
    toolDescriptorV1FromAgentProvider(provider, JSON.parse(JSON.stringify({
      toolId: 'chatgpt.inspect',
      label: 'Inspect page',
      description: 'Read-only visual inspection',
      readOnly: true,
    }))),
    validTool,
  );
  const validCapability = capabilityV1FromRegistry('filesystem.read', {
    description: 'Read file', riskClass: 'R1', attributes: { provider: 'native' },
  });
  assert.deepEqual(
    capabilityV1FromRegistry('filesystem.read', JSON.parse(JSON.stringify({
      description: 'Read file', riskClass: 'R1', attributes: { provider: 'native' },
    }))),
    validCapability,
  );
});


test('Plan-1 S1: explicit unknown privacy and read-only flags cannot downgrade at restart', () => {
  const descriptor = {
    schemaVersion: 1,
    toolId: 'fs.read',
    providerId: 'native-companion',
    label: 'Read file',
    capabilityIds: ['filesystem.read'],
  };
  const report = artifact({ sensitive: true });
  for (const invalid of [null, undefined, 'false', 0]) {
    assert.throws(
      () => normalizeToolDescriptorV1({ ...descriptor, readOnly: invalid }),
      /readOnly must be boolean/,
      'explicitly unknown readOnly permission cannot turn into false',
    );
    assert.throws(
      () => normalizeArtifactRefV1({ ...report, sensitive: invalid }),
      /sensitive must be boolean/,
      'explicitly unknown artifact sensitivity cannot turn into public metadata',
    );
  }
  assert.equal(normalizeToolDescriptorV1(descriptor).readOnly, false, 'omitted legacy flag retains default');
  assert.equal(normalizeArtifactRefV1(artifact({ sensitive: false })).sensitive, false);
  assert.equal(normalizeArtifactRefV1(report).sensitive, true);
  const durableTool = normalizeToolDescriptorV1({ ...descriptor, readOnly: true });
  const durableArtifact = normalizeArtifactRefV1(report);
  assert.deepEqual(normalizeToolDescriptorV1(JSON.parse(JSON.stringify(durableTool))), durableTool);
  assert.deepEqual(normalizeArtifactRefV1(JSON.parse(JSON.stringify(durableArtifact))), durableArtifact);
});


test('Plan-1 S1: persisted policy and evidence enums reject alias promotion across restart', () => {
  const permission = {
    schemaVersion: 1,
    decisionId: 'decision-exact-1',
    invocationId: 'invoke-exact-1',
    decision: PolicyDecisionKind.DENY,
    reasonCode: 'OWNER_DENY',
    decidedAt: AT,
  };
  const observation = {
    schemaVersion: 1,
    observationId: 'obs-exact-1',
    invocationId: 'invoke-exact-1',
    status: ObservationStatus.OK,
    observedAt: AT,
  };
  const verification = {
    schemaVersion: 1,
    verificationId: 'verify-exact-1',
    invocationId: 'invoke-exact-1',
    observationId: 'obs-exact-1',
    status: VerificationStatus.VERIFIED,
    reasonCode: 'POSTCONDITION_MATCH',
    verifiedAt: AT,
  };
  // Previously a malformed serialized/adapter status silently became an
  // authoritative ALLOW or VERIFIED after trimming and uppercasing.
  for (const alias of ['allow', ' ALLOW', 'ALLOW ', 'aLlOw', 'DENY ']) {
    assert.throws(() => normalizePolicyDecisionV1({ ...permission, decision: alias }), /decision is invalid/);
  }
  for (const alias of ['ok', ' OK', 'OK ', 'pArTiAl']) {
    assert.throws(() => normalizeObservationV1({ ...observation, status: alias }), /status is invalid/);
  }
  for (const alias of ['verified', ' VERIFIED', 'VERIFIED ', 'aMbIgUoUs']) {
    assert.throws(() => normalizeVerificationV1({ ...verification, status: alias }), /status is invalid/);
  }
  for (const [normalizer, input] of [
    [normalizePolicyDecisionV1, permission],
    [normalizeObservationV1, observation],
    [normalizeVerificationV1, verification],
  ]) {
    const original = normalizer(input);
    const restarted = normalizer(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(restarted, original, 'cold JSON restart retains exact durable enum');
    assert.ok(Object.isFrozen(restarted));
  }
});


test('Plan-1 S1: denied capability diagnostics never disclose untrusted identifiers', () => {
  const secret = 'provider.token.PRIVATE-CREDENTIAL-777';
  const invocation = {
    schemaVersion: 1,
    invocationId: 'invoke-denied-cap-1',
    toolId: 'fs.read',
    providerId: 'native-companion',
    requestedCapabilityIds: ['filesystem.read', secret],
    policyDecisionId: 'decision-denied-cap-1',
    arguments: {},
    createdAt: AT,
  };
  const authorized = {
    invocation,
    policyDecision: {
      schemaVersion: 1,
      decisionId: 'decision-denied-cap-1',
      invocationId: invocation.invocationId,
      decision: PolicyDecisionKind.ALLOW,
      reasonCode: 'OWNER_APPROVED',
      decidedAt: AT,
    },
    toolDescriptor: {
      schemaVersion: 1,
      toolId: invocation.toolId,
      providerId: invocation.providerId,
      label: 'Read file',
      capabilityIds: ['filesystem.read', secret],
      readOnly: true,
    },
    grantedCapabilityIds: ['filesystem.read'],
  };
  const assertRedacted = error => {
    assert.match(error.message, /exceeds granted capabilities/);
    assert.doesNotMatch(error.message, /PRIVATE-CREDENTIAL|provider\.token/);
    return true;
  };

  // Even if the descriptor advertises it, the owner grant remains the
  // authoritative subset. A denied ID may contain a sensitive provider ref.
  assert.throws(() => assertToolInvocationAuthorizedV1(authorized), assertRedacted);
  assert.throws(
    () => assertToolInvocationAuthorizedV1({
      ...authorized,
      toolDescriptor: { ...authorized.toolDescriptor, capabilityIds: ['filesystem.read'] },
      grantedCapabilityIds: ['filesystem.read', secret],
    }),
    assertRedacted,
    'provider descriptor denial must be redacted too',
  );

  const handoff = {
    schemaVersion: 1,
    handoffId: 'handoff-denied-cap-1',
    specialistId: 'specialist-1',
    goal: 'Read a workspace report',
    requestedCapabilityIds: ['filesystem.read', secret],
    createdAt: AT,
  };
  assert.throws(() => assertSpecialistHandoffScopedV1(handoff, ['filesystem.read']), assertRedacted);

  // Rejection cannot mutate persisted grants or weaken the existing authority.
  assert.deepEqual(authorized.grantedCapabilityIds, ['filesystem.read']);
  assert.deepEqual(handoff.requestedCapabilityIds, ['filesystem.read', secret]);
  const validAuthorization = assertToolInvocationAuthorizedV1({
    ...authorized,
    grantedCapabilityIds: ['filesystem.read', secret],
  });
  assert.deepEqual(validAuthorization.invocation.requestedCapabilityIds, ['filesystem.read', secret]);
  assert.deepEqual(
    assertToolInvocationAuthorizedV1(JSON.parse(JSON.stringify({
      ...authorized, grantedCapabilityIds: ['filesystem.read', secret],
    }))),
    validAuthorization,
    'canonical permission survives JSON cold restart without an alias',
  );
  assert.deepEqual(
    assertSpecialistHandoffScopedV1(JSON.parse(JSON.stringify(handoff)), ['filesystem.read', secret]),
    assertSpecialistHandoffScopedV1(handoff, ['filesystem.read', secret]),
  );
});


test('Plan-1 S1: artifact digest identity is exact through persisted observation and specialist handoff', () => {
  const digest = 'a'.repeat(64);
  const valid = normalizeArtifactRefV1(artifact({ sha256: digest }));
  assert.equal(valid.sha256, digest);
  assert.deepEqual(normalizeArtifactRefV1(JSON.parse(JSON.stringify(valid))), valid);
  assert.ok(Object.isFrozen(valid), 'persisted artifact metadata remains immutable');

  // Previously both uppercase and padded hashes were silently normalized into
  // a different identity, letting noncanonical evidence pass after restart.
  for (const candidate of [digest.toUpperCase(), ' ' + digest, digest + ' ', '\n' + digest, 'A' + digest.slice(1)]) {
    const hostile = artifact({ sha256: candidate });
    for (const restarted of [hostile, JSON.parse(JSON.stringify(hostile))]) {
      assert.throws(() => normalizeArtifactRefV1(restarted), /sha256 is invalid/);
      assert.throws(() => normalizeObservationV1({
        schemaVersion: 1,
        observationId: 'obs-digest-identity',
        invocationId: 'invoke-1',
        status: ObservationStatus.OK,
        artifactRefs: [restarted],
        observedAt: AT,
      }), /artifactRefs\[0\].*sha256 is invalid/);
      assert.throws(() => normalizeSpecialistHandoffV1({
        schemaVersion: 1,
        handoffId: 'handoff-digest-identity',
        specialistId: 'specialist-1',
        goal: 'Read verified evidence',
        requestedCapabilityIds: ['filesystem.read'],
        artifactRefs: [restarted],
        createdAt: AT,
      }), /artifactRefs\[0\].*sha256 is invalid/);
    }
  }
  assert.deepEqual(normalizeArtifactRefV1(artifact({ sha256: '' })).sha256, '');
});


test('Plan-1 S1: explicitly present malformed artifact byte length fails closed across evidence paths', () => {
  // Legacy absent size is compatible; an explicitly persisted null/undefined
  // must never be converted into evidence that the artifact is zero bytes.
  const legacy = artifact();
  delete legacy.sizeBytes;
  assert.equal(normalizeArtifactRefV1(legacy).sizeBytes, 0);
  assert.equal(normalizeArtifactRefV1(artifact({ sizeBytes: 0 })).sizeBytes, 0);
  assert.equal(normalizeArtifactRefV1(artifact({ sizeBytes: 123 })).sizeBytes, 123);
  for (const sizeBytes of [null, undefined, -0, NaN, Infinity, -1, 1.5]) {
    const malformed = artifact({ sizeBytes });
    assert.throws(() => normalizeArtifactRefV1(malformed), /sizeBytes is invalid/);
    assert.throws(() => normalizeObservationV1({
      schemaVersion: 1, observationId: 'obs-invalid-byte-length',
      invocationId: 'invoke-1', status: ObservationStatus.OK,
      artifactRefs: [malformed], observedAt: AT,
    }), /artifactRefs\[0\].*sizeBytes is invalid/);
    assert.throws(() => normalizeSpecialistHandoffV1({
      schemaVersion: 1, handoffId: 'handoff-invalid-byte-length',
      specialistId: 'specialist-1', goal: 'Verify durable artifact evidence',
      requestedCapabilityIds: ['filesystem.read'],
      artifactRefs: [malformed], createdAt: AT,
    }), /artifactRefs\[0\].*sizeBytes is invalid/);
  }
  for (const sizeBytes of [null, -1, 1.5]) {
    assert.throws(() => normalizeArtifactRefV1(JSON.parse(JSON.stringify(artifact({ sizeBytes })))), /sizeBytes is invalid/);
  }
  const normalized = normalizeArtifactRefV1(artifact());
  assert.ok(Object.isFrozen(normalized));
  assert.deepEqual(normalizeArtifactRefV1(JSON.parse(JSON.stringify(normalized))), normalized);
});


test('Plan-1 S1: explicitly persisted verification attempt cannot be silently reset on restart', () => {
  const base = {
    schemaVersion: 1, verificationId: 'verify-attempt-1',
    invocationId: 'invoke-attempt-1', observationId: 'observation-attempt-1',
    status: VerificationStatus.VERIFIED, reasonCode: 'POSTCONDITION_MATCH',
    verifiedAt: AT,
  };
  // Legacy omission is distinguishable from explicitly corrupt evidence.
  assert.equal(normalizeVerificationV1(base).attempt, 0);
  assert.equal(normalizeVerificationV1({ ...base, attempt: 0 }).attempt, 0);
  assert.equal(normalizeVerificationV1({ ...base, attempt: 1 }).attempt, 1);
  for (const attempt of [undefined, null, -0, -1, 1.5, 65, NaN, Infinity, '1']) {
    const corrupted = { ...base, attempt };
    assert.throws(() => normalizeVerificationV1(corrupted), /attempt is invalid/);
  }
  for (const attempt of [null, -1, 1.5, 65, '1']) {
    assert.throws(
      () => normalizeVerificationV1(JSON.parse(JSON.stringify({ ...base, attempt }))),
      /attempt is invalid/,
      'persisted malformed retry identity must not be admitted after JSON restart',
    );
  }
  const legal = normalizeVerificationV1({ ...base, attempt: 1 });
  assert.ok(Object.isFrozen(legal));
  assert.deepEqual(normalizeVerificationV1(JSON.parse(JSON.stringify(legal))), legal);
});


test('Plan-1 S1: persisted evidence-list presence cannot silently erase verification and effect identity', () => {
  const observation = {
    schemaVersion: 1,
    observationId: 'observation-evidence-presence',
    invocationId: 'invoke-1',
    status: ObservationStatus.OK,
    observedAt: AT,
  };
  const verification = {
    schemaVersion: 1,
    verificationId: 'verification-evidence-presence',
    invocationId: 'invoke-1',
    observationId: observation.observationId,
    status: VerificationStatus.VERIFIED,
    reasonCode: 'POSTCONDITION_MATCH',
    verifiedAt: AT,
  };
  const handoff = {
    schemaVersion: 1,
    handoffId: 'handoff-evidence-presence',
    specialistId: 'specialist-1',
    goal: 'Continue exact evidence-bound work',
    requestedCapabilityIds: ['filesystem.read'],
    createdAt: AT,
  };
  // Truly absent fields are supported by older stored V1 records.
  assert.deepEqual(normalizeObservationV1(observation).artifactRefs, []);
  assert.deepEqual(normalizeVerificationV1(verification).evidenceArtifactIds, []);
  assert.deepEqual(normalizeSpecialistHandoffV1(handoff).artifactRefs, []);
  assert.deepEqual(normalizeSpecialistHandoffV1(handoff).credentialRefs, []);

  const cases = [
    [normalizeObservationV1, observation, 'artifactRefs'],
    [normalizeVerificationV1, verification, 'evidenceArtifactIds'],
    [normalizeSpecialistHandoffV1, handoff, 'artifactRefs'],
    [normalizeSpecialistHandoffV1, handoff, 'credentialRefs'],
  ];
  for (const [normalize, base, field] of cases) {
    for (const corrupt of [null, undefined]) {
      assert.throws(
        () => normalize({ ...base, [field]: corrupt }),
        /must be a bounded plain array/,
        field + ' explicit malformed presence must be rejected',
      );
    }
    // JSON cold restart retains explicit null, so it must remain fail-closed.
    assert.throws(
      () => normalize(JSON.parse(JSON.stringify({ ...base, [field]: null }))),
      /must be a bounded plain array/,
      field + ' must not be rewritten as empty across restart',
    );
    const valid = normalize({ ...base, [field]: [] });
    assert.deepEqual(valid[field], []);
    assert.ok(Object.isFrozen(valid));
    assert.deepEqual(normalize(JSON.parse(JSON.stringify(valid))), valid);
  }
});


test('Plan-1 S1: duplicate evidence and credential identities fail closed across JSON restart', () => {
  const duplicateArtifact = artifact({ artifactId: 'artifact-secret-identity' });
  const observation = {
    schemaVersion: 1,
    observationId: 'observation-dedup',
    invocationId: 'invoke-1',
    status: ObservationStatus.OK,
    artifactRefs: [duplicateArtifact, { ...duplicateArtifact, sha256: 'b'.repeat(64) }],
    observedAt: AT,
  };
  const handoff = {
    schemaVersion: 1,
    handoffId: 'handoff-dedup',
    specialistId: 'specialist-1',
    goal: 'Continue owner-approved work',
    requestedCapabilityIds: ['filesystem.read'],
    artifactRefs: observation.artifactRefs,
    credentialRefs: [credential(), { ...credential(), scope: ['drive.readonly'] }],
    createdAt: AT,
  };
  for (const candidate of [observation, JSON.parse(JSON.stringify(observation))]) {
    assert.throws(
      () => normalizeObservationV1(candidate),
      error => /artifactRefs contains duplicate durable identities/.test(error.message)
        && !error.message.includes('artifact-secret-identity'),
    );
  }
  for (const candidate of [handoff, JSON.parse(JSON.stringify(handoff))]) {
    assert.throws(() => normalizeSpecialistHandoffV1(candidate), /artifactRefs contains duplicate durable identities/);
    const distinctArtifacts = {
      ...candidate,
      artifactRefs: [artifact({ artifactId: 'artifact-a' }), artifact({ artifactId: 'artifact-b' })],
    };
    assert.throws(
      () => normalizeSpecialistHandoffV1(distinctArtifacts),
      /credentialRefs contains duplicate durable identities/,
    );
  }
  const valid = normalizeSpecialistHandoffV1({
    ...handoff,
    artifactRefs: [artifact({ artifactId: 'artifact-a' }), artifact({ artifactId: 'artifact-b' })],
    credentialRefs: [credential({ credentialId: 'cred-a' }), credential({ credentialId: 'cred-b' })],
  });
  assert.deepEqual(
    normalizeSpecialistHandoffV1(JSON.parse(JSON.stringify(valid))),
    valid,
    'distinct durable identities must survive a cold JSON restart',
  );
  assert.ok(Object.isFrozen(valid.artifactRefs));
  assert.ok(Object.isFrozen(valid.credentialRefs));
});


test('Plan-1 S1: web postcondition verifier preserves optional refs across ambiguous-effect readback', async () => {
  const { verifyDeterministicWebPostconditionV1 } = await import('../src/core/deterministic-web-provider.js');
  const observation = normalizeObservationV1({
    schemaVersion: 1,
    observationId: 'web-observation-compat-1',
    invocationId: 'web-invocation-compat-1',
    status: ObservationStatus.OK,
    summary: 'Independent fresh browser readback',
    data: { url: 'https://example.test/ready' },
    artifactRefs: [],
    observedAt: AT,
  });
  const verification = verifyDeterministicWebPostconditionV1({
    invocationId: 'web-invocation-compat-1',
    observation,
    expected: { url: 'https://example.test/ready' },
    now: AT,
  });
  assert.equal(verification.status, VerificationStatus.VERIFIED);
  assert.equal(verification.verificationAuthorityId, null);
  assert.equal(verification.effectId, null);
  assert.equal(verification.executionId, null);
  assert.deepEqual(normalizeVerificationV1(JSON.parse(JSON.stringify(verification))), verification,
    'fresh readback and cold recovery must agree on absent identity refs');

  for (const key of ['verificationAuthorityId', 'effectId', 'executionId']) {
    assert.throws(
      () => normalizeVerificationV1({ ...verification, [key]: '' }),
      /is invalid/,
      'a corrupt explicit empty ' + key + ' must never silently erase evidence identity',
    );
  }

  const mismatch = verifyDeterministicWebPostconditionV1({
    invocationId: 'web-invocation-compat-1',
    observation,
    expected: { url: 'https://example.test/other' },
    now: AT,
  });
  assert.equal(mismatch.status, VerificationStatus.FAILED,
    'stale independent observation must not be promoted to verified or committed');
  assert.deepEqual(normalizeVerificationV1(JSON.parse(JSON.stringify(mismatch))), mismatch);
});


test('Plan-1 S1: universal persisted JSON budgets count UTF-8 bytes', () => {
  const makeInvocation = (data, invocationId) => ({
    schemaVersion: 1, invocationId, toolId: 'file.read',
    providerId: 'native-companion', requestedCapabilityIds: ['filesystem.read'],
    policyDecisionId: 'decision-1', arguments: data, createdAt: AT,
  });
  const makeObservation = data => ({
    schemaVersion: 1, observationId: 'obs-utf8-budget',
    invocationId: 'invoke-utf8-budget', status: ObservationStatus.OK,
    data, observedAt: AT,
  });
  // The old UTF-16 check admitted this payload despite exceeding the
  // configured UTF-8 budget (> 256_000 bytes) on durable transport.
  const oversized = Object.freeze({ payload: 'é'.repeat(130_000) });
  assert.ok(JSON.stringify(oversized).length < 256_000,
    'pre-fix character count would incorrectly permit the payload');
  assert.ok(new TextEncoder().encode(JSON.stringify(oversized)).byteLength > 256_000);
  const invocation = makeInvocation(oversized, 'invoke-utf8-budget');
  const observation = makeObservation(oversized);
  assert.throws(() => normalizeToolInvocationV1(invocation), /arguments is too large/);
  assert.throws(() => normalizeObservationV1(observation), /data is too large/);
  assert.equal(oversized.payload.length, 130_000, 'negative check must not mutate caller evidence');

  const normal = Object.freeze({ payload: 'é'.repeat(1_000), verified: true });
  const validInvocation = normalizeToolInvocationV1(makeInvocation(normal, 'invoke-utf8-valid'));
  const validObservation = normalizeObservationV1(makeObservation(normal));
  assert.deepEqual(normalizeToolInvocationV1(JSON.parse(JSON.stringify(validInvocation))),
    validInvocation, 'valid effect inputs must survive exact cold JSON recovery');
  assert.deepEqual(normalizeObservationV1(JSON.parse(JSON.stringify(validObservation))),
    validObservation, 'valid observations must survive exact cold JSON recovery');
});


test('Plan-1 S1: corrupt persisted artifact digest cannot erase evidence across recovery', () => {
  const legacy = artifact();
  delete legacy.sha256;
  const compatible = normalizeArtifactRefV1(legacy);
  assert.equal(compatible.sha256, '');
  assert.deepEqual(normalizeArtifactRefV1(JSON.parse(JSON.stringify(compatible))), compatible);
  assert.deepEqual(normalizeArtifactRefV1(artifact({ sha256: '' })).sha256, '');

  for (const sha256 of [null, undefined]) {
    const corrupt = artifact({ sha256 });
    const original = { ...corrupt };
    const rejectEveryEvidencePath = (ref) => {
      assert.throws(() => normalizeArtifactRefV1(ref), /sha256 is invalid/,
        'an explicitly corrupt content hash must not silently become optional');
      assert.throws(() => normalizeObservationV1({
        schemaVersion: 1, observationId: 'obs-corrupt-sha',
        invocationId: 'invoke-1', status: ObservationStatus.OK,
        artifactRefs: [ref], observedAt: AT,
      }), /artifactRefs\[0\].*sha256 is invalid/);
      assert.throws(() => normalizeSpecialistHandoffV1({
        schemaVersion: 1, handoffId: 'handoff-corrupt-sha',
        specialistId: 'specialist-1', goal: 'Verify artifact',
        requestedCapabilityIds: ['filesystem.read'],
        artifactRefs: [ref], createdAt: AT,
      }), /artifactRefs\[0\].*sha256 is invalid/);
    };
    rejectEveryEvidencePath(corrupt);
    assert.deepEqual(corrupt, original, 'rejected evidence must never mutate caller data');
    // JSON preserves null, but drops undefined: catch both before persisting,
    // then verify the persisted null form still fails closed on cold restart.
    if (sha256 === null) rejectEveryEvidencePath(JSON.parse(JSON.stringify(corrupt)));
  }

  const verified = normalizeArtifactRefV1(artifact({ sha256: 'b'.repeat(64) }));
  assert.equal(verified.sha256, 'b'.repeat(64));
  assert.ok(Object.isFrozen(verified));
  assert.deepEqual(normalizeArtifactRefV1(JSON.parse(JSON.stringify(verified))), verified);
});


test('Plan-1 S1: nested prototype keys fail closed across invocation, observation and capability contracts', () => {
  const secret = 'PRIVATE_NESTED_JSON_VALUE_MUST_NOT_LEAK';
  const contracts = [
    value => normalizeToolInvocationV1({
      schemaVersion: 1, invocationId: 'invoke-nested-safe', toolId: 'fs.read',
      providerId: 'native-companion', requestedCapabilityIds: ['filesystem.read'],
      policyDecisionId: 'decision-nested-safe', arguments: value, createdAt: AT,
    }),
    value => normalizeObservationV1({
      schemaVersion: 1, observationId: 'obs-nested-safe',
      invocationId: 'invoke-nested-safe', status: ObservationStatus.OK,
      data: value, observedAt: AT,
    }),
    value => normalizeCapabilityV1({
      schemaVersion: 1, capabilityId: 'filesystem.read',
      riskClass: 'R0', attributes: value,
    }),
  ];

  for (const makeContract of contracts) {
    const good = makeContract(Object.freeze({ scope: Object.freeze({ granted: false }) }));
    const normalizedJson = JSON.parse(JSON.stringify(good));
    assert.equal(Object.isFrozen(good), true);
    assert.deepEqual(makeContract({ scope: { granted: false } }), good);
    assert.deepEqual(JSON.parse(JSON.stringify(good)), normalizedJson,
      'validated JSON remains deterministic and serializable for cold recovery');

    // The existing V1 contract deliberately preserves __proto__ strictly
    // as an own data member; retaining that behavior is a migration requirement.
    const legacy = JSON.parse('{"nested":{"__proto__":{"marker":"own-data"}}}');
    const legacyContract = makeContract(legacy);
    const legacyData = legacyContract.arguments ?? legacyContract.data ?? legacyContract.attributes;
    assert.equal(Object.getPrototypeOf(legacyData.nested), Object.prototype);
    assert.equal(Object.hasOwn(legacyData.nested, '__proto__'), true);
    assert.deepEqual(legacyData.nested.__proto__, { marker: 'own-data' });

    for (const unsafeKey of ['constructor', 'prototype']) {
      const hostile = JSON.parse(JSON.stringify({ nested: {} }));
      Object.defineProperty(hostile.nested, unsafeKey, {
        value: { authorized: true, secret }, enumerable: true, configurable: true,
      });
      const before = JSON.stringify(hostile);
      for (const candidate of [hostile, JSON.parse(before)]) {
        assert.throws(() => makeContract(candidate), error => {
          assert.match(error.message, /contains unsafe property key/);
          assert.doesNotMatch(error.message, /PRIVATE_NESTED_JSON_VALUE_MUST_NOT_LEAK/);
          return true;
        }, 'prototype-identity keys must not enter durable effect/evidence data');
        assert.equal(JSON.stringify(candidate), before,
          'rejected caller-owned data must remain unchanged');
      }
    }
  }
});
