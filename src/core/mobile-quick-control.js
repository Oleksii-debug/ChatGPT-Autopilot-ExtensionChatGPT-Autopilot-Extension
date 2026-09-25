import {
  REMOTE_STEERING_SCHEMA_VERSION,
  RemoteSteeringAction,
} from './remote-steering-contract.js';

export const MOBILE_QUICK_CONTROL_VERSION = 1;
export const MAX_MOBILE_INTENT_TTL_MS = 15 * 60 * 1000;
export const MAX_MOBILE_JOBS = 128;
export const MAX_MOBILE_NOTIFICATIONS = 256;

export const MobileQuickIntentKind = Object.freeze({
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  STOP: 'STOP',
  CREATE_TASK: 'CREATE_TASK',
  RESOLVE_ASK: 'RESOLVE_ASK',
});

export const MobileInputMethod = Object.freeze({
  KEYBOARD: 'KEYBOARD',
  TOUCH: 'TOUCH',
  VOICE: 'VOICE',
});

export const MobileAskDecision = Object.freeze({
  APPROVE: 'APPROVE',
  DENY: 'DENY',
  SELECT: 'SELECT',
  FREE_TEXT: 'FREE_TEXT',
});

export const MobileJobState = Object.freeze({
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  WAITING: 'WAITING',
  STOPPED: 'STOPPED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

export const MobileNotificationKind = Object.freeze({
  ATTENTION: 'ATTENTION',
  ASK: 'ASK',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

const INTENT_KINDS = new Set(Object.values(MobileQuickIntentKind));
const INPUT_METHODS = new Set(Object.values(MobileInputMethod));
const ASK_DECISIONS = new Set(Object.values(MobileAskDecision));
const JOB_STATES = new Set(Object.values(MobileJobState));
const NOTIFICATION_KINDS = new Set(Object.values(MobileNotificationKind));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

const INTENT_KEYS = new Set([
  'schemaVersion', 'intentId', 'kind', 'inputMethod',
  'sourcePrincipalId', 'sourceDeviceId', 'sourceSessionId',
  'policyEnvelopeId', 'issuedAt', 'expiresAt',
  'jobId', 'planId', 'expectedJobRevision', 'expectedPlanRevision',
  'projectId', 'taskGoal',
  'supervisionId', 'responseId', 'decision', 'choiceId',
  'clarificationText', 'reasonCode',
]);
const STATUS_KEYS = new Set(['schemaVersion', 'projectionId', 'generatedAt', 'jobs', 'notifications']);
const JOB_KEYS = new Set([
  'jobId', 'planId', 'projectId', 'jobRevision', 'planRevision',
  'policyEnvelopeId', 'state', 'label', 'attentionCount', 'observedAt',
]);
const NOTIFICATION_KEYS = new Set([
  'notificationId', 'jobId', 'kind', 'label', 'observedAt', 'supervisionId',
]);

function fail(message) {
  throw new Error(message);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function strictRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !hasOwn(descriptor, 'value')) {
      fail(label + ' fields must be enumerable own data properties');
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function denseDataArray(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(label + ' must be a canonical dense array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || lengthDescriptor.value > max) {
    fail(label + ' length is invalid');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      fail(label + ' contains non-canonical array fields');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !hasOwn(descriptor, 'value')) {
      fail(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !ID.test(value)) fail(label + ' is invalid');
  return value;
}

function exactText(value, label, max, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max) {
    fail(label + ' must be bounded canonical text');
  }
  return value;
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string') fail(label + ' must use canonical ISO-8601 UTC representation');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(label + ' must use canonical ISO-8601 UTC representation');
  }
  return value;
}

function positiveRevision(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(label + ' must be a positive safe integer');
  return value;
}

function boundedCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) fail(label + ' is invalid');
  return value;
}

function enumValue(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) fail(label + ' is invalid');
  return value;
}

function assertIntentChronology(issuedAt, expiresAt) {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (expires <= issued) fail('mobile quick-control intent expiry must follow issuance');
  if (expires - issued > MAX_MOBILE_INTENT_TTL_MS) fail('mobile quick-control intent TTL exceeds the maximum');
}

function commonAuthorityFlags() {
  return Object.freeze({
    advisoryOnly: true,
    executionAuthorized: false,
    mutationAuthorized: false,
    permissionGranted: false,
    credentialUseAuthorized: false,
    sourceAuthenticated: false,
    requiresCanonicalPrincipalAuthentication: true,
    requiresFreshPolicy: true,
    requiresCanonicalRuntime: true,
    requiresCanonicalCommandDeduplication: true,
    requiresFreshStateRecheck: true,
  });
}

function assertOnlyFields(source, allowed, label) {
  for (const key of Reflect.ownKeys(source)) {
    if (!allowed.has(key)) fail(label + ' does not allow field ' + String(key));
  }
}

function normalizeIntentCommon(source) {
  if (source.schemaVersion !== MOBILE_QUICK_CONTROL_VERSION) {
    fail('MobileQuickControlIntentV1 schemaVersion must be 1');
  }
  const common = {
    schemaVersion: MOBILE_QUICK_CONTROL_VERSION,
    intentId: exactId(source.intentId, 'intentId'),
    kind: enumValue(source.kind, INTENT_KINDS, 'kind'),
    inputMethod: enumValue(source.inputMethod, INPUT_METHODS, 'inputMethod'),
    sourcePrincipalId: exactId(source.sourcePrincipalId, 'sourcePrincipalId'),
    sourceDeviceId: exactId(source.sourceDeviceId, 'sourceDeviceId'),
    sourceSessionId: exactId(source.sourceSessionId, 'sourceSessionId'),
    policyEnvelopeId: exactId(source.policyEnvelopeId, 'policyEnvelopeId'),
    issuedAt: exactTimestamp(source.issuedAt, 'issuedAt'),
    expiresAt: exactTimestamp(source.expiresAt, 'expiresAt'),
  };
  assertIntentChronology(common.issuedAt, common.expiresAt);
  return common;
}

function remoteSteeringIntent(source, common) {
  const allowed = new Set([
    'schemaVersion', 'intentId', 'kind', 'inputMethod', 'sourcePrincipalId',
    'sourceDeviceId', 'sourceSessionId', 'policyEnvelopeId', 'issuedAt', 'expiresAt',
    'jobId', 'planId', 'expectedJobRevision', 'expectedPlanRevision',
  ]);
  assertOnlyFields(source, allowed, common.kind + ' intent');
  const action = common.kind === MobileQuickIntentKind.PAUSE
    ? RemoteSteeringAction.PAUSE
    : common.kind === MobileQuickIntentKind.RESUME
      ? RemoteSteeringAction.RESUME
      : RemoteSteeringAction.STOP;
  const command = Object.freeze({
    schemaVersion: REMOTE_STEERING_SCHEMA_VERSION,
    commandId: common.intentId,
    action,
    jobId: exactId(source.jobId, 'jobId'),
    planId: exactId(source.planId, 'planId'),
    expectedJobRevision: positiveRevision(source.expectedJobRevision, 'expectedJobRevision'),
    expectedPlanRevision: positiveRevision(source.expectedPlanRevision, 'expectedPlanRevision'),
    policyEnvelopeId: common.policyEnvelopeId,
    sourcePrincipalId: common.sourcePrincipalId,
    sourceDeviceId: common.sourceDeviceId,
    sourceSessionId: common.sourceSessionId,
    issuedAt: common.issuedAt,
    expiresAt: common.expiresAt,
  });
  return Object.freeze({
    ...common,
    nonVoiceEquivalent: true,
    semanticAction: action,
    remoteSteeringCommand: command,
    taskProposal: null,
    supervisionProposal: null,
    ...commonAuthorityFlags(),
  });
}

function createTaskIntent(source, common) {
  const allowed = new Set([
    'schemaVersion', 'intentId', 'kind', 'inputMethod', 'sourcePrincipalId',
    'sourceDeviceId', 'sourceSessionId', 'policyEnvelopeId', 'issuedAt', 'expiresAt',
    'projectId', 'taskGoal',
  ]);
  assertOnlyFields(source, allowed, 'CREATE_TASK intent');
  const proposal = Object.freeze({
    schemaVersion: MOBILE_QUICK_CONTROL_VERSION,
    proposalId: common.intentId,
    projectId: exactId(source.projectId, 'projectId', true),
    goal: exactText(source.taskGoal, 'taskGoal', 4000),
    sourcePrincipalId: common.sourcePrincipalId,
    sourceDeviceId: common.sourceDeviceId,
    sourceSessionId: common.sourceSessionId,
    policyEnvelopeId: common.policyEnvelopeId,
    issuedAt: common.issuedAt,
    expiresAt: common.expiresAt,
    requiresCanonicalAgentAdmission: true,
  });
  return Object.freeze({
    ...common,
    nonVoiceEquivalent: true,
    semanticAction: MobileQuickIntentKind.CREATE_TASK,
    remoteSteeringCommand: null,
    taskProposal: proposal,
    supervisionProposal: null,
    ...commonAuthorityFlags(),
  });
}

function resolveAskIntent(source, common) {
  const allowed = new Set([
    'schemaVersion', 'intentId', 'kind', 'inputMethod', 'sourcePrincipalId',
    'sourceDeviceId', 'sourceSessionId', 'policyEnvelopeId', 'issuedAt', 'expiresAt',
    'jobId', 'planId', 'expectedJobRevision', 'expectedPlanRevision',
    'supervisionId', 'responseId', 'decision', 'choiceId', 'clarificationText', 'reasonCode',
  ]);
  assertOnlyFields(source, allowed, 'RESOLVE_ASK intent');
  const decision = enumValue(source.decision, ASK_DECISIONS, 'decision');
  const choiceId = exactId(source.choiceId, 'choiceId', true);
  const clarificationText = exactText(source.clarificationText, 'clarificationText', 4000, true);
  if (decision === MobileAskDecision.SELECT && !choiceId) fail('SELECT decision requires choiceId');
  if (decision !== MobileAskDecision.SELECT && choiceId) fail('choiceId is only valid for SELECT');
  if (decision === MobileAskDecision.FREE_TEXT && !clarificationText) fail('FREE_TEXT decision requires clarificationText');
  if (decision !== MobileAskDecision.FREE_TEXT && clarificationText) fail('clarificationText is only valid for FREE_TEXT');
  const proposal = Object.freeze({
    schemaVersion: MOBILE_QUICK_CONTROL_VERSION,
    supervisionId: exactId(source.supervisionId, 'supervisionId'),
    responseId: exactId(source.responseId, 'responseId'),
    jobId: exactId(source.jobId, 'jobId'),
    planId: exactId(source.planId, 'planId'),
    expectedJobRevision: positiveRevision(source.expectedJobRevision, 'expectedJobRevision'),
    expectedPlanRevision: positiveRevision(source.expectedPlanRevision, 'expectedPlanRevision'),
    policyEnvelopeId: common.policyEnvelopeId,
    sourcePrincipalId: common.sourcePrincipalId,
    sourceDeviceId: common.sourceDeviceId,
    sourceSessionId: common.sourceSessionId,
    decision,
    choiceId,
    clarificationText,
    reasonCode: exactId(source.reasonCode, 'reasonCode'),
    issuedAt: common.issuedAt,
    expiresAt: common.expiresAt,
    requiresCanonicalHumanSupervisionResolution: true,
    requiresCanonicalApprovalResolution: decision === MobileAskDecision.APPROVE || decision === MobileAskDecision.DENY,
  });
  return Object.freeze({
    ...common,
    nonVoiceEquivalent: true,
    semanticAction: MobileQuickIntentKind.RESOLVE_ASK,
    remoteSteeringCommand: null,
    taskProposal: null,
    supervisionProposal: proposal,
    ...commonAuthorityFlags(),
  });
}

export function normalizeMobileQuickControlIntentV1(input) {
  const source = strictRecord(input, INTENT_KEYS, 'MobileQuickControlIntentV1');
  const common = normalizeIntentCommon(source);
  if ([MobileQuickIntentKind.PAUSE, MobileQuickIntentKind.RESUME, MobileQuickIntentKind.STOP].includes(common.kind)) {
    return remoteSteeringIntent(source, common);
  }
  if (common.kind === MobileQuickIntentKind.CREATE_TASK) return createTaskIntent(source, common);
  return resolveAskIntent(source, common);
}

function normalizeJob(input, index, generatedAt) {
  const label = 'jobs[' + index + ']';
  const source = strictRecord(input, JOB_KEYS, label);
  const observedAt = exactTimestamp(source.observedAt, label + '.observedAt');
  if (Date.parse(observedAt) > Date.parse(generatedAt)) fail(label + '.observedAt postdates generatedAt');
  return Object.freeze({
    jobId: exactId(source.jobId, label + '.jobId'),
    planId: exactId(source.planId, label + '.planId'),
    projectId: exactId(source.projectId, label + '.projectId', true),
    jobRevision: positiveRevision(source.jobRevision, label + '.jobRevision'),
    planRevision: positiveRevision(source.planRevision, label + '.planRevision'),
    policyEnvelopeId: exactId(source.policyEnvelopeId, label + '.policyEnvelopeId'),
    state: enumValue(source.state, JOB_STATES, label + '.state'),
    label: exactText(source.label, label + '.label', 500),
    attentionCount: boundedCount(source.attentionCount, label + '.attentionCount'),
    observedAt,
  });
}

function normalizeNotification(input, index, generatedAt) {
  const label = 'notifications[' + index + ']';
  const source = strictRecord(input, NOTIFICATION_KEYS, label);
  const observedAt = exactTimestamp(source.observedAt, label + '.observedAt');
  if (Date.parse(observedAt) > Date.parse(generatedAt)) fail(label + '.observedAt postdates generatedAt');
  const kind = enumValue(source.kind, NOTIFICATION_KINDS, label + '.kind');
  const supervisionId = exactId(source.supervisionId, label + '.supervisionId', true);
  if (kind === MobileNotificationKind.ASK && !supervisionId) fail(label + ' ASK requires supervisionId');
  if (kind !== MobileNotificationKind.ASK && supervisionId) fail(label + ' supervisionId is only valid for ASK');
  return Object.freeze({
    notificationId: exactId(source.notificationId, label + '.notificationId'),
    jobId: exactId(source.jobId, label + '.jobId'),
    kind,
    label: exactText(source.label, label + '.label', 1000),
    observedAt,
    supervisionId,
  });
}

function jobControls(state) {
  if (state === MobileJobState.RUNNING) return Object.freeze([MobileQuickIntentKind.PAUSE, MobileQuickIntentKind.STOP]);
  if (state === MobileJobState.PAUSED) return Object.freeze([MobileQuickIntentKind.RESUME, MobileQuickIntentKind.STOP]);
  if (state === MobileJobState.WAITING) return Object.freeze([MobileQuickIntentKind.STOP]);
  return Object.freeze([]);
}

export function projectMobileQuickControlStatusV1(input) {
  const source = strictRecord(input, STATUS_KEYS, 'MobileQuickControlStatusV1 request');
  if (source.schemaVersion !== MOBILE_QUICK_CONTROL_VERSION) fail('MobileQuickControlStatusV1 schemaVersion must be 1');
  const generatedAt = exactTimestamp(source.generatedAt, 'generatedAt');
  const jobs = denseDataArray(source.jobs, 'jobs', MAX_MOBILE_JOBS)
    .map((item, index) => normalizeJob(item, index, generatedAt));
  const notifications = denseDataArray(source.notifications, 'notifications', MAX_MOBILE_NOTIFICATIONS)
    .map((item, index) => normalizeNotification(item, index, generatedAt));

  const jobIds = new Set();
  for (const job of jobs) {
    if (jobIds.has(job.jobId)) fail('duplicate mobile status jobId: ' + job.jobId);
    jobIds.add(job.jobId);
  }
  const notificationIds = new Set();
  for (const notification of notifications) {
    if (notificationIds.has(notification.notificationId)) fail('duplicate notificationId: ' + notification.notificationId);
    notificationIds.add(notification.notificationId);
    if (!jobIds.has(notification.jobId)) fail('notification references unknown jobId: ' + notification.jobId);
  }

  jobs.sort((a, b) => a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0);
  notifications.sort((a, b) => a.notificationId < b.notificationId ? -1 : a.notificationId > b.notificationId ? 1 : 0);

  const projectedJobs = jobs.map((job, index) => Object.freeze({
    focusOrdinal: index + 1,
    jobId: job.jobId,
    planId: job.planId,
    projectId: job.projectId,
    jobRevision: job.jobRevision,
    planRevision: job.planRevision,
    policyEnvelopeId: job.policyEnvelopeId,
    state: job.state,
    label: job.label,
    attentionCount: job.attentionCount,
    observedAt: job.observedAt,
    controls: jobControls(job.state),
    keyboardReachable: true,
    nonVoiceEquivalent: true,
  }));
  const projectedNotifications = notifications.map((notification, index) => Object.freeze({
    focusOrdinal: index + 1,
    notificationId: notification.notificationId,
    jobId: notification.jobId,
    kind: notification.kind,
    label: notification.label,
    observedAt: notification.observedAt,
    supervisionId: notification.supervisionId,
    semanticAction: notification.kind === MobileNotificationKind.ASK ? MobileQuickIntentKind.RESOLVE_ASK : 'OPEN_STATUS',
    keyboardReachable: true,
    nonVoiceEquivalent: true,
  }));

  return Object.freeze({
    schemaVersion: MOBILE_QUICK_CONTROL_VERSION,
    projectionId: exactId(source.projectionId, 'projectionId'),
    generatedAt,
    jobCount: projectedJobs.length,
    notificationCount: projectedNotifications.length,
    jobs: Object.freeze(projectedJobs),
    notifications: Object.freeze(projectedNotifications),
    globalControls: Object.freeze([MobileQuickIntentKind.CREATE_TASK]),
    semanticControlOrder: 'LINEAR',
    voiceOptional: true,
    nonVoiceEquivalent: true,
    keyboardReachable: true,
    ...commonAuthorityFlags(),
  });
}
