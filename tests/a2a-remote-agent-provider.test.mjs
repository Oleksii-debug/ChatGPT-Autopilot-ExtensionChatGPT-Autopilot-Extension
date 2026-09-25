import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2A_JSONRPC_METHOD_SEND_MESSAGE,
  A2ARemoteAgentProviderV1,
} from '../src/core/a2a-remote-agent-provider.js';
import {
  ExactEffectEventType,
  ExactEffectPhase,
  createExactEffectStateV1,
  reduceExactEffectV1,
} from '../src/core/universal-agent-exact-effect.js';

const T0 = '2026-09-25T00:00:00.000Z';
const T1 = '2026-09-25T00:10:00.000Z';
const T2 = '2026-09-25T00:20:00.000Z';
const T3 = '2026-09-25T00:30:00.000Z';
const T4 = '2026-09-25T00:40:00.000Z';
const sha = char => char.repeat(64);

function requirement() {
  return {
    schemes: [{ schemeId: 'oauth.main', scopeIds: ['agent.connect'] }],
  };
}

function card(overrides = {}) {
  return {
    schemaVersion: 1,
    remoteAgentId: 'agent.remote',
    cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
    cardSha256: sha('a'),
    name: 'Remote Agent',
    supportedInterfaces: [{
      url: 'https://agent.example.com/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      tenant: null,
    }],
    skillIds: ['research'],
    securitySchemeIds: ['oauth.main'],
    securityRequirements: [requirement()],
    skillSecurityRequirements: [{
      skillId: 'research',
      securityRequirements: [requirement()],
    }],
    signatureEvidenceArtifactIds: [],
    discoveredAt: T0,
    advisoryOnly: true,
    executionAuthorized: false,
    credentialMaterialPresent: false,
    ...overrides,
  };
}

function admission(overrides = {}) {
  return {
    schemaVersion: 1,
    admissionRefId: 'admission-1',
    remoteAgentId: 'agent.remote',
    cardSha256: sha('a'),
    interfaceUrl: 'https://agent.example.com/a2a',
    protocolBinding: 'JSONRPC',
    protocolVersion: '1.0',
    tenant: null,
    allowedSkillIds: ['research'],
    allowedCapabilityIds: ['remote.research'],
    allowedSecuritySchemeIds: ['oauth.main'],
    decidedAt: T1,
    expiresAt: '2026-09-25T01:00:00.000Z',
    advisoryOnly: true,
    executionAuthorized: false,
    credentialUseAuthorized: false,
    ...overrides,
  };
}

function delegation(overrides = {}) {
  return {
    schemaVersion: 1,
    delegationId: 'delegation-1',
    localAgentId: 'agent.local',
    localTaskId: 'task-1',
    effectId: 'effect-1',
    remoteAgentId: 'agent.remote',
    requestedSkillId: 'research',
    requestedCapabilityIds: ['remote.research'],
    declaredSecurityRequirement: requirement(),
    taskEnvelopeArtifactId: 'artifact-task-envelope',
    inputArtifactIds: ['artifact-input-1'],
    policyDecisionId: 'policy-1',
    createdAt: T2,
    credentialMaterialPresent: false,
    executionAuthorized: false,
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'policy-1',
    invocationId: 'effect-1',
    decision: 'ALLOW',
    reasonCode: 'OWNER_POLICY_ALLOW',
    reason: 'Allowed by canonical owner policy',
    approvalId: null,
    decidedAt: T3,
    ...overrides,
  };
}

function okResponse(effectId = 'effect-1', result = {
  task: {
    id: 'remote-task-1',
    status: { state: 'TASK_STATE_SUBMITTED' },
  },
}) {
  return {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ jsonrpc: '2.0', id: effectId, result }),
  };
}

function harness({ response = okResponse(), transportError = null, now = Date.parse(T4) } = {}) {
  const calls = [];
  const transport = {
    async sendJsonRpc(request) {
      calls.push(request);
      if (transportError) throw transportError;
      return response;
    },
  };
  const provider = new A2ARemoteAgentProviderV1({
    transport,
    now: () => now,
  });
  return { provider, calls };
}

function sendInput(overrides = {}) {
  return {
    card: card(),
    admission: admission(),
    delegation: delegation(),
    policyDecision: policy(),
    messageText: 'Investigate the supplied artifact and return evidence.',
    timeoutMs: 5000,
    ...overrides,
  };
}

