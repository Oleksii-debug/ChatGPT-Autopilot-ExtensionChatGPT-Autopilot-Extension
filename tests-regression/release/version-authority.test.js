import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RELEASE_VERSION } from '../../scripts/package-release.mjs';
import { SOURCE_VERSION } from '../../scripts/package-source.mjs';

async function text(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
}

test('release version has one authority across package, manifest and packagers', async () => {
  const packageJson = JSON.parse(await text('package.json'));
  const manifest = JSON.parse(await text('manifest.json'));
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(RELEASE_VERSION, packageJson.version);
  assert.equal(SOURCE_VERSION, packageJson.version);
  assert.equal(manifest.version, packageJson.version);
});

test('current release metadata files exist for the authoritative version', async () => {
  const packageJson = JSON.parse(await text('package.json'));
  const changes = await text(`CHANGES-${packageJson.version}.txt`);
  const qa = await text(`QA-${packageJson.version}.txt`);
  assert.match(changes, new RegExp(packageJson.version.replaceAll('.', '\\.')));
  assert.match(qa, new RegExp(packageJson.version.replaceAll('.', '\\.')));
});

test('release workflow derives candidate names from resolved version instead of frozen 0.9.19', async () => {
  const workflow = await text('.github/workflows/release-package.yml');
  assert.ok(workflow.includes('steps.release_meta.outputs.version'));
  assert.doesNotMatch(workflow, /ChatGPT-Autopilot-0\.9\.19(?:\.zip|-candidate)/u);
  assert.match(workflow, /QA-\*\.txt/u);
  assert.match(workflow, /scripts\/package-source\.mjs/u);
});
