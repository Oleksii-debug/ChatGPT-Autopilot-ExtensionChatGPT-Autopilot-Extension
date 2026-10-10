// Window authority belongs to a launch, never to browser focus or tab counts.
export function windowBindingError(code = 'SCENARIO_WINDOW_BINDING_REQUIRED') {
  const error = new Error(code === 'SCENARIO_TAB_WINDOW_MISMATCH'
    ? 'Вкладка поза робочим вікном сценарію. Поверніть її до вікна запуску.'
    : 'Потрібна прив’язка до робочого вікна. Відкрийте Пілот у потрібному вікні та натисніть «Запустити».');
  error.safeDiagnosticCode = code;
  return error;
}

export function assertSessionWindow(session, tab) {
  const managed = session?.scenarioWork?.managed === true;
  const expected = managed ? session.scenarioWork.preferredWindowId : session?.tabWindowId;
  if (managed && session.scenarioWork.windowBindingRequired === true && !Number.isInteger(expected)) {
    throw windowBindingError();
  }
  if (Number.isInteger(expected) && tab?.windowId !== expected) {
    throw windowBindingError('SCENARIO_TAB_WINDOW_MISMATCH');
  }
  return tab;
}

export async function resolveLaunchWindow(chromeApi, sender, sourceTabId) {
  const panelUrl = chromeApi.runtime.getURL('src/ui/options.html');
  if (sender?.id !== chromeApi.runtime.id || String(sender?.url || '').split(/[?#]/u)[0] !== panelUrl) {
    throw windowBindingError('SCENARIO_LAUNCH_SOURCE_INVALID');
  }
  const tabId = sender.tab?.id ?? sourceTabId;
  if (!Number.isInteger(tabId) || (sender.tab && sourceTabId != null && sourceTabId !== tabId)) {
    throw windowBindingError('SCENARIO_LAUNCH_SOURCE_INVALID');
  }
  const tab = await chromeApi.tabs.get(tabId);
  if (String(tab?.url || '').split(/[?#]/u)[0] !== panelUrl || !Number.isInteger(tab.windowId)) {
    throw windowBindingError('SCENARIO_LAUNCH_SOURCE_INVALID');
  }
  if (chromeApi.windows?.get) await chromeApi.windows.get(tab.windowId);
  return tab.windowId;
}

export async function openWindowPilotPanel(chromeApi, sourceTab) {
  if (!Number.isInteger(sourceTab?.windowId)) throw windowBindingError();
  const url = chromeApi.runtime.getURL('src/ui/options.html');
  const panels = await chromeApi.tabs.query({ windowId: sourceTab.windowId });
  const existing = panels.find(tab => tab.windowId === sourceTab.windowId && tab.url?.split(/[?#]/u)[0] === url);
  return existing ? chromeApi.tabs.update(existing.id, { active: true })
    : chromeApi.tabs.create({ url, windowId: sourceTab.windowId, active: true });
}

const profileScopeReads = new WeakMap();
export function localProfileScope(chromeApi) {
  if (profileScopeReads.has(chromeApi)) return profileScopeReads.get(chromeApi);
  const pending = readLocalProfileScope(chromeApi).catch(error => {
    profileScopeReads.delete(chromeApi); throw error;
  });
  profileScopeReads.set(chromeApi, pending);
  return pending;
}

async function readLocalProfileScope(chromeApi) {
  const key = 'autopilotLocalDiagnosticScopeV1';
  let value = (await chromeApi.storage.local.get(key))?.[key];
  if (typeof value !== 'string' || !value) {
    value = globalThis.crypto.randomUUID();
    await chromeApi.storage.local.set({ [key]: value });
  }
  return value;
}
