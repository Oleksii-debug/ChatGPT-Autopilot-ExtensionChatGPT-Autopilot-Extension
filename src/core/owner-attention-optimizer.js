import {
  ActionCenterItemStatus,
  ActionCenterSeverity,
  normalizeActionCenterItemV1,
} from './action-center-contract.js';

export const OWNER_ATTENTION_OPTIMIZER_SCHEMA_VERSION = 1;

export const OwnerAttentionDisposition = Object.freeze({
  ESCALATE_NOW: 'ESCALATE_NOW',
  GATHER_EVIDENCE_FIRST: 'GATHER_EVIDENCE_FIRST',
  BATCH: 'BATCH',
  DEFER_WHILE_CONTINUING: 'DEFER_WHILE_CONTINUING',
});

export const OwnerAttentionWrongDecisionConsequence = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

export const OwnerAttentionReversibility = Object.freeze({
  REVERSIBLE: 'REVERSIBLE',
  COMPENSABLE: 'COMPENSABLE',
  IRREVERSIBLE: 'IRREVERSIBLE',
});

export const OwnerAttentionDelayCost = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

export const OwnerAttentionUncertainty = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
});

const MAX_ITEMS = 256;
const MAX_BATCH_SIZE = 32;
const MAX_NEAR_DEADLINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,179}$/u;

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'evaluatedAt',
  'nearDeadlineWindowMs',
  'items',
]);

const ITEM_KEYS = new Set([
  'attentionItem',
  'wrongDecisionConsequence',
  'reversibility',
  'delayCost',
  'uncertainty',
  'canonicalEvidenceAvailable',
  'safeEvidenceGatheringAvailable',
  'canContinueAround',
  'batchKey',
  'decisionDeadlineAt',
]);

const CONSEQUENCES = new Set(Object.values(OwnerAttentionWrongDecisionConsequence));
const REVERSIBILITIES = new Set(Object.values(OwnerAttentionReversibility));
const DELAY_COSTS = new Set(Object.values(OwnerAttentionDelayCost));
const UNCERTAINTIES = new Set(Object.values(OwnerAttentionUncertainty));

const DISPOSITION_RANK = Object.freeze({
  [OwnerAttentionDisposition.ESCALATE_NOW]: 0,
  [OwnerAttentionDisposition.GATHER_EVIDENCE_FIRST]: 1,
  [OwnerAttentionDisposition.BATCH]: 2,
  [OwnerAttentionDisposition.DEFER_WHILE_CONTINUING]: 3,
});

const SEVERITY_RANK = Object.freeze({
  [ActionCenterSeverity.BLOCKING]: 0,
  [ActionCenterSeverity.HIGH]: 1,
  [ActionCenterSeverity.NORMAL]: 2,
  [ActionCenterSeverity.LOW]: 3,
});

function asciiCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function strictRecord(input, allowed, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(label + ' must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain or null-prototype object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(label + ' contains unknown field: ' + String(key));
    }
    const descriptor = descriptors[key];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + ' fields must be enumerable own data properties');
    }
    out[key] = descriptor.value;
  }
  return out;
}

function requireKeys(raw, required, label) {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(label + '.' + key + ' is required');
    }
  }
}

function strictArray(input, label, max = MAX_ITEMS) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error(label + ' must be a canonical array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) {
    throw new Error(label + ' must be a bounded canonical array');
  }
  const expected = new Set(['length']);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expected.has(key)) {
      throw new Error(label + ' contains non-canonical array fields');
    }
  }
  const out = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '[' + index + '] must be an enumerable own data property');
    }
    out[index] = descriptor.value;
  }
  return out;
}

function canonicalTimestamp(value, label, { optional = false } = {}) {
  if (optional && (value === '' || value === null || value === undefined)) return '';
  if (typeof value !== 'string' || value !== value.trim() || !value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical ISO timestamp');
  }
  return value;
}

function canonicalId(value, label, { optional = false } = {}) {
  if (optional && (value === '' || value === null || value === undefined)) return '';
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) {
    throw new Error(label + ' must be a canonical string identity');
  }
  return value;
}

function enumValue(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(label + ' is invalid');
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function boundedInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value)
      || Object.is(value, -0)
      || value < min
      || value > max) {
    throw new Error(label + ' must be an exact integer in ' + min + '..' + max);
  }
  return value;
}

