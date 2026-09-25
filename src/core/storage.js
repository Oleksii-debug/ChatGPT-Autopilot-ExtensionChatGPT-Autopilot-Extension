import { STORAGE_KEY, createEmptyState, validateState, SCHEMA_VERSION } from './schema.js';

function migrateV1ToV2(raw, now) {
  const next = structuredClone(raw);
  next.schemaVersion = 2;
  next.diagnostics = [];
  next.migrationHistory = Array.isArray(next.migrationHistory) ? next.migrationHistory : [];
  next.migrationHistory.push({ from: 1, to: 2, at: now });
  return next;
}

function migrateRateLimitReserve(raw) {
  if (!raw.profile || typeof raw.profile !== 'object' || Array.isArray(raw.profile)) return raw;
  if (raw.profile.rateLimitReservePolicyVersion === 1) return raw;
  const next = structuredClone(raw);
  const oldDefault = Number(next.profile.rateLimitCooldownMs) === 5 * 60 * 1000;
  if (oldDefault || next.profile.rateLimitCooldownMs === undefined) {
    const oldGate = Number(next.profile.rateLimitUntil || 0);
    next.profile.rateLimitCooldownMs = 0;
    next.profile.rateLimitUntil = 0;
    if (oldGate > 0) {
      for (const session of Object.values(next.sessionsById || {})) {
        for (const task of Object.values(session.tasksById || {})) {
          if (task.retryAfterAt === oldGate && task.status === 'RATE_LIMITED') task.retryAfterAt = 0;
        }
      }
    }
  }
  next.profile.rateLimitReservePolicyVersion = 1;
  return next;
}

export function migrateState(raw, now = Date.now()) {
  if (raw === undefined) return createEmptyState(now);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Stored state is corrupt');
  if (!Number.isInteger(raw.schemaVersion)) throw new Error('Stored state has an invalid schema version');
  if (raw.schemaVersion === SCHEMA_VERSION) return validateState(migrateRateLimitReserve(raw));
  if (raw.schemaVersion > SCHEMA_VERSION) throw new Error('State was created by a newer extension version');
  if (raw.schemaVersion === 1) return validateState(migrateRateLimitReserve(migrateV1ToV2(raw, now)));
  throw new Error(`No migration path from schema ${raw.schemaVersion}`);
}

export class StorageRepository {
  constructor(chromeApi) {
    this.chrome = chromeApi;
    this.updateQueue = Promise.resolve();
  }
  async load() {
    const record = await this.chrome.storage.local.get(STORAGE_KEY);
    return migrateState(record[STORAGE_KEY]);
  }
  async save(state) {
    validateState(state);
    await this.chrome.storage.local.set({ [STORAGE_KEY]: state });
    return state;
  }
  update(mutator) {
    const operation = this.updateQueue.then(async () => {
      const current = await this.load();
      const draft = structuredClone(current);
      const next = await mutator(draft) || draft;
      next.revision = current.revision + 1;
      return this.save(next);
    });
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }
}
