import { assertToolInvocationAuthorizedV1, normalizeToolDescriptorV1 } from './universal-agent-contracts.js';
import { createSha256FingerprintV1 } from './fingerprint.js';
import {
  UntrustedContentSourceKind,
  normalizeUntrustedContentSourceV1,
} from './untrusted-content-guard.js';

export const CMS_WORDPRESS_PROVIDER_ID = 'remote/cms-wordpress';

export const CmsWordPressToolId = Object.freeze({
  SITE_READ: 'remote/cms-wordpress/site.read',
  CONTENT_SEARCH: 'remote/cms-wordpress/content.search',
  CONTENT_GET: 'remote/cms-wordpress/content.get',
  MEDIA_SEARCH: 'remote/cms-wordpress/media.search',
  MEDIA_GET: 'remote/cms-wordpress/media.get',
  TAXONOMY_SEARCH: 'remote/cms-wordpress/taxonomy.search',
});

export const CmsWordPressCapabilityId = Object.freeze({
  SITE_READ: 'cms.wordpress.site.read',
  CONTENT_READ: 'cms.wordpress.content.read',
  MEDIA_READ: 'cms.wordpress.media.read',
  TAXONOMY_READ: 'cms.wordpress.taxonomy.read',
});

const TOOLS = Object.freeze([
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: CmsWordPressToolId.SITE_READ,
    providerId: CMS_WORDPRESS_PROVIDER_ID,
    label: 'Read owner-authorized WordPress site metadata',
    description: 'Reads bounded WordPress REST index metadata from one explicitly owner-authorized site.',
    capabilityIds: [CmsWordPressCapabilityId.SITE_READ],
    inputSchemaRef: 'cms-wordpress-schema/site.read/input',
    outputSchemaRef: 'cms-wordpress-schema/site.read/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: CmsWordPressToolId.CONTENT_SEARCH,
    providerId: CMS_WORDPRESS_PROVIDER_ID,
    label: 'Search WordPress posts or pages',
    description: 'Lists bounded post/page metadata from an owner-authorized WordPress site without mutation.',
    capabilityIds: [CmsWordPressCapabilityId.CONTENT_READ],
    inputSchemaRef: 'cms-wordpress-schema/content.search/input',
    outputSchemaRef: 'cms-wordpress-schema/content.search/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: CmsWordPressToolId.CONTENT_GET,
    providerId: CMS_WORDPRESS_PROVIDER_ID,
    label: 'Read one WordPress post or page',
    description: 'Reads one bounded post/page including rendered content from an owner-authorized WordPress site.',
    capabilityIds: [CmsWordPressCapabilityId.CONTENT_READ],
    inputSchemaRef: 'cms-wordpress-schema/content.get/input',
    outputSchemaRef: 'cms-wordpress-schema/content.get/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: CmsWordPressToolId.MEDIA_SEARCH,
    providerId: CMS_WORDPRESS_PROVIDER_ID,
    label: 'Search WordPress media',
    description: 'Lists bounded media metadata including technical dimensions without downloading media bytes.',
    capabilityIds: [CmsWordPressCapabilityId.MEDIA_READ],
    inputSchemaRef: 'cms-wordpress-schema/media.search/input',
    outputSchemaRef: 'cms-wordpress-schema/media.search/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: CmsWordPressToolId.MEDIA_GET,
    providerId: CMS_WORDPRESS_PROVIDER_ID,
    label: 'Read one WordPress media item',
    description: 'Reads bounded metadata for one media item without fetching or mutating the underlying media.',
    capabilityIds: [CmsWordPressCapabilityId.MEDIA_READ],
    inputSchemaRef: 'cms-wordpress-schema/media.get/input',
    outputSchemaRef: 'cms-wordpress-schema/media.get/output',
    readOnly: true,
  }),
  normalizeToolDescriptorV1({
    schemaVersion: 1,
    toolId: CmsWordPressToolId.TAXONOMY_SEARCH,
    providerId: CMS_WORDPRESS_PROVIDER_ID,
    label: 'Search WordPress categories or tags',
    description: 'Lists bounded category/tag metadata from an owner-authorized WordPress site.',
    capabilityIds: [CmsWordPressCapabilityId.TAXONOMY_READ],
    inputSchemaRef: 'cms-wordpress-schema/taxonomy.search/input',
    outputSchemaRef: 'cms-wordpress-schema/taxonomy.search/output',
    readOnly: true,
  }),
]);

