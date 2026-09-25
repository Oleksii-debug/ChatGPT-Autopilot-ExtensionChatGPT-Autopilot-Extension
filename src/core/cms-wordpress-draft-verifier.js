import { VerificationStatus } from './universal-agent-contracts.js';
import { ReconciliationOutcome } from './universal-agent-exact-effect.js';
import {
  CMS_WORDPRESS_PROVIDER_ID,
  CmsWordPressToolId,
} from './cms-wordpress-agent-provider.js';
import { createSha256FingerprintV1 } from './fingerprint.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const DRAFT_SLUG = /^autopilot-[a-f0-9]{64}$/u;
const ALLOWED_ARGUMENT_KEYS = new Set(['siteOrigin', 'contentType', 'title', 'content', 'excerpt']);

function requireId(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function exactRecord(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain object');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(label + ' must be a plain object');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(label + ' contains unknown field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable data property');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function requireMutationText(value, label, max, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || (!optional && !value) || value.length > max
      || /[\u0000\u000b\u000c\u001c-\u001f\u007f]/u.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function requireOrigin(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 2048) {
    throw new Error('siteOrigin is invalid');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('siteOrigin is invalid'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
      || parsed.origin !== value
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))) {
    throw new Error('siteOrigin is invalid');
  }
  return parsed.origin;
}

function attemptFromExecutionId(value) {
  const match = /:attempt:(\d+)$/u.exec(String(value || ''));
  const attempt = match ? Number(match[1]) : 0;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 64) {
    throw new Error('executionId does not contain a valid attempt');
  }
  return attempt;
}

async function slugForInvocation(invocationId) {
  const fingerprint = await createSha256FingerprintV1(requireId(invocationId, 'invocationId'));
  const slug = 'autopilot-' + fingerprint.slice('sha256:'.length);
  if (!DRAFT_SLUG.test(slug)) throw new Error('Deterministic WordPress draft slug is invalid');
  return slug;
}

function requireInvocation(invocation) {
  if (!invocation || invocation.toolId !== CmsWordPressToolId.CONTENT_DRAFT_CREATE
      || invocation.providerId !== CMS_WORDPRESS_PROVIDER_ID) {
    throw new Error('WordPress draft verifier accepts only canonical draft-create invocations');
  }
  requireId(invocation.invocationId, 'invocationId');
  const raw = exactRecord(invocation.arguments, ALLOWED_ARGUMENT_KEYS, 'WordPress draft arguments');
  const siteOrigin = requireOrigin(raw.siteOrigin);
  if (raw.contentType !== 'posts' && raw.contentType !== 'pages') {
    throw new Error('contentType must be posts or pages');
  }
  const title = requireMutationText(raw.title, 'title', 100_000);
  const body = raw.content == null ? '' : requireMutationText(raw.content, 'content', 500_000, { optional: true });
  const excerpt = raw.excerpt == null ? '' : requireMutationText(raw.excerpt, 'excerpt', 200_000, { optional: true });
  return Object.freeze({ siteOrigin, contentType: raw.contentType, title, content: body, excerpt });
}

function exactDraftType(contentType) {
  return contentType === 'posts' ? 'post' : 'page';
}

function responseIdentity(observation) {
  const data = observation?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const id = data.id;
  const slug = data.slug;
  if (!Number.isSafeInteger(id) || id < 1 || typeof slug !== 'string' || !DRAFT_SLUG.test(slug)) return null;
  return { id, slug };
}

export class CmsWordPressDraftVerifierV1 {
  constructor({
    wordpressClient,
    verifierId = 'cms-wordpress-draft-readback-verifier',
    now = () => Date.now(),
  } = {}) {
    if (!wordpressClient
        || typeof wordpressClient.findContentBySlug !== 'function'
        || typeof wordpressClient.getContent !== 'function') {
      throw new Error('WordPress draft readback client is required');
    }
    this.wordpressClient = wordpressClient;
    this.verifierId = requireId(verifierId, 'verifierId');
    if (this.verifierId === CMS_WORDPRESS_PROVIDER_ID) {
      throw new Error('WordPress verifier identity must differ from effect provider identity');
    }
    if (typeof now !== 'function') throw new Error('now must be a function');
    this.now = now;
  }

