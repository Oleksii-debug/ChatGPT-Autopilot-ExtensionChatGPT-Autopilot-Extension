import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WordPressRestClientV1 } from '../src/core/wordpress-rest-client.js';
import {
  CMS_WORDPRESS_PROVIDER_ID,
  CmsWordPressAgentProviderV1,
  CmsWordPressCapabilityId,
  CmsWordPressToolId,
} from '../src/core/cms-wordpress-agent-provider.js';
import { CmsWordPressDraftVerifierV1 } from '../src/core/cms-wordpress-draft-verifier.js';
import { CmsWordPressExactEffectExecutorV1 } from '../src/core/cms-wordpress-exact-effect.js';
import { ExactEffectPhase } from '../src/core/universal-agent-exact-effect.js';

const origin = 'https://example.test';
const credentialId = 'wordpress-example';
const at = '2026-09-25T09:00:00.000Z';
const baseMs = Date.parse(at);

function slugFor(id) {
  return 'autopilot-' + createHash('sha256').update(id, 'utf8').digest('hex');
}

function response(status, value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return { status, text: async () => body };
}

function credentialResolver() {
  return {
    resolveCredential: async ({ credentialId: requested, targetOrigin }) => ({
      credentialId: requested,
      kind: 'username-password',
      targetOrigin,
      username: 'owner',
      secret: 'application-password',
    }),
  };
}

function draftItem({ id = 41, type = 'post', slug, title = 'Draft title', content = '<p>Draft body</p>', excerpt = 'Summary' } = {}) {
  return {
    id,
    date_gmt: '2026-09-25T08:00:00',
    modified_gmt: '2026-09-25T09:00:00',
    slug,
    status: 'draft',
    type,
    link: origin + '/?p=' + id,
    title: { raw: title, rendered: title },
    excerpt: { raw: excerpt, rendered: '<p>' + excerpt + '</p>' },
    content: { raw: content, rendered: content },
  };
}