const INVOKE_KEYS = new Set(['invocation', 'policyDecision']);
const INVOCATION_KEYS = new Set([
  'schemaVersion', 'invocationId', 'toolId', 'providerId', 'requestedCapabilityIds',
  'policyDecisionId', 'arguments', 'createdAt', 'parentInvocationId',
]);
const POLICY_KEYS = new Set([
  'schemaVersion', 'decisionId', 'invocationId', 'decision', 'reasonCode', 'reason',
  'approvalId', 'decidedAt',
]);
const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

function fail(message) { throw new Error(message); }
function canonicalSourceOrigin(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    fail('WordPress source origin must be canonical');
  }
  let parsed;
  try { parsed = new URL(value); } catch { fail('WordPress source origin must be canonical'); }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || parsed.origin !== value) {
    fail('WordPress source origin must be canonical');
  }
  return parsed.origin;
}

function bindOptionalDataFunction(value, label) {
  if (value == null) return null;
  if (typeof value !== 'function') fail(label + ' must be a function');
  return value;
}

async function materializeUntrustedWordPressResult({
  materialize,
  invocation,
  result,
  observedAt,
}) {
  if (typeof materialize !== 'function') {
    fail('Canonical untrusted-content artifact materializer is required');
  }
  const material = snapshotJson(result, 'WordPress provider result');
  const bytes = JSON.stringify(material);
  const encoded = new TextEncoder().encode(bytes);
  const fingerprint = await createSha256FingerprintV1(bytes);
  const expectedSha256 = fingerprint.slice('sha256:'.length);
  const sourceOrigin = canonicalSourceOrigin(material.siteOrigin ?? invocation.arguments.siteOrigin);
  const artifactRef = await materialize(Object.freeze({
    schemaVersion: 1,
    invocationId: invocation.invocationId,
    toolId: invocation.toolId,
    providerId: CMS_WORDPRESS_PROVIDER_ID,
    sourceOrigin,
    observedAt,
    mediaType: 'application/json',
    content: bytes,
  }));
  const source = normalizeUntrustedContentSourceV1({
    schemaVersion: 1,
    sourceId: 'wordpress:' + invocation.invocationId,
    sourceKind: UntrustedContentSourceKind.TOOL_METADATA,
    sourceOrigin,
    artifactRef,
    observedAt,
  });
  if (source.artifactRef.sha256 !== expectedSha256) {
    fail('WordPress materialized artifact SHA-256 does not match exact provider result');
  }
  if (source.artifactRef.sizeBytes !== encoded.byteLength) {
    fail('WordPress materialized artifact size does not match exact provider result');
  }
  if (source.artifactRef.producerInvocationId !== invocation.invocationId) {
    fail('WordPress materialized artifact producerInvocationId mismatch');
  }
  return Object.freeze({ material: Object.freeze(material), source });
}


function snapshotRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be an object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(label + ' must be a plain object');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) fail(label + ' contains unknown field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(label + '.' + String(key) + ' must be an enumerable data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function snapshotJson(value, label, depth = 0, nodes = { count: 0 }) {
  if (depth > 32) fail(label + ' is too deep');
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(label + ' contains an invalid number');
    return value;
  }
  if (typeof value !== 'object') fail(label + ' contains an unsupported value');
  if (++nodes.count > 10_000) fail(label + ' is too complex');
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(label + ' must be a bounded plain array');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 1024) {
      fail(label + ' must be a bounded plain array');
    }
    const length = lengthDescriptor.value;
    const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expected.size || keys.some(key => typeof key !== 'string' || !expected.has(key))) {
      fail(label + ' must be a dense canonical array');
    }
    const out = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        fail(label + '[' + index + '] must be an enumerable data property');
      }
      out.push(snapshotJson(descriptor.value, label + '[' + index + ']', depth + 1, nodes));
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(label + ' must contain only plain records');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key.length > 512) fail(label + ' contains an invalid key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(label + '.' + key + ' must be an enumerable data property');
    }
    out[key] = snapshotJson(descriptor.value, label + '.' + key, depth + 1, nodes);
  }
  return out;
}

