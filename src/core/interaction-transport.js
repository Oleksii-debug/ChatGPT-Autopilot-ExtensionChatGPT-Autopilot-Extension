import { InteractionResult } from '../shared/protocol.js';
import { waitForTaskTabReady } from './tabs.js';
import { SiteAdapterId, getSiteAdapter, requireSiteAdapterUrl } from './site-adapter-registry.js';
// These phases only inspect state. They neither change the composer nor click
// Send, so one receiver restoration and one retry are safe after an extension
// update or a ChatGPT navigation. Effectful phases remain non-replayable.
const SAFE_RECEIVER_RECOVERY_MODES = new Set([
  'CHECK_ONLY',
  'PREPARE_SEND',
  'VERIFY_AFTER_UNCERTAIN_SUBMIT',
  'READ_ASSISTANT_REPORT',
]);
const DEFAULT_CHECK_ONLY_UI_READY_TIMEOUT_MS = 45000;
const DEFAULT_CHECK_ONLY_UI_READY_POLL_MS = 250;

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isMissingReceiverError(error) {
  const message = String(error?.message || error || '');
  return /could not establish connection|receiving end does not exist/i.test(message);
}

function isChromeNetworkErrorPageAccessError(error) {
  const message = String(error?.message || error || '');
  return /chrome-error:\/\/|ERR_CONNECTION_|ERR_INTERNET_|ERR_NETWORK_|cannot access contents of url.*chrome-error|cannot access a chrome:\/\/ url/i.test(message);
}

async function reloadAfterNetworkErrorPage(chromeApi, tabId) {
  if (!chromeApi?.tabs?.reload) return false;
  try {
    await chromeApi.tabs.reload(tabId);
    return true;
  } catch {
    return false;
  }
}

function diagnosticError(code, message, cause, request) {
  const error = new Error(message);
  error.name = 'InteractionTransportError';
  error.safeDiagnosticCode = code;
  error.autopilotTaskId = request?.taskId || null;
  error.autopilotMode = request?.mode || null;
  if (cause) error.cause = cause;
  return error;
}

function attachRequestContext(error, request) {
  const value = error instanceof Error ? error : new Error(String(error || 'Interaction transport failed'));
  if (!value.safeDiagnosticCode) value.safeDiagnosticCode = 'INTERACTION_TRANSPORT_FAILURE';
  if (!value.autopilotTaskId) value.autopilotTaskId = request?.taskId || null;
  if (!value.autopilotMode) value.autopilotMode = request?.mode || null;
  return value;
}

export class ChromeInteractionTransport {
  constructor(chromeApi, {
    siteAdapterId = SiteAdapterId.CHATGPT_WEB,
    tabReadinessOptions = {},
    checkOnlyUiReadinessOptions = {},
  } = {}) {
    this.chrome = chromeApi;
    this.siteAdapter = getSiteAdapter(siteAdapterId);
    this.tabReadinessOptions = tabReadinessOptions;
    this.checkOnlyUiReadinessOptions = checkOnlyUiReadinessOptions;
  }

  async send(tabId, request) {
    return this.chrome.tabs.sendMessage(tabId, {
      channel: 'autopilot-interaction',
      request,
    });
  }

  async restoreMissingSafeReceiver(tabId) {
    if (!this.chrome.scripting?.executeScript) {
      throw new Error('Interaction receiver is missing and scripting recovery is unavailable');
    }
    await this.chrome.scripting.executeScript({
      target: { tabId },
      files: [...this.siteAdapter.recoveryScriptFiles],
    });
  }

  readinessOptions(request) {
    return {
      ...this.tabReadinessOptions,
      allowPostSendNavigation: request?.mode === 'VERIFY_AFTER_UNCERTAIN_SUBMIT',
    };
  }

