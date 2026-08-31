import process from 'node:process';

const portArgument = process.argv.find((value) => value.startsWith('--port='));
const port = Number(portArgument?.slice('--port='.length) || 9222);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Use --port=<1-65535> for the local Chrome debugging endpoint');
}

const endpoint = `http://127.0.0.1:${port}`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${endpoint}${path}`, options);
  if (!response.ok) throw new Error(`Chrome endpoint ${path} returned HTTP ${response.status}`);
  return response.json();
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function findOptionsTarget() {
  let targets = await jsonRequest('/json/list');
  const existingOptionsPage = targets.find((target) => target.type === 'page'
    && /^chrome-extension:\/\/[^/]+\/src\/ui\/options\.html$/.test(target.url));
  const worker = targets.find((target) => target.type === 'service_worker'
    && /^chrome-extension:\/\/[^/]+\/src\/background\/service-worker\.js$/.test(target.url));
  const extensionTarget = existingOptionsPage || worker;
  assert(extensionTarget, 'The packaged ChatGPT Autopilot extension is not loaded');
  const extensionId = new URL(extensionTarget.url).hostname;
  const optionsUrl = `chrome-extension://${extensionId}/src/ui/options.html`;
  let page = existingOptionsPage;
  if (!page) {
    await jsonRequest(`/json/new?${encodeURIComponent(optionsUrl)}`, { method: 'PUT' });
    await delay(250);
    targets = await jsonRequest('/json/list');
    page = targets.find((target) => target.type === 'page' && target.url === optionsUrl);
  }
  assert(page?.webSocketDebuggerUrl, 'The ChatGPT Autopilot options page is not inspectable');
  return { page, extensionId, optionsUrl };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Page evaluation failed');
  return result.result?.value;
}

async function waitForDashboard(client) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate(client, `Boolean(
      document.readyState === 'complete'
      && document.documentElement.lang === 'uk'
      && document.title === 'ChatGPT Автопілот'
      && document.getElementById('create-session-button')
    )`);
    if (ready) return;
    await delay(50);
  }
  throw new Error('The localized options dashboard did not become ready');
}

async function dispatchKey(client, key, code, windowsVirtualKeyCode, modifiers = 0) {
  const common = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers };
  if (key === 'Enter') {
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    await client.send('Input.dispatchKeyEvent', { type: 'char', ...common, text: '\r', unmodifiedText: '\r' });
  } else {
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
  }
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

async function activeElement(client) {
  return evaluate(client, `(() => {
    const element = document.activeElement;
    if (!element) return null;
    const label = element.labels?.length
      ? Array.from(element.labels, (item) => item.textContent.trim()).join(' ')
      : '';
    return {
      id: element.id || '',
      tag: element.tagName,
      type: element.getAttribute('type') || '',
      name: element.getAttribute('aria-label') || label || element.textContent?.trim() || '',
      hidden: Boolean(element.hidden || element.closest('[hidden]')),
      disabled: Boolean(element.disabled),
    };
  })()`);
}

