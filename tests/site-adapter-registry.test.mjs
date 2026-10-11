import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SiteAdapterId,
  getSiteAdapter,
  listSiteAdapters,
  requireSiteAdapterUrl,
  siteAdapterAcceptsUrl,
} from '../src/core/site-adapter-registry.js';

test('ChatGPT site adapter is explicit and returned defensively', () => {
  const adapter = getSiteAdapter(SiteAdapterId.CHATGPT_WEB);
  assert.equal(adapter.id, SiteAdapterId.CHATGPT_WEB);
  assert.deepEqual(adapter.hosts, ['chatgpt.com']);
  assert.deepEqual(adapter.recoveryScriptFiles, [
    'src/interaction/chatgpt-adapter.js',
    'src/interaction/content-script.js',
  ]);
  adapter.hosts.length = 0;
  assert.equal(getSiteAdapter(SiteAdapterId.CHATGPT_WEB).hosts.length, 1);
  assert.equal(listSiteAdapters().length, 1);
});

test('site adapter identities are exact text and never trimmed or coerced', () => {
  for (const alias of [
    ` ${SiteAdapterId.CHATGPT_WEB}`,
    `${SiteAdapterId.CHATGPT_WEB} `,
    '',
  ]) {
    assert.throws(
      () => getSiteAdapter(alias),
      /exact canonical text representation/,
    );
  }

  let coercions = 0;
  const coercive = {
    toString() {
      coercions += 1;
      return SiteAdapterId.CHATGPT_WEB;
    },
  };
  assert.throws(
    () => getSiteAdapter(coercive),
    /exact canonical text representation/,
  );
  assert.equal(coercions, 0);

  assert.throws(
    () => siteAdapterAcceptsUrl(` ${SiteAdapterId.CHATGPT_WEB}`, 'https://chatgpt.com/'),
    /exact canonical text representation/,
  );
  assert.throws(
    () => requireSiteAdapterUrl(coercive, 'https://chatgpt.com/'),
    /exact canonical text representation/,
  );
  assert.equal(coercions, 0);
});

test('site adapter registry resolves only own canonical descriptors', () => {
  for (const inheritedId of ['toString', 'constructor', '__proto__']) {
    assert.throws(
      () => getSiteAdapter(inheritedId),
      /Unsupported site adapter/,
    );
  }

  const pollutedId = 'polluted-site-adapter';
  Object.defineProperty(Object.prototype, pollutedId, {
    configurable: true,
    enumerable: true,
    value: {
      id: pollutedId,
      version: 999,
      hosts: ['chatgpt.com'],
      recoveryScriptFiles: [],
    },
  });
  try {
    assert.throws(
      () => getSiteAdapter(pollutedId),
      /Unsupported site adapter/,
    );
  } finally {
    delete Object.prototype[pollutedId];
  }

  assert.equal(getSiteAdapter(SiteAdapterId.CHATGPT_WEB).id, SiteAdapterId.CHATGPT_WEB);
});

test('site adapter URL contract fails closed outside declared HTTPS hosts', () => {
  assert.equal(siteAdapterAcceptsUrl(SiteAdapterId.CHATGPT_WEB, 'https://chatgpt.com/c/abc'), true);
  assert.equal(siteAdapterAcceptsUrl(SiteAdapterId.CHATGPT_WEB, 'https://www.chatgpt.com/'), false);
  assert.equal(siteAdapterAcceptsUrl(SiteAdapterId.CHATGPT_WEB, 'http://chatgpt.com/'), false);
  assert.equal(siteAdapterAcceptsUrl(SiteAdapterId.CHATGPT_WEB, 'https://example.com/'), false);
  assert.throws(() => requireSiteAdapterUrl(SiteAdapterId.CHATGPT_WEB, 'https://example.com/'), /does not accept URL/);
  assert.throws(() => getSiteAdapter('future-site'), /Unsupported site adapter/);
});
