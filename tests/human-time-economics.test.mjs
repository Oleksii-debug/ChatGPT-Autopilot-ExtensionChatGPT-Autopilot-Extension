import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HumanTimeEconomicsStatus,
  assessHumanTimeEconomicsV1,
} from '../src/core/human-time-economics.js';

const AS_OF = '2026-09-25T08:00:00.000Z';

function readiness(providerId = 'provider-a', overrides = {}) {
  return {
    schemaVersion: 1,
    providerId,
    toolId: 'tool-' + providerId,
    health: 'READY',
    installationRequired: false,
    installed: true,
    authenticationRequired: false,
    authenticated: true,
    pathKind: 'API',
    latencyMs: 500,
    reasonCode: '',
    ...overrides,
  };
}

function budget(machineApiCostUsdMicros, runtimeMs, overrides = {}) {
  const runtimeSeconds = Math.floor((runtimeMs + 999) / 1000);
  return {
    budget: {
      maxConcurrentAgents: 10,
      maxChildAgents: 10,
      maxModelCalls: 100,
      maxModelInputTokens: 1_000_000,
      maxModelOutputTokens: 1_000_000,
      maxRuntimeSeconds: 100_000,
      maxCostUsdMicros: 100_000_000,
    },
    usage: {
      concurrentAgents: 0,
      childAgents: 0,
      modelCalls: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      runtimeSeconds: 0,
      costUsdMicros: 0,
    },
    request: {
      concurrentAgents: 1,
      childAgents: 0,
      modelCalls: 1,
      modelInputTokens: 100,
      modelOutputTokens: 100,
      runtimeSeconds,
      costUsdMicros: machineApiCostUsdMicros,
    },
    ...overrides,
  };
}

function outcome(overrides = {}) {
  return {
    evidenceId: 'outcome-evidence-1',
    sampleCount: 20,
    verifierPassCount: 18,
    reworkCount: 4,
    totalReworkOwnerSeconds: 600,
    observedAt: '2026-09-25T07:55:00.000Z',
    ...overrides,
  };
}

function alternative(id, overrides = {}) {
  const machineApiCostUsdMicros = overrides.machineApiCostUsdMicros ?? 100_000;
  const runtimeMs = overrides.runtimeMs ?? 10_000;
  const base = {
    alternativeId: id,
    providerReadiness: readiness('provider-' + id),
    machineApiCostUsdMicros,
    runtimeMs,
    ownerReviewSeconds: 120,
    ownerCoordinationSeconds: 60,
    deadlineCostUsdMicros: 0,
    deadlineFeasible: true,
    deadlineEvidenceId: 'deadline-' + id,
    deadlineAssessedAt: '2026-09-25T07:56:00.000Z',
    outcomeEvidence: outcome({ evidenceId: 'outcome-' + id }),
    resourceBudget: budget(machineApiCostUsdMicros, runtimeMs),
  };
  return { ...base, ...overrides };
}

function request(alternatives) {
  return {
    schemaVersion: 1,
    assessmentId: 'human-time-1',
    projectId: 'project-1',
    jobId: 'job-1',
    asOf: AS_OF,
    ownerMinuteValueUsdMicros: 1_000_000,
    minimumEvidenceSamples: 10,
    alternatives,
  };
}

