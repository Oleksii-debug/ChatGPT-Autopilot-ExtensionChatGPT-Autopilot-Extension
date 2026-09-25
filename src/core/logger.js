import { MAX_LOG_ENTRIES, MAX_LOG_MESSAGE_LENGTH } from './schema.js';

export { MAX_LOG_ENTRIES, MAX_LOG_MESSAGE_LENGTH };

export function appendLog(state, sessionId, message, { at = Date.now(), level = 'INFO' } = {}) {
  const list = state.logs[sessionId] || (state.logs[sessionId] = []);
  list.push({ at, level, message: String(message).slice(0, MAX_LOG_MESSAGE_LENGTH) });
  if (list.length > MAX_LOG_ENTRIES) list.splice(0, list.length - MAX_LOG_ENTRIES);
  return list.at(-1);
}
