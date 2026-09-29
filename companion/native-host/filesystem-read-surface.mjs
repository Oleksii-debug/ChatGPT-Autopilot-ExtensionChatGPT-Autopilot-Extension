import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  authorizeFilesystemPathAtIoV1,
  authorizeFilesystemPathV1,
  withAuthorizedExistingFileV1,
} from './filesystem-provider.mjs';

export const MAX_LIST_ENTRIES = 1024;
export const MAX_HASH_BYTES = 16 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function kindOf(stat) {
  if (stat.isFile()) return 'FILE';
  if (stat.isDirectory()) return 'DIRECTORY';
  return 'OTHER';
}

function sizeOf(stat, label) {
  if (!Number.isSafeInteger(stat.size) || stat.size < 0) fail(`${label} size is invalid`);
  return stat.size;
}

function modifiedAtOf(stat, label) {
  const millis = stat.mtime?.getTime?.();
  if (!Number.isFinite(millis)) fail(`${label} modified time is invalid`);
  return new Date(millis).toISOString();
}

async function snapshotReadablePath(scope, requestedPath) {
  const lexical = authorizeFilesystemPathV1(scope, requestedPath);
  const admitted = await authorizeFilesystemPathAtIoV1(scope, lexical, { allowMissingLeaf: false });
  const before = await fs.lstat(lexical);
  if (before.isSymbolicLink()) fail('Filesystem read path must not be a symbolic link');
  const real = canonical(await fs.realpath(lexical));
  if (real !== canonical(admitted)) fail('Filesystem read path identity changed during observation');
  const after = await fs.lstat(lexical);
  if (after.isSymbolicLink() || !sameFileIdentity(before, after)) {
    fail('Filesystem read path identity changed during observation');
  }
  return Object.freeze({ lexical, real, stat: after });
}

async function closeDirectoryQuietly(directory) {
  if (!directory) return;
  try {
    await directory.close();
  } catch (error) {
    if (error?.code !== 'ERR_DIR_CLOSED') throw error;
  }
}

export async function listFilesystemDirectoryV1(scope, requestedDirectory, {
  maxEntries = MAX_LIST_ENTRIES,
  beforeEnumerate = null,
  openDirectory = null,
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_LIST_ENTRIES) {
    fail('Invalid filesystem list entry bound');
  }
  if (beforeEnumerate != null && typeof beforeEnumerate !== 'function') fail('Invalid filesystem list beforeEnumerate hook');
  if (openDirectory != null && typeof openDirectory !== 'function') fail('Invalid filesystem list openDirectory hook');

  const rootBefore = await snapshotReadablePath(scope, requestedDirectory);
  if (!rootBefore.stat.isDirectory()) fail('Filesystem list target must be a directory');
  if (beforeEnumerate != null) await beforeEnumerate(rootBefore.lexical, rootBefore);
  const preOpen = await snapshotReadablePath(scope, rootBefore.lexical);
  if (preOpen.real !== rootBefore.real || !sameFileIdentity(preOpen.stat, rootBefore.stat)) {
    fail('Filesystem list directory identity changed before enumeration');
  }

  const openDir = openDirectory ?? (current => fs.opendir(current, { bufferSize: 1 }));
  let directory = null;
  let visitedEntries = 0;
  let truncated = false;
  const items = [];
  try {
    directory = await openDir(rootBefore.lexical);
    if (!directory || typeof directory.read !== 'function' || typeof directory.close !== 'function') {
      fail('Filesystem directory enumerator is invalid');
    }
    const afterOpen = await snapshotReadablePath(scope, rootBefore.lexical);
    if (afterOpen.real !== rootBefore.real || !sameFileIdentity(afterOpen.stat, rootBefore.stat)) {
      fail('Filesystem list directory identity changed during enumeration');
    }

    while (visitedEntries < maxEntries) {
      const entry = await directory.read();
      if (entry == null) break;
      visitedEntries += 1;
      if (typeof entry.name !== 'string' || !entry.name) fail('Filesystem list entry name is invalid');

      const candidate = path.join(rootBefore.lexical, entry.name);
      const beforeEntry = await fs.lstat(candidate).catch(error => {
        if (error?.code === 'ENOENT') fail('Filesystem list entry identity changed during enumeration');
        throw error;
      });
      if (beforeEntry.isSymbolicLink()) continue;

      const admitted = await authorizeFilesystemPathAtIoV1(scope, candidate, { allowMissingLeaf: false });
      const real = canonical(await fs.realpath(candidate));
      if (real !== canonical(admitted)) fail('Filesystem list entry escapes owner scope');
      const afterEntry = await fs.lstat(candidate).catch(error => {
        if (error?.code === 'ENOENT') fail('Filesystem list entry identity changed during enumeration');
        throw error;
      });
      if (afterEntry.isSymbolicLink() || !sameFileIdentity(beforeEntry, afterEntry)) {
        fail('Filesystem list entry identity changed during enumeration');
      }
      items.push(Object.freeze({
        name: entry.name,
        kind: kindOf(afterEntry),
        sizeBytes: sizeOf(afterEntry, 'Filesystem list entry'),
        modifiedAt: modifiedAtOf(afterEntry, 'Filesystem list entry'),
      }));
    }

    const afterEnumeration = await snapshotReadablePath(scope, rootBefore.lexical);
    if (afterEnumeration.real !== rootBefore.real || !sameFileIdentity(afterEnumeration.stat, rootBefore.stat)) {
      fail('Filesystem list directory identity changed during enumeration');
    }
    if (visitedEntries >= maxEntries) {
      // One bounded look-ahead distinguishes an exactly-full directory from a
      // genuinely truncated enumeration without walking the remaining tree.
      truncated = (await directory.read()) != null;
    }
  } finally {
    await closeDirectoryQuietly(directory);
  }

  items.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return Object.freeze({ items: Object.freeze(items), visitedEntries, truncated });
}

