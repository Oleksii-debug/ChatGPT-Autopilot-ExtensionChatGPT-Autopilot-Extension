import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SELF_REPAIR_ATTEMPTS,
  SelfRepairCycleState,
  assessSelfRepairCycleV1,
  normalizeSelfRepairCycleV1,
} from '../src/core/self-repair-cycle.js';

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);
const H4 = '4'.repeat(64);

function failure({
  revision = 'rev-1',
  hash = H1,
  completedAt = '2026-09-25T05:00:10.000Z',
} = {}) {
  return {
    verifierId: 'verifier-1',
    subjectRevisionId: revision,
    evidenceSha256: hash,
    completedAt,
  };
}

function diagnosis({
  id = 'diag-1',
  createdAt = '2026-09-25T05:00:20.000Z',
} = {}) {
  return {
    diagnosisId: id,
    producerId: 'actor-1',
    hypothesisCodes: ['regression.test-failure', 'boundary.stale-evidence'],
    createdAt,
  };
}

function repair({
  id = 'repair-1',
  from = 'rev-1',
  to = 'rev-2',
  artifactId = 'artifact-change-1',
  hash = H2,
  appliedAt = '2026-09-25T05:00:30.000Z',
} = {}) {
  return {
    repairId: id,
    producerId: 'actor-1',
    fromRevisionId: from,
    toRevisionId: to,
    changeArtifactId: artifactId,
    changeArtifactSha256: hash,
    appliedAt,
  };
}

function retest({
  id = 'retest-1',
  revision = 'rev-2',
  outcome = 'PASS',
  hash = H3,
  startedAt = '2026-09-25T05:00:40.000Z',
  completedAt = '2026-09-25T05:00:50.000Z',
  verifierId = 'verifier-1',
  verifierPlanRevisionId = 'verify-plan-r1',
} = {}) {
  return {
    runId: id,
    verifierId,
    verifierPlanRevisionId,
    subjectRevisionId: revision,
    outcome,
    evidenceSha256: hash,
    startedAt,
    completedAt,
  };
}

function attempt({
  number = 1,
  failureValue = failure(),
  diagnosisValue = diagnosis(),
  repairValue = null,
  retestValue = null,
} = {}) {
  return {
    attemptNumber: number,
    failure: failureValue,
    diagnosis: diagnosisValue,
    repair: repairValue,
    retest: retestValue,
  };
}

function cycle({
  attempts = [attempt()],
  maxAttempts = 3,
  actorId = 'actor-1',
  verifierId = 'verifier-1',
  baselineRevisionId = 'rev-1',
  updatedAt = '2026-09-25T05:02:00.000Z',
} = {}) {
  return {
    schemaVersion: 1,
    cycleId: 'cycle-1',
    subjectId: 'subject-1',
    actorId,
    verifierId,
    verifierPlanRevisionId: 'verify-plan-r1',
    baselineRevisionId,
    maxAttempts,
    createdAt: '2026-09-25T05:00:10.000Z',
    updatedAt,
    attempts,
  };
}

test('starts from trusted failure evidence in READY_FOR_REPAIR without granting authority', () => {
  const result = assessSelfRepairCycleV1(cycle());
  assert.equal(result.state, SelfRepairCycleState.READY_FOR_REPAIR);
  assert.equal(result.activeAttemptNumber, 1);
  assert.equal(result.currentRevisionId, 'rev-1');
  assert.equal(result.retestPassed, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.verificationAuthorized, false);
  assert.equal(result.policyGranted, false);
  assert.equal(result.requiresCanonicalExecutor, true);
  assert.equal(result.requiresCanonicalPolicy, true);
  assert.equal(result.requiresIndependentVerifier, true);
  assert.equal(result.evidenceTrust, 'UNVERIFIED_INPUT');
  assert.equal(result.requiresCanonicalEvidenceResolution, true);
  assert.equal(result.completionAuthorized, false);
});

test('applied repair must move revision and requires fresh retest before success', () => {
  const value = cycle({
    attempts: [attempt({ repairValue: repair() })],
  });
  const result = assessSelfRepairCycleV1(value);
  assert.equal(result.state, SelfRepairCycleState.READY_FOR_RETEST);
  assert.equal(result.currentRevisionId, 'rev-2');
  assert.equal(result.retestPassed, false);

  const unchanged = cycle({
    attempts: [attempt({
      repairValue: repair({ from: 'rev-1', to: 'rev-1' }),
    })],
  });
  assert.throws(
    () => assessSelfRepairCycleV1(unchanged),
    /must move the subject to a new revision/u,
  );
});