function deadlineState(deadlineAt, evaluatedAt, nearDeadlineWindowMs) {
  if (!deadlineAt) return 'NONE';
  const deadlineMs = Date.parse(deadlineAt);
  const evaluatedMs = Date.parse(evaluatedAt);
  if (deadlineMs <= evaluatedMs) return 'REACHED';
  if (deadlineMs - evaluatedMs <= nearDeadlineWindowMs) return 'NEAR';
  return 'LATER';
}

function normalizeCandidate(input, index, evaluatedAt, nearDeadlineWindowMs) {
  const label = 'items[' + index + ']';
  const raw = strictRecord(input, ITEM_KEYS, label);
  requireKeys(raw, ITEM_KEYS, label);

  const attentionItem = normalizeActionCenterItemV1(raw.attentionItem);
  if (attentionItem.status !== ActionCenterItemStatus.OPEN) {
    throw new Error(label + '.attentionItem must be OPEN');
  }
  if (Date.parse(attentionItem.createdAt) > Date.parse(evaluatedAt)
      || Date.parse(attentionItem.updatedAt) > Date.parse(evaluatedAt)) {
    throw new Error(label + '.attentionItem is observed after evaluatedAt');
  }

  const decisionDeadlineAt = canonicalTimestamp(
    raw.decisionDeadlineAt,
    label + '.decisionDeadlineAt',
    { optional: true },
  );
  if (decisionDeadlineAt
      && Date.parse(decisionDeadlineAt) < Date.parse(attentionItem.createdAt)) {
    throw new Error(label + '.decisionDeadlineAt cannot predate attention item creation');
  }

  return deepFreeze({
    attentionItem,
    wrongDecisionConsequence: enumValue(
      raw.wrongDecisionConsequence,
      CONSEQUENCES,
      label + '.wrongDecisionConsequence',
    ),
    reversibility: enumValue(raw.reversibility, REVERSIBILITIES, label + '.reversibility'),
    delayCost: enumValue(raw.delayCost, DELAY_COSTS, label + '.delayCost'),
    uncertainty: enumValue(raw.uncertainty, UNCERTAINTIES, label + '.uncertainty'),
    canonicalEvidenceAvailable: bool(
      raw.canonicalEvidenceAvailable,
      label + '.canonicalEvidenceAvailable',
    ),
    safeEvidenceGatheringAvailable: bool(
      raw.safeEvidenceGatheringAvailable,
      label + '.safeEvidenceGatheringAvailable',
    ),
    canContinueAround: bool(raw.canContinueAround, label + '.canContinueAround'),
    batchKey: canonicalId(raw.batchKey, label + '.batchKey', { optional: true }),
    decisionDeadlineAt,
    deadlineState: deadlineState(decisionDeadlineAt, evaluatedAt, nearDeadlineWindowMs),
  });
}

function initialDisposition(candidate) {
  const item = candidate.attentionItem;

  if (item.severity === ActionCenterSeverity.BLOCKING) {
    return { disposition: OwnerAttentionDisposition.ESCALATE_NOW, reasonCode: 'ACTION_CENTER_BLOCKING' };
  }
  if (candidate.deadlineState === 'REACHED') {
    return { disposition: OwnerAttentionDisposition.ESCALATE_NOW, reasonCode: 'DECISION_DEADLINE_REACHED' };
  }
  if (candidate.deadlineState === 'NEAR') {
    return { disposition: OwnerAttentionDisposition.ESCALATE_NOW, reasonCode: 'DECISION_DEADLINE_NEAR' };
  }

  if (!candidate.canonicalEvidenceAvailable) {
    if (candidate.safeEvidenceGatheringAvailable) {
      return {
        disposition: OwnerAttentionDisposition.GATHER_EVIDENCE_FIRST,
        reasonCode: 'SAFE_CANONICAL_EVIDENCE_PATH_AVAILABLE',
      };
    }
    return {
      disposition: OwnerAttentionDisposition.ESCALATE_NOW,
      reasonCode: 'CANONICAL_EVIDENCE_MISSING',
    };
  }

  if (item.severity === ActionCenterSeverity.HIGH) {
    return { disposition: OwnerAttentionDisposition.ESCALATE_NOW, reasonCode: 'HIGH_SEVERITY_ATTENTION' };
  }
  if (candidate.wrongDecisionConsequence === OwnerAttentionWrongDecisionConsequence.CRITICAL) {
    return { disposition: OwnerAttentionDisposition.ESCALATE_NOW, reasonCode: 'WRONG_DECISION_CONSEQUENCE_CRITICAL' };
  }
  if (candidate.reversibility === OwnerAttentionReversibility.IRREVERSIBLE) {
    return { disposition: OwnerAttentionDisposition.ESCALATE_NOW, reasonCode: 'IRREVERSIBLE_DECISION' };
  }
  if (candidate.delayCost === OwnerAttentionDelayCost.CRITICAL
      || candidate.delayCost === OwnerAttentionDelayCost.HIGH) {
    return { disposition: OwnerAttentionDisposition.ESCALATE_NOW, reasonCode: 'MATERIAL_DELAY_COST' };
  }

  if (candidate.batchKey) {
    return { disposition: 'BATCH_ELIGIBLE', reasonCode: 'RELATED_DECISION_BATCH_CANDIDATE' };
  }

  if (candidate.canContinueAround
      && candidate.delayCost !== OwnerAttentionDelayCost.HIGH
      && candidate.delayCost !== OwnerAttentionDelayCost.CRITICAL) {
    return {
      disposition: OwnerAttentionDisposition.DEFER_WHILE_CONTINUING,
      reasonCode: 'SAFE_CONTINUE_AROUND_AVAILABLE',
    };
  }

  return {
    disposition: OwnerAttentionDisposition.ESCALATE_NOW,
    reasonCode: 'OWNER_ACTION_REQUIRED_NO_SAFE_DELAY_PATH',
  };
}

