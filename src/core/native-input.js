import { normalizeChatUrl, OperationPhase, RunState, TabStrategy } from './schema.js';
import { sameChatConversationUrl } from './tabs.js';

function fail(code) {
  const error = new Error(code);
  error.safeDiagnosticCode = code;
  throw error;
}

function authorizedOperation(state, message, sender, chromeApi) {
  if (sender?.id !== chromeApi.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) {
    fail('NATIVE_INPUT_SENDER_INVALID');
  }
  if (!['insert', 'submit'].includes(message.kind)) fail('NATIVE_INPUT_KIND_INVALID');
  const session = Object.values(state.sessionsById).find(s => s.operation?.operationId === message.requestId);
  const operation = session?.operation;
  if (!operation || operation.taskId !== message.taskId) fail('NATIVE_INPUT_OPERATION_MISSING');
  if (state.profile.masterPaused || ![RunState.RUNNING, RunState.RECOVERING].includes(session.runState)) {
    fail('NATIVE_INPUT_SESSION_PAUSED');
  }
  const phase = message.kind === 'insert' ? OperationPhase.INSERTING : OperationPhase.SUBMITTING;
  if (operation.phase !== phase) fail('NATIVE_INPUT_PHASE_INVALID');
  const hintKey = session.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION
    ? `__session_worker__:${session.id}` : operation.taskId;
  if (state.tabHintsByTaskId[hintKey]?.tabId !== sender.tab.id) fail('NATIVE_INPUT_TAB_NOT_OWNED');
  if (message.kind === 'submit' && operation.nativeSubmitDispatched) fail('NATIVE_SUBMIT_ALREADY_DISPATCHED');
  return { session, operation };
}

// This function is serialized into Chrome's isolated world. No page-owned JS,
// credentials, network responses or authentication data are read.
function targetProof(requestId, kind) {
  const targets = Array.from(document.querySelectorAll('[data-autopilot-native-target]'))
    .filter(element => element.getAttribute('data-autopilot-native-target') === requestId);
  if (targets.length !== 1) return false;
  const target = targets[0];
  if (!target || target.getAttribute('data-autopilot-native-target') !== requestId
    || !target.isConnected || target.disabled || target.readOnly
    || target.getAttribute('aria-disabled') === 'true') return false;
  let node = target;
  while (node) {
    if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return false;
    node = node.parentElement;
  }
  const style = getComputedStyle(target);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (kind === 'insert') {
    if (target !== document.activeElement || !target.matches('textarea, input, [contenteditable="true"]')) return false;
    return { url: location.href, platform: navigator?.platform || '' };
  }
  if (!target.matches('button, [role="button"]')) return false;
  // Attaching Chrome's debugger can display an infobar and resize the viewport.
  // Calculate coordinates AFTER attach, not from a stale content-script rectangle.
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (hit !== target && !target.contains(hit)) return false;
  return { url: location.href, x, y };
}

export async function performNativeInput(chromeApi, repository, message, sender) {
  const initial = await repository.load();
  const { operation } = authorizedOperation(initial, message, sender, chromeApi);
  const tabId = sender.tab.id;
  const tab = await chromeApi.tabs.get(tabId);
  if (!sameChatConversationUrl(normalizeChatUrl(tab.url), operation.targetUrl)) fail('NATIVE_INPUT_URL_MISMATCH');
  if (!chromeApi.debugger?.attach || !chromeApi.debugger?.sendCommand) fail('NATIVE_INPUT_PERMISSION_UNAVAILABLE');
  const target = { tabId };
  let attached = false;
  try {
    try {
      await chromeApi.debugger.attach(target, '1.3');
      attached = true;
    } catch { fail('NATIVE_INPUT_ATTACH_FAILED'); }
    const inspectTarget = () => chromeApi.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: targetProof,
      args: [message.requestId, message.kind],
    });
    const proof = await inspectTarget();
    if (!proof?.[0]?.result?.url || !sameChatConversationUrl(
      normalizeChatUrl(proof[0].result.url), operation.targetUrl,
    )) fail('NATIVE_INPUT_TARGET_CHANGED');

    // Recheck pause, ownership and operation identity after all asynchronous
    // preparation. Persist the submit effect boundary BEFORE native input.
    let text = '';
    await repository.update(state => {
      const live = authorizedOperation(state, message, sender, chromeApi);
      text = live.operation.promptText;
      if (message.kind === 'submit') live.operation.nativeSubmitDispatched = true;
      return state;
    });
    const finalProof = (await inspectTarget())?.[0]?.result;
    if (!finalProof?.url || !sameChatConversationUrl(normalizeChatUrl(finalProof.url), operation.targetUrl)) {
      fail('NATIVE_INPUT_TARGET_CHANGED');
    }
    if (message.kind === 'insert') {
      // Replace, do not append. The ChatGPT composer is contenteditable/ProseMirror and
      // a DOM Range selection is not always honored by CDP Input.insertText. Use a
      // browser-native Select All in the already-proven focused composer immediately
      // before inserting. Repeating this operation is therefore idempotent: one prompt
      // remains one prompt instead of accumulating duplicate copies.
      const isMac = String(finalProof.platform || '').toLowerCase().includes('mac');
      const modifiers = isMac ? 4 : 2; // CDP: Meta=4, Ctrl=2.
      await chromeApi.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', modifiers, key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      });
      await chromeApi.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
        type: 'keyUp', modifiers, key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      });
      await chromeApi.debugger.sendCommand(target, 'Input.insertText', { text });
    } else {
      if (!Number.isFinite(finalProof.x) || !Number.isFinite(finalProof.y)
        || finalProof.x < 0 || finalProof.y < 0) fail('NATIVE_INPUT_POINT_INVALID');
      const point = { x: finalProof.x, y: finalProof.y, button: 'left', clickCount: 1 };
      await chromeApi.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        ...point, type: 'mousePressed', buttons: 1,
      });
      await chromeApi.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        ...point, type: 'mouseReleased', buttons: 0,
      });
    }
  } finally {
    if (attached) {
      try { await chromeApi.debugger.detach(target); } catch { /* Tab may have closed. */ }
    }
  }
}