test('only independent fresh PASS retest can produce VERIFIED', () => {
  const value = cycle({
    attempts: [attempt({
      repairValue: repair(),
      retestValue: retest({ outcome: 'PASS' }),
    })],
  });
  const normalized = normalizeSelfRepairCycleV1(value);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.attempts), true);

  const result = assessSelfRepairCycleV1(value);
  assert.equal(result.state, SelfRepairCycleState.VERIFIED);
  assert.equal(result.activeAttemptNumber, 0);
  assert.equal(result.currentRevisionId, 'rev-2');
  assert.equal(result.completedRetests, 1);
  assert.equal(result.retestPassed, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
});

test('actor and verifier identity must be independent', () => {
  assert.throws(
    () => assessSelfRepairCycleV1(cycle({ verifierId: 'actor-1' })),
    /independent from actorId/u,
  );
  const wrongRetestVerifier = cycle({
    attempts: [attempt({
      repairValue: repair(),
      retestValue: retest({ verifierId: 'actor-1' }),
    })],
  });
  assert.throws(
    () => assessSelfRepairCycleV1(wrongRetestVerifier),
    /declared independent verifier/u,
  );
});

test('retest is bound to repaired revision, verifier plan and post-repair causality', () => {
  const wrongRevision = cycle({
    attempts: [attempt({
      repairValue: repair(),
      retestValue: retest({ revision: 'rev-1' }),
    })],
  });
  assert.throws(() => assessSelfRepairCycleV1(wrongRevision), /repaired subject revision/u);

  const wrongPlan = cycle({
    attempts: [attempt({
      repairValue: repair(),
      retestValue: retest({ verifierPlanRevisionId: 'verify-plan-r2' }),
    })],
  });
  assert.throws(() => assessSelfRepairCycleV1(wrongPlan), /verifier plan revision/u);

  const staleRetest = cycle({
    attempts: [attempt({
      repairValue: repair({ appliedAt: '2026-09-25T05:00:30.000Z' }),
      retestValue: retest({
        startedAt: '2026-09-25T05:00:29.000Z',
        completedAt: '2026-09-25T05:00:50.000Z',
      }),
    })],
  });
  assert.throws(() => assessSelfRepairCycleV1(staleRetest), /cannot start before/u);
});

test('FAIL retest can open exactly the next attempt only from the same evidence', () => {
  const firstRetest = retest({ outcome: 'FAIL', hash: H3 });
  const first = attempt({
    repairValue: repair(),
    retestValue: firstRetest,
  });
  const result = assessSelfRepairCycleV1(cycle({ attempts: [first], maxAttempts: 3 }));
  assert.equal(result.state, SelfRepairCycleState.READY_FOR_REPAIR);
  assert.equal(result.activeAttemptNumber, 2);
  assert.equal(result.currentRevisionId, 'rev-2');
  assert.equal(result.retestPassed, false);

  const second = attempt({
    number: 2,
    failureValue: failure({
      revision: 'rev-2',
      hash: H3,
      completedAt: '2026-09-25T05:00:50.000Z',
    }),
    diagnosisValue: diagnosis({
      id: 'diag-2',
      createdAt: '2026-09-25T05:01:00.000Z',
    }),
    repairValue: repair({
      id: 'repair-2',
      from: 'rev-2',
      to: 'rev-3',
      artifactId: 'artifact-change-2',
      hash: H4,
      appliedAt: '2026-09-25T05:01:10.000Z',
    }),
    retestValue: retest({
      id: 'retest-2',
      revision: 'rev-3',
      outcome: 'PASS',
      hash: H4,
      startedAt: '2026-09-25T05:01:20.000Z',
      completedAt: '2026-09-25T05:01:30.000Z',
    }),
  });
  const completed = assessSelfRepairCycleV1(cycle({
    attempts: [first, second],
    maxAttempts: 3,
  }));
  assert.equal(completed.state, SelfRepairCycleState.VERIFIED);
  assert.equal(completed.currentRevisionId, 'rev-3');

  const forgedSecond = structuredClone(second);
  forgedSecond.failure.evidenceSha256 = H2;
  assert.throws(
    () => assessSelfRepairCycleV1(cycle({ attempts: [first, forgedSecond], maxAttempts: 3 })),
    /must exactly reuse the prior FAIL retest evidence/u,
  );
});

test('PASS or ERROR retest cannot be followed by another attempt', () => {
  for (const outcome of ['PASS', 'ERROR']) {
    const first = attempt({
      repairValue: repair(),
      retestValue: retest({ outcome }),
    });
    const second = attempt({
      number: 2,
      failureValue: failure({
        revision: 'rev-2',
        hash: H3,
        completedAt: '2026-09-25T05:00:50.000Z',
      }),
      diagnosisValue: diagnosis({
        id: 'diag-2',
        createdAt: '2026-09-25T05:01:00.000Z',
      }),
    });
    assert.throws(
      () => assessSelfRepairCycleV1(cycle({ attempts: [first, second] })),
      /allowed only after FAIL retest/u,
    );
  }
});

