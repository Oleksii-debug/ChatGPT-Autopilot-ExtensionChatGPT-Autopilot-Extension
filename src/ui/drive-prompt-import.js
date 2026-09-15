const MAX_DRIVE_TEXT_BYTES = 1024 * 1024;

const $ = id => document.getElementById(id);

function extractDriveFile(urlText) {
  const url = new URL(urlText.trim());
  const host = url.hostname.toLowerCase();

  if (host === 'docs.google.com') {
    const docMatch = url.pathname.match(/^\/document\/d\/([^/]+)/);
    if (docMatch) {
      return {
        id: docMatch[1],
        kind: 'google-doc',
        fetchUrl: `https://docs.google.com/document/d/${encodeURIComponent(docMatch[1])}/export?format=txt`,
      };
    }
  }

  if (host === 'drive.google.com') {
    const pathMatch = url.pathname.match(/^\/file\/d\/([^/]+)/);
    const id = pathMatch?.[1] || url.searchParams.get('id');
    if (id) {
      return {
        id,
        kind: 'drive-file',
        fetchUrl: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`,
      };
    }
  }

  throw new Error('Потрібне посилання на Google Docs або файл Google Drive.');
}

async function readTextResponse(response) {
  if (!response.ok) throw new Error(`Drive повернув HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DRIVE_TEXT_BYTES) {
    throw new Error('Файл завеликий для prompt-а. Максимум 1 МБ тексту.');
  }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_DRIVE_TEXT_BYTES) {
    throw new Error('Файл завеликий для prompt-а. Максимум 1 МБ тексту.');
  }
  if (contentType.includes('text/html') && /accounts\.google\.com|sign in|увійти/i.test(text)) {
    throw new Error('Цей файл не читається за посиланням без входу. Для приватного Drive потрібна OAuth-авторизація.');
  }
  if (!text.trim()) throw new Error('Drive повернув порожній вміст.');
  return text;
}

function setTextareaValue(field, text) {
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

function targetField() {
  const target = $('drive-prompt-target')?.value || 'primary';
  if (target === 'secondary') {
    const secondary = $('prompt-cadence-text');
    if (!secondary) throw new Error('Спочатку відкрийте налаштування другого prompt-а.');
    return secondary;
  }
  if ($('prompt-mode-unique')?.checked) {
    return $('default-unique-prompt');
  }
  return $('shared-prompt');
}

async function importDriveText() {
  const status = $('drive-prompt-status');
  try {
    const source = extractDriveFile($('drive-prompt-url').value);
    status.textContent = 'Читаю вміст файла з Drive…';
    const response = await fetch(source.fetchUrl, { method: 'GET', redirect: 'follow', credentials: 'include' });
    const text = await readTextResponse(response);
    const field = targetField();
    if (!field) throw new Error('Не знайдено поле prompt-а в поточній сесії.');
    setTextareaValue(field, text);
    status.textContent = `Вміст завантажено: ${text.length} символів. Тепер збережіть відповідне налаштування.`;
    field.focus();
  } catch (error) {
    status.textContent = error?.message || 'Не вдалося прочитати файл Drive.';
  }
}

function ensureDriveRegion() {
  if ($('drive-prompt-region')) return;
  const editor = $('session-editor');
  const configuration = $('configuration-heading')?.parentElement;
  if (!editor || !configuration) return;

  const section = document.createElement('section');
  section.id = 'drive-prompt-region';
  section.setAttribute('aria-labelledby', 'drive-prompt-heading');
  section.innerHTML = `
    <h4 id="drive-prompt-heading">Завантажити prompt з Google Drive</h4>
    <label for="drive-prompt-url">Посилання на Google Docs або текстовий файл Drive</label>
    <input id="drive-prompt-url" type="url" autocomplete="off" placeholder="https://docs.google.com/document/d/…">
    <label for="drive-prompt-target">Куди вставити вміст</label>
    <select id="drive-prompt-target">
      <option value="primary">Основний prompt</option>
      <option value="secondary">Другий prompt</option>
    </select>
    <button id="drive-prompt-load" type="button">Завантажити вміст з Drive</button>
    <p id="drive-prompt-status" role="status" tabindex="0">Файл ще не завантажувався.</p>
  `;
  configuration.append(section);
  $('drive-prompt-load').addEventListener('click', importDriveText);
}

const observer = new MutationObserver(() => ensureDriveRegion());
observer.observe(document.documentElement, { subtree: true, childList: true });
ensureDriveRegion();
