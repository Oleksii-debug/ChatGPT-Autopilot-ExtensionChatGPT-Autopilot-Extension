import { RunState } from './schema.js';
import { getDriveAccessToken } from './drive-auth.js';
import { readAuthorizedDriveSnapshot } from './drive-api.js';
import { acceptDriveSnapshot, getDriveSourceConfig, nextDriveSyncAt, recordDriveSyncCheck } from './drive-source.js';

const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);

export function computeNextDriveWake(state, now = Date.now()) {
  let earliest = Infinity;
  for (const [sessionId, session] of Object.entries(state?.sessionsById || {})) {
    if (!ACTIVE_STATES.has(session.runState)) continue;
    let wakeAt = null;
    try {
      wakeAt = nextDriveSyncAt(state, sessionId, now);
    } catch {
      wakeAt = null;
    }
    if (wakeAt != null) earliest = Math.min(earliest, Math.max(now, wakeAt));
  }
  return earliest < Infinity ? earliest : null;
}

export async function syncDueDriveSources({
  repository,
  chromeApi,
  now = () => Date.now(),
  readSnapshot = readAuthorizedDriveSnapshot,
  getAccessToken = getDriveAccessToken,
} = {}) {
  if (!repository || !chromeApi) throw new Error('Drive sync dependencies are required');
  const snapshot = await repository.load();
  const due = [];
  const at = now();

  for (const [sessionId, session] of Object.entries(snapshot.sessionsById || {})) {
    if (!ACTIVE_STATES.has(session.runState)) continue;
    let source;
    try {
      source = getDriveSourceConfig(snapshot, sessionId);
    } catch {
      continue;
    }
    if (!source.fileId || !source.autoSyncEnabled) continue;
    const wakeAt = nextDriveSyncAt(snapshot, sessionId, at);
    if (wakeAt != null && wakeAt <= at) due.push({ sessionId, fileId: source.fileId });
  }

  if (!due.length) return { checked: 0, accepted: 0, errors: [] };

  let token;
  try {
    token = await getAccessToken(chromeApi, { interactive: false });
  } catch (error) {
    const message = error?.code || error?.message || 'DRIVE_AUTH_FAILED';
    for (const item of due) {
      await repository.update(draft => {
        const source = getDriveSourceConfig(draft, item.sessionId);
        if (source.fileId !== item.fileId) return draft;
        recordDriveSyncCheck(draft, item.sessionId, { at, error: message });
        return draft;
      });
    }
    return {
      checked: due.length,
      accepted: 0,
      errors: due.map(item => ({ sessionId: item.sessionId, code: message })),
    };
  }

  let accepted = 0;
  const errors = [];
  for (const item of due) {
    try {
      const driveSnapshot = await readSnapshot({ fileId: item.fileId, accessToken: token });
      let result = null;
      await repository.update(draft => {
        const source = getDriveSourceConfig(draft, item.sessionId);
        if (source.fileId !== item.fileId || !source.autoSyncEnabled) return draft;
        result = acceptDriveSnapshot(draft, item.sessionId, driveSnapshot, { now: at });
        if (result?.accepted === false) recordDriveSyncCheck(draft, item.sessionId, { at, error: '' });
        return draft;
      });
      if (result?.accepted) accepted += 1;
    } catch (error) {
      const message = error?.code || error?.message || 'DRIVE_SYNC_FAILED';
      errors.push({ sessionId: item.sessionId, code: message });
      await repository.update(draft => {
        const source = getDriveSourceConfig(draft, item.sessionId);
        if (source.fileId !== item.fileId) return draft;
        recordDriveSyncCheck(draft, item.sessionId, { at, error: message });
        return draft;
      });
    }
  }
  return { checked: due.length, accepted, errors };
}
