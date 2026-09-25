import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GlobalSearchDomain,
  fuseGlobalSearchV1,
  normalizeGlobalSearchHitV1,
  normalizeGlobalSearchProviderResultV1,
} from '../src/core/global-search-federation.js';

const AT = '2026-09-25T00:20:00.000Z';
const DONE = '2026-09-25T00:20:01.000Z';
const SHA = 'a'.repeat(64);

function hit(overrides = {}) {
  return {
    schemaVersion: 1,
    hitId: 'hit-1',
    sourceId: 'source-1',
    revisionId: 'rev-1',
    uri: 'https://example.test/source-1',
    title: 'Source one',
    observedAt: AT,
    rank: 1,
    contentSha256: SHA,
    ...overrides,
  };
}

function batch(overrides = {}) {
  return {
    schemaVersion: 1,
    searchId: 'search-1',
    providerId: 'provider-project',
    domain: 'PROJECT',
    visibilityScopeId: 'scope-project',
    queriedAt: AT,
    completedAt: DONE,
    hits: [hit()],
    ...overrides,
  };
}

function fusion(overrides = {}) {
  return {
    schemaVersion: 1,
    searchId: 'search-1',
    query: 'source one',
    providerResults: [batch()],
    admittedSearchScopes: [{
      providerId: 'provider-project',
      domain: 'PROJECT',
      visibilityScopeId: 'scope-project',
    }],
    limit: 20,
    ...overrides,
  };
}

test('federates admitted metadata-only search refs without granting retrieval or execution', () => {
  const result = fuseGlobalSearchV1(fusion());
  assert.equal(result.resultCount, 1);
  assert.equal(result.results[0].domain, GlobalSearchDomain.PROJECT);
  assert.equal(result.results[0].sourceId, 'source-1');
  assert.equal(result.results[0].contentSha256, SHA);
  assert.equal(result.advisoryOnly, true);
  assert.equal(result.permissionAuthority, false);
  assert.equal(result.metadataAuthority, false);
  assert.equal(result.contentRetrievalAuthorized, false);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.requiresCanonicalContentAdmission, true);
  assert.equal(result.results[0].permissionAuthority, false);
  assert.equal(result.results[0].metadataAuthority, false);
  assert.equal(result.results[0].contentRetrievalAuthorized, false);
  assert.equal(result.results[0].providerRefs[0].queriedAt, AT);
  assert.equal(result.results[0].providerRefs[0].completedAt, DONE);
  assert.equal(result.results[0].providerRefs[0].observedAt, AT);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.results), true);
});

test('raw content and snippet fields are outside the contract', () => {
  assert.throws(() => normalizeGlobalSearchHitV1({ ...hit(), snippet: 'secret body' }), /unknown field: snippet/);
  assert.throws(() => normalizeGlobalSearchHitV1({ ...hit(), body: 'secret body' }), /unknown field: body/);
  assert.throws(() => normalizeGlobalSearchProviderResultV1({ ...batch(), rawResponse: 'secret' }), /unknown field: rawResponse/);
});

test('admission envelopes are exact provider/domain/scope tuples and fail closed', () => {
  assert.throws(() => fuseGlobalSearchV1({ ...fusion(), admittedSearchScopes: undefined }), /bounded plain array/);
  assert.throws(() => fuseGlobalSearchV1(fusion({ admittedSearchScopes: [] })), /must not be empty/);
  assert.throws(() => fuseGlobalSearchV1(fusion({
    admittedSearchScopes: [{ providerId: 'other', domain: 'PROJECT', visibilityScopeId: 'scope-project' }],
  })), /tuple is not admitted/);
  assert.throws(() => fuseGlobalSearchV1(fusion({
    admittedSearchScopes: [{ providerId: 'provider-project', domain: 'GITHUB', visibilityScopeId: 'scope-project' }],
  })), /tuple is not admitted/);
  assert.throws(() => fuseGlobalSearchV1(fusion({
    admittedSearchScopes: [{ providerId: 'provider-project', domain: 'PROJECT', visibilityScopeId: 'scope-other' }],
  })), /tuple is not admitted/);

  const mixed = batch({ providerId: 'provider-a', domain: 'GMAIL', visibilityScopeId: 'scope-b' });
  assert.throws(() => fuseGlobalSearchV1(fusion({
    providerResults: [mixed],
    admittedSearchScopes: [
      { providerId: 'provider-a', domain: 'PROJECT', visibilityScopeId: 'scope-a' },
      { providerId: 'provider-b', domain: 'GMAIL', visibilityScopeId: 'scope-b' },
    ],
  })), /tuple is not admitted/);
});

