// Safe public default. Customized release packages may replace only this file
// with a user-authorized profile containing Sessions, Tasks and prompts.
// Keep the repository copy disabled and free of private ChatGPT URLs/prompts.
export const BUNDLED_BOOTSTRAP_PROFILE = Object.freeze({
  enabled: false,
  profileId: 'default-disabled',
  revision: 1,
  autoStart: false,
  replaceManagedOnUpgrade: false,
  sessions: [],
});
