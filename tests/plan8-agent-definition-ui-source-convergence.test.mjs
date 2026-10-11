import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAgentDefinitionFromFormV1 } from '../src/ui/agent-definition-form.js';

const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');
const routeIds = [
  'auto-switch', 'pinned-id', 'ordered-ids', 'allow-ids', 'deny-ids',
  'free-only', 'locality', 'max-input-price', 'max-output-price',
];
const modelIds = [
  'ai-routing-mode', 'ai-pinned-route-id', 'ai-primary-provider',
  'ai-primary-model', 'ai-strong-provider', 'ai-strong-model',
];

test('Plan8 11.x source: native model and Router controls are uniquely labeled', () => {
  for (const id of [...modelIds.map(x => 'agent-definition-' + x),
    ...routeIds.map(x => 'agent-definition-model-route-' + x)]) {
    assert.equal(html.split('id="' + id + '"').length - 1, 1, id + ' must exist once');
    assert.ok(html.includes('<label for="' + id + '">'), id + ' needs native label');
  }
  assert.equal(html.split('id="agent-definition-model-route-policy-configured"').length - 1, 1);
  assert.match(html, /Збереження policy не вибирає модель, не запускає provider і не запускає Agent/u);
});

test('Plan8 11.x source: disabled routing fields cannot receive keyboard focus, no execution authority', () => {
  const begin = js.indexOf('function syncAgentDefinitionModelRoutePolicyControls()');
  const end = js.indexOf('\nfunction fillAgentDefinitionForm', begin);
  assert.ok(begin >= 0 && end > begin);
  const sync = js.slice(begin, end);
  assert.match(sync, /\$\(id\)\.disabled = !configured/u);
  for (const name of routeIds) assert.ok(sync.includes('agent-definition-model-route-' + name));
  assert.match(js, /agent-definition-model-route-policy-configured'\)\.addEventListener\('change', syncAgentDefinitionModelRoutePolicyControls\)/u);
  const startSave = js.indexOf('async function saveAgentDefinition()');
  const endSave = js.indexOf('\nasync function toggleAgentDefinitionEnabled', startSave);
  const save = js.slice(startSave, endSave);
  assert.match(save, /MUTATE_BROWSER_AGENT_DEFINITION_REGISTRY/u);
  assert.doesNotMatch(save, /RUN_AI_ROUTED_PROMPT|START_BROWSER_AGENT_JOB|RUN_BROWSER_AGENT_BURST|fetch\(/u);
  assert.ok(js.includes(".join('\\n')"), 'route lists must use real newline escape');
  assert.ok(!js.includes(".join('\\\\n')"), 'literal backslash-n breaks list recovery');
});

test('Plan8 11.x source: cold-restart model defaults and Router policy retain owner choices', () => {
  const base = {
    agentDefinitionId:'agent.research',
    label:'Research',
    description:'',
    instructions:'Only read approved evidence.',
    capabilityIdsText:'',
    toolIdsText:'',
    tagsText:'',
    acceptanceCriteriaText:'',
    enabled:true,
  };
  const policy = {
    autoSwitch:true,
    pinnedRouteId:'route.fast',
    orderedRouteIds:['route.fast','route.strong'],
    allowRouteIds:['route.fast','route.strong'],
    denyRouteIds:[],
    freeOnly:false,
    locality:'any',
    maxInputPricePerMillionUsd:null,
    maxOutputPricePerMillionUsd:null,
  };
  const saved = buildAgentDefinitionFromFormV1(base, {
    configDefaults:{aiRoutingMode:'auto'},
    modelRoutePolicy:policy,
  });
  const restarted = JSON.parse(JSON.stringify(saved));
  const resaved = buildAgentDefinitionFromFormV1(base, {
    configDefaults:restarted.configDefaults,
    modelRoutePolicy:restarted.modelRoutePolicy,
  });
  assert.deepEqual(resaved.configDefaults, saved.configDefaults);
  assert.deepEqual(resaved.modelRoutePolicy, saved.modelRoutePolicy);
  let accessed = 0;
  const hostile = {...base};
  Object.defineProperty(hostile, 'modelRoutePolicyConfigured', {
    enumerable:true,
    get() { accessed += 1; return true; },
  });
  assert.throws(
    () => buildAgentDefinitionFromFormV1(hostile, {modelRoutePolicy:policy}),
    /enumerable data property/u,
  );
  assert.equal(accessed, 0);
});


test('Plan8 11.x source: reserved prototype keys fail closed in persisted Agent settings', () => {
  const base = {
    agentDefinitionId:'agent.research', label:'Research', description:'',
    instructions:'Read only approved evidence.', capabilityIdsText:'',
    toolIdsText:'', tagsText:'', acceptanceCriteriaText:'', enabled:true,
  };
  // JSON and object-descriptor data can contain reserved keys even though
  // ordinary object literals do not expose them as own data properties.
  const injected = JSON.parse('{"__proto__":{"owner":true}}');
  const originalPrototype = Object.getPrototypeOf(injected);
  assert.equal(Object.hasOwn(injected, '__proto__'), true);
  assert.throws(
    () => buildAgentDefinitionFromFormV1(base, {configDefaults:injected}),
    /заборонене поле/u,
  );
  assert.throws(
    () => buildAgentDefinitionFromFormV1(base, {modelRoutePolicy:injected}),
    /заборонене поле/u,
  );
  assert.equal(Object.getPrototypeOf(injected), originalPrototype);
  assert.equal({}.owner, undefined);

  let getterCalls = 0;
  const hostile = Object.create(null);
  Object.defineProperty(hostile, 'constructor', {
    enumerable:true,
    get() { getterCalls++; throw new Error('ATTACKER_GETTER_EXECUTED'); },
  });
  assert.throws(
    () => buildAgentDefinitionFromFormV1(base, {configDefaults:hostile}),
    /заборонене поле/u,
  );
  assert.throws(
    () => buildAgentDefinitionFromFormV1(base, {modelRoutePolicy:hostile}),
    /заборонене поле/u,
  );
  assert.equal(getterCalls, 0);

  // A clean durable restart remains compatible and receives no new authority.
  const valid = buildAgentDefinitionFromFormV1(base, {
    configDefaults:{aiRoutingMode:'auto'},
  });
  const restarted = buildAgentDefinitionFromFormV1(base, {
    configDefaults:JSON.parse(JSON.stringify(valid.configDefaults)),
  });
  assert.deepEqual(restarted.configDefaults, valid.configDefaults);
  assert.equal(Object.hasOwn(restarted.configDefaults, 'owner'), false);
});
