export const WORDPRESS_REST_PROVIDER_ID = 'remote/cms-wordpress';

const MAX_JSON_BYTES = 2_000_000;
const MAX_BODY_TEXT = 500_000;
const MAX_SEARCH = 500;
const MAX_SITES = 32;
const CREDENTIAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/u;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const STATUS = new Set(['publish', 'draft', 'pending', 'private', 'future']);
const CONTENT_TYPES = new Set(['posts', 'pages']);
const TAXONOMIES = new Set(['categories', 'tags']);

function wpError(code, message, status = 0) {
  const error = new Error(String(message || 'WordPress read failed').slice(0, 4000));
  error.name = 'WordPressRestClientError';
  error.code = String(code || 'WORDPRESS_REQUEST_FAILED').slice(0, 120);
  error.status = Number.isInteger(status) ? status : 0;
  error.effectMayHaveOccurred = false;
  error.safeToRetry = true;
  return error;
}

function fail(code, message, status = 0) {
  throw wpError(code, message, status);
}

function record(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('WORDPRESS_SCHEMA_INVALID', label + ' must be an object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail('WORDPRESS_SCHEMA_INVALID', label + ' must be a plain object');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail('WORDPRESS_SCHEMA_INVALID', label + ' contains unknown field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('WORDPRESS_SCHEMA_INVALID', label + '.' + String(key) + ' must be an enumerable data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('WORDPRESS_RESPONSE_INVALID', label + ' must be an object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail('WORDPRESS_RESPONSE_INVALID', label + ' must be a plain object');
  return value;
}

function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
}

function denseArray(value, label, max = 128) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('WORDPRESS_SCHEMA_INVALID', label + ' must be a bounded plain array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > max) {
    fail('WORDPRESS_SCHEMA_INVALID', label + ' must be a bounded plain array');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.size || keys.some(key => typeof key !== 'string' || !expected.has(key))) {
    fail('WORDPRESS_SCHEMA_INVALID', label + ' must be a dense canonical array');
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('WORDPRESS_SCHEMA_INVALID', label + '[' + index + '] must be an enumerable data property');
    }
    out.push(descriptor.value);
  }
  return out;
}

function text(value, label, max = 4096, optional = false) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string') fail('WORDPRESS_SCHEMA_INVALID', label + ' must be text');
  if ((!optional && !value) || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('WORDPRESS_SCHEMA_INVALID', label + ' is invalid');
  }
  return value;
}

function credentialId(value, label = 'credentialId') {
  const out = text(value, label, 128);
  if (!CREDENTIAL_ID.test(out)) fail('WORDPRESS_SCHEMA_INVALID', label + ' is invalid');
  return out;
}

function positiveInt(value, label, max = Number.MAX_SAFE_INTEGER, fallback = null) {
  if (value == null && fallback != null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('WORDPRESS_SCHEMA_INVALID', label + ' is invalid');
  return value;
}

function responseInt(value, label, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail('WORDPRESS_RESPONSE_INVALID', label + ' is invalid');
  return value;
}

function canonicalOrigin(value, label = 'site origin') {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 2048) {
    fail('WORDPRESS_SCHEMA_INVALID', label + ' must be an exact origin');
  }
  let parsed;
  try { parsed = new URL(value); } catch { fail('WORDPRESS_SCHEMA_INVALID', label + ' is invalid'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    fail('WORDPRESS_SCHEMA_INVALID', label + ' must use HTTPS except localhost development');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) {
    fail('WORDPRESS_SCHEMA_INVALID', label + ' must be an exact credential-free origin without path/query/fragment');
  }
  return parsed.origin;
}

function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) fail('WORDPRESS_SCHEMA_INVALID', label + ' is required');
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        fail('WORDPRESS_SCHEMA_INVALID', label + '.' + method + ' must be a data method');
      }
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  fail('WORDPRESS_SCHEMA_INVALID', label + '.' + method + ' is required');
}

function siteConfig(value, index) {
  const raw = record(value, new Set(['origin', 'credentialId']), 'sites[' + index + ']');
  return Object.freeze({
    origin: canonicalOrigin(raw.origin, 'sites[' + index + '].origin'),
    credentialId: credentialId(raw.credentialId, 'sites[' + index + '].credentialId'),
  });
}

