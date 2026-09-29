import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listSiteAdapters } from '../../src/core/site-adapter-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function exactHttpsHost(pattern) {
  const match = /^https:\/\/([^/*]+)\/\*$/.exec(pattern);
  return match ? match[1].toLowerCase() : null;
}

test('every declared site-adapter host is covered by manifest host permission and content-script match', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
  const hostPermissionHosts = new Set((manifest.host_permissions || []).map(exactHttpsHost).filter(Boolean));
  const contentScriptHosts = new Set(
    (manifest.content_scripts || []).flatMap(block => block.matches || []).map(exactHttpsHost).filter(Boolean),
  );

  for (const adapter of listSiteAdapters()) {
    for (const host of adapter.hosts) {
      assert.equal(hostPermissionHosts.has(host), true, `${adapter.id} host ${host} lacks manifest host permission`);
      assert.equal(contentScriptHosts.has(host), true, `${adapter.id} host ${host} lacks manifest content-script match`);
    }
  }
});
