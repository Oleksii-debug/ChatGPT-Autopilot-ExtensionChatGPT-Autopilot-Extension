import { SESSION_DEFAULT_PROFILE_VALUES } from '../shared/session-defaults.js';

export const MAX_TEMPLATE_SESSIONS = 200;

function assertSessionCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_TEMPLATE_SESSIONS) {
    throw new Error(`Кількість Session має бути цілим числом від 1 до ${MAX_TEMPLATE_SESSIONS}.`);
  }
  return count;
}

function templateSession(index) {
  const ordinal = index + 1;
  return {
    id: `template-session-${ordinal}`,
    name: `Сеанс ${ordinal}`,
    autoStart: false,
    promptMode: 'shared',
    sharedPrompt: '',
    defaultUniquePrompt: '',
    runMode: 'continuous',
    minimumSendIntervalMinutes: SESSION_DEFAULT_PROFILE_VALUES.minimumSendIntervalMinutes,
    preSendDelaySeconds: SESSION_DEFAULT_PROFILE_VALUES.preSendDelaySeconds,
    busyCheckDelaySeconds: SESSION_DEFAULT_PROFILE_VALUES.busyCheckDelaySeconds,
    retryBackoffSeconds: SESSION_DEFAULT_PROFILE_VALUES.retryBackoffSeconds,
    retryPolicy: SESSION_DEFAULT_PROFILE_VALUES.retryPolicy,
    tabStrategy: SESSION_DEFAULT_PROFILE_VALUES.tabStrategy,
    tasks: [{
      id: `template-session-${ordinal}-task-1`,
      enabled: false,
      label: 'Вкажіть посилання на потрібну розмову ChatGPT',
      url: '',
      promptOverride: '',
    }],
  };
}

export function createSessionTemplate(sessionCount, { profileName = 'ChatGPT Автопілот — шаблон' } = {}) {
  const count = assertSessionCount(sessionCount);
  return {
    format: 'chatgpt-autopilot-profile',
    version: 1,
    profileName,
    autoStart: false,
    sessions: Array.from({ length: count }, (_, index) => templateSession(index)),
  };
}

export function serializeSessionTemplate(sessionCount, options = {}) {
  return `${JSON.stringify(createSessionTemplate(sessionCount, options), null, 2)}\n`;
}
