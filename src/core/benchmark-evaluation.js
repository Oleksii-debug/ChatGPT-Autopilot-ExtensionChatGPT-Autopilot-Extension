import { normalizeArtifactRefV1 } from './universal-agent-contracts.js';

export const BENCHMARK_EVALUATION_SCHEMA_VERSION = 1;

export const BenchmarkAssertionOperator = Object.freeze({
  AT_LEAST: 'AT_LEAST',
  AT_MOST: 'AT_MOST',
  EQUAL: 'EQUAL',
});

export const BenchmarkCaseOutcome = Object.freeze({
  MEASURED: 'MEASURED',
  ERROR: 'ERROR',
});

export const BenchmarkEvaluationStatus = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
});

const OPERATORS = new Set(Object.values(BenchmarkAssertionOperator));
const OUTCOMES = new Set(Object.values(BenchmarkCaseOutcome));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_CASES = 500;
const MAX_ASSERTIONS_PER_CASE = 64;
const MAX_EVIDENCE_PER_CASE = 128;
const MAX_TRUSTED_EVIDENCE = MAX_CASES * MAX_EVIDENCE_PER_CASE;
const MAX_TEXT = 4_000;

const SUITE_KEYS = new Set([
  'schemaVersion', 'suiteId', 'suiteRevisionId', 'title', 'cases',
]);
const CASE_KEYS = new Set([
  'caseId', 'title', 'assertions',
]);
const ASSERTION_KEYS = new Set([
  'metricId', 'operator', 'threshold',
]);
const RUN_KEYS = new Set([
  'schemaVersion', 'runId', 'suiteId', 'suiteRevisionId',
  'subjectId', 'subjectRevisionId', 'startedAt', 'completedAt', 'results',
]);
const RESULT_KEYS = new Set([
  'caseId', 'outcome', 'metrics', 'evidenceArtifactIds', 'reasonCode',
]);
const SUBJECT_KEYS = new Set(['subjectId', 'subjectRevisionId']);
const EXECUTION_KEYS = new Set(['runId', 'producerInvocationId', 'startedAt', 'completedAt']);
const EVALUATION_REQUEST_KEYS = new Set([
  'suite', 'run', 'expectedSubject', 'trustedExecution', 'trustedEvidenceArtifacts',
]);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const normalized = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error(label + ' must not contain symbol fields');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + ' must contain enumerable own data properties only');
    }
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
  }
}

function denseArray(value, label, { min = 0, max } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(label + ' must be a bounded array');
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain array');
  }

  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key)) {
      throw new Error(label + ' must contain canonical own enumerable data indices only');
    }
    const index = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Number.isSafeInteger(index)
      || index < 0
      || index >= value.length
      || String(index) !== key
      || !descriptor
      || !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true) {
      throw new Error(label + ' must contain canonical own enumerable data indices only');
    }
  }

  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) throw new Error(label + ' must not be sparse');
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new Error(label + ' must contain canonical own enumerable data indices only');
    }
    normalized.push(descriptor.value);
  }
  return normalized;
}

function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > MAX_TEXT) {
    throw new Error(label + ' must be bounded canonical text');
  }
  return value;
}

