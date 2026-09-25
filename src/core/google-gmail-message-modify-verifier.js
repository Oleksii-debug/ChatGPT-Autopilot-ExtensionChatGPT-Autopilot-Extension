import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import { GOOGLE_WORKSPACE_PROVIDER_ID, GoogleWorkspaceToolId } from './google-workspace-agent-provider.js';

const RESOURCE_ID = /^[A-Za-z0-9_-]{1,512}$/u;
const VERIFIER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const USER = /^[^\s/@\u0000-\u001f\u007f]+@[^\s/@\u0000-\u001f\u007f]+\.[^\s/@\u0000-\u001f\u007f]+$/u;
const INVOCATION_KEYS = new Set([
  'schemaVersion', 'invocationId', 'toolId', 'providerId', 'requestedCapabilityIds',
  'policyDecisionId', 'arguments', 'createdAt', 'parentInvocationId',
]);
const OBSERVATION_KEYS = new Set([
  'schemaVersion', 'observationId', 'invocationId', 'status', 'summary', 'data',
  'artifactRefs', 'observedAt',
]);
const RESULT_KEYS = new Set([
  'userId', 'messageId', 'threadId', 'labelIds', 'historyId', 'internalDate', 'sizeEstimate',
]);
const READBACK_KEYS = new Set([
  'id', 'threadId', 'labelIds', 'snippet', 'historyId', 'internalDate', 'payload', 'sizeEstimate',
]);

function exactDataRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${label} must be a plain object`);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`${label} contains unknown field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}.${String(key)} must be an enumerable data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error(`${label} is required`);
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new Error(`${label}.${method} must be a data method`);
      }
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  throw new Error(`${label}.${method} is required`);
}

function requireVerifierId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !VERIFIER_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireResourceId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !RESOURCE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireUser(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 320 || !USER.test(value)) {
    throw new Error('Gmail message modify requires exact userId');
  }
  return value;
}

function exactIds(value, label, max = 100) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must be a bounded plain array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) throw new Error(`${label} is invalid`);
  const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expectedKeys.size || keys.some(key => typeof key !== 'string' || !expectedKeys.has(key))) {
    throw new Error(`${label} must be a dense canonical array`);
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
    out.push(requireResourceId(descriptor.value, `${label}[${index}]`));
  }
  if (new Set(out).size !== out.length) throw new Error(`${label} contains duplicates`);
  return Object.freeze(out);
}

function attemptFromExecutionId(value, invocationId) {
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('executionId does not contain a valid attempt');
  const match = /^(.*):attempt:(\d+)$/u.exec(value);
  const attempt = match ? Number(match[2]) : 0;
  if (!match || match[1] !== invocationId || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 64) {
    throw new Error('executionId does not contain a valid attempt');
  }
  return attempt;
}

function snapshotInvocation(invocation) {
  const raw = exactDataRecord(invocation, INVOCATION_KEYS, 'Gmail message modify invocation');
  if (raw.schemaVersion !== 1
      || raw.toolId !== GoogleWorkspaceToolId.GMAIL_MESSAGE_MODIFY
      || raw.providerId !== GOOGLE_WORKSPACE_PROVIDER_ID) {
    throw new Error('Gmail message modify verifier accepts only canonical message-modify invocations');
  }
  const invocationId = requireVerifierId(raw.invocationId, 'invocationId');
  const policyDecisionId = requireVerifierId(raw.policyDecisionId, 'policyDecisionId');
  const args = exactDataRecord(
    raw.arguments,
    new Set(['userId', 'messageId', 'addLabelIds', 'removeLabelIds']),
    'Gmail message modify arguments',
  );
  const userId = requireUser(args.userId);
  const messageId = requireResourceId(args.messageId, 'messageId');
  const addLabelIds = args.addLabelIds == null ? Object.freeze([]) : exactIds(args.addLabelIds, 'addLabelIds');
  const removeLabelIds = args.removeLabelIds == null ? Object.freeze([]) : exactIds(args.removeLabelIds, 'removeLabelIds');
  if (!addLabelIds.length && !removeLabelIds.length) throw new Error('Gmail message modify requires at least one label change');
  const removeSet = new Set(removeLabelIds);
  if (addLabelIds.some(label => removeSet.has(label))) throw new Error('Gmail message modify cannot add and remove the same label');
  return Object.freeze({
    invocationId,
    policyDecisionId,
    expected: Object.freeze({ userId, messageId, addLabelIds, removeLabelIds }),
  });
}

function labelsMatch(labelIds, expected) {
  const labels = new Set(labelIds);
  return expected.addLabelIds.every(label => labels.has(label))
    && expected.removeLabelIds.every(label => !labels.has(label));
}

