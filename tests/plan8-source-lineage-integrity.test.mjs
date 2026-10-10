import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PLAN8_ARCHIVE_SHA256, PLAN8_SOURCE_VERSION, verifyPlan8Lineage,
} from '../scripts/verify-plan8-lineage.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-p8-source-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args],
    { encoding: 'utf8', stdio: 'pipe' }).trim();
  const put = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), value, 'utf8');
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'plan8-tests@example.invalid');
  git('config', 'user.name', 'Plan 8 Test');
  const version = JSON.stringify({ version: PLAN8_SOURCE_VERSION });
  put('manifest.json', version);
  put('package.json', version);
  put('PLAN8_11_0_13_SOURCE_CONVERGENCE.md',
    'Audited source archive SHA-256: ' + PLAN8_ARCHIVE_SHA256 + '\n');
  for (const path of [
    'src/core/browser-agent-manager.js', 'src/core/orchestration-v2-manager.js',
    'src/background/service-worker.js', 'companion/ai-gateway/gateway.mjs',
    '.github/workflows/release-package.yml',
  ]) put(path, '/* canonical placeholder for lineage-only fixture */\n');
  git('add', '.');
  git('commit', '-m', '11.0.13 source baseline');
  const baseline = git('rev-parse', 'HEAD');
  put('integration-marker.txt', 'safe main-only integration\n');
  git('add', '.');
  git('commit', '-m', 'Converge source into candidate');
  return {
    root, git, put, baseline,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withFixture(run) {
  const f = fixture();
  try { return run(f); } finally { f.close(); }
}

test('canonical source ancestor, 11.0.13 manifests and audited provenance pass', () => withFixture(f => {
  const result = verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline });
  assert.equal(result.sourceAncestry, 'verified');
  assert.equal(result.version, PLAN8_SOURCE_VERSION);
  assert.equal(result.archivedSha256, PLAN8_ARCHIVE_SHA256);
  assert.equal(result.driveArchiveBytesRehashed, false);
  assert.equal(Object.isFrozen(result), true);
}));

test('JSON-compatible cold restart preserves legitimate source lineage', () => withFixture(f => {
  for (const path of ['manifest.json', 'package.json']) {
    f.put(path, JSON.stringify(JSON.parse(readFileSync(join(f.root, path), 'utf8'))));
  }
  assert.equal(verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline }).sourceAncestry, 'verified');
}));

test('0.9.x downgrade or package/manifest drift fails closed', () => withFixture(f => {
  f.put('manifest.json', JSON.stringify({ version: '0.9.19' }));
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline }), /manifest.json version/u);
  f.put('manifest.json', JSON.stringify({ version: PLAN8_SOURCE_VERSION }));
  f.put('package.json', JSON.stringify({ version: '11.0.12' }));
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline }), /package.json version/u);
}));

test('forged digest, missing integration paths and malformed JSON reject', () => withFixture(f => {
  f.put('PLAN8_11_0_13_SOURCE_CONVERGENCE.md', 'Unverified archive!');
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline }), /archive digest/u);
  f.put('PLAN8_11_0_13_SOURCE_CONVERGENCE.md', PLAN8_ARCHIVE_SHA256);
  rmSync(join(f.root, 'src/core/browser-agent-manager.js'));
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline }), /source path missing/u);
  f.put('src/core/browser-agent-manager.js', 'restored');
  f.put('manifest.json', '{broken');
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline }), /not valid JSON/u);
}));

test('unrelated or unknown commit cannot impersonate reachable 11.x baseline', () => withFixture(f => {
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: 'f'.repeat(40) }), /not an ancestor/u);
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: '../not-a-sha' }), /full lowercase Git SHA/u);
}));

test('invalid source ancestor version fails despite current 11.x head', () => withFixture(f => {
  f.put('manifest.json', JSON.stringify({ version: '0.9.19' }));
  f.git('add', '.');
  f.git('commit', '-m', 'Current downgrade');
  const priorVersion = f.git('rev-parse', 'HEAD');
  f.put('manifest.json', JSON.stringify({ version: PLAN8_SOURCE_VERSION }));
  f.git('add', '.');
  f.git('commit', '-m', 'Restore current version');
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: priorVersion }),
    /source ancestor manifest.json version/u);
}));

test('an untracked replacement cannot impersonate a source blob deleted from candidate HEAD', () => withFixture(f => {
  const path = 'src/core/browser-agent-manager.js';
  f.git('rm', path);
  f.git('commit', '-m', 'Remove canonical source blob');
  f.put(path, '/* untracked file impersonating canonical source */\n');
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline }),
    /candidate HEAD missing regular tracked 11\.x source path/u);
}));

test('candidate recovery cannot retroactively invent a missing source-ancestor blob', () => withFixture(f => {
  const path = 'src/core/orchestration-v2-manager.js';
  f.git('rm', path);
  f.git('commit', '-m', 'Remove source ancestor blob');
  const incompleteAncestor = f.git('rev-parse', 'HEAD');
  f.put(path, '/* candidate restored path without original source lineage */\n');
  f.git('add', path);
  f.git('commit', '-m', 'Restore candidate path');
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: incompleteAncestor }),
    /source ancestor missing regular tracked 11\.x source path/u);
}));
