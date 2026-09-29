import test from 'node:test';
import assert from 'node:assert/strict';

import { StorageRepository } from '../src/core/storage.js';
import { OrchestrationV2Manager } from '../src/core/orchestration-v2-manager.js';
import {
  ProjectWorkspaceRepository,
  addProjectSnapshot,
  putProjectContextCapsule,
} from '../src/core/project-workspace.js';
import {
  OrchestrationActivationPurpose,
  OrchestrationBarrierMode,
  OrchestrationChatMode,
  OrchestrationHierarchyEventType,
  createOrchestrationHierarchyRuntime,
  reduceOrchestrationHierarchyEvent,
  validateOrchestrationGraphV1,
} from '../src/core/orchestration-hierarchy.js';
import { deriveSubagentTaskDispatchIdentityV1 } from '../src/core/subagent-task-envelope.js';

const T0 = '2026-09-29T04:00:00.000Z';
const T1 = '2026-09-29T04:01:00.000Z';
const T2 = '2026-09-29T04:02:00.000Z';

function chromeFake() {
  const data = {};
  return {
    data,
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map(item => [item, structuredClone(data[item])]));
          }
          return { [key]: structuredClone(data[key]) };
        },
        async set(record) {
          Object.assign(data, structuredClone(record));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        },
      },
    },
    alarms: { async create() {}, async clear() { return true; } },
  };
}

function config() {
  return {
    enabled: false,
    projectId: 'project.alpha',
    targetRepository: 'owner/repo',
    controlRepository: 'owner/repo',
    controlIssueNumber: 1,
    masterCoordinatorPrompt: 'master',
    defaultDesiredWorkers: 1,
    absoluteMaxWorkers: 2,
  };
}

function source(sourceId, { sha = 'a'.repeat(64) } = {}) {
  return {
    schemaVersion: 1,
    sourceId,
    projectId: 'project.alpha',
    kind: 'document',
    uri: 'private://parent/' + sourceId,
    revisionId: 'r1',
    contentSha256: sha,
    observedAt: T0,
    authority: 'CANONICAL',
    metadata: { label: sourceId },
  };
}

function artifact(artifactId, { sha = 'b'.repeat(64) } = {}) {
  return {
    schemaVersion: 1,
    artifactId,
    kind: 'document',
    uri: 'private://artifact/' + artifactId,
    mediaType: 'text/plain',
    sha256: sha,
    sizeBytes: 12,
    createdAt: T0,
    producerInvocationId: '',
    sensitive: false,
  };
}

function snapshot() {
  return {
    schemaVersion: 1,
    projectId: 'project.alpha',
    revisionId: 'project-r2',
    title: 'SECRET PARENT PROJECT TITLE',
    sourceRefs: [
      source('source.allowed'),
      source('source.secret', { sha: 'c'.repeat(64) }),
    ],
    artifactRefs: [
      artifact('artifact.allowed'),
      artifact('artifact.secret', { sha: 'd'.repeat(64) }),
    ],
    createdAt: T1,
  };
}

function capsule() {
  return {
    schemaVersion: 1,
    capsuleId: 'capsule.parent',
    projectId: 'project.alpha',
    projectRevisionId: 'project-r2',
    summary: 'SECRET PARENT SUMMARY',
    sourceBindings: [
      { sourceId: 'source.allowed', revisionId: 'r1', contentSha256: 'a'.repeat(64) },
      { sourceId: 'source.secret', revisionId: 'r1', contentSha256: 'c'.repeat(64) },
    ],
    artifactRefs: [
      artifact('artifact.allowed'),
      artifact('artifact.secret', { sha: 'd'.repeat(64) }),
    ],
    createdAt: T1,
  };
}

function authorityEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    decision: 'ALLOW',
    reasonCode: 'LEAST_AUTHORITY_DERIVED',
    projectId: 'project.alpha',
    parentAgentId: 'agent.parent',
    childAgentId: 'agent.child',
    taskId: 'task.child',
    providerId: 'provider.main',
    capabilityIds: ['cap.read'],
    sourceIds: ['source.allowed', 'source.secret'],
    artifactIds: ['artifact.allowed', 'artifact.secret'],
    toolIds: ['tool.read'],
    toolDescriptors: [],
    executionAuthority: false,
    credentialAuthority: false,
    policyAuthority: false,
    ...overrides,
  };
}

function taskEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    envelopeId: 'task-envelope.1',
    projectId: 'project.alpha',
    parentAgentId: 'agent.parent',
    childAgentId: 'agent.child',
    taskId: 'task.child',
    planId: 'plan.1',
    planRevision: 1,
    objective: 'Use only the exact task inputs.',
    conflictKeys: [],
    budget: {
      maxModelCalls: 1,
      maxRuntimeSeconds: 60,
      maxCostUsdMicros: 1000,
    },
    inputSourceRefs: [{
      sourceId: 'source.allowed',
      location: 'private://parent/source.allowed',
      revisionId: 'r1',
      contentSha256: 'a'.repeat(64),
    }],
    inputArtifactRefs: [artifact('artifact.allowed')],
    outcome: {
      contractId: 'outcome.1',
      contractRevision: 1,
      desiredResult: 'Return one verified result.',
      criterionIds: ['criterion.1'],
      deliverableIds: ['deliverable.1'],
      verifierId: 'verifier.1',
      requiredEvidenceArtifactCount: 1,
    },
    createdAt: T1,
    planProvenance: 'UNVERIFIED_INPUT',
    outcomeProvenance: 'UNVERIFIED_INPUT',
    inputReferenceProvenance: 'UNVERIFIED_INPUT',
    trustedResolutionRequired: true,
    executionAuthority: false,
    schedulingAuthority: false,
    policyAuthority: false,
    credentialAuthority: false,
    completionAuthority: false,
    ...overrides,
  };
}

