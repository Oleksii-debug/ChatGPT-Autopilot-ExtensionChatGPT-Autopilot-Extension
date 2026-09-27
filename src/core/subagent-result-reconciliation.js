import { normalizeOutcomeContractV1 } from './outcome-contract.js';
import {
  OutcomeVerificationVerdict,
  adjudicateOutcomeVerificationV1,
} from './outcome-verification-bridge.js';
import {
  OrchestrationActivationPhase,
  OrchestrationActivationPurpose,
  OrchestrationHierarchyActionType,
  OrchestrationHierarchyEventType,
  OrchestrationTerminalStatus,
  compactOrchestrationEventId,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from './orchestration-hierarchy.js';
import { normalizeSubagentResultEnvelopeV1 } from './subagent-result-envelope.js';
import { normalizeSubagentTaskEnvelopeV1 } from './subagent-task-envelope.js';

export const SUBAGENT_RESULT_RECONCILIATION_VERSION = 1;
export const SUBAGENT_TASK_ACTIVATION_BINDING_VERSION = 1;

export const SubagentResultReconciliationDecision = Object.freeze({
  ADMIT_TERMINAL: 'ADMIT_TERMINAL',
  REOPEN: 'REOPEN',
  WAIT: 'WAIT',
  DENY: 'DENY',
  ALREADY_TERMINAL: 'ALREADY_TERMINAL',
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_ROWS = 128;
const REQUEST_KEYS = new Set([
  'resultEnvelope',
  'outcomeContract',
  'criterionVerifications',
  'evaluatedAt',
  'graph',
  'runtime',
  'taskActivationBindingId',
]);
const BINDING_BUILD_KEYS = new Set([
  'taskEnvelope',
  'graph',
  'runtime',
  'activationAction',
  'invocationId',
  'boundAt',
]);
const ACTIVATION_ACTION_KEYS = new Set([
  'type',
  'nodeId',
  'activationId',
  'generation',
  'round',
  'purpose',
  'chatMode',
  'promptProfileId',
  'promptPayload',
  'providerDispatchIdentity',
  'authority',
]);

const BINDING_KEYS = new Set([
  'schemaVersion',
  'bindingId',
  'projectId',
  'parentAgentId',
  'childAgentId',
  'taskId',
  'taskEnvelopeId',
  'planId',
  'planRevision',
  'outcomeContractId',
  'outcomeContractRevision',
  'invocationId',
  'controlEpoch',
  'activationId',
  'generation',
  'activationPurpose',
  'boundAt',
]);
const ALLOWED_TERMINAL_PURPOSES = new Set([
  OrchestrationActivationPurpose.WORK,
  OrchestrationActivationPurpose.RECONCILE,
  OrchestrationActivationPurpose.RECOVERY,
]);

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new Error(label + ' contains symbol field');
    }
    if (!allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + key);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function own(value, key, label) {
  if (!Object.hasOwn(value, key)) throw new Error(label + ' requires ' + key);
  return value[key];
}

function exactId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactInteger(value, label, min = 1) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(label + ' must be a timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function dataArray(value, label, max = MAX_ROWS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(label + ' is invalid');
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(label + ' must be a dense data-only array');
    }
    out.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string'
        || !/^(?:0|[1-9]\d*)$/u.test(key)
        || Number(key) >= length) {
      throw new Error(label + ' contains a non-index field');
    }
  }
  return out;
}

