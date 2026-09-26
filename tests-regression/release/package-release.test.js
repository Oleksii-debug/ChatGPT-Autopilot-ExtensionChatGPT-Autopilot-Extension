import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_NAME,
  RELEASE_VERSION,
  buildReleasePackage,
  collectProductFiles,
} from '../../scripts/package-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function writeLineEndingVariant(targetRoot, files, lineEnding) {
  const textExtensions = new Set(['.cmd', '.cs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.txt']);
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

test('release version is coherent across manifest, package metadata and README', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const readme = await fs.readFile(path.join(root, 'README.txt'), 'utf8');
  assert.equal(manifest.version, RELEASE_VERSION);
  assert.equal(packageMetadata.version, manifest.version);
  assert.match(readme.split(/\r?\n/, 1)[0], new RegExp(`^${manifest.version_name} ПІЛОТ\\b`, 'u'));
});

test('release allowlist contains release docs, extension files and complete companion distribution only', async () => {
  const { manifest, files } = await collectProductFiles(root);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, RELEASE_VERSION);
  assert.ok(files.includes('README.txt'));
  assert.ok(files.includes(`CHANGES-${RELEASE_VERSION}.txt`));
  assert.ok(files.includes(`QA-${RELEASE_VERSION}.txt`));
  assert.ok(files.includes('manifest.json'));
  assert.ok(files.includes('icons/icon128.png'));
  assert.ok(files.includes('src/background/service-worker.js'));
  assert.ok(files.includes('src/ui/options.html'));
  assert.ok(files.includes('src/interaction/content-script.js'));
  assert.ok(files.includes('companion/native-host/host.mjs'));
  assert.ok(files.includes('companion/native-host/credential-broker.mjs'));
  assert.ok(files.includes('companion/native-host/ВСТАНОВИТИ NATIVE COMPANION.ps1'));
  assert.ok(files.includes('companion/ai-gateway/gateway.mjs'));
  assert.ok(files.every(file => file === 'README.txt' || file === `CHANGES-${RELEASE_VERSION}.txt` || file === `QA-${RELEASE_VERSION}.txt` || file === 'manifest.json' || file.startsWith('companion/') || file.startsWith('icons/') || file.startsWith('src/')));
  assert.ok(!files.includes('package.json'));
  assert.ok(!files.some(file => file.startsWith('tests/')));
  assert.ok(!files.some(file => file.startsWith('.github/')));
  assert.ok(!files.some(file => /\.(?:dpapi|p12|pfx|pem|key)$/i.test(file)));
  assert.ok(!files.some(file => /(?:^|\/)(?:credentials|secrets|private-data)(?:\/|$)/i.test(file)));
});


test('release rejects top-level file and directory symlinks before source traversal', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-release-symlink-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const { files } = await collectProductFiles(root);
  const fixtureRoot = path.join(temp, 'source');
  await writeLineEndingVariant(fixtureRoot, files, '\n');

  const originalSrc = path.join(fixtureRoot, 'src');
  const outsideSrc = path.join(temp, 'outside-src');
  await fs.rename(originalSrc, outsideSrc);
  try {
    await fs.symlink(outsideSrc, originalSrc, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symbolic links are unavailable on this platform: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => collectProductFiles(fixtureRoot),
    /Release source must not contain symlinks: src/,
  );

  await fs.rm(originalSrc, { force: true });
  await fs.rename(outsideSrc, originalSrc);

  const originalReadme = path.join(fixtureRoot, 'README.txt');
  const outsideReadme = path.join(temp, 'outside-readme.txt');
  await fs.rename(originalReadme, outsideReadme);
  await fs.symlink(outsideReadme, originalReadme, 'file');

  await assert.rejects(
    () => collectProductFiles(fixtureRoot),
    /Release source must not contain symlinks: README\.txt/,
  );
});


test('release fails closed on NUL bytes in packaged text sources', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-release-nul-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const { files } = await collectProductFiles(root);
  const fixtureRoot = path.join(temp, 'source');
  await writeLineEndingVariant(fixtureRoot, files, '\n');

  await fs.writeFile(
    path.join(fixtureRoot, 'README.txt'),
    Buffer.concat([
      Buffer.from(`ChatGPT Autopilot ${RELEASE_VERSION}\n`, 'utf8'),
      Buffer.from([0]),
      Buffer.from('sk-example-secret-material-abcdefghijklmnopqrstuvwxyz', 'utf8'),
    ]),
  );

  await assert.rejects(
    () => collectProductFiles(fixtureRoot),
    /NUL byte found in packaged text source: README\.txt/,
  );
});


test('release fails closed on NUL bytes in packaged YAML text sources', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-release-yaml-nul-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const { files } = await collectProductFiles(root);
  const fixtureRoot = path.join(temp, 'source');
  await writeLineEndingVariant(fixtureRoot, files, '\n');

  const yamlPath = path.join(fixtureRoot, 'src', 'benign-config.yaml');
  await fs.writeFile(
    yamlPath,
    Buffer.concat([
      Buffer.from('fixture: true\ncomment: harmless-prefix\n', 'utf8'),
      Buffer.from([0]),
      Buffer.from('sk-example-secret-material-abcdefghijklmnopqrstuvwxyz\n', 'utf8'),
    ]),
  );

  await assert.rejects(
    () => collectProductFiles(fixtureRoot),
    /NUL byte found in packaged text source: src\/benign-config\.yaml/,
  );
});