function preparedExactState(invocationOverrides = {}) {
  return createExactEffectStateV1({
    schemaVersion: 1,
    invocationId: 'effect-1',
    toolId: 'a2a.send-message',
    providerId: 'a2a-remote-agent',
    requestedCapabilityIds: ['remote.research'],
    policyDecisionId: 'policy-1',
    arguments: { delegationId: 'delegation-1' },
    createdAt: T2,
    parentInvocationId: null,
    ...invocationOverrides,
  }, { createdAt: T2 });
}

function executingExactState(invocationOverrides = {}) {
  const prepared = preparedExactState(invocationOverrides);
  const transition = reduceExactEffectV1(prepared, {
    schemaVersion: 1,
    eventId: 'event-begin-1',
    type: ExactEffectEventType.BEGIN_EXECUTION,
    effectId: prepared.effectId,
    at: T3,
  });
  assert.equal(transition.accepted, true);
  assert.equal(transition.state.phase, ExactEffectPhase.EXECUTING);
  return transition.state;
}

test('sends one exact JSON-RPC message/send through admitted interface without credential material', async () => {
  const { provider, calls } = harness();
  const result = await provider.sendMessage(sendInput());

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://agent.example.com/a2a');
  assert.equal(call.protocolVersion, '1.0');
  assert.equal(call.tenant, null);
  assert.equal(call.timeoutMs, 5000);
  assert.equal(call.effectId, 'effect-1');
  assert.deepEqual(call.securityRequirement, requirement());
  assert.equal(call.request.jsonrpc, '2.0');
  assert.equal(call.request.id, 'effect-1');
  assert.equal(call.request.method, A2A_JSONRPC_METHOD_SEND_MESSAGE);
  assert.equal(call.request.params.message.messageId, 'delegation-1');
  assert.equal(call.request.params.message.role, 'ROLE_USER');
  assert.equal(call.request.params.message.parts[0].text, sendInput().messageText);
  assert.equal(call.request.params.message.parts[0].mediaType, 'text/plain');
  assert.equal(Object.hasOwn(call.request.params.message.parts[0], 'kind'), false);
  assert.deepEqual(call.request.params.message.metadata['autopilot/inputArtifactIds'], ['artifact-input-1']);

  const serialized = JSON.stringify(call);
  assert.equal(/authorization|bearer|access_token|refresh_token|client_secret|password/i.test(serialized), false);

  assert.equal(result.providerId, 'a2a-remote-agent');
  assert.equal(result.remoteAgentId, 'agent.remote');
  assert.equal(result.effectId, 'effect-1');
  assert.equal(result.runtimeExpiryVerified, true);
  assert.equal(result.untrustedRemoteData, true);
  assert.equal(result.effectMayHaveOccurred, true);
  assert.equal(result.safeToRetry, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.credentialUseAuthorized, false);
  assert.equal(result.policyDecision, 'NONE');
  assert.equal(result.requiresIndependentVerification, true);
  assert.equal(result.requiresCanonicalExactEffectCommit, true);
  assert.equal(result.remoteResult.task.id, 'remote-task-1');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.remoteResult), true);
});

test('strict v1.0 SendMessageResponse accepts exactly one Task or Message payload', async () => {
  const validMessage = {
    message: {
      messageId: 'remote-message-1',
      role: 'ROLE_AGENT',
      parts: [{ text: 'done', mediaType: 'text/plain' }],
    },
  };
  const { provider: messageProvider } = harness({ response: okResponse('effect-1', validMessage) });
  const messageResult = await messageProvider.sendMessage(sendInput());
  assert.equal(messageResult.remoteResult.message.messageId, 'remote-message-1');

  const invalidResults = [
    {},
    {
      task: { id: 'remote-task-1', status: { state: 'TASK_STATE_WORKING' } },
      message: { messageId: 'remote-message-1' },
    },
    { task: { id: 'remote-task-1' }, extra: true },
    { task: { id: '' } },
    { task: { id: ' remote-task-1 ' } },
    { message: { messageId: '' } },
    { message: { messageId: ' remote-message-1 ' } },
  ];

  for (const result of invalidResults) {
    const { provider, calls } = harness({ response: okResponse('effect-1', result) });
    await assert.rejects(
      provider.sendMessage(sendInput()),
      error => error.code === 'A2A_RESPONSE_INVALID'
        && error.effectMayHaveOccurred === true
        && error.safeToRetry === false,
    );
    assert.equal(calls.length, 1);
  }
});