function encodeBasic(username, secret) {
  const source = username + ':' + secret;
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function responseBytes(response, maxBytes) {
  if (!response || typeof response !== 'object') fail('WORDPRESS_TRANSPORT_ERROR', 'WordPress response is invalid');
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!(next.value instanceof Uint8Array)) fail('WORDPRESS_RESPONSE_READ_FAILED', 'WordPress response stream returned invalid bytes');
        total += next.value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch {}
          fail('WORDPRESS_RESPONSE_TOO_LARGE', 'WordPress response exceeds the configured size bound');
        }
        chunks.push(next.value);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return out;
  }
  let bytes;
  if (typeof response.arrayBuffer === 'function') bytes = new Uint8Array(await response.arrayBuffer());
  else if (typeof response.text === 'function') bytes = new TextEncoder().encode(await response.text());
  else fail('WORDPRESS_RESPONSE_READ_FAILED', 'WordPress response body is unavailable');
  if (bytes.byteLength > maxBytes) fail('WORDPRESS_RESPONSE_TOO_LARGE', 'WordPress response exceeds the configured size bound');
  return bytes;
}

function decodeUtf8(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('WORDPRESS_RESPONSE_INVALID', label + ' is not valid UTF-8'); }
}

function rendered(value, label, max) {
  if (value == null) return '';
  const object = plain(value, label);
  const raw = own(object, 'rendered');
  if (raw == null) return '';
  if (typeof raw !== 'string' || raw.length > max) fail('WORDPRESS_RESPONSE_INVALID', label + '.rendered is invalid');
  return raw;
}

function responseText(value, label, max, optional = false) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || (!optional && !value) || value.length > max) {
    fail('WORDPRESS_RESPONSE_INVALID', label + ' is invalid');
  }
  return value;
}

