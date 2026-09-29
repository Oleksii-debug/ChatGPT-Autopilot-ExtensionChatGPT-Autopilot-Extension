import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CapabilityPathKind,
  CapabilityPathReadiness,
  ProviderHealthStatus,
  discoverCapabilityPathsV1,
  normalizeProviderReadinessV1,
} from '../src/core/capability-discovery.js';

const AS_OF = '2026-09-29T04:30:00.000Z';
const OBSERVED_AT = '2026-09-29T04:00:00.000Z';
const VALID_THROUGH = '2026-09-29T05:00:00.000Z';

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
    sourceId:'health.authority',
    sourceRevision:1,
    observedAt:OBSERVED_AT,
    validThrough:VALID_THROUGH,
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

function discover(input) {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const request = Object.create(Object.getPrototypeOf(input));
  Object.defineProperties(request, descriptors);
  Object.defineProperty(request, 'asOf', {
    value: AS_OF,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return discoverCapabilityPathsV1(request);
}

test('discovery produces a deterministic executable coverage plan without granting permission', () => {
  const result = discover({
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
      readinessSourceId:'health.authority',
      readinessSourceRevision:1,
      readinessObservedAt:OBSERVED_AT,
      readinessValidThrough:VALID_THROUGH,
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
      readinessSourceId:'health.authority',
      readinessSourceRevision:1,
      readinessObservedAt:OBSERVED_AT,
      readinessValidThrough:VALID_THROUGH,
      requiresPolicyDecision:true,
      permissionGranted:false,
    },
  ]);
  assert.deepEqual(result.unresolvedCapabilityIds, []);
  assert.equal(result.candidates.every(item => item.requiresPolicyDecision && item.permissionGranted === false), true);
});

test('input ordering does not change recommendation or plan ordering', () => {
  const first = discover({
    capabilities,
    tools,
    providerStates:[state('local/fs'), state('remote/github')],
    requestedCapabilityIds:['artifact.write', 'filesystem.read', 'github.code'],
  });
  const second = discover({
    capabilities:[...capabilities].reverse(),
    tools:[...tools].reverse(),
    providerStates:[state('remote/github'), state('local/fs')],
    requestedCapabilityIds:['github.code', 'filesystem.read', 'artifact.write'],
  });
  assert.deepEqual(second, first);
});

test('needs-auth, needs-install and unavailable candidates are visible but never executable plan steps', () => {
  const result = discover({
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

test('stale and future provider readiness never enter executable plan', () => {
  const stale = discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[state('local/fs', {
      observedAt:'2026-09-29T03:00:00.000Z',
      validThrough:'2026-09-29T04:00:00.000Z',
    })],
    requestedCapabilityIds:['filesystem.read'],
  });
  assert.equal(stale.candidates[0].readiness, CapabilityPathReadiness.NEEDS_HEALTH_CHECK);
  assert.equal(stale.candidates[0].reasonCode, 'PROVIDER_STATE_STALE');
  assert.deepEqual(stale.plan, []);
  assert.deepEqual(stale.unresolvedCapabilityIds, ['filesystem.read']);

  const future = discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[state('local/fs', {
      observedAt:'2026-09-29T04:45:00.000Z',
      validThrough:'2026-09-29T05:30:00.000Z',
    })],
    requestedCapabilityIds:['filesystem.read'],
  });
  assert.equal(future.candidates[0].readiness, CapabilityPathReadiness.NEEDS_HEALTH_CHECK);
  assert.equal(future.candidates[0].reasonCode, 'PROVIDER_STATE_FUTURE');
  assert.deepEqual(future.plan, []);
});

test('fresh executable plan carries exact readiness source provenance', () => {
  const result = discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[state('local/fs', {
      sourceId:'health.windows',
      sourceRevision:7,
      observedAt:'2026-09-29T04:20:00.000Z',
      validThrough:'2026-09-29T04:40:00.000Z',
    })],
    requestedCapabilityIds:['filesystem.read'],
  });
  assert.equal(result.asOf, AS_OF);
  assert.equal(result.candidates[0].readiness, CapabilityPathReadiness.READY);
  assert.equal(result.candidates[0].readinessSourceId, 'health.windows');
  assert.equal(result.candidates[0].readinessSourceRevision, 7);
  assert.equal(result.candidates[0].readinessObservedAt, '2026-09-29T04:20:00.000Z');
  assert.equal(result.candidates[0].readinessValidThrough, '2026-09-29T04:40:00.000Z');
  assert.equal(result.plan[0].readinessSourceId, 'health.windows');
  assert.equal(result.plan[0].readinessSourceRevision, 7);
});

