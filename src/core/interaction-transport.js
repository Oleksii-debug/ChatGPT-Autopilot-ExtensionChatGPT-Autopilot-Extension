import { InteractionResult } from '../shared/protocol.js';
import { waitForTaskTabReady } from './tabs.js';

const INTERACTION_SCRIPT_FILES = Object.freeze([
  'src/interaction/chatgpt-adapter.js',
  'src/interaction/content-script.js',
]);
const DEFAULT_CHECK_ONLY_UI_READY_TIMEOUT_MS = 15000;
const DEFAULT_CHECK_ONLY_UI_READY_POLL_MS = 100;

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isMissingReceiverError(error) {
  const message = String(error?.message || error || '');
  return /could not establish connection|receiving end does not exist/i.test(message);
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
    tabReadinessOptions = {},
    checkOnlyUiReadinessOptions = {},
  } = {}) {
    this.chrome = chromeApi;
    this.tabReadinessOptions = tabReadinessOptions;
    this.checkOnlyUiReadinessOptions = checkOnlyUiReadinessOptions;
  }

  async send(tabId, request) {
    return this.chrome.tabs.sendMessage(tabId, {
      channel: 'autopilot-interaction',
      request,
    });
  }

  async restoreMissingCheckOnlyReceiver(tabId) {
    if (!this.chrome.scripting?.executeScript) {
      throw new Error('Interaction receiver is missing and scripting recovery is unavailable');
    }
    await this.chrome.scripting.executeScript({
      target: { tabId },
      files: [...INTERACTION_SCRIPT_FILES],
    });
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
        this.tabReadinessOptions,
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
      if (request?.mode === 'CHECK_ONLY') {
        await waitForTaskTabReady(
          this.chrome,
          tabId,
          request.expectedUrl,
          this.tabReadinessOptions,
        );
      }

      let response;
      try {
        response = await this.send(tabId, request);
      } catch (error) {
        // An unpacked-extension update/reload can leave an already-open ChatGPT tab
        // without the newly registered content-script receiver. CHECK_ONLY has zero
        // page mutations, so it is safe to restore the two interaction scripts and
        // retry exactly once. Effectful/prompt-bearing phases are never replayed here.
        if (request?.mode !== 'CHECK_ONLY' || !isMissingReceiverError(error)) {
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
          this.tabReadinessOptions,
        );
        try {
          await this.restoreMissingCheckOnlyReceiver(tabId);
        } catch (restoreError) {
          throw diagnosticError(
            'INTERACTION_RECEIVER_RESTORE_FAILED',
            'CHECK_ONLY receiver restoration failed after the receiving end was missing',
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
              : 'INTERACTION_CHECK_ONLY_RETRY_FAILED',
            'CHECK_ONLY failed after one bounded receiver restoration attempt',
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