function graph() {
  return validateOrchestrationGraphV1({
    schemaVersion: 1,
    graphId: 'context-owner-graph',
    controlEpoch: 7,
    loopPolicy: { mode: 'ONE_SHOT', maxRounds: 0 },
    promptProfiles: [
      { id: 'parent-profile', role: 'PARENT', version: 1, prompt: 'parent' },
      { id: 'child-profile', role: 'CHILD', version: 1, prompt: 'child' },
    ],
    nodes: [
      {
        id: 'agent.parent',
        parentId: null,
        childIds: ['agent.child'],
        promptProfileId: 'parent-profile',
        chatMode: OrchestrationChatMode.PERSISTENT_CHAT,
        maxActiveChildren: 1,
        barrier: {
          mode: OrchestrationBarrierMode.ALL_DIRECT_CHILDREN,
          childIds: ['agent.child'],
        },
      },
      {
        id: 'agent.child',
        parentId: 'agent.parent',
        childIds: [],
        promptProfileId: 'child-profile',
        chatMode: OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION,
        maxActiveChildren: 0,
        barrier: { mode: OrchestrationBarrierMode.NONE, childIds: [] },
      },
    ],
  });
}

async function fixture({ projectWorkspaceRepository = null } = {}) {
  const chrome = chromeFake();
  const core = new StorageRepository(chrome);
  const workspace = projectWorkspaceRepository || new ProjectWorkspaceRepository(chrome);
  if (!projectWorkspaceRepository) {
    await workspace.update(draft => {
      addProjectSnapshot(draft, snapshot(), { nowMs: Date.parse(T1) });
      putProjectContextCapsule(draft, capsule(), { nowMs: Date.parse(T1) });
      return draft;
    }, { nowMs: Date.parse(T1) });
  }

  const manager = new OrchestrationV2Manager({
    coreRepository: core,
    chromeApi: chrome,
    projectWorkspaceRepository: workspace,
    createId: () => 'orch-1',
    now: () => Date.parse(T2),
  });
  await manager.create({ name: 'Context owner', config: config() });

  const canonicalGraph = graph();
  const initial = createOrchestrationHierarchyRuntime(canonicalGraph, Date.parse(T0));
  const task = taskEnvelope();
  const prepared = reduceOrchestrationHierarchyEvent(
    canonicalGraph,
    initial,
    {
      type: OrchestrationHierarchyEventType.NODE_ACTIVATION_REQUESTED,
      eventId: 'context-owner:activate',
      controlEpoch: 7,
      nodeId: 'agent.child',
      generation: 1,
      activationId: 'child-activation-1',
      purpose: OrchestrationActivationPurpose.WORK,
      providerDispatchIdentity: deriveSubagentTaskDispatchIdentityV1(task),
    },
    Date.parse(T1),
  );
  await manager.controllerFor('orch-1').runtimeRepository.update(runtime => {
    runtime.hierarchy = {
      schemaVersion: 1,
      graph: canonicalGraph,
      state: prepared.runtime,
    };
    return runtime;
  });

  const registered = await manager.registerSubagentTaskActivationBinding({
    taskEnvelope: task,
    activationAction: prepared.actions[0],
    invocationId: 'invocation-child-1',
    authorityEnvelope: authorityEnvelope(),
  }, 'orch-1');

  return { chrome, manager, task, registered, prepared };
}

function contextRequest(task, bindingId, overrides = {}) {
  return {
    bindingId,
    taskEnvelope: task,
    expectedProjectRevisionId: 'project-r2',
    capsuleId: 'capsule.parent',
    ...overrides,
  };
}