function snapshotObservation(observation, safeInvocation) {
  const raw = exactDataRecord(observation, OBSERVATION_KEYS, 'Gmail message modify observation');
  if (raw.schemaVersion !== 1) throw new Error('Gmail message modify verifier requires canonical observation');
  const observationId = requireVerifierId(raw.observationId, 'observationId');
  if (requireVerifierId(raw.invocationId, 'observation.invocationId') !== safeInvocation.invocationId) {
    throw new Error('Gmail message modify observation invocation identity mismatch');
  }
  const data = exactDataRecord(raw.data, RESULT_KEYS, 'Gmail message modify observation data');
  if (requireUser(data.userId) !== safeInvocation.expected.userId
      || requireResourceId(data.messageId, 'observation.messageId') !== safeInvocation.expected.messageId) {
    throw new Error('Gmail message modify observation target identity mismatch');
  }
  const labels = exactIds(data.labelIds ?? [], 'observation.labelIds', 256);
  if (!labelsMatch(labels, safeInvocation.expected)) {
    throw new Error('Gmail message modify observation does not contain the requested label state');
  }
  return Object.freeze({ observationId });
}

function snapshotReadback(value, expected) {
  const raw = exactDataRecord(value, READBACK_KEYS, 'Gmail message modify readback');
  const messageId = requireResourceId(raw.id, 'Gmail readback message id');
  if (messageId !== expected.messageId) throw new Error('Gmail message modify readback identity mismatch');
  const threadId = requireResourceId(raw.threadId, 'Gmail readback threadId');
  const labelIds = exactIds(raw.labelIds ?? [], 'Gmail readback labelIds', 256);
  return Object.freeze({
    messageId,
    threadId,
    labelIds,
    matches: labelsMatch(labelIds, expected),
  });
}

export class GmailMessageModifyVerifierV1 {
  constructor({ workspaceClient, verifierId = 'google-gmail-message-modify-readback-verifier', now = () => Date.now() } = {}) {
    this.getGmailMessage = bindDataMethod(workspaceClient, 'getGmailMessage', 'workspaceClient');
    this.verifierId = requireVerifierId(verifierId, 'verifierId');
    if (this.verifierId === GOOGLE_WORKSPACE_PROVIDER_ID) {
      throw new Error('Gmail message modify verifier identity must differ from effect provider identity');
    }
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(expected) {
    const message = snapshotReadback(await this.getGmailMessage({
      userId: expected.userId,
      messageId: expected.messageId,
      format: 'METADATA',
      metadataHeaders: [],
    }), expected);
    return message;
  }

  #verification(safeInvocation, readback, executionId, attempt, observationId, suffix = '') {
    return {
      schemaVersion: 1,
      verificationId: `${safeInvocation.invocationId}:gmail-message-modify-verification${suffix}:${attempt}`,
      invocationId: safeInvocation.invocationId,
      observationId,
      status: readback.matches ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.matches ? 'GMAIL_MESSAGE_LABEL_STATE_MATCHED' : 'GMAIL_MESSAGE_LABEL_STATE_DIVERGED',
      summary: readback.matches
        ? 'Fresh independent Gmail readback matched the requested message label state.'
        : 'Fresh independent Gmail readback did not match the requested message label state.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: safeInvocation.policyDecisionId,
      effectId: safeInvocation.invocationId,
      executionId,
      attempt,
    };
  }

  async verify({ invocation, executionId, observation } = {}) {
    const safeInvocation = snapshotInvocation(invocation);
    const attempt = attemptFromExecutionId(executionId, safeInvocation.invocationId);
    const safeObservation = snapshotObservation(observation, safeInvocation);
    const readback = await this.#readback(safeInvocation.expected);
    return this.#verification(safeInvocation, readback, executionId, attempt, safeObservation.observationId);
  }

  async reconcileVerify({
    invocation, effectId, executionId, attempt, policyDecisionId, expectedOutcome,
  } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('Gmail message modify cannot prove SAFE_RETRY from a negative readback after an uncertain mutation dispatch');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED) {
      throw new Error('Gmail message modify reconciliation supports only independently verified committed state');
    }
    const safeInvocation = snapshotInvocation(invocation);
    if (requireVerifierId(effectId, 'effectId') !== safeInvocation.invocationId) throw new Error('effectId is invalid');
    if (requireVerifierId(policyDecisionId, 'policyDecisionId') !== safeInvocation.policyDecisionId) throw new Error('policyDecisionId is invalid');
    const exactAttempt = attemptFromExecutionId(executionId, safeInvocation.invocationId);
    if (attempt !== exactAttempt) throw new Error('attempt does not match executionId');

    const readback = await this.#readback(safeInvocation.expected);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: `${safeInvocation.invocationId}:gmail-message-modify-readback:reconcile-${attempt}`,
      invocationId: safeInvocation.invocationId,
      status: 'OK',
      summary: 'Fresh Gmail readback classified the requested message label state.',
      data: {
        committed: readback.matches,
        userId: safeInvocation.expected.userId,
        messageId: readback.messageId,
        threadId: readback.threadId,
        labelIds: [...readback.labelIds],
      },
      artifactRefs: [],
      observedAt,
    };
    const verification = this.#verification(
      safeInvocation,
      readback,
      executionId,
      attempt,
      observation.observationId,
      ':reconcile',
    );
    return {
      verifierId: this.verifierId,
      verificationAuthorityId: safeInvocation.policyDecisionId,
      effectId: safeInvocation.invocationId,
      executionId,
      attempt,
      observation,
      verification,
    };
  }
}
