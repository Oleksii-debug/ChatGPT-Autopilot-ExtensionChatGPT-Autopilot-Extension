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

async function writeLineEndingVariant(targetRoot, files, lineEnding) {
  const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.txt']);
  for (const relativePath of files) {
    const source = await fs.readFile(path.join(root, relativePath));
    const destination = path.join(targetRoot, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (!textExtensions.has(path.extname(relativePath).toLowerCase())) {
      await fs.writeFile(destination, source);
      continue;
    }
    const lf = source.toString('utf8').replace(/\r\n?/g, '\n');
    await fs.writeFile(destination, lineEnding === '\n' ? lf : lf.replaceAll('\n', lineEnding), 'utf8');
  }
}

test('release allowlist contains README, manifest.json and product src files only', async () => {
  const { manifest, files } = await collectProductFiles(root);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '0.1.0');
  assert.ok(files.includes('README.txt'));
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('src/background/service-worker.js'));
  assert.ok(files.includes('src/ui/options.html'));
  assert.ok(files.includes('src/interaction/content-script.js'));
  assert.ok(files.every(file => file === 'README.txt' || file === 'manifest.json' || file.startsWith('src/')));
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
  assert.ok(firstZip.includes(Buffer.from(`${RELEASE_NAME}/README.txt`, 'utf8')));
  assert.ok(firstZip.includes(Buffer.from(`${RELEASE_NAME}/manifest.json`, 'utf8')));
  assert.ok(firstZip.includes(Buffer.from(`${RELEASE_NAME}/src/background/service-worker.js`, 'utf8')));
  assert.ok(!firstZip.includes(Buffer.from(`${RELEASE_NAME}/package.json`, 'utf8')));

  const unpackedRootEntries = (await fs.readdir(first.unpackedDir)).sort();
  assert.deepEqual(unpackedRootEntries, ['README.txt', 'manifest.json', 'src']);
});

test('release ZIP and unpacked files are identical across LF and Windows CRLF checkouts', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-release-eol-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const { files } = await collectProductFiles(root);
  const lfRoot = path.join(temp, 'source-lf');
  const crlfRoot = path.join(temp, 'source-crlf');
  await writeLineEndingVariant(lfRoot, files, '\n');
  await writeLineEndingVariant(crlfRoot, files, '\r\n');

  const lf = await buildReleasePackage({ root: lfRoot, outDir: path.join(temp, 'out-lf') });
  const crlf = await buildReleasePackage({ root: crlfRoot, outDir: path.join(temp, 'out-crlf') });
  const lfZip = await fs.readFile(lf.zipPath);
  const crlfZip = await fs.readFile(crlf.zipPath);

  assert.equal(lf.sha256, crlf.sha256);
  assert.deepEqual(lfZip, crlfZip);
  for (const relativePath of ['README.txt', 'manifest.json', 'src/ui/options.js']) {
    const lfFile = await fs.readFile(path.join(lf.unpackedDir, relativePath));
    const crlfFile = await fs.readFile(path.join(crlf.unpackedDir, relativePath));
    assert.deepEqual(lfFile, crlfFile);
    assert.equal(lfFile.includes(Buffer.from('\r', 'utf8')), false, `${relativePath} must use canonical LF bytes`);
  }
});