test('ERROR requires manual review and failed final attempt is EXHAUSTED', () => {
  const errored = assessSelfRepairCycleV1(cycle({
    attempts: [attempt({
      repairValue: repair(),
      retestValue: retest({ outcome: 'ERROR' }),
    })],
  }));
  assert.equal(errored.state, SelfRepairCycleState.MANUAL_REVIEW);
  assert.equal(errored.retestPassed, false);

  const exhausted = assessSelfRepairCycleV1(cycle({
    maxAttempts: 1,
    attempts: [attempt({
      repairValue: repair(),
      retestValue: retest({ outcome: 'FAIL' }),
    })],
  }));
  assert.equal(exhausted.state, SelfRepairCycleState.EXHAUSTED);
  assert.equal(exhausted.attemptsRemaining, 0);
  assert.equal(exhausted.retestPassed, false);
});

test('attempt count is bounded and sequential', () => {
  assert.throws(
    () => assessSelfRepairCycleV1(cycle({ maxAttempts: 0 })),
    /maxAttempts/u,
  );
  assert.throws(
    () => assessSelfRepairCycleV1(cycle({ maxAttempts: MAX_SELF_REPAIR_ATTEMPTS + 1 })),
    /maxAttempts/u,
  );
  const invalid = cycle({
    attempts: [attempt({ number: 2 })],
  });
  assert.throws(() => assessSelfRepairCycleV1(invalid), /must be sequential/u);
});

test('cycle timestamps cannot backdate diagnosis, repair, retest or updatedAt', () => {
  const cyclePredatesFailure = cycle({
    attempts: [attempt({
      failureValue: failure({ completedAt: '2026-09-25T05:00:11.000Z' }),
      diagnosisValue: diagnosis({ createdAt: '2026-09-25T05:00:20.000Z' }),
    })],
  });
  assert.throws(() => assessSelfRepairCycleV1(cyclePredatesFailure), /createdAt cannot predate initial failure evidence/u);

  const earlyDiagnosis = cycle({
    attempts: [attempt({
      diagnosisValue: diagnosis({ createdAt: '2026-09-25T05:00:09.000Z' }),
    })],
  });
  assert.throws(() => assessSelfRepairCycleV1(earlyDiagnosis), /cannot predate failure evidence/u);

  const earlyRepair = cycle({
    attempts: [attempt({
      diagnosisValue: diagnosis({ createdAt: '2026-09-25T05:00:20.000Z' }),
      repairValue: repair({ appliedAt: '2026-09-25T05:00:19.000Z' }),
    })],
  });
  assert.throws(() => assessSelfRepairCycleV1(earlyRepair), /cannot predate diagnosis/u);

  const staleUpdatedAt = cycle({
    attempts: [attempt({
      repairValue: repair(),
      retestValue: retest(),
    })],
    updatedAt: '2026-09-25T05:00:49.000Z',
  });
  assert.throws(() => assessSelfRepairCycleV1(staleUpdatedAt), /updatedAt cannot predate attempt evidence/u);
});

test('strict data boundary rejects accessors, symbols, hidden fields, sparse arrays and side data', () => {
  let reads = 0;
  const root = cycle();
  Object.defineProperty(root, 'cycleId', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return 'cycle-1';
    },
  });
  assert.throws(
    () => assessSelfRepairCycleV1(root),
    /enumerable own data properties/u,
  );
  assert.equal(reads, 0);

  const symbol = cycle();
  symbol[Symbol('authority')] = true;
  assert.throws(() => assessSelfRepairCycleV1(symbol), /symbol fields/u);

  const hidden = cycle();
  Object.defineProperty(hidden, 'hiddenAuthority', {
    enumerable: false,
    configurable: true,
    value: true,
  });
  assert.throws(() => assessSelfRepairCycleV1(hidden), /enumerable own data properties/u);

  const sparse = cycle();
  sparse.attempts = new Array(1);
  assert.throws(() => assessSelfRepairCycleV1(sparse), /must not be sparse/u);

  const side = cycle();
  side.attempts.extraAuthority = true;
  assert.throws(() => assessSelfRepairCycleV1(side), /non-index array data/u);
});

test('unknown fields, noncanonical hashes and baseline mismatch fail closed', () => {
  const extra = cycle();
  extra.executionAuthorized = true;
  assert.throws(() => assessSelfRepairCycleV1(extra), /unknown field/u);

  const badHash = cycle({
    attempts: [attempt({
      failureValue: failure({ hash: 'A'.repeat(64) }),
    })],
  });
  assert.throws(() => assessSelfRepairCycleV1(badHash), /lowercase SHA-256/u);

  assert.throws(
    () => assessSelfRepairCycleV1(cycle({ baselineRevisionId: 'rev-other' })),
    /bind baselineRevisionId/u,
  );
});