test('converts an exact Task response into canonical ObservationV1 for the current execution attempt', async () => {
  const response = okResponse('effect-1', {
    task: {
      id: 'remote-task-1',
      status: { state: 'TASK_STATE_WORKING' },
      metadata: { privateRemoteContent: 'must-not-persist-in-observation' },
    },
  });
  const { provider } = harness({ response });
  const providerResult = await provider.sendMessage(sendInput());
  const exactEffectState = executingExactState();

  const observation = provider.toObservation({
    providerResult,
    exactEffectState,
  });

  assert.equal(observation.schemaVersion, 1);
  assert.equal(observation.observationId, 'effect-1:attempt:1');
  assert.equal(observation.invocationId, 'effect-1');
  assert.equal(observation.status, 'OK');
  assert.equal(observation.observedAt, T4);
  assert.equal(observation.data.protocol, 'A2A');
  assert.equal(observation.data.protocolVersion, '1.0');
  assert.equal(observation.data.providerId, 'a2a-remote-agent');
  assert.equal(observation.data.remoteAgentId, 'agent.remote');
  assert.equal(observation.data.delegationId, 'delegation-1');
  assert.equal(observation.data.resultKind, 'TASK');
  assert.equal(observation.data.remoteTaskId, 'remote-task-1');
  assert.equal(observation.data.remoteMessageId, null);
  assert.equal(observation.data.untrustedRemoteData, true);
  assert.equal(observation.data.executionAuthorized, false);
  assert.equal(observation.data.credentialUseAuthorized, false);
  assert.equal(observation.data.requiresIndependentVerification, true);
  assert.deepEqual(observation.artifactRefs, []);
  assert.equal(JSON.stringify(observation).includes('must-not-persist-in-observation'), false);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.data), true);

  const recorded = reduceExactEffectV1(exactEffectState, {
    schemaVersion: 1,
    eventId: 'event-observation-1',
    type: ExactEffectEventType.RECORD_OBSERVATION,
    effectId: exactEffectState.effectId,
    executionId: exactEffectState.executionId,
    at: T4,
    observation,
  });
  assert.equal(recorded.accepted, true);
  assert.equal(recorded.state.phase, ExactEffectPhase.OBSERVED);
  assert.equal(recorded.state.observation.observationId, exactEffectState.executionId);
});

test('converts a Message response into minimal identity-only ObservationV1', async () => {
  const response = okResponse('effect-1', {
    message: {
      messageId: 'remote-message-1',
      role: 'ROLE_AGENT',
      parts: [{ text: 'sensitive remote content', mediaType: 'text/plain' }],
    },
  });
  const { provider } = harness({ response });
  const providerResult = await provider.sendMessage(sendInput());
  const observation = provider.toObservation({
    providerResult,
    exactEffectState: executingExactState(),
  });

  assert.equal(observation.data.resultKind, 'MESSAGE');
  assert.equal(observation.data.remoteTaskId, null);
  assert.equal(observation.data.remoteMessageId, 'remote-message-1');
  assert.equal(JSON.stringify(observation).includes('sensitive remote content'), false);
});

test('ObservationV1 conversion rejects cloned/cross-provider results and exact-effect mismatches', async () => {
  const { provider } = harness();
  const providerResult = await provider.sendMessage(sendInput());
  const executing = executingExactState();

  const forgedCases = [
    { ...providerResult },
    { ...providerResult, effectId: 'effect-other' },
    { ...providerResult, executionAuthorized: true },
  ];
  for (const forged of forgedCases) {
    assert.throws(
      () => provider.toObservation({
        providerResult: forged,
        exactEffectState: executing,
      }),
      error => error.code === 'A2A_PROVIDER_RESULT_UNTRUSTED',
    );
  }

  const { provider: otherProvider } = harness();
  assert.throws(
    () => otherProvider.toObservation({
      providerResult,
      exactEffectState: executing,
    }),
    error => error.code === 'A2A_PROVIDER_RESULT_UNTRUSTED',
  );

  assert.throws(
    () => provider.toObservation({
      providerResult,
      exactEffectState: preparedExactState(),
    }),
    error => error.code === 'A2A_EXACT_EFFECT_STATE_INVALID',
  );

  for (const exactEffectState of [
    executingExactState({ invocationId: 'effect-other' }),
    executingExactState({ providerId: 'other-provider' }),
    executingExactState({ policyDecisionId: 'policy-other' }),
    executingExactState({ requestedCapabilityIds: ['remote.other'] }),
  ]) {
    assert.throws(
      () => provider.toObservation({
        providerResult,
        exactEffectState,
      }),
      error => error.code === 'A2A_EXACT_EFFECT_BINDING_MISMATCH',
    );
  }
});

