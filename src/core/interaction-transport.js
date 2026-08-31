import { InteractionResult } from '../shared/protocol.js';

const INTERACTION_SCRIPT_FILES = Object.freeze([
  'src/interaction/chatgpt-adapter.js',
  'src/interaction/content-script.js',
]);

function isMissingReceiverError(error) {
  const message = String(error?.message || error || '');
  return /could not establish connection|receiving end does not exist/i.test(message);
}

export class ChromeInteractionTransport {
  constructor(chromeApi) {
    this.chrome = chromeApi;
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

  async execute(tabId, request) {
    if (tabId == null) throw new Error('Interaction tab id is required');

    let response;
    try {
      response = await this.send(tabId, request);
    } catch (error) {
      // An unpacked-extension update/reload can leave an already-open ChatGPT tab
      // without the newly registered content-script receiver. CHECK_ONLY has zero
      // page mutations, so it is safe to restore the two interaction scripts and
      // retry exactly once. Effectful/prompt-bearing phases are never replayed here.
      if (request?.mode !== 'CHECK_ONLY' || !isMissingReceiverError(error)) throw error;
      await this.restoreMissingCheckOnlyReceiver(tabId);
      response = await this.send(tabId, request);
    }

    if (!response?.ok || !response.data?.status) {
      throw new Error(response?.error?.message || 'Interaction transport failed safely');
    }
    if (!Object.values(InteractionResult).includes(response.data.status)) {
      throw new Error(`Unknown Interaction status: ${response.data.status}`);
    }
    return response.data;
  }
}
