const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

class Cdp {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); this.events = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      } else if (message.method) this.events.push(message);
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws?.close(); } catch {} }
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripModuleSyntax(source) {
  return source
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace(/\bexport\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/g, '')
    .replace(/^export\s*\{[^}]+\};?\s*$/gm, '');
}

function buildDocumentHtml() {
  const css = read('src/ui/options.css');
  return read('src/ui/options.html')
    .replace(/<link\s+rel="stylesheet"\s+href="options\.css"\s*>/i, `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace(/<script\s+type="module"\s+src="[^"]+"\s*><\/script>/gi, '');
}

function buildUiBundle() {
  const parts = [
    stripModuleSyntax(read('src/ui/focus-policy.js')),
    stripModuleSyntax(read('src/ui/config-tools.js')),
    stripModuleSyntax(read('src/ui/uk-localization.js')),
    stripModuleSyntax(read('src/ui/options.js')),
  ];
  return `(async()=>{\n${parts.join('\n\n')}\n})()`;
}

function buildGuardBundle(rel) {
  return `(()=>{\n${stripModuleSyntax(read(rel))}\n})()`;
}

function buildInteractionAdapterForFixture() {
  return read('src/interaction/chatgpt-adapter.js')
    .replace(/globalThis\.location\?\.href \|\| ''/g, "(globalThis.__autopilotFixtureLocation || 'https://chatgpt.com/')");
}

const chromeMock = String.raw`(() => {
  const normalSession = { id:'normal-1', name:'Мій звичайний сеанс', runState:'STOPPED', displayRunState:'STOPPED', enabledTaskCount:1, completedTaskCount:0, successfulSendCount:0, managedKind:'' };
  const internalWorker = { id:'worker-internal', name:'Worker internal', runState:'RUNNING', displayRunState:'RUNNING', enabledTaskCount:1, completedTaskCount:0, successfulSendCount:0, managedKind:'ORCHESTRATION_WORKER' };
  const baseConfig = () => ({
    enabled:false, projectId:'demo', targetRepository:'owner/project', controlRepository:'owner/project', controlIssueNumber:121, controlCommentId:0,
    coordinatorAgentProviderId:'chatgpt-browser', workerAgentProviderId:'chatgpt-browser', coordinatorLaunchUrl:'https://chatgpt.com/',
    masterCoordinatorPrompt:'MASTER', coordinatorTickPrompt:'TICK', masterPromptVersion:1, fallbackUniversalPromptEnabled:false,
    defaultDesiredWorkers:5, absoluteMaxWorkers:8, maxLaunchesPerWindow:6, launchWindowSeconds:300, minimumWorkerLaunchIntervalMs:0,
    workerProbeIntervalSeconds:30, watchdogIntervalSeconds:300, maxCoordinatorTurns:10, staleWorkerAfterSeconds:3600,
    workerPreSendDelayMs:8000, workerBusyCheckDelayMs:2000, workerRetryBackoffMs:60000, coordinatorPreSendDelayMs:8000, coordinatorRetryBackoffMs:60000
  });
  const runtime = () => ({ workerCounts:{}, coordinator:{ generation:1, turnsUsed:0, maxTurns:10 }, provider:{ canonicalCommentId:444 }, launchPolicy:{ launchesInWindow:0 }, mode:'RUN', effectiveDesiredWorkers:0, hardMaxWorkers:8, lastAppliedControlRevision:0 });
  let nextOrchestra = 2;
  let selectedId = 'orch-1';
  const orchestras = [{ id:'orch-1', name:'Основний оркестр', ownerPaused:false, pausedSessionIds:[], createdAt:1, updatedAt:1 }];
  const configs = { 'orch-1': baseConfig() };
  const status = (id = selectedId) => {
    const selected = orchestras.find(item => item.id === id) || null;
    if (!selected) return { selectedId:'', orchestra:null, orchestras:[], config:baseConfig(), runtime:null, ownerPaused:false };
    return {
      selectedId:id,
      orchestra:{ ...selected, selected:id===selectedId },
      orchestras:orchestras.map(item => ({ ...item, selected:item.id===selectedId })),
      config:structuredClone(configs[id] || baseConfig()),
      runtime:runtime(),
      ownerPaused:selected.ownerPaused
    };
  };
  globalThis.__sentCommands = [];
  globalThis.__orchestraFixture = { orchestras, configs, get selectedId(){ return selectedId; } };
  const ok = data => ({ ok:true, data });
  const handlers = {
    GET_PROFILE_SETTINGS: () => ok({ rateLimitCooldownMinutes:5 }),
    GET_LOCAL_AI_SETTINGS: () => ok({ settings:{ enabled:false, providerType:'ollama', baseUrl:'http://127.0.0.1:11434', model:'', timeoutSeconds:90 } }),
    GET_AI_ROUTER_SETTINGS: () => ok({ settings:{ enabled:false, gatewayUrl:'http://127.0.0.1:17621', timeoutSeconds:180, mode:'strong', primary:{provider:'ollama',model:''}, strong:{provider:'openai',model:'gpt-5.6-sol'}, strongEveryNRequests:10, strongEveryMinutes:120, strongMinGapMinutes:0, strongMaxPerHour:0, carryStrongResultToPrimary:true, handoffMaxChars:12000, fallbackToStrongOnPrimaryError:true, keepPrimaryIfStrongFails:true }, runtime:{} }),
    TEST_AI_GATEWAY: () => ok({ result:{ version:'0.7.0', providers:['ollama','openai','openai-compatible'], openaiConfigured:true, compatibleApiKeyConfigured:false, compatibleBaseUrl:'http://127.0.0.1:1234/v1', providerStatus:[{provider:'openai',configured:true,ok:true,models:4}] } }),
    LIST_AI_ROUTER_MODELS: message => ok({ result:{ provider:message.payload?.provider, models:message.payload?.provider==='openai' ? ['gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-4.1'] : ['local-test-model'] } }),
    RUN_AI_ROUTED_PROMPT: message => ok({ result:{ text:'Тестова API-відповідь', route:'strong', trigger:message.payload?.forceStrong ? 'forced-strong' : 'strong-only', primary:null, strong:{provider:'openai',model:'gpt-5.6-sol',text:'Тестова API-відповідь'}, runtime:{ requestCount:1, primaryCount:0, strongCount:1, lastRoute:'strong', lastStrongAt:Date.now(), strongHistoryAt:[Date.now()] } } }),
    GET_AI_MANAGER_SETTINGS: () => ok({ settings:{}, runtime:{} }),
    LIST_SESSIONS: () => ok({ sessions:[normalSession, internalWorker] }),
    GET_ORCHESTRATION_V2_STATUS: () => ok(status()),
    CREATE_ORCHESTRATION_V2_ORCHESTRA: message => {
      const id='orch-'+nextOrchestra++;
      const item={ id, name:String(message.payload?.name || 'Новий оркестр'), ownerPaused:false, pausedSessionIds:[], createdAt:Date.now(), updatedAt:Date.now() };
      orchestras.push(item); configs[id]=baseConfig(); configs[id].projectId=''; configs[id].targetRepository=''; configs[id].controlRepository=''; selectedId=id; return ok(status(id));
    },
    SELECT_ORCHESTRATION_V2_ORCHESTRA: message => { selectedId=message.payload.id; return ok(status()); },
    RENAME_ORCHESTRATION_V2_ORCHESTRA: message => { const x=orchestras.find(i=>i.id===message.payload.id); if(x)x.name=message.payload.name; return ok(status(message.payload.id)); },
    PAUSE_ORCHESTRATION_V2_ORCHESTRA: message => { const x=orchestras.find(i=>i.id===message.payload.id); if(x)x.ownerPaused=true; return ok(status(message.payload.id)); },
    RESUME_ORCHESTRATION_V2_ORCHESTRA: message => { const x=orchestras.find(i=>i.id===message.payload.id); if(x)x.ownerPaused=false; return ok(status(message.payload.id)); },
    DELETE_ORCHESTRATION_V2_ORCHESTRA: message => { const idx=orchestras.findIndex(i=>i.id===message.payload.id); if(idx>=0)orchestras.splice(idx,1); delete configs[message.payload.id]; selectedId=orchestras[0]?.id || ''; return ok(status()); },
    GET_REMOTE_DISPATCH_STATUS: () => ok({ config:{ enabled:false }, feed:{}, ledger:{}, runtime:{} }),
    UPDATE_ORCHESTRATION_V2_SETTINGS: message => { configs[selectedId]=structuredClone(message.payload.settings); return ok({ config:configs[selectedId], status:status() }); },
    TEST_ORCHESTRATION_V2_CONTROL: () => ok({ selected:null, diagnostics:[{ message:'test fixture' }] }),
    RUN_ORCHESTRATION_V2_NOW: () => ok({}),
    EMERGENCY_STOP_ORCHESTRATION_V2: () => { configs[selectedId].enabled=false; return ok({ config:configs[selectedId], status:status() }); },
    RECORD_DIAGNOSTIC_SNAPSHOT: () => ok({}),
    GET_SESSION: () => ok({ session:{ id:'normal-1', version:1 } }),
  };
  globalThis.chrome = {
    runtime: {
      sendMessage: async message => {
        globalThis.__sentCommands.push(structuredClone(message));
        const handler = handlers[message.command];
        return handler ? handler(message) : ok({});
      },
      onMessage:{ addListener(){} },
      reload() { globalThis.__reloadCalled = true; }
    }
  };
})();`;

async function runBrowserSmoke({ verbose = true } = {}) {
  assert.ok(fs.existsSync(CHROMIUM), `Chromium not found: ${CHROMIUM}`);
  const debugPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-browser-smoke-'));
  const browser = spawn(CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-proxy-server',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'
  ], { stdio:['ignore','ignore','pipe'], detached: process.platform !== 'win32' });
  let stderr = '';
  browser.stderr.on('data', chunk => { stderr += String(chunk); });
  let cdp;
  try {
    let target;
    for (let i = 0; i < 100; i++) {
      try {
        const list = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
        target = list.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
        if (target) break;
      } catch {}
      await sleep(75);
    }
    assert.ok(target, `Chromium DevTools target unavailable. ${stderr.slice(-500)}`);
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const frameTree = await cdp.send('Page.getFrameTree');
    const frameId = frameTree.frameTree.frame.id;
    await cdp.send('Page.setDocumentContent', { frameId, html: buildDocumentHtml() });

    async function evaluate(expression, { awaitPromise = true } = {}) {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue:true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Chromium evaluation failed');
      }
      return result.result?.value;
    }

    await evaluate(chromeMock);
    await evaluate(buildUiBundle());
    await evaluate(buildGuardBundle('src/ui/runtime-reload-guard.js'));
    await evaluate(buildGuardBundle('src/ui/start-save-guard.js'));
    await sleep(450);

    const exception = cdp.events.find(event => event.method === 'Runtime.exceptionThrown');
    assert.equal(exception, undefined, `Browser JS exception: ${JSON.stringify(exception?.params || {})}`);

    const initial = await evaluate(`(() => ({
      selected:[...document.querySelectorAll('#mode-tabs [role=tab]')].find(x=>x.getAttribute('aria-selected')==='true')?.id,
      sessionsVisible:[...document.querySelectorAll('[data-app-mode="sessions"]')].some(x=>!x.hidden),
      orchestrationVisible:[...document.querySelectorAll('[data-app-mode="orchestration"]')].some(x=>!x.hidden),
      aiVisible:[...document.querySelectorAll('[data-app-mode="ai"]')].some(x=>!x.hidden),
      listedSessions:[...document.querySelectorAll('#session-list button[id^=\"session-select-\"]')].map(x=>x.textContent.trim()),
      legacyOpen:document.querySelector('#remote-dispatch-legacy').open,
      limits:{ maxWorkers:document.querySelector('#orchestration-v2-max-workers').value, maxLaunches:document.querySelector('#orchestration-v2-max-launches-window').value, window:document.querySelector('#orchestration-v2-launch-window').value },
      controlComment:document.querySelector('#orchestration-v2-control-comment').value,
      runtimeText:document.querySelector('#orchestration-v2-runtime').textContent
    }))()`);
    assert.equal(initial.selected, 'mode-sessions');
    assert.equal(initial.sessionsVisible, true);
    assert.equal(initial.orchestrationVisible, false);
    assert.equal(initial.aiVisible, false);
    assert.deepEqual(initial.listedSessions, ['Мій звичайний сеанс']);
    assert.equal(initial.legacyOpen, false);
    assert.deepEqual(initial.limits, { maxWorkers:'8', maxLaunches:'6', window:'300' });
    assert.equal(initial.controlComment, '', 'auto-discovered comment must not be copied into the editable pin field');
    assert.match(initial.runtimeText, /Control auto → 444/, 'runtime summary should expose the discovered comment without pinning it');

    const orchestration = await evaluate(`(async()=>{
      document.querySelector('#mode-orchestration').click(); await new Promise(r=>setTimeout(r,25));
      return { selected:document.querySelector('#mode-orchestration').getAttribute('aria-selected'), sessionsVisible:[...document.querySelectorAll('[data-app-mode="sessions"]')].some(x=>!x.hidden), orchestrationVisible:[...document.querySelectorAll('[data-app-mode="orchestration"]')].some(x=>!x.hidden), scenarioVisible:[...document.querySelectorAll('[data-app-mode="scenario-work"]')].some(x=>!x.hidden), aiVisible:[...document.querySelectorAll('[data-app-mode="ai"]')].some(x=>!x.hidden), focus:document.activeElement?.id };
    })()`);
    assert.deepEqual(orchestration, { selected:'true', sessionsVisible:false, orchestrationVisible:true, scenarioVisible:false, aiVisible:false, focus:'mode-orchestration' });

    const multiOrchestraUi = await evaluate(`(async()=>{
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const out={};
      out.initial={
        count:document.querySelector('#orchestration-v2-orchestra-list').options.length,
        selected:document.querySelector('#orchestration-v2-orchestra-list').value,
        pauseDisabled:document.querySelector('#pause-orchestration-v2-orchestra-button').disabled,
        resumeDisabled:document.querySelector('#resume-orchestration-v2-orchestra-button').disabled,
        innerSelected:[...document.querySelectorAll('#orchestration-v2-tabs [role=tab]')].find(x=>x.getAttribute('aria-selected')==='true')?.id
      };
      document.querySelector('#pause-orchestration-v2-orchestra-button').click(); await sleep(35);
      out.paused={
        summary:document.querySelector('#orchestration-v2-orchestra-summary').textContent,
        pauseDisabled:document.querySelector('#pause-orchestration-v2-orchestra-button').disabled,
        resumeDisabled:document.querySelector('#resume-orchestration-v2-orchestra-button').disabled
      };
      document.querySelector('#orchestration-v2-tab-settings').click(); await sleep(10);
      document.querySelector('#orchestration-v2-desired-workers').value='4';
      document.querySelector('#save-orchestration-v2-button').click(); await sleep(35);
      document.querySelector('#orchestration-v2-tab-orchestras').click(); await sleep(10);
      document.querySelector('#resume-orchestration-v2-orchestra-button').click(); await sleep(35);
      out.resumed={
        desired:__orchestraFixture.configs['orch-1'].defaultDesiredWorkers,
        ownerPaused:__orchestraFixture.orchestras.find(x=>x.id==='orch-1').ownerPaused
      };
      document.querySelector('#orchestration-v2-orchestra-name').value='Другий оркестр';
      document.querySelector('#new-orchestration-v2-orchestra-button').click(); await sleep(35);
      out.created={ count:document.querySelector('#orchestration-v2-orchestra-list').options.length, selected:__orchestraFixture.selectedId };
      document.querySelector('#orchestration-v2-tab-orchestras').click(); await sleep(10);
      const list=document.querySelector('#orchestration-v2-orchestra-list');
      list.value='orch-1'; list.dispatchEvent(new Event('change',{bubbles:true})); await sleep(35);
      out.firstAgain={ selected:list.value, desired:document.querySelector('#orchestration-v2-desired-workers').value };
      list.value='orch-2'; list.dispatchEvent(new Event('change',{bubbles:true})); await sleep(35);
      document.querySelector('#delete-orchestration-v2-orchestra-button').click(); await sleep(35);
      out.deleted={ count:list.options.length, selected:list.value, remainingDesired:__orchestraFixture.configs['orch-1'].defaultDesiredWorkers };
      return out;
    })()`);
    assert.deepEqual(multiOrchestraUi.initial, { count:1, selected:'orch-1', pauseDisabled:false, resumeDisabled:true, innerSelected:'orchestration-v2-tab-orchestras' });
    assert.match(multiOrchestraUi.paused.summary, /пауза: так/i);
    assert.equal(multiOrchestraUi.paused.pauseDisabled, true);
    assert.equal(multiOrchestraUi.paused.resumeDisabled, false);
    assert.deepEqual(multiOrchestraUi.resumed, { desired:4, ownerPaused:false });
    assert.equal(multiOrchestraUi.created.count, 2);
    assert.equal(multiOrchestraUi.created.selected, 'orch-2');
    assert.deepEqual(multiOrchestraUi.firstAgain, { selected:'orch-1', desired:'4' });
    assert.deepEqual(multiOrchestraUi.deleted, { count:1, selected:'orch-1', remainingDesired:4 });

    const keyboard = await evaluate(`(async()=>{
      document.querySelector('#mode-orchestration').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await new Promise(r=>setTimeout(r,25));
      const afterScenario={ scenarioSelected:document.querySelector('#mode-scenario-work').getAttribute('aria-selected'), scenarioFocus:document.activeElement?.id };
      document.querySelector('#mode-scenario-work').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await new Promise(r=>setTimeout(r,25));
      const afterAgent={ agentSelected:document.querySelector('#mode-agent').getAttribute('aria-selected'), agentFocus:document.activeElement?.id };
      document.querySelector('#mode-agent').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await new Promise(r=>setTimeout(r,25));
      return { ...afterScenario, ...afterAgent, aiSelected:document.querySelector('#mode-ai').getAttribute('aria-selected'), finalFocus:document.activeElement?.id };
    })()`);
    assert.deepEqual(keyboard, { scenarioSelected:'true', scenarioFocus:'mode-scenario-work', agentSelected:'true', agentFocus:'mode-agent', aiSelected:'true', finalFocus:'mode-ai' });

    const aiApiUi = await evaluate(`(async()=>{
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const initial=[...document.querySelector('#ai-router-strong-model').options].map(o=>o.value).filter(Boolean);
      document.querySelector('#test-ai-gateway-button').click(); await sleep(35);
      const keyStatus=document.querySelector('#ai-router-openai-key-status').textContent;
      document.querySelector('#ai-router-strong-models-button').click(); await sleep(35);
      const refreshed=[...document.querySelector('#ai-router-strong-model').options].map(o=>o.value).filter(Boolean);
      document.querySelector('#run-ai-router-strong-button').click(); await sleep(35);
      return {initial,keyStatus,refreshed,response:document.querySelector('#ai-router-test-response').textContent,status:document.querySelector('#ai-router-status').textContent};
    })()`);
    assert.ok(aiApiUi.initial.includes('gpt-5.6-sol'));
    assert.ok(aiApiUi.initial.includes('gpt-5.6-terra'));
    assert.ok(aiApiUi.initial.includes('gpt-5.6-luna'));
    assert.match(aiApiUi.keyStatus, /DPAPI \/ Gateway/);
    assert.ok(aiApiUi.refreshed.includes('gpt-4.1'));
    assert.equal(aiApiUi.response, 'Тестова API-відповідь');
    assert.match(aiApiUi.status, /Маршрут: strong/);

    const labels = await evaluate(`[...document.querySelectorAll('[data-app-mode="orchestration"] label')].map(x=>x.textContent.trim().replace(/\\s+/g,' ')).filter(Boolean)`);
    const overlyLong = labels.filter(text => text.split(/\s+/).length > 7);
    assert.deepEqual(overlyLong, [], `Orchestration labels should remain concise: ${overlyLong.join(' | ')}`);

    const groupSemantics = await evaluate(`({
      legends:[...document.querySelectorAll('[data-app-mode="orchestration"] fieldset.settings-group > legend')].map(x=>x.textContent.trim()),
      commentHelp:document.querySelector('#orchestration-v2-control-comment').getAttribute('aria-describedby'),
      launchHelp:document.querySelector('#orchestration-v2-max-launches-window').getAttribute('aria-describedby'),
      commentHelpText:document.querySelector('#orchestration-v2-control-comment-help').textContent.trim(),
      launchHelpText:document.querySelector('#orchestration-v2-launch-limit-help').textContent.trim()
    })`);
    assert.deepEqual(groupSemantics.legends, ['Завантажити JSON оркестру','Проєкт і control','Coordinator','Локальні ліміти']);
    assert.equal(groupSemantics.commentHelp, 'orchestration-v2-control-comment-help');
    assert.equal(groupSemantics.launchHelp, 'orchestration-v2-launch-limit-help');
    assert.match(groupSemantics.commentHelpText, /0/);
    assert.match(groupSemantics.launchHelpText, /0/);

    const validation = await evaluate(`(async()=>{
      document.querySelector('#mode-orchestration').click();
      document.querySelector('#orchestration-v2-desired-workers').value='10';
      document.querySelector('#orchestration-v2-max-workers').value='5';
      document.querySelector('#save-orchestration-v2-button').click();
      await new Promise(r=>setTimeout(r,50));
      return document.querySelector('#orchestration-v2-status').textContent;
    })()`);
    assert.match(validation, /не може перевищувати/i);

    const blankZeroPolicy = await evaluate(`(async()=>{
      const before=__sentCommands.filter(x=>x.command==='UPDATE_ORCHESTRATION_V2_SETTINGS').length;
      document.querySelector('#orchestration-v2-desired-workers').value='1';
      document.querySelector('#orchestration-v2-max-workers').value='2';
      document.querySelector('#orchestration-v2-max-launches-window').value='';
      document.querySelector('#save-orchestration-v2-button').click();
      await new Promise(r=>setTimeout(r,40));
      const after=__sentCommands.filter(x=>x.command==='UPDATE_ORCHESTRATION_V2_SETTINGS').length;
      return {before,after,status:document.querySelector('#orchestration-v2-status').textContent};
    })()`);
    assert.equal(blankZeroPolicy.after, blankZeroPolicy.before, 'blank launch limit must fail closed before Core update');
    assert.match(blankZeroPolicy.status, /введіть ціле число/i);

    const blankGapPolicy = await evaluate(`(async()=>{
      const before=__sentCommands.filter(x=>x.command==='UPDATE_ORCHESTRATION_V2_SETTINGS').length;
      document.querySelector('#orchestration-v2-max-launches-window').value='2';
      document.querySelector('#orchestration-v2-min-launch-gap').value='';
      document.querySelector('#save-orchestration-v2-button').click();
      await new Promise(r=>setTimeout(r,40));
      const after=__sentCommands.filter(x=>x.command==='UPDATE_ORCHESTRATION_V2_SETTINGS').length;
      return {before,after,status:document.querySelector('#orchestration-v2-status').textContent};
    })()`);
    assert.equal(blankGapPolicy.after, blankGapPolicy.before, 'blank launch gap must fail closed before Core update');
    assert.match(blankGapPolicy.status, /введіть ціле число/i);

    const roles = await evaluate(`(async()=>{
      const out=[];
      const roleConfigs=[
        {name:'conservative',initial:1,max:2,launches:2,window:300,gap:30},
        {name:'balanced',initial:4,max:8,launches:8,window:300,gap:5},
        {name:'throughput',initial:12,max:20,launches:30,window:600,gap:0}
      ];
      for (const role of roleConfigs) {
        document.querySelector('#orchestration-v2-desired-workers').value=String(role.initial);
        document.querySelector('#orchestration-v2-max-workers').value=String(role.max);
        document.querySelector('#orchestration-v2-max-launches-window').value=String(role.launches);
        document.querySelector('#orchestration-v2-launch-window').value=String(role.window);
        document.querySelector('#orchestration-v2-min-launch-gap').value=String(role.gap);
        document.querySelector('#save-orchestration-v2-button').click();
        await new Promise(r=>setTimeout(r,30));
        const message=[...__sentCommands].reverse().find(x=>x.command==='UPDATE_ORCHESTRATION_V2_SETTINGS');
        out.push({name:role.name, settings:message?.payload?.settings, status:document.querySelector('#orchestration-v2-status').textContent});
      }
      return out;
    })()`);
    assert.deepEqual(roles.map(x=>({name:x.name,initial:x.settings.defaultDesiredWorkers,max:x.settings.absoluteMaxWorkers,launches:x.settings.maxLaunchesPerWindow,window:x.settings.launchWindowSeconds,gap:x.settings.minimumWorkerLaunchIntervalMs,comment:x.settings.controlCommentId})), [
      {name:'conservative',initial:1,max:2,launches:2,window:300,gap:30000,comment:0},
      {name:'balanced',initial:4,max:8,launches:8,window:300,gap:5000,comment:0},
      {name:'throughput',initial:12,max:20,launches:30,window:600,gap:0,comment:0}
    ]);

    const evidence = await evaluate(`({ listed:__sentCommands.some(x=>x.command==='LIST_SESSIONS'), orchestration:__sentCommands.some(x=>x.command==='GET_ORCHESTRATION_V2_STATUS'), remote:__sentCommands.some(x=>x.command==='GET_REMOTE_DISPATCH_STATUS') })`);
    assert.deepEqual(evidence, { listed:true, orchestration:true, remote:true });

    await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:800, deviceScaleFactor:1, mobile:false });
    await sleep(30);
    const responsive = await evaluate(`({
      noHorizontalOverflow:document.documentElement.scrollWidth <= window.innerWidth + 1,
      layoutColumns:getComputedStyle(document.querySelector('.layout')).gridTemplateColumns,
      navPosition:getComputedStyle(document.querySelector('nav')).position,
      actionHeight:parseFloat(getComputedStyle(document.querySelector('#master-pause-button')).height),
      focusOutline:getComputedStyle(document.querySelector('#mode-orchestration')).outlineStyle
    })`);
    assert.equal(responsive.noHorizontalOverflow, true, 'options UI must not horizontally overflow at a narrow desktop viewport');
    assert.equal(responsive.navPosition, 'static');
    assert.ok(responsive.actionHeight >= 40, `primary controls must remain comfortably targetable, got ${responsive.actionHeight}px`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:1280, height:800, deviceScaleFactor:1, mobile:false });

    await cdp.send('Page.setDocumentContent', { frameId, html: `<!doctype html><html><body>
      <div id="messages" style="width:500px;min-height:20px"></div>
      <form id="composer-form" aria-label="Chat composer" style="width:500px;height:120px">
        <textarea id="prompt-textarea" aria-label="Message ChatGPT" style="width:420px;height:80px"></textarea>
        <button id="send" type="submit" data-testid="send-button" aria-label="Send message" style="width:60px;height:32px">Send</button>
      </form>
    </body></html>` });
    await evaluate(`(() => {
      const form = document.querySelector('#composer-form');
      const composer = document.querySelector('#prompt-textarea');
      form.addEventListener('submit', event => {
        event.preventDefault();
        const article = document.createElement('article');
        article.setAttribute('data-message-author-role', 'user');
        article.style.cssText = 'display:block;width:500px;min-height:24px';
        const body = document.createElement('div');
        body.setAttribute('data-message-content', 'true');
        body.textContent = composer.value;
        article.append(body);
        document.querySelector('#messages').append(article);
        composer.value = '';
        composer.dispatchEvent(new Event('input', { bubbles:true }));
        globalThis.__autopilotFixtureLocation = 'https://chatgpt.com/c/browser-generated';
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.setAttribute('aria-label', 'Stop generating');
        stop.textContent = 'Stop';
        stop.style.cssText = 'display:block;width:60px;height:32px';
        document.body.append(stop);
      });
    })()`);
    await evaluate(`globalThis.__autopilotFixtureLocation = 'https://chatgpt.com/'`);
    await evaluate(buildInteractionAdapterForFixture());
    const interaction = await evaluate(`(async () => {
      const base = { requestId:'browser-op-1', taskId:'task-1', expectedUrl:'https://chatgpt.com/', promptText:'Practical browser prompt' };
      const check = await ChatGPTInteractionAdapter.execute({ ...base, mode:'CHECK_ONLY' }, { document });
      const insert = await ChatGPTInteractionAdapter.execute({ ...base, mode:'INSERT_ONLY' }, { document, wait:async()=>{} });
      const prepare = await ChatGPTInteractionAdapter.execute({ ...base, mode:'PREPARE_SEND' }, { document });
      const submit = await ChatGPTInteractionAdapter.execute({ ...base, mode:'SUBMIT_EXISTING' }, { document, wait:async()=>{} });
      return { check:check.status, insert:insert.status, prepare:prepare.status, submit:submit.status, evidence:submit.submissionEvidence, messages:document.querySelectorAll('[data-message-author-role=\"user\"]').length, composer:document.querySelector('#prompt-textarea').value };
    })()`);
    assert.deepEqual(interaction, { check:'READY', insert:'INSERTED_NOT_SENT', prepare:'READY', submit:'SENT_VERIFIED', evidence:'NEW_USER_MESSAGE_MATCH', messages:1, composer:'' });

    // Generic Browser Agent E2E in real Chromium. This is intentionally an
    // AIS-like generic form fixture, not a claim of testing the real UKF AIS.
    await cdp.send('Page.setDocumentContent', { frameId, html: `<!doctype html><html><body>
      <main style="width:720px;min-height:420px;font-size:18px">
        <h1>Study registration fixture</h1>
        <form id="registration" style="display:grid;gap:12px;width:560px">
          <label for="course-name">Course name</label>
          <input id="course-name" name="course" type="text" placeholder="Course" style="width:420px;height:36px">
          <label for="semester">Semester</label>
          <select id="semester" name="semester" style="width:300px;height:36px">
            <option value="summer">Summer semester</option>
            <option value="winter">Winter semester</option>
          </select>
          <label><input id="required" type="checkbox" style="width:20px;height:20px"> Required course</label>
          <label for="note">Note</label>
          <div id="note" contenteditable="true" role="textbox" aria-label="Schedule note" style="width:420px;min-height:50px;border:1px solid #444"></div>
          <button id="save-registration" type="submit" style="width:180px;height:40px">Save registration</button>
        </form>
        <button id="legacy-control" onclick="document.querySelector('#legacy-status').textContent='legacy-clicked'" style="width:190px;height:40px;margin-top:16px">Legacy AIS action</button>
        <div id="legacy-status" aria-live="polite"></div>
        <canvas id="visual-control" width="220" height="70" style="display:block;width:220px;height:70px;border:1px solid #444;margin-top:16px"></canvas>
        <div id="visual-status" aria-live="polite"></div>
        <div id="drag-source" style="display:inline-block;width:140px;height:48px;border:1px solid #444;margin-top:16px;user-select:none">Course card</div>
        <div id="drag-target" style="display:inline-block;width:180px;height:48px;border:1px solid #444;margin-left:80px;user-select:none">Monday slot</div>
        <div id="drag-status" aria-live="polite"></div>
        <div id="coordinate-editor" contenteditable="true" style="width:420px;min-height:48px;border:1px solid #444;margin-top:16px"></div>
        <div id="result" role="status" aria-live="polite" style="min-height:32px;margin-top:16px"></div>
      </main>
    </body></html>` });
    await evaluate(`(() => {
      document.querySelector('#registration').addEventListener('submit', event => {
        event.preventDefault();
        const course = document.querySelector('#course-name').value;
        const semester = document.querySelector('#semester').value;
        const required = document.querySelector('#required').checked;
        const note = document.querySelector('#note').textContent;
        document.querySelector('#result').textContent = [course, semester, required ? 'required' : 'optional', note].join('|');
      });
      const canvas=document.querySelector('#visual-control');
      const context=canvas.getContext('2d');
      context.font='18px sans-serif';
      context.fillText('Visual-only timetable',18,38);
      canvas.addEventListener('click',()=>{ document.querySelector('#visual-status').textContent='visual-clicked'; });
      let dragging=false;
      document.querySelector('#drag-source').addEventListener('mousedown',()=>{ dragging=true; });
      document.querySelector('#drag-target').addEventListener('mouseup',()=>{
        if (dragging) document.querySelector('#drag-status').textContent='visual-dragged';
        dragging=false;
      });
      document.addEventListener('mouseup',()=>{ dragging=false; });
    })()`);
    const browserAgentSource = stripModuleSyntax(read('src/core/browser-agent.js'));
    await evaluate(`(()=>{ ${browserAgentSource}; globalThis.__agentSnapshot=snapshotBrowserPage; globalThis.__agentAction=executeBrowserPageAction; globalThis.__agentCoordinateProbe=probeBrowserCoordinateTarget; })()`);
    const initialAgentSnapshot = await evaluate(`globalThis.__agentSnapshot('fixture-snapshot-1')`);
    const byName = new Map(initialAgentSnapshot.elements.map(item => [item.name, item]));
    assert.ok(byName.get('Course name')?.ref, 'Agent snapshot must expose labelled text input');
    assert.ok(byName.get('Semester')?.ref, 'Agent snapshot must expose select');
    assert.ok(byName.get('Required course')?.ref, 'Agent snapshot must expose checkbox');
    assert.ok(byName.get('Schedule note')?.ref, 'Agent snapshot must expose contenteditable editor');
    assert.ok(byName.get('Save registration')?.ref, 'Agent snapshot must expose submit button');
    assert.ok(byName.get('Legacy AIS action')?.ref, 'Agent snapshot must expose legacy onclick control');
    const agentActions = {
      course:byName.get('Course name').ref,
      semester:byName.get('Semester').ref,
      required:byName.get('Required course').ref,
      note:byName.get('Schedule note').ref,
      save:byName.get('Save registration').ref,
      legacy:byName.get('Legacy AIS action').ref,
    };
    const agentE2e = await evaluate(`(async()=>{
      const refs=${JSON.stringify(agentActions)};
      const sid='fixture-snapshot-1';
      globalThis.__agentAction(sid,{type:'fill',ref:refs.course,text:'Systematic Philosophy'});
      globalThis.__agentAction(sid,{type:'select',ref:refs.semester,value:'Winter semester'});
      globalThis.__agentAction(sid,{type:'check',ref:refs.required,checked:true});
      globalThis.__agentAction(sid,{type:'fill',ref:refs.note,text:'No Friday conflict'});
      globalThis.__agentAction(sid,{type:'click',ref:refs.legacy});
      globalThis.__agentAction(sid,{type:'click',ref:refs.save});
      const verified=globalThis.__agentSnapshot('fixture-snapshot-2');
      return {
        course:document.querySelector('#course-name').value,
        semester:document.querySelector('#semester').value,
        required:document.querySelector('#required').checked,
        note:document.querySelector('#note').textContent,
        legacy:document.querySelector('#legacy-status').textContent,
        result:document.querySelector('#result').textContent,
        snapshotText:verified.text
      };
    })()`);
    assert.deepEqual({
      course:agentE2e.course,
      semester:agentE2e.semester,
      required:agentE2e.required,
      note:agentE2e.note,
      legacy:agentE2e.legacy,
      result:agentE2e.result,
    }, {
      course:'Systematic Philosophy',
      semester:'winter',
      required:true,
      note:'No Friday conflict',
      legacy:'legacy-clicked',
      result:'Systematic Philosophy|winter|required|No Friday conflict',
    });
    assert.match(agentE2e.snapshotText, /Systematic Philosophy\|winter\|required\|No Friday conflict/);

    const visualPoint = await evaluate(`(()=>{ const rect=document.querySelector('#visual-control').getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()`);
    const visualProof = await evaluate(`globalThis.__agentCoordinateProbe(${Number(visualPoint.x)},${Number(visualPoint.y)})`);
    assert.equal(visualProof?.target?.tag, 'canvas');
    assert.equal(visualProof?.target?.visualOnly, true);
    await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:visualPoint.x, y:visualPoint.y, button:'left', buttons:1, clickCount:1 });
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:visualPoint.x, y:visualPoint.y, button:'left', buttons:0, clickCount:1 });
    assert.equal(await evaluate(`document.querySelector('#visual-status').textContent`), 'visual-clicked');

    const dragPoints = await evaluate(`(()=>{
      const a=document.querySelector('#drag-source').getBoundingClientRect();
      const b=document.querySelector('#drag-target').getBoundingClientRect();
      return {start:{x:a.left+a.width/2,y:a.top+a.height/2},end:{x:b.left+b.width/2,y:b.top+b.height/2}};
    })()`);
    const dragStartProof = await evaluate(`globalThis.__agentCoordinateProbe(${Number(dragPoints.start.x)},${Number(dragPoints.start.y)})`);
    const dragEndProof = await evaluate(`globalThis.__agentCoordinateProbe(${Number(dragPoints.end.x)},${Number(dragPoints.end.y)})`);
    assert.equal(dragStartProof?.target?.tag, 'div');
    assert.equal(dragStartProof?.target?.visualOnly, true);
    assert.equal(dragEndProof?.target?.tag, 'div');
    assert.equal(dragEndProof?.target?.visualOnly, true);
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:dragPoints.start.x, y:dragPoints.start.y, button:'none', buttons:0 });
    await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:dragPoints.start.x, y:dragPoints.start.y, button:'left', buttons:1, clickCount:1 });
    for (let index=1; index<=6; index+=1) {
      const ratio=index/6;
      await cdp.send('Input.dispatchMouseEvent', {
        type:'mouseMoved',
        x:dragPoints.start.x+((dragPoints.end.x-dragPoints.start.x)*ratio),
        y:dragPoints.start.y+((dragPoints.end.y-dragPoints.start.y)*ratio),
        button:'none', buttons:1,
      });
      if(index<6) await new Promise(resolve=>setTimeout(resolve,75));
    }
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:dragPoints.end.x, y:dragPoints.end.y, button:'left', buttons:0, clickCount:1 });
    assert.equal(await evaluate(`document.querySelector('#drag-status').textContent`), 'visual-dragged');

    const editorPoint = await evaluate(`(()=>{ const rect=document.querySelector('#coordinate-editor').getBoundingClientRect(); return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}; })()`);
    const editorProof = await evaluate(`globalThis.__agentCoordinateProbe(${Number(editorPoint.x)},${Number(editorPoint.y)})`);
    assert.equal(editorProof?.target?.tag, 'div');
    assert.equal(editorProof?.target?.editable, true);
    assert.equal(editorProof?.target?.sensitive, false);
    await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:editorPoint.x, y:editorPoint.y, button:'left', buttons:1, clickCount:1 });
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:editorPoint.x, y:editorPoint.y, button:'left', buttons:0, clickCount:1 });
    await cdp.send('Input.insertText', { text:'Native coordinate editor text' });
    assert.equal(await evaluate(`document.querySelector('#coordinate-editor').textContent`), 'Native coordinate editor text');

    // Trusted Script real-CDP primitive proof. The manager-level approval/TOCTOU
    // contract is covered by Node tests; here we prove Chromium accepts the
    // exact network-guarded Runtime.evaluate sequence used by the extension.
    await cdp.send('Network.enable', {});
    await cdp.send('Network.setBlockedURLs', { urls:['*'] });
    try {
      const trusted = await cdp.send('Runtime.evaluate', {
        expression:`(() => { document.querySelector('#legacy-status').textContent='trusted-script-cdp'; })()`,
        awaitPromise:true, returnByValue:false, userGesture:true, silent:false, timeout:5000,
      });
      assert.ok(!trusted?.exceptionDetails, 'Trusted Script CDP evaluation must complete without exception');
      assert.equal(await evaluate(`document.querySelector('#legacy-status').textContent`), 'trusted-script-cdp');
    } finally {
      await cdp.send('Network.setBlockedURLs', { urls:[] });
      await cdp.send('Network.disable', {});
    }

    if (verbose) console.log('native-browser-smoke: PASS — Chromium UI + ChatGPT phased interaction + generic Browser Agent form/visual-coordinate click/drag/type + network-guarded Trusted Script CDP E2E');
    return { ok:true };
  } finally {
    try { cdp?.close(); } catch {}
    const exited = new Promise(resolve => browser.once('exit', resolve));
    try {
      if (process.platform !== 'win32' && browser.pid) process.kill(-browser.pid, 'SIGTERM');
      else browser.kill('SIGTERM');
    } catch {}
    await Promise.race([exited, sleep(750)]);
    if (browser.exitCode === null) {
      try {
        if (process.platform !== 'win32' && browser.pid) process.kill(-browser.pid, 'SIGKILL');
        else browser.kill('SIGKILL');
      } catch {}
      await Promise.race([exited, sleep(500)]);
    }
    try { fs.rmSync(profile, { recursive:true, force:true }); } catch {}
  }
}

module.exports = { runBrowserSmoke };