test('DENY and REQUIRE_APPROVAL never reach transport', async () => {
  for (const policyDecision of [
    policy({ decision: 'DENY' }),
    policy({ decision: 'REQUIRE_APPROVAL', approvalId: 'approval-1' }),
  ]) {
    const { provider, calls } = harness();
    await assert.rejects(
      provider.sendMessage(sendInput({ policyDecision })),
      error => error.code === 'A2A_POLICY_DENIED' && error.effectMayHaveOccurred === false,
    );
    assert.equal(calls.length, 0);
  }
});

test('policy identity must bind exactly to delegation decision and effect identity', async () => {
  for (const policyDecision of [
    policy({ decisionId: 'policy-other' }),
    policy({ invocationId: 'effect-other' }),
    policy({ decidedAt: T1 }),
    policy({ decidedAt: '2026-09-25T02:00:00.000Z' }),
  ]) {
    const { provider, calls } = harness();
    await assert.rejects(
      provider.sendMessage(sendInput({ policyDecision })),
      error => error.code === 'A2A_POLICY_MISMATCH',
    );
    assert.equal(calls.length, 0);
  }
});

test('trusted runtime clock blocks expired admission before transport', async () => {
  const { provider, calls } = harness({ now: Date.parse('2026-09-25T01:00:00.000Z') });
  await assert.rejects(
    provider.sendMessage(sendInput()),
    error => ['A2A_DELEGATION_BLOCKED', 'A2A_ADMISSION_EXPIRED'].includes(error.code),
  );
  assert.equal(calls.length, 0);
});

test('card/admission drift and capability drift fail closed before transport', async () => {
  const cases = [
    { card: card({ cardSha256: sha('b') }) },
    { admission: admission({ allowedCapabilityIds: [] }) },
    { delegation: delegation({ requestedCapabilityIds: ['remote.write'] }) },
  ];
  for (const patch of cases) {
    const { provider, calls } = harness();
    await assert.rejects(
      provider.sendMessage(sendInput(patch)),
      error => error.code === 'A2A_DELEGATION_BLOCKED',
    );
    assert.equal(calls.length, 0);
  }
});

test('only JSONRPC binding is executable in the first provider slice', async () => {
  const httpInterface = {
    url: 'https://agent.example.com/a2a',
    protocolBinding: 'HTTP+JSON',
    protocolVersion: '1.0',
    tenant: null,
  };
  const { provider, calls } = harness();
  await assert.rejects(
    provider.sendMessage(sendInput({
      card: card({ supportedInterfaces: [httpInterface] }),
      admission: admission({ protocolBinding: 'HTTP+JSON' }),
    })),
    error => error.code === 'A2A_TRANSPORT_NOT_IMPLEMENTED',
  );
  assert.equal(calls.length, 0);
});

test('JSONRPC protocol versions other than v1.0 fail closed before transport', async () => {
  const legacyInterface = {
    url: 'https://agent.example.com/a2a',
    protocolBinding: 'JSONRPC',
    protocolVersion: '0.3',
    tenant: null,
  };
  const { provider, calls } = harness();
  await assert.rejects(
    provider.sendMessage(sendInput({
      card: card({ supportedInterfaces: [legacyInterface] }),
      admission: admission({ protocolVersion: '0.3' }),
    })),
    error => error.code === 'A2A_PROTOCOL_VERSION_NOT_IMPLEMENTED',
  );
  assert.equal(calls.length, 0);
});

