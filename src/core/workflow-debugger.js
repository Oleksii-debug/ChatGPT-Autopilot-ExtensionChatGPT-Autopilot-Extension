import { normalizeAgentPlanV1 } from './agent-plan.js';
import { normalizeAgentCheckpointV1 } from './agent-checkpoint.js';
import {
  ExactEffectPhase,
  normalizeExactEffectStateV1,
} from './universal-agent-exact-effect.js';

export const WORKFLOW_DEBUGGER_VERSION = 1;
export const MAX_WORKFLOW_DEBUGGER_BREAKPOINTS = 128;
export const MAX_WORKFLOW_DEBUGGER_EFFECTS = 128;

export const WorkflowDebuggerBreakpointKind = Object.freeze({
  PLAN_NODE: 'PLAN_NODE',
  PROVIDER: 'PROVIDER',
  TOOL: 'TOOL',
  CAPABILITY: 'CAPABILITY',
  EFFECT_PHASE: 'EFFECT_PHASE',
});

const BREAKPOINT_KINDS = new Set(Object.values(WorkflowDebuggerBreakpointKind));
const EFFECT_PHASES = new Set(Object.values(ExactEffectPhase));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REQUEST_KEYS = new Set([
  'schemaVersion',
  'debugSessionId',
  'projectId',
  'agentId',
  'generatedAt',
  'plan',
  'checkpoint',
  'effects',
  'effectBindings',
  'breakpoints',
  'selectedNodeId',
  'selectedEffectId',
  'variantRequest',
]);
const BINDING_KEYS = new Set(['effectId', 'nodeId']);
const BREAKPOINT_KEYS = new Set(['breakpointId', 'kind', 'value', 'enabled']);
const VARIANT_KEYS = new Set([
  'variantId',
  'checkpointId',
  'alternateRouterId',
  'targetNodeId',
  'requestedAt',
]);

function snapshotRecord(value, label, allowed, { requireAll = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    Object.defineProperty(out, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  if (requireAll) {
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) {
        throw new Error(label + ' is missing field: ' + key);
      }
    }
  }
  return Object.freeze(out);
}

function denseArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a bounded canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' must be a bounded canonical array');
  }
  const length = lengthDescriptor.value;
  const out = new Array(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index data');
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' entries must be enumerable own data properties');
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' must be dense');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label, { optional = false } = {}) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(label + ' must be a timestamp');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(label + ' must be a timestamp');
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical) throw new Error(label + ' must use canonical ISO-8601 UTC representation');
  return value;
}

function exactBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeEffectBinding(input, index) {
  const raw = snapshotRecord(input, 'effectBindings[' + index + ']', BINDING_KEYS);
  return deepFreeze({
    effectId: exactId(raw.effectId, 'effectBindings[' + index + '].effectId'),
    nodeId: exactId(raw.nodeId, 'effectBindings[' + index + '].nodeId'),
  });
}

function normalizeBreakpoint(input, index) {
  const raw = snapshotRecord(input, 'breakpoints[' + index + ']', BREAKPOINT_KEYS);
  if (typeof raw.kind !== 'string' || !BREAKPOINT_KINDS.has(raw.kind)) {
    throw new Error('breakpoints[' + index + '].kind is invalid');
  }
  return deepFreeze({
    breakpointId: exactId(raw.breakpointId, 'breakpoints[' + index + '].breakpointId'),
    kind: raw.kind,
    value: exactId(raw.value, 'breakpoints[' + index + '].value'),
    enabled: exactBoolean(raw.enabled, 'breakpoints[' + index + '].enabled'),
  });
}

function normalizeVariantRequest(input) {
  if (input == null) return null;
  const raw = snapshotRecord(input, 'variantRequest', VARIANT_KEYS);
  return deepFreeze({
    variantId: exactId(raw.variantId, 'variantRequest.variantId'),
    checkpointId: exactId(raw.checkpointId, 'variantRequest.checkpointId'),
    alternateRouterId: exactId(raw.alternateRouterId, 'variantRequest.alternateRouterId'),
    targetNodeId: exactId(raw.targetNodeId, 'variantRequest.targetNodeId'),
    requestedAt: exactTimestamp(raw.requestedAt, 'variantRequest.requestedAt'),
  });
}