function dataField(record, key, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(label + '.' + key + ' must be an own data property');
  }
  return descriptor.value;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function baseProjection({
  decision,
  reasonCode,
  result = null,
  binding = null,
  trustedVerification = null,
  terminalEvent = null,
}) {
  return freezeDeep({
    schemaVersion: SUBAGENT_RESULT_RECONCILIATION_VERSION,
    decision,
    reasonCode,
    resultId: result?.resultId || '',
    bindingId: binding?.bindingId || '',
    projectId: result?.projectId || binding?.projectId || '',
    parentAgentId: result?.parentAgentId || binding?.parentAgentId || '',
    childAgentId: result?.childAgentId || binding?.childAgentId || '',
    taskId: result?.taskId || binding?.taskId || '',
    activationId: binding?.activationId || '',
    generation: binding?.generation || 0,
    trustedVerification,
    terminalEvent,
    terminalCommitAuthority: false,
    completionAuthority: false,
    executionAuthority: false,
    schedulingAuthority: false,
    policyAuthority: false,
    credentialAuthority: false,
    persistenceAuthority: false,
    requiresCanonicalOrchestrationReducer: terminalEvent !== null,
  });
}

function normalizeTerminalizableActivationAction(input) {
  const raw = strictRecord(
    input,
    ACTIVATION_ACTION_KEYS,
    'SubagentTerminalizableActivationActionV1',
  );
  const purpose = exactId(
    own(raw, 'purpose', 'SubagentTerminalizableActivationActionV1'),
    'activationAction.purpose',
  );
  if (!ALLOWED_TERMINAL_PURPOSES.has(purpose)) {
    throw new Error('Subagent activation action purpose cannot terminalize a result');
  }

  const type = exactId(
    own(raw, 'type', 'SubagentTerminalizableActivationActionV1'),
    'activationAction.type',
  );
  const expectedType = purpose === OrchestrationActivationPurpose.RECONCILE
    ? OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT
    : OrchestrationHierarchyActionType.ACTIVATE_NODE;
  if (type !== expectedType) {
    throw new Error('Subagent activation action type/purpose is mismatched');
  }
  if (own(raw, 'authority', 'SubagentTerminalizableActivationActionV1')
      !== 'EXISTING_CORE_SESSION_TASK_PATH') {
    throw new Error('Subagent activation action is not from the canonical Core session/task path');
  }

  return {
    type,
    nodeId: exactId(
      own(raw, 'nodeId', 'SubagentTerminalizableActivationActionV1'),
      'activationAction.nodeId',
    ),
    activationId: exactId(
      own(raw, 'activationId', 'SubagentTerminalizableActivationActionV1'),
      'activationAction.activationId',
    ),
    generation: exactInteger(
      own(raw, 'generation', 'SubagentTerminalizableActivationActionV1'),
      'activationAction.generation',
    ),
    round: exactInteger(
      own(raw, 'round', 'SubagentTerminalizableActivationActionV1'),
      'activationAction.round',
    ),
    purpose,
  };
}

/**
 * Derive the exact value that an existing durable Orchestration owner may
 * persist as task↔activation↔invocation evidence.
 *
 * This function does not persist the record and does not make it trusted.
 * prepareSubagentResultReconciliationV1 accepts the record only when it is
 * re-observed through the injected canonical owner resolver.
 */