test('v1.0 tenant is transmitted inside SendMessageRequest params', async () => {
  const tenantInterface = {
    url: 'https://agent.example.com/a2a',
    protocolBinding: 'JSONRPC',
    protocolVersion: '1.0',
    tenant: 'tenant-a',
  };
  const { provider, calls } = harness();
  await provider.sendMessage(sendInput({
    card: card({ supportedInterfaces: [tenantInterface] }),
    admission: admission({ tenant: 'tenant-a' }),
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tenant, 'tenant-a');
  assert.equal(calls[0].request.params.tenant, 'tenant-a');
});

test('pre-dispatch transport failure is retryable only when transport explicitly proves it', async () => {
  const transportError = Object.assign(new Error('not dispatched'), {
    effectMayHaveOccurred: false,
    safeToRetry: true,
  });
  const { provider, calls } = harness({ transportError });
  await assert.rejects(
    provider.sendMessage(sendInput()),
    error => error.code === 'A2A_TRANSPORT_FAILED'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true,
  );
  assert.equal(calls.length, 1);
});

test('uncertain transport failure becomes canonical no-blind-replay ambiguity', async () => {
  const transportError = Object.assign(new Error('connection lost after write'), {
    effectMayHaveOccurred: true,
    safeToRetry: true,
  });
  const { provider, calls } = harness({ transportError });
  await assert.rejects(
    provider.sendMessage(sendInput()),
    error => error.code === 'A2A_EFFECT_AMBIGUOUS'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false,
  );
  assert.equal(calls.length, 1);
});

test('post-dispatch response boundary failures are always ambiguous and non-retryable', async () => {
  const cases = [
    { ...okResponse(), contentType: 'text/plain' },
    { ...okResponse(), body: '{not-json' },
    { ...okResponse(), body: JSON.stringify({ jsonrpc: '2.0', id: 'effect-other', result: {} }) },
    { ...okResponse(), body: JSON.stringify({ jsonrpc: '1.0', id: 'effect-1', result: {} }) },
    { ...okResponse(), body: JSON.stringify({ jsonrpc: '2.0', id: 'effect-1', result: {}, extra: true }) },
    { status: 503, contentType: 'application/json', body: '{}' },
    { status: 200, contentType: 'application/json', body: 'x'.repeat(300 * 1024) },
  ];
  for (const response of cases) {
    const { provider, calls } = harness({ response });
    await assert.rejects(
      provider.sendMessage(sendInput()),
      error => error.effectMayHaveOccurred === true && error.safeToRetry === false,
    );
    assert.equal(calls.length, 1);
  }
});

test('malformed transport response envelope remains post-dispatch ambiguous', async () => {
  const response = {
    ...okResponse(),
    unexpected: true,
  };
  const { provider, calls } = harness({ response });
  await assert.rejects(
    provider.sendMessage(sendInput()),
    error => error.code === 'A2A_RESPONSE_INVALID'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false,
  );
  assert.equal(calls.length, 1);
});

test('trusted clock failure after a remote response is ambiguous rather than retry-safe', async () => {
  let clockReads = 0;
  let calls = 0;
  const provider = new A2ARemoteAgentProviderV1({
    transport: {
      async sendJsonRpc() {
        calls += 1;
        return okResponse();
      },
    },
    now: () => {
      clockReads += 1;
      return clockReads === 1 ? Date.parse(T4) : NaN;
    },
  });
  await assert.rejects(
    provider.sendMessage(sendInput()),
    error => error.code === 'A2A_EFFECT_AMBIGUOUS'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false,
  );
  assert.equal(calls, 1);
  assert.equal(clockReads, 2);
});

test('JSON-RPC error is retained only as untrusted error evidence and never marked safe retry', async () => {
  const response = {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'effect-1',
      error: { code: -32001, message: 'remote rejected request', data: { kind: 'remote-data' } },
    }),
  };
  const { provider } = harness({ response });
  await assert.rejects(
    provider.sendMessage(sendInput()),
    error => error.code === 'A2A_REMOTE_ERROR_AMBIGUOUS'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false
      && error.remoteError.code === -32001,
  );
});

test('message and request boundaries fail before transport', async () => {
  const { provider, calls } = harness();

  await assert.rejects(
    provider.sendMessage(sendInput({ messageText: 'x'.repeat(40 * 1024) })),
    error => error.code === 'A2A_PROVIDER_INPUT_INVALID',
  );
  await assert.rejects(
    provider.sendMessage(sendInput({ timeoutMs: 1 })),
    error => error.code === 'A2A_PROVIDER_INPUT_INVALID',
  );

  const hostile = sendInput();
  Object.defineProperty(hostile, 'messageText', {
    enumerable: true,
    get() { throw new Error('must not execute getter'); },
  });
  await assert.rejects(
    provider.sendMessage(hostile),
    error => error.code === 'A2A_PROVIDER_INPUT_INVALID',
  );
  assert.equal(calls.length, 0);
});

test('constructor and trusted clock fail closed without network effects', async () => {
  assert.throws(
    () => new A2ARemoteAgentProviderV1({ transport: {} }),
    error => error.code === 'A2A_TRANSPORT_UNAVAILABLE',
  );

  let calls = 0;
  const provider = new A2ARemoteAgentProviderV1({
    transport: {
      async sendJsonRpc() {
        calls += 1;
        return okResponse();
      },
    },
    now: () => NaN,
  });
  await assert.rejects(
    provider.sendMessage(sendInput()),
    error => error.code === 'A2A_TIME_UNAVAILABLE',
  );
  assert.equal(calls, 0);
});
