import { assertToolInvocationAuthorizedV1, normalizeToolDescriptorV1 } from './universal-agent-contracts.js';

export const GOOGLE_WORKSPACE_PROVIDER_ID = 'remote/google-workspace';

export const GoogleWorkspaceToolId = Object.freeze({
  DRIVE_SEARCH: 'remote/google-workspace/drive.search',
  DRIVE_FILE_GET: 'remote/google-workspace/drive.file.get',
  DRIVE_FILE_READ_TEXT: 'remote/google-workspace/drive.file.readText',
  DRIVE_FILE_UPDATE: 'remote/google-workspace/drive.file.update',
  GMAIL_SEARCH: 'remote/google-workspace/gmail.search',
  GMAIL_MESSAGE_GET: 'remote/google-workspace/gmail.message.get',
  GMAIL_MESSAGE_MODIFY: 'remote/google-workspace/gmail.message.modify',
  GMAIL_THREAD_GET: 'remote/google-workspace/gmail.thread.get',
  GMAIL_ATTACHMENT_GET: 'remote/google-workspace/gmail.attachment.get',
  GMAIL_DRAFT_CREATE: 'remote/google-workspace/gmail.draft.create',
  GMAIL_DRAFT_SEND: 'remote/google-workspace/gmail.draft.send',
});

export const GoogleWorkspaceCapabilityId = Object.freeze({
  DRIVE_SEARCH: 'google.drive.search',
  DRIVE_FILE_READ: 'google.drive.file.read',
  DRIVE_FILE_UPDATE: 'google.drive.file.update',
  GMAIL_SEARCH: 'google.gmail.search',
  GMAIL_MESSAGE_READ: 'google.gmail.message.read',
  GMAIL_MESSAGE_MODIFY: 'google.gmail.message.modify',
  GMAIL_ATTACHMENT_READ: 'google.gmail.attachment.read',
  GMAIL_DRAFT_CREATE: 'google.gmail.draft.create',
  GMAIL_DRAFT_SEND: 'google.gmail.draft.send',
});

