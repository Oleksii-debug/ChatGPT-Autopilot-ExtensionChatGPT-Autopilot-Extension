export const REMOTE_DISPATCH_LEDGER_STORAGE_KEY = 'autopilotRemoteDispatchLedger';
export const REMOTE_DISPATCH_LEDGER_SCHEMA_VERSION = 1;
export const MAX_LEDGER_DISPATCHES = 200;
export const MAX_LEDGER_REJECTIONS = 100;
export const MAX_LEDGER_LAUNCH_KEYS = 10_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
}

function assertString(value, label) {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
}

function assertTimestamp(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
}

function trimArray(array, max) {
  return array.length <= max ? array : array.slice(array.length - max);
}

export function createRemoteDispatchLedger(projectId = '', nowMs = Date.now()) {
  if (typeof projectId !== 'string') throw new Error('Invalid projectId');
  return {
    schemaVersion: REMOTE_DISPATCH_LEDGER_SCHEMA_VERSION,
    revision: 0,
    projectId,
    createdAt: nowMs,
    updatedAt: nowMs,
    lastFetchAt: 0,
    lastFetchOkAt: 0,
    lastFetchError: '',
    lastCommentId: '',
    currentDispatchId: '',
    currentStrategyRevision: 0,
    currentDispatchExpiresAt: 0,
    acceptedDispatches: [],
    supersededDispatchIds: [],
    rejectedDispatches: [],
    launchCounts: {},
    importedSessionIds: {},
    configFingerprints: {},
    countedSendFingerprints: {},
    fallbackActive: false,
    fallbackActivatedAt: 0,
    fallbackEligibleSince: 0,
    fallbackSessionId: '',
    fallbackAutoStarted: false,
  };
}

export function validateRemoteDispatchLedger(ledger) {
  assertRecord(ledger, 'remote dispatch ledger');
  if (ledger.schemaVersion !== REMOTE_DISPATCH_LEDGER_SCHEMA_VERSION) throw new Error('Unsupported remote dispatch ledger schema');
  if (!Number.isInteger(ledger.revision) || ledger.revision < 0) throw new Error('Invalid remote dispatch ledger revision');
  assertString(ledger.projectId, 'remote dispatch ledger projectId');
  for (const field of ['createdAt', 'updatedAt', 'lastFetchAt', 'lastFetchOkAt', 'currentDispatchExpiresAt', 'fallbackActivatedAt', 'fallbackEligibleSince']) assertTimestamp(ledger[field], `remote dispatch ledger ${field}`);
  for (const field of ['lastFetchError', 'lastCommentId', 'currentDispatchId']) assertString(ledger[field], `remote dispatch ledger ${field}`);
  if (!Number.isInteger(ledger.currentStrategyRevision) || ledger.currentStrategyRevision < 0) throw new Error('Invalid remote dispatch ledger currentStrategyRevision');
  if (typeof ledger.fallbackActive !== 'boolean') throw new Error('Invalid remote dispatch ledger fallbackActive');
  assertString(ledger.fallbackSessionId, 'remote dispatch ledger fallbackSessionId');
  if (typeof ledger.fallbackAutoStarted !== 'boolean') throw new Error('Invalid remote dispatch ledger fallbackAutoStarted');
  for (const field of ['acceptedDispatches', 'supersededDispatchIds', 'rejectedDispatches']) if (!Array.isArray(ledger[field])) throw new Error(`Invalid remote dispatch ledger ${field}`);
  for (const field of ['launchCounts', 'importedSessionIds', 'configFingerprints', 'countedSendFingerprints']) assertRecord(ledger[field], `remote dispatch ledger ${field}`);
  if (ledger.acceptedDispatches.length > MAX_LEDGER_DISPATCHES) throw new Error('Remote dispatch accepted history exceeds limit');
  if (ledger.rejectedDispatches.length > MAX_LEDGER_REJECTIONS) throw new Error('Remote dispatch rejected history exceeds limit');
  if (Object.keys(ledger.launchCounts).length > MAX_LEDGER_LAUNCH_KEYS) throw new Error('Remote dispatch launch ledger exceeds limit');
  for (const [key, value] of Object.entries(ledger.launchCounts)) {
    assertString(key, 'remote dispatch launch key');
    if (!Number.isInteger(value) || value < 0) throw new Error('Invalid remote dispatch launch count');
  }
  return ledger;
}