function strictId(value, label, optional = false) {
  if ((value == null || value === '') && optional) return;
  if (typeof value !== 'string' || !CANONICAL_ID.test(value)) fail(label + ' must be an exact canonical text identity');
}

function exactTimestamp(value, label) {
  if (typeof value !== 'string') fail(label + ' must be an exact canonical timestamp');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(label + ' must be an exact canonical timestamp');
  }
}

function strictDenseCapabilities(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('grantedCapabilityIds must be a bounded plain array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > 128) {
    fail('grantedCapabilityIds must be a bounded plain array');
  }
  const length = lengthDescriptor.value;
  const expected = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.size || keys.some(key => typeof key !== 'string' || !expected.has(key))) {
    fail('grantedCapabilityIds must be a dense canonical array');
  }
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || typeof descriptor.value !== 'string' || !CANONICAL_ID.test(descriptor.value)) {
      fail('grantedCapabilityIds[' + index + '] must be an enumerable canonical text data property');
    }
    out.push(descriptor.value);
  }
  if (new Set(out).size !== out.length) fail('grantedCapabilityIds contains duplicates');
  return Object.freeze(out);
}

function canonicalInputs(input) {
  const envelope = snapshotRecord(input, INVOKE_KEYS, 'WordPress invocation envelope');
  const invocation = snapshotRecord(envelope.invocation, INVOCATION_KEYS, 'ToolInvocationV1');
  const policyDecision = snapshotRecord(envelope.policyDecision, POLICY_KEYS, 'PolicyDecisionV1');
  invocation.requestedCapabilityIds = snapshotJson(invocation.requestedCapabilityIds, 'requestedCapabilityIds');
  invocation.arguments = snapshotJson(invocation.arguments, 'arguments');

  if (invocation.schemaVersion !== 1) fail('ToolInvocationV1.schemaVersion must be numeric 1');
  strictId(invocation.invocationId, 'ToolInvocationV1.invocationId');
  strictId(invocation.toolId, 'ToolInvocationV1.toolId');
  strictId(invocation.providerId, 'ToolInvocationV1.providerId');
  strictId(invocation.policyDecisionId, 'ToolInvocationV1.policyDecisionId');
  strictId(invocation.parentInvocationId, 'ToolInvocationV1.parentInvocationId', true);
  exactTimestamp(invocation.createdAt, 'ToolInvocationV1.createdAt');
  if (!Array.isArray(invocation.requestedCapabilityIds) || invocation.requestedCapabilityIds.length > 128) {
    fail('ToolInvocationV1.requestedCapabilityIds must be a bounded array');
  }
  for (let index = 0; index < invocation.requestedCapabilityIds.length; index += 1) {
    strictId(invocation.requestedCapabilityIds[index], 'ToolInvocationV1.requestedCapabilityIds[' + index + ']');
  }
  if (new Set(invocation.requestedCapabilityIds).size !== invocation.requestedCapabilityIds.length) {
    fail('ToolInvocationV1.requestedCapabilityIds contains duplicates');
  }

  if (policyDecision.schemaVersion !== 1) fail('PolicyDecisionV1.schemaVersion must be numeric 1');
  strictId(policyDecision.decisionId, 'PolicyDecisionV1.decisionId');
  strictId(policyDecision.invocationId, 'PolicyDecisionV1.invocationId');
  strictId(policyDecision.reasonCode, 'PolicyDecisionV1.reasonCode');
  strictId(policyDecision.approvalId, 'PolicyDecisionV1.approvalId', true);
  if (typeof policyDecision.decision !== 'string' || !['ALLOW', 'DENY', 'REQUIRE_APPROVAL'].includes(policyDecision.decision)) {
    fail('PolicyDecisionV1.decision is invalid');
  }
  if (policyDecision.reason != null && typeof policyDecision.reason !== 'string') fail('PolicyDecisionV1.reason must be text');
  exactTimestamp(policyDecision.decidedAt, 'PolicyDecisionV1.decidedAt');
  return { invocation, policyDecision };
}

