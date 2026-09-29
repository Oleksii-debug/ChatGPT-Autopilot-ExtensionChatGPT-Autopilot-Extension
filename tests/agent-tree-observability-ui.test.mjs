import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const options = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');

function functionBody(source, name) {
  const syncStart = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const starts = [syncStart, asyncStart].filter(index => index >= 0);
  assert.ok(starts.length, `${name} must exist`);
  const start = Math.min(...starts);
  const candidates = [
    source.indexOf('\nfunction ', start + 1),
    source.indexOf('\nasync function ', start + 1),
  ].filter(index => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test('Agent tree observability is keyboard-readable and explicitly read-only', () => {
  assert.match(html, /id="orchestration-v2-agent-tree-heading">Дерево Agent і стан виконання/u);
  assert.match(html, /id="orchestration-v2-agent-tree-refresh-button"[^>]*type="button"/u);
  assert.match(html, /id="orchestration-v2-agent-tree-summary" role="status"/u);
  assert.match(html, /id="orchestration-v2-agent-tree" tabindex="0" aria-label="Дерево Agent і телеметрія"/u);
  assert.match(html, /Лише читання:[\s\S]*?без prompt body, transcript або hidden reasoning/u);
});

test('Agent tree UI renders projection text only through textContent', () => {
  const render = functionBody(options, 'renderOrchestrationV2AgentTree');
  assert.match(render, /projection\.textLines/u);
  assert.match(render, /\.textContent = lines\.length/u);
  assert.doesNotMatch(render, /innerHTML|insertAdjacentHTML|document\.write/u);
});

test('Agent tree refresh fences stale orchestra and stale action epoch responses', () => {
  const load = functionBody(options, 'loadOrchestrationV2AgentTree');
  assert.match(load, /GET_ORCHESTRATION_V2_AGENT_TREE/u);
  assert.match(load, /epoch !== orchestrationV2ActionEpoch/u);
  assert.match(load, /orchestraId !== ui\.selectedOrchestraId/u);
  assert.match(
    options,
    /previousOrchestraId !== ui\.selectedOrchestraId[\s\S]*?clearOrchestrationV2AgentTree/u,
  );
});

test('Agent tree command is in the read-only command set and dispatches only to projection read', () => {
  assert.match(
    serviceWorker,
    /READ_ONLY_UI_COMMANDS[\s\S]*?'GET_ORCHESTRATION_V2_AGENT_TREE'/u,
  );
  const branchStart = serviceWorker.indexOf("message.command === 'GET_ORCHESTRATION_V2_AGENT_TREE'");
  assert.ok(branchStart >= 0, 'Agent tree command branch must exist');
  const branchEnd = serviceWorker.indexOf("} else if (message.command ===", branchStart + 1);
  const branch = serviceWorker.slice(branchStart, branchEnd > branchStart ? branchEnd : serviceWorker.length);
  assert.match(branch, /getAgentTreeProjection/u);
  assert.doesNotMatch(branch, /start\(|resume\(|cycle\(|dispatchHierarchyEvent|recoverHierarchyNode|updateConfig/u);
});
