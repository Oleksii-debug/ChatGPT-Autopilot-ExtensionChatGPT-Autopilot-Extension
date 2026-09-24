import {
  evaluateResourceBudgetV1,
  normalizeResourceBudgetV1,
} from './resource-budget-governor.js';

/**
 * Pure composition between the durable AgentPlan budget contract and the
 * broader owner resource envelope. Pricing/metering stays in the canonical AI
 * route cost authority; this module only admits an already-metered request.
 * It does not reserve, persist, schedule, spawn workers, or call a model.
 */
export const AGENT_BUDGET_ADMISSION_VERSION = 1;

const AGENT_PLAN_BUDGET_KEYS = new Set([
  'maxModelCalls',
  'maxRuntimeSeconds',
  'maxCostUsdMicros',
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value;
}

function exact(raw, allowed, label) {
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
}

function own(raw, key) {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function integer(value, label, max, fallback = 0) {
  const number = value == null ? fallback : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > max) {
    throw new Error(`${label} is invalid`);
  }
  return number;
}

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

export function normalizeAgentPlanBudgetCeilingV1(input = {}) {
  const raw = object(input, 'AgentPlan budget ceiling');
  exact(raw, AGENT_PLAN_BUDGET_KEYS, 'AgentPlan budget ceiling');
  return frozen({
    maxModelCalls: integer(own(raw, 'maxModelCalls'), 'AgentPlan budget maxModelCalls', 1_000_000),
    maxRuntimeSeconds: integer(own(raw, 'maxRuntimeSeconds'), 'AgentPlan budget maxRuntimeSeconds', 31_536_000),
    maxCostUsdMicros: integer(own(raw, 'maxCostUsdMicros'), 'AgentPlan budget maxCostUsdMicros', Number.MAX_SAFE_INTEGER),
  });
}

/**
 * AgentPlan owns three existing node ceilings. The owner resource envelope
 * remains authoritative for every other dimension. Shared dimensions are
 * narrowed to the stricter value; this function can never expand authority.
 */
export function narrowResourceBudgetWithAgentPlanV1({ ownerBudget, agentPlanBudget } = {}) {
  const owner = normalizeResourceBudgetV1(ownerBudget);
  const plan = normalizeAgentPlanBudgetCeilingV1(agentPlanBudget);
  return frozen({
    ...owner,
    maxModelCalls: Math.min(owner.maxModelCalls, plan.maxModelCalls),
    maxRuntimeSeconds: Math.min(owner.maxRuntimeSeconds, plan.maxRuntimeSeconds),
    maxCostUsdMicros: Math.min(owner.maxCostUsdMicros, plan.maxCostUsdMicros),
  });
}

/**
 * Accepts any partial ResourceRequestV1 shape. In particular the canonical AI
 * cost meter may supply modelCalls/modelInputTokens/modelOutputTokens/
 * costUsdMicros while the governor fills unrelated dimensions with zero.
 */
export function evaluateAgentResourceAdmissionV1({
  ownerBudget,
  agentPlanBudget,
  currentUsage = {},
  request = {},
} = {}) {
  const budget = narrowResourceBudgetWithAgentPlanV1({ ownerBudget, agentPlanBudget });
  return evaluateResourceBudgetV1({ budget, usage: currentUsage, request });
}
