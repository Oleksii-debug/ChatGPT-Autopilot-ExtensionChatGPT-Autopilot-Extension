import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageRepository } from '../../src/core/storage.js';

function chromeWithStoredNull() {
  const db = { autopilotState: null };
  let writes = 0;
  return {
    db,
    writes: () => writes,
    chrome: {
      storage: {
        local: {
          get: async key => ({ [key]: db[key] }),
          set: async record => {
            writes += 1;
            Object.assign(db, structuredClone(record));
          },
        },
      },
    },
  };
}

test('persisted null state fails closed instead of bootstrapping an empty install', async () => {
  const { chrome, db, writes } = chromeWithStoredNull();
  const repo = new StorageRepository(chrome);

  await assert.rejects(() => repo.load(), /Stored state is corrupt/);
  assert.equal(db.autopilotState, null);
  assert.equal(writes(), 0);
});
