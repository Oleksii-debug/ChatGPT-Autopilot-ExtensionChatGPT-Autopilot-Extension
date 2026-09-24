import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityPathKind,
  CapabilityPathReadiness,
  ProviderHealthStatus,
  discoverCapabilityPathsV1,
  normalizeProviderReadinessV1,
} from '../src/core/capability-discovery.js';

function capability(capabilityId) {
  return { schemaVersion:1, capabilityId, description:'', riskClass:'R0', attributes:{} };
}

function tool(toolId, providerId, capabilityIds, readOnly = false) {
  return {
    schemaVersion:1,
    toolId,
    providerId,
    label:toolId,
    description:'',
    capabilityIds,
    inputSchemaRef:'',
    outputSchemaRef:'',
    readOnly,
  };
}

function state(providerId, overrides = {}) {
  return {
    schemaVersion:1,
    providerId,
    health:ProviderHealthStatus.READY,
    installationRequired:false,
    installed:true,
    authenticationRequired:false,
    authenticated:true,
    pathKind:CapabilityPathKind.API,
    latencyMs:10,
    reasonCode:'',
    ...overrides,
  };
}

const capabilities = [
  capability('artifact.write'),
  capability('filesystem.read'),
  capability('github.code'),
];

const tools = [
  tool('fs.inspect', 'local/fs', ['filesystem.read', 'artifact.write'], true),
  tool('github.mutate', 'remote/github', ['github.code', 'artifact.write'], false),
];

test('discovery produces a deterministic executable coverage plan without granting permission', () => {
  const result = discoverCapabilityPathsV1({
    capabilities,
    tools,
    providerStates:[
      state('remote/github', { health:'DEGRADED', latencyMs:30 }),
      state('local/fs', { latencyMs:20 }),
    ],
    requestedCapabilityIds:['github.code', 'artifact.write', 'filesystem.read'],
  });

  assert.deepEqual(result.plan, [
    {
      stepIndex:0,
      providerId:'local/fs',
      toolId:'fs.inspect',
      capabilityIds:['artifact.write', 'filesystem.read'],
      readiness:'READY',
      pathKind:'API',
      requiresPolicyDecision:true,
      permissionGranted:false,
    },
    {
      stepIndex:1,
      providerId:'remote/github',
      toolId:'github.mutate',
      capabilityIds:['github.code'],
      readiness:'DEGRADED',
      pathKind:'API',
      requiresPolicyDecision:true,
      permissionGranted:false,
    },
  ]);
  assert.deepEqual(result.unresolvedCapabilityIds, []);
  assert.equal(result.candidates.every(item => item.requiresPolicyDecision && item.permissionGranted === false), true);
});

test('input ordering does not change recommendation or plan ordering', () => {
  const first = discoverCapabilityPathsV1({
    capabilities,
    tools,
    providerStates:[state('local/fs'), state('remote/github')],
    requestedCapabilityIds:['artifact.write', 'filesystem.read', 'github.code'],
  });
  const second = discoverCapabilityPathsV1({
    capabilities:[...capabilities].reverse(),
    tools:[...tools].reverse(),
    providerStates:[state('remote/github'), state('local/fs')],
    requestedCapabilityIds:['github.code', 'filesystem.read', 'artifact.write'],
  });
  assert.deepEqual(second, first);
});

test('needs-auth, needs-install and unavailable candidates are visible but never executable plan steps', () => {
  const result = discoverCapabilityPathsV1({
    capabilities,
    tools:[
      tool('auth.tool', 'auth/provider', ['github.code']),
      tool('install.tool', 'install/provider', ['filesystem.read']),
      tool('down.tool', 'down/provider', ['artifact.write']),
    ],
    providerStates:[
      state('auth/provider', { authenticationRequired:true, authenticated:false }),
      state('install/provider', { installationRequired:true, installed:false }),
      state('down/provider', { health:'UNAVAILABLE' }),
    ],
    requestedCapabilityIds:['github.code', 'filesystem.read', 'artifact.write'],
  });
  assert.deepEqual(result.candidates.map(item => item.readiness), [
    CapabilityPathReadiness.NEEDS_AUTH,
    CapabilityPathReadiness.NEEDS_INSTALL,
    CapabilityPathReadiness.UNAVAILABLE,
  ]);
  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.unresolvedCapabilityIds, ['artifact.write', 'filesystem.read', 'github.code']);
});

test('missing provider state requires health evidence and never silently becomes ready', () => {
  const result = discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[],
    requestedCapabilityIds:['filesystem.read'],
  });
  assert.equal(result.candidates[0].readiness, CapabilityPathReadiness.NEEDS_HEALTH_CHECK);
  assert.equal(result.candidates[0].reasonCode, 'PROVIDER_STATE_MISSING');
  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.unresolvedCapabilityIds, ['filesystem.read']);
});

test('unknown requested capabilities are reported unresolved rather than synthesized', () => {
  const result = discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[state('local/fs')],
    requestedCapabilityIds:['filesystem.read', 'future.unknown'],
  });
  assert.deepEqual(result.plan.map(step => step.capabilityIds), [['filesystem.read']]);
  assert.deepEqual(result.unresolvedCapabilityIds, ['future.unknown']);
  assert.equal(result.candidates.some(candidate => candidate.matchingCapabilityIds.includes('future.unknown')), false);
});

