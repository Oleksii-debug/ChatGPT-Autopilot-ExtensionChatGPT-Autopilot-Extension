const STALE_CORE_PATTERN = /Unknown Core command:/i;
let reloadScheduled = false;

function setReadableStatus(message) {
  const appStatus = document.getElementById('app-status');
  const preview = document.getElementById('portable-profile-preview');
  const announcer = document.getElementById('live-announcer');
  if (appStatus) appStatus.textContent = message;
  if (preview && STALE_CORE_PATTERN.test(preview.textContent || '')) preview.textContent = message;
  if (announcer) {
    announcer.textContent = '';
    requestAnimationFrame(() => { announcer.textContent = message; });
  }
}

function reloadExtension(reason = 'manual') {
  if (reloadScheduled || typeof chrome?.runtime?.reload !== 'function') return;
  reloadScheduled = true;
  const message = reason === 'stale-core'
    ? 'Виявлено застарілу фонову частину Chrome. ChatGPT Автопілот автоматично перезавантажується. Після цього відкрийте його ще раз і повторіть останню дію.'
    : 'ChatGPT Автопілот перезавантажується. Після цього відкрийте його ще раз.';
  setReadableStatus(message);
  setTimeout(() => chrome.runtime.reload(), 1000);
}

document.getElementById('reload-extension-button')?.addEventListener('click', () => reloadExtension('manual'));

const preview = document.getElementById('portable-profile-preview');
if (preview) {
  const observer = new MutationObserver(() => {
    if (STALE_CORE_PATTERN.test(preview.textContent || '')) reloadExtension('stale-core');
  });
  observer.observe(preview, { childList: true, characterData: true, subtree: true });
}