function publicPlanProjection(plan) {
  return deepFreeze({
    planId: plan.planId,
    jobId: plan.jobId,
    revision: plan.revision,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    nodeCount: plan.nodes.length,
    nodes: plan.nodes.map(node => deepFreeze({
      nodeId: node.nodeId,
      state: node.state,
      ownerId: node.ownerId,
      executionPlane: node.executionPlane,
      dependsOn: [...node.dependsOn],
      conflictKeys: [...node.conflictKeys],
      acceptanceCriteriaCount: node.acceptanceCriteria.length,
      updatedAt: node.updatedAt,
    })),
  });
}

function publicCheckpointProjection(checkpoint) {
  return deepFreeze({
    checkpointId: checkpoint.checkpointId,
    agentId: checkpoint.agentId,
    jobId: checkpoint.jobId,
    planId: checkpoint.planId,
    planRevision: checkpoint.planRevision,
    internalStateRevision: checkpoint.internalStateRevision,
    exactEffectLedgerRevision: checkpoint.exactEffectLedgerRevision,
    policyRevisionId: checkpoint.policyRevisionId,
    snapshotArtifactId: checkpoint.snapshotArtifact.artifactId,
    snapshotSha256: checkpoint.snapshotArtifact.sha256,
    snapshotSensitive: checkpoint.snapshotArtifact.sensitive,
    checkpointDigest: checkpoint.checkpointDigest,
    createdAt: checkpoint.createdAt,
  });
}

function publicEffectProjection(effect, nodeId) {
  return deepFreeze({
    effectId: effect.effectId,
    nodeId,
    phase: effect.phase,
    attempt: effect.attempt,
    executionId: effect.executionId,
    toolId: effect.invocation.toolId,
    providerId: effect.invocation.providerId,
    requestedCapabilityIds: [...effect.invocation.requestedCapabilityIds].sort(codeUnitCompare),
    hasObservation: effect.observation !== null,
    hasVerification: effect.verification !== null,
    ambiguityReasonCode: effect.ambiguity.reasonCode,
    reconciliationOutcome: effect.reconciliation.outcome,
    createdAt: effect.createdAt,
    updatedAt: effect.updatedAt,
  });
}

function breakpointMatchesPlanNode(breakpoint, node) {
  return breakpoint.enabled
    && breakpoint.kind === WorkflowDebuggerBreakpointKind.PLAN_NODE
    && breakpoint.value === node.nodeId;
}

function breakpointMatchesEffect(breakpoint, effect) {
  if (!breakpoint.enabled) return false;
  if (breakpoint.kind === WorkflowDebuggerBreakpointKind.PROVIDER) {
    return breakpoint.value === effect.providerId;
  }
  if (breakpoint.kind === WorkflowDebuggerBreakpointKind.TOOL) {
    return breakpoint.value === effect.toolId;
  }
  if (breakpoint.kind === WorkflowDebuggerBreakpointKind.CAPABILITY) {
    return effect.requestedCapabilityIds.includes(breakpoint.value);
  }
  if (breakpoint.kind === WorkflowDebuggerBreakpointKind.EFFECT_PHASE) {
    return breakpoint.value === effect.phase;
  }
  return false;
}

function buildBreakpointHits(breakpoints, plan, effects) {
  const hits = [];
  for (const breakpoint of breakpoints) {
    for (const node of plan.nodes) {
      if (breakpointMatchesPlanNode(breakpoint, node)) {
        hits.push({
          breakpointId: breakpoint.breakpointId,
          kind: breakpoint.kind,
          subjectKind: 'PLAN_NODE',
          subjectId: node.nodeId,
          nodeId: node.nodeId,
          effectId: '',
          matchedValue: breakpoint.value,
          at: node.updatedAt,
        });
      }
    }
    for (const effect of effects) {
      if (breakpointMatchesEffect(breakpoint, effect)) {
        hits.push({
          breakpointId: breakpoint.breakpointId,
          kind: breakpoint.kind,
          subjectKind: 'EXACT_EFFECT',
          subjectId: effect.effectId,
          nodeId: effect.nodeId,
          effectId: effect.effectId,
          matchedValue: breakpoint.value,
          at: effect.updatedAt,
        });
      }
    }
  }
  hits.sort((left, right) =>
    codeUnitCompare(left.breakpointId, right.breakpointId)
    || codeUnitCompare(left.subjectKind, right.subjectKind)
    || codeUnitCompare(left.subjectId, right.subjectId));
  return hits.map(hit => deepFreeze(hit));
}

