const MODES = new Set(['shared-shared', 'shared-unique', 'unique-shared', 'unique-unique']);
const exactInteger = (value, min, max, label) => {
  const text = String(value ?? '').trim();
  const number = Number(text);
  if (!/^\d+$/u.test(text) || !Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label}: ціле число від ${min} до ${max}.`);
  }
  return number;
};

export function buildSimplifiedSessionConfig(fields, previous = null, createId = () => crypto.randomUUID()) {
  const mode = String(fields.mode || 'shared-shared');
  if (!MODES.has(mode)) throw new Error('Невідомий режим спрощеної сесії.');
  const [urlMode, promptMode] = mode.split('-');
  const urls = urlMode === 'shared'
    ? [String(fields.url || '').trim()]
    : String(fields.urls || '').split(/\r?\n/u).map(url => url.trim()).filter(Boolean);
  const prompts = promptMode === 'shared'
    ? [String(fields.prompt || '').trim()]
    : String(fields.prompts || '').split(/^\s*---\s*$/mu).map(prompt => prompt.trim()).filter(Boolean);
  if (!urls.length || urls.some(url => !url)) throw new Error('Укажіть посилання ChatGPT.');
  if (!prompts.length || prompts.some(prompt => !prompt)) throw new Error('Укажіть промпт.');
  if (urlMode === 'unique' && promptMode === 'unique' && urls.length !== prompts.length) {
    throw new Error('Кількість посилань і промптів повинна збігатися.');
  }
  const physicalCount = Math.max(urls.length, prompts.length);
  if (physicalCount > 1000) throw new Error('У режимі різних посилань або промптів можна вказати до 1000 позицій.');
  const compact = mode === 'shared-shared';
  const configuredTaskCount = compact ? exactInteger(fields.cycles, 1, 1_000_000, 'Цикли') : physicalCount;
  const intervalUnit = fields.intervalUnit === 'seconds' ? 'seconds' : 'minutes';
  const interval = exactInteger(fields.interval, 1, intervalUnit === 'seconds' ? 86400 : 1440, 'Інтервал');
  const preSendDelaySeconds = exactInteger(fields.delay, 1, 30, 'Пауза перед Send');
  const busyCheckDelaySeconds = exactInteger(fields.busy, 1, 30, 'Перевірка зайнятого чату');
  const retryBackoffSeconds = exactInteger(fields.retry, 5, 3600, 'Технічний повтор');
  const tasks = Array.from({ length: compact ? 1 : physicalCount }, (_, index) => ({
    id: previous?.tasks?.[index]?.id || createId(), enabled: true,
    label: `Крок ${index + 1}`,
    url: urls[urlMode === 'shared' ? 0 : index],
    promptOverride: promptMode === 'unique' ? prompts[index] : '',
  }));
  return {
    id: previous?.id || createId(), version: previous?.version || 0,
    simplifiedSession: true,
    name: String(fields.name || '').trim() || 'Спрощений сеанс',
    promptMode, urlMode,
    sharedPrompt: promptMode === 'shared' ? prompts[0] : '',
    defaultUniquePrompt: '',
    tasks, configuredTaskCount,
    runMode: fields.runMode === 'one-pass' ? 'one-pass' : 'continuous',
    minimumSendIntervalValue: interval, minimumSendIntervalUnit: intervalUnit,
    preSendDelaySeconds, busyCheckDelaySeconds, retryBackoffSeconds,
    retryPolicy: fields.retryPolicy === 'manual' ? 'manual' : 'safe',
    busyChatBehavior: 'skip-next',
    tabStrategy: ['keep-open', 'worker', 'open-close'].includes(fields.tabs) ? fields.tabs : 'keep-open',
  };
}


export function assertSimplifiedPortableProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Файл спрощених сесій має містити portable profile.');
  }
  const profilePrototype = Object.getPrototypeOf(profile);
  if (profilePrototype !== Object.prototype && profilePrototype !== null) {
    throw new Error('Файл спрощених сесій має містити portable profile.');
  }
  const sessionsDescriptor = Object.getOwnPropertyDescriptor(profile, 'sessions');
  if (!sessionsDescriptor?.enumerable || !Object.hasOwn(sessionsDescriptor, 'value')) {
    throw new Error('Файл спрощених сесій має містити список sessions.');
  }
  const sessions = sessionsDescriptor.value;
  if (!Array.isArray(sessions) || Object.getPrototypeOf(sessions) !== Array.prototype || sessions.length < 1) {
    throw new Error('Файл спрощених сесій має містити хоча б одну сесію.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(sessions);
  for (let index = 0; index < sessions.length; index += 1) {
    const itemDescriptor = descriptors[String(index)];
    if (!itemDescriptor?.enumerable || !Object.hasOwn(itemDescriptor, 'value')) {
      throw new Error('Список sessions у файлі спрощених сесій має бути суцільним масивом даних.');
    }
    const session = itemDescriptor.value;
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      throw new Error('Файл спрощених сесій містить некоректну сесію.');
    }
    const sessionPrototype = Object.getPrototypeOf(session);
    if (sessionPrototype !== Object.prototype && sessionPrototype !== null) {
      throw new Error('Файл спрощених сесій містить некоректну сесію.');
    }
    const simplifiedDescriptor = Object.getOwnPropertyDescriptor(session, 'simplifiedSession');
    if (!simplifiedDescriptor?.enumerable
        || !Object.hasOwn(simplifiedDescriptor, 'value')
        || simplifiedDescriptor.value !== true) {
      throw new Error('Через «Спрощені сесії» можна імпортувати лише сесії з явним прапорцем simplifiedSession=true.');
    }
  }
  return profile;
}
