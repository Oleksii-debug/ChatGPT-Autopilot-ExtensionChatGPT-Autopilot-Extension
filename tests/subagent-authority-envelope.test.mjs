import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SubagentAuthorityDecision,
  deriveSubagentAuthorityEnvelopeV1,
} from '../src/core/subagent-authority-envelope.js';

function tool(toolId, capabilityIds = ['cap.read'], providerId = 'provider.main') {
  return {
    schemaVersion: 1,
    toolId,
    providerId,
    label: toolId,
    description: '',
    capabilityIds,
    inputSchemaRef: null,
    outputSchemaRef: null,
    readOnly: true,
  };
}

function request(overrides = {}) {
  return {
    projectId: 'project.alpha',
    parentAgentId: 'agent.parent',
    childAgentId: 'agent.child',
    taskId: 'task.one',
    providerId: 'provider.main',
    parentProviderIds: ['provider.main', 'provider.backup'],
    ownerAllowedProviderIds: ['provider.main'],
    parentCapabilityIds: ['cap.read', 'cap.write', 'cap.admin'],
    ownerAllowedCapabilityIds: ['cap.read', 'cap.write'],
    providerCapabilityIds: ['cap.read', 'cap.write', 'cap.remote'],
    taskRequestedCapabilityIds: ['cap.read'],
    parentSourceIds: ['source.repo', 'source.drive'],
    ownerAllowedSourceIds: ['source.repo', 'source.drive'],
    taskSourceIds: ['source.repo'],
    parentArtifactIds: ['artifact.input', 'artifact.private'],
    ownerAllowedArtifactIds: ['artifact.input', 'artifact.private'],
    taskArtifactIds: ['artifact.input'],
    parentToolIds: ['tool.read', 'tool.write'],
    ownerAllowedToolIds: ['tool.read', 'tool.write'],
    requestedToolIds: ['tool.read'],
    parentToolDescriptors: [tool('tool.read')],
    ...overrides,
  };
}

test('derives only the exact task scope inside parent, owner and provider authority', () => {
  const result = deriveSubagentAuthorityEnvelopeV1(request({
    taskRequestedCapabilityIds: ['cap.read', 'cap.write'],
    requestedToolIds: ['tool.read', 'tool.write'],
    parentToolDescriptors: [
      tool('tool.read', ['cap.read']),
      tool('tool.write', ['cap.write']),
    ],
  }));

  assert.equal(result.decision, SubagentAuthorityDecision.ALLOW);
  assert.equal(result.reasonCode, 'LEAST_AUTHORITY_DERIVED');
  assert.deepEqual(result.capabilityIds, ['cap.read', 'cap.write']);
  assert.deepEqual(result.sourceIds, ['source.repo']);
  assert.deepEqual(result.artifactIds, ['artifact.input']);
  assert.deepEqual(result.toolIds, ['tool.read', 'tool.write']);
  assert.equal(result.executionAuthority, false);
  assert.equal(result.credentialAuthority, false);
  assert.equal(result.policyAuthority, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.toolDescriptors[0]), true);
});


test('selected provider must remain inside parent and owner provider scope', () => {
  const parentDenied = deriveSubagentAuthorityEnvelopeV1(request({
    parentProviderIds: ['provider.backup'],
  }));
  assert.equal(parentDenied.decision, 'DENY');
  assert.equal(parentDenied.reasonCode, 'PROVIDER_SCOPE_ESCALATION');
  assert.deepEqual(parentDenied.deniedProviderIds, ['provider.main']);

  const ownerDenied = deriveSubagentAuthorityEnvelopeV1(request({
    ownerAllowedProviderIds: ['provider.backup'],
  }));
  assert.equal(ownerDenied.decision, 'DENY');
  assert.equal(ownerDenied.reasonCode, 'PROVIDER_SCOPE_ESCALATION');
  assert.deepEqual(ownerDenied.deniedProviderIds, ['provider.main']);
});