const POST_CHECKPOINT_EFFECT_PHASES = new Set([
  ExactEffectPhase.EXECUTING,
  ExactEffectPhase.OBSERVED,
  ExactEffectPhase.RECONCILE,
  ExactEffectPhase.VERIFIED,
  ExactEffectPhase.SAFE_RETRY,
  ExactEffectPhase.MANUAL_REVIEW,
  ExactEffectPhase.COMMITTED,
]);

function buildVariantProposal(variant, checkpoint, plan, effects, generatedAt) {
  if (!variant) return null;
  if (variant.checkpointId !== checkpoint.checkpointId) {
    throw new Error('variantRequest checkpointId does not match debugger checkpoint');
  }
  if (Date.parse(variant.requestedAt) > Date.parse(generatedAt)) {
    throw new Error('variantRequest requestedAt cannot be after debugger generation');
  }
  if (Date.parse(variant.requestedAt) < Date.parse(checkpoint.createdAt)) {
    throw new Error('variantRequest requestedAt cannot predate checkpoint');
  }
  const target = plan.nodes.find(node => node.nodeId === variant.targetNodeId);
  if (!target) throw new Error('variantRequest targetNodeId does not exist in AgentPlan');

  const postCheckpointEffectIds = effects
    .filter(effect => POST_CHECKPOINT_EFFECT_PHASES.has(effect.phase)
      && Date.parse(effect.updatedAt) >= Date.parse(checkpoint.createdAt))
    .map(effect => effect.effectId)
    .sort(codeUnitCompare);
  const proposalEligible = postCheckpointEffectIds.length === 0;
  return deepFreeze({
    variantId: variant.variantId,
    checkpointId: checkpoint.checkpointId,
    alternateRouterId: variant.alternateRouterId,
    targetNodeId: variant.targetNodeId,
    requestedAt: variant.requestedAt,
    proposalEligible,
    reasonCode: proposalEligible
      ? 'INTERNAL_VARIANT_REQUIRES_FRESH_GATES'
      : 'EXTERNAL_EFFECT_STATE_AFTER_CHECKPOINT',
    blockingEffectIds: postCheckpointEffectIds,
    internalPlanningReplayRequested: true,
    internalPlanningReplayAuthorized: false,
    externalEffectReplayAuthorized: false,
    checkpointRestoreAuthorized: false,
    requiresCanonicalCheckpointVerification: true,
    requiresCanonicalCheckpointRewindAssessment: true,
    requiresFreshPolicyEvaluation: true,
    requiresFreshWorldState: true,
    requiresFreshReconciliation: true,
  });
}