const TOOLS = Object.freeze([
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.DRIVE_SEARCH,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Search owner-authorized Google Drive scope',
    description: 'Lists bounded metadata under an owner-authorized Drive folder. Discovery grants no new permission.',
    capabilityIds: [GoogleWorkspaceCapabilityId.DRIVE_SEARCH],
    inputSchemaRef: 'google-workspace-schema/drive.search/input',
    outputSchemaRef: 'google-workspace-schema/drive.search/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.DRIVE_FILE_GET,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Read Google Drive file metadata',
    description: 'Reads bounded metadata only after the file resolves within an owner-authorized Drive root or exact file allowlist.',
    capabilityIds: [GoogleWorkspaceCapabilityId.DRIVE_FILE_READ],
    inputSchemaRef: 'google-workspace-schema/drive.file.get/input',
    outputSchemaRef: 'google-workspace-schema/drive.file.get/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.DRIVE_FILE_READ_TEXT,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Read or export Google Drive text',
    description: 'Reads bounded UTF-8 text or an admitted Google Workspace text export without mutation.',
    capabilityIds: [GoogleWorkspaceCapabilityId.DRIVE_FILE_READ],
    inputSchemaRef: 'google-workspace-schema/drive.file.readText/input',
    outputSchemaRef: 'google-workspace-schema/drive.file.readText/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.DRIVE_FILE_UPDATE,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Update owner-authorized Google Drive file',
    description: 'Renames and/or moves one existing owner-authorized Drive file through the canonical exact-effect path.',
    capabilityIds: [GoogleWorkspaceCapabilityId.DRIVE_FILE_UPDATE],
    inputSchemaRef: 'google-workspace-schema/drive.file.update/input',
    outputSchemaRef: 'google-workspace-schema/drive.file.update/output',
    readOnly: false,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.GMAIL_SEARCH,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Search owner-authorized Gmail mailbox',
    description: 'Lists bounded Gmail message identities from an owner-authorized mailbox without changing mailbox state.',
    capabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_SEARCH],
    inputSchemaRef: 'google-workspace-schema/gmail.search/input',
    outputSchemaRef: 'google-workspace-schema/gmail.search/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.GMAIL_MESSAGE_GET,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Read Gmail message',
    description: 'Reads one bounded Gmail message from an owner-authorized mailbox.',
    capabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_READ],
    inputSchemaRef: 'google-workspace-schema/gmail.message.get/input',
    outputSchemaRef: 'google-workspace-schema/gmail.message.get/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.GMAIL_MESSAGE_MODIFY,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Modify owner-authorized Gmail message labels',
    description: 'Adds and/or removes exact label IDs on one owner-authorized Gmail message through the canonical exact-effect path. Removing INBOX archives the message.',
    capabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_MODIFY],
    inputSchemaRef: 'google-workspace-schema/gmail.message.modify/input',
    outputSchemaRef: 'google-workspace-schema/gmail.message.modify/output',
    readOnly: false,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.GMAIL_THREAD_GET,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Read Gmail thread',
    description: 'Reads one bounded Gmail thread from an owner-authorized mailbox.',
    capabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_READ],
    inputSchemaRef: 'google-workspace-schema/gmail.thread.get/input',
    outputSchemaRef: 'google-workspace-schema/gmail.thread.get/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.GMAIL_ATTACHMENT_GET,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Read Gmail attachment',
    description: 'Reads one size-bounded Gmail attachment from an owner-authorized mailbox as base64url data.',
    capabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_ATTACHMENT_READ],
    inputSchemaRef: 'google-workspace-schema/gmail.attachment.get/input',
    outputSchemaRef: 'google-workspace-schema/gmail.attachment.get/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.GMAIL_DRAFT_CREATE,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Create owner-authorized Gmail draft',
    description: 'Creates a bounded Gmail draft through the canonical exact-effect path. It does not send mail.',
    capabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_DRAFT_CREATE],
    inputSchemaRef: 'google-workspace-schema/gmail.draft.create/input',
    outputSchemaRef: 'google-workspace-schema/gmail.draft.create/output',
    readOnly: false,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: GoogleWorkspaceToolId.GMAIL_DRAFT_SEND,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    label: 'Send owner-authorized Gmail draft',
    description: 'Sends one exact owner-authorized Gmail draft through the canonical exact-effect path. The invocation binds the exact RFC822 bytes used by drafts.send.',
    capabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_DRAFT_SEND],
    inputSchemaRef: 'google-workspace-schema/gmail.draft.send/input',
    outputSchemaRef: 'google-workspace-schema/gmail.draft.send/output',
    readOnly: false,
  }),
]);

const INVOKE_KEYS = new Set(['invocation', 'policyDecision']);
const INVOCATION_KEYS = new Set([
  'schemaVersion', 'invocationId', 'toolId', 'providerId', 'requestedCapabilityIds',
  'policyDecisionId', 'arguments', 'createdAt', 'parentInvocationId',
]);
const POLICY_KEYS = new Set([
  'schemaVersion', 'decisionId', 'invocationId', 'decision', 'reasonCode', 'reason',
  'approvalId', 'decidedAt',
]);

const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function strictIdValue(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return;
  if (typeof value !== 'string' || !CANONICAL_ID.test(value)) fail(`${label} must be an exact canonical text identity`);
}

function exactTimestampValue(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an exact canonical timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(`${label} must be an exact canonical timestamp`);
  }
}