test('fails closed when task capability exceeds any authority intersection member', () => {
  const ownerDenied = deriveSubagentAuthorityEnvelopeV1(request({
    taskRequestedCapabilityIds: ['cap.admin'],
  }));
  assert.equal(ownerDenied.decision, 'DENY');
  assert.equal(ownerDenied.reasonCode, 'CAPABILITY_ESCALATION');
  assert.deepEqual(ownerDenied.deniedCapabilityIds, ['cap.admin']);

  const providerDenied = deriveSubagentAuthorityEnvelopeV1(request({
    parentCapabilityIds: ['cap.local'],
    ownerAllowedCapabilityIds: ['cap.local'],
    providerCapabilityIds: ['cap.read'],
    taskRequestedCapabilityIds: ['cap.local'],
  }));
  assert.equal(providerDenied.reasonCode, 'CAPABILITY_ESCALATION');
  assert.deepEqual(providerDenied.deniedCapabilityIds, ['cap.local']);
});

test('child context cannot escape parent or owner source/artifact visibility', () => {
  const source = deriveSubagentAuthorityEnvelopeV1(request({
    taskSourceIds: ['source.repo', 'source.secret'],
  }));
  assert.equal(source.reasonCode, 'CONTEXT_SOURCE_ESCALATION');
  assert.deepEqual(source.deniedSourceIds, ['source.secret']);
  assert.deepEqual(source.sourceIds, []);

  const ownerSource = deriveSubagentAuthorityEnvelopeV1(request({
    ownerAllowedSourceIds: ['source.drive'],
    taskSourceIds: ['source.repo'],
  }));
  assert.equal(ownerSource.reasonCode, 'CONTEXT_SOURCE_ESCALATION');
  assert.deepEqual(ownerSource.deniedSourceIds, ['source.repo']);

  const artifact = deriveSubagentAuthorityEnvelopeV1(request({
    taskArtifactIds: ['artifact.input', 'artifact.secret'],
  }));
  assert.equal(artifact.reasonCode, 'CONTEXT_ARTIFACT_ESCALATION');
  assert.deepEqual(artifact.deniedArtifactIds, ['artifact.secret']);
  assert.deepEqual(artifact.artifactIds, []);

  const ownerArtifact = deriveSubagentAuthorityEnvelopeV1(request({
    ownerAllowedArtifactIds: ['artifact.private'],
    taskArtifactIds: ['artifact.input'],
  }));
  assert.equal(ownerArtifact.reasonCode, 'CONTEXT_ARTIFACT_ESCALATION');
  assert.deepEqual(ownerArtifact.deniedArtifactIds, ['artifact.input']);
});

test('tool identity is independently narrowed by parent and owner scope', () => {
  const parentDenied = deriveSubagentAuthorityEnvelopeV1(request({
    parentToolIds: ['tool.write'],
    requestedToolIds: ['tool.read'],
  }));
  assert.equal(parentDenied.reasonCode, 'TOOL_SCOPE_ESCALATION');
  assert.deepEqual(parentDenied.deniedToolIds, ['tool.read']);

  const ownerDenied = deriveSubagentAuthorityEnvelopeV1(request({
    ownerAllowedToolIds: ['tool.write'],
    requestedToolIds: ['tool.read'],
  }));
  assert.equal(ownerDenied.reasonCode, 'TOOL_SCOPE_ESCALATION');
  assert.deepEqual(ownerDenied.deniedToolIds, ['tool.read']);
});

test('tool descriptors cannot smuggle provider or capability authority', () => {
  const capability = deriveSubagentAuthorityEnvelopeV1(request({
    parentToolDescriptors: [tool('tool.read', ['cap.read', 'cap.write'])],
  }));
  assert.equal(capability.reasonCode, 'TOOL_CAPABILITY_ESCALATION');
  assert.deepEqual(capability.deniedToolIds, ['tool.read']);
  assert.deepEqual(capability.deniedCapabilityIds, ['cap.write']);

  const provider = deriveSubagentAuthorityEnvelopeV1(request({
    parentToolDescriptors: [tool('tool.read', ['cap.read'], 'provider.other')],
  }));
  assert.equal(provider.reasonCode, 'TOOL_PROVIDER_ESCALATION');
  assert.deepEqual(provider.deniedToolIds, ['tool.read']);

  const missing = deriveSubagentAuthorityEnvelopeV1(request({
    parentToolIds: ['tool.read', 'tool.unknown'],
    ownerAllowedToolIds: ['tool.read', 'tool.unknown'],
    requestedToolIds: ['tool.unknown'],
  }));
  assert.equal(missing.reasonCode, 'TOOL_DESCRIPTOR_MISSING');
  assert.deepEqual(missing.deniedToolIds, ['tool.unknown']);

  const undeclared = deriveSubagentAuthorityEnvelopeV1(request({
    parentToolDescriptors: [tool('tool.read', [])],
  }));
  assert.equal(undeclared.reasonCode, 'TOOL_CAPABILITY_UNDECLARED');
  assert.deepEqual(undeclared.deniedToolIds, ['tool.read']);
});

