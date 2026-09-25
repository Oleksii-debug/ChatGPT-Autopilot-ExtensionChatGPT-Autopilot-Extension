import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildStorePackage } from '../../scripts/package-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function pngDimensions(buffer) {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function localEntries(zip) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const start = offset + 30;
    const name = zip.subarray(start, start + nameLength).toString('utf8');
    entries.push(name);
    offset = start + nameLength + extraLength + compressedSize;
  }
  return entries;
}

test('manifest follows Chrome Web Store structural requirements used by this product', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name.length <= 45);
  assert.ok(manifest.description.length <= 132);
  assert.equal(manifest.content_security_policy?.extension_pages, "script-src 'self'; object-src 'self'");
  for (const size of [16, 32, 48, 128]) {
    const rel = manifest.icons?.[String(size)];
    assert.ok(rel, `manifest icon ${size} missing`);
    const image = await fs.readFile(path.join(root, rel));
    assert.deepEqual(pngDimensions(image), { width:size, height:size });
  }
  for (const size of [16, 32, 48]) assert.ok(manifest.action?.default_icon?.[String(size)]);
  assert.ok(manifest.permissions.includes('debugger'), 'native verified input uses chrome.debugger and must declare it');
  assert.ok(manifest.permissions.includes('scripting'), 'native target proof uses chrome.scripting');
  assert.ok(manifest.permissions.includes('tabs'), 'durable tab ownership/readiness uses chrome.tabs');
});

test('extension pages do not load remote scripts or evaluate fetched strings', async () => {
  const html = await fs.readFile(path.join(root, 'src/ui/options.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:\/\//i);
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes:true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.m?js$/i.test(entry.name)) files.push(full);
    }
  }
  await walk(path.join(root, 'src'));
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(source, /\beval\s*\(/, `remote/string eval is not allowed: ${path.relative(root, file)}`);
    assert.doesNotMatch(source, /\bnew\s+Function\s*\(/, `dynamic Function constructor is not allowed: ${path.relative(root, file)}`);
  }
});

test('CWS ZIP is deterministic and has manifest.json at ZIP root', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-cws-'));
  t.after(() => fs.rm(temp, { recursive:true, force:true }));
  const one = await buildStorePackage({ root, outDir:path.join(temp, 'one') });
  const two = await buildStorePackage({ root, outDir:path.join(temp, 'two') });
  const a = await fs.readFile(one.zipPath);
  const b = await fs.readFile(two.zipPath);
  assert.equal(one.sha256, two.sha256);
  assert.deepEqual(a, b);
  const entries = localEntries(a);
  assert.ok(entries.includes('manifest.json'));
  assert.ok(entries.includes('icons/icon128.png'));
  assert.ok(entries.includes('src/background/service-worker.js'));
  assert.equal(entries.some(name => name.startsWith('ChatGPT-Autopilot-')), false, 'CWS ZIP must not add a wrapper folder');
  assert.equal(entries.some(name => name === 'README.txt' || name.startsWith('QA-') || name.startsWith('CHANGES-')), false);
});
