import {
  derivePrincipalGovernanceCeilingV1,
  normalizeIdentityGovernanceRegistryV1,
} from './identity-governance.js';
import { normalizeProjectSnapshotV1 } from './project-context-artifact.js';

export const SHARED_PROJECT_COLLABORATION_SCHEMA_VERSION = 1;

export const SharedProjectCollaborationKind = Object.freeze({
  COMMENT: 'COMMENT',
  HANDOFF: 'HANDOFF',
});

const KINDS = new Set(Object.values(SharedProjectCollaborationKind));
const EVENT_CAPABILITY_REQUIREMENTS = Object.freeze({
  [SharedProjectCollaborationKind.COMMENT]: Object.freeze({
    actorCapabilityId: 'project.comment',
    recipientCapabilityId: 'project.read',
  }),
  [SharedProjectCollaborationKind.HANDOFF]: Object.freeze({
    actorCapabilityId: 'project.handoff',
    recipientCapabilityId: 'project.read',
  }),
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;
const MAX_IDS = 512;
const MAX_MESSAGE = 8_000;

const BINDING_KEYS = new Set([
  'schemaVersion', 'bindingId', 'projectId', 'projectRevisionId',
  'organizationId', 'governanceRegistryId', 'governanceRegistryRevision',
  'ownerPrincipalId', 'resourceKey', 'createdAt',
]);
const ACCESS_KEYS = new Set([
  'bindingId', 'principalId', 'at',
  'requestedCapabilityIds', 'requestedProviderIds', 'requestedOutboundDataClassIds',
]);
const EVENT_KEYS = new Set([
  'schemaVersion', 'eventId', 'kind', 'bindingId', 'projectId',
  'projectRevisionId', 'actorPrincipalId', 'recipientPrincipalId',
  'taskId', 'artifactIds', 'message', 'createdAt',
]);
const EVENT_ASSESSMENT_KEYS = new Set(['event', 'at']);

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
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + String(key) + ' must be an enumerable own data property');
    }
    output[key] = descriptor.value;
  }
  return output;
}

function strictArray(input, label, max = MAX_IDS) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(label + ' must be a plain dense array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' exceeds its bounded array limit');
  }
  const length = lengthDescriptor.value;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index fields');
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index)
        || index < 0
        || index >= length
        || !descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' contains invalid array descriptors');
    }
  }
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' must not be sparse');
    }
    output.push(descriptor.value);
  }
  return output;
}

function version(value, label) {
  if (value !== SHARED_PROJECT_COLLABORATION_SCHEMA_VERSION) {
    throw new Error('Unsupported ' + label + ' schemaVersion');
  }
  return SHARED_PROJECT_COLLABORATION_SCHEMA_VERSION;
}