export function buildWorkflowDebuggerV1(input) {
  const raw = snapshotRecord(input, 'WorkflowDebuggerV1', REQUEST_KEYS);
  if (raw.schemaVersion !== WORKFLOW_DEBUGGER_VERSION) {
    throw new Error('Unsupported WorkflowDebuggerV1 schemaVersion');
  }

  const debugSessionId = exactId(raw.debugSessionId, 'debugSessionId');
  const projectId = exactId(raw.projectId, 'projectId');
  const agentId = exactId(raw.agentId, 'agentId');
  const generatedAt = exactTimestamp(raw.generatedAt, 'generatedAt');
  const plan = normalizeAgentPlanV1(raw.plan);
  const checkpoint = normalizeAgentCheckpointV1(raw.checkpoint);
  if (checkpoint.agentId !== agentId) throw new Error('checkpoint agentId mismatch');
  if (checkpoint.jobId !== plan.jobId) throw new Error('checkpoint jobId mismatch');
  if (checkpoint.planId !== plan.planId) throw new Error('checkpoint planId mismatch');
  if (checkpoint.planRevision > plan.revision) throw new Error('checkpoint planRevision exceeds current AgentPlan revision');
  if (Date.parse(plan.updatedAt) > Date.parse(generatedAt)) throw new Error('AgentPlan is from the future of debugger generation');
  if (Date.parse(checkpoint.createdAt) > Date.parse(generatedAt)) throw new Error('checkpoint is from the future of debugger generation');

  const effects = denseArray(raw.effects, 'effects', MAX_WORKFLOW_DEBUGGER_EFFECTS)
    .map((item) => normalizeExactEffectStateV1(item));
  const effectIds = effects.map(effect => effect.effectId);
  if (new Set(effectIds).size !== effectIds.length) throw new Error('effects contains duplicate effectId');

  const bindings = denseArray(raw.effectBindings, 'effectBindings', MAX_WORKFLOW_DEBUGGER_EFFECTS)
    .map(normalizeEffectBinding);
  const bindingIds = bindings.map(binding => binding.effectId);
  if (new Set(bindingIds).size !== bindingIds.length) throw new Error('effectBindings contains duplicate effectId');
  if (bindings.length !== effects.length) throw new Error('effectBindings must exactly bind every effect');
  const effectIdSet = new Set(effectIds);
  const nodeIdSet = new Set(plan.nodes.map(node => node.nodeId));
  for (const binding of bindings) {
    if (!effectIdSet.has(binding.effectId)) throw new Error('effectBindings references unknown effectId');
    if (!nodeIdSet.has(binding.nodeId)) throw new Error('effectBindings references unknown nodeId');
  }
  for (const effectId of effectIds) {
    if (!bindingIds.includes(effectId)) throw new Error('effectBindings must exactly bind every effect');
  }

  const breakpoints = denseArray(
    raw.breakpoints,
    'breakpoints',
    MAX_WORKFLOW_DEBUGGER_BREAKPOINTS,
  ).map(normalizeBreakpoint);
  const breakpointIds = breakpoints.map(item => item.breakpointId);
  if (new Set(breakpointIds).size !== breakpointIds.length) {
    throw new Error('breakpoints contains duplicate breakpointId');
  }
  for (const breakpoint of breakpoints) {
    if (breakpoint.kind === WorkflowDebuggerBreakpointKind.EFFECT_PHASE
        && !EFFECT_PHASES.has(breakpoint.value)) {
      throw new Error('EFFECT_PHASE breakpoint value is invalid');
    }
  }

  const selectedNodeId = exactId(raw.selectedNodeId, 'selectedNodeId', { optional: true });
  const selectedEffectId = exactId(raw.selectedEffectId, 'selectedEffectId', { optional: true });
  if (selectedNodeId && !nodeIdSet.has(selectedNodeId)) throw new Error('selectedNodeId does not exist');
  if (selectedEffectId && !effectIdSet.has(selectedEffectId)) throw new Error('selectedEffectId does not exist');

  const bindingByEffectId = new Map(bindings.map(binding => [binding.effectId, binding.nodeId]));
  const publicEffects = effects
    .map(effect => publicEffectProjection(effect, bindingByEffectId.get(effect.effectId)))
    .sort((left, right) => codeUnitCompare(left.effectId, right.effectId));
  for (const effect of publicEffects) {
    if (Date.parse(effect.updatedAt) > Date.parse(generatedAt)) {
      throw new Error('exact effect is from the future of debugger generation');
    }
  }

  const publicPlan = publicPlanProjection(plan);
  const publicCheckpoint = publicCheckpointProjection(checkpoint);
  const variantRequest = normalizeVariantRequest(raw.variantRequest);
  const breakpointHits = buildBreakpointHits(breakpoints, publicPlan, publicEffects);
  const variantProposal = buildVariantProposal(
    variantRequest,
    publicCheckpoint,
    publicPlan,
    publicEffects,
    generatedAt,
  );

  return deepFreeze({
    schemaVersion: WORKFLOW_DEBUGGER_VERSION,
    debugSessionId,
    projectId,
    agentId,
    generatedAt,
    plan: publicPlan,
    checkpoint: publicCheckpoint,
    effects: publicEffects,
    breakpoints: breakpoints
      .map(item => ({ ...item }))
      .sort((left, right) => codeUnitCompare(left.breakpointId, right.breakpointId)),
    breakpointHits,
    selection: {
      nodeId: selectedNodeId,
      effectId: selectedEffectId,
    },
    variantProposal,
    sourceTrust: 'CALLER_BOUND_NOT_AUTHENTICATED',
    readOnly: true,
    advisoryOnly: true,
    executionAuthorized: false,
    mutationAuthorized: false,
    checkpointRestoreAuthorized: false,
    externalEffectReplayAuthorized: false,
    hiddenReasoningExposed: false,
    requiresCanonicalCheckpointVerification: true,
    requiresFreshWorldState: true,
    requiresFreshPolicyEvaluation: true,
  });
}