export function deriveSubagentTaskActivationBindingV1(input = {}) {
  const request = strictRecord(
    input,
    BINDING_BUILD_KEYS,
    'SubagentTaskActivationBindingBuildV1',
  );
  const task = normalizeSubagentTaskEnvelopeV1(
    own(request, 'taskEnvelope', 'SubagentTaskActivationBindingBuildV1'),
  );
  const graph = validateOrchestrationGraphV1(
    own(request, 'graph', 'SubagentTaskActivationBindingBuildV1'),
  );
  const runtime = validateOrchestrationHierarchyRuntimeV1(
    graph,
    own(request, 'runtime', 'SubagentTaskActivationBindingBuildV1'),
  );
  const action = normalizeTerminalizableActivationAction(
    own(request, 'activationAction', 'SubagentTaskActivationBindingBuildV1'),
  );

  const child = graph.nodesById[task.childAgentId];
  if (!child || child.parentId !== task.parentAgentId) {
    throw new Error('Subagent task identity is not the exact canonical graph parent/child link');
  }
  if (action.nodeId !== task.childAgentId) {
    throw new Error('Subagent activation action nodeId does not match task childAgentId');
  }

  const nodeRuntime = runtime.nodesById[task.childAgentId];
  if (!nodeRuntime || nodeRuntime.currentActivationId !== action.activationId) {
    throw new Error('Subagent activation action is not the current canonical activation');
  }
  if (nodeRuntime.generation !== action.generation) {
    throw new Error('Subagent activation action generation is not current');
  }
  const ledger = dataField(
    nodeRuntime.activationLedger,
    action.activationId,
    'child activationLedger',
  );
  const ledgerFields = {
    generation: dataField(ledger, 'generation', 'current child activation'),
    round: dataField(ledger, 'round', 'current child activation'),
    purpose: dataField(ledger, 'purpose', 'current child activation'),
    phase: dataField(ledger, 'phase', 'current child activation'),
    preparedAt: dataField(ledger, 'preparedAt', 'current child activation'),
  };
  if (ledgerFields.generation !== action.generation
      || ledgerFields.round !== action.round
      || ledgerFields.purpose !== action.purpose) {
    throw new Error('Subagent activation action does not match the canonical runtime ledger');
  }
  if (![OrchestrationActivationPhase.PREPARED, OrchestrationActivationPhase.EFFECT_CONFIRMED]
    .includes(ledgerFields.phase)) {
    throw new Error('Subagent activation binding cannot be derived from a terminal, ambiguous, or superseded activation');
  }

  const boundAt = canonicalTimestamp(
    own(request, 'boundAt', 'SubagentTaskActivationBindingBuildV1'),
    'boundAt',
  );
  if (!Number.isFinite(ledgerFields.preparedAt)
      || Date.parse(boundAt) < ledgerFields.preparedAt) {
    throw new Error('Subagent activation binding predates canonical activation preparation');
  }
  if (Date.parse(boundAt) < Date.parse(task.createdAt)) {
    throw new Error('Subagent activation binding predates the task envelope');
  }

  const invocationId = exactId(
    own(request, 'invocationId', 'SubagentTaskActivationBindingBuildV1'),
    'invocationId',
  );
  const bindingId = compactOrchestrationEventId(
    'subagent-task-activation-binding',
    task.projectId,
    task.envelopeId,
    String(runtime.controlEpoch),
    action.activationId,
    String(action.generation),
    invocationId,
  );

  return freezeDeep({
    schemaVersion: SUBAGENT_TASK_ACTIVATION_BINDING_VERSION,
    bindingId,
    projectId: task.projectId,
    parentAgentId: task.parentAgentId,
    childAgentId: task.childAgentId,
    taskId: task.taskId,
    taskEnvelopeId: task.envelopeId,
    planId: task.planId,
    planRevision: task.planRevision,
    outcomeContractId: task.outcome.contractId,
    outcomeContractRevision: task.outcome.contractRevision,
    invocationId,
    controlEpoch: runtime.controlEpoch,
    activationId: action.activationId,
    generation: action.generation,
    activationPurpose: action.purpose,
    boundAt,
  });
}