function restClient(fetchImpl) {
  return new WordPressRestClientV1({
    nativeClient: credentialResolver(),
    sites: [{ origin, credentialId }],
    fetchImpl,
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
}

function invocation(id = 'cms-draft-effect-1', overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId: id,
    toolId: CmsWordPressToolId.CONTENT_DRAFT_CREATE,
    providerId: CMS_WORDPRESS_PROVIDER_ID,
    requestedCapabilityIds: [CmsWordPressCapabilityId.CONTENT_DRAFT_CREATE],
    policyDecisionId: 'decision-' + id,
    arguments: {
      siteOrigin: origin,
      contentType: 'posts',
      title: 'Draft title',
      content: '<p>Draft body</p>',
      excerpt: 'Summary',
      ...overrides,
    },
    createdAt: at,
    parentInvocationId: null,
  };
}

function decision(id = 'cms-draft-effect-1', kind = 'ALLOW') {
  return {
    schemaVersion: 1,
    decisionId: 'decision-' + id,
    invocationId: id,
    decision: kind,
    reasonCode: 'OWNER_POLICY',
    reason: '',
    approvalId: null,
    decidedAt: at,
  };
}

async function materializeUntrustedContent({ invocationId, observedAt, mediaType, content }) {
  return {
    schemaVersion: 1,
    artifactId: 'cms-result:' + invocationId,
    kind: 'TOOL_METADATA',
    uri: 'artifact://cms-wordpress/' + invocationId,
    mediaType,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    createdAt: observedAt,
    producerInvocationId: invocationId,
    sensitive: false,
  };
}

function providerClient(overrides = {}) {
  return {
    readSite: async args => ({ args }),
    searchContent: async args => ({ args }),
    getContent: async args => ({ args }),
    searchMedia: async args => ({ args }),
    getMedia: async args => ({ args }),
    searchTaxonomy: async args => ({ args }),
    createDraft: async args => ({ siteOrigin: args.siteOrigin, contentType: args.contentType, id: 41, type: 'post', status: 'draft', slug: args.slug, titleRaw: args.title, contentRaw: args.content ?? '', excerptRaw: args.excerpt ?? '' }),
    ...overrides,
  };
}

function memoryStore() {
  let root = { effectsById: {} };
  return {
    async update(mutator) {
      const draft = structuredClone(root);
      const returned = mutator(draft);
      root = structuredClone(returned === undefined ? draft : returned);
      return structuredClone(root);
    },
    async load(id) {
      const state = root.effectsById?.[id]?.state;
      return state ? structuredClone(state) : null;
    },
  };
}

test('WordPress draft create preflights exact deterministic slug and dispatches fixed draft-only POST', async () => {
  const id = 'cms-rest-draft-1';
  const slug = slugFor(id);
  const requests = [];
  const client = restClient(async (url, init) => {
    requests.push({ url, init });
    if (init.method === 'GET') return response(200, []);
    return response(201, draftItem({ slug }));
  });

  const result = await client.createDraft({
    siteOrigin: origin,
    contentType: 'posts',
    slug,
    title: 'Draft title',
    content: '<p>Draft body</p>',
    excerpt: 'Summary',
  });

  assert.equal(result.id, 41);
  assert.equal(result.status, 'draft');
  assert.equal(result.slug, slug);
  assert.equal(requests.length, 2);
  const preflight = new URL(requests[0].url);
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(preflight.pathname, '/wp-json/wp/v2/posts');
  assert.equal(preflight.searchParams.get('slug'), slug);
  assert.equal(preflight.searchParams.get('status'), 'any');
  assert.equal(requests[1].init.method, 'POST');
  assert.equal(new URL(requests[1].url).pathname, '/wp-json/wp/v2/posts');
  assert.equal(requests[1].init.redirect, 'error');
  assert.equal(requests[1].init.headers['Content-Type'], 'application/json; charset=utf-8');
  const body = JSON.parse(requests[1].init.body);
  assert.deepEqual(body, {
    status: 'draft',
    slug,
    title: 'Draft title',
    content: '<p>Draft body</p>',
    excerpt: 'Summary',
  });
});

test('pre-existing deterministic slug blocks draft creation before any POST', async () => {
  const slug = slugFor('cms-rest-collision');
  let posts = 0;
  const client = restClient(async (_url, init) => {
    if (init.method === 'POST') posts += 1;
    return response(200, [draftItem({ slug })]);
  });
  await assert.rejects(
    () => client.createDraft({ siteOrigin: origin, contentType: 'posts', slug, title: 'Draft title' }),
    error => error.code === 'WORDPRESS_DRAFT_SLUG_CONFLICT'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true,
  );
  assert.equal(posts, 0);
});

test('post-dispatch transport and response mismatch are never classified retry-safe', async t => {
  await t.test('transport loss', async () => {
    const slug = slugFor('cms-rest-transport');
    let call = 0;
    const client = restClient(async (_url, init) => {
      call += 1;
      if (init.method === 'GET') return response(200, []);
      throw new Error('connection reset after write');
    });
    await assert.rejects(
      () => client.createDraft({ siteOrigin: origin, contentType: 'posts', slug, title: 'Draft title' }),
      error => error.code === 'WORDPRESS_TRANSPORT_ERROR'
        && error.effectMayHaveOccurred === true
        && error.safeToRetry === false,
    );
    assert.equal(call, 2);
  });

  await t.test('provider changed deterministic slug', async () => {
    const slug = slugFor('cms-rest-mismatch');
    const client = restClient(async (_url, init) => {
      if (init.method === 'GET') return response(200, []);
      return response(201, draftItem({ slug: slug + '-2' }));
    });
    await assert.rejects(
      () => client.createDraft({ siteOrigin: origin, contentType: 'posts', slug, title: 'Draft title' }),
      error => error.code === 'WORDPRESS_MUTATION_RESPONSE_MISMATCH'
        && error.effectMayHaveOccurred === true
        && error.safeToRetry === false,
    );
  });
});

test('WordPress provider derives slug from invocation identity and enforces policy/capability before mutation', async () => {
  const calls = [];
  const id = 'cms-provider-draft-1';
  const provider = new CmsWordPressAgentProviderV1({
    wordpressClient: providerClient({
      createDraft: async args => {
        calls.push(structuredClone(args));
        return {
          siteOrigin: args.siteOrigin,
          contentType: args.contentType,
          id: 41,
          type: 'post',
          status: 'draft',
          slug: args.slug,
          titleRaw: args.title,
          contentRaw: args.content,
          excerptRaw: args.excerpt,
        };
      },
    }),
    grantedCapabilityIds: [CmsWordPressCapabilityId.CONTENT_DRAFT_CREATE],
    materializeUntrustedContent,
    now: () => baseMs,
  });
  const inv = invocation(id);
  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: decision(id, 'DENY') }), /not authorized/i);
  assert.equal(calls.length, 0);

  const result = await provider.invoke({ invocation: inv, policyDecision: decision(id) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, slugFor(id));
  assert.equal(result.result.slug, slugFor(id));
  assert.equal(result.contentTrust, 'UNTRUSTED_DATA');
  assert.equal(result.instructionAuthority, 'NONE');
  assert.equal(result.requiresCanonicalUntrustedContentGuardAssessment, true);
});

test('independent WordPress verifier binds exact slug, identity and requested draft content', async () => {
  const id = 'cms-verifier-draft-1';
  const slug = slugFor(id);
  const client = {
    findContentBySlug: async input => ({
      siteOrigin: input.siteOrigin,
      contentType: input.contentType,
      slug: input.slug,
      items: [{ id: 41 }],
    }),
    getContent: async () => ({
      id: 41,
      type: 'post',
      status: 'draft',
      slug,
      titleRaw: 'Draft title',
      contentRaw: '<p>Draft body</p>',
      excerptRaw: 'Summary',
    }),
  };
  const verifier = new CmsWordPressDraftVerifierV1({ wordpressClient: client, now: () => baseMs + 5000 });
  const inv = invocation(id);
  const observation = {
    schemaVersion: 1,
    observationId: id + ':observation',
    invocationId: id,
    status: 'OK',
    summary: 'provider result',
    data: { id: 41, slug },
    artifactRefs: [],
    observedAt: new Date(baseMs + 1000).toISOString(),
  };
  const verified = await verifier.verify({
    invocation: inv,
    executionId: id + ':attempt:1',
    observation,
  });
  assert.equal(verified.status, 'VERIFIED');
  assert.equal(verified.reasonCode, 'WORDPRESS_DRAFT_READBACK_MATCHED');

  const proof = await verifier.reconcileVerify({
    invocation: inv,
    effectId: id,
    executionId: id + ':attempt:1',
    attempt: 1,
    policyDecisionId: inv.policyDecisionId,
    expectedOutcome: 'VERIFIED',
  });
  assert.equal(proof.observation.data.committed, true);
  assert.equal(proof.observation.data.slug, slug);
  await assert.rejects(
    () => verifier.reconcileVerify({
      invocation: inv,
      effectId: id,
      executionId: id + ':attempt:1',
      attempt: 1,
      policyDecisionId: inv.policyDecisionId,
      expectedOutcome: 'SAFE_RETRY',
    }),
    /never infers SAFE_RETRY/i,
  );
});

