import {
  MAX_DIAGNOSTIC_ENTRIES,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  OperationPhase,
} from './schema.js';

const PRIVATE_URL_PATTERN = /https:\/\/(?:www\.)?chatgpt\.com\/[^\s"'<>)\]]+/giu;

function safeText(value, maximum = MAX_DIAGNOSTIC_MESSAGE_LENGTH) {
  return String(value ?? '')
    .replace(PRIVATE_URL_PATTERN, '[приховане посилання ChatGPT]')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, maximum);
}

function optionalText(value, maximum) {
  const normalized = safeText(value, maximum);
  return normalized || null;
}

export function redactChatGptUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!/(^|\.)chatgpt\.com$/iu.test(url.hostname)) return 'не-ChatGPT-адреса';
    const conversation = url.pathname.match(/\/c\/([^/]+)/u)?.[1] || '';
    if (!conversation) return 'chatgpt.com/розмова: немає ідентифікатора';
    return `chatgpt.com/розмова: …${conversation.slice(-6)}`;
  } catch {
    return value ? 'некоректна адреса ChatGPT' : null;
  }
}

function entryText(entry, field, maximum = MAX_DIAGNOSTIC_MESSAGE_LENGTH) {
  return entry?.[field] == null ? null : optionalText(entry[field], maximum);
}

