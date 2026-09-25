import { normalizeOutcomeContractV1 } from './outcome-contract.js';
import { normalizeAgentPlanV1 } from './agent-plan.js';

export const OUTCOME_PLAN_BINDING_SCHEMA_VERSION = 1;

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function criterionPlanningText(criterion) {
  return `${criterion.criterionId}: ${criterion.observable}`;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function planningEnvelopeFromNormalized(contract) {
  const criterionBindings = contract.completionCriteria.map(criterion => freezeDeep({
    criterionId: criterion.criterionId,
    planningCriterion: criterionPlanningText(criterion),
    requiredEvidenceKinds: criterion.requiredEvidenceKinds,
  }));

  return freezeDeep({
    schemaVersion: OUTCOME_PLAN_BINDING_SCHEMA_VERSION,
    contractId: contract.contractId,
    contractRevision: contract.revision,
    projectId: contract.projectId,
    objective: contract.desiredResult,
    successCriteria: criterionBindings.map(item => item.planningCriterion),
    criterionBindings,
    constraints: contract.constraints,
    sourceTruth: contract.sourceTruth,
    authorityRequirements: contract.allowedAuthority,
    resourceEnvelope: {
      maxModelCalls: contract.budgetBoundaries.maxModelCalls,
      maxRuntimeSeconds: contract.budgetBoundaries.maxRuntimeSeconds,
      maxCostUsdMicros: contract.budgetBoundaries.maxCostUsdMicros,
    },
    maxConcurrency: contract.budgetBoundaries.maxConcurrency,
    deliverables: contract.deliverables,
    verifierPlan: contract.verifierPlan,
    triggerRefs: contract.triggerRefs,
    advisoryOnly: true,
    planningAuthorized: false,
    policyDecisionGranted: false,
    executionAuthorized: false,
    completionAuthorized: false,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalBudgetEnforcement: true,
    requiresCanonicalConcurrencyEnforcement: true,
    requiresCanonicalVerifier: true,
  });
}

export function projectOutcomePlanningEnvelopeV1(contractInput) {
  return planningEnvelopeFromNormalized(normalizeOutcomeContractV1(contractInput));
}

function aggregatePlanBudget(plan, envelope) {
  const totals = {
    maxModelCalls: 0n,
    maxRuntimeSeconds: 0n,
    maxCostUsdMicros: 0n,
  };
  for (const node of plan.nodes) {
    for (const key of Object.keys(totals)) {
      totals[key] += BigInt(node.budget[key]);
      if (totals[key] > BigInt(envelope[key])) {
        throw new Error(`AgentPlan exceeds Outcome Contract resource boundary: ${key}`);
      }
    }
  }
  return freezeDeep({
    maxModelCalls: Number(totals.maxModelCalls),
    maxRuntimeSeconds: Number(totals.maxRuntimeSeconds),
    maxCostUsdMicros: Number(totals.maxCostUsdMicros),
  });
}

/**
 * Proves only structural planning compatibility. It does not accept the
 * contract on behalf of the owner, grant policy, enforce runtime budgets,
 * schedule work, execute effects, or authorize completion.
 */
export function assessAgentPlanOutcomeBindingV1(contractInput, planInput) {
  const contract = normalizeOutcomeContractV1(contractInput);
  const plan = normalizeAgentPlanV1(planInput);
  const envelope = planningEnvelopeFromNormalized(contract);

  if (plan.objective !== envelope.objective) {
    throw new Error('AgentPlan objective does not match the exact Outcome Contract desired result');
  }
  if (!sameArray(plan.successCriteria, envelope.successCriteria)) {
    throw new Error('AgentPlan successCriteria do not match the exact Outcome Contract criteria');
  }
  if (Date.parse(plan.createdAt) < Date.parse(contract.createdAt)) {
    throw new Error('AgentPlan cannot predate the Outcome Contract');
  }

  const coverage = envelope.criterionBindings.map(binding => {
    const nodeIds = plan.nodes
      .filter(node => node.acceptanceCriteria.includes(binding.planningCriterion))
      .map(node => node.nodeId)
      .sort();
    if (!nodeIds.length) {
      throw new Error(`Outcome criterion is not covered by any AgentPlan node: ${binding.criterionId}`);
    }
    return freezeDeep({
      criterionId: binding.criterionId,
      planningCriterion: binding.planningCriterion,
      nodeIds,
    });
  });

  const aggregateBudget = aggregatePlanBudget(plan, envelope.resourceEnvelope);

  return freezeDeep({
    schemaVersion: OUTCOME_PLAN_BINDING_SCHEMA_VERSION,
    bindingStatus: 'STRUCTURALLY_BOUND',
    contractId: contract.contractId,
    contractRevision: contract.revision,
    projectId: contract.projectId,
    planId: plan.planId,
    planRevision: plan.revision,
    jobId: plan.jobId,
    criterionCoverage: coverage,
    aggregateBudget,
    resourceEnvelope: envelope.resourceEnvelope,
    maxConcurrency: envelope.maxConcurrency,
    sourceTruth: envelope.sourceTruth,
    authorityRequirements: envelope.authorityRequirements,
    deliverables: envelope.deliverables,
    verifierPlan: envelope.verifierPlan,
    triggerRefs: envelope.triggerRefs,
    advisoryOnly: true,
    planningAuthorized: false,
    policyDecisionGranted: false,
    executionAuthorized: false,
    completionAuthorized: false,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalBudgetEnforcement: true,
    requiresCanonicalConcurrencyEnforcement: true,
    requiresCanonicalVerifier: true,
  });
}
