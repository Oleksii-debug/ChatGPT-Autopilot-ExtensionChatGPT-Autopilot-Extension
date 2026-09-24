import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

export const FILESYSTEM_PROVIDER_VERSION = 1;
export const MAX_READ_BYTES = 1024 * 1024;
export const MAX_SEARCH_RESULTS = 256;
export const MAX_SEARCH_ENTRIES = 4096;

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

async function realRootsFor(scope, write) {
  const roots = write ? scope.writableRoots : scope.roots;
  return Promise.all(roots.map(async root => canonical(await fs.realpath(root))));
}

function requireContained(realRoots, candidate, write) {
  if (!realRoots.some(root => isWithin(root, candidate))) {
    fail(write ? 'Filesystem write escapes owner scope through link/reparse point' : 'Filesystem read escapes owner scope through link/reparse point');
  }
}

// Mandatory immediately-before-I/O admission fence. Lexical authorization alone is
// never execution authority because symlinks/junctions/reparse points can redirect it.
export async function authorizeFilesystemPathAtIoV1(scope, requestedPath, { write = false, allowMissingLeaf = write } = {}) {
  const lexical = authorizeFilesystemPathV1(scope, requestedPath, { write });
  const realRoots = await realRootsFor(scope, write);
  const realCandidate = await realpathExistingOrParent(lexical, { allowMissingLeaf });
  requireContained(realRoots, realCandidate, write);
  return realCandidate;
}

function sameFileIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

// Existing-file effects are bound to the checked object, not merely a checked pathname.
// We deliberately do not create a missing leaf here: Node has no portable openat-style
// parent-handle API, so creation remains fail-closed until an equivalent secure primitive
// is available in the Native Companion platform adapter.
export async function withAuthorizedExistingFileV1(scope, requestedPath, { write = false, beforeOpen = null } = {}, effect) {
  if (typeof effect !== 'function') fail('Filesystem I/O effect callback required');
  const lexical = authorizeFilesystemPathV1(scope, requestedPath, { write });
  const admitted = await authorizeFilesystemPathAtIoV1(scope, lexical, { write, allowMissingLeaf: false });
  if (beforeOpen != null) {
    if (typeof beforeOpen !== 'function') fail('Invalid filesystem beforeOpen hook');
    await beforeOpen();
  }

  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  const flags = (write ? fsConstants.O_RDWR : fsConstants.O_RDONLY) | noFollow;
  let handle;
  try {
    handle = await fs.open(lexical, flags);
    const [handleStat, pathStat, postOpenReal, realRoots] = await Promise.all([
      handle.stat(),
      fs.stat(lexical),
      fs.realpath(lexical).then(canonical),
      realRootsFor(scope, write),
    ]);
    requireContained(realRoots, postOpenReal, write);
    if (canonical(postOpenReal) !== canonical(admitted) || !sameFileIdentity(handleStat, pathStat)) {
      fail('Filesystem path identity changed during I/O authorization');
    }
    return await effect(handle, Object.freeze({ path: postOpenReal, stat: handleStat }));
  } finally {
    await handle?.close();
  }
}

export async function readFilesystemFileV1(scope, requestedPath, { maxBytes = MAX_READ_BYTES, beforeOpen = null } = {}) {
  return withAuthorizedExistingFileV1(scope, requestedPath, { beforeOpen }, async handle => {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return boundReadV1(buffer.subarray(0, bytesRead), { maxBytes });
  });
}

// Search is metadata-only and never grants execution authority. It refuses link/reparse
// traversal and bounds both work and output so an owner-scoped root cannot become an
// unbounded filesystem crawler. Results are stable relative paths, never ambient paths.
export async function searchFilesystemV1(scope, requestedRoot, query, {
  maxResults = MAX_SEARCH_RESULTS,
  maxEntries = MAX_SEARCH_ENTRIES,
} = {}) {
  const needle = nonEmpty(query, 'filesystem search query').toLocaleLowerCase('en-US');
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_SEARCH_ENTRIES) fail('Invalid filesystem search entry bound');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS) fail('Invalid filesystem search bound');
  const lexicalRoot = authorizeFilesystemPathV1(scope, requestedRoot);
  const admittedRoot = await authorizeFilesystemPathAtIoV1(scope, lexicalRoot, { allowMissingLeaf: false });
  const realRoots = await realRootsFor(scope, false);
  const pending = [lexicalRoot];
  const matches = [];
  let visited = 0;
  let workTruncated = false;

  while (pending.length) {
    const current = pending.shift();
    const currentReal = canonical(await fs.realpath(current));
    requireContained(realRoots, currentReal, false);
    if (!isWithin(admittedRoot, currentReal)) fail('Filesystem search escaped admitted root');
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (visited >= maxEntries) { workTruncated = true; pending.length = 0; break; }
      visited += 1;
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      const relativePath = path.relative(lexicalRoot, candidate).split(path.sep).join('/');
      if (relativePath.toLocaleLowerCase('en-US').includes(needle)) matches.push(relativePath);
      if (entry.isDirectory()) pending.push(candidate);
    }
  }

  matches.sort((a, b) => a.localeCompare(b, 'en'));
  const bounded = boundSearchResultsV1(matches, { maxResults });
  return Object.freeze({ ...bounded, truncated: bounded.truncated || workTruncated, visitedEntries: visited });
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