test('same exact source revision from multiple providers is fused deterministically', () => {
  const project = batch();
  const second = batch({
    providerId: 'provider-index',
    hits: [
      hit({
        hitId: 'other-hit',
        sourceId: 'other-source',
        revisionId: 'other-rev',
        uri: 'https://example.test/other',
        title: 'Other source',
        rank: 1,
        contentSha256: 'b'.repeat(64),
      }),
      hit({ hitId: 'hit-2', rank: 2, title: 'A deterministic title', observedAt: DONE }),
    ],
  });
  const first = fuseGlobalSearchV1(fusion({
    providerResults: [project, second],
    admittedSearchScopes: [
      { providerId: 'provider-project', domain: 'PROJECT', visibilityScopeId: 'scope-project' },
      { providerId: 'provider-index', domain: 'PROJECT', visibilityScopeId: 'scope-project' },
    ],
  }));
  const reversed = fuseGlobalSearchV1(fusion({
    providerResults: [second, project],
    admittedSearchScopes: [
      { providerId: 'provider-index', domain: 'PROJECT', visibilityScopeId: 'scope-project' },
      { providerId: 'provider-project', domain: 'PROJECT', visibilityScopeId: 'scope-project' },
    ],
  }));
  assert.deepEqual(first, reversed);
  const fusedSource = first.results.find(item => item.sourceId === 'source-1');
  assert.ok(fusedSource);
  assert.equal(fusedSource.providerCount, 2);
  assert.equal(fusedSource.bestRank, 1);
  assert.equal(fusedSource.title, 'A deterministic title');
  assert.equal(fusedSource.latestObservedAt, DONE);
  assert.equal(fusedSource.latestSearchCompletedAt, DONE);
  assert.deepEqual(fusedSource.providerRefs.map(ref => ref.providerId), ['provider-index', 'provider-project']);
});

test('different revisions never collapse into one result', () => {
  const second = batch({
    providerId: 'provider-index',
    hits: [hit({ hitId: 'hit-2', revisionId: 'rev-2', rank: 1, contentSha256: 'b'.repeat(64) })],
  });
  const result = fuseGlobalSearchV1(fusion({
    providerResults: [batch(), second],
    admittedSearchScopes: [
      { providerId: 'provider-project', domain: 'PROJECT', visibilityScopeId: 'scope-project' },
      { providerId: 'provider-index', domain: 'PROJECT', visibilityScopeId: 'scope-project' },
    ],
  }));
  assert.equal(result.results.length, 2);
  assert.deepEqual(new Set(result.results.map(item => item.revisionId)), new Set(['rev-1', 'rev-2']));
});

test('provider and observation chronology is causal', () => {
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({ queriedAt: DONE, completedAt: AT })), /queriedAt cannot be later/);
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({ hits: [hit({ observedAt: '2026-09-25T00:20:02.000Z' })] })), /observedAt cannot be later/);
});

test('canonical identities, enums, timestamps, digests and URI boundaries reject aliases', () => {
  assert.throws(() => normalizeGlobalSearchHitV1(hit({ sourceId: ' source-1' })), /sourceId is invalid/);
  assert.throws(() => normalizeGlobalSearchHitV1(hit({ observedAt: '2026-09-25T00:20:00Z' })), /canonical timestamp/);
  assert.throws(() => normalizeGlobalSearchHitV1(hit({ contentSha256: SHA.toUpperCase() })), /lowercase SHA-256/);
  assert.throws(() => normalizeGlobalSearchHitV1(hit({ uri: ' https://example.test/source-1' })), /uri is invalid/);
  assert.throws(() => normalizeGlobalSearchHitV1(hit({ uri: 'https://example.test/a\u001fb' })), /uri is invalid/);
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({ domain: 'project' })), /domain is invalid/);
});

