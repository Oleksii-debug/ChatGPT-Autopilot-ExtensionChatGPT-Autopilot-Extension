export const SELF_REPAIR_CYCLE_SCHEMA_VERSION = 1;
export const MAX_SELF_REPAIR_ATTEMPTS = 8;

export const SelfRepairRetestOutcome = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  ERROR: 'ERROR',
});

export const SelfRepairCycleState = Object.freeze({
  READY_FOR_REPAIR: 'READY_FOR_REPAIR',
  READY_FOR_RETEST: 'READY_FOR_RETEST',
  VERIFIED: 'VERIFIED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  EXHAUSTED: 'EXHAUSTED',
});

const RETEST_OUTCOMES = new Set(Object.values(SelfRepairRetestOutcome));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const CYCLE_KEYS = new Set([
  'schemaVersion',
  'cycleId',
  'subjectId',
  'actorId',
  'verifierId',
  'verifierPlanRevisionId',
  'baselineRevisionId',
  'maxAttempts',
  'createdAt',
  'updatedAt',
  'attempts',
]);
const ATTEMPT_KEYS = new Set([
  'attemptNumber',
  'failure',
  'diagnosis',
  'repair',
  'retest',
]);
const FAILURE_KEYS = new Set([
  'verifierId',
  'subjectRevisionId',
  'evidenceSha256',
  'completedAt',
]);
const DIAGNOSIS_KEYS = new Set([
  'diagnosisId',
  'producerId',
  'hypothesisCodes',
  'createdAt',
]);
const REPAIR_KEYS = new Set([
  'repairId',
  'producerId',
  'fromRevisionId',
  'toRevisionId',
  'changeArtifactId',
  'changeArtifactSha256',
  'appliedAt',
]);
const RETEST_KEYS = new Set([
  'runId',
  'verifierId',
  'verifierPlanRevisionId',
  'subjectRevisionId',
  'outcome',
  'evidenceSha256',
  'startedAt',
  'completedAt',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const out = Object.create(null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new Error(label + ' must not contain symbol fields');
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + ' must contain enumerable own data properties only');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
  }
}