function integer(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(label + ' must be a safe integer');
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

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function uniqueIds(values, label, { min = 0, max = MAX_EVIDENCE_PER_CASE } = {}) {
  const items = denseArray(values, label, { min, max });
  const normalized = items.map((value, index) => id(value, label + '[' + index + ']'));
  const seen = new Set();
  for (const value of normalized) {
    if (seen.has(value)) throw new Error(label + ' contains duplicate ID: ' + value);
    seen.add(value);
  }
  normalized.sort();
  return Object.freeze(normalized);
}

function normalizeTrustedEvidenceArtifacts(value) {
  const rawArtifacts = denseArray(
    value,
    'TrustedBenchmarkEvidenceV1 artifacts',
    { min: 1, max: MAX_TRUSTED_EVIDENCE },
  );
  const byId = new Map();
  for (let index = 0; index < rawArtifacts.length; index += 1) {
    const strict = record(
      rawArtifacts[index],
      'TrustedBenchmarkEvidenceV1 artifact[' + index + ']',
    );
    const artifact = normalizeArtifactRefV1(strict);
    if (!artifact.sha256) {
      throw new Error(
        'TrustedBenchmarkEvidenceV1 artifact ' + artifact.artifactId + ' must include sha256',
      );
    }
    if (byId.has(artifact.artifactId)) {
      throw new Error(
        'TrustedBenchmarkEvidenceV1 contains duplicate artifactId: ' + artifact.artifactId,
      );
    }
    byId.set(artifact.artifactId, artifact);
  }
  return byId;
}

function normalizeAssertion(input, label) {
  const raw = record(input, label);
  exactKeys(raw, ASSERTION_KEYS, label);
  const operator = raw.operator;
  if (typeof operator !== 'string' || !OPERATORS.has(operator)) {
    throw new Error(label + ' operator is invalid');
  }
  return freeze({
    metricId: id(raw.metricId, label + ' metricId'),
    operator,
    threshold: integer(raw.threshold, label + ' threshold'),
  });
}

function normalizeCase(input, index) {
  const label = 'BenchmarkCaseV1[' + index + ']';
  const raw = record(input, label);
  exactKeys(raw, CASE_KEYS, label);
  const assertions = denseArray(raw.assertions, label + ' assertions', {
    min: 1,
    max: MAX_ASSERTIONS_PER_CASE,
  }).map((item, assertionIndex) => normalizeAssertion(
    item,
    label + ' assertion[' + assertionIndex + ']',
  ));
  const metrics = new Set();
  for (const assertion of assertions) {
    if (metrics.has(assertion.metricId)) {
      throw new Error(label + ' contains duplicate metric assertion: ' + assertion.metricId);
    }
    metrics.add(assertion.metricId);
  }
  assertions.sort((a, b) => a.metricId < b.metricId ? -1 : a.metricId > b.metricId ? 1 : 0);
  return freeze({
    caseId: id(raw.caseId, label + ' caseId'),
    title: text(raw.title, label + ' title'),
    assertions: Object.freeze(assertions),
  });
}

export function normalizeBenchmarkSuiteV1(input) {
  const raw = record(input, 'BenchmarkSuiteV1');
  exactKeys(raw, SUITE_KEYS, 'BenchmarkSuiteV1');
  if (raw.schemaVersion !== BENCHMARK_EVALUATION_SCHEMA_VERSION) {
    throw new Error('Unsupported BenchmarkSuiteV1 schemaVersion');
  }
  const cases = denseArray(raw.cases, 'BenchmarkSuiteV1 cases', {
    min: 1,
    max: MAX_CASES,
  }).map(normalizeCase);
  const seen = new Set();
  for (const item of cases) {
    if (seen.has(item.caseId)) throw new Error('BenchmarkSuiteV1 contains duplicate caseId: ' + item.caseId);
    seen.add(item.caseId);
  }
  cases.sort((a, b) => a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0);
  return freeze({
    schemaVersion: BENCHMARK_EVALUATION_SCHEMA_VERSION,
    suiteId: id(raw.suiteId, 'BenchmarkSuiteV1 suiteId'),
    suiteRevisionId: id(raw.suiteRevisionId, 'BenchmarkSuiteV1 suiteRevisionId'),
    title: text(raw.title, 'BenchmarkSuiteV1 title'),
    cases: Object.freeze(cases),
  });
}

function normalizeMetrics(input, expectedMetricIds, label, { required }) {
  const raw = record(input, label);
  const names = Object.getOwnPropertyNames(raw);
  const expected = new Set(expectedMetricIds);

  for (const name of names) {
    if (!ID.test(name)) throw new Error(label + ' contains invalid metric ID: ' + name);
    if (!expected.has(name)) throw new Error(label + ' contains unknown metric: ' + name);
    integer(raw[name], label + ' ' + name);
  }
  if (required) {
    for (const name of expectedMetricIds) {
      if (!Object.hasOwn(raw, name)) throw new Error(label + ' is missing metric: ' + name);
    }
  } else if (names.length !== 0) {
    throw new Error(label + ' must be empty for ERROR outcome');
  }

  const entries = names
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    .map((name) => [name, raw[name]]);
  return freeze(Object.fromEntries(entries));
}

function normalizeCaseResult(input, suiteCase, trustedEvidenceById, trustedExecution) {
  const label = 'BenchmarkCaseResultV1 ' + suiteCase.caseId;
  const raw = record(input, label);
  exactKeys(raw, RESULT_KEYS, label);
  if (id(raw.caseId, label + ' caseId') !== suiteCase.caseId) {
    throw new Error(label + ' caseId mismatch');
  }
  const outcome = raw.outcome;
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
    throw new Error(label + ' outcome is invalid');
  }
  const metricIds = suiteCase.assertions.map((item) => item.metricId);
  const metrics = normalizeMetrics(
    raw.metrics,
    metricIds,
    label + ' metrics',
    { required: outcome === BenchmarkCaseOutcome.MEASURED },
  );
  const evidenceArtifactIds = uniqueIds(
    raw.evidenceArtifactIds,
    label + ' evidenceArtifactIds',
    { min: 1 },
  );
  for (const evidenceArtifactId of evidenceArtifactIds) {
    const artifact = trustedEvidenceById.get(evidenceArtifactId);
    if (!artifact) {
      throw new Error(
        label + ' references unknown trusted evidence artifact: ' + evidenceArtifactId,
      );
    }
    if (artifact.producerInvocationId !== trustedExecution.producerInvocationId) {
      throw new Error(
        label + ' evidence artifact producer does not match trusted benchmark execution: '
          + evidenceArtifactId,
      );
    }
    const artifactTime = Date.parse(artifact.createdAt);
    if (artifactTime < Date.parse(trustedExecution.startedAt)
      || artifactTime > Date.parse(trustedExecution.completedAt)) {
      throw new Error(
        label + ' evidence artifact is outside the trusted benchmark execution interval: '
          + evidenceArtifactId,
      );
    }
  }
  let reasonCode = '';
  if (outcome === BenchmarkCaseOutcome.ERROR) {
    reasonCode = id(raw.reasonCode, label + ' reasonCode');
  } else if (raw.reasonCode !== undefined && raw.reasonCode !== '') {
    throw new Error(label + ' reasonCode is only valid for ERROR outcome');
  }
  return freeze({
    caseId: suiteCase.caseId,
    outcome,
    metrics,
    evidenceArtifactIds,
    reasonCode,
  });
}

