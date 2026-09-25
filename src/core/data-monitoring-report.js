import {
  assessDataDatasetFreshnessV1,
  deriveDataDatasetDeltaV1,
  normalizeDataDatasetSnapshotV1,
} from './data-analytics-lineage.js';

export const DATA_MONITORING_REPORT_VERSION = 1;
export const DataMonitoringStatus = Object.freeze({
  CLEAR: 'CLEAR',
  ALERT: 'ALERT',
  BLOCKED: 'BLOCKED',
});

export const DataMonitoringSeverity = Object.freeze({
  BLOCKER: 'BLOCKER',
  ALERT: 'ALERT',
  WARNING: 'WARNING',
});

const REQUEST_KEYS = new Set([
  'schemaVersion',
  'baseline',
  'current',
  'currentSourceRefs',
  'thresholds',
  'assessedAt',
]);

const THRESHOLD_KEYS = new Set([
  'absoluteRowDelta',
  'rowChangeBasisPoints',
  'flagSchemaChange',
  'flagSourceBindingChange',
]);

const MAX_SOURCE_REFS = 128;
const MAX_REPORT_CHARS = 32 * 1024;

function strictRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a plain data object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(label + ' must be a plain data object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new Error(label + ' contains symbol fields');
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '.' + key + ' must be an enumerable own data property');
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

function exactKeys(raw, allowed, label) {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(label + ' contains unknown field: ' + key);
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(label + '.' + key + ' is required');
    }
  }
}

function strictArraySnapshot(value, label, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(label + ' must be a plain dense array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > max) {
    throw new Error(label + ' has an invalid length');
  }
  const length = lengthDescriptor.value;
  const snapshot = new Array(length);
  const seen = new Set();
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new Error(label + ' contains non-index fields');
    }
    const index = Number(key);
    const descriptor = descriptors[key];
    if (!Number.isSafeInteger(index) || index >= length
        || !descriptor || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(label + '[' + key + '] must be an enumerable own data item');
    }
    snapshot[index] = descriptor.value;
    seen.add(index);
  }
  for (let index = 0; index < length; index += 1) {
    if (!seen.has(index)) throw new Error(label + '[' + index + '] is missing');
  }
  return Object.freeze(snapshot);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new Error(label + ' must be a canonical timestamp');
  }
  return value;
}

function compareCanonicalTimestamp(left, right) {
  const leftMillis = Date.parse(left);
  const rightMillis = Date.parse(right);
  return leftMillis < rightMillis ? -1 : leftMillis > rightMillis ? 1 : 0;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be boolean');
  return value;
}

function optionalPositiveSafeInteger(value, label, max) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(label + ' must be null or a positive safe integer');
  }
  return value;
}

function normalizeThresholds(input) {
  const raw = strictRecord(input, 'DataMonitoringThresholdsV1');
  exactKeys(raw, THRESHOLD_KEYS, 'DataMonitoringThresholdsV1');
  return Object.freeze({
    absoluteRowDelta: optionalPositiveSafeInteger(
      raw.absoluteRowDelta,
      'absoluteRowDelta',
      Number.MAX_SAFE_INTEGER,
    ),
    rowChangeBasisPoints: optionalPositiveSafeInteger(
      raw.rowChangeBasisPoints,
      'rowChangeBasisPoints',
      1_000_000_000,
    ),
    flagSchemaChange: boolean(raw.flagSchemaChange, 'flagSchemaChange'),
    flagSourceBindingChange: boolean(raw.flagSourceBindingChange, 'flagSourceBindingChange'),
  });
}