function denseArray(value, label, { min = 0, max }) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < min
      || lengthDescriptor.value > max) {
    throw new Error(label + ' must be a bounded array');
  }
  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index array data');
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || !Object.hasOwn(descriptor, 'value')
        || descriptor.enumerable !== true) {
      throw new Error(label + ' must contain canonical enumerable data indices only');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + ' must not be sparse');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA256.test(value)) {
    throw new Error(label + ' must be canonical lowercase SHA-256');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function integer(value, label, { min, max }) {
  if (typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value < min
      || value > max) {
    throw new Error(label + ' is out of bounds');
  }
  return value;
}

function hypothesisCodes(value, label) {
  const items = denseArray(value, label, { min: 1, max: 16 })
    .map((item, index) => id(item, label + '[' + index + ']'));
  if (new Set(items).size !== items.length) throw new Error(label + ' contains duplicates');
  items.sort();
  return Object.freeze(items);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function normalizeFailure(input, label, verifierId) {
  const raw = record(input, label);
  exactKeys(raw, FAILURE_KEYS, label);
  const failureVerifierId = id(raw.verifierId, label + ' verifierId');
  if (failureVerifierId !== verifierId) {
    throw new Error(label + ' verifierId does not match the declared independent verifier');
  }
  return freezeDeep({
    verifierId: failureVerifierId,
    subjectRevisionId: id(raw.subjectRevisionId, label + ' subjectRevisionId'),
    evidenceSha256: sha256(raw.evidenceSha256, label + ' evidenceSha256'),
    completedAt: timestamp(raw.completedAt, label + ' completedAt'),
  });
}

function normalizeDiagnosis(input, label, actorId, failureCompletedAt) {
  const raw = record(input, label);
  exactKeys(raw, DIAGNOSIS_KEYS, label);
  const producerId = id(raw.producerId, label + ' producerId');
  if (producerId !== actorId) throw new Error(label + ' producerId must match actorId');
  const createdAt = timestamp(raw.createdAt, label + ' createdAt');
  if (Date.parse(createdAt) < Date.parse(failureCompletedAt)) {
    throw new Error(label + ' cannot predate failure evidence');
  }
  return freezeDeep({
    diagnosisId: id(raw.diagnosisId, label + ' diagnosisId'),
    producerId,
    hypothesisCodes: hypothesisCodes(raw.hypothesisCodes, label + ' hypothesisCodes'),
    createdAt,
  });
}

function normalizeRepair(input, label, actorId, failureRevisionId, diagnosisCreatedAt) {
  if (input == null) return null;
  const raw = record(input, label);
  exactKeys(raw, REPAIR_KEYS, label);
  const producerId = id(raw.producerId, label + ' producerId');
  if (producerId !== actorId) throw new Error(label + ' producerId must match actorId');
  const fromRevisionId = id(raw.fromRevisionId, label + ' fromRevisionId');
  const toRevisionId = id(raw.toRevisionId, label + ' toRevisionId');
  if (fromRevisionId !== failureRevisionId) {
    throw new Error(label + ' fromRevisionId must match the failed subject revision');
  }
  if (toRevisionId === fromRevisionId) {
    throw new Error(label + ' must move the subject to a new revision');
  }
  const appliedAt = timestamp(raw.appliedAt, label + ' appliedAt');
  if (Date.parse(appliedAt) < Date.parse(diagnosisCreatedAt)) {
    throw new Error(label + ' cannot predate diagnosis');
  }
  return freezeDeep({
    repairId: id(raw.repairId, label + ' repairId'),
    producerId,
    fromRevisionId,
    toRevisionId,
    changeArtifactId: id(raw.changeArtifactId, label + ' changeArtifactId'),
    changeArtifactSha256: sha256(raw.changeArtifactSha256, label + ' changeArtifactSha256'),
    appliedAt,
  });
}

function normalizeRetest(input, label, verifierId, verifierPlanRevisionId, repair) {
  if (input == null) return null;
  if (!repair) throw new Error(label + ' requires an applied repair');
  const raw = record(input, label);
  exactKeys(raw, RETEST_KEYS, label);
  const observedVerifierId = id(raw.verifierId, label + ' verifierId');
  if (observedVerifierId !== verifierId) {
    throw new Error(label + ' verifierId does not match the declared independent verifier');
  }
  const observedPlanRevisionId = id(raw.verifierPlanRevisionId, label + ' verifierPlanRevisionId');
  if (observedPlanRevisionId !== verifierPlanRevisionId) {
    throw new Error(label + ' verifier plan revision does not match');
  }
  const subjectRevisionId = id(raw.subjectRevisionId, label + ' subjectRevisionId');
  if (subjectRevisionId !== repair.toRevisionId) {
    throw new Error(label + ' must verify the repaired subject revision');
  }
  if (typeof raw.outcome !== 'string' || !RETEST_OUTCOMES.has(raw.outcome)) {
    throw new Error(label + ' outcome is invalid');
  }
  const startedAt = timestamp(raw.startedAt, label + ' startedAt');
  const completedAt = timestamp(raw.completedAt, label + ' completedAt');
  if (Date.parse(startedAt) < Date.parse(repair.appliedAt)) {
    throw new Error(label + ' cannot start before the repair was applied');
  }
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error(label + ' completedAt cannot predate startedAt');
  }
  return freezeDeep({
    runId: id(raw.runId, label + ' runId'),
    verifierId: observedVerifierId,
    verifierPlanRevisionId: observedPlanRevisionId,
    subjectRevisionId,
    outcome: raw.outcome,
    evidenceSha256: sha256(raw.evidenceSha256, label + ' evidenceSha256'),
    startedAt,
    completedAt,
  });
}

function normalizeAttempt(input, index, context) {
  const label = 'SelfRepairAttemptV1[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, ATTEMPT_KEYS, label);
  const attemptNumber = integer(raw.attemptNumber, label + ' attemptNumber', {
    min: 1,
    max: context.maxAttempts,
  });
  if (attemptNumber !== index + 1) {
    throw new Error(label + ' attemptNumber must be sequential');
  }
  const failure = normalizeFailure(raw.failure, label + ' failure', context.verifierId);
  const diagnosis = normalizeDiagnosis(
    raw.diagnosis,
    label + ' diagnosis',
    context.actorId,
    failure.completedAt,
  );
  const repair = normalizeRepair(
    raw.repair,
    label + ' repair',
    context.actorId,
    failure.subjectRevisionId,
    diagnosis.createdAt,
  );
  const retest = normalizeRetest(
    raw.retest,
    label + ' retest',
    context.verifierId,
    context.verifierPlanRevisionId,
    repair,
  );
  return freezeDeep({ attemptNumber, failure, diagnosis, repair, retest });
}

function assertAttemptChain(attempts, baselineRevisionId) {
  if (attempts[0].failure.subjectRevisionId !== baselineRevisionId) {
    throw new Error('first self-repair attempt must bind baselineRevisionId');
  }
  for (let index = 1; index < attempts.length; index += 1) {
    const previous = attempts[index - 1];
    const current = attempts[index];
    if (!previous.retest) {
      throw new Error('a later self-repair attempt requires the previous retest');
    }
    if (previous.retest.outcome !== SelfRepairRetestOutcome.FAIL) {
      throw new Error('a later self-repair attempt is allowed only after FAIL retest');
    }
    if (current.failure.subjectRevisionId !== previous.retest.subjectRevisionId
        || current.failure.evidenceSha256 !== previous.retest.evidenceSha256
        || current.failure.completedAt !== previous.retest.completedAt
        || current.failure.verifierId !== previous.retest.verifierId) {
      throw new Error('next self-repair attempt failure must exactly reuse the prior FAIL retest evidence');
    }
  }
}

function latestEventAt(attempt) {
  if (attempt.retest) return attempt.retest.completedAt;
  if (attempt.repair) return attempt.repair.appliedAt;
  return attempt.diagnosis.createdAt;
}

function deriveState(attempts, maxAttempts) {
  const last = attempts.at(-1);
  if (!last.repair) {
    return {
      state: SelfRepairCycleState.READY_FOR_REPAIR,
      activeAttemptNumber: last.attemptNumber,
      currentRevisionId: last.failure.subjectRevisionId,
    };
  }
  if (!last.retest) {
    return {
      state: SelfRepairCycleState.READY_FOR_RETEST,
      activeAttemptNumber: last.attemptNumber,
      currentRevisionId: last.repair.toRevisionId,
    };
  }
  if (last.retest.outcome === SelfRepairRetestOutcome.PASS) {
    return {
      state: SelfRepairCycleState.VERIFIED,
      activeAttemptNumber: 0,
      currentRevisionId: last.retest.subjectRevisionId,
    };
  }
  if (last.retest.outcome === SelfRepairRetestOutcome.ERROR) {
    return {
      state: SelfRepairCycleState.MANUAL_REVIEW,
      activeAttemptNumber: 0,
      currentRevisionId: last.retest.subjectRevisionId,
    };
  }
  if (attempts.length >= maxAttempts) {
    return {
      state: SelfRepairCycleState.EXHAUSTED,
      activeAttemptNumber: 0,
      currentRevisionId: last.retest.subjectRevisionId,
    };
  }
  return {
    state: SelfRepairCycleState.READY_FOR_REPAIR,
    activeAttemptNumber: attempts.length + 1,
    currentRevisionId: last.retest.subjectRevisionId,
  };
}

export function normalizeSelfRepairCycleV1(input) {
  const raw = record(input, 'SelfRepairCycleV1');
  exactKeys(raw, CYCLE_KEYS, 'SelfRepairCycleV1');
  if (raw.schemaVersion !== SELF_REPAIR_CYCLE_SCHEMA_VERSION) {
    throw new Error('Unsupported SelfRepairCycleV1 schemaVersion');
  }

  const actorId = id(raw.actorId, 'SelfRepairCycleV1 actorId');
  const verifierId = id(raw.verifierId, 'SelfRepairCycleV1 verifierId');
  if (actorId === verifierId) {
    throw new Error('SelfRepairCycleV1 requires verifier identity independent from actorId');
  }
  const verifierPlanRevisionId = id(
    raw.verifierPlanRevisionId,
    'SelfRepairCycleV1 verifierPlanRevisionId',
  );
  const maxAttempts = integer(raw.maxAttempts, 'SelfRepairCycleV1 maxAttempts', {
    min: 1,
    max: MAX_SELF_REPAIR_ATTEMPTS,
  });
  const createdAt = timestamp(raw.createdAt, 'SelfRepairCycleV1 createdAt');
  const updatedAt = timestamp(raw.updatedAt, 'SelfRepairCycleV1 updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('SelfRepairCycleV1 updatedAt cannot predate createdAt');
  }

  const attempts = denseArray(raw.attempts, 'SelfRepairCycleV1 attempts', {
    min: 1,
    max: maxAttempts,
  }).map((attempt, index) => normalizeAttempt(attempt, index, {
    actorId,
    verifierId,
    verifierPlanRevisionId,
    maxAttempts,
  }));

  const baselineRevisionId = id(raw.baselineRevisionId, 'SelfRepairCycleV1 baselineRevisionId');
  assertAttemptChain(attempts, baselineRevisionId);

  if (Date.parse(attempts[0].failure.completedAt) > Date.parse(createdAt)) {
    throw new Error('SelfRepairCycleV1 createdAt cannot predate initial failure evidence');
  }
  for (const attempt of attempts) {
    if (Date.parse(latestEventAt(attempt)) > Date.parse(updatedAt)) {
      throw new Error('SelfRepairCycleV1 updatedAt cannot predate attempt evidence');
    }
  }

  return freezeDeep({
    schemaVersion: SELF_REPAIR_CYCLE_SCHEMA_VERSION,
    cycleId: id(raw.cycleId, 'SelfRepairCycleV1 cycleId'),
    subjectId: id(raw.subjectId, 'SelfRepairCycleV1 subjectId'),
    actorId,
    verifierId,
    verifierPlanRevisionId,
    baselineRevisionId,
    maxAttempts,
    createdAt,
    updatedAt,
    attempts: Object.freeze(attempts),
  });
}

export function assessSelfRepairCycleV1(input) {
  const cycle = normalizeSelfRepairCycleV1(input);
  const derived = deriveState(cycle.attempts, cycle.maxAttempts);
  const completedRetests = cycle.attempts.filter((attempt) => attempt.retest !== null).length;

  return freezeDeep({
    schemaVersion: SELF_REPAIR_CYCLE_SCHEMA_VERSION,
    cycleId: cycle.cycleId,
    subjectId: cycle.subjectId,
    baselineRevisionId: cycle.baselineRevisionId,
    currentRevisionId: derived.currentRevisionId,
    state: derived.state,
    activeAttemptNumber: derived.activeAttemptNumber,
    attemptsUsed: cycle.attempts.length,
    completedRetests,
    attemptsRemaining: cycle.maxAttempts - cycle.attempts.length,
    actorId: cycle.actorId,
    verifierId: cycle.verifierId,
    verifierPlanRevisionId: cycle.verifierPlanRevisionId,
    executionAuthorized: false,
    mutationAuthorized: false,
    verificationAuthorized: false,
    policyGranted: false,
    requiresCanonicalExecutor: true,
    requiresCanonicalPolicy: true,
    requiresIndependentVerifier: true,
    evidenceTrust: 'UNVERIFIED_INPUT',
    requiresCanonicalEvidenceResolution: true,
    completionAuthorized: false,
    retestPassed: derived.state === SelfRepairCycleState.VERIFIED,
  });
}