async function main() {
  const { page, extensionId, optionsUrl } = await findOptionsTarget();
  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();
  try {
    await Promise.all([
      client.send('Page.enable'),
      client.send('Runtime.enable'),
      client.send('Accessibility.enable'),
    ]);
    await client.send('Page.bringToFront');
    await waitForDashboard(client);

    const registeredCommand = await evaluate(client, `(async () => {
      const commands = await chrome.commands.getAll();
      return commands.find((command) => command.name === '_execute_action') || null;
    })()`);
    assert(registeredCommand, 'Chrome did not register the Open dashboard extension command');
    assert(registeredCommand.shortcut === 'Ctrl+Shift+Y', `Unexpected registered dashboard shortcut: ${registeredCommand.shortcut || 'unassigned'}`);

    const snapshot = await evaluate(client, `(() => {
      const visible = (element) => !element.hidden && !element.closest('[hidden]');
      const nameOf = (element) => {
        if (element.getAttribute('aria-label')) return element.getAttribute('aria-label').trim();
        if (element.labels?.length) return Array.from(element.labels, (label) => label.textContent.trim()).join(' ');
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) return labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent.trim() || '').join(' ').trim();
        return element.textContent?.trim() || element.getAttribute('title') || '';
      };
      const controls = Array.from(document.querySelectorAll('a[href], button, input, select, textarea'))
        .filter(visible)
        .map((element) => ({
          id: element.id || '',
          tag: element.tagName,
          type: element.getAttribute('type') || '',
          name: nameOf(element),
          disabled: Boolean(element.disabled),
          tabindex: element.getAttribute('tabindex'),
        }));
      const ids = Array.from(document.querySelectorAll('[id]'), (element) => element.id);
      return {
        lang: document.documentElement.lang,
        title: document.title,
        heading: document.querySelector('h1')?.textContent.trim() || '',
        statusRole: document.getElementById('app-status')?.getAttribute('role') || '',
        mainCount: document.querySelectorAll('main').length,
        navName: document.querySelector('nav')?.getAttribute('aria-label') || '',
        duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
        unnamedControls: controls.filter((control) => !control.name),
        positiveTabindex: controls.filter((control) => Number(control.tabindex) > 0),
        visibleControlCount: controls.length,
      };
    })()`);

    assert(snapshot.lang === 'uk', `Expected Ukrainian document language, received ${snapshot.lang}`);
    assert(snapshot.title === 'ChatGPT Автопілот', `Unexpected document title: ${snapshot.title}`);
    assert(snapshot.heading === 'ChatGPT Автопілот', `Unexpected page heading: ${snapshot.heading}`);
    assert(snapshot.statusRole === 'status', 'The persistent application status must expose role=status');
    assert(snapshot.mainCount === 1, 'The page must expose exactly one main landmark');
    assert(snapshot.navName === 'Навігація сеансами', `Unexpected navigation name: ${snapshot.navName}`);
    assert(snapshot.duplicateIds.length === 0, `Duplicate element ids: ${snapshot.duplicateIds.join(', ')}`);
    assert(snapshot.unnamedControls.length === 0, `Visible controls without names: ${JSON.stringify(snapshot.unnamedControls)}`);
    assert(snapshot.positiveTabindex.length === 0, `Positive tabindex breaks DOM order: ${JSON.stringify(snapshot.positiveTabindex)}`);

    const axTree = await client.send('Accessibility.getFullAXTree');
    const interactiveRoles = new Set(['button', 'checkbox', 'combobox', 'link', 'radio', 'spinbutton', 'textbox']);
    const unnamedAxNodes = (axTree.nodes || []).filter((node) => !node.ignored
      && interactiveRoles.has(node.role?.value)
      && !String(node.name?.value || '').trim());
    assert(unnamedAxNodes.length === 0, `Accessibility tree has ${unnamedAxNodes.length} unnamed interactive controls`);

    await evaluate(client, `document.activeElement?.blur()`);
    const tabOrder = [];
    for (let index = 0; index < 40; index += 1) {
      await dispatchKey(client, 'Tab', 'Tab', 9);
      const active = await activeElement(client);
      assert(active && !active.hidden, `Tab reached a hidden element at position ${index + 1}`);
      assert(!active.disabled, `Tab reached a disabled element at position ${index + 1}`);
      tabOrder.push(active);
      if (active.id === tabOrder[0]?.id && index > 0) break;
    }
    const createIndex = tabOrder.findIndex((item) => item.id === 'create-session-button');
    assert(createIndex >= 0, 'Create Session is not reachable by Tab');

    await evaluate(client, `document.getElementById('create-session-button').focus()`);
    await dispatchKey(client, 'Enter', 'Enter', 13);
    let editorOpened = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate(client, `!document.getElementById('session-editor').hidden`)) {
        editorOpened = true;
        break;
      }
      await delay(50);
    }
    assert(editorOpened, 'Enter did not open the Session editor from Create Session');
    const afterCreate = await activeElement(client);
    assert(afterCreate?.id === 'session-name', `Create Session should focus Session name, received ${JSON.stringify(afterCreate)}`);

    await evaluate(client, `document.getElementById('save-session-button').focus()`);
    await dispatchKey(client, 'Enter', 'Enter', 13);
    await delay(50);
    const validation = await evaluate(client, `(() => {
      const summary = document.getElementById('form-error-summary');
      const focused = document.activeElement;
      return {
        summaryHidden: summary.hidden,
        summaryRole: summary.getAttribute('role'),
        summaryName: summary.getAttribute('aria-label'),
        summaryText: summary.textContent.trim(),
        focusedId: focused?.id || '',
        rawTraceback: /(?:Traceback|Error:\\s+at\\s|at \\w+ \\([^)]*:\\d+:\\d+\\))/i.test(summary.textContent),
      };
    })()`);
    assert(!validation.summaryHidden, 'Invalid configuration did not expose the error summary');
    assert(validation.summaryRole === 'region', 'Validation summary must remain a named region');
    assert(validation.summaryName === 'Помилки налаштування', `Unexpected validation summary name: ${validation.summaryName}`);
    assert(validation.summaryText.length > 0, 'Validation summary is empty');
    assert(validation.focusedId, 'Validation did not move focus to an actionable error target');
    assert(!validation.rawTraceback, 'Raw traceback leaked into the user-visible validation summary');

    console.log(JSON.stringify({
      status: 'PASS',
      browserEndpoint: endpoint,
      extensionId,
      optionsUrl,
      registeredCommand,
      visibleControlCount: snapshot.visibleControlCount,
      axNodeCount: axTree.nodes?.length || 0,
      tabStopsChecked: tabOrder.length,
      createSessionTabIndex: createIndex + 1,
      focusAfterCreate: afterCreate,
      validation,
    }, null, 2));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`Chrome accessibility smoke failed: ${error.message}`);
  process.exitCode = 1;
});
