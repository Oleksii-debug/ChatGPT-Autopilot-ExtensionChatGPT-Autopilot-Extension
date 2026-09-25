import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINAL_AGENT_PAYLOAD_KIND,
  TERMINAL_AGENT_PROVIDER_ID,
  createTerminalAgentPayloadDescriptorV1,
  createTerminalAgentSourceBindingIdV1,
  createTerminalAgentTriggerObservationV1,
} from '../src/core/terminal-agent-trigger-adapter.js';
import {
  EventTriggerKind,
  createEventTriggerAdmissionV1,
} from '../src/core/event-trigger-contract.js';
import { OrchestrationTerminalStatus } from '../src/core/orchestration-hierarchy.js';

const T0 = '2026-09-25T10:00:00.000Z';
const T1 = '2026-09-25T10:01:00.000Z';
const T2 = '2026-09-25T10:02:00.000Z';
const T3 = '2026-09-25T10:03:00.000Z';

function identity(overrides = {}) {
  return {
    graphId: 'graph.main',
    controlEpoch: 7,
    nodeId: 'node.worker.3',
    generation: 4,
    activationId: 'activation.worker.3.g4',
    ...overrides,
  };
}

function fact(overrides = {}) {
  return {
    ...identity(),
    status: OrchestrationTerminalStatus.COMPLETED,
    terminalAt: T1,
    ...overrides,
  };
}

async function trigger(overrides = {}) {
  return {
    schemaVersion: 1,
    triggerId: 'trigger.terminal.worker.3',
    triggerRevision: 5,
    agentId: 'agent.coordinator',
    jobId: 'job.main',
    kind: EventTriggerKind.TERMINAL_AGENT,
    providerId: TERMINAL_AGENT_PROVIDER_ID,
    sourceBindingId: await createTerminalAgentSourceBindingIdV1({
      graphId: 'graph.main',
      nodeId: 'node.worker.3',
    }),
    requiredCapabilityIds: ['cap.orchestration.observe'],
    enabled: true,
    createdAt: T0,
    ...overrides,
  };
}

async function payload(overrides = {}, terminalFact = fact()) {
  const descriptor = await createTerminalAgentPayloadDescriptorV1(terminalFact);
  return {
    schemaVersion: 1,
    artifactId: 'artifact.terminal.worker.3',
    kind: TERMINAL_AGENT_PAYLOAD_KIND,
    uri: 'artifact://orchestration/terminal/worker.3',
    mediaType: 'application/json',
    sha256: descriptor.sha256,
    sizeBytes: descriptor.sizeBytes,
    createdAt: T2,
    producerInvocationId: 'orchestration-runtime',
    sensitive: false,
    ...overrides,
  };
}

function dependencies(terminalFact = fact()) {
  return {
    resolveTerminalActivation: async query => {
      assert.deepEqual(query, identity());
      return structuredClone(terminalFact);
    },
  };
}

test('projects one trusted orchestration terminal fact into deterministic TERMINAL_AGENT observation', async () => {
  const t = await trigger();
  const p = await payload();
  const first = await createTerminalAgentTriggerObservationV1({
    trigger: t,
    terminalIdentity: identity(),
    payloadArtifactRef: p,
    observedAt: T3,
  }, dependencies());
  const second = await createTerminalAgentTriggerObservationV1({
    trigger: structuredClone(t),
    terminalIdentity: identity(),
    payloadArtifactRef: structuredClone(p),
    observedAt: T3,
  }, dependencies());

  assert.deepEqual(second, first);
  assert.equal(first.providerId, TERMINAL_AGENT_PROVIDER_ID);
  assert.match(first.sourceEventId, /^terminal-event:[a-f0-9]{64}$/u);
  assert.match(first.observationId, /^terminal-observation:[a-f0-9]{64}$/u);
  assert.equal(first.payloadArtifactRef.kind, TERMINAL_AGENT_PAYLOAD_KIND);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.payloadArtifactRef), true);
});

test('generated observation composes with the canonical EventTrigger admission without minting execution authority', async () => {
  const t = await trigger();
  const observation = await createTerminalAgentTriggerObservationV1({
    trigger: t,
    terminalIdentity: identity(),
    payloadArtifactRef: await payload(),
    observedAt: T3,
  }, dependencies());

  const admission = await createEventTriggerAdmissionV1({
    trigger: t,
    observation,
    admittedAt: T3,
  }, {
    resolveTriggerDefinition: async () => structuredClone(t),
  });

  assert.equal(admission.kind, EventTriggerKind.TERMINAL_AGENT);
  assert.equal(admission.status, 'READY_FOR_SCHEDULER');
  assert.equal(admission.executionAuthorized, false);
  assert.equal(admission.policyDecisionGranted, false);
  assert.equal(admission.sourceEventId, observation.sourceEventId);
  assert.equal(admission.payloadSha256, observation.payloadArtifactRef.sha256);
});

test('source binding is deterministic for exact graph/node identity and rejects aliases', async () => {
  const first = await createTerminalAgentSourceBindingIdV1({
    graphId: 'graph.main',
    nodeId: 'node.worker.3',
  });
  const second = await createTerminalAgentSourceBindingIdV1({
    graphId: 'graph.main',
    nodeId: 'node.worker.3',
  });
  assert.equal(second, first);
  assert.match(first, /^terminal-binding:[a-f0-9]{64}$/u);

  await assert.rejects(
    () => createTerminalAgentSourceBindingIdV1({
      graphId: ' graph.main ',
      nodeId: 'node.worker.3',
    }),
    /graphId is invalid/u,
  );
});