function singletonBatchFallback(candidate) {
  if (candidate.canContinueAround) {
    return {
      disposition: OwnerAttentionDisposition.DEFER_WHILE_CONTINUING,
      reasonCode: 'BATCH_PEER_NOT_AVAILABLE_CONTINUE_AROUND',
    };
  }
  return {
    disposition: OwnerAttentionDisposition.ESCALATE_NOW,
    reasonCode: 'BATCH_PEER_NOT_AVAILABLE_OWNER_ACTION_REQUIRED',
  };
}

function chunkBatchCandidates(candidates) {
  const chunks = [];
  let cursor = 0;
  while (candidates.length - cursor > MAX_BATCH_SIZE) {
    const remaining = candidates.length - cursor;
    const size = remaining - MAX_BATCH_SIZE === 1 ? MAX_BATCH_SIZE - 1 : MAX_BATCH_SIZE;
    chunks.push(candidates.slice(cursor, cursor + size));
    cursor += size;
  }
  const remainder = candidates.slice(cursor);
  if (remainder.length >= 2) chunks.push(remainder);
  return chunks;
}

function evidenceUnion(candidates) {
  return [...new Set(
    candidates.flatMap(candidate => candidate.attentionItem.evidenceArtifactIds),
  )].sort(asciiCompare);
}

function earliestDeadline(candidates) {
  const deadlines = candidates
    .map(candidate => candidate.decisionDeadlineAt)
    .filter(Boolean)
    .sort(asciiCompare);
  return deadlines[0] || '';
}

function resultFor(candidate, decision, batchKey = '', batchGroupIndex = null) {
  const item = candidate.attentionItem;
  return deepFreeze({
    itemId: item.itemId,
    sourceKind: item.sourceKind,
    sourceId: item.sourceId,
    sourceRevisionId: item.sourceRevisionId,
    severity: item.severity,
    ownerActionKind: item.ownerActionKind,
    disposition: decision.disposition,
    reasonCode: decision.reasonCode,
    wrongDecisionConsequence: candidate.wrongDecisionConsequence,
    reversibility: candidate.reversibility,
    delayCost: candidate.delayCost,
    uncertainty: candidate.uncertainty,
    canonicalEvidenceAvailable: candidate.canonicalEvidenceAvailable,
    decisionDeadlineAt: candidate.decisionDeadlineAt,
    deadlineState: candidate.deadlineState,
    batchKey,
    batchGroupIndex,
    evidenceArtifactIds: [...item.evidenceArtifactIds],
  });
}