test('inventory identity conflicts and dangling tool capability references fail closed', () => {
  assert.throws(() => discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read'), capability('filesystem.read')],
    tools:[],
    providerStates:[],
    requestedCapabilityIds:[],
  }), /duplicate capabilityId/);

  assert.throws(() => discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read')],
    tools:[
      tool('same', 'a/provider', ['filesystem.read']),
      tool('same', 'b/provider', ['filesystem.read']),
    ],
    providerStates:[],
    requestedCapabilityIds:['filesystem.read'],
  }), /duplicate toolId/);

  assert.throws(() => discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read')],
    tools:[tool('bad.tool', 'a/provider', ['missing.capability'])],
    providerStates:[],
    requestedCapabilityIds:['filesystem.read'],
  }), /unknown capability/);

  assert.throws(() => discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'])],
    providerStates:[state('local/fs'), state('local/fs')],
    requestedCapabilityIds:['filesystem.read'],
  }), /duplicate provider\/tool readiness identity/);

  assert.throws(() => discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'])],
    providerStates:[state('other/provider', { toolId:'fs.inspect' })],
    requestedCapabilityIds:['filesystem.read'],
  }), /does not belong to providerId/);
});

test('provider readiness boundary rejects coercion, inherited authority and exotic objects', () => {
  const valid = state('local/fs');
  for (const bad of [
    { ...valid, schemaVersion:'1' },
    { ...valid, providerId:1 },
    { ...valid, health:true },
    { ...valid, installed:1 },
    { ...valid, authenticated:'true' },
    { ...valid, pathKind:'MAGIC' },
    { ...valid, latencyMs:'10' },
  ]) {
    assert.throws(() => normalizeProviderReadinessV1(bad));
  }

  const inherited = Object.create({ providerId:'inherited/provider' });
  Object.assign(inherited, {
    schemaVersion:1,
    health:'READY',
    installationRequired:false,
    installed:true,
    authenticationRequired:false,
    authenticated:true,
  });
  assert.throws(() => normalizeProviderReadinessV1(inherited), /plain object/);

  const exotic = new (class ProviderState {
    constructor() { Object.assign(this, valid); }
  })();
  assert.throws(() => normalizeProviderReadinessV1(exotic), /plain object/);
});

test('degraded providers remain executable but sort behind ready providers for equal coverage', () => {
  const result = discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read')],
    tools:[
      tool('z.degraded', 'z/provider', ['filesystem.read']),
      tool('a.ready', 'a/provider', ['filesystem.read']),
    ],
    providerStates:[
      state('z/provider', { health:'DEGRADED', latencyMs:1 }),
      state('a/provider', { health:'READY', latencyMs:100 }),
    ],
    requestedCapabilityIds:['filesystem.read'],
  });
  assert.equal(result.candidates[0].toolId, 'a.ready');
  assert.equal(result.plan[0].toolId, 'a.ready');
});


test('best-path planning prefers deterministic API/CLI/semantic/UIA paths before visual or OCR fallback', () => {
  const result = discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read')],
    tools:[
      tool('visual.fast', 'visual/provider', ['filesystem.read']),
      tool('uia.slower', 'uia/provider', ['filesystem.read']),
      tool('api.slowest', 'api/provider', ['filesystem.read']),
    ],
    providerStates:[
      state('visual/provider', { pathKind:'VISUAL', latencyMs:1 }),
      state('uia/provider', { pathKind:'UIA', latencyMs:20 }),
      state('api/provider', { pathKind:'API', latencyMs:100 }),
    ],
    requestedCapabilityIds:['filesystem.read'],
  });

  assert.deepEqual(result.candidates.map(item => item.toolId), ['api.slowest', 'uia.slower', 'visual.fast']);
  assert.equal(result.plan[0].toolId, 'api.slowest');
  assert.equal(result.plan[0].pathKind, 'API');
  assert.equal(result.plan[0].permissionGranted, false);
});


test('tool-specific path readiness overrides provider-wide fallback for mixed-mode providers', () => {
  const result = discoverCapabilityPathsV1({
    capabilities:[capability('filesystem.read')],
    tools:[
      tool('windows.visual', 'windows/provider', ['filesystem.read']),
      tool('windows.uia', 'windows/provider', ['filesystem.read']),
    ],
    providerStates:[
      state('windows/provider', { pathKind:'VISUAL', latencyMs:1 }),
      state('windows/provider', { toolId:'windows.uia', pathKind:'UIA', latencyMs:40 }),
    ],
    requestedCapabilityIds:['filesystem.read'],
  });

  assert.deepEqual(result.candidates.map(item => [item.toolId, item.pathKind]), [
    ['windows.uia', 'UIA'],
    ['windows.visual', 'VISUAL'],
  ]);
  assert.equal(result.plan[0].toolId, 'windows.uia');
});


test('deterministic path class outranks broader visual coverage in the executable plan', () => {
  const result = discoverCapabilityPathsV1({
    capabilities:[capability('a.read'), capability('b.read')],
    tools:[
      tool('api.a', 'api/provider', ['a.read']),
      tool('visual.all', 'visual/provider', ['a.read', 'b.read']),
    ],
    providerStates:[
      state('api/provider', { pathKind:'API', latencyMs:100 }),
      state('visual/provider', { pathKind:'VISUAL', latencyMs:1 }),
    ],
    requestedCapabilityIds:['a.read', 'b.read'],
  });

  assert.deepEqual(result.plan.map(step => [step.toolId, step.capabilityIds]), [
    ['api.a', ['a.read']],
    ['visual.all', ['b.read']],
  ]);
  assert.equal(result.plan.every(step => step.permissionGranted === false), true);
});
