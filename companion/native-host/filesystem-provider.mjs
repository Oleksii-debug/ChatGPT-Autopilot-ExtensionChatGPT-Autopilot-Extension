import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export const FILESYSTEM_PROVIDER_VERSION = 1;
export const MAX_READ_BYTES = 1024 * 1024;
export const MAX_SEARCH_RESULTS = 256;

function fail(message) { throw new Error(message); }
function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`Invalid ${label}`);
  return value;
}

function canonical(value) {
  const resolved = path.resolve(nonEmpty(value, 'filesystem path'));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function createFilesystemScopeV1({ scopeId, roots, writableRoots = [] }) {
  nonEmpty(scopeId, 'scopeId');
  if (!Array.isArray(roots) || roots.length === 0) fail('Filesystem scope requires roots');
  if (!Array.isArray(writableRoots)) fail('Invalid writableRoots');
  const readRoots = [...new Set(roots.map(canonical))];
  const writeRoots = [...new Set(writableRoots.map(canonical))];
  for (const root of writeRoots) {
    if (!readRoots.some(parent => isWithin(parent, root))) fail('Writable root must be inside readable scope');
  }
  return Object.freeze({ version: FILESYSTEM_PROVIDER_VERSION, scopeId, roots: readRoots, writableRoots: writeRoots });
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function authorizeFilesystemPathV1(scope, requestedPath, { write = false } = {}) {
  if (!scope || scope.version !== FILESYSTEM_PROVIDER_VERSION) fail('Invalid filesystem scope');
  const candidate = canonical(requestedPath);
  const roots = write ? scope.writableRoots : scope.roots;
  if (!roots.some(root => isWithin(root, candidate))) fail(write ? 'Filesystem write outside owner scope' : 'Filesystem read outside owner scope');
  return candidate;
}

async function realpathExistingOrParent(candidate, { allowMissingLeaf }) {
  let cursor = candidate;
  const missing = [];
  while (true) {
    try {
      const real = canonical(await fs.realpath(cursor));
      if (missing.length && !allowMissingLeaf) fail('Filesystem path does not exist');
      return canonical(path.join(real, ...missing.reverse()));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

// Mandatory immediately-before-I/O fence. Lexical authorization alone is not an
// execution authority because symlinks/junctions/reparse points can redirect it.
export async function authorizeFilesystemPathAtIoV1(scope, requestedPath, { write = false, allowMissingLeaf = write } = {}) {
  const lexical = authorizeFilesystemPathV1(scope, requestedPath, { write });
  const roots = write ? scope.writableRoots : scope.roots;
  const realRoots = await Promise.all(roots.map(async root => canonical(await fs.realpath(root))));
  const realCandidate = await realpathExistingOrParent(lexical, { allowMissingLeaf });
  if (!realRoots.some(root => isWithin(root, realCandidate))) {
    fail(write ? 'Filesystem write escapes owner scope through link/reparse point' : 'Filesystem read escapes owner scope through link/reparse point');
  }
  return realCandidate;
}

export function boundReadV1(buffer, { maxBytes = MAX_READ_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer)) fail('Filesystem read must be a Buffer');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) fail('Invalid filesystem read bound');
  const bytes = buffer.subarray(0, maxBytes);
  return Object.freeze({ bytes, truncated: buffer.length > bytes.length, sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}

export function boundSearchResultsV1(results, { maxResults = MAX_SEARCH_RESULTS } = {}) {
  if (!Array.isArray(results)) fail('Filesystem search results must be an array');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) fail('Invalid filesystem search bound');
  const items = results.slice(0, maxResults);
  return Object.freeze({ items, truncated: results.length > items.length });
}

export function createFilesystemMutationV1({ effectId, operation, sourcePath, destinationPath = null, scope, nowMs = Date.now() }) {
  nonEmpty(effectId, 'effectId');
  if (!['WRITE', 'MOVE', 'COPY', 'DELETE', 'ARCHIVE'].includes(operation)) fail('Unsupported filesystem mutation');
  const source = authorizeFilesystemPathV1(scope, sourcePath, { write: true });
  const destination = destinationPath == null ? null : authorizeFilesystemPathV1(scope, destinationPath, { write: true });
  if (['MOVE', 'COPY', 'ARCHIVE'].includes(operation) && !destination) fail(`${operation} requires destinationPath`);
  return Object.freeze({ version: 1, effectId, operation, sourcePath: source, destinationPath: destination, state: 'PREPARED', preparedAt: nowMs, observation: null });
}

export function markFilesystemExecutingV1(mutation, nowMs = Date.now()) {
  if (mutation?.state !== 'PREPARED') fail('Filesystem mutation must be PREPARED');
  return Object.freeze({ ...mutation, state: 'EXECUTING', executingAt: nowMs });
}

export function observeFilesystemMutationV1(mutation, observation, nowMs = Date.now()) {
  if (mutation?.state !== 'EXECUTING') fail('Filesystem mutation must be EXECUTING');
  if (!observation || typeof observation !== 'object') fail('Filesystem mutation requires observation');
  return Object.freeze({ ...mutation, state: 'OBSERVED', observedAt: nowMs, observation: Object.freeze({ ...observation }) });
}

export function verifyFilesystemMutationV1(mutation, verified, nowMs = Date.now()) {
  if (mutation?.state !== 'OBSERVED') fail('Filesystem mutation must be OBSERVED');
  if (verified !== true) return Object.freeze({ ...mutation, state: 'AMBIGUOUS', reconcileRequired: true, verifiedAt: nowMs });
  return Object.freeze({ ...mutation, state: 'VERIFIED', verifiedAt: nowMs, reconcileRequired: false });
}

export function commitFilesystemMutationV1(mutation, nowMs = Date.now()) {
  if (mutation?.state !== 'VERIFIED') fail('Filesystem mutation must be VERIFIED');
  return Object.freeze({ ...mutation, state: 'COMMITTED', committedAt: nowMs });
}

export function recoverFilesystemMutationV1(mutation) {
  if (!mutation || typeof mutation !== 'object') fail('Invalid filesystem mutation');
  if (mutation.state === 'PREPARED') return Object.freeze({ ...mutation, recovery: 'SAFE_RETRY', reconcileRequired: false });
  if (mutation.state === 'EXECUTING' || mutation.state === 'OBSERVED' || mutation.state === 'AMBIGUOUS') {
    return Object.freeze({ ...mutation, state: 'AMBIGUOUS', recovery: 'RECONCILE', reconcileRequired: true });
  }
  if (mutation.state === 'VERIFIED' || mutation.state === 'COMMITTED') return Object.freeze({ ...mutation, recovery: 'VERIFIED', reconcileRequired: false });
  fail('Unknown filesystem mutation state');
}
