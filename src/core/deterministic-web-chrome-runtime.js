import {
  createDeterministicWebProviderV1,
  verifyDeterministicWebPostconditionV1,
} from './deterministic-web-provider.js';
import {
  normalizeObservationV1,
  normalizeVerificationV1,
} from './universal-agent-contracts.js';

export const DETERMINISTIC_WEB_RUNTIME_STORAGE_KEY = 'autopilot.deterministicWebRuntime.v1';
export const DETERMINISTIC_WEB_RECONCILE_VERIFIER_ID = 'deterministic-web-chrome-readback-v1';

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

function chromeOriginPattern(urlValue) {
  if (typeof urlValue !== 'string') throw new Error('deterministic web target origin is unavailable');
  let url;
  try { url = new URL(urlValue); } catch { throw new Error('deterministic web target origin is invalid'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('deterministic web target origin is not scriptable');
  }
  return `${url.protocol}//${url.hostname}/*`;
}

async function requireChromeHostAccessV1(chromeApi, urlValue) {
  if (!chromeApi?.permissions?.contains) {
    throw new Error('deterministic web runtime requires Chrome permissions API');
  }
  const origin = chromeOriginPattern(urlValue);
  const granted = await chromeApi.permissions.contains({ origins: [origin] });
  if (granted !== true) throw new Error('deterministic web host permission is not granted');
  return origin;
}

function clone(value) { return structuredClone(value); }

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function normalizeRuntimeStoreRecordV1(value) {
  const raw = plainRecord(value, 'deterministic web runtime storage');
  const allowed = new Set(['schemaVersion', 'effectsById', 'leasesByTargetId']);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`deterministic web runtime storage contains unknown field: ${String(key)}`);
    }
  }
  if (raw.schemaVersion !== 1) throw new Error('deterministic web runtime storage schema is unsupported');
  plainRecord(raw.effectsById, 'deterministic web runtime effectsById');
  plainRecord(raw.leasesByTargetId, 'deterministic web runtime leasesByTargetId');
  return clone(raw);
}

async function readChromeTargetV1(chromeApi, targetId) {
  const { tabId } = normalizeChromeDeterministicWebTargetV1(targetId);
  const live = await chromeApi.tabs.get(tabId);
  if (!live || live.id !== tabId) throw new Error('deterministic web target tab is unavailable');
  await requireChromeHostAccessV1(chromeApi, live.url);
  const result = await chromeApi.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => ({
      url: location.href,
      readyState: document.readyState,
      visibleSelectors: Array.from(document.querySelectorAll('[id]')).filter(node => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }).slice(0, 256).map(node => `#${CSS.escape(node.id)}`),
    }),
  });
  return {
    tabId,
    live,
    data: {
      targetId,
      tabId,
      url: result?.[0]?.result?.url || live?.url || '',
      readyState: result?.[0]?.result?.readyState || '',
      tabStatus: live?.status || '',
      visibleSelectors: result?.[0]?.result?.visibleSelectors || [],
    },
  };
}

export function createChromeDeterministicWebStoreV1(chromeApi, { storageKey = DETERMINISTIC_WEB_RUNTIME_STORAGE_KEY } = {}) {
  if (!chromeApi?.storage?.local?.get || !chromeApi?.storage?.local?.set) throw new Error('deterministic web runtime requires Chrome local storage');
  let chain = Promise.resolve();
  return Object.freeze({
    update(mutator) {
      const operation = chain.then(async () => {
        const record = await chromeApi.storage.local.get(storageKey);
        const hasStoredRecord = Boolean(record)
          && typeof record === 'object'
          && Object.prototype.hasOwnProperty.call(record, storageKey);
        const draft = hasStoredRecord
          ? normalizeRuntimeStoreRecordV1(record[storageKey])
          : { schemaVersion: 1, effectsById: {}, leasesByTargetId: {} };
        const next = await mutator(draft) || draft;
        const normalizedNext = normalizeRuntimeStoreRecordV1(next);
        await chromeApi.storage.local.set({ [storageKey]: normalizedNext });
        return clone(normalizedNext);
      });
      chain = operation.catch(() => undefined);
      return operation;
    },
  });
}

export function createChromeDeterministicWebTransportV1(chromeApi) {
  if (!chromeApi?.tabs?.get || !chromeApi?.tabs?.update || !chromeApi?.scripting?.executeScript || !chromeApi?.permissions?.contains) {
    throw new Error('deterministic web runtime requires Chrome tabs, scripting, and permissions APIs');
  }
  const script = () => chromeApi.scripting;
  async function preflight({ targetId, action }) {
    const tabId = tabIdFromTarget(targetId);
    const live = await chromeApi.tabs.get(tabId);
    if (!live || live.id !== tabId) throw new Error('deterministic web target tab is unavailable');
    await requireChromeHostAccessV1(chromeApi, action.kind === 'NAVIGATE' ? action.url : live.url);
  }
  return Object.freeze({
    preflight,
    async execute({ targetId, action }) {
      const tabId = tabIdFromTarget(targetId);
      const live = await chromeApi.tabs.get(tabId);
      if (!live || live.id !== tabId) throw new Error('deterministic web target tab is unavailable');
      await requireChromeHostAccessV1(chromeApi, action.kind === 'NAVIGATE' ? action.url : live.url);
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
      const readback = await readChromeTargetV1(chromeApi, targetId);
      return { data: readback.data, artifactRefs: [] };
    },
  });
}

export function createChromeDeterministicWebReconcileVerifierV1(chromeApi, { now = () => new Date().toISOString() } = {}) {
  if (!chromeApi?.tabs?.get || !chromeApi?.scripting?.executeScript || !chromeApi?.permissions?.contains) {
    throw new Error('independent deterministic web readback requires Chrome tabs, scripting, and permissions APIs');
  }
  return async ({ invocation, executionId, attempt, outcome, targetId, postcondition }) => {
    if (String(outcome || '').toUpperCase() !== 'VERIFIED') {
      throw new Error('automatic Chrome reconciliation only proves VERIFIED outcomes');
    }
    const normalizedTarget = normalizeChromeDeterministicWebTargetV1(targetId);
    const observedAt = now();
    const readback = await readChromeTargetV1(chromeApi, normalizedTarget.targetId);
    const observation = normalizeObservationV1({
      schemaVersion: 1,
      observationId: `web-reconcile-observe-${invocation.invocationId}`,
      invocationId: invocation.invocationId,
      status: 'OK',
      summary: 'Fresh independent Chrome readback captured for reconciliation.',
      data: readback.data,
      artifactRefs: [],
      observedAt,
    });
    const base = verifyDeterministicWebPostconditionV1({
      invocationId: invocation.invocationId,
      observation,
      expected: postcondition,
      now: observedAt,
    });
    const verification = normalizeVerificationV1({
      ...base,
      verificationId: `web-reconcile-verify-${invocation.invocationId}`,
      verifierId: DETERMINISTIC_WEB_RECONCILE_VERIFIER_ID,
      verificationAuthorityId: invocation.policyDecisionId,
      effectId: invocation.invocationId,
      executionId,
      attempt,
    });
    return Object.freeze({
      verifierId: DETERMINISTIC_WEB_RECONCILE_VERIFIER_ID,
      targetId: normalizedTarget.targetId,
      observation,
      verification,
    });
  };
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
