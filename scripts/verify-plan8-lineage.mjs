import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAN8_ARCHIVE_SHA256 = 'ddf0527d03ca5b68c3b50e96dd3413e2d26afb0b7737ae3f502a3f960ae3c329';
export const PLAN8_SOURCE_COMMIT = 'ca7062e1f8e47b26d7e024c46bb432d341621dd4';
// Audited main-only predecessor; the source merge must preserve BOTH histories.
export const PLAN8_MAIN_ANCESTOR_COMMIT = '2000dd3571323f7c98c6fb67c9d4aa9ff395897f';
export const PLAN8_SOURCE_VERSION = '11.0.13';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ONLY_PATHS = ['src/interaction/chatgpt-live-send-recovery.js'];
const REQUIRED_PATHS = [
  'src/core/browser-agent-manager.js',
  'src/core/orchestration-v2-manager.js',
  'src/background/service-worker.js',
  'companion/ai-gateway/gateway.mjs',
  '.github/workflows/release-package.yml',
];

function assert(condition, message) {
  if (!condition) throw new Error('PLAN8_LINEAGE_INVALID: ' + message);
}

function parseVersion(text, label) {
  let object;
  try { object = JSON.parse(text); } catch {
    throw new Error('PLAN8_LINEAGE_INVALID: ' + label + ' is not valid JSON');
  }
  assert(object && typeof object === 'object' && !Array.isArray(object), label + ' is not an object');
  assert(object.version === PLAN8_SOURCE_VERSION,
    label + ' version must be ' + PLAN8_SOURCE_VERSION + ', got ' + String(object.version));
}

function assertTrackedRegularSource(root, commit, path, label) {
  let entry = '';
  try {
    entry = execFileSync('git', ['-C', root, 'ls-tree', commit, '--', path],
      { encoding: 'utf8', stdio: 'pipe' }).trimEnd();
  } catch {
    throw new Error('PLAN8_LINEAGE_INVALID: ' + label + ' cannot inspect Git tree');
  }
  const match = /^100(?:644|755) blob [0-9a-f]{40}\t([^\n]+)$/u.exec(entry);
  assert(match && match[1] === path,
    label + ' missing regular tracked 11.x source path: ' + path);
}

/**
 * A fail-closed repository convergence gate. It verifies reachable Git source
 * lineage, not the original Drive ZIP bytes. The recorded archive digest is
 * previously audited provenance and must never be claimed as rehashed here.
 */
export function verifyPlan8Lineage({ root = ROOT, sourceCommit = PLAN8_SOURCE_COMMIT,
  mainAncestorCommit = PLAN8_MAIN_ANCESTOR_COMMIT } = {}) {
  assert(/^[0-9a-f]{40}$/u.test(sourceCommit), 'source commit must be a full lowercase Git SHA');
  assert(/^[0-9a-f]{40}$/u.test(mainAncestorCommit), 'main ancestor must be a full lowercase Git SHA');
  const read = path => readFileSync(join(root, path), 'utf8');
  parseVersion(read('manifest.json'), 'manifest.json');
  parseVersion(read('package.json'), 'package.json');
  for (const path of REQUIRED_PATHS) {
    let regular = false;
    try { regular = statSync(join(root, path)).isFile(); } catch { /* missing */ }
    assert(regular, 'required 11.x source path missing: ' + path);
  }
  // Prove ancestry before inspecting untrusted sourceCommit as a Git tree:
  // unknown or unrelated SHAs must fail with the deterministic ancestry error,
  // not a misleading tree-inspection error. Either failure remains fail-closed.
  let ancestor = false;
  try {
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', sourceCommit, 'HEAD'], { stdio: 'pipe' });
    ancestor = true;
  } catch { /* absent/shallow/divergent commit must fail closed */ }
  assert(ancestor, 'canonical 11.x source commit ' + sourceCommit + ' is not an ancestor of HEAD');
  // The 11.x archive alone does not prove that main-only operational recovery
  // survived convergence. Validate the independently audited main predecessor.
  let mainAncestor = false;
  try {
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', mainAncestorCommit, 'HEAD'], { stdio: 'pipe' });
    mainAncestor = true;
  } catch { /* absent/shallow/divergent main predecessor */ }
  assert(mainAncestor, 'canonical main ancestor ' + mainAncestorCommit + ' is not an ancestor of HEAD');
  // Directory existence alone is insufficient: untracked replacements, Git
  // symlinks and later additions cannot establish the imported 11.x baseline.
  for (const path of REQUIRED_PATHS) {
    assertTrackedRegularSource(root, sourceCommit, path, 'source ancestor');
    assertTrackedRegularSource(root, 'HEAD', path, 'candidate HEAD');
  }
  for (const path of MAIN_ONLY_PATHS) {
    assertTrackedRegularSource(root, mainAncestorCommit, path, 'main ancestor');
    assertTrackedRegularSource(root, 'HEAD', path, 'candidate HEAD');
  }
  const provenance = read('PLAN8_11_0_13_SOURCE_CONVERGENCE.md');
  assert(provenance.includes(PLAN8_ARCHIVE_SHA256), 'audited archive digest missing from provenance');
  for (const path of ['manifest.json', 'package.json']) {
    let baselineText;
    try {
      baselineText = execFileSync('git', ['-C', root, 'show', sourceCommit + ':' + path],
        { encoding: 'utf8', stdio: 'pipe' });
    } catch {
      throw new Error('PLAN8_LINEAGE_INVALID: source ancestor lacks ' + path);
    }
    parseVersion(baselineText, 'source ancestor ' + path);
  }
  return Object.freeze({
    version: PLAN8_SOURCE_VERSION, sourceCommit, mainAncestorCommit,
    archivedSha256: PLAN8_ARCHIVE_SHA256,
    sourceAncestry: 'verified', mainAncestry: 'verified', driveArchiveBytesRehashed: false,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyPlan8Lineage()));
}