  async #readback(invocation) {
    const expected = requireInvocation(invocation);
    const slug = await slugForInvocation(invocation.invocationId);
    const listing = await this.wordpressClient.findContentBySlug({
      siteOrigin: expected.siteOrigin,
      contentType: expected.contentType,
      slug,
    });
    if (listing?.siteOrigin !== expected.siteOrigin
        || listing?.contentType !== expected.contentType
        || listing?.slug !== slug
        || !Array.isArray(listing?.items)) {
      throw new Error('WordPress exact-slug readback envelope is invalid');
    }
    if (listing.items.length !== 1) {
      return Object.freeze({ matches: false, reason: listing.items.length === 0 ? 'NOT_FOUND' : 'NON_UNIQUE', slug, id: null });
    }
    const listed = listing.items[0];
    if (!Number.isSafeInteger(listed?.id) || listed.id < 1) {
      throw new Error('WordPress exact-slug readback identity is invalid');
    }
    const item = await this.wordpressClient.getContent({
      siteOrigin: expected.siteOrigin,
      contentType: expected.contentType,
      id: listed.id,
    });
    const matches = item?.id === listed.id
      && item?.slug === slug
      && item?.status === 'draft'
      && item?.type === exactDraftType(expected.contentType)
      && item?.titleRaw === expected.title
      && item?.contentRaw === expected.content
      && item?.excerptRaw === expected.excerpt;
    return Object.freeze({
      matches,
      reason: matches ? 'MATCHED' : 'STATE_DIVERGED',
      slug,
      id: listed.id,
      status: item?.status ?? '',
    });
  }

  async verify({ invocation, executionId, observation } = {}) {
    const readback = await this.#readback(invocation);
    const attempt = attemptFromExecutionId(executionId);
    const observedIdentity = responseIdentity(observation);
    const observationMatches = observedIdentity != null
      && observedIdentity.slug === readback.slug
      && observedIdentity.id === readback.id;
    const matches = readback.matches && observationMatches;
    return {
      schemaVersion: 1,
      verificationId: invocation.invocationId + ':wordpress-draft-verification:' + attempt,
      invocationId: invocation.invocationId,
      observationId: observation?.observationId,
      status: matches ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: matches ? 'WORDPRESS_DRAFT_READBACK_MATCHED' : 'WORDPRESS_DRAFT_READBACK_DIVERGED',
      summary: matches
        ? 'Fresh WordPress readback matched the exact invocation-bound draft.'
        : 'Fresh WordPress readback did not match the exact invocation-bound draft.',
      evidenceArtifactIds: [],
      verifiedAt: new Date(this.now()).toISOString(),
      verifierId: this.verifierId,
      verificationAuthorityId: invocation.policyDecisionId,
      effectId: invocation.invocationId,
      executionId,
      attempt,
    };
  }

  async reconcileVerify({
    invocation,
    effectId,
    executionId,
    attempt,
    policyDecisionId,
    expectedOutcome,
  } = {}) {
    if (expectedOutcome === ReconciliationOutcome.SAFE_RETRY) {
      throw new Error('WordPress draft creation never infers SAFE_RETRY after ambiguous dispatch');
    }
    if (expectedOutcome !== ReconciliationOutcome.VERIFIED) {
      throw new Error('WordPress draft reconciliation accepts only VERIFIED readback or manual review');
    }
    const readback = await this.#readback(invocation);
    const observedAt = new Date(this.now()).toISOString();
    const observation = {
      schemaVersion: 1,
      observationId: invocation.invocationId + ':wordpress-draft-readback:reconcile-' + attempt,
      invocationId: invocation.invocationId,
      status: 'OK',
      summary: 'Fresh WordPress exact-slug readback classified the intended draft.',
      data: {
        committed: readback.matches,
        contentId: readback.id,
        slug: readback.slug,
        status: readback.status ?? '',
      },
      artifactRefs: [],
      observedAt,
    };
    const verification = {
      schemaVersion: 1,
      verificationId: invocation.invocationId + ':wordpress-draft-verification:reconcile-' + attempt,
      invocationId: invocation.invocationId,
      observationId: observation.observationId,
      status: readback.matches ? VerificationStatus.VERIFIED : VerificationStatus.AMBIGUOUS,
      reasonCode: readback.matches ? 'WORDPRESS_DRAFT_COMMITTED_EFFECT_CONFIRMED' : 'WORDPRESS_DRAFT_STATE_DIVERGED',
      summary: readback.matches
        ? 'Fresh WordPress readback confirms the exact invocation-bound draft exists.'
        : 'Fresh WordPress readback does not prove the intended draft effect.',
      evidenceArtifactIds: [],
      verifiedAt: observedAt,
      verifierId: this.verifierId,
      verificationAuthorityId: policyDecisionId,
      effectId,
      executionId,
      attempt,
    };
    return {
      verifierId: this.verifierId,
      verificationAuthorityId: policyDecisionId,
      effectId,
      executionId,
      attempt,
      observation,
      verification,
    };
  }
}
