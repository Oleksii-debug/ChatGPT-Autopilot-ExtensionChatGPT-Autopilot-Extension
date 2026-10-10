import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OrchestrationV2Manager } from '../src/core/orchestration-v2-manager.js';

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


test('orchestra selection rejects stale async responses before status or Agent tree render', () => {
  const select = functionBody(options, 'selectOrchestrationV2Orchestra');
  assert.match(select, /const epoch = beginOrchestrationV2Action\(\)/u);
  const awaitIndex = select.indexOf("await core('SELECT_ORCHESTRATION_V2_ORCHESTRA'");
  const fenceIndex = select.indexOf('if (epoch !== orchestrationV2ActionEpoch) return;', awaitIndex);
  const renderIndex = select.indexOf('renderOrchestrationV2Status(data)', fenceIndex);
  assert.ok(awaitIndex >= 0 && fenceIndex > awaitIndex && renderIndex > fenceIndex,
    'stale selection must be rejected before rendering status');
  assert.match(select, /loadOrchestrationV2AgentTree\(\{ epoch \}\)/u);
  const catchIndex = select.indexOf('catch (error)');
  assert.ok(catchIndex > renderIndex, 'selection handler must have a guarded error path');
  assert.match(
    select.slice(catchIndex),
    /if \(epoch !== orchestrationV2ActionEpoch\) return;[\s\S]*?Не вдалося вибрати оркестр/u,
  );
});


test('read-only Agent tree rejects inherited and hostile orchestra IDs, then recovers after JSON restart', async () => {
  // Exercise the actual manager method, not a replacement status/projection
  // authority: invalid selection may not reach runtime storage or execute a
  // coercing toString getter. A legitimate persisted ID remains readable.
  const persisted = JSON.parse(JSON.stringify({
    selectedId: 'orch-1',
    byId: { 'orch-1': { id: 'orch-1' } },
  }));
  const manager = Object.create(OrchestrationV2Manager.prototype);
  manager.loadMeta = async () => persisted;
  const reads = [];
  manager.controllerFor = id => {
    reads.push(id);
    return { runtimeRepository: { load: async () => ({ hierarchy: null }) } };
  };
  let coercionCalls = 0;
  const forgedId = {
    toString() {
      coercionCalls += 1;
      throw new Error('untrusted id coercion executed');
    },
  };
  for (const invalidId of ['__proto__', 'constructor', 'toString', forgedId, 7, true]) {
    assert.deepEqual(await manager.getAgentTreeProjection(invalidId), {
      selectedId: '',
      projection: null,
    });
  }
  assert.equal(coercionCalls, 0, 'untrusted ID must never be coerced');
  assert.deepEqual(reads, [], 'invalid IDs must not open a runtime repository');
  assert.deepEqual(await manager.getAgentTreeProjection('orch-1'), {
    selectedId: 'orch-1',
    projection: null,
  });
  assert.deepEqual(await manager.getAgentTreeProjection(), {
    selectedId: 'orch-1',
    projection: null,
  });
  assert.deepEqual(reads, ['orch-1', 'orch-1']);
});
