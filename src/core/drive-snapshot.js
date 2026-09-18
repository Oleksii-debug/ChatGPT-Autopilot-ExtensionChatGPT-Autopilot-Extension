export class DriveSnapshotError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DriveSnapshotError';
    this.code = code;
    Object.assign(this, details);
  }
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function normalizeVersion(value) {
  const text = String(value ?? '').trim();
  if (!text || !/^\d+$/.test(text)) {
    throw new DriveSnapshotError('INVALID_VERSION', 'Drive response did not contain a usable monotonic version.');
  }
  return text;
}

function shouldRetry(error) {
  return Boolean(error?.retryable || RETRYABLE_STATUSES.has(Number(error?.status)));
}

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

export async function sha256Text(text) {
  if (!globalThis.crypto?.subtle) throw new DriveSnapshotError('HASH_UNAVAILABLE', 'Web Crypto is unavailable.');
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readStableDriveSnapshot({
  readMetadata,
  readContent,
  hashContent = sha256Text,
  maxAttempts = 3,
  retryDelayMs = 250,
}) {
  if (typeof readMetadata !== 'function' || typeof readContent !== 'function') {
    throw new DriveSnapshotError('INVALID_READER', 'Drive snapshot readers are required.');
  }
  const attempts = Number.isInteger(maxAttempts) ? Math.max(1, Math.min(maxAttempts, 5)) : 3;
  let lastVersionBefore = '';
  let lastVersionAfter = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let before;
    let content;
    let after;
    try {
      before = await readMetadata();
      const fileId = String(before?.id || '').trim();
      if (!fileId) throw new DriveSnapshotError('INVALID_METADATA', 'Drive metadata did not contain a file id.');
      lastVersionBefore = normalizeVersion(before?.version);
      content = await readContent(before);
      if (typeof content !== 'string' || !content.trim()) {
        throw new DriveSnapshotError('EMPTY_CONTENT', 'Drive returned empty content.');
      }
      after = await readMetadata();
      if (String(after?.id || '').trim() !== fileId) {
        throw new DriveSnapshotError('FILE_ID_CHANGED', 'Drive file identity changed during snapshot.');
      }
      lastVersionAfter = normalizeVersion(after?.version);
      if (lastVersionBefore !== lastVersionAfter) {
        if (attempt < attempts) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new DriveSnapshotError(
          'VERSION_RACE',
          `Drive file changed while it was being read (${lastVersionBefore} → ${lastVersionAfter}).`,
          { versionBefore: lastVersionBefore, versionAfter: lastVersionAfter, attempts: attempt },
        );
      }
      return {
        fileId,
        version: lastVersionAfter,
        content,
        hash: await hashContent(content),
        metadata: after,
        attempts: attempt,
      };
    } catch (error) {
      if (error instanceof DriveSnapshotError && error.code === 'VERSION_RACE') throw error;
      if (attempt >= attempts || !shouldRetry(error)) throw error;
      await sleep(retryDelayMs * attempt);
    }
  }

  throw new DriveSnapshotError('SNAPSHOT_FAILED', `Could not establish a stable Drive snapshot (${lastVersionBefore} → ${lastVersionAfter}).`);
}
