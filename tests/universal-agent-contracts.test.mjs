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
  }), /credentialRefs must be a bounded array/);
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
  }), /exceeds granted capabilities: filesystem.write/);
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
    /exceeds granted capabilities: workspace.write/,
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
    /enumerable own data properties|unknown field: hiddenAuthority/,
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

