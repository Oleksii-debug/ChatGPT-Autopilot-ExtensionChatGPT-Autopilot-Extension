import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CMS_WORDPRESS_PROVIDER_ID,
  CmsWordPressAgentProviderV1,
  CmsWordPressCapabilityId,
  CmsWordPressToolId,
} from '../src/core/cms-wordpress-agent-provider.js';

const at = '2026-09-25T06:20:00.000Z';

function invocation(toolId, capabilityId, args = {}, invocationId = 'cms-inv-1') {
  return {
    schemaVersion: 1,
    invocationId,
    toolId,
    providerId: CMS_WORDPRESS_PROVIDER_ID,
    requestedCapabilityIds: [capabilityId],
    policyDecisionId: 'decision-' + invocationId,
    arguments: args,
    createdAt: at,
    parentInvocationId: null,
  };
}

function decision(invocationId = 'cms-inv-1', kind = 'ALLOW') {
  return {
    schemaVersion: 1,
    decisionId: 'decision-' + invocationId,
    invocationId,
    decision: kind,
    reasonCode: 'OWNER_POLICY',
    reason: '',
    approvalId: null,
    decidedAt: at,
  };
}

function client(overrides = {}) {
  return {
    readSite: async args => ({ operation: 'readSite', args }),
    searchContent: async args => ({ operation: 'searchContent', args }),
    getContent: async args => ({ operation: 'getContent', args }),
    searchMedia: async args => ({ operation: 'searchMedia', args }),
    getMedia: async args => ({ operation: 'getMedia', args }),
    searchTaxonomy: async args => ({ operation: 'searchTaxonomy', args }),
    ...overrides,
  };
}

const capabilities = Object.values(CmsWordPressCapabilityId);

test('WordPress provider advertises only six read-only discovery tools and no mutation surface', () => {
  const provider = new CmsWordPressAgentProviderV1({ wordpressClient: client(), grantedCapabilityIds: capabilities });
  const tools = provider.tools();
  assert.equal(tools.length, 6);
  assert.ok(tools.every(tool => tool.providerId === CMS_WORDPRESS_PROVIDER_ID && tool.readOnly === true));
  assert.ok(tools.every(tool => !/(create|update|edit|publish|upload|delete|trash|plugin|theme)/iu.test(tool.toolId)));
  assert.deepEqual(new Set(tools.flatMap(tool => tool.capabilityIds)), new Set(capabilities));
});

test('owner policy and capability grant are enforced before WordPress client invocation', async () => {
  let calls = 0;
  const provider = new CmsWordPressAgentProviderV1({
    wordpressClient: client({ searchContent: async args => { calls += 1; return { args }; } }),
    grantedCapabilityIds: [CmsWordPressCapabilityId.CONTENT_READ],
    now: () => Date.parse(at),
  });
  const inv = invocation(
    CmsWordPressToolId.CONTENT_SEARCH,
    CmsWordPressCapabilityId.CONTENT_READ,
    { siteOrigin: 'https://example.test', contentType: 'posts' },
  );
  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: decision('cms-inv-1', 'DENY') }), /not authorized/i);
  await assert.rejects(
    () => provider.invoke({
      invocation: { ...inv, requestedCapabilityIds: [CmsWordPressCapabilityId.MEDIA_READ] },
      policyDecision: decision(),
    }),
    /capabilit|granted|tool/i,
  );
  assert.equal(calls, 0);
  const result = await provider.invoke({ invocation: inv, policyDecision: decision() });
  assert.equal(result.providerId, CMS_WORDPRESS_PROVIDER_ID);
  assert.equal(result.invocationId, 'cms-inv-1');
  assert.equal(result.observedAt, at);
  assert.equal(calls, 1);
});

test('each WordPress read tool dispatches through the single client', async () => {
  const provider = new CmsWordPressAgentProviderV1({
    wordpressClient: client(),
    grantedCapabilityIds: capabilities,
    now: () => Date.parse(at),
  });
  const cases = [
    [CmsWordPressToolId.SITE_READ, CmsWordPressCapabilityId.SITE_READ, 'readSite', { siteOrigin: 'https://example.test' }],
    [CmsWordPressToolId.CONTENT_SEARCH, CmsWordPressCapabilityId.CONTENT_READ, 'searchContent', { siteOrigin: 'https://example.test', contentType: 'posts' }],
    [CmsWordPressToolId.CONTENT_GET, CmsWordPressCapabilityId.CONTENT_READ, 'getContent', { siteOrigin: 'https://example.test', contentType: 'pages', id: 7 }],
    [CmsWordPressToolId.MEDIA_SEARCH, CmsWordPressCapabilityId.MEDIA_READ, 'searchMedia', { siteOrigin: 'https://example.test' }],
    [CmsWordPressToolId.MEDIA_GET, CmsWordPressCapabilityId.MEDIA_READ, 'getMedia', { siteOrigin: 'https://example.test', id: 9 }],
    [CmsWordPressToolId.TAXONOMY_SEARCH, CmsWordPressCapabilityId.TAXONOMY_READ, 'searchTaxonomy', { siteOrigin: 'https://example.test', taxonomy: 'tags' }],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [toolId, capabilityId, operation, args] = cases[index];
    const id = 'cms-dispatch-' + index;
    const result = await provider.invoke({
      invocation: invocation(toolId, capabilityId, args, id),
      policyDecision: decision(id),
    });
    assert.equal(result.result.operation, operation);
    assert.deepEqual(result.result.args, args);
  }
});