function validateCanonicalInvocationShape(invocation, policyDecision) {
  if (invocation.schemaVersion !== 1) fail('ToolInvocationV1.schemaVersion must be numeric 1');
  strictIdValue(invocation.invocationId, 'ToolInvocationV1.invocationId');
  strictIdValue(invocation.toolId, 'ToolInvocationV1.toolId');
  strictIdValue(invocation.providerId, 'ToolInvocationV1.providerId');
  strictIdValue(invocation.policyDecisionId, 'ToolInvocationV1.policyDecisionId');
  strictIdValue(invocation.parentInvocationId, 'ToolInvocationV1.parentInvocationId', { optional: true });
  exactTimestampValue(invocation.createdAt, 'ToolInvocationV1.createdAt');
  if (!Array.isArray(invocation.requestedCapabilityIds) || invocation.requestedCapabilityIds.length > 128) fail('ToolInvocationV1.requestedCapabilityIds must be a bounded array');
  for (let index = 0; index < invocation.requestedCapabilityIds.length; index += 1) strictIdValue(invocation.requestedCapabilityIds[index], `ToolInvocationV1.requestedCapabilityIds[${index}]`);
  if (new Set(invocation.requestedCapabilityIds).size !== invocation.requestedCapabilityIds.length) fail('ToolInvocationV1.requestedCapabilityIds contains duplicates');

  if (policyDecision.schemaVersion !== 1) fail('PolicyDecisionV1.schemaVersion must be numeric 1');
  strictIdValue(policyDecision.decisionId, 'PolicyDecisionV1.decisionId');
  strictIdValue(policyDecision.invocationId, 'PolicyDecisionV1.invocationId');
  strictIdValue(policyDecision.reasonCode, 'PolicyDecisionV1.reasonCode');
  strictIdValue(policyDecision.approvalId, 'PolicyDecisionV1.approvalId', { optional: true });
  if (typeof policyDecision.decision !== 'string' || !['ALLOW', 'DENY', 'REQUIRE_APPROVAL'].includes(policyDecision.decision)) fail('PolicyDecisionV1.decision is invalid');
  if (policyDecision.reason != null && typeof policyDecision.reason !== 'string') fail('PolicyDecisionV1.reason must be text');
  exactTimestampValue(policyDecision.decidedAt, 'PolicyDecisionV1.decidedAt');
}

function fail(message) {
  throw new Error(message);
}

function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${label} must be a plain object`);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(`${label} contains unknown field`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${label}.${key} must be an enumerable data property`);
    }
    out[key] = descriptor.value;
  }
  return out;
}

function snapshotJson(value, label, depth = 0, nodes = { count: 0 }) {
  if (depth > 32) fail(`${label} is too deep`);
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains an invalid number`);
    return value;
  }
  if (typeof value !== 'object') fail(`${label} contains an unsupported value`);
  if (++nodes.count > 10_000) fail(`${label} is too complex`);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a bounded plain array`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor
        || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > 1024) {
      fail(`${label} must be a bounded plain array`);
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(descriptors);
    const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
    if (keys.length !== expected.size || keys.some(key => typeof key !== 'string' || !expected.has(key))) fail(`${label} must be a dense canonical array`);
    const out = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(`${label}[${index}] must be an enumerable data property`);
      out.push(snapshotJson(descriptor.value, `${label}[${index}]`, depth + 1, nodes));
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${label} must contain only plain records`);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key.length > 512) fail(`${label} contains an invalid key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(`${label}.${key} must be an enumerable data property`);
    out[key] = snapshotJson(descriptor.value, `${label}.${key}`, depth + 1, nodes);
  }
  return out;
}

function canonicalInputs(input) {
  const envelope = snapshotRecord(input, INVOKE_KEYS, 'Google Workspace invocation envelope');
  const invocation = snapshotRecord(envelope.invocation, INVOCATION_KEYS, 'ToolInvocationV1');
  const policyDecision = snapshotRecord(envelope.policyDecision, POLICY_KEYS, 'PolicyDecisionV1');
  invocation.requestedCapabilityIds = snapshotJson(invocation.requestedCapabilityIds, 'requestedCapabilityIds');
  invocation.arguments = snapshotJson(invocation.arguments, 'arguments');
  validateCanonicalInvocationShape(invocation, policyDecision);
  return { invocation, policyDecision };
}

function strictCapabilities(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('grantedCapabilityIds must be a bounded plain array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > 128) {
    fail('grantedCapabilityIds must be a bounded plain array');
  }
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  if (keys.length !== expected.size || keys.some(key => typeof key !== 'string' || !expected.has(key))) fail('grantedCapabilityIds must be a dense canonical array');
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'string') {
      fail(`grantedCapabilityIds[${index}] must be an enumerable text data property`);
    }
    out.push(descriptor.value);
  }
  return Object.freeze(out);
}

function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) fail(`${label} is required`);
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        fail(`${label}.${method} must be a data method`);
      }
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  fail(`${label}.${method} is required`);
}

