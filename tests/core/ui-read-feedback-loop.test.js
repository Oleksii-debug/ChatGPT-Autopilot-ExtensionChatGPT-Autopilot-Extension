import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../../src/background/service-worker.js'), 'utf8');

test('read-only UI commands do not reconcile runtime and broadcast STATUS_CHANGED back into their own reads', () => {
  assert.match(source, /const READ_ONLY_UI_COMMANDS = new Set\(\[/);
  for (const command of ['LIST_SESSIONS', 'GET_SESSION', 'GET_SNAPSHOT', 'PREVIEW_PORTABLE_PROFILE', 'EXPORT_PORTABLE_PROFILE']) {
    assert.match(source, new RegExp(`'${command}'`));
  }
  assert.match(source, /if \(!READ_ONLY_UI_COMMANDS\.has\(message\.command\)\) await reconcileRuntime\(\);/);
  assert.doesNotMatch(source, /const result = await dispatcher\.execute\([^;]+;\s*await reconcileRuntime\(\);\s*return result;/s);
});