test('WordPress client failures are redacted and remain explicitly no-effect/retry-safe', async () => {
  const leaked = 'application-password-must-not-cross-provider';
  const failure = Object.assign(new Error('offline ' + leaked), {
    code: 'WORDPRESS_TRANSPORT_ERROR',
    status: 0,
    cause: leaked,
  });
  const provider = new CmsWordPressAgentProviderV1({
    wordpressClient: client({ getContent: async () => { throw failure; } }),
    grantedCapabilityIds: [CmsWordPressCapabilityId.CONTENT_READ],
  });
  const inv = invocation(
    CmsWordPressToolId.CONTENT_GET,
    CmsWordPressCapabilityId.CONTENT_READ,
    { siteOrigin: 'https://example.test', contentType: 'posts', id: 7 },
  );
  await assert.rejects(
    () => provider.invoke({ invocation: inv, policyDecision: decision() }),
    error => error.code === 'WORDPRESS_TRANSPORT_ERROR'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true
      && error.invocationId === 'cms-inv-1'
      && error.message === 'WordPress read failed'
      && !String(error.message).includes(leaked)
      && !Object.prototype.hasOwnProperty.call(error, 'cause'),
  );
});

test('accessor-backed invocation arguments fail closed before getter or client execution', async () => {
  let getterReads = 0;
  let clientCalls = 0;
  const args = {};
  Object.defineProperty(args, 'siteOrigin', {
    enumerable: true,
    get() { getterReads += 1; return 'https://example.test'; },
  });
  const provider = new CmsWordPressAgentProviderV1({
    wordpressClient: client({ readSite: async value => { clientCalls += 1; return value; } }),
    grantedCapabilityIds: [CmsWordPressCapabilityId.SITE_READ],
  });
  const inv = invocation(CmsWordPressToolId.SITE_READ, CmsWordPressCapabilityId.SITE_READ, args);
  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: decision() }), /enumerable data property/i);
  assert.equal(getterReads, 0);
  assert.equal(clientCalls, 0);
});

test('sparse/accessor granted capability arrays fail before value reads', () => {
  const sparse = new Array(1);
  assert.throws(
    () => new CmsWordPressAgentProviderV1({ wordpressClient: client(), grantedCapabilityIds: sparse }),
    /dense canonical array/i,
  );
  let reads = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() { reads += 1; return CmsWordPressCapabilityId.SITE_READ; },
  });
  accessor.length = 1;
  assert.throws(
    () => new CmsWordPressAgentProviderV1({ wordpressClient: client(), grantedCapabilityIds: accessor }),
    /enumerable canonical text data property/i,
  );
  assert.equal(reads, 0);
});

test('canonical authority timestamps are required before universal contract normalization', async () => {
  let calls = 0;
  const provider = new CmsWordPressAgentProviderV1({
    wordpressClient: client({ readSite: async args => { calls += 1; return args; } }),
    grantedCapabilityIds: [CmsWordPressCapabilityId.SITE_READ],
    now: () => Date.parse(at),
  });
  const base = invocation(CmsWordPressToolId.SITE_READ, CmsWordPressCapabilityId.SITE_READ, { siteOrigin: 'https://example.test' });
  await assert.rejects(
    () => provider.invoke({
      invocation: { ...base, createdAt: '2026-09-25T06:20:00Z' },
      policyDecision: decision(),
    }),
    /createdAt must be an exact canonical timestamp/i,
  );
  await assert.rejects(
    () => provider.invoke({
      invocation: base,
      policyDecision: { ...decision(), decidedAt: '2026-09-25T06:20:00Z' },
    }),
    /decidedAt must be an exact canonical timestamp/i,
  );
  assert.equal(calls, 0);
  await provider.invoke({ invocation: base, policyDecision: decision() });
  assert.equal(calls, 1);
});

test('coercive or unknown authority aliases cannot reach WordPress client', async () => {
  let calls = 0;
  const provider = new CmsWordPressAgentProviderV1({
    wordpressClient: client({ readSite: async args => { calls += 1; return args; } }),
    grantedCapabilityIds: [CmsWordPressCapabilityId.SITE_READ],
  });
  const base = invocation(CmsWordPressToolId.SITE_READ, CmsWordPressCapabilityId.SITE_READ, { siteOrigin: 'https://example.test' });
  await assert.rejects(
    () => provider.invoke({ invocation: { ...base, schemaVersion: '1' }, policyDecision: decision() }),
    /schemaVersion must be numeric 1/i,
  );
  await assert.rejects(
    () => provider.invoke({ invocation: { ...base, invocationId: 7 }, policyDecision: { ...decision(), invocationId: 7 } }),
    /canonical text identity/i,
  );
  await assert.rejects(
    () => provider.invoke({
      invocation: { ...base, toolId: 'remote/cms-wordpress/content.publish' },
      policyDecision: decision(),
    }),
    /not registered/i,
  );
  assert.equal(calls, 0);
});

test('proxied capability arrays are descriptor-snapshotted without ordinary property reads', async () => {
  let reads = 0;
  const proxiedGranted = new Proxy([CmsWordPressCapabilityId.SITE_READ], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const provider = new CmsWordPressAgentProviderV1({
    wordpressClient: client(),
    grantedCapabilityIds: proxiedGranted,
    now: () => Date.parse(at),
  });
  assert.equal(reads, 0);
  const requested = new Proxy([CmsWordPressCapabilityId.SITE_READ], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const inv = invocation(CmsWordPressToolId.SITE_READ, CmsWordPressCapabilityId.SITE_READ, { siteOrigin: 'https://example.test' });
  inv.requestedCapabilityIds = requested;
  const result = await provider.invoke({ invocation: inv, policyDecision: decision() });
  assert.equal(result.result.operation, 'readSite');
  assert.equal(reads, 0);
});