function methodFor(toolId) {
  if (toolId === GoogleWorkspaceToolId.DRIVE_SEARCH) return 'searchDrive';
  if (toolId === GoogleWorkspaceToolId.DRIVE_FILE_GET) return 'getDriveFile';
  if (toolId === GoogleWorkspaceToolId.DRIVE_FILE_READ_TEXT) return 'readDriveText';
  if (toolId === GoogleWorkspaceToolId.DRIVE_FILE_UPDATE) return 'updateDriveFile';
  if (toolId === GoogleWorkspaceToolId.GMAIL_SEARCH) return 'searchGmail';
  if (toolId === GoogleWorkspaceToolId.GMAIL_MESSAGE_GET) return 'getGmailMessage';
  if (toolId === GoogleWorkspaceToolId.GMAIL_MESSAGE_MODIFY) return 'modifyGmailMessage';
  if (toolId === GoogleWorkspaceToolId.GMAIL_THREAD_GET) return 'getGmailThread';
  if (toolId === GoogleWorkspaceToolId.GMAIL_ATTACHMENT_GET) return 'getGmailAttachment';
  if (toolId === GoogleWorkspaceToolId.GMAIL_DRAFT_CREATE) return 'createGmailDraft';
  if (toolId === GoogleWorkspaceToolId.GMAIL_DRAFT_SEND) return 'sendGmailDraft';
  return '';
}

function wrapFailure(error, invocationId, readOnly) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = /^GOOGLE_[A-Z0-9_]{1,100}$/u.test(rawCode) ? rawCode : 'GOOGLE_WORKSPACE_PROVIDER_FAILED';
  const wrapped = new Error(readOnly ? 'Google Workspace read failed' : 'Google Workspace mutation outcome is uncertain');
  wrapped.name = 'GoogleWorkspaceAgentProviderError';
  wrapped.code = code;
  wrapped.invocationId = invocationId;
  if (readOnly) {
    wrapped.effectMayHaveOccurred = false;
    wrapped.safeToRetry = true;
  } else {
    wrapped.effectMayHaveOccurred = error?.effectMayHaveOccurred === false ? false : true;
    wrapped.safeToRetry = wrapped.effectMayHaveOccurred === false && error?.safeToRetry === true;
  }
  if (Number.isInteger(error?.status)) wrapped.status = error.status;
  return wrapped;
}

export class GoogleWorkspaceAgentProviderV1 {
  constructor(config = {}) {
    const raw = snapshotRecord(config, new Set(['workspaceClient', 'grantedCapabilityIds', 'now']), 'Google Workspace provider config');
    const requiredMethods = Object.values(GoogleWorkspaceToolId).map(methodFor);
    const workspaceMethods = Object.create(null);
    for (const method of requiredMethods) workspaceMethods[method] = bindDataMethod(raw.workspaceClient, method, 'workspaceClient');
    this.workspaceMethods = Object.freeze(workspaceMethods);
    this.grantedCapabilityIds = strictCapabilities(raw.grantedCapabilityIds ?? []);
    this.now = raw.now ?? (() => Date.now());
    if (typeof this.now !== 'function') fail('now must be a function');
  }

  tools() {
    return TOOLS;
  }

  authorize(input = {}) {
    const { invocation, policyDecision } = canonicalInputs(input);
    const tool = TOOLS.find(item => item.toolId === invocation.toolId);
    if (!tool) fail('Google Workspace tool is not registered');
    return assertToolInvocationAuthorizedV1({
      invocation,
      policyDecision,
      toolDescriptor: tool,
      grantedCapabilityIds: this.grantedCapabilityIds,
    });
  }

  async invoke(input = {}) {
    const authorized = this.authorize(input);
    const tool = TOOLS.find(item => item.toolId === authorized.invocation.toolId);
    const method = methodFor(tool.toolId);
    try {
      const result = await this.workspaceMethods[method](authorized.invocation.arguments);
      const observedAt = new Date(this.now());
      if (!Number.isFinite(observedAt.getTime())) fail('now returned an invalid timestamp');
      return Object.freeze({
        providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
        invocationId: authorized.invocation.invocationId,
        observedAt: observedAt.toISOString(),
        result: structuredClone(result),
      });
    } catch (error) {
      throw wrapFailure(error, authorized.invocation.invocationId, tool.readOnly);
    }
  }
}