export function buildOwnerAttentionPlanV1(input) {
  const raw = strictRecord(input, REQUEST_KEYS, 'OwnerAttentionOptimizerRequestV1');
  requireKeys(raw, REQUEST_KEYS, 'OwnerAttentionOptimizerRequestV1');
  if (raw.schemaVersion !== OWNER_ATTENTION_OPTIMIZER_SCHEMA_VERSION) {
    throw new Error('OwnerAttentionOptimizerRequestV1 schemaVersion must be numeric 1');
  }

  const evaluatedAt = canonicalTimestamp(raw.evaluatedAt, 'evaluatedAt');
  const nearDeadlineWindowMs = boundedInteger(
    raw.nearDeadlineWindowMs,
    'nearDeadlineWindowMs',
    0,
    MAX_NEAR_DEADLINE_WINDOW_MS,
  );
  const candidates = strictArray(raw.items, 'items').map((item, index) => (
    normalizeCandidate(item, index, evaluatedAt, nearDeadlineWindowMs)
  ));

  const itemIds = new Set();
  for (const candidate of candidates) {
    if (itemIds.has(candidate.attentionItem.itemId)) {
      throw new Error('items contain duplicate Action Center itemId: ' + candidate.attentionItem.itemId);
    }
    itemIds.add(candidate.attentionItem.itemId);
  }

  const decisionsById = new Map();
  const batchCandidates = new Map();

  for (const candidate of candidates) {
    const decision = initialDisposition(candidate);
    if (decision.disposition !== 'BATCH_ELIGIBLE') {
      decisionsById.set(candidate.attentionItem.itemId, { candidate, decision });
      continue;
    }
    const group = batchCandidates.get(candidate.batchKey) || [];
    group.push(candidate);
    batchCandidates.set(candidate.batchKey, group);
  }

  const batches = [];
  for (const batchKey of [...batchCandidates.keys()].sort(asciiCompare)) {
    const group = [...batchCandidates.get(batchKey)].sort((left, right) => (
      asciiCompare(left.attentionItem.itemId, right.attentionItem.itemId)
    ));
    const chunks = chunkBatchCandidates(group);
    const batchedIds = new Set();

    chunks.forEach((chunk, index) => {
      const groupIndex = index + 1;
      for (const candidate of chunk) {
        batchedIds.add(candidate.attentionItem.itemId);
        decisionsById.set(candidate.attentionItem.itemId, {
          candidate,
          decision: {
            disposition: OwnerAttentionDisposition.BATCH,
            reasonCode: 'RELATED_OWNER_DECISIONS_BATCHED',
          },
          batchKey,
          batchGroupIndex: groupIndex,
        });
      }
      batches.push(deepFreeze({
        batchKey,
        groupIndex,
        itemIds: chunk.map(candidate => candidate.attentionItem.itemId),
        ownerActionKinds: [...new Set(
          chunk.map(candidate => candidate.attentionItem.ownerActionKind),
        )].sort(asciiCompare),
        earliestDeadlineAt: earliestDeadline(chunk),
        evidenceArtifactIds: evidenceUnion(chunk),
        notificationAuthorized: false,
        decisionAuthorized: false,
      }));
    });

    for (const candidate of group) {
      if (batchedIds.has(candidate.attentionItem.itemId)) continue;
      decisionsById.set(candidate.attentionItem.itemId, {
        candidate,
        decision: singletonBatchFallback(candidate),
      });
    }
  }

  const items = [...decisionsById.values()].map(entry => resultFor(
    entry.candidate,
    entry.decision,
    entry.batchKey || '',
    entry.batchGroupIndex ?? null,
  )).sort((left, right) => (
    DISPOSITION_RANK[left.disposition] - DISPOSITION_RANK[right.disposition]
    || SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || asciiCompare(left.decisionDeadlineAt || '9999', right.decisionDeadlineAt || '9999')
    || asciiCompare(left.itemId, right.itemId)
  ));

  const count = disposition => items.filter(item => item.disposition === disposition).length;

  return deepFreeze({
    schemaVersion: OWNER_ATTENTION_OPTIMIZER_SCHEMA_VERSION,
    evaluatedAt,
    nearDeadlineWindowMs,
    items,
    batches: batches.sort((left, right) => (
      asciiCompare(left.batchKey, right.batchKey) || left.groupIndex - right.groupIndex
    )),
    summary: {
      itemCount: items.length,
      escalateNowCount: count(OwnerAttentionDisposition.ESCALATE_NOW),
      gatherEvidenceFirstCount: count(OwnerAttentionDisposition.GATHER_EVIDENCE_FIRST),
      batchedItemCount: count(OwnerAttentionDisposition.BATCH),
      deferWhileContinuingCount: count(OwnerAttentionDisposition.DEFER_WHILE_CONTINUING),
      batchCount: batches.length,
    },
    readOnly: true,
    advisoryOnly: true,
    requiresCanonicalSourceResolution: true,
    notificationAuthorized: false,
    decisionAuthorized: false,
    evidenceGatheringAuthorized: false,
    taskMutationAuthorized: false,
  });
}
