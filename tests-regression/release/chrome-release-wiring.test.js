import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(root, '.github', 'workflows', 'release-package.yml');

test('Windows release package gate runs the canonical real-Chrome accessibility smoke before packaging', async () => {
  const workflow = await fs.readFile(workflowPath, 'utf8');
  const jobStart = workflow.indexOf('  windows-package:');
  assert.ok(jobStart >= 0, 'release workflow must define windows-package');
  const windowsJob = workflow.slice(jobStart);

  const smokeStep = windowsJob.indexOf('- name: Run real Chrome accessibility smoke on Windows');
  const chromeEnv = windowsJob.indexOf('$env:CHROMIUM_BIN = $chrome');
  const smokeCommand = windowsJob.indexOf('npm run test:chrome-ui');
  const buildStep = windowsJob.indexOf('- name: Build release candidate twice on Windows');
  const uploadStep = windowsJob.indexOf('- name: Upload Windows-built release candidate ZIP');

  assert.ok(smokeStep >= 0, 'Windows release job must contain the real-Chrome accessibility smoke step');
  assert.ok(chromeEnv > smokeStep, 'Windows smoke must bind the resolved executable through CHROMIUM_BIN');
  assert.ok(smokeCommand > chromeEnv, 'Windows smoke must invoke the canonical npm test:chrome-ui command');
  assert.ok(buildStep > smokeCommand, 'Chrome accessibility smoke must pass before candidate build');
  assert.ok(uploadStep > buildStep, 'candidate upload must remain after the package build');
  assert.match(
    windowsJob,
    /throw 'Google Chrome executable is unavailable on the Windows release runner'/u,
    'missing Chrome must fail the Windows release gate instead of silently skipping browser evidence',
  );
  assert.match(windowsJob, /Test-Path -LiteralPath \$_ -PathType Leaf/u);
});

test('release workflow cannot claim human or NVDA verification from the automated Chrome smoke', async () => {
  const workflow = await fs.readFile(workflowPath, 'utf8');
  const forbiddenClaims = [
    /NVDA_VERIFIED\s*=\s*true/iu,
    /HUMAN_TESTED\s*=\s*true/iu,
  ];
  for (const pattern of forbiddenClaims) {
    assert.equal(pattern.test(workflow), false, 'automated workflow must never mint human accessibility evidence');
  }
});
