/**
 * Read-only privacy-minimizing owner ROI advisory. The canonical trusted
 * evidence resolver and ROI engine remain the only source of statistics.
 * No new policy, model, scheduler, license, store or execution authority.
 */
import {
  buildRoiOpportunityReportV1,
  RoiReportStatus,
} from './roi-opportunity-engine.js';

export const ROI_OWNER_ADVISORY_VERSION = 1;
export const RoiOwnerAdvisoryStatus = Object.freeze({
  OFFLINE: 'OFFLINE',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  PARTIAL_EVIDENCE: 'PARTIAL_EVIDENCE',
  EVIDENCE_BACKED: 'EVIDENCE_BACKED',
});

function subtractExact(left, right) {
  const value = BigInt(left) - BigInt(right);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    // "unknown", not a silently rounded money/time claim
    return null;
  }
  return Number(value);
}

function frozenRows(report) {
  return Object.freeze(report.automationOpportunities.map(candidate => Object.freeze({
    workflowClassId: candidate.workflowClassId,
    verifiedManualOccurrenceCount: candidate.verifiedManualOccurrenceCount,
    recurringOwnerAttentionSeconds: candidate.observedManualOwnerAttentionSeconds,
    advisoryPath: 'EVALUATE_DETERMINISTIC_RECIPE_OR_TOOL',
    shorterModelPath: 'NOT_EVALUATED',
    // No comparative route/model evidence is present in the ROI run schema;
    // never pretend a cheaper model is verified from spend totals alone.
    supportingRunCount: candidate.supportingRunIds.length,
    decisionAuthorized: false,
    policyOrExecutionAuthorized: false,
  })));
}

/**
 * Offline is a safety/privacy boundary, not a truthy UI setting. Snapshot
 * only own data descriptors before reading the option, so getters, inherited
 * flags and coerced strings cannot silently turn evidence reads back on.
 */
function strictOfflineOption(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('ROI offline options must be a plain object');
  }
  let prototype, descriptors;
  try {
    prototype = Object.getPrototypeOf(options);
    descriptors = Object.getOwnPropertyDescriptors(options);
  } catch {
    throw new Error('ROI offline options are not trustworthy');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('ROI offline options must be a plain object');
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => key !== 'offline')) {
    throw new Error('ROI offline options contain unknown fields');
  }
  if (!Object.hasOwn(descriptors, 'offline')) return false;
  const descriptor = descriptors.offline;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
    || typeof descriptor.value !== 'boolean') {
    throw new Error('ROI offline options require an own boolean data field');
  }
  return descriptor.value;
}

/**
 * offline=true is an explicit, observable degradation path. It never serves
 * cached gains as current evidence and never calls the resolver while offline.
 * All other malformed/tampered evidence errors propagate fail-closed.
 */
export async function buildRoiOwnerAdvisoryV1(input, dependencies, options = {}) {
  const offline = strictOfflineOption(options);
  if (offline) {
    return Object.freeze({
      schemaVersion: ROI_OWNER_ADVISORY_VERSION,
      status: RoiOwnerAdvisoryStatus.OFFLINE,
      statusText: 'Немає зв’язку з локальними доказами. Оцінку економії не оновлено.',
      reportId: null,
      observedRunCount: 0,
      verifiedOutcomeCount: 0,
      observedOwnerTimeAvoidedSeconds: null,
      estimatedOwnerTimeAvoidedSeconds: null,
      observedOwnerAttentionSeconds: null,
      netOwnerTimeLowerSeconds: null,
      netOwnerTimeUpperSeconds: null,
      machineSpendUsdMicros: null,
      runtimeMs: null,
      opportunities: Object.freeze([]),
      noComparableModelEvidence: true,
      recommendationAuthorized: false,
      deploymentAuthorized: false,
      telemetryEmitted: false,
    });
  }

  const report = await buildRoiOpportunityReportV1(input, dependencies);
  const sufficient = report.status !== RoiReportStatus.INSUFFICIENT_EVIDENCE;
  const status = !sufficient
    ? RoiOwnerAdvisoryStatus.INSUFFICIENT_EVIDENCE
    : report.status === RoiReportStatus.PARTIAL_EVIDENCE
      ? RoiOwnerAdvisoryStatus.PARTIAL_EVIDENCE
      : RoiOwnerAdvisoryStatus.EVIDENCE_BACKED;
  const ownerAttention = report.ownerTime.totalObservedOwnerAttentionSeconds;
  const avoidedLower = report.ownerTime.boundedOwnerTimeAvoidedLowerSeconds;
  const avoidedUpper = report.ownerTime.boundedOwnerTimeAvoidedUpperSeconds;
  return Object.freeze({
    schemaVersion: ROI_OWNER_ADVISORY_VERSION,
    status,
    statusText: !sufficient
      ? 'Доказів недостатньо для рекомендації автоматизації.'
      : report.status === RoiReportStatus.PARTIAL_EVIDENCE
        ? 'Часткові докази. Оцінена економія показана як інтервал.'
        : 'Доступні підтверджені локальні показники. Рекомендації лише дорадчі.',
    reportId: report.reportId,
    observedRunCount: report.outcomes.totalRunCount,
    verifiedOutcomeCount: report.outcomes.verifiedOutcomesCompleted,
    observedOwnerTimeAvoidedSeconds: sufficient
      ? report.ownerTime.observedOwnerTimeAvoidedSeconds : null,
    estimatedOwnerTimeAvoidedSeconds: sufficient
      ? Object.freeze({
        lower: report.ownerTime.estimatedOwnerTimeAvoidedLowerSeconds,
        upper: report.ownerTime.estimatedOwnerTimeAvoidedUpperSeconds,
      }) : null,
    observedOwnerAttentionSeconds: sufficient ? ownerAttention : null,
    netOwnerTimeLowerSeconds: sufficient ? subtractExact(avoidedLower, ownerAttention) : null,
    netOwnerTimeUpperSeconds: sufficient ? subtractExact(avoidedUpper, ownerAttention) : null,
    machineSpendUsdMicros: sufficient ? report.spend.machineApiSpendUsdMicros : null,
    runtimeMs: sufficient ? report.spend.runtimeMs : null,
    opportunities: sufficient ? frozenRows(report) : Object.freeze([]),
    noComparableModelEvidence: true,
    recommendationAuthorized: false,
    deploymentAuthorized: false,
    telemetryEmitted: false,
  });
}