test('impossible readiness chronology and malformed source provenance fail closed', () => {
  assert.throws(
    () => normalizeProviderReadinessV1(state('local/fs', {
      observedAt:'2026-09-29T04:20:00.000Z',
      validThrough:'2026-09-29T04:10:00.000Z',
    })),
    /validThrough cannot predate observedAt/,
  );
  assert.throws(
    () => normalizeProviderReadinessV1(state('local/fs', { sourceRevision:-0 })),
    /positive safe integer/,
  );
  assert.throws(
    () => normalizeProviderReadinessV1(state('local/fs', { observedAt:'2026-09-29 04:00:00Z' })),
    /canonical UTC/,
  );
});

test('missing provider state requires health evidence and never silently becomes ready', () => {
  const result = discover({
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
  const result = discover({
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
  assert.throws(() => discover({
    capabilities:[capability('filesystem.read'), capability('filesystem.read')],
    tools:[],
    providerStates:[],
    requestedCapabilityIds:[],
  }), /duplicate capabilityId/);

  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[
      tool('same', 'a/provider', ['filesystem.read']),
      tool('same', 'b/provider', ['filesystem.read']),
    ],
    providerStates:[],
    requestedCapabilityIds:['filesystem.read'],
  }), /duplicate toolId/);

  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('bad.tool', 'a/provider', ['missing.capability'])],
    providerStates:[],
    requestedCapabilityIds:['filesystem.read'],
  }), /unknown capability/);

  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'])],
    providerStates:[state('local/fs'), state('local/fs')],
    requestedCapabilityIds:['filesystem.read'],
  }), /duplicate provider\/tool readiness identity/);

  assert.throws(() => discover({
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
  const result = discover({
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
  const result = discover({
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
  const result = discover({
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


test('stale tool-specific readiness does not fall back to fresh provider-wide readiness', () => {
  const result = discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('windows.uia', 'windows/provider', ['filesystem.read'])],
    providerStates:[
      state('windows/provider', {
        sourceId:'health.provider',
        sourceRevision:3,
        pathKind:'API',
      }),
      state('windows/provider', {
        toolId:'windows.uia',
        sourceId:'health.tool',
        sourceRevision:4,
        pathKind:'UIA',
        observedAt:'2026-09-29T03:00:00.000Z',
        validThrough:'2026-09-29T04:00:00.000Z',
      }),
    ],
    requestedCapabilityIds:['filesystem.read'],
  });

  assert.equal(result.candidates[0].readiness, CapabilityPathReadiness.NEEDS_HEALTH_CHECK);
  assert.equal(result.candidates[0].reasonCode, 'PROVIDER_STATE_STALE');
  assert.equal(result.candidates[0].readinessSourceId, 'health.tool');
  assert.deepEqual(result.plan, []);
});

test('deterministic path class outranks broader visual coverage in the executable plan', () => {
  const result = discover({
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


test('provider readiness rejects accessors, symbols and hidden authority without executing getters', () => {
  let healthReads = 0;
  const accessor = state('provider/accessor');
  Object.defineProperty(accessor, 'health', {
    enumerable: true,
    configurable: true,
    get() {
      healthReads += 1;
      return healthReads === 1 ? ProviderHealthStatus.UNAVAILABLE : ProviderHealthStatus.READY;
    },
  });
  assert.throws(() => normalizeProviderReadinessV1(accessor), /own data properties/);
  assert.equal(healthReads, 0, 'readiness getter must never execute');

  const symbolic = state('provider/symbol');
  symbolic[Symbol('authority')] = 'READY';
  assert.throws(() => normalizeProviderReadinessV1(symbolic), /symbol field/);

  const hidden = state('provider/hidden');
  Object.defineProperty(hidden, 'authenticated', {
    enumerable: false,
    configurable: true,
    value: true,
  });
  assert.throws(() => normalizeProviderReadinessV1(hidden), /non-enumerable field: authenticated/);
});

test('candidate tie-breaking uses locale-independent code-unit order regardless of inventory order', () => {
  const caps = [capability('filesystem.read')];
  const upper = tool('tool.same', 'Provider/A', ['filesystem.read'], true);
  const lower = tool('tool.same2', 'provider/a', ['filesystem.read'], true);
  const states = [
    state('Provider/A', { toolId:'tool.same', latencyMs:10 }),
    state('provider/a', { toolId:'tool.same2', latencyMs:10 }),
  ];
  const forward = discover({
    capabilities:caps,
    tools:[lower, upper],
    providerStates:[states[1], states[0]],
    requestedCapabilityIds:['filesystem.read'],
  });
  const reverse = discover({
    capabilities:caps,
    tools:[upper, lower],
    providerStates:[states[0], states[1]],
    requestedCapabilityIds:['filesystem.read'],
  });
  assert.deepEqual(forward.candidates.map(item => item.providerId), ['Provider/A', 'provider/a']);
  assert.deepEqual(reverse.candidates.map(item => item.providerId), ['Provider/A', 'provider/a']);
  assert.equal(forward.plan[0].providerId, 'Provider/A');
  assert.equal(reverse.plan[0].providerId, 'Provider/A');
});


test('readiness records, array lengths and request envelopes are snapshot without ordinary Proxy reads', () => {
  let readinessReads = 0;
  const readinessProxy = new Proxy(state('proxy/provider'), {
    get(target, key, receiver) {
      readinessReads += 1;
      if (key === 'health') return ProviderHealthStatus.UNAVAILABLE;
      return Reflect.get(target, key, receiver);
    },
  });
  const normalized = normalizeProviderReadinessV1(readinessProxy);
  assert.equal(readinessReads, 0, 'readiness Proxy get trap must never execute');
  assert.equal(normalized.health, ProviderHealthStatus.READY);

  let arrayReads = 0;
  const providerStates = new Proxy([state('local/fs')], {
    get(target, key, receiver) {
      arrayReads += 1;
      if (key === 'length') return 999999;
      return Reflect.get(target, key, receiver);
    },
  });
  const fromArrayProxy = discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates,
    requestedCapabilityIds:['filesystem.read'],
  });
  assert.equal(arrayReads, 0, 'array Proxy length/items must come only from descriptors');
  assert.equal(fromArrayProxy.plan[0].toolId, 'fs.inspect');

  let requestReads = 0;
  const requestProxy = new Proxy({
    asOf:AS_OF,
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[state('local/fs')],
    requestedCapabilityIds:['filesystem.read'],
  }, {
    get(target, key, receiver) {
      requestReads += 1;
      if (key === 'providerStates') return [];
      return Reflect.get(target, key, receiver);
    },
  });
  const fromRequestProxy = discoverCapabilityPathsV1(requestProxy);
  assert.equal(requestReads, 0, 'top-level discovery Proxy get trap must never execute');
  assert.equal(fromRequestProxy.plan[0].toolId, 'fs.inspect');

  let accessorReads = 0;
  const accessorRequest = {
    asOf:AS_OF,
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    requestedCapabilityIds:['filesystem.read'],
  };
  Object.defineProperty(accessorRequest, 'providerStates', {
    enumerable:true,
    configurable:true,
    get() {
      accessorReads += 1;
      return [state('local/fs')];
    },
  });
  assert.throws(
    () => discoverCapabilityPathsV1(accessorRequest),
    /own data properties/,
  );
  assert.equal(accessorReads, 0, 'top-level request accessor must never execute');

  assert.throws(
    () => discover({
      capabilities:[],
      tools:[],
      providerStates:[],
      requestedCapabilityIds:[],
      hiddenAuthority:true,
    }),
    /unknown field/,
  );
});

test('discovery asOf authority rejects accessors without executing getters', () => {
  let reads = 0;
  const request = {
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[state('local/fs')],
    requestedCapabilityIds:['filesystem.read'],
  };
  Object.defineProperty(request, 'asOf', {
    enumerable:true,
    configurable:true,
    get() {
      reads += 1;
      return AS_OF;
    },
  });
  assert.throws(() => discoverCapabilityPathsV1(request), /own data properties/);
  assert.equal(reads, 0, 'asOf getter must never execute');
});

test('collection boundaries reject accessor-backed inventory and request items without executing getters', () => {
  let providerStateReads = 0;
  const providerStates = [];
  Object.defineProperty(providerStates, 0, {
    enumerable:true,
    configurable:true,
    get() {
      providerStateReads += 1;
      return state('local/fs');
    },
  });

  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates,
    requestedCapabilityIds:['filesystem.read'],
  }), /enumerable data property/);
  assert.equal(providerStateReads, 0, 'providerStates getter must never execute');

  let requestedReads = 0;
  const requestedCapabilityIds = [];
  Object.defineProperty(requestedCapabilityIds, 0, {
    enumerable:true,
    configurable:true,
    get() {
      requestedReads += 1;
      return 'filesystem.read';
    },
  });

  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[],
    requestedCapabilityIds,
  }), /enumerable data property/);
  assert.equal(requestedReads, 0, 'requestedCapabilityIds getter must never execute');
});

test('collection boundaries reject sparse, hidden, custom, symbol and exotic arrays', () => {
  const sparse = new Array(1);
  assert.throws(() => discover({
    capabilities:sparse,
    tools:[],
    providerStates:[],
    requestedCapabilityIds:[],
  }), /must not be sparse/);

  const hidden = [state('local/fs')];
  Object.defineProperty(hidden, 0, {
    enumerable:false,
    configurable:true,
    writable:true,
    value:hidden[0],
  });
  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:hidden,
    requestedCapabilityIds:['filesystem.read'],
  }), /enumerable data property/);

  const custom = [capability('filesystem.read')];
  custom.metadata = 'authority';
  assert.throws(() => discover({
    capabilities:custom,
    tools:[],
    providerStates:[],
    requestedCapabilityIds:[],
  }), /non-index array data/);

  const symbolic = [capability('filesystem.read')];
  symbolic[Symbol('authority')] = true;
  assert.throws(() => discover({
    capabilities:symbolic,
    tools:[],
    providerStates:[],
    requestedCapabilityIds:[],
  }), /non-index array data/);

  const exotic = [capability('filesystem.read')];
  Object.setPrototypeOf(exotic, null);
  assert.throws(() => discover({
    capabilities:exotic,
    tools:[],
    providerStates:[],
    requestedCapabilityIds:[],
  }), /bounded plain array/);
});


