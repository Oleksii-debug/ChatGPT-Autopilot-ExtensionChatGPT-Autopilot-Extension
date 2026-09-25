import { normalizeProjectSnapshotV1 } from './project-context-artifact.js';
import {
  derivePrincipalGovernanceCeilingV1,
  normalizeIdentityGovernanceRegistryV1,
} from './identity-governance.js';

export const SHARED_PROJECT_GOVERNANCE_SCHEMA_VERSION = 1;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_MEMBERSHIPS = 2_000;
const MAX_AUDIT_EVENTS = 20_000;
const MAX_TEXT = 2_000;

const REQUEST_KEYS = new Set([
  'projectSnapshot',
  'identityRegistry',
  'memberships',
  'auditEvents',
  'evaluatedAt',
]);
const MEMBERSHIP_KEYS = new Set([
  'membershipId',
  'projectId',
  'principalId',
  'invitedByPrincipalId',
  'joinedAt',
  'leftAt',
]);
const AUDIT_KEYS = new Set([
  'eventId',
  'projectId',
  'principalId',
  'actorPrincipalId',
  'eventType',
  'subjectId',
  'occurredAt',
]);

function asciiCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function strictRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label} contains unknown field: ${String(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must contain enumerable data properties only`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function strictArray(input, label, max) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || Object.is(lengthDescriptor.value, -0)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(`${label} must be a bounded plain array`);
  }
  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(`${label} contains non-index data`);
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || String(index) !== key
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} contains invalid indexed data`);
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must be dense data-only array`);
    }
    out[index] = descriptor.value;
  }
  return out;
}

function exactId(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(`${label} must use exact canonical identity representation`);
  }
  return value;
}

function canonicalTimestamp(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function boundedText(value, label) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > MAX_TEXT) {
    throw new Error(`${label} must be bounded canonical text`);
  }
  return value;
}

function uniqueBy(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item[key])) throw new Error(`${label} contains duplicate ${key}: ${item[key]}`);
    seen.add(item[key]);
  }
}

function normalizeMembership(input, index, projectId, registryUpdatedAt) {
  const label = `memberships[${index}]`;
  const raw = strictRecord(input, MEMBERSHIP_KEYS, label);
  const membershipId = exactId(raw.membershipId, `${label}.membershipId`);
  const boundProjectId = exactId(raw.projectId, `${label}.projectId`);
  if (boundProjectId !== projectId) throw new Error(`${label}.projectId does not match ProjectSnapshotV1`);
  const principalId = exactId(raw.principalId, `${label}.principalId`);
  const invitedByPrincipalId = exactId(raw.invitedByPrincipalId, `${label}.invitedByPrincipalId`);
  const joinedAt = canonicalTimestamp(raw.joinedAt, `${label}.joinedAt`);
  const leftAt = canonicalTimestamp(raw.leftAt, `${label}.leftAt`, { optional: true });
  if (leftAt && Date.parse(leftAt) <= Date.parse(joinedAt)) {
    throw new Error(`${label}.leftAt must be after joinedAt`);
  }
  if (Date.parse(joinedAt) > Date.parse(registryUpdatedAt)
      || (leftAt && Date.parse(leftAt) > Date.parse(registryUpdatedAt))) {
    throw new Error(`${label} cannot contain membership history newer than identity registry`);
  }
  return freezeDeep({
    membershipId,
    projectId: boundProjectId,
    principalId,
    invitedByPrincipalId,
    joinedAt,
    leftAt,
  });
}

function normalizeAuditEvent(input, index, projectId, registryUpdatedAt) {
  const label = `auditEvents[${index}]`;
  const raw = strictRecord(input, AUDIT_KEYS, label);
  const boundProjectId = exactId(raw.projectId, `${label}.projectId`);
  if (boundProjectId !== projectId) throw new Error(`${label}.projectId does not match ProjectSnapshotV1`);
  const occurredAt = canonicalTimestamp(raw.occurredAt, `${label}.occurredAt`);
  if (Date.parse(occurredAt) > Date.parse(registryUpdatedAt)) {
    throw new Error(`${label}.occurredAt cannot be newer than identity registry`);
  }
  return freezeDeep({
    eventId: exactId(raw.eventId, `${label}.eventId`),
    projectId: boundProjectId,
    principalId: exactId(raw.principalId, `${label}.principalId`, { optional: true }),
    actorPrincipalId: exactId(raw.actorPrincipalId, `${label}.actorPrincipalId`),
    eventType: boundedText(raw.eventType, `${label}.eventType`),
    subjectId: exactId(raw.subjectId, `${label}.subjectId`, { optional: true }),
    occurredAt,
  });
}

function activeAt(membership, atMillis) {
  return atMillis >= Date.parse(membership.joinedAt)
    && (!membership.leftAt || atMillis < Date.parse(membership.leftAt));
}

function principalActiveAt(principal, atMillis) {
  if (atMillis < Date.parse(principal.createdAt)) return false;
  return !principal.revokedAt || atMillis < Date.parse(principal.revokedAt);
}

function auditCompare(a, b) {
  return Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    || asciiCompare(a.eventId, b.eventId);
}

/**
 * Builds a read-only shared/team Project governance projection.
 *
 * This module does not create or replace owner policy. Membership only establishes
 * collaboration scope. Effective roles/capability/provider/data ceilings are
 * delegated to the canonical IdentityGovernanceRegistryV1 for resource
 * `project:<projectId>`. The result never authorizes an action or credential use.
 */
export function buildSharedProjectGovernanceV1(input = {}) {
  const request = strictRecord(input, REQUEST_KEYS, 'SharedProjectGovernanceRequestV1');
  const project = normalizeProjectSnapshotV1(request.projectSnapshot);
  const registry = normalizeIdentityGovernanceRegistryV1(request.identityRegistry);
  const evaluatedAt = canonicalTimestamp(request.evaluatedAt, 'evaluatedAt');
  const evaluatedAtMillis = Date.parse(evaluatedAt);

  if (evaluatedAtMillis < Date.parse(project.createdAt)) {
    throw new Error('evaluatedAt cannot predate ProjectSnapshotV1');
  }
  if (evaluatedAtMillis > Date.parse(registry.updatedAt)) {
    throw new Error('evaluatedAt cannot be later than identity registry updatedAt');
  }

  const memberships = strictArray(
    request.memberships,
    'memberships',
    MAX_MEMBERSHIPS,
  ).map((item, index) => normalizeMembership(item, index, project.projectId, registry.updatedAt));
  uniqueBy(memberships, 'membershipId', 'memberships');
  const activeMembershipPrincipals = new Set();
  for (const membership of memberships) {
    if (activeAt(membership, evaluatedAtMillis)) {
      if (activeMembershipPrincipals.has(membership.principalId)) {
        throw new Error(`multiple active memberships for principalId: ${membership.principalId}`);
      }
      activeMembershipPrincipals.add(membership.principalId);
    }
  }

  const principalById = new Map(registry.principals.map((principal) => [principal.principalId, principal]));
  for (const membership of memberships) {
    const principal = principalById.get(membership.principalId);
    const inviter = principalById.get(membership.invitedByPrincipalId);
    if (!principal) throw new Error(`membership references unknown principalId: ${membership.principalId}`);
    if (!inviter) throw new Error(`membership references unknown invitedByPrincipalId: ${membership.invitedByPrincipalId}`);
    if (Date.parse(membership.joinedAt) < Date.parse(principal.createdAt)) {
      throw new Error(`membership predates principal creation: ${membership.principalId}`);
    }
    if (!principalActiveAt(inviter, Date.parse(membership.joinedAt))) {
      throw new Error(`inviting principal was inactive at membership creation: ${membership.invitedByPrincipalId}`);
    }
  }

  const auditEvents = strictArray(
    request.auditEvents,
    'auditEvents',
    MAX_AUDIT_EVENTS,
  ).map((item, index) => normalizeAuditEvent(item, index, project.projectId, registry.updatedAt));
  uniqueBy(auditEvents, 'eventId', 'auditEvents');

  for (const event of auditEvents) {
    if (!principalById.has(event.actorPrincipalId)) {
      throw new Error(`audit event references unknown actorPrincipalId: ${event.actorPrincipalId}`);
    }
    if (event.principalId && !principalById.has(event.principalId)) {
      throw new Error(`audit event references unknown principalId: ${event.principalId}`);
    }
    const actor = principalById.get(event.actorPrincipalId);
    if (!principalActiveAt(actor, Date.parse(event.occurredAt))) {
      throw new Error(`audit actor was inactive at event time: ${event.actorPrincipalId}`);
    }
  }

  const resourceKey = `project:${project.projectId}`;
  const participants = memberships
    .filter((membership) => activeAt(membership, evaluatedAtMillis))
    .map((membership) => {
      const ceiling = derivePrincipalGovernanceCeilingV1({
        registry,
        principalId: membership.principalId,
        resourceKey,
        at: evaluatedAt,
      });
      return freezeDeep({
        membershipId: membership.membershipId,
        principalId: membership.principalId,
        principalKind: principalById.get(membership.principalId).kind,
        joinedAt: membership.joinedAt,
        invitedByPrincipalId: membership.invitedByPrincipalId,
        identityActive: ceiling.active,
        effectiveRoleIds: ceiling.active ? [...ceiling.effectiveRoleIds] : [],
        effectiveGrantIds: ceiling.active ? [...ceiling.effectiveGrantIds] : [],
        capabilityCeilingIds: ceiling.active ? [...ceiling.capabilityCeilingIds] : [],
        providerCeilingIds: ceiling.active ? [...ceiling.providerCeilingIds] : [],
        outboundDataClassIds: ceiling.active ? [...ceiling.outboundDataClassIds] : [],
        requiresPolicyDecision: true,
        policyDecision: 'NONE',
        authorizationGranted: false,
        credentialUseAuthorized: false,
      });
    })
    .sort((a, b) => asciiCompare(a.principalId, b.principalId));

  const visibleAuditEvents = auditEvents
    .filter((event) => Date.parse(event.occurredAt) <= evaluatedAtMillis)
    .sort(auditCompare);

  return freezeDeep({
    schemaVersion: SHARED_PROJECT_GOVERNANCE_SCHEMA_VERSION,
    projectId: project.projectId,
    projectRevisionId: project.revisionId,
    projectTitle: project.title,
    organizationId: registry.organizationId,
    identityRegistryId: registry.registryId,
    identityRegistryRevision: registry.revision,
    resourceKey,
    evaluatedAt,
    participants,
    auditEvents: visibleAuditEvents,
    requiresPolicyDecision: true,
    policyDecision: 'NONE',
    authorizationGranted: false,
    credentialUseAuthorized: false,
  });
}
