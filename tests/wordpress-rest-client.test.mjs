import test from 'node:test';
import assert from 'node:assert/strict';
import { WordPressRestClientV1 } from '../src/core/wordpress-rest-client.js';

const origin = 'https://example.test';
const credentialId = 'wordpress-example';
const username = 'owner';
const secret = 'app password';
const encoder = new TextEncoder();

function credentialResolver(calls = [], overrides = {}) {
  return {
    resolveCredential: async request => {
      calls.push(structuredClone(request));
      return {
        credentialId,
        kind: 'username-password',
        targetOrigin: origin,
        username,
        secret,
        ...overrides,
      };
    },
  };
}

function response(status, value, options = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    status,
    ...(options.body ? { body: options.body } : {}),
    text: async () => text,
  };
}

function content(id = 7, type = 'post', overrides = {}) {
  return {
    id,
    date_gmt: '2026-09-25T04:00:00',
    modified_gmt: '2026-09-25T05:00:00',
    slug: 'hello',
    status: 'publish',
    type,
    link: origin + '/hello/',
    title: { rendered: 'Hello' },
    excerpt: { rendered: '<p>Excerpt</p>' },
    content: { rendered: '<p>Body</p>' },
    ...overrides,
  };
}

function media(id = 9, overrides = {}) {
  return {
    id,
    date_gmt: '2026-09-25T04:00:00',
    modified_gmt: '2026-09-25T05:00:00',
    slug: 'photo',
    status: 'inherit',
    link: origin + '/photo/',
    title: { rendered: 'Photo' },
    caption: { rendered: '<p>Caption</p>' },
    alt_text: 'Alt',
    media_type: 'image',
    mime_type: 'image/jpeg',
    source_url: origin + '/wp-content/uploads/photo.jpg',
    media_details: { width: 1200, height: 800 },
    ...overrides,
  };
}

function taxonomy(id = 3, taxonomyType = 'category') {
  return {
    id,
    count: 4,
    description: 'Desc',
    link: origin + '/category/news/',
    name: 'News',
    slug: 'news',
    taxonomy: taxonomyType,
    parent: 0,
  };
}

function baseConfig(overrides = {}) {
  return {
    nativeClient: credentialResolver(),
    sites: [{ origin, credentialId }],
    fetchImpl: async () => response(200, {}),
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
    ...overrides,
  };
}

test('WordPress client requires canonical owner-authorized origins and dense site config', () => {
  for (const invalidOrigin of [
    ' http://example.test',
    'http://example.test',
    'https://EXAMPLE.test',
    'https://example.test/',
    'https://user@example.test',
    'https://example.test/blog',
  ]) {
    assert.throws(
      () => new WordPressRestClientV1(baseConfig({ sites: [{ origin: invalidOrigin, credentialId }] })),
      /origin|HTTPS/i,
    );
  }
  assert.doesNotThrow(() => new WordPressRestClientV1(baseConfig({
    sites: [{ origin: 'http://localhost:8080', credentialId }],
  })));
  const sparse = new Array(1);
  assert.throws(() => new WordPressRestClientV1(baseConfig({ sites: sparse })), /dense canonical array/i);
  assert.throws(
    () => new WordPressRestClientV1(baseConfig({ sites: [{ origin, credentialId }, { origin, credentialId: 'other' }] })),
    /duplicate origins/i,
  );
});

