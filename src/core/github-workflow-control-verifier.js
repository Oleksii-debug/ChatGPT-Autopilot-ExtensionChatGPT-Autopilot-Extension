import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GITHUB_PROVIDER_ID, GitHubToolId } from './github-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA = /^[a-f0-9]{40,64}$/u;
const READBACK_KEYS = new Set([
  'repositoryFullName', 'id', 'workflowId', 'runNumber', 'runAttempt', 'event',
  'status', 'conclusion', 'headBranch', 'headSha', 'createdAt', 'updatedAt', 'url',
]);
const OBSERVATION_DATA_KEYS = new Set([
  'operation', 'repositoryFullName', 'runId', 'workflowId', 'runNumber', 'headSha',
  'event', 'previousRunAttempt', 'previousStatus', 'previousConclusion', 'previousUpdatedAt',
]);

function record(value, label, allowed = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be a plain object');
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(label + ' must be a plain object');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || (allowed && !allowed.has(key))) throw new Error(label + ' contains unknown field');
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}
function id(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(label + ' is invalid');
  return value;
}
function repository(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 300 || !REPOSITORY.test(value) || value.includes('..')) {
    throw new Error('repositoryFullName is invalid');
  }
  return value;
}
function positiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(label + ' is invalid');
  return value;
}
function sha(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !SHA.test(value)) throw new Error(label + ' is invalid');
  return value;
}
function boundedText(value, label, max = 1000) {
  if (typeof value !== 'string' || value.length > max) throw new Error(label + ' is invalid');
  return value;
}
function timestampMillis(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error(label + ' is invalid');
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(label + ' is invalid');
  return millis;
}
function attemptFromExecutionId(value) {
  const match = typeof value === 'string' && value === value.trim() ? /:attempt:(\d+)$/u.exec(value) : null;
  const attempt = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('executionId does not contain a valid attempt');
  return attempt;
}
function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error(label + ' is required');
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new Error(label + '.' + method + ' must be a data method');
      }
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new Error(label + '.' + method + ' is required');
}
function operationForTool(toolId) {
  if (toolId === GitHubToolId.WORKFLOW_RUN_RERUN) return 'RERUN';
  if (toolId === GitHubToolId.WORKFLOW_RUN_CANCEL) return 'CANCEL';
  throw new Error('GitHub workflow control verifier accepts only rerun/cancel invocations');
}
function expectedMutation(invocation) {
  const admitted = record(invocation, 'GitHub workflow-control invocation');
  if (admitted.providerId !== GITHUB_PROVIDER_ID) throw new Error('GitHub workflow control provider identity mismatch');
  const operation = operationForTool(admitted.toolId);
  const args = record(
    admitted.arguments,
    'GitHub workflow-control arguments',
    new Set(['repositoryFullName', 'runId', 'expectedWorkflowId', 'expectedRunAttempt', 'expectedHeadSha']),
  );
  timestampMillis(admitted.createdAt, 'invocation.createdAt');
  return Object.freeze({
    invocationId: id(admitted.invocationId, 'invocationId'),
    policyDecisionId: id(admitted.policyDecisionId, 'policyDecisionId'),
    operation,
    repositoryFullName: repository(args.repositoryFullName),
    runId: positiveInteger(args.runId, 'runId'),
    workflowId: positiveInteger(args.expectedWorkflowId, 'expectedWorkflowId'),
    previousRunAttempt: positiveInteger(args.expectedRunAttempt, 'expectedRunAttempt'),
    headSha: sha(args.expectedHeadSha, 'expectedHeadSha'),
    createdAt: admitted.createdAt,
  });
}
function observedMutation(expected, observation) {
  const observed = record(observation, 'GitHub workflow-control observation');
  if (id(observed.invocationId, 'observation.invocationId') !== expected.invocationId) throw new Error('GitHub workflow control observation invocation identity mismatch');
  if (observed.status !== 'OK') throw new Error('GitHub workflow control observation status is not OK');
  if (timestampMillis(observed.observedAt, 'observation.observedAt') < timestampMillis(expected.createdAt, 'invocation.createdAt')) {
    throw new Error('GitHub workflow control observation predates invocation');
  }
  const data = record(observed.data, 'GitHub workflow-control observation data', OBSERVATION_DATA_KEYS);
  if (data.operation !== expected.operation
      || data.repositoryFullName !== expected.repositoryFullName
      || positiveInteger(data.runId, 'observed runId') !== expected.runId
      || positiveInteger(data.workflowId, 'observed workflowId') !== expected.workflowId
      || positiveInteger(data.previousRunAttempt, 'observed previousRunAttempt') !== expected.previousRunAttempt
      || sha(data.headSha, 'observed headSha') !== expected.headSha) {
    throw new Error('GitHub workflow control observation request identity mismatch');
  }
  timestampMillis(data.previousUpdatedAt, 'observed previousUpdatedAt');
  return Object.freeze({
    ...expected,
    observationId: id(observed.observationId, 'observationId'),
    observedAt: observed.observedAt,
    runNumber: positiveInteger(data.runNumber, 'observed runNumber'),
    event: boundedText(data.event, 'observed event', 120),
    previousStatus: boundedText(data.previousStatus, 'observed previousStatus', 80),
    previousConclusion: boundedText(data.previousConclusion, 'observed previousConclusion', 80),
    previousUpdatedAt: data.previousUpdatedAt,
  });
}

