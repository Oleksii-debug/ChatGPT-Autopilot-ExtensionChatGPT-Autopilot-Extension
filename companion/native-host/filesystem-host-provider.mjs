import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  MAX_SEARCH_ENTRIES,
  MAX_SEARCH_RESULTS,
  createFilesystemScopeV1,
  searchFilesystemV1,
  withAuthorizedExistingFileV1,
} from './filesystem-provider.mjs';
import {
  MAX_HASH_BYTES,
  MAX_LIST_ENTRIES,
  listFilesystemDirectoryV1,
  statFilesystemPathV1,
} from './filesystem-read-surface.mjs';

export const MAX_WRITE_TEXT_BYTES = 240 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function nativeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function id(value, label) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(out)) throw nativeError('INVALID_REQUEST', `${label} is invalid`);
  return out;
}

function relativePath(value, label = 'relativePath') {
  if (typeof value !== 'string') throw nativeError('INVALID_REQUEST', `${label} must be text`);
  const out = value.trim();
  if (!out || out.length > 32000 || path.isAbsolute(out)) throw nativeError('PATH_OUTSIDE_SCOPE', `${label} is invalid`);
  const segments = out.replace(/\\/gu, '/').split('/');
  if (segments.some(segment => segment === '..' || segment === '' || segment.includes(':'))) {
    throw nativeError('PATH_OUTSIDE_SCOPE', `${label} contains an invalid path segment`);
  }
  return out;
}