test('off-allowlist site and malformed REST path fail before credential resolution or fetch', async () => {
  const credentialCalls = [];
  let fetchCount = 0;
  const client = new WordPressRestClientV1(baseConfig({
    nativeClient: credentialResolver(credentialCalls),
    fetchImpl: async () => { fetchCount += 1; return response(200, {}); },
  }));
  await assert.rejects(() => client.readSite({ siteOrigin: 'https://other.test' }), error => error.code === 'WORDPRESS_SITE_NOT_ALLOWED');
  await assert.rejects(
    () => client.requestJson(origin, '//evil.test/wp-json/wp/v2/posts'),
    error => error.code === 'WORDPRESS_SCHEMA_INVALID',
  );
  await assert.rejects(
    () => client.requestJson(origin, '/wp-json/../admin'),
    error => error.code === 'WORDPRESS_SCHEMA_INVALID',
  );
  class HostileParams extends URLSearchParams {
    toString() { throw new Error('must not call subclass override'); }
  }
  await assert.rejects(
    () => client.requestJson(origin, '/wp-json/wp/v2/posts', new HostileParams()),
    error => error.code === 'WORDPRESS_SCHEMA_INVALID',
  );
  assert.deepEqual(credentialCalls, []);
  assert.equal(fetchCount, 0);
});

test('credential identity, target origin and kind are exact-bound before fetch', async () => {
  const cases = [
    { credentialId: 'other', targetOrigin: origin, kind: 'username-password' },
    { credentialId, targetOrigin: 'https://other.test', kind: 'username-password' },
    { credentialId, targetOrigin: origin, kind: 'bearer' },
  ];
  for (const overrides of cases) {
    let fetchCount = 0;
    const client = new WordPressRestClientV1(baseConfig({
      nativeClient: credentialResolver([], overrides),
      fetchImpl: async () => { fetchCount += 1; return response(200, {}); },
    }));
    await assert.rejects(() => client.readSite({ siteOrigin: origin }), error =>
      ['WORDPRESS_CREDENTIAL_SCOPE_MISMATCH', 'WORDPRESS_CREDENTIAL_INVALID'].includes(error.code));
    assert.equal(fetchCount, 0);
  }
});

test('transport uses GET, Basic application credential, redirect error and exact admitted origin', async () => {
  const credentialCalls = [];
  const requests = [];
  const client = new WordPressRestClientV1(baseConfig({
    nativeClient: credentialResolver(credentialCalls),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response(200, { name: 'Example', url: origin, home: origin, namespaces: ['wp/v2'] });
    },
  }));
  const result = await client.readSite({ siteOrigin: origin });
  assert.equal(result.origin, origin);
  assert.equal(result.name, 'Example');
  assert.deepEqual(result.namespaces, ['wp/v2']);
  assert.deepEqual(credentialCalls, [{ credentialId, targetOrigin: origin }]);
  assert.equal(requests.length, 1);
  const requestUrl = new URL(requests[0].url);
  assert.equal(requestUrl.origin, origin);
  assert.equal(requestUrl.pathname, '/wp-json/');
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.headers.Accept, 'application/json');
  assert.equal(requests[0].init.headers.Authorization, 'Basic ' + btoa(username + ':' + secret));
});

test('content search is bounded, fixed to wp/v2 and normalizes revision metadata', async () => {
  const urls = [];
  const client = new WordPressRestClientV1(baseConfig({
    fetchImpl: async url => {
      urls.push(url);
      return response(200, [content()]);
    },
  }));
  const result = await client.searchContent({
    siteOrigin: origin,
    contentType: 'posts',
    search: 'hello',
    status: 'draft',
    page: 2,
    perPage: 10,
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    id: 7,
    type: 'post',
    status: 'publish',
    slug: 'hello',
    dateGmt: '2026-09-25T04:00:00',
    modifiedGmt: '2026-09-25T05:00:00',
    link: origin + '/hello/',
    titleHtml: 'Hello',
    excerptHtml: '<p>Excerpt</p>',
  });
  const url = new URL(urls[0]);
  assert.equal(url.pathname, '/wp-json/wp/v2/posts');
  assert.equal(url.searchParams.get('context'), 'edit');
  assert.equal(url.searchParams.get('status'), 'draft');
  assert.equal(url.searchParams.get('search'), 'hello');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('per_page'), '10');
  await assert.rejects(
    () => client.searchContent({ siteOrigin: origin, contentType: 'posts', status: 'any' }),
    error => error.code === 'WORDPRESS_SCHEMA_INVALID',
  );
});