function bindDataMethod(target, method, label) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) fail(label + ' is required');
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, method);
    if (descriptor) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'function') {
        fail(label + '.' + method + ' must be a data method');
      }
      return descriptor.value.bind(target);
    }
    current = Object.getPrototypeOf(current);
  }
  fail(label + '.' + method + ' is required');
}

function methodFor(toolId) {
  if (toolId === CmsWordPressToolId.SITE_READ) return 'readSite';
  if (toolId === CmsWordPressToolId.CONTENT_SEARCH) return 'searchContent';
  if (toolId === CmsWordPressToolId.CONTENT_GET) return 'getContent';
  if (toolId === CmsWordPressToolId.MEDIA_SEARCH) return 'searchMedia';
  if (toolId === CmsWordPressToolId.MEDIA_GET) return 'getMedia';
  if (toolId === CmsWordPressToolId.TAXONOMY_SEARCH) return 'searchTaxonomy';
  return '';
}

function wrapFailure(error, invocationId) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = /^WORDPRESS_[A-Z0-9_]{1,100}$/u.test(rawCode) ? rawCode : 'WORDPRESS_PROVIDER_FAILED';
  const wrapped = new Error('WordPress read failed');
  wrapped.name = 'CmsWordPressAgentProviderError';
  wrapped.code = code;
  wrapped.invocationId = invocationId;
  wrapped.effectMayHaveOccurred = false;
  wrapped.safeToRetry = true;
  if (Number.isInteger(error?.status)) wrapped.status = error.status;
  return wrapped;
}

export class CmsWordPressAgentProviderV1 {
  constructor(config = {}) {
    const raw = snapshotRecord(
      config,
      new Set(['wordpressClient', 'grantedCapabilityIds', 'now', 'materializeUntrustedContent']),
      'WordPress provider config',
    );
    const methods = Object.values(CmsWordPressToolId).map(methodFor);
    const bound = Object.create(null);
    for (const method of methods) bound[method] = bindDataMethod(raw.wordpressClient, method, 'wordpressClient');
    this.wordpressMethods = Object.freeze(bound);
    this.grantedCapabilityIds = strictDenseCapabilities(raw.grantedCapabilityIds ?? []);
    this.materializeUntrustedContent = bindOptionalDataFunction(
      raw.materializeUntrustedContent,
      'materializeUntrustedContent',
    );
    this.now = raw.now ?? (() => Date.now());
    if (typeof this.now !== 'function') fail('now must be a function');
  }

  tools() { return TOOLS; }

  authorize(input = {}) {
    const { invocation, policyDecision } = canonicalInputs(input);
    const tool = TOOLS.find(item => item.toolId === invocation.toolId);
    if (!tool) fail('WordPress tool is not registered');
    return assertToolInvocationAuthorizedV1({
      invocation,
      policyDecision,
      toolDescriptor: tool,
      grantedCapabilityIds: this.grantedCapabilityIds,
    });
  }

  async invoke(input = {}) {
    const authorized = this.authorize(input);
    const tool = TOOLS.find(item => item.toolId === authorized.invocation.toolId);
    const method = methodFor(tool.toolId);
    try {
      const result = await this.wordpressMethods[method](authorized.invocation.arguments);
      const observed = new Date(this.now());
      if (!Number.isFinite(observed.getTime())) fail('now returned an invalid timestamp');
      const observedAt = observed.toISOString();
      const materialized = await materializeUntrustedWordPressResult({
        materialize: this.materializeUntrustedContent,
        invocation: authorized.invocation,
        result,
        observedAt,
      });
      return Object.freeze({
        providerId: CMS_WORDPRESS_PROVIDER_ID,
        invocationId: authorized.invocation.invocationId,
        observedAt,
        result: materialized.material,
        source: materialized.source,
        contentTrust: materialized.source.contentTrust,
        instructionAuthority: materialized.source.instructionAuthority,
        requiresCanonicalUntrustedContentGuardAssessment: true,
      });
    } catch (error) {
      throw wrapFailure(error, authorized.invocation.invocationId);
    }
  }
}