export function migrateRemoteDispatchLedger(raw, { projectId = '', nowMs = Date.now() } = {}) {
  if (raw === undefined) return createRemoteDispatchLedger(projectId, nowMs);
  raw = { fallbackEligibleSince: 0, fallbackSessionId: '', fallbackAutoStarted: false, ...raw };
  validateRemoteDispatchLedger(raw);
  if (projectId && raw.projectId && raw.projectId !== projectId) throw new Error('Remote dispatch ledger belongs to another project');
  if (projectId && !raw.projectId) return { ...raw, projectId };
  return raw;
}

export function makeRemoteLaunchKey({ projectId, dispatchId, sessionKey, taskId }) {
  for (const [name, value] of Object.entries({ projectId, dispatchId, sessionKey, taskId })) {
    if (typeof value !== 'string' || !value) throw new Error(`Invalid remote launch ${name}`);
  }
  return `${projectId}\u001f${dispatchId}\u001f${sessionKey}\u001f${taskId}`;
}

export function getRemoteLaunchCount(ledger, identity) {
  validateRemoteDispatchLedger(ledger);
  return ledger.launchCounts[makeRemoteLaunchKey(identity)] || 0;
}

export function canLaunchRemoteTask(ledger, identity, maxLaunches) {
  if (!Number.isInteger(maxLaunches) || maxLaunches < 1) throw new Error('Invalid remote maxLaunches');
  return getRemoteLaunchCount(ledger, identity) < maxLaunches;
}

export function recordRemoteTaskLaunch(ledger, identity, { nowMs = Date.now() } = {}) {
  validateRemoteDispatchLedger(ledger);
  const key = makeRemoteLaunchKey(identity);
  if (!Object.hasOwn(ledger.launchCounts, key) && Object.keys(ledger.launchCounts).length >= MAX_LEDGER_LAUNCH_KEYS) {
    throw new Error('Remote dispatch launch ledger is full');
  }
  ledger.launchCounts[key] = (ledger.launchCounts[key] || 0) + 1;
  ledger.updatedAt = nowMs;
  return ledger.launchCounts[key];
}


export function recordVerifiedRemoteSend(ledger, identity, promptFingerprint, { nowMs = Date.now() } = {}) {
  validateRemoteDispatchLedger(ledger);
  if (typeof promptFingerprint !== 'string' || !promptFingerprint) throw new Error('Invalid remote verified-send fingerprint');
  const key = makeRemoteLaunchKey(identity);
  if (ledger.countedSendFingerprints[key] === promptFingerprint) {
    return { counted: false, count: ledger.launchCounts[key] || 0 };
  }
  const count = recordRemoteTaskLaunch(ledger, identity, { nowMs });
  ledger.countedSendFingerprints[key] = promptFingerprint.slice(0, 200);
  ledger.updatedAt = nowMs;
  return { counted: true, count };
}

export function recordRemoteSessionBinding(ledger, sessionKey, localSessionId, { nowMs = Date.now() } = {}) {
  validateRemoteDispatchLedger(ledger);
  if (typeof sessionKey !== 'string' || !sessionKey || typeof localSessionId !== 'string' || !localSessionId) throw new Error('Invalid remote session binding');
  ledger.importedSessionIds[sessionKey] = localSessionId;
  ledger.updatedAt = nowMs;
  return ledger;
}

export function recordAcceptedRemoteDispatch(ledger, { dispatchId, strategyRevision, expiresAtMs, commentId = '', supersedesDispatchIds = [] }, { nowMs = Date.now() } = {}) {
  validateRemoteDispatchLedger(ledger);
  assertString(dispatchId, 'accepted dispatchId');
  if (!dispatchId) throw new Error('Invalid accepted dispatchId');
  if (!Number.isInteger(strategyRevision) || strategyRevision < 0) throw new Error('Invalid accepted strategyRevision');
  assertTimestamp(expiresAtMs, 'accepted expiresAtMs');
  ledger.currentDispatchId = dispatchId;
  ledger.currentStrategyRevision = strategyRevision;
  ledger.currentDispatchExpiresAt = expiresAtMs;
  ledger.lastCommentId = String(commentId || '');
  const alreadyRecorded = ledger.acceptedDispatches.some(entry =>
    entry?.dispatchId === dispatchId
    && entry?.strategyRevision === strategyRevision
    && String(entry?.commentId || '') === ledger.lastCommentId
  );
  if (!alreadyRecorded) {
    ledger.acceptedDispatches = trimArray([...ledger.acceptedDispatches, { dispatchId, strategyRevision, acceptedAt: nowMs, commentId: ledger.lastCommentId }], MAX_LEDGER_DISPATCHES);
  }
  const superseded = new Set(ledger.supersededDispatchIds);
  for (const id of supersedesDispatchIds) {
    if (typeof id === 'string' && id) superseded.add(id);
  }
  ledger.supersededDispatchIds = [...superseded].slice(-MAX_LEDGER_DISPATCHES);
  ledger.updatedAt = nowMs;
  return ledger;
}