test('more expensive machine route can dominate after exact owner-time economics without selecting a winner', () => {
  const cheap = alternative('cheap', {
    machineApiCostUsdMicros: 100_000,
    runtimeMs: 30_000,
    ownerReviewSeconds: 600,
    ownerCoordinationSeconds: 120,
    outcomeEvidence: outcome({
      evidenceId: 'outcome-cheap',
      verifierPassCount: 15,
      reworkCount: 8,
      totalReworkOwnerSeconds: 2_400,
    }),
    resourceBudget: budget(100_000, 30_000),
  });
  const premium = alternative('premium', {
    machineApiCostUsdMicros: 1_000_000,
    runtimeMs: 10_000,
    ownerReviewSeconds: 30,
    ownerCoordinationSeconds: 30,
    outcomeEvidence: outcome({
      evidenceId: 'outcome-premium',
      verifierPassCount: 19,
      reworkCount: 2,
      totalReworkOwnerSeconds: 120,
    }),
    resourceBudget: budget(1_000_000, 10_000),
  });

  const result = assessHumanTimeEconomicsV1(request([cheap, premium]));
  const cheapOut = result.alternatives.find(item => item.alternativeId === 'cheap');
  const premiumOut = result.alternatives.find(item => item.alternativeId === 'premium');

  assert.equal(result.status, HumanTimeEconomicsStatus.COMPARABLE);
  assert.ok(premiumOut.machineApiCostUsdMicros > cheapOut.machineApiCostUsdMicros);
  assert.ok(premiumOut.totalEconomicBurdenUsdMicros < cheapOut.totalEconomicBurdenUsdMicros);
  assert.deepEqual(result.dominance, [{
    dominantAlternativeId: 'premium',
    dominatedAlternativeId: 'cheap',
  }]);
  assert.deepEqual(result.paretoAlternativeIds, ['premium']);
  assert.equal(result.singleWinnerSelected, false);
  assert.equal(result.selectionAuthorized, false);
  assert.equal(result.routingAuthorized, false);
  assert.equal(result.executionAuthorized, false);
});

test('sparse outcome evidence remains explicit and never fabricates a probability', () => {
  const sparse = alternative('sparse', {
    outcomeEvidence: outcome({
      evidenceId: 'outcome-sparse',
      sampleCount: 3,
      verifierPassCount: 3,
      reworkCount: 0,
      totalReworkOwnerSeconds: 0,
    }),
  });
  const result = assessHumanTimeEconomicsV1(request([sparse]));
  const item = result.alternatives[0];

  assert.equal(result.status, HumanTimeEconomicsStatus.NO_COMPARABLE_ALTERNATIVES);
  assert.equal(item.comparable, false);
  assert.equal(item.outcomeEvidence.evidenceSufficient, false);
  assert.equal(item.outcomeEvidence.empiricalVerifierPassRateBasisPoints, null);
  assert.equal(item.expectedReworkOwnerSeconds, null);
  assert.equal(item.totalEconomicBurdenUsdMicros, null);
  assert.deepEqual(item.blockers, ['OUTCOME_EVIDENCE_INSUFFICIENT']);
  assert.equal(result.probabilityClaimed, false);
});

test('empirical pass/rework rates and conservative expected rework are integer-exact', () => {
  const item = alternative('evidence', {
    outcomeEvidence: outcome({
      evidenceId: 'outcome-evidence',
      sampleCount: 12,
      verifierPassCount: 10,
      reworkCount: 5,
      totalReworkOwnerSeconds: 601,
    }),
  });
  const result = assessHumanTimeEconomicsV1(request([item]));
  const evidence = result.alternatives[0].outcomeEvidence;

  assert.equal(evidence.empiricalVerifierPassRateBasisPoints, 8333);
  assert.equal(evidence.empiricalReworkRateBasisPoints, 4166);
  assert.equal(evidence.expectedReworkOwnerSeconds, 51);
  assert.equal(result.probabilityClaimed, false);
});

test('owner attention money uses conservative exact USD-micro arithmetic', () => {
  const item = alternative('money', {
    machineApiCostUsdMicros: 11,
    ownerReviewSeconds: 1,
    ownerCoordinationSeconds: 0,
    outcomeEvidence: outcome({
      evidenceId: 'outcome-money',
      sampleCount: 10,
      verifierPassCount: 10,
      reworkCount: 0,
      totalReworkOwnerSeconds: 0,
    }),
    resourceBudget: budget(11, 10_000),
  });
  const input = request([item]);
  input.ownerMinuteValueUsdMicros = 100;
  const result = assessHumanTimeEconomicsV1(input);
  const out = result.alternatives[0];

  assert.equal(out.expectedOwnerAttentionSeconds, 1);
  assert.equal(out.ownerAttentionCostUsdMicros, 2);
  assert.equal(out.totalEconomicBurdenUsdMicros, 13);
});

