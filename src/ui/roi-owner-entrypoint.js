/**
 * Plan 7 production options-entry read-only bridge.
 * This is NOT an ROI data store, cache, permission or automation authority.
 * Core GET_ROI_OWNER_ADVISORY remains optional until trusted persisted
 * evidence is wired by its canonical owner. Unavailable data is OFFLINE.
 */
import { renderRoiOwnerViewV1 } from './roi-owner-view.js';

const revisions = new WeakMap();
const OFFLINE_ROI = Object.freeze({
  schemaVersion: 1,
  status: 'OFFLINE',
  statusText: 'Немає свіжих локальних доказів',
  reportId: null,
  observedRunCount: 0,
  verifiedOutcomeCount: 0,
  opportunities: Object.freeze([]),
  recommendationAuthorized: false,
  deploymentAuthorized: false,
  telemetryEmitted: false,
});

export async function refreshRoiOwnerPanelV1(container, readCanonicalRoi, timeoutMs = 3500) {
  if (!container || typeof readCanonicalRoi !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) {
    throw new Error('Invalid bounded ROI owner read');
  }
  const generation = (revisions.get(container) || 0) + 1;
  revisions.set(container, generation);
  // Clear old numbers immediately: stale previously verified evidence cannot
  // masquerade as a fresh assessment after connectivity loss or restart.
  renderRoiOwnerViewV1(container, OFFLINE_ROI);
  let timeout;
  try {
    const report = await Promise.race([
      Promise.resolve().then(readCanonicalRoi),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('ROI read timeout')), timeoutMs);
      }),
    ]);
    if (revisions.get(container) !== generation) return 'STALE_IGNORED';
    // All malformed/hostile reports fail closed to offline without echoing
    // private provider/verification exceptions to an NVDA live region.
    try {
      renderRoiOwnerViewV1(container, report);
      return 'EVIDENCE';
    } catch {
      renderRoiOwnerViewV1(container, OFFLINE_ROI);
      return 'OFFLINE';
    }
  } catch {
    if (revisions.get(container) !== generation) return 'STALE_IGNORED';
    renderRoiOwnerViewV1(container, OFFLINE_ROI);
    return 'OFFLINE';
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