test('trusted terminal fact must match every requested causal identity field', async () => {
  const t = await trigger();
  for (const drift of [
    { graphId: 'graph.other' },
    { controlEpoch: 8 },
    { nodeId: 'node.other' },
    { generation: 5 },
    { activationId: 'activation.other' },
  ]) {
    const terminalFact = fact(drift);
    await assert.rejects(
      async () => createTerminalAgentTriggerObservationV1({
        trigger: t,
        terminalIdentity: identity(),
        payloadArtifactRef: await payload({}, terminalFact),
        observedAt: T3,
      }, dependencies(terminalFact)),
      /does not match requested terminal identity/u,
    );
  }
});

test('terminal status and timestamps are exact canonical trusted fact data', async () => {
  const t = await trigger();
  for (const terminalFact of [
    fact({ status: 'completed' }),
    fact({ status: ' COMPLETED ' }),
    fact({ terminalAt: '2026-09-25T10:01:00Z' }),
  ]) {
    await assert.rejects(
      async () => createTerminalAgentTriggerObservationV1({
        trigger: t,
        terminalIdentity: identity(),
        payloadArtifactRef: await payload(),
        observedAt: T3,
      }, dependencies(terminalFact)),
    );
  }
});

test('payload artifact is byte-identity bound to canonical terminal fact material', async () => {
  const t = await trigger();
  await assert.rejects(
    async () => createTerminalAgentTriggerObservationV1({
      trigger: t,
      terminalIdentity: identity(),
      payloadArtifactRef: await payload({ sha256: 'f'.repeat(64) }),
      observedAt: T3,
    }, dependencies()),
    /does not match canonical terminal fact bytes/u,
  );
  await assert.rejects(
    async () => createTerminalAgentTriggerObservationV1({
      trigger: t,
      terminalIdentity: identity(),
      payloadArtifactRef: await payload({ sizeBytes: 1 }),
      observedAt: T3,
    }, dependencies()),
    /does not match canonical terminal fact bytes/u,
  );
});

test('payload representation and chronology fail closed', async () => {
  const t = await trigger();
  for (const artifactPatch of [
    { kind: 'generic-json' },
    { mediaType: 'text/plain' },
    { sensitive: true },
    { createdAt: T0 },
  ]) {
    await assert.rejects(
      async () => createTerminalAgentTriggerObservationV1({
        trigger: t,
        terminalIdentity: identity(),
        payloadArtifactRef: await payload(artifactPatch),
        observedAt: T3,
      }, dependencies()),
    );
  }

  await assert.rejects(
    async () => createTerminalAgentTriggerObservationV1({
      trigger: t,
      terminalIdentity: identity(),
      payloadArtifactRef: await payload(),
      observedAt: T0,
    }, dependencies()),
    /predates trusted terminal fact/u,
  );
});

test('trigger kind, provider and graph/node binding must be canonical', async () => {
  const good = await trigger();
  for (const badTrigger of [
    await trigger({ kind: EventTriggerKind.WEBHOOK }),
    await trigger({ providerId: 'provider.other' }),
    await trigger({ sourceBindingId: 'terminal-binding:' + 'a'.repeat(64) }),
  ]) {
    await assert.rejects(
      async () => createTerminalAgentTriggerObservationV1({
        trigger: badTrigger,
        terminalIdentity: identity(),
        payloadArtifactRef: await payload(),
        observedAt: T3,
      }, dependencies()),
    );
  }

  const observation = await createTerminalAgentTriggerObservationV1({
    trigger: good,
    terminalIdentity: identity(),
    payloadArtifactRef: await payload(),
    observedAt: T3,
  }, dependencies());
  assert.equal(observation.triggerId, good.triggerId);
});

test('hostile request/dependency accessors are rejected without getter execution', async () => {
  let reads = 0;
  const t = await trigger();
  const request = {
    trigger: t,
    terminalIdentity: identity(),
    payloadArtifactRef: await payload(),
    observedAt: T3,
  };
  Object.defineProperty(request, 'terminalIdentity', {
    enumerable: true,
    get() {
      reads += 1;
      return identity();
    },
  });
  await assert.rejects(
    () => createTerminalAgentTriggerObservationV1(request, dependencies()),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0);

  const hostileDeps = {};
  Object.defineProperty(hostileDeps, 'resolveTerminalActivation', {
    enumerable: true,
    get() {
      reads += 1;
      return dependencies().resolveTerminalActivation;
    },
  });
  await assert.rejects(
    async () => createTerminalAgentTriggerObservationV1({
      trigger: t,
      terminalIdentity: identity(),
      payloadArtifactRef: await payload(),
      observedAt: T3,
    }, hostileDeps),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0);
});

test('changing trusted terminal status changes exact source event and payload identities', async () => {
  const t = await trigger();
  const completedFact = fact({ status: OrchestrationTerminalStatus.COMPLETED });
  const failedFact = fact({ status: OrchestrationTerminalStatus.FAILED });

  const completed = await createTerminalAgentTriggerObservationV1({
    trigger: t,
    terminalIdentity: identity(),
    payloadArtifactRef: await payload({}, completedFact),
    observedAt: T3,
  }, dependencies(completedFact));
  const failed = await createTerminalAgentTriggerObservationV1({
    trigger: t,
    terminalIdentity: identity(),
    payloadArtifactRef: await payload({}, failedFact),
    observedAt: T3,
  }, dependencies(failedFact));

  assert.notEqual(failed.sourceEventId, completed.sourceEventId);
  assert.notEqual(failed.payloadArtifactRef.sha256, completed.payloadArtifactRef.sha256);
});