test('content get requires exact returned identity and exposes bounded rendered body', async () => {
  let payload = content(7);
  const client = new WordPressRestClientV1(baseConfig({
    fetchImpl: async () => response(200, payload),
  }));
  const value = await client.getContent({ siteOrigin: origin, contentType: 'posts', id: 7 });
  assert.equal(value.id, 7);
  assert.equal(value.contentHtml, '<p>Body</p>');
  payload = content(8);
  await assert.rejects(
    () => client.getContent({ siteOrigin: origin, contentType: 'posts', id: 7 }),
    error => error.code === 'WORDPRESS_RESPONSE_INVALID',
  );
});

test('media discovery returns deterministic technical metadata without downloading media bytes', async () => {
  const urls = [];
  const client = new WordPressRestClientV1(baseConfig({
    fetchImpl: async url => {
      urls.push(url);
      return response(200, [media()]);
    },
  }));
  const result = await client.searchMedia({ siteOrigin: origin, search: 'photo', perPage: 5 });
  assert.equal(result.items[0].width, 1200);
  assert.equal(result.items[0].height, 800);
  assert.equal(result.items[0].sourceUrl, origin + '/wp-content/uploads/photo.jpg');
  assert.equal(new URL(urls[0]).pathname, '/wp-json/wp/v2/media');
  assert.equal(urls.some(url => new URL(url).pathname.includes('/wp-content/')), false);
});

test('taxonomy discovery is restricted to categories/tags and bounded list responses', async () => {
  const client = new WordPressRestClientV1(baseConfig({
    fetchImpl: async () => response(200, [taxonomy()]),
  }));
  const result = await client.searchTaxonomy({ siteOrigin: origin, taxonomy: 'categories', perPage: 10 });
  assert.equal(result.items[0].name, 'News');
  await assert.rejects(
    () => client.searchTaxonomy({ siteOrigin: origin, taxonomy: 'users' }),
    error => error.code === 'WORDPRESS_SCHEMA_INVALID',
  );
});

test('oversize streaming response is rejected before JSON parse and reader is cancelled', async () => {
  let cancelled = 0;
  const chunks = [new Uint8Array(700), new Uint8Array(700)];
  let index = 0;
  const body = {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++] };
        },
        async cancel() { cancelled += 1; },
        releaseLock() {},
      };
    },
  };
  const client = new WordPressRestClientV1(baseConfig({
    maxJsonBytes: 1024,
    fetchImpl: async () => response(200, '', { body }),
  }));
  await assert.rejects(() => client.readSite({ siteOrigin: origin }), error => error.code === 'WORDPRESS_RESPONSE_TOO_LARGE');
  assert.equal(cancelled, 1);
});

test('invalid UTF-8 and malformed JSON fail as no-effect read errors', async () => {
  const malformedUtf8 = {
    status: 200,
    async arrayBuffer() { return Uint8Array.from([0xc3, 0x28]).buffer; },
  };
  let current = malformedUtf8;
  const client = new WordPressRestClientV1(baseConfig({ fetchImpl: async () => current }));
  await assert.rejects(() => client.readSite({ siteOrigin: origin }), error =>
    error.code === 'WORDPRESS_RESPONSE_INVALID' && error.effectMayHaveOccurred === false && error.safeToRetry === true);
  current = response(200, '{not-json');
  await assert.rejects(() => client.readSite({ siteOrigin: origin }), error =>
    error.code === 'WORDPRESS_RESPONSE_INVALID' && error.effectMayHaveOccurred === false && error.safeToRetry === true);
});

test('HTTP failure does not surface response body or credential material', async () => {
  const bodySecret = 'server echoed app password ' + secret;
  const client = new WordPressRestClientV1(baseConfig({
    fetchImpl: async () => response(401, { message: bodySecret }),
  }));
  await assert.rejects(
    () => client.readSite({ siteOrigin: origin }),
    error => error.code === 'WORDPRESS_HTTP_401'
      && !String(error.message).includes(secret)
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true,
  );
});
