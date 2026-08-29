import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_NAME,
  buildReleasePackage,
  collectProductFiles,
} from '../../scripts/package-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('release allowlist contains only manifest.json and product src files', async () => {
  const { manifest, files } = await collectProductFiles(root);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '0.1.0');
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('src/background/service-worker.js'));
  assert.ok(files.includes('src/ui/options.html'));
  assert.ok(files.includes('src/interaction/content-script.js'));
  assert.ok(files.every(file => file === 'manifest.json' || file.startsWith('src/')));
  assert.ok(!files.includes('package.json'));
  assert.ok(!files.some(file => file.startsWith('tests/')));
  assert.ok(!files.some(file => file.startsWith('.github/')));
});

test('release ZIP is byte-for-byte reproducible and has one canonical root folder', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-release-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));

  const first = await buildReleasePackage({ root, outDir: path.join(temp, 'one') });
  const second = await buildReleasePackage({ root, outDir: path.join(temp, 'two') });
  const firstZip = await fs.readFile(first.zipPath);
  const secondZip = await fs.readFile(second.zipPath);

  assert.equal(first.sha256, sha256(firstZip));
  assert.equal(second.sha256, sha256(secondZip));
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first.files, second.files);
  assert.ok(firstZip.includes(Buffer.from(`${RELEASE_NAME}/manifest.json`, 'utf8')));
  assert.ok(firstZip.includes(Buffer.from(`${RELEASE_NAME}/src/background/service-worker.js`, 'utf8')));
  assert.ok(!firstZip.includes(Buffer.from(`${RELEASE_NAME}/package.json`, 'utf8')));

  const unpackedRootEntries = (await fs.readdir(first.unpackedDir)).sort();
  assert.deepEqual(unpackedRootEntries, ['manifest.json', 'src']);
});
