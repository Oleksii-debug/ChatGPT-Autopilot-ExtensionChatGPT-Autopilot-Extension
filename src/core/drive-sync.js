import { getDriveAccessToken } from './drive-auth.js';
import { readAuthorizedDriveSnapshot } from './drive-api.js';
import {
  acceptDriveSnapshot,
  dueDriveSourceSessionIds,
  getDriveSourceConfig,
  recordDriveSyncOutcome,
} from './drive-source.js';

function diagnostic(error) {
  const code = String(error?.code || error?.name || 'DRIVE_SYNC_FAILED').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return code || 'DRIVE_SYNC_FAILED';
}

export async function syncDueDriveSources({
  repository,
  chromeApi,
  now = () => Date.now(),
  getAccessToken = getDriveAccessToken,
  readSnapshot = readAuthorizedDriveSnapshot,
} = {}) {
  if (!repository || !chromeApi) throw new Error('Drive sync dependencies are required');
  const snapshot = await repository.load();
  const at = now();
  const due = dueDriveSourceSessionIds(snapshot, at);
  if (!due.length) return [];

  let token = '';
  let tokenError = null;
  let tokenAttempted = false;
  const results = [];

  for (const sessionId of due) {
    try {
      if (!tokenAttempted) {
        tokenAttempted = true;
        try {
          token = await getAccessToken(chromeApi, { interactive: false });
        } catch (error) {
          tokenError = error;
        }
      }
      if (tokenError) throw tokenError;
      const live = await repository.load();
      const source = getDriveSourceConfig(live, sessionId);
      const driveSnapshot = await readSnapshot({
        fileId: source.fileId,
        accessToken: token,
      });
      let acceptance = null;
      await repository.update(draft => {
        acceptance = acceptDriveSnapshot(draft, sessionId, driveSnapshot, { now: at });
        recordDriveSyncOutcome(draft, sessionId, { now: at });
        return draft;
      });
      results.push({
        sessionId,
        ok: true,
        accepted: acceptance?.accepted === true,
        reason: acceptance?.reason || '',
        version: driveSnapshot.version,
      });
    } catch (error) {
      const code = diagnostic(error);
      await repository.update(draft => {
        recordDriveSyncOutcome(draft, sessionId, { now: at, error: code });
        return draft;
      });
      results.push({ sessionId, ok: false, diagnosticCode: code });
    }
  }

  return results;
}