function assertionPasses(operator, observed, threshold) {
  if (operator === BenchmarkAssertionOperator.AT_LEAST) return observed >= threshold;
  if (operator === BenchmarkAssertionOperator.AT_MOST) return observed <= threshold;
  return observed === threshold;
}

export function evaluateBenchmarkRunV1(input = {}) {
  const request = record(input, 'EvaluateBenchmarkRunV1 request');
  exactKeys(request, EVALUATION_REQUEST_KEYS, 'EvaluateBenchmarkRunV1 request');
  const suite = request.suite;
  const run = request.run;
  const expectedSubject = request.expectedSubject;
  const trustedExecution = request.trustedExecution;
  const trustedEvidenceArtifacts = request.trustedEvidenceArtifacts;

  const normalizedSuite = normalizeBenchmarkSuiteV1(suite);
  const subject = record(expectedSubject, 'ExpectedBenchmarkSubjectV1');
  exactKeys(subject, SUBJECT_KEYS, 'ExpectedBenchmarkSubjectV1');
  const expectedSubjectId = id(subject.subjectId, 'ExpectedBenchmarkSubjectV1 subjectId');
  const expectedSubjectRevisionId = id(
    subject.subjectRevisionId,
    'ExpectedBenchmarkSubjectV1 subjectRevisionId',
  );

  const execution = record(trustedExecution, 'TrustedBenchmarkExecutionV1');
  exactKeys(execution, EXECUTION_KEYS, 'TrustedBenchmarkExecutionV1');
  const trustedRunId = id(execution.runId, 'TrustedBenchmarkExecutionV1 runId');
  const trustedProducerInvocationId = id(
    execution.producerInvocationId,
    'TrustedBenchmarkExecutionV1 producerInvocationId',
  );
  const trustedStartedAt = timestamp(
    execution.startedAt,
    'TrustedBenchmarkExecutionV1 startedAt',
  );
  const trustedCompletedAt = timestamp(
    execution.completedAt,
    'TrustedBenchmarkExecutionV1 completedAt',
  );
  if (Date.parse(trustedCompletedAt) < Date.parse(trustedStartedAt)) {
    throw new Error('TrustedBenchmarkExecutionV1 completedAt precedes startedAt');
  }
  const normalizedTrustedExecution = freeze({
    runId: trustedRunId,
    producerInvocationId: trustedProducerInvocationId,
    startedAt: trustedStartedAt,
    completedAt: trustedCompletedAt,
  });
  const trustedEvidenceById = normalizeTrustedEvidenceArtifacts(trustedEvidenceArtifacts);

  const rawRun = record(run, 'BenchmarkRunV1');
  exactKeys(rawRun, RUN_KEYS, 'BenchmarkRunV1');
  if (rawRun.schemaVersion !== BENCHMARK_EVALUATION_SCHEMA_VERSION) {
    throw new Error('Unsupported BenchmarkRunV1 schemaVersion');
  }

  const suiteId = id(rawRun.suiteId, 'BenchmarkRunV1 suiteId');
  const suiteRevisionId = id(rawRun.suiteRevisionId, 'BenchmarkRunV1 suiteRevisionId');
  if (suiteId !== normalizedSuite.suiteId || suiteRevisionId !== normalizedSuite.suiteRevisionId) {
    throw new Error('BenchmarkRunV1 suite identity/revision mismatch');
  }

  const subjectId = id(rawRun.subjectId, 'BenchmarkRunV1 subjectId');
  const subjectRevisionId = id(rawRun.subjectRevisionId, 'BenchmarkRunV1 subjectRevisionId');
  if (subjectId !== expectedSubjectId || subjectRevisionId !== expectedSubjectRevisionId) {
    throw new Error('BenchmarkRunV1 subject identity/revision mismatch');
  }

  const runId = id(rawRun.runId, 'BenchmarkRunV1 runId');
  const startedAt = timestamp(rawRun.startedAt, 'BenchmarkRunV1 startedAt');
  const completedAt = timestamp(rawRun.completedAt, 'BenchmarkRunV1 completedAt');
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error('BenchmarkRunV1 completedAt precedes startedAt');
  }
  if (runId !== normalizedTrustedExecution.runId
    || startedAt !== normalizedTrustedExecution.startedAt
    || completedAt !== normalizedTrustedExecution.completedAt) {
    throw new Error('BenchmarkRunV1 execution identity/time does not match trusted execution');
  }

  const rawResults = denseArray(rawRun.results, 'BenchmarkRunV1 results', {
    min: normalizedSuite.cases.length,
    max: normalizedSuite.cases.length,
  });
  const byCase = new Map();
  for (let index = 0; index < rawResults.length; index += 1) {
    const raw = record(rawResults[index], 'BenchmarkRunV1 result[' + index + ']');
    const caseId = id(raw.caseId, 'BenchmarkRunV1 result[' + index + '] caseId');
    if (byCase.has(caseId)) throw new Error('BenchmarkRunV1 contains duplicate case result: ' + caseId);
    byCase.set(caseId, raw);
  }

  const suiteCaseIds = new Set(normalizedSuite.cases.map((item) => item.caseId));
  for (const caseId of byCase.keys()) {
    if (!suiteCaseIds.has(caseId)) throw new Error('BenchmarkRunV1 contains unknown case result: ' + caseId);
  }
  for (const suiteCase of normalizedSuite.cases) {
    if (!byCase.has(suiteCase.caseId)) {
      throw new Error('BenchmarkRunV1 is missing case result: ' + suiteCase.caseId);
    }
  }

  const evaluatedResults = [];
  let passedCaseCount = 0;

  for (const suiteCase of normalizedSuite.cases) {
    const result = normalizeCaseResult(
      byCase.get(suiteCase.caseId),
      suiteCase,
      trustedEvidenceById,
      normalizedTrustedExecution,
    );
    const assertionResults = [];

    if (result.outcome === BenchmarkCaseOutcome.MEASURED) {
      for (const assertion of suiteCase.assertions) {
        const observed = result.metrics[assertion.metricId];
        const passed = assertionPasses(assertion.operator, observed, assertion.threshold);
        assertionResults.push(freeze({
          metricId: assertion.metricId,
          operator: assertion.operator,
          threshold: assertion.threshold,
          observed,
          passed,
        }));
      }
    }

    const passed = result.outcome === BenchmarkCaseOutcome.MEASURED
      && assertionResults.every((item) => item.passed);
    if (passed) passedCaseCount += 1;

    evaluatedResults.push(freeze({
      caseId: result.caseId,
      outcome: result.outcome,
      passed,
      reasonCode: result.reasonCode,
      metrics: result.metrics,
      evidenceArtifactIds: result.evidenceArtifactIds,
      assertionResults: Object.freeze(assertionResults),
    }));
  }

  const caseCount = evaluatedResults.length;
  const failedCaseCount = caseCount - passedCaseCount;
  return freeze({
    schemaVersion: BENCHMARK_EVALUATION_SCHEMA_VERSION,
    runId,
    suiteId: normalizedSuite.suiteId,
    suiteRevisionId: normalizedSuite.suiteRevisionId,
    subjectId,
    subjectRevisionId,
    startedAt,
    completedAt,
    status: failedCaseCount === 0
      ? BenchmarkEvaluationStatus.PASS
      : BenchmarkEvaluationStatus.FAIL,
    caseCount,
    passedCaseCount,
    failedCaseCount,
    results: Object.freeze(evaluatedResults),
  });
}
