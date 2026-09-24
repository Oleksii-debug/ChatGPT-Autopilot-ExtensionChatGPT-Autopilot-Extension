import { createDeterministicWebProviderV1 } from './deterministic-web-provider.js';

export const DETERMINISTIC_WEB_RUNTIME_STORAGE_KEY = 'autopilot.deterministicWebRuntime.v1';

export function normalizeChromeDeterministicWebTargetV1(targetId) {
  if (typeof targetId !== 'string') throw new Error('deterministic web targetId must be canonical tab:<positive-safe-integer>');
  const match = /^tab:([1-9]\d*)$/.exec(targetId);
  if (!match) throw new Error('deterministic web targetId must be canonical tab:<positive-safe-integer>');
  const tabId = Number(match[1]);
  if (!Number.isSafeInteger(tabId) || tabId <= 0 || String(tabId) !== match[1]) {
    throw new Error('deterministic web targetId must be canonical tab:<positive-safe-integer>');
  }
  return Object.freeze({ targetId: `tab:${tabId}`, tabId });
}

function tabIdFromTarget(targetId) {
  return normalizeChromeDeterministicWebTargetV1(targetId).tabId;
}

function clone(value) { return structuredClone(value); }

export function createChromeDeterministicWebStoreV1(chromeApi, { storageKey = DETERMINISTIC_WEB_RUNTIME_STORAGE_KEY } = {}) {
  if (!chromeApi?.storage?.local?.get || !chromeApi?.storage?.local?.set) throw new Error('deterministic web runtime requires Chrome local storage');
  let chain = Promise.resolve();
  return Object.freeze({
    update(mutator) {
      const operation = chain.then(async () => {
        const record = await chromeApi.storage.local.get(storageKey);
        const current = record?.[storageKey];
        const draft = current && typeof current === 'object' && !Array.isArray(current)
          ? clone(current) : { schemaVersion: 1, effectsById: {}, leasesByTargetId: {} };
        if (draft.schemaVersion !== 1) throw new Error('deterministic web runtime storage schema is unsupported');
        const next = await mutator(draft) || draft;
        await chromeApi.storage.local.set({ [storageKey]: next });
        return clone(next);
      });
      chain = operation.catch(() => undefined);
      return operation;
    },
  });
}

export function createChromeDeterministicWebTransportV1(chromeApi) {
  if (!chromeApi?.tabs?.get || !chromeApi?.tabs?.update || !chromeApi?.scripting?.executeScript) {
    throw new Error('deterministic web runtime requires Chrome tabs and scripting APIs');
  }
  const script = () => chromeApi.scripting;
  return Object.freeze({
    async execute({ targetId, action }) {
      const tabId = tabIdFromTarget(targetId);
      const live = await chromeApi.tabs.get(tabId);
      if (!live?.id) throw new Error('deterministic web target tab is unavailable');
      if (action.kind === 'NAVIGATE') {
        await chromeApi.tabs.update(tabId, { url: action.url });
        return;
      }
      const result = await script().executeScript({
        target: { tabId, frameIds: [0] },
        func: (kind, selector, value) => {
          const node = document.querySelector(selector);
          if (!node) return { ok: false, code: 'TARGET_NOT_FOUND' };
          if (kind === 'CLICK') { node.click(); return { ok: true }; }
          if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement || node.isContentEditable)) {
            return { ok: false, code: 'TARGET_NOT_EDITABLE' };
          }
          if (node.isContentEditable) node.textContent = value;
          else node.value = value;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        },
        args: [action.kind, action.selector, action.value || ''],
      });
      if (!result?.[0]?.result?.ok) throw new Error(result?.[0]?.result?.code || 'WEB_ACTION_REJECTED');
    },
    async observe({ targetId }) {
      const tabId = tabIdFromTarget(targetId);
      const live = await chromeApi.tabs.get(tabId);
      const result = await script().executeScript({
        target: { tabId, frameIds: [0] },
        func: () => ({
          url: location.href,
          visibleSelectors: Array.from(document.querySelectorAll('[id]')).filter(node => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          }).slice(0, 256).map(node => `#${CSS.escape(node.id)}`),
        }),
      });
      return {
        data: {
          url: result?.[0]?.result?.url || live?.url || '',
          visibleSelectors: result?.[0]?.result?.visibleSelectors || [],
        },
        artifactRefs: [],
      };
    },
  });
}

export function createChromeDeterministicWebProviderV1({ chromeApi, reconcileVerify, now, leaseId } = {}) {
  const provider = createDeterministicWebProviderV1({
    transport: createChromeDeterministicWebTransportV1(chromeApi),
    store: createChromeDeterministicWebStoreV1(chromeApi),
    reconcileVerify,
    now,
    leaseId,
  });
  return Object.freeze({
    ...provider,
    invoke(input = {}) {
      const normalized = normalizeChromeDeterministicWebTargetV1(input.targetId);
      return provider.invoke({ ...input, targetId: normalized.targetId });
    },
  });
}
