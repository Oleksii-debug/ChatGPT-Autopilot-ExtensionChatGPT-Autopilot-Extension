import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GITHUB_PROVIDER_ID, GitHubToolId } from './github-agent-provider.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REF = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\.lock(?:\/|$))[A-Za-z0-9._\/-]{1,240}$/u;
const INPUT_KEY = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_INPUTS = 25;
const MAX_INPUT_JSON_BYTES = 65_535;

function requireId(value, label) { if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) throw new Error(label + ' is invalid'); return value; }
function record(value, label, allowed = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be a plain object');
  const proto = Object.getPrototypeOf(value); const descriptors = Object.getOwnPropertyDescriptors(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' must be a plain object');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || (allowed && !allowed.has(key))) throw new Error(label + ' contains unknown field');
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(label + '.' + String(key) + ' must be an enumerable data property');
    out[key] = descriptor.value;
  }
  return out;
}
function repository(value) { if (typeof value !== 'string' || value !== value.trim() || value.length > 300 || !REPOSITORY.test(value) || value.includes('..')) throw new Error('repositoryFullName is invalid'); return value; }
function positiveInteger(value, label) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(label + ' is invalid'); return value; }
function timestampMillis(value, label) { if (typeof value !== 'string' || value !== value.trim() || !value) throw new Error(label + ' is invalid'); const millis = Date.parse(value); if (!Number.isFinite(millis)) throw new Error(label + ' is invalid'); return millis; }
function exactRef(value, label) { if (typeof value !== 'string' || value !== value.trim() || !REF.test(value) || value.endsWith('/') || value.startsWith('.') || value.includes('//')) throw new Error(label + ' is invalid'); return value; }
function inputs(value) {
  if (value == null) return Object.freeze(Object.create(null));
  const raw = record(value, 'inputs'); const keys = Object.keys(raw);
  if (keys.length > MAX_INPUTS) throw new Error('inputs exceeds the maximum of 25 workflow inputs');
  const out = Object.create(null);
  for (const key of keys.sort()) {
    if (!INPUT_KEY.test(key)) throw new Error('inputs contains an invalid workflow input key');
    const item = raw[key];
    if (typeof item === 'string') { if (item.length > MAX_INPUT_JSON_BYTES) throw new Error('inputs.' + key + ' is too large'); out[key] = item; }
    else if (typeof item === 'boolean') out[key] = item;
    else if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) out[key] = item;
    else throw new Error('inputs.' + key + ' must be a canonical string, boolean, or finite number');
  }
  if (new TextEncoder().encode(JSON.stringify(out)).byteLength > MAX_INPUT_JSON_BYTES) throw new Error('inputs serialized payload is too large');
  return Object.freeze(out);
}
function canonicalInputs(value) { return JSON.stringify(inputs(value)); }
function attemptFromExecutionId(value) { const match = typeof value === 'string' && value === value.trim() ? /:attempt:(\d+)$/u.exec(value) : null; const attempt = match ? Number(match[1]) : 0; if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 64) throw new Error('executionId does not contain a valid attempt'); return attempt; }
function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error(label + ' is required');
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) { const descriptor = Object.getOwnPropertyDescriptor(current, method); if (descriptor) { if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') throw new Error(label + '.' + method + ' must be a data method'); return descriptor.value.bind(target); } current = Object.getPrototypeOf(current); }
  throw new Error(label + '.' + method + ' is required');
}
function expectedMutation(invocation) {
  const admitted = record(invocation, 'GitHub workflow-dispatch invocation');
  if (admitted.providerId !== GITHUB_PROVIDER_ID || admitted.toolId !== GitHubToolId.WORKFLOW_DISPATCH) throw new Error('GitHub workflow dispatch verifier accepts only canonical workflow-dispatch invocations');
  const args = record(admitted.arguments, 'GitHub workflow-dispatch arguments', new Set(['repositoryFullName', 'workflowId', 'ref', 'inputs']));
  const createdAt = admitted.createdAt;
  timestampMillis(createdAt, 'invocation.createdAt');
  return Object.freeze({ invocationId: requireId(admitted.invocationId, 'invocationId'), policyDecisionId: requireId(admitted.policyDecisionId, 'policyDecisionId'), repositoryFullName: repository(args.repositoryFullName), workflowId: positiveInteger(args.workflowId, 'workflowId'), ref: exactRef(args.ref, 'ref'), inputs: inputs(args.inputs), createdAt });
}
function observedMutation(expected, observation) {
  const observed = record(observation, 'GitHub workflow-dispatch observation');
  if (requireId(observed.invocationId, 'observation.invocationId') !== expected.invocationId) throw new Error('GitHub workflow dispatch observation invocation identity mismatch');
  if (observed.status !== 'OK') throw new Error('GitHub workflow dispatch observation status is not OK');
  const observedAt = observed.observedAt;
  const observedAtMs = timestampMillis(observedAt, 'observation.observedAt');
  if (observedAtMs < timestampMillis(expected.createdAt, 'invocation.createdAt')) throw new Error('GitHub workflow dispatch observation predates invocation');
  const data = record(observed.data, 'GitHub workflow-dispatch observation data', new Set(['repositoryFullName', 'workflowId', 'ref', 'inputs', 'runId', 'runUrl', 'htmlUrl']));
  if (data.repositoryFullName !== expected.repositoryFullName || positiveInteger(data.workflowId, 'observed workflowId') !== expected.workflowId || exactRef(data.ref, 'observed ref') !== expected.ref || canonicalInputs(data.inputs) !== canonicalInputs(expected.inputs)) throw new Error('GitHub workflow dispatch observation request identity mismatch');
  return Object.freeze({ ...expected, observationId: requireId(observed.observationId, 'observationId'), observedAt, runId: positiveInteger(data.runId, 'observed runId') });
}

export class GitHubWorkflowDispatchVerifierV1 {
  constructor({ githubClient, verifierId = 'github-workflow-dispatch-readback-verifier', now = () => Date.now() } = {}) { this.readWorkflowRun = bindDataMethod(githubClient, 'readWorkflowRun', 'GitHub workflow readback client'); this.verifierId = requireId(verifierId, 'verifierId'); if (this.verifierId === GITHUB_PROVIDER_ID) throw new Error('GitHub workflow dispatch verifier identity must differ from provider identity'); if (typeof now !== 'function') throw new Error('now must be a function'); this.now = now; }
  async readback(identity) {
    const run = record(await this.readWorkflowRun({ repositoryFullName: identity.repositoryFullName, runId: identity.runId }), 'GitHub workflow dispatch readback', new Set(['repositoryFullName', 'id', 'workflowId', 'runNumber', 'runAttempt', 'event', 'status', 'conclusion', 'headBranch', 'headSha', 'createdAt', 'updatedAt', 'url']));
    const runCreatedAtMs = timestampMillis(run.createdAt, 'readback createdAt');
    const runUpdatedAtMs = timestampMillis(run.updatedAt, 'readback updatedAt');
    const invocationCreatedAtMs = timestampMillis(identity.createdAt, 'invocation.createdAt');
    const observationObservedAtMs = timestampMillis(identity.observedAt, 'observation.observedAt');
    const chronologyMatches = invocationCreatedAtMs <= runCreatedAtMs
      && runCreatedAtMs <= observationObservedAtMs
      && runCreatedAtMs <= runUpdatedAtMs;
    const matches = run.repositoryFullName === identity.repositoryFullName
      && positiveInteger(run.id, 'readback run id') === identity.runId
      && positiveInteger(run.workflowId, 'readback workflow id') === identity.workflowId
      && run.event === 'workflow_dispatch'
      && run.headBranch === identity.ref
      && chronologyMatches;
    return Object.freeze({ identity, matches, run });
  }
  verification(readback, executionId, attempt, observationId, suffix = '') { const verified = readback.matches; return { schemaVersion: 1, verificationId: readback.identity.invocationId + ':github-workflow-dispatch-verification' + suffix + ':' + attempt, invocationId: readback.identity.invocationId, observationId, status: verified ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS, reasonCode: verified ? 'GITHUB_WORKFLOW_DISPATCH_RUN_CONFIRMED' : 'GITHUB_WORKFLOW_DISPATCH_RUN_NOT_CONFIRMED', summary: verified ? 'Fresh independent GitHub Actions readback confirmed the exact workflow/ref run identity returned by dispatch.' : 'Fresh independent GitHub Actions readback did not confirm the exact workflow/ref run identity.', evidenceArtifactIds: [], verifiedAt: new Date(this.now()).toISOString(), verifierId: this.verifierId, verificationAuthorityId: readback.identity.policyDecisionId, effectId: readback.identity.invocationId, executionId, attempt }; }
  async verify({ invocation, executionId, observation } = {}) { const attempt = attemptFromExecutionId(executionId); const expected = expectedMutation(invocation); const identity = observedMutation(expected, observation); const readback = await this.readback(identity); return this.verification(readback, executionId, attempt, identity.observationId); }
  async reconcileVerify({ invocation, effectId, executionId, attempt, policyDecisionId, expectedOutcome, priorObservation } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) throw new Error('GitHub workflow dispatch cannot prove SAFE_RETRY after dispatch');
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED) throw new Error('GitHub workflow dispatch reconciliation supports only VERIFIED or manual review');
    const expected = expectedMutation(invocation);
    if (requireId(effectId, 'effectId') !== expected.invocationId) throw new Error('effectId is invalid');
    if (requireId(policyDecisionId, 'policyDecisionId') !== expected.policyDecisionId) throw new Error('policyDecisionId is invalid');
    const exactAttempt = attemptFromExecutionId(executionId); if (attempt !== exactAttempt) throw new Error('attempt does not match executionId');
    if (!priorObservation) throw new Error('GitHub workflow dispatch requires provider-issued workflow run identity for automatic reconciliation; otherwise manual review is required');
    const identity = observedMutation(expected, priorObservation); const readback = await this.readback(identity); const observedAt = new Date(this.now()).toISOString();
    const observation = { schemaVersion: 1, observationId: expected.invocationId + ':github-workflow-dispatch-readback:reconcile-' + attempt, invocationId: expected.invocationId, status: 'OK', summary: 'Fresh GitHub Actions readback classified the provider-issued workflow run identity.', data: { committed: readback.matches, repositoryFullName: expected.repositoryFullName, workflowId: expected.workflowId, ref: expected.ref, runId: identity.runId }, artifactRefs: [], observedAt };
    const verification = this.verification(readback, executionId, attempt, observation.observationId, ':reconcile');
    return { verifierId: this.verifierId, verificationAuthorityId: policyDecisionId, effectId, executionId, attempt, observation, verification };
  }
}
