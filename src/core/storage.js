import { STORAGE_KEY, createEmptyState, validateState, SCHEMA_VERSION } from './schema.js';

export function migrateState(raw, now = Date.now()) {
  if (raw === undefined) return createEmptyState(now);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Stored state is corrupt');
  if (!Number.isInteger(raw.schemaVersion)) throw new Error('Stored state has an invalid schema version');
  if (raw.schemaVersion === SCHEMA_VERSION) return validateState(raw);
  if (raw.schemaVersion > SCHEMA_VERSION) throw new Error('State was created by a newer extension version');
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
