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
  // The real predecessor has a distinct main-only send-recovery source blob.
  put('src/interaction/chatgpt-live-send-recovery.js', '/* predecessor-only recovery */\n');
  git('add', '.');
  git('commit', '-m', 'Preserve previous main-only recovery source');
  const mainAncestor = git('rev-parse', 'HEAD');
  put('integration-marker.txt', 'safe main-only integration\n');
  git('add', '.');
  git('commit', '-m', 'Converge source into candidate');
  return {
    root, git, put, baseline, mainAncestor,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withFixture(run) {
  const f = fixture();
  try { return run(f); } finally { f.close(); }
}

test('canonical source ancestor, 11.0.13 manifests and audited provenance pass', () => withFixture(f => {
  const result = verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor });
  assert.equal(result.sourceAncestry, 'verified');
  assert.equal(result.mainAncestry, 'verified');
  assert.equal(result.mainAncestorCommit, f.mainAncestor);
  assert.equal(result.version, PLAN8_SOURCE_VERSION);
  assert.equal(result.archivedSha256, PLAN8_ARCHIVE_SHA256);
  assert.equal(result.driveArchiveBytesRehashed, false);
  assert.equal(Object.isFrozen(result), true);
}));

test('JSON-compatible cold restart preserves legitimate source lineage', () => withFixture(f => {
  for (const path of ['manifest.json', 'package.json']) {
    f.put(path, JSON.stringify(JSON.parse(readFileSync(join(f.root, path), 'utf8'))));
  }
  assert.equal(verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }).sourceAncestry, 'verified');
}));

test('0.9.x downgrade or package/manifest drift fails closed', () => withFixture(f => {
  f.put('manifest.json', JSON.stringify({ version: '0.9.19' }));
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }), /manifest.json version/u);
  f.put('manifest.json', JSON.stringify({ version: PLAN8_SOURCE_VERSION }));
  f.put('package.json', JSON.stringify({ version: '11.0.12' }));
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }), /package.json version/u);
}));

test('forged digest, missing integration paths and malformed JSON reject', () => withFixture(f => {
  f.put('PLAN8_11_0_13_SOURCE_CONVERGENCE.md', 'Unverified archive!');
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }), /archive digest/u);
  f.put('PLAN8_11_0_13_SOURCE_CONVERGENCE.md', PLAN8_ARCHIVE_SHA256);
  rmSync(join(f.root, 'src/core/browser-agent-manager.js'));
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }), /source path missing/u);
  f.put('src/core/browser-agent-manager.js', 'restored');
  f.put('manifest.json', '{broken');
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }), /not valid JSON/u);
}));

test('unrelated or unknown commit cannot impersonate reachable 11.x baseline', () => withFixture(f => {
  // A real unrelated commit may contain the exact expected tree and version:
  // the source must still be an ancestor, not merely a plausible Git blob.
  const independent = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'),
    '-m', 'independent 11.x source impersonator');
  assert.match(independent, /^[0-9a-f]{40}$/u);
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: independent }), /not an ancestor/u);
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
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: priorVersion, mainAncestorCommit: f.mainAncestor }),
    /source ancestor manifest.json version/u);
}));

test('an untracked replacement cannot impersonate a source blob deleted from candidate HEAD', () => withFixture(f => {
  const path = 'src/core/browser-agent-manager.js';
  f.git('rm', path);
  f.git('commit', '-m', 'Remove canonical source blob');
  f.put(path, '/* untracked file impersonating canonical source */\n');
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }),
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
  assert.throws(() => verifyPlan8Lineage({ root: f.root, sourceCommit: incompleteAncestor, mainAncestorCommit: f.mainAncestor }),
    /source ancestor missing regular tracked 11\.x source path/u);
}));


test('tracked candidate HEAD downgrade cannot be concealed by unstaged 11.x files', () => withFixture(f => {
  for (const path of ['manifest.json', 'package.json']) {
    f.put(path, JSON.stringify({ version: '0.9.19' }));
    f.git('add', path);
    f.git('commit', '-m', 'Downgrade committed ' + path);
    // The checkout looks correct, but the shipped HEAD does not.
    f.put(path, JSON.stringify({ version: PLAN8_SOURCE_VERSION }));
    assert.throws(() => verifyPlan8Lineage({ root: f.root,
      sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }),
      new RegExp('candidate HEAD ' + path.replace('.', '\\.') + ' version', 'u'));
    // Restore clean committed 11.x lineage before trying the next file.
    f.git('add', path);
    f.git('commit', '-m', 'Restore committed ' + path);
  }
}));

test('source-only candidate cannot impersonate the preserved predecessor history', () => withFixture(f => {
  f.git('checkout', '-b', 'source-only-candidate', f.baseline);
  assert.throws(() => verifyPlan8Lineage({ root: f.root,
    sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }),
  /canonical main ancestor .* is not an ancestor/u);
}));

test('deleted main-only recovery source cannot be replaced by an untracked file', () => withFixture(f => {
  const path = 'src/interaction/chatgpt-live-send-recovery.js';
  f.git('rm', path);
  f.git('commit', '-m', 'Accidentally erase main-only recovery');
  f.put(path, '/* untracked forged recovery */\n');
  assert.throws(() => verifyPlan8Lineage({ root: f.root,
    sourceCommit: f.baseline, mainAncestorCommit: f.mainAncestor }),
  /candidate HEAD missing regular tracked 11\.x source path/u);
}));

test('unrelated main predecessor cannot substitute identical candidate tree contents', () => withFixture(f => {
  const stranger = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'),
    '-m', 'forged predecessor with identical tree');
  assert.throws(() => verifyPlan8Lineage({ root: f.root,
    sourceCommit: f.baseline, mainAncestorCommit: stranger }),
  /canonical main ancestor .* is not an ancestor/u);
}));