test('orchestration owner resolves exact durable task binding before projecting Project context', async () => {
  const { manager, task, registered } = await fixture();
  const result = await manager.resolveDurableSubagentTaskContext(
    contextRequest(task, registered.binding.bindingId),
    'orch-1',
  );

  assert.equal(result.orchestraId, 'orch-1');
  assert.equal(result.bindingId, registered.binding.bindingId);
  assert.equal(result.taskDispatchIdentity, registered.binding.taskDispatchIdentity);
  assert.equal(result.activationId, 'child-activation-1');
  assert.equal(result.generation, 1);
  assert.equal(result.activationPurpose, OrchestrationActivationPurpose.WORK);
  assert.equal(result.providerId, 'provider.main');
  assert.equal(result.ownerStateSource, 'DURABLE_PROJECT_WORKSPACE');
  assert.equal(result.parentProjectRevisionId, 'project-r2');
  assert.equal(result.sourceTrust, 'DURABLE_OWNER_STATE_SOURCE_AUTHORITY_NOT_AUTHENTICATED');
  assert.deepEqual(result.projectedSnapshot.sourceRefs.map(item => item.sourceId), ['source.allowed']);
  assert.deepEqual(result.projectedSnapshot.artifactRefs.map(item => item.artifactId), ['artifact.allowed']);
  assert.deepEqual(result.priorBindings.sourceBindings.map(item => item.sourceId), ['source.allowed']);
  assert.deepEqual(result.priorBindings.artifactRefs.map(item => item.artifactId), ['artifact.allowed']);
  assert.equal(JSON.stringify(result).includes('source.secret'), false);
  assert.equal(JSON.stringify(result).includes('artifact.secret'), false);
  assert.equal(JSON.stringify(result).includes('SECRET PARENT PROJECT TITLE'), false);
  assert.equal(JSON.stringify(result).includes('SECRET PARENT SUMMARY'), false);
  assert.equal(result.retrievalAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.credentialAuthority, false);
  assert.equal(result.policyAuthority, false);
  assert.equal(Object.isFrozen(result), true);
});

test('durable child context uses persisted authority provenance and rejects provider substitution', async () => {
  const { chrome, manager, task, registered, prepared } = await fixture();
  const before = structuredClone(
    chrome.data['autopilotOrchestrationV2Runtime:orch-1'].subagentTaskActivationBindingRegistry,
  );

  await assert.rejects(
    () => manager.registerSubagentTaskActivationBinding({
      taskEnvelope: task,
      activationAction: prepared.actions[0],
      invocationId: 'invocation-child-1',
      authorityEnvelope: authorityEnvelope({ providerId: 'provider.other' }),
    }, 'orch-1'),
    /authority provenance collision/,
  );
  assert.deepEqual(
    chrome.data['autopilotOrchestrationV2Runtime:orch-1'].subagentTaskActivationBindingRegistry,
    before,
  );

  const forgedContext = contextRequest(task, registered.binding.bindingId);
  forgedContext.authorityEnvelope = authorityEnvelope({ providerId: 'provider.other' });
  await assert.rejects(
    () => manager.resolveDurableSubagentTaskContext(forgedContext, 'orch-1'),
    /unknown field: authorityEnvelope/,
  );

  const durable = await manager.resolveDurableSubagentTaskContext(
    contextRequest(task, registered.binding.bindingId),
    'orch-1',
  );
  assert.equal(durable.providerId, 'provider.main');
});

test('orchestration owner rejects task semantic substitution against durable activation evidence', async () => {
  let resolverCalls = 0;
  const projectWorkspaceRepository = {
    async resolveContext() {
      resolverCalls += 1;
      throw new Error('resolver must not be reached for a substituted task');
    },
  };
  const { manager, task, registered } = await fixture({ projectWorkspaceRepository });
  const substituted = structuredClone(task);
  substituted.objective = 'Different task semantics with the same visible identities.';

  await assert.rejects(
    () => manager.resolveDurableSubagentTaskContext(
      contextRequest(substituted, registered.binding.bindingId),
      'orch-1',
    ),
    /taskDispatchIdentity/,
  );
  assert.equal(resolverCalls, 0);
});

test('orchestration owner rejects unknown binding and stale Project revision fail closed', async () => {
  const { manager, task, registered } = await fixture();

  await assert.rejects(
    () => manager.resolveDurableSubagentTaskContext(
      contextRequest(task, 'subagent-task-activation-binding:missing'),
      'orch-1',
    ),
    /activation binding not found/,
  );

  await assert.rejects(
    () => manager.resolveDurableSubagentTaskContext(
      contextRequest(task, registered.binding.bindingId, {
        expectedProjectRevisionId: 'project-r1',
      }),
      'orch-1',
    ),
    /snapshot revision binding mismatch/,
  );
});

test('orchestration owner context request rejects authority aliases and accessors before durable context lookup', async () => {
  let resolverCalls = 0;
  const projectWorkspaceRepository = {
    async resolveContext() {
      resolverCalls += 1;
      throw new Error('resolver must not be reached');
    },
  };
  const { manager, task, registered } = await fixture({ projectWorkspaceRepository });
  const unknown = contextRequest(task, registered.binding.bindingId);
  unknown.expectedChildAgentId = 'agent.child';
  await assert.rejects(
    () => manager.resolveDurableSubagentTaskContext(unknown, 'orch-1'),
    /unknown field: expectedChildAgentId/,
  );

  let reads = 0;
  const hostile = contextRequest(task, registered.binding.bindingId);
  Object.defineProperty(hostile, 'expectedProjectRevisionId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'project-r2';
    },
  });
  await assert.rejects(
    () => manager.resolveDurableSubagentTaskContext(hostile, 'orch-1'),
    /expectedProjectRevisionId must be an enumerable own data property/,
  );
  assert.equal(reads, 0);
  assert.equal(resolverCalls, 0);
});