test('duplicate hit ids, ranks, source identities and provider/domain batches fail closed', () => {
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({
    hits: [hit(), hit({ hitId: 'hit-1', rank: 2 })],
  })), /duplicate hitId/);
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({
    hits: [hit(), hit({ hitId: 'hit-2', rank: 1 })],
  })), /duplicate provider rank/);
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({
    hits: [hit(), hit({ hitId: 'hit-2', rank: 2 })],
  })), /duplicate provider source identity/);
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({
    hits: [hit({ rank: 2 })],
  })), /ranks must be contiguous from 1/);
  assert.throws(() => fuseGlobalSearchV1(fusion({
    providerResults: [batch(), batch({ visibilityScopeId: 'scope-project-2' })],
    admittedSearchScopes: [
      { providerId: 'provider-project', domain: 'PROJECT', visibilityScopeId: 'scope-project' },
      { providerId: 'provider-project', domain: 'PROJECT', visibilityScopeId: 'scope-project-2' },
    ],
  })), /duplicate provider\/domain batch/);
});

test('record accessors, hidden fields, symbols and exotic prototypes fail before reads', () => {
  let reads = 0;
  const input = hit();
  Object.defineProperty(input, 'sourceId', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return 'source-1'; },
  });
  assert.throws(() => normalizeGlobalSearchHitV1(input), /enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = hit();
  Object.defineProperty(hidden, 'rank', { value: 1, enumerable: false, configurable: true });
  assert.throws(() => normalizeGlobalSearchHitV1(hidden), /enumerable own data property/);

  const symbol = hit();
  symbol[Symbol('authority')] = true;
  assert.throws(() => normalizeGlobalSearchHitV1(symbol), /unknown field/);

  const exotic = Object.assign(Object.create({ admin: true }), hit());
  assert.throws(() => normalizeGlobalSearchHitV1(exotic), /plain object/);
});

test('arrays are dense plain data arrays and execute zero index getters', () => {
  let reads = 0;
  const hits = [hit()];
  Object.defineProperty(hits, '0', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return hit(); },
  });
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({ hits })), /enumerable own data property/);
  assert.equal(reads, 0);

  const sparse = [];
  sparse.length = 1;
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({ hits: sparse })), /enumerable own data property/);

  const custom = [hit()];
  custom.extra = true;
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({ hits: custom })), /non-canonical array property/);

  const subclass = new (class extends Array {})();
  subclass.push(hit());
  assert.throws(() => normalizeGlobalSearchProviderResultV1(batch({ hits: subclass })), /bounded plain array/);
});

test('null-prototype JSON-style records remain valid', () => {
  const h = Object.assign(Object.create(null), hit());
  const b = Object.assign(Object.create(null), batch({ hits: [h] }));
  const f = Object.assign(Object.create(null), fusion({ providerResults: [b] }));
  const result = fuseGlobalSearchV1(f);
  assert.equal(result.results[0].sourceId, 'source-1');
});

test('result limit is bounded and truncation is derived, not caller supplied', () => {
  const hits = [
    hit({ hitId: 'hit-1', sourceId: 'source-1', uri: 'https://example.test/1', rank: 1 }),
    hit({ hitId: 'hit-2', sourceId: 'source-2', uri: 'https://example.test/2', rank: 2 }),
  ];
  const result = fuseGlobalSearchV1(fusion({ providerResults: [batch({ hits })], limit: 1 }));
  assert.equal(result.resultCount, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.results[0].sourceId, 'source-1');
  assert.throws(() => fuseGlobalSearchV1({ ...fusion(), truncated: false }), /unknown field: truncated/);
  assert.throws(() => fuseGlobalSearchV1(fusion({ limit: 101 })), /limit is invalid/);
});

test('fusion ranking uses provider rank only and is locale-independent', () => {
  const hitsA = [
    hit({ hitId: 'z-hit', sourceId: 'z-source', uri: 'https://example.test/z', title: 'Zulu', rank: 1 }),
    hit({ hitId: 'A-hit', sourceId: 'A-source', uri: 'https://example.test/a', title: 'Alpha', rank: 2 }),
  ];
  const result = fuseGlobalSearchV1(fusion({ providerResults: [batch({ hits: hitsA })] }));
  assert.deepEqual(result.results.map(item => item.sourceId), ['z-source', 'A-source']);
  assert.ok(result.results[0].fusionScore > result.results[1].fusionScore);
});