test('unused parent descriptors grant no child authority and requested tool order remains deterministic', () => {
  const result = deriveSubagentAuthorityEnvelopeV1(request({
    parentToolIds: ['tool.read', 'tool.write', 'tool.second', 'tool.unused'],
    ownerAllowedToolIds: ['tool.read', 'tool.write', 'tool.second'],
    requestedToolIds: ['tool.second', 'tool.read'],
    parentToolDescriptors: [
      tool('tool.unused', ['cap.admin']),
      tool('tool.read', ['cap.read']),
      tool('tool.second', ['cap.read']),
    ],
  }));
  assert.equal(result.decision, 'ALLOW');
  assert.deepEqual(result.toolIds, ['tool.second', 'tool.read']);
  assert.deepEqual(result.toolDescriptors.map(item => item.toolId), ['tool.second', 'tool.read']);
});


test('task cannot substitute tool descriptor semantics for an authorized tool identity', () => {
  assert.throws(
    () => deriveSubagentAuthorityEnvelopeV1({
      ...request(),
      parentToolDescriptors: undefined,
      toolDescriptors: [tool('tool.read', ['cap.read'], 'provider.main')],
    }),
    /unknown field: toolDescriptors/,
  );

  assert.throws(
    () => deriveSubagentAuthorityEnvelopeV1(request({
      parentToolDescriptors: [tool('tool.unowned')],
    })),
    /parentToolDescriptors exceeds parentToolIds: tool\.unowned/,
  );
});

test('parent and child identities must be distinct', () => {
  const result = deriveSubagentAuthorityEnvelopeV1(request({
    childAgentId: 'agent.parent',
  }));
  assert.equal(result.decision, 'DENY');
  assert.equal(result.reasonCode, 'CHILD_IDENTITY_NOT_ISOLATED');
});

test('request boundary rejects accessors, symbols and unknown authority without getter reads', () => {
  let reads = 0;
  const accessor = request();
  Object.defineProperty(accessor, 'providerId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'provider.main';
    },
  });
  assert.throws(
    () => deriveSubagentAuthorityEnvelopeV1(accessor),
    /providerId.*enumerable own data property/,
  );
  assert.equal(reads, 0);

  const symbol = request();
  symbol[Symbol('credentialAuthority')] = true;
  assert.throws(() => deriveSubagentAuthorityEnvelopeV1(symbol), /symbol field/);

  assert.throws(
    () => deriveSubagentAuthorityEnvelopeV1({ ...request(), executionAuthority: true }),
    /unknown field: executionAuthority/,
  );
});

test('list and ToolDescriptor boundaries reject hostile shapes without evaluating getters', () => {
  const sparse = request();
  sparse.taskSourceIds = new Array(2);
  sparse.taskSourceIds[0] = 'source.repo';
  assert.throws(() => deriveSubagentAuthorityEnvelopeV1(sparse), /dense data-only array/);

  let reads = 0;
  const descriptor = tool('tool.read');
  Object.defineProperty(descriptor, 'capabilityIds', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return ['cap.read'];
    },
  });
  assert.throws(
    () => deriveSubagentAuthorityEnvelopeV1(request({ parentToolDescriptors: [descriptor] })),
    /enumerable own data properties/,
  );
  assert.equal(reads, 0);
});

test('duplicates fail closed instead of creating ambiguous child authority', () => {
  assert.throws(
    () => deriveSubagentAuthorityEnvelopeV1(request({
      taskRequestedCapabilityIds: ['cap.read', 'cap.read'],
    })),
    /contains duplicates/,
  );
  assert.throws(
    () => deriveSubagentAuthorityEnvelopeV1(request({
      requestedToolIds: ['tool.read', 'tool.read'],
    })),
    /contains duplicates/,
  );
  assert.throws(
    () => deriveSubagentAuthorityEnvelopeV1(request({
      parentToolDescriptors: [tool('tool.read'), tool('tool.read')],
    })),
    /duplicate toolId/,
  );
});
