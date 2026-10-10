import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
const profile = mkdtempSync(path.join(os.tmpdir(), 'autopilot-10-tab-'));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--no-proxy-server', '--no-first-run',
  '--remote-allow-origins=*', '--user-data-dir=' + profile,
  '--remote-debugging-port=' + port, 'about:blank'], { stdio: ['ignore','ignore','pipe'] });
let stderr = '';
chrome.stderr.on('data', bytes => { stderr += bytes.toString(); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class PageConnection {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.pending = new Map(); this.nextId = 0;
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once:true });
      this.ws.addEventListener('error', reject, { once:true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result || {});
    });
  }
  async send(method, params = {}) {
    await this.ready;
    return new Promise((resolve,reject) => {
      const id = ++this.nextId;
      this.pending.set(id, {resolve,reject});
      this.ws.send(JSON.stringify({id,method,params}));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise:true, returnByValue:true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.ws.close(); }
}

const adapterSource = readFileSync(path.join(root, 'src/interaction/chatgpt-adapter.js'), 'utf8')
  .replace(/globalThis\.location\?\.href \|\| ''/g,
    "(globalThis.__apFakeUrl || 'https://chatgpt.com/')");
const listener = "document.querySelector('#frm').addEventListener('submit',e=>{e.preventDefault();"
  + "const txt=document.querySelector('#prompt').innerText;"
  + "const outer=document.createElement('article');outer.setAttribute('data-message-author-role','user');"
  + "const body=document.createElement('div');body.className='whitespace-pre-wrap';body.textContent=txt;outer.appendChild(body);"
  + "document.querySelector('#history').appendChild(outer);document.querySelector('#prompt').textContent='';"
  + "globalThis.__apFakeUrl='https://chatgpt.com/c/generated-'+(globalThis.__apTabId||'0');"
  + "const assistant=document.createElement('article');assistant.setAttribute('data-message-author-role','assistant');"
  + "assistant.textContent='Working';document.querySelector('#history').appendChild(assistant);});";
const html = '<!doctype html><html><head><style>form{margin:24px;display:block}'
  + '#prompt{width:400px;min-height:80px;border:1px solid gray;display:block;padding:6px}'
  + 'button{width:95px;height:35px}</style></head><body><main>'
  + '<form id="frm" aria-label="chat composer"><div id="prompt" data-testid="prompt-textarea"'
  + ' aria-label="Message" contenteditable="true" role="textbox"></div>'
  + '<button type="submit" data-testid="send-button" aria-label="Send">Send</button></form>'
  + '<div id="history"></div></main><script>' + listener + '</script></body></html>';

const connections = [];
try {
  let ready = false;
  for (let i=0; i<80; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (response.ok) { ready=true; break; }
    } catch {}
    await pause(100);
  }
  assert.ok(ready, 'Chromium debugging unavailable: ' + stderr.slice(-600));
  for (let id=0; id<10; id++) {
    const response = await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', {method:'PUT'});
    assert.equal(response.ok, true);
    const info = await response.json();
    const page = new PageConnection(info.webSocketDebuggerUrl);
    await page.send('Page.enable'); await page.send('Runtime.enable');
    const tree = await page.send('Page.getFrameTree');
    await page.send('Page.setDocumentContent', { frameId:tree.frameTree.frame.id, html });
    await page.eval("globalThis.__apTabId='" + id + "';");
    await page.eval(adapterSource);
    connections.push({id,page});
  }
  const results = await Promise.all(connections.map(async ({id,page}) => {
    const code = "(async()=>{const a=ChatGPTInteractionAdapter;const steps=[];"
      + "const deps={document:document,checkpointSubmit:async()=>{},wait:ms=>new Promise(r=>setTimeout(r,ms))};"
      + "for(let step=1;step<=3;step++){const prompt='background prompt " + id + " step '+step;"
      + "const req={requestId:'request-" + id + "-'+step,taskId:'tab-" + id + "',"
      + "expectedUrl:step===1?'https://chatgpt.com/':'https://chatgpt.com/c/generated-" + id + "',"
      + "promptText:prompt,postSendDelayMs:0,requireGenerationAcknowledgement:true};"
      + "const check=await a.execute({...req,mode:'CHECK_ONLY'},deps);"
      + "const inserted=await a.execute({...req,mode:'INSERT_ONLY'},deps);"
      + "const ready=await a.execute({...req,mode:'PREPARE_SEND'},deps);"
      + "const sent=await a.execute({...req,mode:'SUBMIT_EXISTING'},deps);"
      + "steps.push([check.status,inserted.status,ready.status,sent.status]);}"
      + "return {visibility:document.visibilityState,steps,"
      + "users:[...document.querySelectorAll('[data-message-author-role=user]')].map(x=>x.textContent.trim())};})()";
    return {id, ...(await page.eval(code))};
  }));
  assert.ok(results.filter(x=>x.visibility==='hidden').length>=8, 'Expected at least eight genuinely hidden Chrome tabs');
  for (const result of results) {
    assert.deepEqual(result.steps, Array.from({length:3}, () =>
      ['READY','INSERTED_NOT_SENT','READY','SENT_VERIFIED']));
    assert.deepEqual(result.users, Array.from({length:3}, (_,i) =>
      'background prompt ' + result.id + ' step ' + (i+1)));
  }
  console.log('PASS: 10 real Chromium tabs, >=8 hidden, each submitted and verified three distinct scenario prompts without manual Ctrl+Tab');
} finally {
  connections.forEach(({page})=>page.close());
  chrome.kill('SIGKILL');
  try { rmSync(profile,{recursive:true,force:true}); } catch {}
}
