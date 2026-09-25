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

test('site adapter URL contract fails closed outside declared HTTPS hosts', () => {
  assert.equal(siteAdapterAcceptsUrl(SiteAdapterId.CHATGPT_WEB, 'https://chatgpt.com/c/abc'), true);
  assert.equal(siteAdapterAcceptsUrl(SiteAdapterId.CHATGPT_WEB, 'https://www.chatgpt.com/'), false);
  assert.equal(siteAdapterAcceptsUrl(SiteAdapterId.CHATGPT_WEB, 'http://chatgpt.com/'), false);
  assert.equal(siteAdapterAcceptsUrl(SiteAdapterId.CHATGPT_WEB, 'https://example.com/'), false);
  assert.throws(() => requireSiteAdapterUrl(SiteAdapterId.CHATGPT_WEB, 'https://example.com/'), /does not accept URL/);
  assert.throws(() => getSiteAdapter('future-site'), /Unsupported site adapter/);
});