test('resource budget request cannot understate machine money cost or runtime', () => {
  const money = alternative('money-under', {
    machineApiCostUsdMicros: 50_000,
    resourceBudget: budget(49_999, 10_000),
  });
  assert.throws(
    () => assessHumanTimeEconomicsV1(request([money])),
    /understates machine\/API money cost/,
  );

  const runtimeBudget = budget(100_000, 10_000);
  runtimeBudget.request.runtimeSeconds = 9;
  const runtime = alternative('runtime-under', { resourceBudget: runtimeBudget });
  assert.throws(
    () => assessHumanTimeEconomicsV1(request([runtime])),
    /understates runtime/,
  );
});

test('canonical ResourceBudget denial blocks comparison without becoming authority', () => {
  const deniedBudget = budget(100_000, 10_000);
  deniedBudget.budget.maxCostUsdMicros = 50_000;
  const result = assessHumanTimeEconomicsV1(request([
    alternative('denied', { resourceBudget: deniedBudget }),
  ]));
  const item = result.alternatives[0];

  assert.equal(item.resourceBudgetDecision, 'DENY');
  assert.equal(item.comparable, false);
  assert.ok(item.blockers.includes('RESOURCE_BUDGET_DENIED'));
  assert.equal(item.budgetAuthorized, false);
  assert.equal(result.requiresCanonicalBudgetAdmission, true);
});

test('provider readiness and authentication failures remain explicit blockers', () => {
  const unknown = alternative('unknown', {
    providerReadiness: readiness('provider-unknown', { health: 'UNKNOWN' }),
  });
  const auth = alternative('auth', {
    providerReadiness: readiness('provider-auth', {
      authenticationRequired: true,
      authenticated: false,
    }),
  });
  const result = assessHumanTimeEconomicsV1(request([unknown, auth]));

  assert.equal(result.status, HumanTimeEconomicsStatus.NO_COMPARABLE_ALTERNATIVES);
  assert.deepEqual(
    result.alternatives.find(item => item.alternativeId === 'unknown').blockers,
    ['PROVIDER_HEALTH_UNKNOWN'],
  );
  assert.deepEqual(
    result.alternatives.find(item => item.alternativeId === 'auth').blockers,
    ['PROVIDER_NOT_AUTHENTICATED'],
  );
  assert.equal(result.requiresFreshProviderReadiness, true);
});

test('deadline infeasibility blocks comparison and deadline evidence cannot come from the future', () => {
  const infeasible = alternative('late', {
    deadlineFeasible: false,
    deadlineCostUsdMicros: 5_000_000,
  });
  const result = assessHumanTimeEconomicsV1(request([infeasible]));
  assert.ok(result.alternatives[0].blockers.includes('DEADLINE_INFEASIBLE'));
  assert.equal(result.requiresCanonicalDeadlineAssessment, true);
  assert.equal(result.deadlineEvidenceTrusted, false);

  const future = alternative('future-deadline', {
    deadlineAssessedAt: '2026-09-25T08:00:00.001Z',
  });
  assert.throws(
    () => assessHumanTimeEconomicsV1(request([future])),
    /deadlineAssessedAt postdates assessment/,
  );
});

test('outcome evidence must be causal and internally consistent', () => {
  const future = alternative('future-outcome', {
    outcomeEvidence: outcome({ observedAt: '2026-09-25T08:00:00.001Z' }),
  });
  assert.throws(
    () => assessHumanTimeEconomicsV1(request([future])),
    /postdates assessment/,
  );

  const noRework = alternative('bad-rework', {
    outcomeEvidence: outcome({ reworkCount: 0, totalReworkOwnerSeconds: 10 }),
  });
  assert.throws(
    () => assessHumanTimeEconomicsV1(request([noRework])),
    /rework time requires rework observations/,
  );

  const noTime = alternative('bad-rework-time', {
    outcomeEvidence: outcome({ reworkCount: 2, totalReworkOwnerSeconds: 0 }),
  });
  assert.throws(
    () => assessHumanTimeEconomicsV1(request([noTime])),
    /require measured owner time/,
  );
});