export function recordRejectedRemoteDispatch(ledger, { dispatchId = '', commentId = '', reason = 'INVALID' }, { nowMs = Date.now() } = {}) {
  validateRemoteDispatchLedger(ledger);
  ledger.rejectedDispatches = trimArray([...ledger.rejectedDispatches, {
    dispatchId: String(dispatchId || ''),
    commentId: String(commentId || ''),
    reason: String(reason || 'INVALID').slice(0, 120),
    rejectedAt: nowMs,
  }], MAX_LEDGER_REJECTIONS);
  ledger.updatedAt = nowMs;
  return ledger;
}

export function recordRemoteFetch(ledger, { ok, commentId = '', error = '' }, { nowMs = Date.now() } = {}) {
  validateRemoteDispatchLedger(ledger);
  ledger.lastFetchAt = nowMs;
  ledger.lastCommentId = String(commentId || ledger.lastCommentId || '');
  if (ok) {
    ledger.lastFetchOkAt = nowMs;
    ledger.lastFetchError = '';
  } else {
    ledger.lastFetchError = String(error || 'Remote dispatch fetch failed').slice(0, 500);
  }
  ledger.updatedAt = nowMs;
  return ledger;
}

export function setRemoteFallbackEligibility(ledger, eligible, { nowMs = Date.now() } = {}) {
  validateRemoteDispatchLedger(ledger);
  if (typeof eligible !== 'boolean') throw new Error('Invalid fallback eligibility');
  if (eligible && !ledger.fallbackEligibleSince) ledger.fallbackEligibleSince = nowMs;
  if (!eligible) ledger.fallbackEligibleSince = 0;
  ledger.updatedAt = nowMs;
  return ledger;
}

export function setRemoteFallbackActive(ledger, active, { nowMs = Date.now(), sessionId = '', autoStarted = false } = {}) {
  validateRemoteDispatchLedger(ledger);
  if (typeof active !== 'boolean') throw new Error('Invalid fallback state');
  if (active && !ledger.fallbackActive) ledger.fallbackActivatedAt = nowMs;
  if (!active) ledger.fallbackActivatedAt = 0;
  ledger.fallbackActive = active;
  if (active) {
    ledger.fallbackSessionId = String(sessionId || ledger.fallbackSessionId || '');
    ledger.fallbackAutoStarted = autoStarted === true || ledger.fallbackAutoStarted === true;
  } else if (!ledger.fallbackAutoStarted) {
    ledger.fallbackSessionId = '';
  }
  ledger.updatedAt = nowMs;
  return ledger;
}

export function clearRemoteFallbackAutoStart(ledger, { nowMs = Date.now() } = {}) {
  validateRemoteDispatchLedger(ledger);
  ledger.fallbackAutoStarted = false;
  ledger.fallbackSessionId = '';
  ledger.updatedAt = nowMs;
  return ledger;
}

export class RemoteDispatchLedgerRepository {
  constructor(chromeApi, { projectId = '' } = {}) {
    this.chrome = chromeApi;
    this.projectId = projectId;
    this.updateQueue = Promise.resolve();
  }

  async load() {
    const record = await this.chrome.storage.local.get(REMOTE_DISPATCH_LEDGER_STORAGE_KEY);
    return migrateRemoteDispatchLedger(record[REMOTE_DISPATCH_LEDGER_STORAGE_KEY], { projectId: this.projectId });
  }

  async save(ledger) {
    validateRemoteDispatchLedger(ledger);
    if (this.projectId && ledger.projectId && ledger.projectId !== this.projectId) throw new Error('Refusing to save another project ledger');
    if (this.projectId && !ledger.projectId) ledger.projectId = this.projectId;
    await this.chrome.storage.local.set({ [REMOTE_DISPATCH_LEDGER_STORAGE_KEY]: ledger });
    return ledger;
  }

  update(mutator, { nowMs = Date.now() } = {}) {
    const operation = this.updateQueue.then(async () => {
      const current = await this.load();
      const draft = structuredClone(current);
      const next = await mutator(draft) || draft;
      next.revision = current.revision + 1;
      next.updatedAt = nowMs;
      return this.save(next);
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }
}
