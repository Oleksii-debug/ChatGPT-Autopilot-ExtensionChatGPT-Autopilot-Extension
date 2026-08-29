import { normalizeChatUrl } from './schema.js';

function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createPromptFingerprint({
  sessionId,
  taskId,
  targetUrl,
  promptText,
  generation,
  cryptoApi = globalThis.crypto,
}) {
  if (!sessionId || !taskId) throw new Error('Session and task identity are required');
  if (typeof promptText !== 'string') throw new Error('Prompt text must be a string');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Operation generation must be a positive integer');
  if (!cryptoApi?.subtle?.digest) throw new Error('Web Crypto SHA-256 is unavailable');

  const canonical = JSON.stringify([
    'chatgpt-autopilot-prompt-v1',
    sessionId,
    taskId,
    normalizeChatUrl(targetUrl),
    generation,
    promptText,
  ]);
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

export function createOperationId({ sessionId, taskId, generation, promptFingerprint }) {
  if (!sessionId || !taskId || !promptFingerprint) throw new Error('Operation identity fields are required');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Operation generation must be a positive integer');
  const suffix = String(promptFingerprint).replace(/^sha256:/, '').slice(0, 16);
  return `${sessionId}:${taskId}:${generation}:${suffix}`;
}