test('WordPress exact-effect persists EXECUTING before dispatch, verifies, commits, and blocks replay', async () => {
  const id = 'cms-exact-draft-1';
  const slug = slugFor(id);
  const store = memoryStore();
  let dispatches = 0;
  const provider = {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async ({ invocation: inv }) => {
      dispatches += 1;
      return {
        providerId: CMS_WORDPRESS_PROVIDER_ID,
        invocationId: inv.invocationId,
        observedAt: new Date(baseMs + 1000).toISOString(),
        result: { id: 41, slug, status: 'draft' },
      };
    },
  };
  const readback = {
    findContentBySlug: async () => ({
      siteOrigin: origin,
      contentType: 'posts',
      slug,
      items: [{ id: 41 }],
    }),
    getContent: async () => ({
      id: 41,
      type: 'post',
      status: 'draft',
      slug,
      titleRaw: 'Draft title',
      contentRaw: '<p>Draft body</p>',
      excerptRaw: 'Summary',
    }),
  };
  let nowMs = baseMs;
  const verifier = new CmsWordPressDraftVerifierV1({ wordpressClient: readback, now: () => { nowMs += 1000; return nowMs; } });
  const executor = new CmsWordPressExactEffectExecutorV1({
    provider,
    store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => { nowMs += 1000; return nowMs; },
  });
  const inv = invocation(id);
  const result = await executor.invoke({ invocation: inv, policyDecision: decision(id) });
  assert.equal(result.effectState.phase, ExactEffectPhase.COMMITTED);
  assert.equal(dispatches, 1);
  assert.equal((await store.load(id)).phase, ExactEffectPhase.COMMITTED);
  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: decision(id) }),
    /cannot execute from COMMITTED/i,
  );
  assert.equal(dispatches, 1);
});

test('ambiguous WordPress draft dispatch enters RECONCILE; deterministic slug can verify it but SAFE_RETRY is forbidden', async () => {
  const id = 'cms-exact-ambiguous-1';
  const slug = slugFor(id);
  const store = memoryStore();
  let dispatches = 0;
  const provider = {
    authorize: ({ invocation: inv, policyDecision }) => ({ invocation: inv, policyDecision }),
    invoke: async () => {
      dispatches += 1;
      const error = new Error('response lost after accepted create');
      error.effectMayHaveOccurred = true;
      error.safeToRetry = false;
      throw error;
    },
  };
  const readback = {
    findContentBySlug: async () => ({
      siteOrigin: origin,
      contentType: 'posts',
      slug,
      items: [{ id: 41 }],
    }),
    getContent: async () => ({
      id: 41,
      type: 'post',
      status: 'draft',
      slug,
      titleRaw: 'Draft title',
      contentRaw: '<p>Draft body</p>',
      excerptRaw: 'Summary',
    }),
  };
  let nowMs = baseMs;
  const verifier = new CmsWordPressDraftVerifierV1({ wordpressClient: readback, now: () => { nowMs += 1000; return nowMs; } });
  const executor = new CmsWordPressExactEffectExecutorV1({
    provider,
    store,
    verify: input => verifier.verify(input),
    reconcileVerify: input => verifier.reconcileVerify(input),
    now: () => { nowMs += 1000; return nowMs; },
  });
  const inv = invocation(id);
  await assert.rejects(
    () => executor.invoke({ invocation: inv, policyDecision: decision(id) }),
    error => error.reconcileRequired === true
      && error.safeToRetry === false
      && error.effectState.phase === ExactEffectPhase.RECONCILE,
  );
  assert.equal(dispatches, 1);
  await assert.rejects(
    () => executor.reconcile({
      invocationId: id,
      outcome: 'SAFE_RETRY',
      reasonCode: 'NO_EFFECT',
    }),
    /never infers SAFE_RETRY/i,
  );
  const reconciled = await executor.reconcile({
    invocationId: id,
    outcome: 'VERIFIED',
    reasonCode: 'EXACT_SLUG_READBACK',
    summary: 'Fresh exact-slug readback confirmed the draft.',
  });
  assert.equal(reconciled.phase, ExactEffectPhase.COMMITTED);
  assert.equal(dispatches, 1);
});