async function hashAuthorizedFile(scope, requestedPath, maxHashBytes, beforeOpen) {
  return withAuthorizedExistingFileV1(scope, requestedPath, { beforeOpen }, async (handle, admitted) => {
    if (!admitted.stat.isFile()) fail('Filesystem hash requires a regular file');
    const sizeBytes = sizeOf(admitted.stat, 'Filesystem hash target');
    if (sizeBytes > maxHashBytes) fail('Filesystem file exceeds hash bound');

    const digest = crypto.createHash('sha256');
    const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, sizeBytes)));
    let offset = 0;
    while (offset < sizeBytes) {
      const requested = Math.min(chunk.length, sizeBytes - offset);
      const { bytesRead } = await handle.read(chunk, 0, requested, offset);
      if (!Number.isInteger(bytesRead) || bytesRead <= 0) fail('Filesystem file changed during hash read');
      digest.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }

    const after = await handle.stat();
    if (!sameFileIdentity(admitted.stat, after)
        || sizeOf(after, 'Filesystem hash target') !== sizeBytes
        || after.mtimeMs !== admitted.stat.mtimeMs
        || after.ctimeMs !== admitted.stat.ctimeMs) {
      fail('Filesystem file changed during hash read');
    }
    return Object.freeze({
      sha256: digest.digest('hex'),
      stat: after,
    });
  });
}

export async function statFilesystemPathV1(scope, requestedPath, {
  hash = false,
  maxHashBytes = MAX_HASH_BYTES,
  beforeHashOpen = null,
  afterHashRead = null,
} = {}) {
  if (typeof hash !== 'boolean') fail('Invalid filesystem stat hash flag');
  if (!Number.isInteger(maxHashBytes) || maxHashBytes < 1 || maxHashBytes > MAX_HASH_BYTES) {
    fail('Invalid filesystem hash byte bound');
  }
  if (beforeHashOpen != null && typeof beforeHashOpen !== 'function') fail('Invalid filesystem stat beforeHashOpen hook');
  if (afterHashRead != null && typeof afterHashRead !== 'function') fail('Invalid filesystem stat afterHashRead hook');

  const before = await snapshotReadablePath(scope, requestedPath);
  let hashSnapshot = null;
  if (hash) {
    if (!before.stat.isFile()) fail('Filesystem hash requires a regular file');
    hashSnapshot = await hashAuthorizedFile(scope, before.lexical, maxHashBytes, beforeHashOpen);
    if (afterHashRead != null) await afterHashRead(before.lexical, hashSnapshot);
  }
  const after = await snapshotReadablePath(scope, before.lexical);
  if (after.real !== before.real || !sameFileIdentity(after.stat, before.stat)) {
    fail('Filesystem read path identity changed during observation');
  }
  if (hashSnapshot) {
    if (!sameFileIdentity(after.stat, hashSnapshot.stat)
        || sizeOf(after.stat, 'Filesystem stat target') !== sizeOf(hashSnapshot.stat, 'Filesystem hashed target')
        || after.stat.mtimeMs !== hashSnapshot.stat.mtimeMs
        || after.stat.ctimeMs !== hashSnapshot.stat.ctimeMs) {
      fail('Filesystem file changed after hash read');
    }
  }

  const observedStat = hashSnapshot?.stat ?? after.stat;
  return Object.freeze({
    realPath: after.real,
    kind: kindOf(observedStat),
    sizeBytes: sizeOf(observedStat, 'Filesystem stat target'),
    modifiedAt: modifiedAtOf(observedStat, 'Filesystem stat target'),
    hashed: hash,
    sha256: hashSnapshot?.sha256 ?? '',
  });
}