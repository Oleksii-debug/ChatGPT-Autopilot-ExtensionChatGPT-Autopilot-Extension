/**
 * Shared strict V1 JSON ingestion for the loopback SDK and keyboard CLI.
 * Both transports reject duplicate object keys (including escaped aliases)
 * and malformed UTF-8 BEFORE canonical request normalization/dispatch.
 * The caller must bound input bytes. This is not a Core policy authority.
 */
function assertNoDuplicateJsonMembers(source) {
  const frames = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      const start = i;
      for (i += 1; i < source.length; i++) {
        if (source[i] === '\\') { i += 1; continue; }
        if (source[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/u.test(source[next] || '')) next += 1;
      const frame = frames[frames.length - 1];
      if (frame?.keys && source[next] === ':') {
        const key = JSON.parse(source.slice(start, i + 1));
        if (frame.keys.has(key)) throw new Error('Ambiguous duplicate JSON member');
        frame.keys.add(key);
      }
    } else if (char === '{') frames.push({ keys: new Set() });
    else if (char === '[') frames.push({ keys: null });
    else if (char === '}' || char === ']') frames.pop();
  }
}

export function parseStrictControlJsonV1(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Expected bounded JSON bytes');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = JSON.parse(source);
  assertNoDuplicateJsonMembers(source);
  return parsed;
}
