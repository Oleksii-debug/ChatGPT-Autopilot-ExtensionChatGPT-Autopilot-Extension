import crypto from 'node:crypto';
import path from 'node:path';
import {
  MAX_SEARCH_ENTRIES,
  MAX_SEARCH_RESULTS,
  createFilesystemScopeV1,
  searchFilesystemV1,
  withAuthorizedExistingFileV1,
} from './filesystem-provider.mjs';

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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw nativeError('INVALID_REQUEST', `${label} must be an object`);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw nativeError('INVALID_REQUEST', `${label} contains unknown field: ${key}`);
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

export async function searchScopedFilesystemV1(payload, config) {
  exactKeys(payload, new Set(['rootId', 'query', 'maxResults', 'maxEntries']), 'filesystem.search payload');
  const root = configuredRoot(config, payload.rootId);
  if (typeof payload.query !== 'string' || !payload.query.trim()) throw nativeError('INVALID_REQUEST', 'query is required');
  const maxResults = payload.maxResults == null ? Math.min(64, MAX_SEARCH_RESULTS) : Number(payload.maxResults);
  const maxEntries = payload.maxEntries == null ? Math.min(2048, MAX_SEARCH_ENTRIES) : Number(payload.maxEntries);
  try {
    const result = await searchFilesystemV1(scopeFor(root), root.path, payload.query, { maxResults, maxEntries });
    return { rootId: root.rootId, ...result };
  } catch (error) {
    throw mapPathError(error);
  }
}

/**
 * V1 mutation primitive intentionally overwrites an existing regular UTF-8 file only.
 * Creation remains fail-closed because Node has no portable openat-style parent handle
 * primitive that can bind a missing leaf to the admitted directory identity.
 *
 * expectedSha256 is an optimistic-concurrency fence.  If the desired bytes are already
 * present, the operation reports alreadyApplied=true, which makes ambiguity reconciliation
 * observable without blind replay.
 */
export async function writeExistingTextScopedV1(payload, config, { beforeOpen = null } = {}) {
  exactKeys(payload, new Set(['rootId', 'relativePath', 'text', 'expectedSha256']), 'filesystem.writeExistingText payload');
  const root = configuredRoot(config, payload.rootId, { write: true });
  const rel = relativePath(payload.relativePath);
  if (typeof payload.text !== 'string') throw nativeError('INVALID_REQUEST', 'text must be text');
  const desired = Buffer.from(payload.text, 'utf8');
  if (desired.byteLength > MAX_WRITE_TEXT_BYTES) throw nativeError('FILE_TOO_LARGE', `text exceeds ${MAX_WRITE_TEXT_BYTES} bytes`);
  const expectedSha256 = String(payload.expectedSha256 || '').trim().toLowerCase();
  if (!SHA256.test(expectedSha256)) throw nativeError('INVALID_REQUEST', 'expectedSha256 must be a lowercase SHA-256 digest');
  const desiredSha256 = sha256(desired);
  const target = path.resolve(root.path, rel);

  try {
    return await withAuthorizedExistingFileV1(scopeFor(root, true), target, { write: true, beforeOpen }, async (handle, admitted) => {
      if (!admitted.stat.isFile()) throw nativeError('NOT_A_FILE', 'Requested path is not a regular file');
      if (admitted.stat.size > MAX_WRITE_TEXT_BYTES) throw nativeError('FILE_TOO_LARGE', 'Existing file exceeds mutation bound');
      const before = Buffer.alloc(admitted.stat.size);
      const { bytesRead } = await handle.read(before, 0, before.length, 0);
      const beforeBytes = before.subarray(0, bytesRead);
      const beforeSha256 = sha256(beforeBytes);
      if (beforeSha256 === desiredSha256) {
        return {
          rootId: root.rootId,
          relativePath: rel.replace(/\\/gu, '/'),
          beforeSha256,
          sha256: desiredSha256,
          sizeBytes: desired.byteLength,
          alreadyApplied: true,
        };
      }
      if (beforeSha256 !== expectedSha256) {
        throw nativeError('PRECONDITION_FAILED', 'Existing file digest does not match expectedSha256');
      }

      await handle.truncate(0);
      if (desired.byteLength) await handle.write(desired, 0, desired.byteLength, 0);
      await handle.sync();
      const postStat = await handle.stat();
      if (!postStat.isFile() || postStat.size !== desired.byteLength) throw nativeError('WRITE_VERIFICATION_FAILED', 'Written file size did not match desired content');
      const after = Buffer.alloc(desired.byteLength);
      const afterRead = desired.byteLength ? await handle.read(after, 0, after.length, 0) : { bytesRead: 0 };
      const afterSha256 = sha256(after.subarray(0, afterRead.bytesRead));
      if (afterRead.bytesRead !== desired.byteLength || afterSha256 !== desiredSha256) {
        throw nativeError('WRITE_VERIFICATION_FAILED', 'Written file digest did not match desired content');
      }
      return {
        rootId: root.rootId,
        relativePath: rel.replace(/\\/gu, '/'),
        beforeSha256,
        sha256: afterSha256,
        sizeBytes: desired.byteLength,
        alreadyApplied: false,
      };
    });
  } catch (error) {
    throw mapPathError(error);
  }
}