function snapshotCurrentSources(value, assessedAt) {
  const items = strictArraySnapshot(value, 'currentSourceRefs', MAX_SOURCE_REFS);
  return Object.freeze(items.map((item, index) => {
    const raw = strictRecord(item, 'currentSourceRefs[' + index + ']');
    if (!Object.prototype.hasOwnProperty.call(raw, 'observedAt')) {
      throw new Error('currentSourceRefs[' + index + '].observedAt is required');
    }
    const observedAt = canonicalTimestamp(raw.observedAt, 'currentSourceRefs[' + index + '].observedAt');
    if (compareCanonicalTimestamp(observedAt, assessedAt) > 0) {
      throw new Error('currentSourceRefs[' + index + '] is observed after assessedAt');
    }
    return raw;
  }));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function absoluteRowDelta(delta) {
  return Math.abs(delta.rowCountDelta);
}

function rowChangeEvidence(rowCountBefore, rowCountAfter) {
  const abs = BigInt(Math.abs(rowCountAfter - rowCountBefore));
  if (rowCountBefore === 0) {
    return Object.freeze({
      basisPointsFloor: rowCountAfter === 0 ? '0' : null,
      unboundedFromZeroBaseline: rowCountAfter !== 0,
    });
  }
  const basisPoints = (abs * 10_000n) / BigInt(rowCountBefore);
  return Object.freeze({
    basisPointsFloor: basisPoints.toString(),
    unboundedFromZeroBaseline: false,
  });
}

function reachesBasisPointThreshold(absDelta, baselineCount, threshold) {
  if (threshold === null || absDelta === 0) return false;
  if (baselineCount === 0) return true;
  return BigInt(absDelta) * 10_000n >= BigInt(threshold) * BigInt(baselineCount);
}

function anomaly(code, severity, subjectId, reasonCodes, message) {
  return deepFreeze({
    code,
    severity,
    subjectId,
    reasonCodes: Object.freeze([...reasonCodes]),
    message,
  });
}

function buildAccessibleText(result) {
  const lines = [
    'Data monitoring report',
    'Project: ' + result.projectId,
    'Dataset: ' + result.datasetId,
    'Revision: ' + result.fromRevisionId + ' -> ' + result.toRevisionId,
    'Content SHA-256: ' + result.currentContentSha256,
    'Freshness: ' + result.freshness.status + ' (' + result.freshness.staleSourceCount + ' stale of ' + result.freshness.checkedSourceCount + ')',
    'Rows: ' + result.rowCountBefore + ' -> ' + result.rowCountAfter + ' (delta ' + result.rowCountDelta + ')',
    'Row change basis points floor: ' + (result.rowChange.basisPointsFloor === null ? 'unbounded from zero baseline' : result.rowChange.basisPointsFloor),
    'Schema changes: ' + result.schemaChangeCount,
    'Source binding changes: ' + result.sourceBindingChangeCount,
    'Status: ' + result.status,
    'Anomalies: ' + result.anomalies.length,
  ];
  for (const item of result.anomalies) {
    lines.push('- [' + item.severity + '] ' + item.code + ' / ' + item.subjectId + ': ' + item.message);
  }
  const text = lines.join('\n');
  if (text.length > MAX_REPORT_CHARS) throw new Error('Data monitoring accessible report exceeds size bound');
  return text;
}

/**
 * Creates a bounded, text-first monitoring projection from the existing
 * canonical Data Analytics snapshot/delta/freshness authorities.
 *
 * This function is read-only and advisory. An alert is only evidence that a
 * canonical downstream policy/trigger workflow may evaluate; it never grants
 * policy, trigger, provider or execution authority.
 */
export function buildDataMonitoringReportV1(input) {
  const raw = strictRecord(input, 'DataMonitoringReportV1 request');
  exactKeys(raw, REQUEST_KEYS, 'DataMonitoringReportV1 request');
  if (raw.schemaVersion !== DATA_MONITORING_REPORT_VERSION) {
    throw new Error('Unsupported DataMonitoringReportV1 schemaVersion');
  }

  const assessedAt = canonicalTimestamp(raw.assessedAt, 'assessedAt');
  const thresholds = normalizeThresholds(raw.thresholds);
  const baseline = normalizeDataDatasetSnapshotV1(raw.baseline);
  const current = normalizeDataDatasetSnapshotV1(raw.current);

  if (baseline.projectId !== current.projectId || baseline.datasetId !== current.datasetId) {
    throw new Error('monitoring requires the same projectId and datasetId');
  }
  if (compareCanonicalTimestamp(baseline.observedAt, current.observedAt) > 0) {
    throw new Error('baseline dataset observation cannot be after current dataset observation');
  }
  if (compareCanonicalTimestamp(current.observedAt, assessedAt) > 0) {
    throw new Error('current dataset observation is after assessedAt');
  }

  const currentSourceRefs = snapshotCurrentSources(raw.currentSourceRefs, assessedAt);
  const delta = deriveDataDatasetDeltaV1({ baseline, current });
  const freshness = assessDataDatasetFreshnessV1(current, currentSourceRefs);
  const absDelta = absoluteRowDelta(delta);
  const rowChange = rowChangeEvidence(delta.rowCountBefore, delta.rowCountAfter);
  const anomalies = [];

  if (freshness.status === 'UNVERIFIED') {
    anomalies.push(anomaly(
      'SOURCE_FRESHNESS_UNVERIFIED',
      DataMonitoringSeverity.BLOCKER,
      current.datasetId,
      ['NO_CANONICAL_SOURCE_BINDING'],
      'Current dataset source freshness cannot be verified.',
    ));
  }
  for (const source of freshness.sources) {
    if (source.status === 'STALE') {
      anomalies.push(anomaly(
        'SOURCE_STALE',
        DataMonitoringSeverity.BLOCKER,
        source.sourceId,
        source.reasons,
        'Current source identity no longer matches the dataset source binding.',
      ));
    }
  }

  if (thresholds.flagSchemaChange && delta.schemaChanges.length > 0) {
    anomalies.push(anomaly(
      'SCHEMA_CHANGED',
      DataMonitoringSeverity.WARNING,
      current.datasetId,
      ['SCHEMA_DELTA_PRESENT'],
      'Dataset schema changed from the baseline revision.',
    ));
  }

  if (thresholds.flagSourceBindingChange && delta.sourceChanges.length > 0) {
    anomalies.push(anomaly(
      'SOURCE_BINDINGS_CHANGED',
      DataMonitoringSeverity.WARNING,
      current.datasetId,
      ['SOURCE_BINDING_DELTA_PRESENT'],
      'Dataset source bindings changed from the baseline revision.',
    ));
  }

  if (thresholds.absoluteRowDelta !== null && absDelta >= thresholds.absoluteRowDelta) {
    anomalies.push(anomaly(
      'ROW_COUNT_ABSOLUTE_THRESHOLD',
      DataMonitoringSeverity.ALERT,
      current.datasetId,
      ['ABSOLUTE_ROW_DELTA_THRESHOLD_REACHED'],
      'Absolute row-count change reached the configured deterministic threshold.',
    ));
  }

  if (reachesBasisPointThreshold(
    absDelta,
    delta.rowCountBefore,
    thresholds.rowChangeBasisPoints,
  )) {
    anomalies.push(anomaly(
      delta.rowCountBefore === 0 ? 'ROW_CHANGE_FROM_ZERO_BASELINE' : 'ROW_COUNT_RATIO_THRESHOLD',
      DataMonitoringSeverity.ALERT,
      current.datasetId,
      [delta.rowCountBefore === 0 ? 'ZERO_BASELINE_NONZERO_CHANGE' : 'ROW_CHANGE_BASIS_POINTS_THRESHOLD_REACHED'],
      delta.rowCountBefore === 0
        ? 'Row count changed from a zero baseline; the proportional change is unbounded.'
        : 'Row-count proportional change reached the configured deterministic basis-point threshold.',
    ));
  }

  const blocked = freshness.status !== 'FRESH';
  const status = blocked
    ? DataMonitoringStatus.BLOCKED
    : (anomalies.length > 0 ? DataMonitoringStatus.ALERT : DataMonitoringStatus.CLEAR);

  const result = {
    schemaVersion: DATA_MONITORING_REPORT_VERSION,
    projectId: current.projectId,
    datasetId: current.datasetId,
    fromRevisionId: baseline.revisionId,
    toRevisionId: current.revisionId,
    baselineContentSha256: baseline.contentSha256,
    currentContentSha256: current.contentSha256,
    assessedAt,
    status,
    thresholds,
    freshness,
    changeSignals: Object.freeze([...delta.signals]),
    rowCountBefore: delta.rowCountBefore,
    rowCountAfter: delta.rowCountAfter,
    rowCountDelta: delta.rowCountDelta,
    rowChange,
    schemaChangeCount: delta.schemaChanges.length,
    sourceBindingChangeCount: delta.sourceChanges.length,
    anomalies: Object.freeze(anomalies),
    downstreamEvaluationRecommended: status === DataMonitoringStatus.ALERT,
    requiresCanonicalPolicyDecision: status === DataMonitoringStatus.ALERT,
    readOnly: true,
    advisoryOnly: true,
    policyDecisionGranted: false,
    triggerAuthorized: false,
    executionAuthorized: false,
  };
  result.accessibleText = buildAccessibleText(result);
  return deepFreeze(result);
}