  async waitForCheckOnlyUiReady(tabId, request, initialResponse) {
    if (request?.mode !== 'CHECK_ONLY') return initialResponse;

    const {
      timeoutMs = DEFAULT_CHECK_ONLY_UI_READY_TIMEOUT_MS,
      pollIntervalMs = DEFAULT_CHECK_ONLY_UI_READY_POLL_MS,
      now = () => Date.now(),
      wait = waitMs,
    } = this.checkOnlyUiReadinessOptions;
    const deadline = now() + Math.max(0, timeoutMs);
    let response = initialResponse;

    while (response?.ok === true
      && response.data?.status === InteractionResult.TEMPORARY_ERROR
      && response.data?.safeDiagnosticCode === 'COMPOSER_NOT_READY') {
      if (now() >= deadline) return response;
      await wait(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
      await waitForTaskTabReady(
        this.chrome,
        tabId,
        request.expectedUrl,
        this.readinessOptions(request),
      );
      try {
        response = await this.send(tabId, request);
      } catch (error) {
        throw diagnosticError(
          isMissingReceiverError(error)
            ? 'INTERACTION_RECEIVER_LOST_DURING_UI_READINESS'
            : 'INTERACTION_CHECK_ONLY_UI_POLL_FAILED',
          'CHECK_ONLY failed while waiting for the ChatGPT composer to become ready',
          error,
          request,
        );
      }
    }

    return response;
  }

  async execute(tabId, request) {
    if (tabId == null) throw new Error('Interaction tab id is required');

    try {
      if (request?.expectedUrl) requireSiteAdapterUrl(this.siteAdapter.id, request.expectedUrl);
      if (SAFE_RECEIVER_RECOVERY_MODES.has(request?.mode)) {
        await waitForTaskTabReady(
          this.chrome,
          tabId,
          request.expectedUrl,
          this.readinessOptions(request),
        );
      }

      let response;
      try {
        response = await this.send(tabId, request);
      } catch (error) {
        // An unpacked-extension update/reload can leave an already-open ChatGPT tab
        // without the newly registered content-script receiver. Only the read-only
        // allow-list above may be restored and retried once.
        if (!SAFE_RECEIVER_RECOVERY_MODES.has(request?.mode) || !isMissingReceiverError(error)) {
          const code = isMissingReceiverError(error)
            ? 'INTERACTION_RECEIVER_MISSING_EFFECTFUL'
            : 'INTERACTION_SEND_FAILED';
          throw diagnosticError(
            code,
            isMissingReceiverError(error)
              ? 'Interaction receiver is missing (receiving end does not exist); effectful request was not retried'
              : 'Interaction request could not reach the selected ChatGPT tab',
            error,
            request,
          );
        }

        // Re-check readiness because a missing receiver can be a navigation race.
        await waitForTaskTabReady(
          this.chrome,
          tabId,
          request.expectedUrl,
          this.readinessOptions(request),
        );
        try {
          await this.restoreMissingSafeReceiver(tabId);
        } catch (restoreError) {
          if (isChromeNetworkErrorPageAccessError(restoreError)) {
            await reloadAfterNetworkErrorPage(this.chrome, tabId);
            throw diagnosticError(
              'CHATGPT_PAGE_UNAVAILABLE',
              'ChatGPT page is temporarily unavailable; navigation will be retried after the configured backoff',
              restoreError,
              request,
            );
          }
          throw diagnosticError(
            'INTERACTION_RECEIVER_RESTORE_FAILED',
            'Safe receiver restoration failed after the receiving end was missing',
            restoreError,
            request,
          );
        }
        try {
          response = await this.send(tabId, request);
        } catch (retryError) {
          throw diagnosticError(
            isMissingReceiverError(retryError)
              ? 'INTERACTION_RECEIVER_STILL_MISSING'
              : 'INTERACTION_SAFE_PHASE_RETRY_FAILED',
            'A safe interaction phase failed after one bounded receiver restoration attempt',
            retryError,
            request,
          );
        }
      }

      response = await this.waitForCheckOnlyUiReady(tabId, request, response);

      if (!response?.ok || !response.data?.status) {
        throw diagnosticError(
          response?.error?.safeDiagnosticCode || response?.error?.code || 'INTERACTION_RESPONSE_INVALID',
          response?.error?.message || 'Interaction transport failed safely',
          null,
          request,
        );
      }
      if (!Object.values(InteractionResult).includes(response.data.status)) {
        throw diagnosticError(
          'INTERACTION_STATUS_UNKNOWN',
          `Unknown Interaction status: ${response.data.status}`,
          null,
          request,
        );
      }
      return response.data;
    } catch (error) {
      throw attachRequestContext(error, request);
    }
  }
}