function id(value, label, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function integer(value, label, { min = 1, max = 1_000_000_000 } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function exactText(value, label, max) {
  if (typeof value !== 'string'
      || value !== value.trim()
      || !value
      || value.length > max) {
    throw new Error(label + ' must be bounded canonical text');
  }
  return value;
}

function idList(input, label, { max = MAX_IDS } = {}) {
  const values = strictArray(input, label, max)
    .map((value, index) => id(value, label + '[' + index + ']'));
  if (new Set(values).size !== values.length) {
    throw new Error(label + ' contains duplicate IDs');
  }
  values.sort(asciiCompare);
  return Object.freeze(values);
}

function missingFrom(requested, ceiling) {
  const allowed = new Set(ceiling);
  return requested.filter(value => !allowed.has(value));
}

function projectResourceKey(projectId) {
  return id('project:' + projectId, 'project resourceKey');
}

function bindTrustedMethod(resolver, methodName) {
  if (!resolver || (typeof resolver !== 'object' && typeof resolver !== 'function')) {
    throw new Error('Trusted shared-project resolver is required');
  }
  let owner = resolver;
  let descriptor = null;
  for (let depth = 0; owner && depth < 8; depth += 1) {
    descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
    if (descriptor) break;
    owner = Object.getPrototypeOf(owner);
  }
  if (!descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || typeof descriptor.value !== 'function') {
    throw new Error('Trusted resolver must expose ' + methodName + ' as a data method');
  }
  return descriptor.value.bind(resolver);
}

export function normalizeSharedProjectBindingV1(input) {
  const raw = strictRecord(input, BINDING_KEYS, 'SharedProjectBindingV1');
  const projectId = id(raw.projectId, 'projectId');
  const resourceKey = id(raw.resourceKey, 'resourceKey');
  const expectedResourceKey = projectResourceKey(projectId);
  if (resourceKey !== expectedResourceKey) {
    throw new Error('resourceKey must exactly bind the shared project');
  }
  return freezeDeep({
    schemaVersion: version(raw.schemaVersion, 'SharedProjectBindingV1'),
    bindingId: id(raw.bindingId, 'bindingId'),
    projectId,
    projectRevisionId: id(raw.projectRevisionId, 'projectRevisionId'),
    organizationId: id(raw.organizationId, 'organizationId'),
    governanceRegistryId: id(raw.governanceRegistryId, 'governanceRegistryId'),
    governanceRegistryRevision: integer(raw.governanceRegistryRevision, 'governanceRegistryRevision'),
    ownerPrincipalId: id(raw.ownerPrincipalId, 'ownerPrincipalId'),
    resourceKey,
    createdAt: timestamp(raw.createdAt, 'createdAt'),
  });
}

function assertBindingAgainstCanonicalSources(binding, snapshot, registry) {
  if (snapshot.projectId !== binding.projectId
      || snapshot.revisionId !== binding.projectRevisionId) {
    throw new Error('Shared project binding does not match trusted project snapshot');
  }
  if (registry.organizationId !== binding.organizationId
      || registry.registryId !== binding.governanceRegistryId
      || registry.revision !== binding.governanceRegistryRevision) {
    throw new Error('Shared project binding does not match trusted identity governance registry');
  }
  if (Date.parse(binding.createdAt) < Date.parse(snapshot.createdAt)) {
    throw new Error('Shared project binding cannot predate trusted project snapshot');
  }
  if (Date.parse(binding.createdAt) > Date.parse(registry.updatedAt)) {
    throw new Error('Shared project binding cannot postdate governance registry evidence');
  }

  const owner = registry.principals.find(item => item.principalId === binding.ownerPrincipalId);
  if (!owner) throw new Error('Shared project ownerPrincipalId is not present in governance registry');

  const ownerCeiling = derivePrincipalGovernanceCeilingV1({
    registry,
    principalId: binding.ownerPrincipalId,
    resourceKey: binding.resourceKey,
    at: binding.createdAt,
  });
  if (!ownerCeiling.active || ownerCeiling.effectiveGrantIds.length === 0) {
    throw new Error('Shared project owner lacks an active project governance grant');
  }
}

async function resolveTrustedContext(bindingIdInput, trustedResolver) {
  const bindingId = id(bindingIdInput, 'bindingId');
  const resolveSharedProjectBinding = bindTrustedMethod(
    trustedResolver,
    'resolveSharedProjectBinding',
  );
  const resolveProjectSnapshot = bindTrustedMethod(
    trustedResolver,
    'resolveProjectSnapshot',
  );
  const resolveIdentityGovernanceRegistry = bindTrustedMethod(
    trustedResolver,
    'resolveIdentityGovernanceRegistry',
  );

  const bindingRaw = await resolveSharedProjectBinding(bindingId);
  if (bindingRaw == null) throw new Error('Trusted shared-project binding was not found');
  const binding = normalizeSharedProjectBindingV1(bindingRaw);
  if (binding.bindingId !== bindingId) {
    throw new Error('Trusted shared-project binding identity mismatch');
  }

  const snapshotRaw = await resolveProjectSnapshot({
    projectId: binding.projectId,
    projectRevisionId: binding.projectRevisionId,
  });
  if (snapshotRaw == null) throw new Error('Trusted project snapshot was not found');
  const snapshot = normalizeProjectSnapshotV1(snapshotRaw);

  const registryRaw = await resolveIdentityGovernanceRegistry({
    governanceRegistryId: binding.governanceRegistryId,
    governanceRegistryRevision: binding.governanceRegistryRevision,
    organizationId: binding.organizationId,
  });
  if (registryRaw == null) throw new Error('Trusted identity governance registry was not found');
  const registry = normalizeIdentityGovernanceRegistryV1(registryRaw);

  assertBindingAgainstCanonicalSources(binding, snapshot, registry);
  return freezeDeep({ binding, snapshot, registry });
}

function normalizeAccessRequest(input) {
  const raw = strictRecord(input, ACCESS_KEYS, 'SharedProjectAccessRequestV1');
  return {
    bindingId: id(raw.bindingId, 'bindingId'),
    principalId: id(raw.principalId, 'principalId'),
    at: timestamp(raw.at, 'at'),
    requestedCapabilityIds: idList(raw.requestedCapabilityIds, 'requestedCapabilityIds'),
    requestedProviderIds: idList(raw.requestedProviderIds, 'requestedProviderIds'),
    requestedOutboundDataClassIds: idList(
      raw.requestedOutboundDataClassIds,
      'requestedOutboundDataClassIds',
    ),
  };
}

function assessResolvedAccess(context, request) {
  const { binding, registry } = context;
  const {
    principalId,
    at,
    requestedCapabilityIds,
    requestedProviderIds,
    requestedOutboundDataClassIds,
  } = request;

  if (Date.parse(at) < Date.parse(binding.createdAt)) {
    throw new Error('Shared project access assessment cannot predate binding');
  }

  const ceiling = derivePrincipalGovernanceCeilingV1({
    registry,
    principalId,
    resourceKey: binding.resourceKey,
    at,
  });
  const ownerCeiling = derivePrincipalGovernanceCeilingV1({
    registry,
    principalId: binding.ownerPrincipalId,
    resourceKey: binding.resourceKey,
    at,
  });
  const projectOwnerCurrentlyBound = ownerCeiling.active
    && ownerCeiling.effectiveGrantIds.length > 0;

  const missingCapabilityIds = missingFrom(requestedCapabilityIds, ceiling.capabilityCeilingIds);
  const missingProviderIds = missingFrom(requestedProviderIds, ceiling.providerCeilingIds);
  const missingOutboundDataClassIds = missingFrom(
    requestedOutboundDataClassIds,
    ceiling.outboundDataClassIds,
  );

  let reasonCode = 'ELIGIBLE_FOR_CANONICAL_POLICY';
  if (!projectOwnerCurrentlyBound) reasonCode = 'PROJECT_OWNER_INACTIVE_OR_UNBOUND';
  else if (!ceiling.active) reasonCode = ceiling.reasonCode;
  else if (ceiling.effectiveGrantIds.length === 0) reasonCode = 'NO_PROJECT_GRANT';
  else if (missingCapabilityIds.length) reasonCode = 'CAPABILITY_OUTSIDE_CEILING';
  else if (missingProviderIds.length) reasonCode = 'PROVIDER_OUTSIDE_CEILING';
  else if (missingOutboundDataClassIds.length) reasonCode = 'OUTBOUND_DATA_CLASS_OUTSIDE_CEILING';

  const collaborationEligible = reasonCode === 'ELIGIBLE_FOR_CANONICAL_POLICY';

  return freezeDeep({
    schemaVersion: SHARED_PROJECT_COLLABORATION_SCHEMA_VERSION,
    bindingId: binding.bindingId,
    projectId: binding.projectId,
    projectRevisionId: binding.projectRevisionId,
    organizationId: binding.organizationId,
    governanceRegistryId: binding.governanceRegistryId,
    governanceRegistryRevision: binding.governanceRegistryRevision,
    principalId,
    resourceKey: binding.resourceKey,
    evaluatedAt: at,
    active: ceiling.active,
    projectOwnerCurrentlyBound,
    collaborationEligible,
    reasonCode,
    effectiveRoleIds: Object.freeze([...ceiling.effectiveRoleIds]),
    effectiveGrantIds: Object.freeze([...ceiling.effectiveGrantIds]),
    capabilityCeilingIds: Object.freeze([...ceiling.capabilityCeilingIds]),
    providerCeilingIds: Object.freeze([...ceiling.providerCeilingIds]),
    outboundDataClassIds: Object.freeze([...ceiling.outboundDataClassIds]),
    requestedCapabilityIds,
    requestedProviderIds,
    requestedOutboundDataClassIds,
    missingCapabilityIds: Object.freeze(missingCapabilityIds),
    missingProviderIds: Object.freeze(missingProviderIds),
    missingOutboundDataClassIds: Object.freeze(missingOutboundDataClassIds),
    ownedCredentialBindingIds: Object.freeze(
      ceiling.ownedCredentialBindings.map(item => item.bindingId).sort(asciiCompare),
    ),
    canonicalSourcesResolved: true,
    advisoryOnly: true,
    authorizationGranted: false,
    executionAuthorized: false,
    mutationAuthorized: false,
    credentialUseAuthorized: false,
    requiresCanonicalPolicyDecision: true,
  });
}

export async function assessSharedProjectAccessV1(input, trustedResolver) {
  const request = normalizeAccessRequest(input);
  const context = await resolveTrustedContext(request.bindingId, trustedResolver);
  return assessResolvedAccess(context, request);
}

export function normalizeSharedProjectCollaborationEventV1(input) {
  const raw = strictRecord(input, EVENT_KEYS, 'SharedProjectCollaborationEventV1');
  const kind = id(raw.kind, 'kind');
  if (!KINDS.has(kind)) throw new Error('Shared project collaboration kind is invalid');
  const recipientPrincipalId = id(
    raw.recipientPrincipalId,
    'recipientPrincipalId',
    { optional: true },
  );
  if (kind === SharedProjectCollaborationKind.HANDOFF && !recipientPrincipalId) {
    throw new Error('HANDOFF requires recipientPrincipalId');
  }
  const actorPrincipalId = id(raw.actorPrincipalId, 'actorPrincipalId');
  if (recipientPrincipalId && recipientPrincipalId === actorPrincipalId) {
    throw new Error('recipientPrincipalId must differ from actorPrincipalId');
  }

  return freezeDeep({
    schemaVersion: version(raw.schemaVersion, 'SharedProjectCollaborationEventV1'),
    eventId: id(raw.eventId, 'eventId'),
    kind,
    bindingId: id(raw.bindingId, 'bindingId'),
    projectId: id(raw.projectId, 'projectId'),
    projectRevisionId: id(raw.projectRevisionId, 'projectRevisionId'),
    actorPrincipalId,
    recipientPrincipalId,
    taskId: id(raw.taskId, 'taskId', { optional: true }),
    artifactIds: idList(raw.artifactIds, 'artifactIds'),
    message: exactText(raw.message, 'message', MAX_MESSAGE),
    createdAt: timestamp(raw.createdAt, 'createdAt'),
  });
}

function eventResolvedRequest(principalId, at, capabilityId) {
  return {
    principalId,
    at,
    requestedCapabilityIds: Object.freeze([capabilityId]),
    requestedProviderIds: Object.freeze([]),
    requestedOutboundDataClassIds: Object.freeze([]),
  };
}

export async function assessSharedProjectCollaborationEventV1(input, trustedResolver) {
  const raw = strictRecord(
    input,
    EVENT_ASSESSMENT_KEYS,
    'SharedProjectCollaborationEventAssessmentV1',
  );
  const event = normalizeSharedProjectCollaborationEventV1(raw.event);
  const at = timestamp(raw.at, 'at');
  const context = await resolveTrustedContext(event.bindingId, trustedResolver);
  const { binding, snapshot } = context;

  if (event.projectId !== binding.projectId
      || event.projectRevisionId !== binding.projectRevisionId) {
    throw new Error('Collaboration event does not match trusted shared project binding');
  }
  if (event.createdAt !== at) {
    throw new Error('Collaboration event createdAt must equal admission assessment time');
  }
  if (Date.parse(at) < Date.parse(binding.createdAt)) {
    throw new Error('Collaboration event cannot predate shared project binding');
  }

  const knownArtifacts = new Set(snapshot.artifactRefs.map(item => item.artifactId));
  for (const artifactId of event.artifactIds) {
    if (!knownArtifacts.has(artifactId)) {
      throw new Error('Collaboration event references artifact outside trusted project snapshot: ' + artifactId);
    }
  }

  const requirements = EVENT_CAPABILITY_REQUIREMENTS[event.kind];
  const actor = assessResolvedAccess(
    context,
    eventResolvedRequest(event.actorPrincipalId, at, requirements.actorCapabilityId),
  );
  const recipient = event.recipientPrincipalId
    ? assessResolvedAccess(
      context,
      eventResolvedRequest(
        event.recipientPrincipalId,
        at,
        requirements.recipientCapabilityId,
      ),
    )
    : null;

  const eventAdmissibleForCollaboration = actor.collaborationEligible
    && (!recipient || recipient.collaborationEligible);

  let reasonCode = 'ELIGIBLE_FOR_CANONICAL_AUDIT_APPEND';
  if (!actor.collaborationEligible) reasonCode = 'ACTOR_' + actor.reasonCode;
  else if (recipient && !recipient.collaborationEligible) {
    reasonCode = 'RECIPIENT_' + recipient.reasonCode;
  }

  return freezeDeep({
    schemaVersion: SHARED_PROJECT_COLLABORATION_SCHEMA_VERSION,
    event,
    organizationId: binding.organizationId,
    governanceRegistryId: binding.governanceRegistryId,
    governanceRegistryRevision: binding.governanceRegistryRevision,
    actorRequiredCapabilityId: requirements.actorCapabilityId,
    recipientRequiredCapabilityId: recipient ? requirements.recipientCapabilityId : '',
    actorAccessReasonCode: actor.reasonCode,
    recipientAccessReasonCode: recipient ? recipient.reasonCode : '',
    eventAdmissibleForCollaboration,
    reasonCode,
    canonicalSourcesResolved: true,
    contentTrust: 'UNTRUSTED_DATA',
    advisoryOnly: true,
    auditAppendAuthorized: false,
    commentPublishAuthorized: false,
    handoffAuthorized: false,
    executionAuthorized: false,
    mutationAuthorized: false,
    credentialUseAuthorized: false,
    requiresCanonicalPolicyDecision: true,
    requiresCanonicalAuditAppend: true,
  });
}
