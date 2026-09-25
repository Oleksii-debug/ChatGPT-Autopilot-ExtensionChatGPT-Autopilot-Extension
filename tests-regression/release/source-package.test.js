import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSourcePackage, collectSourceFiles, SOURCE_NAME } from '../../scripts/package-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const UKRAINIAN_COMPANION = 'companion/ai-gateway/ПІДГОТУВАТИ PORTABLE NODE.ps1';

function localEntries(zip) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const flags = zip.readUInt16LE(offset + 6);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString('utf8');
    entries.push({ name, flags });
    offset = nameStart + nameLength + extraLength + compressedSize;
  }
  return entries;
}

test('source package includes canonical Ukrainian Windows companion filename', async () => {
  const files = await collectSourceFiles(root);
  assert.ok(files.includes(UKRAINIAN_COMPANION));
  assert.ok(!files.some(file => file.startsWith('dist/') || file.startsWith('node_modules/') || file.startsWith('.git/')));
});

test('source ZIP is deterministic and marks every filename UTF-8', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-source-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const first = await buildSourcePackage({ root, outDir: path.join(temp, 'one') });
  const second = await buildSourcePackage({ root, outDir: path.join(temp, 'two') });
  const firstZip = await fs.readFile(first.zipPath);
  const secondZip = await fs.readFile(second.zipPath);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(firstZip, secondZip);
  const entries = localEntries(firstZip);
  assert.equal(entries.length, first.files.length);
  assert.ok(entries.every(entry => (entry.flags & 0x0800) !== 0), 'all source ZIP names must set the UTF-8 flag');
  assert.ok(entries.some(entry => entry.name === `${SOURCE_NAME}/${UKRAINIAN_COMPANION}`));
});
