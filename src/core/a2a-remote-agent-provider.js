import {
  assessA2ADelegationV1,
  normalizeA2ADelegationRequestV1,
  normalizeA2ARemoteAdmissionRefV1,
} from './a2a-interop-contract.js';
import {
  PolicyDecisionKind,
  normalizePolicyDecisionV1,
} from './universal-agent-contracts.js';

export const A2A_REMOTE_AGENT_PROVIDER_VERSION = 1;
export const A2A_JSONRPC_METHOD_SEND_MESSAGE = 'SendMessage';

const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4096;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120000;

const EXECUTE_KEYS = new Set([
  'card',
  'admission',
  'delegation',
  'policyDecision',
  'messageText',
  'timeoutMs',
]);

const RESPONSE_KEYS = new Set(['status', 'contentType', 'body']);
const JSONRPC_RESPONSE_KEYS = new Set(['jsonrpc', 'id', 'result', 'error']);

function fail(code, message, {
  effectMayHaveOccurred = false,
  safeToRetry = false,
  cause = null,
  remoteError = null,
} = {}) {
  const error = new Error(message);
  error.code = code;
  error.effectMayHaveOccurred = effectMayHaveOccurred === true;
  error.safeToRetry = error.effectMayHaveOccurred ? false : safeToRetry === true;
  if (cause) error.cause = cause;
  if (remoteError) error.remoteError = remoteError;
  throw error;
}

function dataRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('A2A_PROVIDER_INPUT_INVALID', `${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('A2A_PROVIDER_INPUT_INVALID', `${label} must be a plain data object`);
  }
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail('A2A_PROVIDER_INPUT_INVALID', `${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('A2A_PROVIDER_INPUT_INVALID', `${label} fields must be enumerable own data properties`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function exactString(value, label, maxBytes, { allowWhitespaceOnly = false } = {}) {
  if (typeof value !== 'string') {
    fail('A2A_PROVIDER_INPUT_INVALID', `${label} must be text`);
  }
  if (!allowWhitespaceOnly && !value.trim()) {
    fail('A2A_PROVIDER_INPUT_INVALID', `${label} must not be empty`);
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > maxBytes) {
    fail('A2A_PROVIDER_INPUT_INVALID', `${label} exceeds the byte limit`);
  }
  return value;
}

function timeout(value) {
  const out = value == null ? 30000 : value;
  if (typeof out !== 'number'
      || !Number.isInteger(out)
      || out < MIN_TIMEOUT_MS
      || out > MAX_TIMEOUT_MS) {
    fail('A2A_PROVIDER_INPUT_INVALID', 'timeoutMs must be an integer from 100 to 120000');
  }
  return out;
}

function trustedNow(now) {
  let value;
  try {
    value = now();
  } catch (cause) {
    fail('A2A_TIME_UNAVAILABLE', 'Trusted runtime clock failed', { cause });
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('A2A_TIME_UNAVAILABLE', 'Trusted runtime clock returned an invalid value');
  }
  const iso = new Date(value).toISOString();
  if (!iso) fail('A2A_TIME_UNAVAILABLE', 'Trusted runtime clock returned an invalid value');
  return { ms: value, iso };
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function boundedJson(value, label, depth = 0, state = { nodes: 0 }) {
  if (depth > MAX_JSON_DEPTH) {
    fail('A2A_RESPONSE_INVALID', `${label} exceeds maximum JSON depth`, {
      effectMayHaveOccurred: true,
    });
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).byteLength > MAX_RESPONSE_BYTES) {
      fail('A2A_RESPONSE_INVALID', `${label} contains oversized text`, {
        effectMayHaveOccurred: true,
      });
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('A2A_RESPONSE_INVALID', `${label} contains a non-finite number`, {
        effectMayHaveOccurred: true,
      });
    }
    return value;
  }
  if (!value || typeof value !== 'object') {
    fail('A2A_RESPONSE_INVALID', `${label} contains non-JSON data`, {
      effectMayHaveOccurred: true,
    });
  }
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    fail('A2A_RESPONSE_INVALID', `${label} contains too many JSON nodes`, {
      effectMayHaveOccurred: true,
    });
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_NODES) {
      fail('A2A_RESPONSE_INVALID', `${label} contains an oversized array`, {
        effectMayHaveOccurred: true,
      });
    }
    return value.map((item, index) => boundedJson(item, `${label}[${index}]`, depth + 1, state));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail('A2A_RESPONSE_INVALID', `${label} must contain plain JSON objects`, {
      effectMayHaveOccurred: true,
    });
  }
  const out = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, {
      value: boundedJson(value[key], `${label}.${key}`, depth + 1, state),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function responseEnvelope(value) {
  const raw = dataRecord(value, RESPONSE_KEYS, 'A2A transport response');
  if (typeof raw.status !== 'number'
      || !Number.isInteger(raw.status)
      || raw.status < 100
      || raw.status > 599) {
    fail('A2A_RESPONSE_INVALID', 'A2A transport response status is invalid', {
      effectMayHaveOccurred: true,
    });
  }
  if (typeof raw.contentType !== 'string' || !raw.contentType.trim()) {
    fail('A2A_RESPONSE_INVALID', 'A2A transport response contentType is invalid', {
      effectMayHaveOccurred: true,
    });
  }
  if (typeof raw.body !== 'string') {
    fail('A2A_RESPONSE_INVALID', 'A2A transport response body must be text', {
      effectMayHaveOccurred: true,
    });
  }
  if (new TextEncoder().encode(raw.body).byteLength > MAX_RESPONSE_BYTES) {
    fail('A2A_RESPONSE_INVALID', 'A2A transport response exceeds the byte limit', {
      effectMayHaveOccurred: true,
    });
  }
  return raw;
}

function parseJsonRpcResponse(response, expectedId) {
  if (response.status < 200 || response.status >= 300) {
    fail('A2A_HTTP_RESPONSE_AMBIGUOUS', `A2A endpoint returned HTTP ${response.status}`, {
      effectMayHaveOccurred: true,
    });
  }
  const mediaType = response.contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    fail('A2A_RESPONSE_INVALID', 'A2A response must use application/json', {
      effectMayHaveOccurred: true,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch (cause) {
    fail('A2A_RESPONSE_INVALID', 'A2A response is not valid JSON', {
      effectMayHaveOccurred: true,
      cause,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('A2A_RESPONSE_INVALID', 'A2A JSON-RPC response must be an object', {
      effectMayHaveOccurred: true,
    });
  }
  for (const key of Object.keys(parsed)) {
    if (!JSONRPC_RESPONSE_KEYS.has(key)) {
      fail('A2A_RESPONSE_INVALID', `A2A JSON-RPC response contains unknown field: ${key}`, {
        effectMayHaveOccurred: true,
      });
    }
  }
  if (parsed.jsonrpc !== '2.0') {
    fail('A2A_RESPONSE_INVALID', 'A2A JSON-RPC version must be 2.0', {
      effectMayHaveOccurred: true,
    });
  }
  if (parsed.id !== expectedId) {
    fail('A2A_RESPONSE_INVALID', 'A2A JSON-RPC response id does not match effectId', {
      effectMayHaveOccurred: true,
    });
  }
  const hasResult = Object.prototype.hasOwnProperty.call(parsed, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(parsed, 'error');
  if (hasResult === hasError) {
    fail('A2A_RESPONSE_INVALID', 'A2A JSON-RPC response must contain exactly one of result or error', {
      effectMayHaveOccurred: true,
    });
  }
  if (hasError) {
    const remoteError = boundedJson(parsed.error, 'A2A remote error');
    fail('A2A_REMOTE_ERROR_AMBIGUOUS', 'A2A remote endpoint returned a JSON-RPC error', {
      effectMayHaveOccurred: true,
      remoteError,
    });
  }
  return boundedJson(parsed.result, 'A2A result');
}

function transportFailure(error) {
  const uncertain = error?.effectMayHaveOccurred === true;
  const code = uncertain ? 'A2A_EFFECT_AMBIGUOUS' : 'A2A_TRANSPORT_FAILED';
  const message = String(error?.message || error || code).slice(0, 4000);
  fail(code, message, {
    effectMayHaveOccurred: uncertain,
    safeToRetry: !uncertain && error?.safeToRetry === true,
    cause: error instanceof Error ? error : null,
  });
}

function assertPolicy(policy, delegation, runtimeNowMs) {
  if (policy.decisionId !== delegation.policyDecisionId) {
    fail('A2A_POLICY_MISMATCH', 'Policy decisionId does not match A2A delegation');
  }
  if (policy.invocationId !== delegation.effectId) {
    fail('A2A_POLICY_MISMATCH', 'Policy invocationId does not match A2A effectId');
  }
  if (policy.decision !== PolicyDecisionKind.ALLOW) {
    fail('A2A_POLICY_DENIED', 'A2A remote execution requires explicit ALLOW');
  }
  const decidedMs = Date.parse(policy.decidedAt);
  if (decidedMs < Date.parse(delegation.createdAt)) {
    fail('A2A_POLICY_MISMATCH', 'Policy decision predates the A2A delegation');
  }
  if (decidedMs > runtimeNowMs) {
    fail('A2A_POLICY_MISMATCH', 'Policy decision is in the future');
  }
}

function jsonRpcRequest(delegation, messageText, tenant) {
  const message = {
    messageId: delegation.delegationId,
    role: 'ROLE_USER',
    parts: [{ text: messageText, mediaType: 'text/plain' }],
    metadata: {
      'autopilot/delegationId': delegation.delegationId,
      'autopilot/localAgentId': delegation.localAgentId,
      'autopilot/localTaskId': delegation.localTaskId,
      'autopilot/effectId': delegation.effectId,
      'autopilot/taskEnvelopeArtifactId': delegation.taskEnvelopeArtifactId,
      'autopilot/inputArtifactIds': [...delegation.inputArtifactIds],
    },
  };
  const params = tenant ? { tenant, message } : { message };
  return freeze({
    jsonrpc: '2.0',
    id: delegation.effectId,
    method: A2A_JSONRPC_METHOD_SEND_MESSAGE,
    params,
  });
}

export class A2ARemoteAgentProviderV1 {
  constructor({ transport, now = () => Date.now() } = {}) {
    if (!transport || typeof transport !== 'object' || typeof transport.sendJsonRpc !== 'function') {
      fail('A2A_TRANSPORT_UNAVAILABLE', 'A2A transport.sendJsonRpc is required');
    }
    if (typeof now !== 'function') {
      fail('A2A_TIME_UNAVAILABLE', 'A2A provider requires a trusted runtime clock');
    }
    this.transport = transport;
    this.now = now;
  }

  async sendMessage(input = {}) {
    const raw = dataRecord(input, EXECUTE_KEYS, 'A2A send request');
    const delegation = normalizeA2ADelegationRequestV1(raw.delegation);
    const admission = normalizeA2ARemoteAdmissionRefV1(raw.admission);
    const policy = normalizePolicyDecisionV1(raw.policyDecision);
    const messageText = exactString(raw.messageText, 'messageText', MAX_MESSAGE_BYTES);
    const timeoutMs = timeout(raw.timeoutMs);
    const runtimeNow = trustedNow(this.now);

    const assessment = assessA2ADelegationV1({
      card: raw.card,
      admission: raw.admission,
      delegation: raw.delegation,
      assessmentAt: runtimeNow.iso,
    });
    if (assessment.reasons.length) {
      fail(
        'A2A_DELEGATION_BLOCKED',
        `A2A delegation is blocked: ${assessment.reasons.join(',')}`,
      );
    }
    if (!assessment.selectedInterface) {
      fail('A2A_DELEGATION_BLOCKED', 'A2A delegation has no admitted interface');
    }
    if (admission.expiresAt && runtimeNow.ms >= Date.parse(admission.expiresAt)) {
      fail('A2A_ADMISSION_EXPIRED', 'A2A admission expired before execution');
    }
    assertPolicy(policy, delegation, runtimeNow.ms);

    if (assessment.selectedInterface.protocolBinding !== 'JSONRPC') {
      fail(
        'A2A_TRANSPORT_NOT_IMPLEMENTED',
        `A2A protocol binding is not implemented: ${assessment.selectedInterface.protocolBinding}`,
      );
    }
    if (assessment.selectedInterface.protocolVersion !== '1.0') {
      fail(
        'A2A_PROTOCOL_VERSION_NOT_IMPLEMENTED',
        `A2A protocol version is not implemented by this provider: ${assessment.selectedInterface.protocolVersion}`,
      );
    }

    const request = jsonRpcRequest(
      delegation,
      messageText,
      assessment.selectedInterface.tenant,
    );
    let rawResponse;
    try {
      rawResponse = await this.transport.sendJsonRpc(freeze({
        url: assessment.selectedInterface.url,
        protocolVersion: assessment.selectedInterface.protocolVersion,
        tenant: assessment.selectedInterface.tenant,
        timeoutMs,
        effectId: delegation.effectId,
        securityRequirement: delegation.declaredSecurityRequirement,
        request,
      }));
    } catch (error) {
      transportFailure(error);
    }

    let remoteResult;
    try {
      const response = responseEnvelope(rawResponse);
      remoteResult = parseJsonRpcResponse(response, delegation.effectId);
    } catch (error) {
      if (error?.effectMayHaveOccurred === true) throw error;
      fail('A2A_RESPONSE_INVALID', String(error?.message || error || 'A2A response validation failed').slice(0, 4000), {
        effectMayHaveOccurred: true,
        cause: error instanceof Error ? error : null,
      });
    }

    let observedAt;
    try {
      observedAt = trustedNow(this.now).iso;
    } catch (error) {
      fail('A2A_EFFECT_AMBIGUOUS', 'A2A response was received but observation time could not be established', {
        effectMayHaveOccurred: true,
        cause: error instanceof Error ? error : null,
      });
    }
    return freeze({
      schemaVersion: A2A_REMOTE_AGENT_PROVIDER_VERSION,
      providerId: 'a2a-remote-agent',
      remoteAgentId: assessment.remoteAgentId,
      delegationId: delegation.delegationId,
      localAgentId: delegation.localAgentId,
      localTaskId: delegation.localTaskId,
      effectId: delegation.effectId,
      policyDecisionId: policy.decisionId,
      interfaceUrl: assessment.selectedInterface.url,
      protocolBinding: assessment.selectedInterface.protocolBinding,
      protocolVersion: assessment.selectedInterface.protocolVersion,
      tenant: assessment.selectedInterface.tenant,
      requestedSkillId: delegation.requestedSkillId,
      requestedCapabilityIds: delegation.requestedCapabilityIds,
      remoteResult,
      observedAt,
      runtimeExpiryVerified: true,
      untrustedRemoteData: true,
      effectMayHaveOccurred: true,
      safeToRetry: false,
      executionAuthorized: false,
      credentialUseAuthorized: false,
      policyDecision: 'NONE',
      requiresIndependentVerification: true,
      requiresCanonicalExactEffectCommit: true,
    });
  }
}