test('Pareto frontier preserves tradeoffs instead of manufacturing a scalar winner', () => {
  const fastExpensive = alternative('fast', {
    machineApiCostUsdMicros: 2_000_000,
    runtimeMs: 5_000,
    ownerReviewSeconds: 60,
    ownerCoordinationSeconds: 0,
    outcomeEvidence: outcome({
      evidenceId: 'outcome-fast',
      verifierPassCount: 18,
      reworkCount: 2,
      totalReworkOwnerSeconds: 120,
    }),
    resourceBudget: budget(2_000_000, 5_000),
  });
  const slowCheap = alternative('cheap', {
    machineApiCostUsdMicros: 100_000,
    runtimeMs: 60_000,
    ownerReviewSeconds: 60,
    ownerCoordinationSeconds: 0,
    outcomeEvidence: outcome({
      evidenceId: 'outcome-cheap-tradeoff',
      verifierPassCount: 18,
      reworkCount: 2,
      totalReworkOwnerSeconds: 120,
    }),
    resourceBudget: budget(100_000, 60_000),
  });
  const result = assessHumanTimeEconomicsV1(request([fastExpensive, slowCheap]));

  assert.deepEqual(result.dominance, []);
  assert.deepEqual(result.paretoAlternativeIds, ['cheap', 'fast']);
  assert.equal(result.singleWinnerSelected, false);
});

test('duplicate alternatives and non-canonical numeric aliases fail closed', () => {
  assert.throws(
    () => assessHumanTimeEconomicsV1(request([
      alternative('dup'),
      alternative('dup', { providerReadiness: readiness('provider-other') }),
    ])),
    /duplicate alternativeId/,
  );

  const negativeZero = alternative('negative-zero', { ownerReviewSeconds: -0 });
  assert.throws(
    () => assessHumanTimeEconomicsV1(request([negativeZero])),
    /ownerReviewSeconds is invalid/,
  );
});

test('identity and timestamp aliases fail closed', () => {
  const input = request([alternative('one')]);
  input.assessmentId = ' human-time-1 ';
  assert.throws(
    () => assessHumanTimeEconomicsV1(input),
    /exact canonical identity/,
  );

  const time = request([alternative('two')]);
  time.asOf = '2026-09-25T08:00:00Z';
  assert.throws(
    () => assessHumanTimeEconomicsV1(time),
    /canonical ISO-8601/,
  );
});

test('descriptor and array boundaries do not execute ordinary getters', () => {
  let reads = 0;
  const alt = alternative('getter');
  Object.defineProperty(alt, 'machineApiCostUsdMicros', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 100_000;
    },
  });
  assert.throws(
    () => assessHumanTimeEconomicsV1(request([alt])),
    /enumerable own data property/,
  );
  assert.equal(reads, 0);

  const base = request([alternative('proxy')]);
  base.alternatives = new Proxy(base.alternatives, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = assessHumanTimeEconomicsV1(base);
  assert.equal(result.alternatives.length, 1);
  assert.equal(reads, 0);
});

test('output is deterministic and advisory-only', () => {
  const result = assessHumanTimeEconomicsV1(request([
    alternative('zeta'),
    alternative('alpha'),
  ]));
  assert.deepEqual(result.alternatives.map(item => item.alternativeId), ['alpha', 'zeta']);
  assert.equal(result.methodology, 'EMPIRICAL_COUNTS_EXACT_MONEY_PARETO');
  assert.equal(result.selectionAuthorized, false);
  assert.equal(result.routingAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.budgetAuthorized, false);
  assert.equal(result.requiresCanonicalPolicyDecision, true);
  assert.equal(result.requiresTrustedOutcomeEvidenceBinding, true);
  assert.equal(Object.isFrozen(result), true);
});
