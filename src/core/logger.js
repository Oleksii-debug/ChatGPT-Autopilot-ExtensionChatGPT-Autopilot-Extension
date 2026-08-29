export const MAX_LOG_ENTRIES = 500;
export function appendLog(state, sessionId, message, { at = Date.now(), level = 'INFO' } = {}) {
  const list = state.logs[sessionId] || (state.logs[sessionId] = []);
  list.push({ at, level, message: String(message).slice(0, 2000) });
  if (list.length > MAX_LOG_ENTRIES) list.splice(0, list.length - MAX_LOG_ENTRIES);
  return list.at(-1);
}