export class GitHubWorkflowRunControlVerifierV1 {
  constructor({ githubClient, verifierId = 'github-workflow-run-control-readback-verifier', now = () => Date.now() } = {}) {
    this.readWorkflowRun = bindDataMethod(githubClient, 'readWorkflowRun', 'GitHub workflow control readback client');
    this.verifierId = id(verifierId, 'verifierId');
    if (this.verifierId === GITHUB_PROVIDER_ID) throw new Error('GitHub workflow control verifier identity must differ from provider identity');
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async readback(identity) {
    const run = record(
      await this.readWorkflowRun({ repositoryFullName: identity.repositoryFullName, runId: identity.runId }),
      'GitHub workflow control readback',
      READBACK_KEYS,
    );
    const commonIdentity = run.repositoryFullName === identity.repositoryFullName
      && positiveInteger(run.id, 'readback run id') === identity.runId
      && positiveInteger(run.workflowId, 'readback workflow id') === identity.workflowId
      && positiveInteger(run.runNumber, 'readback run number') === identity.runNumber
      && sha(run.headSha, 'readback headSha') === identity.headSha
      && boundedText(run.event, 'readback event', 120) === identity.event
      && timestampMillis(run.updatedAt, 'readback updatedAt') >= timestampMillis(identity.previousUpdatedAt, 'previousUpdatedAt');

    let matches = false;
    if (commonIdentity && identity.operation === 'RERUN') {
      const expectedAttempt = identity.previousRunAttempt + 1;
      matches = Number.isSafeInteger(expectedAttempt)
        && identity.previousStatus === 'completed'
        && positiveInteger(run.runAttempt, 'readback run attempt') === expectedAttempt;
    } else if (commonIdentity && identity.operation === 'CANCEL') {
      matches = identity.previousStatus !== 'completed'
        && positiveInteger(run.runAttempt, 'readback run attempt') === identity.previousRunAttempt
        && run.status === 'completed'
        && run.conclusion === 'cancelled';
    }
    return Object.freeze({ identity, matches, run });
  }

  verification(readback, executionId, attempt, observationId, suffix = '') {
    const verified = readback.matches;
    return {
      schemaVersion: 1,
      verificationId: readback.identity.invocationId + ':github-workflow-control-verification' + suffix + ':' + attempt,
      invocationId: readback.identity.invocationId,
      observationId,
      status: verified ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: verified ? 'GITHUB_WORKFLOW_CONTROL_CONFIRMED' : 'GITHUB_WORKFLOW_CONTROL_NOT_CONFIRMED',
      summary: verified
        ? 'Fresh independent GitHub Actions readback confirmed the exact ' + readback.identity.operation + ' effect on the bound workflow run.'
        : 'Fresh independent GitHub Actions readback did not yet confirm the exact ' + readback.identity.operation + ' effect; replay is not authorized.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: readback.identity.policyDecisionId,
      effectId: readback.identity.invocationId,
      executionId,
      attempt,
    };
  }

  async verify({ invocation, executionId, observation } = {}) {
    const attempt = attemptFromExecutionId(executionId);
    const expected = expectedMutation(invocation);
    const identity = observedMutation(expected, observation);
    const readback = await this.readback(identity);
    return this.verification(readback, executionId, attempt, identity.observationId);
  }

  async reconcileVerify({ invocation, effectId, executionId, attempt, policyDecisionId, expectedOutcome, priorObservation } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) throw new Error('GitHub workflow control cannot prove SAFE_RETRY after an admitted control attempt');
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED) throw new Error('GitHub workflow control reconciliation supports only VERIFIED or manual review');
    const expected = expectedMutation(invocation);
    if (id(effectId, 'effectId') !== expected.invocationId) throw new Error('effectId is invalid');
    if (id(policyDecisionId, 'policyDecisionId') !== expected.policyDecisionId) throw new Error('policyDecisionId is invalid');
    const exactAttempt = attemptFromExecutionId(executionId);
    if (attempt !== exactAttempt) throw new Error('attempt does not match executionId');
    if (!priorObservation) throw new Error('GitHub workflow control requires provider-issued preflight identity for automatic reconciliation; otherwise manual review is required');
    const identity = observedMutation(expected, priorObservation);
    const readback = await this.readback(identity);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: expected.invocationId + ':github-workflow-control-readback:reconcile-' + attempt,
      invocationId: expected.invocationId,
      status: 'OK',
      summary: 'Fresh GitHub Actions readback classified the provider-issued workflow-control identity.',
      data: {
        committed: readback.matches,
        operation: expected.operation,
        repositoryFullName: expected.repositoryFullName,
        runId: expected.runId,
        runAttempt: readback.run.runAttempt,
        status: readback.run.status,
        conclusion: readback.run.conclusion,
      },
      artifactRefs: [],
      observedAt,
    };
    const verification = this.verification(readback, executionId, attempt, observation.observationId, ':reconcile');
    return { verifierId: this.verifierId, verificationAuthorityId: policyDecisionId, effectId, executionId, attempt, observation, verification };
  }
}