export function appendDiagnostic(state, entry, { at = Date.now() } = {}) {
  const session = entry?.sessionId ? state.sessionsById?.[entry.sessionId] : null;
  const task = entry?.taskId ? session?.tasksById?.[entry.taskId] : null;
  const list = state.diagnostics || (state.diagnostics = []);
  const safe = {
    at: Number.isFinite(entry?.at) && entry.at >= 0 ? entry.at : at,
    event: safeText(entry?.event || 'ПОДІЯ_ДІАГНОСТИКИ', 80) || 'ПОДІЯ_ДІАГНОСТИКИ',
    sessionId: entryText(entry, 'sessionId', 120),
    sessionName: entryText(entry, 'sessionName', 160) || optionalText(session?.name, 160),
    taskId: entryText(entry, 'taskId', 120),
    taskLabel: entryText(entry, 'taskLabel', 160) || optionalText(task?.label, 160),
    mode: entryText(entry, 'mode', 80),
    phase: entryText(entry, 'phase', 80) || session?.operation?.phase || OperationPhase.NONE,
    runState: entryText(entry, 'runState', 80) || session?.runState || null,
    status: entryText(entry, 'status', 120),
    code: entryText(entry, 'code', 120),
    message: entryText(entry, 'message', MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    target: redactChatGptUrl(entry?.target || session?.operation?.targetUrl || task?.normalizedUrl || task?.url),
    observed: redactChatGptUrl(entry?.observed),
    promptFingerprint: entryText(entry, 'promptFingerprint', 80)
      || optionalText(session?.operation?.promptFingerprint, 80),
    promptSource: entryText(entry, 'promptSource', 80),
    operationIdSuffix: entryText(entry, 'operationIdSuffix', 80)
      || optionalText(session?.operation?.operationId?.slice(-16), 80),
    tabId: Number.isInteger(entry?.tabId) && entry.tabId >= 0 ? entry.tabId : null,
  };
  list.push(safe);
  if (list.length > MAX_DIAGNOSTIC_ENTRIES) {
    list.splice(0, list.length - MAX_DIAGNOSTIC_ENTRIES);
  }
  return safe;
}

function line(label, value) {
  return `${label}: ${value == null || value === '' ? 'немає' : value}`;
}

function formatTime(value) {
  return Number.isFinite(value) && value >= 0 ? new Date(value).toISOString() : 'немає';
}

function reportSession(session) {
  const currentTask = session.tasksById?.[session.taskOrder?.[session.currentTaskIndex]] || null;
  const enabledIds = (session.taskOrder || []).filter(id => session.tasksById?.[id]?.enabled);
  const completedTaskCount = session.runMode === 'ONE_PASS'
    ? enabledIds.filter(id => session.onePassCompletedTaskIds?.includes(id)).length
    : 0;
  const isCompleted = session.runMode === 'ONE_PASS' && enabledIds.length > 0 && completedTaskCount >= enabledIds.length;
  const successfulSendCount = Math.max(completedTaskCount, Number(session.successfulSendCount || 0));
  const scenarioAwaitingAssistant = session.scenarioWork?.managed === true
    && isCompleted
    && successfulSendCount > 0
    && session.operation?.phase === OperationPhase.SENT_VERIFIED;
  return [
    `Сеанс: ${safeText(session.name || 'без назви', 160)} (${safeText(session.id, 120)})`,
    line('  стан', scenarioAwaitingAssistant ? 'WAITING_RESPONSE' : (isCompleted ? 'COMPLETED' : session.runState)),
    ...(scenarioAwaitingAssistant ? [line('  пояснення стану', 'Core підтвердив Send; Scenario Work ще має підтвердити завершення відповіді ChatGPT перед наступним промптом.')] : []),
    line('  успішно надіслано', successfulSendCount),
    line('  виконано завдань', session.runMode === 'CONTINUOUS' ? 'не застосовується — постійний цикл' : `${completedTaskCount}/${enabledIds.length}`),
    line('  залишилось завдань', session.runMode === 'CONTINUOUS' ? 'не застосовується — постійний цикл' : Math.max(0, enabledIds.length - completedTaskCount)),
    line('  поточне завдання', safeText(currentTask?.label || currentTask?.id || '', 160)),
    line('  стан завдання', currentTask?.status),
    line('  етап операції', session.operation?.phase || OperationPhase.NONE),
    line('  очікувана розмова', redactChatGptUrl(session.operation?.targetUrl || currentTask?.normalizedUrl || currentTask?.url)),
    line('  повторна спроба не раніше', formatTime(currentTask?.retryAfterAt)),
    line('  остання помилка', safeText(session.lastError || '', MAX_DIAGNOSTIC_MESSAGE_LENGTH)),
  ].join('\n');
}

function reportEvent(entry) {
  const fields = [
    `подія=${entry.event}`,
    entry.sessionName ? `сеанс=${entry.sessionName}` : null,
    entry.taskLabel ? `завдання=${entry.taskLabel}` : null,
    entry.tabId != null ? `вкладка=${entry.tabId}` : null,
    entry.mode ? `режим=${entry.mode}` : null,
    entry.phase ? `етап=${entry.phase}` : null,
    entry.status ? `результат=${entry.status}` : null,
    entry.code ? `код=${entry.code}` : null,
    entry.target ? `ціль=${entry.target}` : null,
    entry.observed ? `спостережено=${entry.observed}` : null,
    entry.promptSource ? `джерело_промпта=${entry.promptSource}` : null,
    entry.promptFingerprint ? `відбиток=${entry.promptFingerprint}` : null,
    entry.message ? `пояснення=${entry.message}` : null,
  ].filter(Boolean);
  return `[${formatTime(entry.at)}] ${fields.join('; ')}`;
}

export function createDiagnosticReport(state, { now = Date.now(), extensionVersion = 'невідомо' } = {}) {
  const sessions = (state.sessionOrder || [])
    .map(id => state.sessionsById?.[id])
    .filter(Boolean);
  const events = Array.isArray(state.diagnostics) ? state.diagnostics : [];
  const lines = [
    'ChatGPT Автопілот — діагностичний звіт',
    `Версія розширення: ${safeText(extensionVersion, 40) || 'невідомо'}`,
    `Створено: ${formatTime(now)}`,
    `Версія стану: ${state.schemaVersion ?? 'невідомо'}`,
    '',
    'У звіт навмисно не включено: тексти промптів, повні приватні посилання, файли, дані сеансу браузера, ключі доступу, дані входу та вміст розмов.',
    '',
    'Поточний стан сеансів:',
    sessions.length ? sessions.map(reportSession).join('\n\n') : 'Сеансів немає.',
    '',
    `Діагностичні події (останні ${events.length}):`,
  ];
  if (events.length) lines.push(...events.map(reportEvent));
  else lines.push('Подій ще немає. Запустіть сеанс або залиште відкритою панель налаштувань на кілька секунд.');
  return `${lines.join('\n')}\n`;
}