test('release rejects common credential data filenames even when their contents look benign', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-release-credential-files-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const { files } = await collectProductFiles(root);
  const fixtureRoot = path.join(temp, 'source');
  await writeLineEndingVariant(fixtureRoot, files, '\n');

  const tokenPath = path.join(fixtureRoot, 'companion', 'token.json');
  await fs.writeFile(tokenPath, '{"fixture":true}\n', 'utf8');
  await assert.rejects(
    () => collectProductFiles(fixtureRoot),
    /Forbidden private\/sensitive path in release package: companion\/token\.json/,
  );
  await fs.rm(tokenPath);

  const credentialsPath = path.join(fixtureRoot, 'src', 'credentials.json');
  await fs.writeFile(credentialsPath, '{"fixture":true}\n', 'utf8');
  await assert.rejects(
    () => collectProductFiles(fixtureRoot),
    /Forbidden private\/sensitive path in release package: src\/credentials\.json/,
  );
  await fs.rm(credentialsPath);

  const googleClientPath = path.join(
    fixtureRoot,
    'companion',
    'client_secret_123.apps.googleusercontent.com.json',
  );
  await fs.writeFile(googleClientPath, '{"installed":{"client_id":"fixture","client_secret":"benign-looking"}}\n', 'utf8');
  await assert.rejects(
    () => collectProductFiles(fixtureRoot),
    /Forbidden private\/sensitive path in release package: companion\/client_secret_123\.apps\.googleusercontent\.com\.json/,
  );
  await fs.rm(googleClientPath);

  const oauthClientPath = path.join(fixtureRoot, 'src', 'oauth2-client-prod.yaml');
  await fs.writeFile(oauthClientPath, 'client: fixture\nsecret: benign-looking\n', 'utf8');
  await assert.rejects(
    () => collectProductFiles(fixtureRoot),
    /Forbidden private\/sensitive path in release package: src\/oauth2-client-prod\.yaml/,
  );
});

test('release build packages the exact validated byte snapshot even if source paths mutate after scan', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'autopilot-release-snapshot-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const { files } = await collectProductFiles(root);
  const fixtureRoot = path.join(temp, 'source');
  await writeLineEndingVariant(fixtureRoot, files, '\n');

  const readmePath = path.join(fixtureRoot, 'README.txt');
  const originalReadme = await fs.readFile(readmePath);
  const triggerPath = path.resolve(fixtureRoot, files.at(-1));
  const mutated = Buffer.from('MUTATED_AFTER_VALIDATION_SENTINEL\n', 'utf8');
  const originalReadFile = fs.readFile.bind(fs);
  let armed = true;
  fs.readFile = async (...args) => {
    const data = await originalReadFile(...args);
    const requested = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
    if (armed && requested === triggerPath) {
      armed = false;
      await fs.writeFile(readmePath, mutated);
    }
    return data;
  };
  t.after(() => { fs.readFile = originalReadFile; });

  const built = await buildReleasePackage({ root: fixtureRoot, outDir: path.join(temp, 'out') });
  fs.readFile = originalReadFile;

  assert.equal(armed, false, 'fixture must mutate a previously validated source before collectProductFiles returns');
  assert.deepEqual(await fs.readFile(path.join(built.unpackedDir, 'README.txt')), originalReadme);
  const zip = await fs.readFile(built.zipPath);
  assert.equal(zip.includes(mutated), false, 'post-validation source bytes must not enter the ZIP');
  assert.equal(zip.includes(originalReadme), true, 'ZIP must contain the validated README snapshot');
  assert.deepEqual(await fs.readFile(readmePath), mutated, 'fixture must prove the source path really changed after validation');
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
  assert.ok(firstZip.includes(Buffer.from(`${RELEASE_NAME}/companion/native-host/host.mjs`, 'utf8')));
  assert.ok(firstZip.includes(Buffer.from(`${RELEASE_NAME}/companion/native-host/credential-broker.mjs`, 'utf8')));
  assert.ok(firstZip.includes(Buffer.from(`${RELEASE_NAME}/companion/native-host/ВСТАНОВИТИ NATIVE COMPANION.ps1`, 'utf8')));
  assert.ok(firstZip.includes(Buffer.from(`${RELEASE_NAME}/companion/ai-gateway/gateway.mjs`, 'utf8')));
  assert.ok(!firstZip.includes(Buffer.from(`${RELEASE_NAME}/package.json`, 'utf8')));

  const unpackedRootEntries = (await fs.readdir(first.unpackedDir)).sort();
  assert.deepEqual(unpackedRootEntries, [`CHANGES-${RELEASE_VERSION}.txt`, `QA-${RELEASE_VERSION}.txt`, 'README.txt', 'companion', 'icons', 'manifest.json', 'src'].sort());
  assert.ok(!first.files.some(file => /(?:^|\/)(?:Nika|Chess|night|profile).*\.json$/i.test(file)), 'release must not contain ready-to-import session profile JSONs');
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
  for (const relativePath of ['README.txt', 'manifest.json', 'src/ui/options.js', 'companion/native-host/ВСТАНОВИТИ NATIVE COMPANION.ps1', 'companion/native-host/NativeHostLauncher.cs', 'companion/ai-gateway/ЗАПУСТИТИ GATEWAY.cmd']) {
    const lfFile = await fs.readFile(path.join(lf.unpackedDir, relativePath));
    const crlfFile = await fs.readFile(path.join(crlf.unpackedDir, relativePath));
    assert.deepEqual(lfFile, crlfFile);
    assert.equal(lfFile.includes(Buffer.from('\r', 'utf8')), false, `${relativePath} must use canonical LF bytes`);
  }
});
