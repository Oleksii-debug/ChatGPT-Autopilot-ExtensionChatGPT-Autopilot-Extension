const $ = id => document.getElementById(id);
const LAST_SESSION_KEY = 'chatgpt-autopilot-last-session';

async function core(command, payload = {}) {
  const response = await chrome.runtime.sendMessage({ channel: 'autopilot-ui', command, payload });
  if (!response?.ok) throw new Error(response?.error?.message || 'Команда Drive не виконана.');
  return response.data;
}

function currentSessionId() {
  try { return localStorage.getItem(LAST_SESSION_KEY) || ''; } catch { return ''; }
}

function announce(text) {
  const live = $('live-announcer');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

function setStatus(text) {
  const status = $('drive-source-status');
  if (status) status.textContent = text;
  announce(text);
}

async function refreshSource() {
  const sessionId = currentSessionId();
  if (!sessionId) return null;
  const data = await core('GET_DRIVE_SOURCE', { sessionId });
  const source = data.source || {};
  $('drive-source-url').value = source.sourceUrl || '';
  $('drive-source-target').value = source.target || 'primary';
  $('drive-source-auto-sync').checked = source.autoSync === true;
  $('drive-source-sync-minutes').value = String(Math.max(1, Math.round((source.syncIntervalMs || 180000) / 60000)));
  $('drive-source-minimum-characters').value = String(source.minimumCharacters || 1000);
  const accepted = source.lastAcceptedVersion
    ? `Прийнята версія: ${source.lastAcceptedVersion}. Останнє застосування: ${source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString() : 'невідомо'}.`
    : 'Стабільний snapshot ще не приймався.';
  const checked = source.lastCheckedAt
    ? ` Остання перевірка: ${new Date(source.lastCheckedAt).toLocaleString()}.`
    : '';
  const next = source.autoSync && source.nextSyncAt
    ? ` Наступна перевірка не раніше: ${new Date(source.nextSyncAt).toLocaleString()}.`
    : '';
  const error = source.lastSyncError ? ` Остання помилка: ${source.lastSyncError}.` : '';
  const identity = accepted + checked + next + error;
  $('drive-source-identity').textContent = identity;
  return source;
}

async function bindSource() {
  const sessionId = currentSessionId();
  if (!sessionId) { setStatus('Спочатку відкрийте Session.'); return; }
  try {
    const url = $('drive-source-url').value.trim();
    const target = $('drive-source-target').value;
    const autoSync = $('drive-source-auto-sync').checked;
    const syncIntervalMinutes = Number($('drive-source-sync-minutes').value);
    const minimumCharacters = Number($('drive-source-minimum-characters').value);
    const data = await core('SET_DRIVE_SOURCE', {
      sessionId,
      sourceUrl: url,
      target,
      autoSync,
      syncIntervalMinutes,
      minimumCharacters,
    });
    $('drive-source-url').value = data.source.sourceUrl;
    $('drive-source-identity').textContent = 'Джерело прив’язано. Snapshot ще не приймався.';
    setStatus('Джерело Google Drive прив’язано до поточної Session.');
  } catch (error) { setStatus(error.message); }
}

async function syncSource() {
  const sessionId = currentSessionId();
  if (!sessionId) { setStatus('Спочатку відкрийте Session.'); return; }
  try {
    setStatus('Перевіряю стабільність файла в Google Drive…');
    const result = await core('SYNC_DRIVE_SOURCE', { sessionId });
    await refreshSource();
    setStatus(result.acceptance?.accepted === false ? 'Файл не змінився. Новий prompt не застосовано.' : 'Стабільний snapshot прийнято та застосовано.');
  } catch (error) { setStatus(error.message); }
}

async function loadAvailableFiles() {
  try {
    setStatus('Завантажую список доступних файлів Drive…');
    const data = await core('LIST_DRIVE_FILES');
    const picker = $('drive-source-picker');
    picker.replaceChildren(new Option('— виберіть файл —', ''));
    for (const file of data.files || []) {
      const option = new Option(`${file.name || 'Без назви'} — ${file.mimeType || 'невідомий тип'}`, JSON.stringify(file));
      picker.append(option);
    }
    picker.disabled = !(data.files || []).length;
    setStatus((data.files || []).length ? `Доступно файлів: ${data.files.length}.` : 'Доступних файлів Drive не знайдено.');
  } catch (error) { setStatus(error.message); }
}

function applyPickedFile() {
  const raw = $('drive-source-picker').value;
  if (!raw) return;
  try {
    const file = JSON.parse(raw);
    if (file.webViewLink) $('drive-source-url').value = file.webViewLink;
    else $('drive-source-url').value = `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view`;
    setStatus(`Вибрано файл: ${file.name || file.id}. Натисніть «Прив’язати джерело».`);
  } catch { setStatus('Не вдалося прочитати вибраний файл.'); }
}

async function refreshAuthStatus() {
  try {
    const data = await core('GET_DRIVE_AUTH_STATUS');
    const status = $('drive-source-auth');
    status.textContent = data.configured
      ? 'Приватний Drive path налаштований.'
      : 'Приватний Drive path наразі не налаштований: потрібні Google OAuth client ID і scope drive.file.';
    if (!data.configured) $('drive-source-picker').disabled = true;
  } catch (error) { $('drive-source-auth').textContent = error.message; }
}

function ensureRegion() {
  if ($('drive-source-sync-region')) return;
  const editor = $('session-editor');
  const configuration = $('configuration-heading')?.parentElement;
  if (!editor || !configuration) return;
  const section = document.createElement('section');
  section.id = 'drive-source-sync-region';
  section.setAttribute('aria-labelledby', 'drive-source-sync-heading');
  section.innerHTML = `
    <h4 id="drive-source-sync-heading">Безпечна синхронізація Google Drive</h4>
    <p id="drive-source-auth" role="status">Перевіряю авторизацію Google Drive…</p>
    <label for="drive-source-url">Посилання на файл Google Drive або Google Docs</label>
    <input id="drive-source-url" type="url" autocomplete="off">
    <label for="drive-source-picker">Вибрати доступний файл Drive</label>
    <select id="drive-source-picker" disabled><option value="">— спочатку відкрийте список —</option></select>
    <button id="drive-source-list-button" type="button">Показати доступні файли Drive</button>
    <button id="drive-source-use-picked" type="button">Використати вибраний файл</button>
    <label for="drive-source-target">Куди синхронізувати вміст</label>
    <select id="drive-source-target">
      <option value="primary">Основний prompt</option>
      <option value="prompt2">Другий prompt</option>
      <option value="prompt3">Третій prompt</option>
    </select>
    <label><input id="drive-source-auto-sync" type="checkbox"> Автоматично перевіряти цей файл</label>
    <label for="drive-source-sync-minutes">Перевіряти кожні, хвилин</label>
    <input id="drive-source-sync-minutes" type="number" min="1" max="1440" step="1" value="3">
    <label for="drive-source-minimum-characters">Мінімальна довжина prompt-а, символів</label>
    <input id="drive-source-minimum-characters" type="number" min="1" max="1000000" step="1" value="1000">
    <button id="drive-source-bind" type="button">Прив’язати джерело</button>
    <button id="drive-source-sync" type="button">Оновити з Drive</button>
    <p id="drive-source-identity" role="status">Стабільний snapshot ще не приймався.</p>
    <p id="drive-source-status" role="status" tabindex="0">Безпечна синхронізація ще не запускалась.</p>
  `;
  configuration.append(section);
  $('drive-source-list-button').addEventListener('click', loadAvailableFiles);
  $('drive-source-use-picked').addEventListener('click', applyPickedFile);
  $('drive-source-bind').addEventListener('click', bindSource);
  $('drive-source-sync').addEventListener('click', syncSource);
  void refreshAuthStatus();
  void refreshSource().catch(error => setStatus(error.message));
}

const observer = new MutationObserver(() => ensureRegion());
observer.observe(document.documentElement, { subtree: true, childList: true });
ensureRegion();