test('capability discovery rejects canonical-looking identity and enum aliases instead of normalizing them', () => {
  const canonical = discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[state('local/fs')],
    requestedCapabilityIds:['filesystem.read'],
  });
  assert.equal(canonical.plan[0].toolId, 'fs.inspect');

  for (const badState of [
    state(' local/fs'),
    state('local/fs ', { toolId:'fs.inspect' }),
    state('local/fs', { health:'ready' }),
    state('local/fs', { pathKind:'api' }),
    state('local/fs', { reasonCode:' reason.code' }),
  ]) {
    assert.throws(() => normalizeProviderReadinessV1(badState), /exact canonical/);
  }

  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[state('local/fs')],
    requestedCapabilityIds:[' filesystem.read'],
  }), /exact canonical identity/);

  assert.throws(() => discover({
    capabilities:[capability(' filesystem.read')],
    tools:[],
    providerStates:[],
    requestedCapabilityIds:[],
  }), /exact canonical identity/);

  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool(' fs.inspect', 'local/fs', ['filesystem.read'], true)],
    providerStates:[],
    requestedCapabilityIds:['filesystem.read'],
  }), /exact canonical identity/);

  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', ' local/fs', ['filesystem.read'], true)],
    providerStates:[],
    requestedCapabilityIds:['filesystem.read'],
  }), /exact canonical identity/);

  assert.throws(() => discover({
    capabilities:[capability('filesystem.read')],
    tools:[tool('fs.inspect', 'local/fs', ['filesystem.read '], true)],
    providerStates:[],
    requestedCapabilityIds:['filesystem.read'],
  }), /exact canonical identity/);
});
