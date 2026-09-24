import './service-worker.js';
import {
  createChromeDeterministicWebProviderV1,
  createChromeDeterministicWebReconcileVerifierV1,
} from '../core/deterministic-web-chrome-runtime.js';
import {
  createDeterministicWebRuntimeAdmissionV1,
  DETERMINISTIC_WEB_RUNTIME_CHANNEL,
} from '../core/deterministic-web-runtime-admission.js';

const reconcileVerify = createChromeDeterministicWebReconcileVerifierV1(chrome);
const deterministicWebProvider = createChromeDeterministicWebProviderV1({
  chromeApi: chrome,
  reconcileVerify,
});
const deterministicWebAdmission = createDeterministicWebRuntimeAdmissionV1({
  provider: deterministicWebProvider,
  extensionId: chrome.runtime?.id || '',
});

void deterministicWebAdmission.ensureRecovered().catch(() => {
  console.error('ChatGPT Autopilot deterministic web recovery failed safely.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel !== DETERMINISTIC_WEB_RUNTIME_CHANNEL) return false;
  deterministicWebAdmission.dispatch(message, sender)
    .then(data => sendResponse({ ok: true, data }))
    .catch(() => sendResponse({ ok: false, error: { safeDiagnosticCode: 'DETERMINISTIC_WEB_RUNTIME_FAILED' } }));
  return true;
});