export function normalizeTrustedSubagentTaskActivationBindingV1(input) {
  const raw = strictRecord(
    input,
    BINDING_KEYS,
    'TrustedSubagentTaskActivationBindingV1',
  );
  if (own(raw, 'schemaVersion', 'TrustedSubagentTaskActivationBindingV1')
      !== SUBAGENT_TASK_ACTIVATION_BINDING_VERSION) {
    throw new Error('Unsupported TrustedSubagentTaskActivationBindingV1 schemaVersion');
  }

  const purpose = exactId(
    own(raw, 'activationPurpose', 'TrustedSubagentTaskActivationBindingV1'),
    'activationPurpose',
  );
  if (!ALLOWED_TERMINAL_PURPOSES.has(purpose)) {
    throw new Error('Trusted subagent task activation purpose cannot terminalize a result');
  }

  const normalized = {
    schemaVersion: SUBAGENT_TASK_ACTIVATION_BINDING_VERSION,
    bindingId: exactId(own(raw, 'bindingId', 'TrustedSubagentTaskActivationBindingV1'), 'bindingId'),
    projectId: exactId(own(raw, 'projectId', 'TrustedSubagentTaskActivationBindingV1'), 'projectId'),
    parentAgentId: exactId(own(raw, 'parentAgentId', 'TrustedSubagentTaskActivationBindingV1'), 'parentAgentId'),
    childAgentId: exactId(own(raw, 'childAgentId', 'TrustedSubagentTaskActivationBindingV1'), 'childAgentId'),
    taskId: exactId(own(raw, 'taskId', 'TrustedSubagentTaskActivationBindingV1'), 'taskId'),
    taskEnvelopeId: exactId(
      own(raw, 'taskEnvelopeId', 'TrustedSubagentTaskActivationBindingV1'),
      'taskEnvelopeId',
    ),
    planId: exactId(own(raw, 'planId', 'TrustedSubagentTaskActivationBindingV1'), 'planId'),
    planRevision: exactInteger(
      own(raw, 'planRevision', 'TrustedSubagentTaskActivationBindingV1'),
      'planRevision',
    ),
    outcomeContractId: exactId(
      own(raw, 'outcomeContractId', 'TrustedSubagentTaskActivationBindingV1'),
      'outcomeContractId',
    ),
    outcomeContractRevision: exactInteger(
      own(raw, 'outcomeContractRevision', 'TrustedSubagentTaskActivationBindingV1'),
      'outcomeContractRevision',
    ),
    invocationId: exactId(
      own(raw, 'invocationId', 'TrustedSubagentTaskActivationBindingV1'),
      'invocationId',
    ),
    controlEpoch: exactInteger(
      own(raw, 'controlEpoch', 'TrustedSubagentTaskActivationBindingV1'),
      'controlEpoch',
    ),
    activationId: exactId(
      own(raw, 'activationId', 'TrustedSubagentTaskActivationBindingV1'),
      'activationId',
    ),
    generation: exactInteger(
      own(raw, 'generation', 'TrustedSubagentTaskActivationBindingV1'),
      'generation',
    ),
    activationPurpose: purpose,
    boundAt: canonicalTimestamp(
      own(raw, 'boundAt', 'TrustedSubagentTaskActivationBindingV1'),
      'boundAt',
    ),
  };
  const expectedBindingId = compactOrchestrationEventId(
    'subagent-task-activation-binding',
    normalized.projectId,
    normalized.taskEnvelopeId,
    String(normalized.controlEpoch),
    normalized.activationId,
    String(normalized.generation),
    normalized.invocationId,
  );
  if (normalized.bindingId !== expectedBindingId) {
    throw new Error('Trusted subagent task activation bindingId is not canonical');
  }
  return freezeDeep(normalized);
}

function assertResultMatchesBinding(result, binding) {
  const fields = [
    ['projectId', 'projectId'],
    ['parentAgentId', 'parentAgentId'],
    ['childAgentId', 'childAgentId'],
    ['taskId', 'taskId'],
    ['envelopeId', 'taskEnvelopeId'],
    ['planId', 'planId'],
    ['planRevision', 'planRevision'],
    ['outcomeContractId', 'outcomeContractId'],
    ['outcomeContractRevision', 'outcomeContractRevision'],
    ['invocationId', 'invocationId'],
  ];
  for (const [resultField, bindingField] of fields) {
    if (result[resultField] !== binding[bindingField]) {
      throw new Error(
        'Trusted task activation binding mismatch: '
          + resultField
          + ' != '
          + bindingField,
      );
    }
  }
}

function assertResultArtifactInvocationProvenance(result) {
  for (const ref of result.resultArtifactRefs) {
    if (ref.producerInvocationId !== result.invocationId) {
      throw new Error(
        'Subagent result artifact producerInvocationId is not bound to the exact result invocation: '
          + ref.artifactId,
      );
    }
  }
}