function exactKeys(raw, allowed, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw nativeError('INVALID_REQUEST', `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    throw nativeError('INVALID_REQUEST', `${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw nativeError('INVALID_REQUEST', `${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw nativeError('INVALID_REQUEST', `${label} field ${key} must be an enumerable data property`);
    }
  }
  for (const key of allowed) {
    if (key in raw && !Object.prototype.hasOwnProperty.call(raw, key)) {
      throw nativeError('INVALID_REQUEST', `${label} contains inherited field: ${key}`);
    }
  }
}

function configuredRoot(config, rootId, { write = false } = {}) {
  const root = config.roots.find(item => item.rootId === id(rootId, 'rootId'));
  if (!root) throw nativeError('ROOT_NOT_ALLOWED', 'Requested filesystem root is not configured');
  if (write && root.writable !== true) throw nativeError('ROOT_NOT_WRITABLE', 'Requested filesystem root is read-only');
  return root;
}

function scopeFor(root, write = false) {
  return createFilesystemScopeV1({
    scopeId: root.rootId,
    roots: [root.path],
    writableRoots: write ? [root.path] : [],
  });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function mapPathError(error) {
  if (error?.code === 'ENOENT') return nativeError('FILE_NOT_FOUND', 'Requested file is unavailable');
  if (error?.code === 'ELOOP' || /escapes owner scope|symbolic link|identity changed/iu.test(String(error?.message || ''))) {
    return nativeError('PATH_OUTSIDE_SCOPE', 'Requested filesystem path escapes the configured root or changed identity');
  }
  return error;
}

const ATOMIC_WRITE_CHUNK_BYTES = 64 * 1024;

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameFileIdentity(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

async function closeQuietly(handle) {
  if (!handle) return;
  try {
    await handle.close();
  } catch (error) {
    if (error?.code !== 'EBADF') throw error;
  }
}

async function unlinkQuietly(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writeAll(handle, bytes, { afterChunk = null } = {}) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const length = Math.min(ATOMIC_WRITE_CHUNK_BYTES, bytes.byteLength - offset);
    const { bytesWritten } = await handle.write(bytes, offset, length, offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw nativeError('WRITE_VERIFICATION_FAILED', 'Filesystem write made no forward progress');
    }
    offset += bytesWritten;
    if (afterChunk != null) await afterChunk({ writtenBytes: offset, totalBytes: bytes.byteLength });
  }
}

async function stageReplacementFile(target, desired, admitted, { afterTempWrite = null } = {}) {
  const parent = path.dirname(target);
  const tempPath = path.join(parent, `.chatgpt-autopilot-write-${crypto.randomBytes(16).toString('hex')}.tmp`);
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  let handle = null;
  let complete = false;
  try {
    handle = await fs.open(tempPath, flags, 0o600);
    if (process.platform !== 'win32' && Number.isInteger(admitted.stat.mode) && typeof handle.chmod === 'function') {
      await handle.chmod(admitted.stat.mode & 0o777);
    }
    if (desired.byteLength) await writeAll(handle, desired, { afterChunk: afterTempWrite });
    await handle.sync();
    complete = true;
  } finally {
    await closeQuietly(handle);
    if (!complete) await unlinkQuietly(tempPath);
  }
  return Object.freeze({
    tempPath,
    parent,
    admittedPath: admitted.path,
    admittedDev: admitted.stat.dev,
    admittedIno: admitted.stat.ino,
  });
}

async function inspectTargetBeforePublication(scope, target, staged) {
  return withAuthorizedExistingFileV1(scope, target, { write: true }, async (handle, admitted) => {
    if (
      canonicalPath(admitted.path) !== canonicalPath(staged.admittedPath)
      || !admitted.stat.isFile()
      || !sameFileIdentity(admitted.stat, { dev: staged.admittedDev, ino: staged.admittedIno })
    ) {
      throw nativeError('PATH_OUTSIDE_SCOPE', 'Requested filesystem path changed identity before publication');
    }
    if (admitted.stat.size > MAX_WRITE_TEXT_BYTES) {
      throw nativeError('FILE_TOO_LARGE', 'Existing file exceeds mutation bound before publication');
    }
    const bytes = Buffer.alloc(admitted.stat.size);
    const read = admitted.stat.size
      ? await handle.read(bytes, 0, bytes.length, 0)
      : { bytesRead: 0 };
    const afterReadStat = await handle.stat();
    if (
      read.bytesRead !== admitted.stat.size
      || !sameFileIdentity(afterReadStat, admitted.stat)
      || afterReadStat.size !== admitted.stat.size
    ) {
      throw nativeError('PRECONDITION_FAILED', 'Existing file changed during publication precondition read');
    }
    return Object.freeze({ sha256: sha256(bytes), sizeBytes: bytes.byteLength });
  });
}

async function syncParentDirectory(parent) {
  let handle = null;
  try {
    handle = await fs.open(parent, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Node cannot fsync directory handles on every Windows filesystem. The staged
    // file itself is synced before the same-directory atomic rename, so an abrupt
    // failure still exposes either the old complete file or the new complete file.
    if (process.platform === 'win32' && ['EACCES', 'EINVAL', 'EPERM', 'EISDIR'].includes(error?.code)) return;
    throw error;
  } finally {
    await closeQuietly(handle);
  }
}

async function verifyPublishedFile(scope, target, desired) {
  return withAuthorizedExistingFileV1(scope, target, { write: false }, async (handle, admitted) => {
    if (!admitted.stat.isFile() || admitted.stat.size !== desired.byteLength) {
      throw nativeError('WRITE_VERIFICATION_FAILED', 'Published file size did not match desired content');
    }
    const after = Buffer.alloc(desired.byteLength);
    const read = desired.byteLength
      ? await handle.read(after, 0, after.length, 0)
      : { bytesRead: 0 };
    if (read.bytesRead !== desired.byteLength) {
      throw nativeError('WRITE_VERIFICATION_FAILED', 'Published file readback was incomplete');
    }
    return sha256(after);
  });
}

export async function listScopedFilesystemV1(payload, config) {
  exactKeys(payload, new Set(['rootId', 'relativePath', 'maxEntries']), 'filesystem.list payload');
  const root = configuredRoot(config, payload.rootId);
  const rel = relativePath(payload.relativePath);
  const maxEntries = payload.maxEntries == null ? Math.min(256, MAX_LIST_ENTRIES) : payload.maxEntries;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_LIST_ENTRIES) {
    throw nativeError('INVALID_REQUEST', 'filesystem.list maxEntries must be an integer within bounds');
  }
  try {
    const result = await listFilesystemDirectoryV1(scopeFor(root), path.resolve(root.path, rel), { maxEntries });
    return { rootId: root.rootId, relativePath: rel.replace(/\\/gu, '/'), ...result };
  } catch (error) {
    throw mapPathError(error);
  }
}

export async function statScopedFilesystemV1(payload, config, { beforeHashOpen = null } = {}) {
  exactKeys(payload, new Set(['rootId', 'relativePath', 'hash', 'maxHashBytes']), 'filesystem.stat payload');
  const root = configuredRoot(config, payload.rootId);
  const rel = relativePath(payload.relativePath);
  const hash = payload.hash == null ? false : payload.hash;
  const maxHashBytes = payload.maxHashBytes == null ? MAX_HASH_BYTES : payload.maxHashBytes;
  if (typeof hash !== 'boolean') throw nativeError('INVALID_REQUEST', 'filesystem.stat hash must be boolean');
  if (!Number.isInteger(maxHashBytes) || maxHashBytes < 1 || maxHashBytes > MAX_HASH_BYTES) {
    throw nativeError('INVALID_REQUEST', 'filesystem.stat maxHashBytes must be an integer within bounds');
  }
  try {
    const result = await statFilesystemPathV1(
      scopeFor(root),
      path.resolve(root.path, rel),
      { hash, maxHashBytes, beforeHashOpen },
    );
    return {
      rootId: root.rootId,
      relativePath: rel.replace(/\\/gu, '/'),
      kind: result.kind,
      sizeBytes: result.sizeBytes,
      modifiedAt: result.modifiedAt,
      hashed: result.hashed,
      sha256: result.sha256,
    };
  } catch (error) {
    throw mapPathError(error);
  }
}

export async function searchScopedFilesystemV1(payload, config) {
  exactKeys(payload, new Set(['rootId', 'query', 'maxResults', 'maxEntries']), 'filesystem.search payload');
  const root = configuredRoot(config, payload.rootId);
  if (typeof payload.query !== 'string' || !payload.query.trim()) throw nativeError('INVALID_REQUEST', 'query is required');
  const maxResults = payload.maxResults == null ? Math.min(64, MAX_SEARCH_RESULTS) : payload.maxResults;
  const maxEntries = payload.maxEntries == null ? Math.min(2048, MAX_SEARCH_ENTRIES) : payload.maxEntries;
  if (!Number.isInteger(maxResults) || !Number.isInteger(maxEntries)) {
    throw nativeError('INVALID_REQUEST', 'filesystem.search bounds must be integers');
  }
  try {
    const result = await searchFilesystemV1(scopeFor(root), root.path, payload.query, { maxResults, maxEntries });
    return { rootId: root.rootId, ...result };
  } catch (error) {
    throw mapPathError(error);
  }
}

/**
 * V1 mutation primitive crash-safely replaces an existing regular UTF-8 file only.
 * Creation remains fail-closed because Node has no portable openat-style parent handle
 * primitive that can bind a missing leaf to the admitted directory identity.
 *
 * expectedSha256 is an optimistic-concurrency fence.  If the desired bytes are already
 * present, the operation reports alreadyApplied=true, which makes ambiguity reconciliation
 * observable without blind replay.
 */
export async function writeExistingTextScopedV1(payload, config, {
  beforeOpen = null,
  afterTempWrite = null,
  beforePublish = null,
} = {}) {
  exactKeys(payload, new Set(['rootId', 'relativePath', 'text', 'expectedSha256']), 'filesystem.writeExistingText payload');
  if (afterTempWrite != null && typeof afterTempWrite !== 'function') {
    throw nativeError('INVALID_REQUEST', 'afterTempWrite hook must be a function');
  }
  if (beforePublish != null && typeof beforePublish !== 'function') {
    throw nativeError('INVALID_REQUEST', 'beforePublish hook must be a function');
  }
  const root = configuredRoot(config, payload.rootId, { write: true });
  const rel = relativePath(payload.relativePath);
  if (typeof payload.text !== 'string') throw nativeError('INVALID_REQUEST', 'text must be text');
  const desired = Buffer.from(payload.text, 'utf8');
  if (desired.byteLength > MAX_WRITE_TEXT_BYTES) throw nativeError('FILE_TOO_LARGE', `text exceeds ${MAX_WRITE_TEXT_BYTES} bytes`);
  if (typeof payload.expectedSha256 !== 'string') {
    throw nativeError('INVALID_REQUEST', 'expectedSha256 must be a lowercase SHA-256 digest');
  }
  const expectedSha256 = payload.expectedSha256;
  if (!SHA256.test(expectedSha256)) throw nativeError('INVALID_REQUEST', 'expectedSha256 must be a lowercase SHA-256 digest');
  throw nativeError('ATOMIC_WRITE_UNAVAILABLE', 'Filesystem write is fail-closed until publication can be bound to the admitted parent directory identity');
  const desiredSha256 = sha256(desired);
  const target = path.resolve(root.path, rel);
  const scope = scopeFor(root, true);
  let staged = null;
  let published = false;

  try {
    const prepared = await withAuthorizedExistingFileV1(scope, target, { write: true, beforeOpen }, async (handle, admitted) => {
      if (!admitted.stat.isFile()) throw nativeError('NOT_A_FILE', 'Requested path is not a regular file');
      if (admitted.stat.size > MAX_WRITE_TEXT_BYTES) throw nativeError('FILE_TOO_LARGE', 'Existing file exceeds mutation bound');
      const before = Buffer.alloc(admitted.stat.size);
      const { bytesRead } = await handle.read(before, 0, before.length, 0);
      if (bytesRead !== admitted.stat.size) {
        throw nativeError('PRECONDITION_FAILED', 'Existing file changed during optimistic-concurrency read');
      }
      const beforeBytes = before.subarray(0, bytesRead);
      const beforeSha256 = sha256(beforeBytes);
      if (beforeSha256 === desiredSha256) {
        return Object.freeze({ alreadyApplied: true, beforeSha256 });
      }
      if (beforeSha256 !== expectedSha256) {
        throw nativeError('PRECONDITION_FAILED', 'Existing file digest does not match expectedSha256');
      }

      staged = await stageReplacementFile(target, desired, admitted, { afterTempWrite });
      return Object.freeze({ alreadyApplied: false, beforeSha256 });
    });

    if (prepared.alreadyApplied) {
      return {
        rootId: root.rootId,
        relativePath: rel.replace(/\\/gu, '/'),
        beforeSha256: prepared.beforeSha256,
        sha256: desiredSha256,
        sizeBytes: desired.byteLength,
        alreadyApplied: true,
      };
    }

    // The admitted target handle is closed before publication so Windows can perform
    // same-directory replacement. Revalidate the exact admitted file immediately before
    // and after any test/integration hook. Atomic rename replaces the directory entry
    // rather than truncating the admitted inode, so a crash before publication leaves
    // the complete original file and a crash after publication exposes the complete
    // fsynced replacement.
    let liveTarget = await inspectTargetBeforePublication(scope, target, staged);
    if (liveTarget.sha256 !== expectedSha256 && liveTarget.sha256 !== desiredSha256) {
      throw nativeError('PRECONDITION_FAILED', 'Existing file changed while replacement was staged');
    }
    if (beforePublish != null) await beforePublish();
    liveTarget = await inspectTargetBeforePublication(scope, target, staged);
    if (liveTarget.sha256 === desiredSha256) {
      return {
        rootId: root.rootId,
        relativePath: rel.replace(/\\/gu, '/'),
        beforeSha256: prepared.beforeSha256,
        sha256: desiredSha256,
        sizeBytes: desired.byteLength,
        alreadyApplied: true,
      };
    }
    if (liveTarget.sha256 !== expectedSha256) {
      throw nativeError('PRECONDITION_FAILED', 'Existing file changed while replacement was staged');
    }
    await fs.rename(staged.tempPath, target);
    published = true;
    await syncParentDirectory(staged.parent);

    const afterSha256 = await verifyPublishedFile(scope, target, desired);
    if (afterSha256 !== desiredSha256) {
      throw nativeError('WRITE_VERIFICATION_FAILED', 'Published file digest did not match desired content');
    }
    return {
      rootId: root.rootId,
      relativePath: rel.replace(/\\/gu, '/'),
      beforeSha256: prepared.beforeSha256,
      sha256: afterSha256,
      sizeBytes: desired.byteLength,
      alreadyApplied: false,
    };
  } catch (error) {
    throw mapPathError(error);
  } finally {
    if (staged && !published) await unlinkQuietly(staged.tempPath);
  }
}