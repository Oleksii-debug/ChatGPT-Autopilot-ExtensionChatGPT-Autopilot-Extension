export const SESSION_DEFAULTS = Object.freeze({
  minimumSendIntervalMs: 120000,
  preSendDelayMs: 5000,
  busyCheckDelayMs: 2000,
  retryBackoffMs: 30000,
  retryPolicy: 'safe',
  tabStrategy: 'keep-open',
});

export const SESSION_DEFAULT_PROFILE_VALUES = Object.freeze({
  minimumSendIntervalMinutes: SESSION_DEFAULTS.minimumSendIntervalMs / 60000,
  preSendDelaySeconds: SESSION_DEFAULTS.preSendDelayMs / 1000,
  busyCheckDelaySeconds: SESSION_DEFAULTS.busyCheckDelayMs / 1000,
  retryBackoffSeconds: SESSION_DEFAULTS.retryBackoffMs / 1000,
  retryPolicy: SESSION_DEFAULTS.retryPolicy,
  tabStrategy: SESSION_DEFAULTS.tabStrategy,
});