function assertContractIdentity(result, contract) {
  if (contract.contractId !== result.outcomeContractId
      || contract.revision !== result.outcomeContractRevision) {
    throw new Error('Subagent result is not bound to the exact Outcome Contract revision');
  }
  if (contract.projectId !== result.projectId) {
    throw new Error('Subagent result project does not match the Outcome Contract project');
  }
  if (contract.verifierPlan.actorId !== result.childAgentId) {
    throw new Error('Subagent result child is not the Outcome Contract actor');
  }
  if (contract.verifierPlan.verifierId !== result.verifierId) {
    throw new Error('Subagent result verifier does not match the Outcome Contract verifier');
  }
  if (contract.verifierPlan.requiredEvidenceArtifactCount
      !== result.requiredEvidenceArtifactCount) {
    throw new Error('Subagent result evidence requirement drifted from the Outcome Contract');
  }
}

function assertTrustedResultVerificationParticipation(result, adjudication) {
  const rows = adjudication.criteria.filter(
    row => row.verificationId === result.verificationId,
  );
  if (!rows.length) {
    throw new Error(
      'Subagent result verificationId does not participate in trusted outcome adjudication',
    );
  }

  for (const row of rows) {
    if (row.invocationId !== result.invocationId
        || row.observationId !== result.observationId
        || row.verifierId !== result.verifierId) {
      throw new Error(
        'Subagent result verification identity does not match its trusted canonical verification record',
      );
    }
  }
}

function currentActivationProjection(graph, runtime, result) {
  const child = graph.nodesById[result.childAgentId];
  if (!child) {
    return { ok: false, reasonCode: 'RESULT_CHILD_NOT_IN_CANONICAL_GRAPH' };
  }
  if (child.parentId !== result.parentAgentId) {
    return { ok: false, reasonCode: 'RESULT_PARENT_CHILD_GRAPH_MISMATCH' };
  }

  const nodeRuntime = runtime.nodesById[result.childAgentId];
  if (!nodeRuntime) {
    return { ok: false, reasonCode: 'RESULT_CHILD_RUNTIME_MISSING' };
  }
  if (nodeRuntime.scopeState !== 'RUNNING') {
    return {
      ok: false,
      wait: true,
      reasonCode: 'RESULT_CHILD_SCOPE_' + String(nodeRuntime.scopeState || 'BLOCKED'),
    };
  }
  const activationId = nodeRuntime.currentActivationId;
  if (!activationId) {
    return { ok: false, reasonCode: 'RESULT_CHILD_HAS_NO_CURRENT_ACTIVATION' };
  }

  const ledger = dataField(
    nodeRuntime.activationLedger,
    activationId,
    'child activationLedger',
  );
  const phase = dataField(ledger, 'phase', 'current child activation');
  const purpose = dataField(ledger, 'purpose', 'current child activation');
  const generation = dataField(ledger, 'generation', 'current child activation');
  const preparedAt = dataField(ledger, 'preparedAt', 'current child activation');

  if (phase === OrchestrationActivationPhase.TERMINAL) {
    return {
      ok: false,
      alreadyTerminal: true,
      reasonCode: 'RESULT_CHILD_ACTIVATION_ALREADY_TERMINAL',
      activationId,
      purpose,
      generation,
      preparedAt,
    };
  }
  if (phase === OrchestrationActivationPhase.SUPERSEDED) {
    return { ok: false, reasonCode: 'RESULT_CHILD_ACTIVATION_SUPERSEDED' };
  }
  if (phase === OrchestrationActivationPhase.AMBIGUOUS) {
    return {
      ok: false,
      wait: true,
      reasonCode: 'RESULT_CHILD_EFFECT_AMBIGUOUS',
    };
  }
  if (phase !== OrchestrationActivationPhase.EFFECT_CONFIRMED) {
    return {
      ok: false,
      wait: true,
      reasonCode: 'RESULT_CHILD_EFFECT_NOT_CONFIRMED',
    };
  }
  if (!ALLOWED_TERMINAL_PURPOSES.has(purpose)) {
    return { ok: false, reasonCode: 'RESULT_CHILD_ACTIVATION_PURPOSE_NOT_TERMINABLE' };
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Canonical child activation generation is invalid');
  }
  if (!Number.isFinite(preparedAt) || preparedAt < 0) {
    throw new Error('Canonical child activation preparedAt is invalid');
  }

  return {
    ok: true,
    activationId,
    purpose,
    generation,
    preparedAt,
    nodeGeneration: nodeRuntime.generation,
  };
}

