import { MAX_TEMPLATE_SESSIONS, serializeSessionTemplate } from './template-generator.js';

const $ = id => document.getElementById(id);

function safeFileName(value) {
  return String(value || 'ChatGPT-Autopilot-template').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 100) || 'ChatGPT-Autopilot-template';
}

function downloadText(text, fileName) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function announce(text) {
  const live = $('live-announcer');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

function setStatus(text) {
  const status = $('template-download-status');
  if (status) status.textContent = text;
  announce(text);
}

function downloadTemplate() {
  const input = $('template-session-count');
  try {
    const count = Number(input?.value);
    if (!Number.isInteger(count) || count < 1 || count > MAX_TEMPLATE_SESSIONS) {
      throw new Error(`Введіть ціле число від 1 до ${MAX_TEMPLATE_SESSIONS}.`);
    }
    const text = serializeSessionTemplate(count);
    downloadText(text, `${safeFileName(`ChatGPT Автопілот — ${count} Session`)}.json`);
    setStatus(`Шаблон завантажено: ${count} Session.`);
  } catch (error) {
    setStatus(error?.message || 'Не вдалося створити шаблон.');
    input?.focus();
  }
}

function init() {
  const input = $('template-session-count');
  const button = $('download-session-template-button');
  if (!input || !button) return;
  input.max = String(MAX_TEMPLATE_SESSIONS);
  button.addEventListener('click', downloadTemplate);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      downloadTemplate();
    }
  });
}

init();