function sourceUrl(value, label) {
  if (value == null || value === '') return '';
  const out = responseText(value, label, 8192);
  let parsed;
  try { parsed = new URL(out); } catch { fail('WORDPRESS_RESPONSE_INVALID', label + ' is invalid'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('WORDPRESS_RESPONSE_INVALID', label + ' is invalid');
  }
  return out;
}

function contentItem(value, { full = false, expectedId = null } = {}) {
  const raw = plain(value, 'WordPress content item');
  const id = responseInt(own(raw, 'id'), 'WordPress content id');
  if (id < 1 || (expectedId != null && id !== expectedId)) fail('WORDPRESS_RESPONSE_INVALID', 'WordPress returned a different content identity');
  const type = responseText(own(raw, 'type'), 'WordPress content type', 80);
  if (!['post', 'page'].includes(type)) fail('WORDPRESS_RESPONSE_INVALID', 'WordPress returned an unsupported content type');
  const status = responseText(own(raw, 'status'), 'WordPress content status', 80);
  const out = {
    id,
    type,
    status,
    slug: responseText(own(raw, 'slug'), 'WordPress content slug', 200, true),
    dateGmt: responseText(own(raw, 'date_gmt'), 'WordPress content date_gmt', 64, true),
    modifiedGmt: responseText(own(raw, 'modified_gmt'), 'WordPress content modified_gmt', 64, true),
    link: sourceUrl(own(raw, 'link'), 'WordPress content link'),
    titleHtml: rendered(own(raw, 'title'), 'WordPress content title', 100_000),
    excerptHtml: rendered(own(raw, 'excerpt'), 'WordPress content excerpt', 200_000),
  };
  if (full) out.contentHtml = rendered(own(raw, 'content'), 'WordPress content body', MAX_BODY_TEXT);
  return Object.freeze(out);
}

function mediaItem(value, { expectedId = null } = {}) {
  const raw = plain(value, 'WordPress media item');
  const id = responseInt(own(raw, 'id'), 'WordPress media id');
  if (id < 1 || (expectedId != null && id !== expectedId)) fail('WORDPRESS_RESPONSE_INVALID', 'WordPress returned a different media identity');
  const details = own(raw, 'media_details');
  let width = null;
  let height = null;
  if (details != null) {
    const d = plain(details, 'WordPress media details');
    width = responseInt(own(d, 'width'), 'WordPress media width', { optional: true });
    height = responseInt(own(d, 'height'), 'WordPress media height', { optional: true });
  }
  return Object.freeze({
    id,
    status: responseText(own(raw, 'status'), 'WordPress media status', 80),
    slug: responseText(own(raw, 'slug'), 'WordPress media slug', 200, true),
    dateGmt: responseText(own(raw, 'date_gmt'), 'WordPress media date_gmt', 64, true),
    modifiedGmt: responseText(own(raw, 'modified_gmt'), 'WordPress media modified_gmt', 64, true),
    link: sourceUrl(own(raw, 'link'), 'WordPress media link'),
    titleHtml: rendered(own(raw, 'title'), 'WordPress media title', 100_000),
    captionHtml: rendered(own(raw, 'caption'), 'WordPress media caption', 200_000),
    altText: responseText(own(raw, 'alt_text'), 'WordPress media alt_text', 100_000, true),
    mediaType: responseText(own(raw, 'media_type'), 'WordPress media type', 80, true),
    mimeType: responseText(own(raw, 'mime_type'), 'WordPress media mime type', 256, true),
    sourceUrl: sourceUrl(own(raw, 'source_url'), 'WordPress media source_url'),
    width,
    height,
  });
}

function taxonomyItem(value) {
  const raw = plain(value, 'WordPress taxonomy item');
  const id = responseInt(own(raw, 'id'), 'WordPress taxonomy id');
  if (id < 1) fail('WORDPRESS_RESPONSE_INVALID', 'WordPress taxonomy id is invalid');
  return Object.freeze({
    id,
    count: responseInt(own(raw, 'count'), 'WordPress taxonomy count', { optional: true }) ?? 0,
    name: responseText(own(raw, 'name'), 'WordPress taxonomy name', 1000),
    slug: responseText(own(raw, 'slug'), 'WordPress taxonomy slug', 200),
    description: responseText(own(raw, 'description'), 'WordPress taxonomy description', 100_000, true),
    link: sourceUrl(own(raw, 'link'), 'WordPress taxonomy link'),
    taxonomy: responseText(own(raw, 'taxonomy'), 'WordPress taxonomy type', 80),
    parent: responseInt(own(raw, 'parent'), 'WordPress taxonomy parent', { optional: true }) ?? 0,
  });
}

export class WordPressRestClientV1 {
  constructor(config = {}) {
    const raw = record(config, new Set([
      'nativeClient', 'sites', 'fetchImpl', 'requestTimeoutMs', 'setTimeoutImpl', 'clearTimeoutImpl', 'maxJsonBytes',
    ]), 'WordPress config');
    this.resolveCredential = bindDataMethod(raw.nativeClient, 'resolveCredential', 'nativeClient');
    const sites = denseArray(raw.sites ?? [], 'sites', MAX_SITES).map(siteConfig);
    if (!sites.length) fail('WORDPRESS_SCHEMA_INVALID', 'sites must contain at least one owner-authorized WordPress origin');
    if (new Set(sites.map(site => site.origin)).size !== sites.length) fail('WORDPRESS_SCHEMA_INVALID', 'sites contains duplicate origins');
    this.sites = Object.freeze(sites);
    this.siteByOrigin = new Map(sites.map(site => [site.origin, site]));
    this.fetchImpl = raw.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') fail('WORDPRESS_SCHEMA_INVALID', 'fetchImpl is required');
    this.requestTimeoutMs = raw.requestTimeoutMs == null ? 30_000 : raw.requestTimeoutMs;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1_000 || this.requestTimeoutMs > 300_000) {
      fail('WORDPRESS_SCHEMA_INVALID', 'requestTimeoutMs must be an integer between 1000 and 300000');
    }
    this.setTimeoutImpl = raw.setTimeoutImpl ?? globalThis.setTimeout;
    this.clearTimeoutImpl = raw.clearTimeoutImpl ?? globalThis.clearTimeout;
    if (typeof this.setTimeoutImpl !== 'function' || typeof this.clearTimeoutImpl !== 'function') fail('WORDPRESS_SCHEMA_INVALID', 'timeout scheduler is required');
    this.maxJsonBytes = raw.maxJsonBytes == null ? MAX_JSON_BYTES : raw.maxJsonBytes;
    if (!Number.isInteger(this.maxJsonBytes) || this.maxJsonBytes < 1024 || this.maxJsonBytes > 20_000_000) {
      fail('WORDPRESS_SCHEMA_INVALID', 'maxJsonBytes is invalid');
    }
  }

  assertSiteAllowed(siteOrigin) {
    const origin = canonicalOrigin(siteOrigin);
    const site = this.siteByOrigin.get(origin);
    if (!site) fail('WORDPRESS_SITE_NOT_ALLOWED', 'WordPress site is outside the owner-configured allowlist');
    return site;
  }

  async requestJson(siteOrigin, path, query = null) {
    const site = this.assertSiteAllowed(siteOrigin);
    if (typeof path !== 'string' || !path.startsWith('/wp-json/') || path.includes('://') || path.includes('\\') || path.includes('#')) {
      fail('WORDPRESS_SCHEMA_INVALID', 'WordPress REST path is invalid');
    }
    if (query != null && Object.getPrototypeOf(query) !== URLSearchParams.prototype) {
      fail('WORDPRESS_SCHEMA_INVALID', 'WordPress query must be an exact URLSearchParams');
    }
    const url = new URL(path, site.origin);
    if (url.origin !== site.origin || url.pathname !== path) fail('WORDPRESS_SCHEMA_INVALID', 'WordPress REST path is not canonical');
    if (query) url.search = URLSearchParams.prototype.toString.call(query);

    let resolved;
    try {
      resolved = await this.resolveCredential({ credentialId: site.credentialId, targetOrigin: site.origin });
    } catch {
      fail('WORDPRESS_CREDENTIAL_UNAVAILABLE', 'WordPress credential is unavailable');
    }
    const credential = record(resolved, new Set(['credentialId', 'kind', 'targetOrigin', 'username', 'secret']), 'Resolved WordPress credential');
    if (credential.credentialId !== site.credentialId || credential.targetOrigin !== site.origin) {
      fail('WORDPRESS_CREDENTIAL_SCOPE_MISMATCH', 'Resolved WordPress credential identity/origin does not match the admitted site');
    }
    if (credential.kind !== 'username-password') fail('WORDPRESS_CREDENTIAL_INVALID', 'WordPress requires a username-password application credential');
    const username = text(credential.username, 'WordPress credential username', 320);
    const secret = text(credential.secret, 'WordPress credential secret', 100_000);
    const authorization = 'Basic ' + encodeBasic(username, secret);

    const controller = new AbortController();
    const timer = this.setTimeoutImpl(() => controller.abort(), this.requestTimeoutMs);
    let response;
    let bytes;
    try {
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { Authorization: authorization, Accept: 'application/json' },
        });
      } catch {
        fail(controller.signal.aborted ? 'WORDPRESS_REQUEST_TIMEOUT' : 'WORDPRESS_TRANSPORT_ERROR',
          controller.signal.aborted ? 'WordPress request timed out' : 'WordPress transport failed');
      }
      try {
        bytes = await responseBytes(response, this.maxJsonBytes);
      } catch (error) {
        if (controller.signal.aborted) fail('WORDPRESS_REQUEST_TIMEOUT', 'WordPress request timed out');
        if (error?.name === 'WordPressRestClientError') throw error;
        fail('WORDPRESS_RESPONSE_READ_FAILED', 'WordPress response body read failed');
      }
    } finally {
      this.clearTimeoutImpl(timer);
      resolved = null;
    }

    const status = Number(response?.status) || 0;
    if (status < 200 || status >= 300) fail('WORDPRESS_HTTP_' + (status || 'ERROR'), 'WordPress HTTP ' + status, status);
    const bodyText = decodeUtf8(bytes, 'WordPress JSON response');
    let payload;
    try { payload = bodyText ? JSON.parse(bodyText) : {}; }
    catch { fail('WORDPRESS_RESPONSE_INVALID', 'WordPress returned invalid JSON'); }
    return payload;
  }

  async readSite(input = {}) {
    const raw = record(input, new Set(['siteOrigin']), 'WordPress site request');
    const site = this.assertSiteAllowed(raw.siteOrigin);
    const payload = plain(await this.requestJson(site.origin, '/wp-json/'), 'WordPress REST index');
    const namespacesRaw = own(payload, 'namespaces');
    const namespaces = namespacesRaw == null ? [] : denseArray(namespacesRaw, 'WordPress namespaces', 512).map((value, index) =>
      responseText(value, 'WordPress namespaces[' + index + ']', 256));
    return Object.freeze({
      origin: site.origin,
      name: responseText(own(payload, 'name'), 'WordPress site name', 10_000, true),
      url: sourceUrl(own(payload, 'url'), 'WordPress site url'),
      home: sourceUrl(own(payload, 'home'), 'WordPress site home'),
      namespaces: Object.freeze(namespaces),
    });
  }

  async searchContent(input = {}) {
    const raw = record(input, new Set(['siteOrigin', 'contentType', 'search', 'status', 'page', 'perPage']), 'WordPress content search request');
    const site = this.assertSiteAllowed(raw.siteOrigin);
    const contentType = text(raw.contentType, 'contentType', 16);
    if (!CONTENT_TYPES.has(contentType)) fail('WORDPRESS_SCHEMA_INVALID', 'contentType must be posts or pages');
    const search = raw.search == null ? '' : text(raw.search, 'search', MAX_SEARCH, true);
    const status = raw.status == null ? 'publish' : text(raw.status, 'status', 32);
    if (!STATUS.has(status)) fail('WORDPRESS_SCHEMA_INVALID', 'status is not admitted');
    const page = positiveInt(raw.page, 'page', 10_000, 1);
    const perPage = positiveInt(raw.perPage, 'perPage', 100, 20);
    const query = new URLSearchParams({
      context: 'edit',
      status,
      page: String(page),
      per_page: String(perPage),
      orderby: 'modified',
      order: 'desc',
      _fields: 'id,date_gmt,modified_gmt,slug,status,type,link,title,excerpt',
    });
    if (search) query.set('search', search);
    const payload = await this.requestJson(site.origin, '/wp-json/wp/v2/' + contentType, query);
    const items = denseArray(payload, 'WordPress content search response', 100).map(value => contentItem(value));
    return Object.freeze({ siteOrigin: site.origin, contentType, status, page, perPage, items: Object.freeze(items) });
  }

  async getContent(input = {}) {
    const raw = record(input, new Set(['siteOrigin', 'contentType', 'id']), 'WordPress content get request');
    const site = this.assertSiteAllowed(raw.siteOrigin);
    const contentType = text(raw.contentType, 'contentType', 16);
    if (!CONTENT_TYPES.has(contentType)) fail('WORDPRESS_SCHEMA_INVALID', 'contentType must be posts or pages');
    const id = positiveInt(raw.id, 'id');
    const query = new URLSearchParams({
      context: 'edit',
      _fields: 'id,date_gmt,modified_gmt,slug,status,type,link,title,excerpt,content',
    });
    return contentItem(await this.requestJson(site.origin, '/wp-json/wp/v2/' + contentType + '/' + id, query), { full: true, expectedId: id });
  }

  async searchMedia(input = {}) {
    const raw = record(input, new Set(['siteOrigin', 'search', 'page', 'perPage']), 'WordPress media search request');
    const site = this.assertSiteAllowed(raw.siteOrigin);
    const search = raw.search == null ? '' : text(raw.search, 'search', MAX_SEARCH, true);
    const page = positiveInt(raw.page, 'page', 10_000, 1);
    const perPage = positiveInt(raw.perPage, 'perPage', 100, 20);
    const query = new URLSearchParams({
      context: 'edit',
      page: String(page),
      per_page: String(perPage),
      orderby: 'modified',
      order: 'desc',
      _fields: 'id,date_gmt,modified_gmt,slug,status,link,title,caption,alt_text,media_type,mime_type,source_url,media_details',
    });
    if (search) query.set('search', search);
    const payload = await this.requestJson(site.origin, '/wp-json/wp/v2/media', query);
    const items = denseArray(payload, 'WordPress media search response', 100).map(value => mediaItem(value));
    return Object.freeze({ siteOrigin: site.origin, page, perPage, items: Object.freeze(items) });
  }

  async getMedia(input = {}) {
    const raw = record(input, new Set(['siteOrigin', 'id']), 'WordPress media get request');
    const site = this.assertSiteAllowed(raw.siteOrigin);
    const id = positiveInt(raw.id, 'id');
    const query = new URLSearchParams({
      context: 'edit',
      _fields: 'id,date_gmt,modified_gmt,slug,status,link,title,caption,alt_text,media_type,mime_type,source_url,media_details',
    });
    return mediaItem(await this.requestJson(site.origin, '/wp-json/wp/v2/media/' + id, query), { expectedId: id });
  }

  async searchTaxonomy(input = {}) {
    const raw = record(input, new Set(['siteOrigin', 'taxonomy', 'search', 'page', 'perPage']), 'WordPress taxonomy search request');
    const site = this.assertSiteAllowed(raw.siteOrigin);
    const taxonomy = text(raw.taxonomy, 'taxonomy', 32);
    if (!TAXONOMIES.has(taxonomy)) fail('WORDPRESS_SCHEMA_INVALID', 'taxonomy must be categories or tags');
    const search = raw.search == null ? '' : text(raw.search, 'search', MAX_SEARCH, true);
    const page = positiveInt(raw.page, 'page', 10_000, 1);
    const perPage = positiveInt(raw.perPage, 'perPage', 100, 20);
    const query = new URLSearchParams({
      context: 'edit',
      page: String(page),
      per_page: String(perPage),
      orderby: 'name',
      order: 'asc',
      _fields: 'id,count,description,link,name,slug,taxonomy,parent',
    });
    if (search) query.set('search', search);
    const payload = await this.requestJson(site.origin, '/wp-json/wp/v2/' + taxonomy, query);
    const items = denseArray(payload, 'WordPress taxonomy search response', 100).map(value => taxonomyItem(value));
    return Object.freeze({ siteOrigin: site.origin, taxonomy, page, perPage, items: Object.freeze(items) });
  }
}