function assertBindingMatchesCurrentRuntime(binding, activation, runtime) {
  if (binding.controlEpoch !== runtime.controlEpoch) {
    throw new Error('Trusted task activation binding controlEpoch is stale');
  }
  if (binding.activationId !== activation.activationId) {
    throw new Error('Trusted task activation binding activationId is not current');
  }
  if (binding.generation !== activation.generation
      || binding.generation !== activation.nodeGeneration) {
    throw new Error('Trusted task activation binding generation is stale');
  }
  if (binding.activationPurpose !== activation.purpose) {
    throw new Error('Trusted task activation binding purpose is mismatched');
  }
  const boundAtMs = Date.parse(binding.boundAt);
  if (boundAtMs < activation.preparedAt) {
    throw new Error('Trusted task activation binding predates the current activation');
  }
}

function assertResultChronologyAgainstBinding(result, binding) {
  const boundAtMs = Date.parse(binding.boundAt);
  if (Date.parse(result.observedAt) < boundAtMs) {
    throw new Error('Subagent result observation predates its trusted task activation binding');
  }
  if (Date.parse(result.completedAt) < boundAtMs) {
    throw new Error('Subagent result completion predates its trusted task activation binding');
  }
}

/**
 * Admit one immutable child result into the existing OrchestrationHierarchy
 * terminal-event path without creating completion or reducer authority.
 *
 * The raw result is never sufficient. Admission requires:
 *   1. exact canonical graph/runtime current activation,
 *   2. a trusted owner-resolved task/activation/invocation binding, and
 *   3. the existing canonical Outcome Verification Bridge over trusted records.
 *
 * The returned NODE_TERMINAL event is inert data. Only the canonical
 * reduceOrchestrationHierarchyEvent durable owner may commit it and trigger
 * terminal-event-driven parent reconciliation.
 */
