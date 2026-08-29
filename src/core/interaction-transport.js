import { InteractionResult } from '../shared/protocol.js';

export class ChromeInteractionTransport {
  constructor(chromeApi) {
    this.chrome = chromeApi;
  }

  async execute(tabId, request) {
    if (tabId == null) throw new Error('Interaction tab id is required');
    const response = await this.chrome.tabs.sendMessage(tabId, {
      channel: 'autopilot-interaction',
      request,
    });
    if (!response?.ok || !response.data?.status) {
      throw new Error(response?.error?.message || 'Interaction transport failed safely');
    }
    if (!Object.values(InteractionResult).includes(response.data.status)) {
      throw new Error(`Unknown Interaction status: ${response.data.status}`);
    }
    return response.data;
  }
}