export async function prepareSubagentResultReconciliationV1(
  input = {},
  {
    resolveTrustedOutcomeContract,
    resolveTrustedVerificationRecord,
    resolveTrustedTaskActivationBinding,
  } = {},
) {
  if (typeof resolveTrustedTaskActivationBinding !== 'function') {
    throw new Error('Canonical trusted task activation binding resolver is required');
  }
  if (typeof resolveTrustedOutcomeContract !== 'function') {
    throw new Error('Canonical trusted outcome contract resolver is required');
  }
  if (typeof resolveTrustedVerificationRecord !== 'function') {
    throw new Error('Canonical trusted verification record resolver is required');
  }

  const request = strictRecord(
    input,
    REQUEST_KEYS,
    'SubagentResultReconciliationRequestV1',
  );
  const result = normalizeSubagentResultEnvelopeV1(
    own(request, 'resultEnvelope', 'SubagentResultReconciliationRequestV1'),
  );
  assertResultArtifactInvocationProvenance(result);

  const contract = normalizeOutcomeContractV1(
    own(request, 'outcomeContract', 'SubagentResultReconciliationRequestV1'),
  );
  assertContractIdentity(result, contract);

  const graph = validateOrchestrationGraphV1(
    own(request, 'graph', 'SubagentResultReconciliationRequestV1'),
  );
  const runtime = validateOrchestrationHierarchyRuntimeV1(
    graph,
    own(request, 'runtime', 'SubagentResultReconciliationRequestV1'),
  );
  const activation = currentActivationProjection(graph, runtime, result);
  if (!activation.ok) {
    if (activation.alreadyTerminal) {
      return baseProjection({
        decision: SubagentResultReconciliationDecision.ALREADY_TERMINAL,
        reasonCode: activation.reasonCode,
        result,
      });
    }
    return baseProjection({
      decision: activation.wait
        ? SubagentResultReconciliationDecision.WAIT
        : SubagentResultReconciliationDecision.DENY,
      reasonCode: activation.reasonCode,
      result,
    });
  }

  const bindingId = exactId(
    own(request, 'taskActivationBindingId', 'SubagentResultReconciliationRequestV1'),
    'taskActivationBindingId',
  );
  const rawBinding = await resolveTrustedTaskActivationBinding(
    freezeDeep({ bindingId }),
  );
  if (rawBinding == null) {
    throw new Error('Trusted subagent task activation binding was not found: ' + bindingId);
  }
  const binding = normalizeTrustedSubagentTaskActivationBindingV1(rawBinding);
  if (binding.bindingId !== bindingId) {
    throw new Error('Trusted task activation binding lookup returned a different bindingId');
  }

  assertResultMatchesBinding(result, binding);
  assertBindingMatchesCurrentRuntime(binding, activation, runtime);
  assertResultChronologyAgainstBinding(result, binding);

  const evaluatedAt = canonicalTimestamp(
    own(request, 'evaluatedAt', 'SubagentResultReconciliationRequestV1'),
    'evaluatedAt',
  );
  if (Date.parse(evaluatedAt) < Date.parse(result.completedAt)) {
    throw new Error('Trusted outcome evaluation predates the child result completion');
  }

  // Validate descriptor-safe cardinality before handing rows to the canonical
  // bridge. The bridge performs the authoritative row schema/identity checks.
  const criterionVerifications = dataArray(
    own(request, 'criterionVerifications', 'SubagentResultReconciliationRequestV1'),
    'criterionVerifications',
  );

  const adjudication = await adjudicateOutcomeVerificationV1(
    {
      contract,
      criterionVerifications,
      evaluatedAt,
    },
    {
      resolveTrustedOutcomeContract,
      resolveTrustedVerificationRecord,
    },
  );

  if (adjudication.contractId !== result.outcomeContractId
      || adjudication.contractRevision !== result.outcomeContractRevision
      || adjudication.actorId !== result.childAgentId
      || adjudication.verifierId !== result.verifierId) {
    throw new Error('Trusted outcome adjudication identity does not match the subagent result');
  }
  assertTrustedResultVerificationParticipation(result, adjudication);

  const trustedComplete = adjudication.verdict === OutcomeVerificationVerdict.VERIFIED
    && adjudication.completionEvidenceReady === true;
  const terminalStatus = trustedComplete
    ? OrchestrationTerminalStatus.COMPLETED
    : OrchestrationTerminalStatus.FAILED;

  // A trusted REOPEN is a terminal result for this *attempt*, not a successful
  // outcome. Marking the activation FAILED lets the existing parent barrier
  // reconcile/replan it instead of leaving the child permanently in-flight.
  // The adapter still does not decide or schedule the retry itself.
  const terminalEvent = freezeDeep({
    type: OrchestrationHierarchyEventType.NODE_TERMINAL,
    eventId: compactOrchestrationEventId(
      'subagent-result-terminal',
      result.resultId,
      binding.bindingId,
      binding.activationId,
      result.verificationId,
      terminalStatus,
    ),
    controlEpoch: runtime.controlEpoch,
    nodeId: result.childAgentId,
    generation: binding.generation,
    activationId: binding.activationId,
    status: terminalStatus,
  });

  return baseProjection({
    decision: trustedComplete
      ? SubagentResultReconciliationDecision.ADMIT_TERMINAL
      : SubagentResultReconciliationDecision.REOPEN,
    reasonCode: trustedComplete
      ? 'TRUSTED_SUBAGENT_RESULT_TERMINAL_ADMITTED'
      : 'TRUSTED_OUTCOME_REOPEN_TERMINAL_ADMITTED',
    result,
    binding,
    trustedVerification: adjudication,
    terminalEvent,
  });
}
