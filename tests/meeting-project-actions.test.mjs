import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessMeetingEvidenceFreshnessV1,
  assertMeetingEvidenceMatchesProjectSnapshotV1,
  assertMeetingProjectActionsMatchesEvidenceV1,
  meetingEvidenceBindingFromBundleV1,
  normalizeMeetingEvidenceBundleV1,
  normalizeMeetingProjectActionsV1,
} from '../src/core/meeting-project-actions.js';

const T1 = '2026-09-24T20:00:00.000Z';
const T2 = '2026-09-24T21:00:00.000Z';
const sha = char => char.repeat(64);

function source({
  id = 'meeting-source',
  projectId = 'project-a',
  revisionId = 'source-r1',
  digest = sha('b'),
  uri = 'drive://meeting-doc',
  authority = 'CANONICAL',
} = {}) {
  return {
    schemaVersion: 1,
    sourceId: id,
    projectId,
    kind: 'meeting',
    uri,
    revisionId,
    contentSha256: digest,
    observedAt: T1,
    authority,
    metadata: {},
  };
}

function artifact({
  id,
  digest,
  kind = 'meeting.evidence',
  uri,
  mediaType = 'application/octet-stream',
  sizeBytes = 100,
} = {}) {
  return {
    schemaVersion: 1,
    artifactId: id,
    kind,
    uri: uri || `artifact://${id}`,
    mediaType,
    sha256: digest,
    sizeBytes,
    createdAt: T1,
    producerInvocationId: 'invoke-meeting-1',
    sensitive: false,
  };
}

function transcript() {
  return artifact({
    id: 'transcript-a',
    digest: sha('a'),
    kind: 'meeting.transcript',
    mediaType: 'text/plain',
  });
}

function recording(id = 'recording-a', digest = sha('c')) {
  return artifact({
    id,
    digest,
    kind: 'meeting.recording',
    mediaType: 'audio/wav',
    sizeBytes: 200,
  });
}

function evidenceBundle({
  sourceRefs = [source()],
  recordingRefs = [recording()],
  transcriptRef = transcript(),
  revisionId = 'meeting-r1',
} = {}) {
  return {
    schemaVersion: 1,
    meetingId: 'meeting-a',
    projectId: 'project-a',
    meetingRevisionId: revisionId,
    sourceRefs,
    transcriptArtifactRef: transcriptRef,
    recordingArtifactRefs: recordingRefs,
    observedAt: T1,
  };
}

function projectSnapshot(bundle = evidenceBundle()) {
  return {
    schemaVersion: 1,
    projectId: 'project-a',
    revisionId: 'project-r1',
    title: 'Project A',
    sourceRefs: bundle.sourceRefs,
    artifactRefs: [bundle.transcriptArtifactRef, ...bundle.recordingArtifactRefs],
    createdAt: T1,
  };
}

function result(bundle = evidenceBundle()) {
  return {
    schemaVersion: 1,
    resultId: 'meeting-actions-1',
    meetingBinding: meetingEvidenceBindingFromBundleV1(bundle),
    decisions: [{
      decisionId: 'decision-a',
      statement: 'Use the canonical Project source for the next revision.',
      evidenceArtifactIds: ['transcript-a'],
      sourceIds: ['meeting-source'],
      status: 'PROPOSED',
    }],
    actionItems: [{
      actionItemId: 'action-a',
      title: 'Prepare the next Project revision',
      details: 'Draft only; no Task or Calendar mutation is authorized.',
      assigneeRef: 'person-alex',
      dueAt: T2,
      evidenceArtifactIds: ['recording-a', 'transcript-a'],
      sourceIds: ['meeting-source'],
      status: 'PROPOSED',
    }],
    generatedAt: T2,
    advisoryOnly: true,
    taskCreationAuthorized: false,
    calendarMutationAuthorized: false,
    messageSendAuthorized: false,
    identityAuthority: 'UNVERIFIED_REFERENCES',
  };
}

test('meeting evidence is materialized, deterministic and source-aware', () => {
  const raw = evidenceBundle({
    sourceRefs: [
      source({ id: 'source-z', revisionId: 'z-r1', digest: sha('d'), uri: 'drive://z' }),
      source(),
    ],
    recordingRefs: [
      recording('recording-z', sha('e')),
      recording(),
    ],
  });
  const normalized = normalizeMeetingEvidenceBundleV1(raw);
  assert.deepEqual(normalized.sourceRefs.map(item => item.sourceId), ['meeting-source', 'source-z']);
  assert.deepEqual(normalized.recordingArtifactRefs.map(item => item.artifactId), ['recording-a', 'recording-z']);
  assert(Object.isFrozen(normalized));
  const missingHash = structuredClone(raw);
  delete missingHash.sourceRefs[0].contentSha256;
  assert.throws(() => normalizeMeetingEvidenceBundleV1(missingHash), /contentSha256 is required/);
  const duplicateArtifact = evidenceBundle({ recordingRefs: [recording('transcript-a', sha('d'))] });
  assert.throws(() => normalizeMeetingEvidenceBundleV1(duplicateArtifact), /distinct artifactId/);
});

test('meeting evidence and generated proposals preserve temporal causality', () => {
  const futureSource = source();
  futureSource.observedAt = '2026-09-24T22:00:00.000Z';
  assert.throws(() => normalizeMeetingEvidenceBundleV1(evidenceBundle({
    sourceRefs: [futureSource],
  })), /cannot predate source observation/);

  const futureTranscript = transcript();
  futureTranscript.createdAt = '2026-09-24T22:00:00.000Z';
  assert.throws(() => normalizeMeetingEvidenceBundleV1(evidenceBundle({
    transcriptRef: futureTranscript,
  })), /cannot predate artifact creation/);

  const bundle = evidenceBundle();
  const beforeEvidence = result(bundle);
  beforeEvidence.generatedAt = '2026-09-24T19:59:59.000Z';
  assert.throws(() => normalizeMeetingProjectActionsV1(beforeEvidence), /cannot predate meeting evidence/);
});

test('strict boundary rejects accessors, hidden fields, symbols, exotic objects and sparse arrays without getter execution', () => {
  let reads = 0;
  const accessor = evidenceBundle();
  Object.defineProperty(accessor, 'projectId', {
    enumerable: true,
    get() { reads += 1; return 'project-a'; },
  });
  assert.throws(() => normalizeMeetingEvidenceBundleV1(accessor), /enumerable own data property/);
  assert.equal(reads, 0);

  const hidden = evidenceBundle();
  Object.defineProperty(hidden, 'meetingId', { value: 'meeting-a', enumerable: false });
  assert.throws(() => normalizeMeetingEvidenceBundleV1(hidden), /enumerable own data property/);

  const symbol = evidenceBundle();
  symbol[Symbol('permission')] = 'ALLOW';
  assert.throws(() => normalizeMeetingEvidenceBundleV1(symbol), /symbol fields/);

  const exotic = Object.create({ ownerAuthority: 'ALLOW' });
  Object.assign(exotic, evidenceBundle());
  assert.throws(() => normalizeMeetingEvidenceBundleV1(exotic), /plain data object/);

  const sparse = evidenceBundle();
  sparse.recordingArtifactRefs = new Array(1);
  assert.throws(() => normalizeMeetingEvidenceBundleV1(sparse), /enumerable own data item/);

  const indexAccessor = evidenceBundle();
  Object.defineProperty(indexAccessor.sourceRefs, '0', {
    enumerable: true,
    get() { reads += 1; return source(); },
  });
  assert.throws(() => normalizeMeetingEvidenceBundleV1(indexAccessor), /enumerable own data item/);
  assert.equal(reads, 0);
});

test('meeting evidence must already be admitted by exact canonical ProjectSnapshot sources and artifacts', () => {
  const bundle = evidenceBundle();
  const project = projectSnapshot(bundle);
  const admitted = assertMeetingEvidenceMatchesProjectSnapshotV1({ evidenceBundle: bundle, projectSnapshot: project });
  assert.equal(admitted.projectRevisionId, 'project-r1');
  assert.equal(admitted.advisoryOnly, true);
  assert.equal(admitted.admissionAuthorized, false);

  const coerciveVersion = structuredClone(project);
  coerciveVersion.schemaVersion = '1';
  assert.throws(() => assertMeetingEvidenceMatchesProjectSnapshotV1({
    evidenceBundle: bundle,
    projectSnapshot: coerciveVersion,
  }), /schemaVersion/);

  const coerciveArtifactId = structuredClone(project);
  coerciveArtifactId.artifactRefs[0].artifactId = 7;
  assert.throws(() => assertMeetingEvidenceMatchesProjectSnapshotV1({
    evidenceBundle: bundle,
    projectSnapshot: coerciveArtifactId,
  }), /artifactId is invalid/);

  let reads = 0;
  const accessorArtifacts = structuredClone(project);
  Object.defineProperty(accessorArtifacts.artifactRefs, '0', {
    enumerable: true,
    get() { reads += 1; return transcript(); },
  });
  assert.throws(() => assertMeetingEvidenceMatchesProjectSnapshotV1({
    evidenceBundle: bundle,
    projectSnapshot: accessorArtifacts,
  }), /enumerable own data item/);
  assert.equal(reads, 0);

  const staleSource = structuredClone(project);
  staleSource.sourceRefs[0].revisionId = 'source-r2';
  assert.throws(() => assertMeetingEvidenceMatchesProjectSnapshotV1({
    evidenceBundle: bundle,
    projectSnapshot: staleSource,
  }), /source is not admitted/);

  const swappedTranscript = structuredClone(project);
  swappedTranscript.artifactRefs[0].sha256 = sha('f');
  assert.throws(() => assertMeetingEvidenceMatchesProjectSnapshotV1({
    evidenceBundle: bundle,
    projectSnapshot: swappedTranscript,
  }), /artifact is not admitted/);

  const missingRecording = structuredClone(project);
  missingRecording.artifactRefs = [bundle.transcriptArtifactRef];
  assert.throws(() => assertMeetingEvidenceMatchesProjectSnapshotV1({
    evidenceBundle: bundle,
    projectSnapshot: missingRecording,
  }), /artifact is not admitted/);
});

test('project actions bind exact meeting revision and never grant execution or identity authority', () => {
  const bundle = evidenceBundle();
  const normalized = normalizeMeetingProjectActionsV1(result(bundle));
  assert.equal(normalized.advisoryOnly, true);
  assert.equal(normalized.taskCreationAuthorized, false);
  assert.equal(normalized.calendarMutationAuthorized, false);
  assert.equal(normalized.messageSendAuthorized, false);
  assert.equal(normalized.identityAuthority, 'UNVERIFIED_REFERENCES');
  assert.equal(normalized.actionItems[0].assigneeRef, 'person-alex');

  assert.doesNotThrow(() => assertMeetingProjectActionsMatchesEvidenceV1({
    result: result(bundle),
    evidenceBundle: bundle,
  }));

  const revised = evidenceBundle({ revisionId: 'meeting-r2' });
  assert.throws(() => assertMeetingProjectActionsMatchesEvidenceV1({
    result: result(bundle),
    evidenceBundle: revised,
  }), /does not bind the exact/);

  const reclassified = structuredClone(bundle);
  reclassified.sourceRefs[0].authority = 'DERIVED';
  assert.throws(() => assertMeetingProjectActionsMatchesEvidenceV1({
    result: result(bundle),
    evidenceBundle: reclassified,
  }), /does not bind the exact/);

  const sensitivityChanged = structuredClone(bundle);
  sensitivityChanged.transcriptArtifactRef.sensitive = true;
  assert.throws(() => assertMeetingProjectActionsMatchesEvidenceV1({
    result: result(bundle),
    evidenceBundle: sensitivityChanged,
  }), /does not bind the exact/);

  assert.throws(() => normalizeMeetingProjectActionsV1({
    ...result(bundle),
    taskCreationAuthorized: true,
  }), /cannot authorize Task creation/);
  assert.throws(() => normalizeMeetingProjectActionsV1({
    ...result(bundle),
    identityAuthority: 'AUTHENTICATED_OWNER',
  }), /UNVERIFIED_REFERENCES/);
});

test('decisions and actions cannot cite unknown evidence or sources and remain PROPOSED', () => {
  const bundle = evidenceBundle();
  const unknownArtifact = result(bundle);
  unknownArtifact.actionItems[0].evidenceArtifactIds = ['artifact-not-in-meeting'];
  assert.throws(() => normalizeMeetingProjectActionsV1(unknownArtifact), /unknown meeting evidence artifact/);

  const unknownSource = result(bundle);
  unknownSource.decisions[0].sourceIds = ['source-not-in-meeting'];
  assert.throws(() => normalizeMeetingProjectActionsV1(unknownSource), /unknown meeting source/);

  const fakeDone = result(bundle);
  fakeDone.actionItems[0].status = 'DONE';
  assert.throws(() => normalizeMeetingProjectActionsV1(fakeDone), /must be PROPOSED/);

  const permissionInjection = result(bundle);
  permissionInjection.actionItems[0].policyDecision = 'ALLOW';
  assert.throws(() => normalizeMeetingProjectActionsV1(permissionInjection), /unknown field/);
});

test('meeting source freshness fails closed on revision/hash/URI/authority drift or missing source', () => {
  const bundle = evidenceBundle();
  const fresh = assessMeetingEvidenceFreshnessV1(bundle, [source()]);
  assert.equal(fresh.status, 'FRESH');
  assert.equal(fresh.advisoryOnly, true);

  const changed = assessMeetingEvidenceFreshnessV1(bundle, [
    source({ revisionId: 'source-r2', digest: sha('d'), uri: 'drive://changed', authority: 'DERIVED' }),
  ]);
  assert.equal(changed.status, 'STALE');
  assert.deepEqual(changed.sources[0].reasons, [
    'URI_CHANGED',
    'AUTHORITY_CHANGED',
    'REVISION_CHANGED',
    'CONTENT_CHANGED',
  ]);

  const missing = assessMeetingEvidenceFreshnessV1(bundle, []);
  assert.equal(missing.status, 'STALE');
  assert.deepEqual(missing.sources[0].reasons, ['CURRENT_SOURCE_MISSING']);

  const regressed = source();
  regressed.observedAt = '2026-09-24T19:00:00.000Z';
  const regressedState = assessMeetingEvidenceFreshnessV1(bundle, [regressed]);
  assert.equal(regressedState.status, 'STALE');
  assert.deepEqual(regressedState.sources[0].reasons, ['OBSERVATION_REGRESSED']);
});

test('canonical primitive representation cannot gain authority through coercion/defaults', () => {
  const stringVersion = evidenceBundle();
  stringVersion.transcriptArtifactRef.schemaVersion = '1';
  assert.throws(() => normalizeMeetingEvidenceBundleV1(stringVersion), /schemaVersion/);

  const numericId = evidenceBundle();
  numericId.transcriptArtifactRef.artifactId = 7;
  assert.throws(() => normalizeMeetingEvidenceBundleV1(numericId), /artifactId is invalid/);

  const missingSensitive = evidenceBundle();
  delete missingSensitive.transcriptArtifactRef.sensitive;
  assert.throws(() => normalizeMeetingEvidenceBundleV1(missingSensitive), /sensitive is required/);

  const upperDigest = evidenceBundle();
  upperDigest.transcriptArtifactRef.sha256 = sha('A');
  assert.throws(() => normalizeMeetingEvidenceBundleV1(upperDigest), /sha256 is invalid/);

  const nonCanonicalTime = evidenceBundle();
  nonCanonicalTime.sourceRefs[0].observedAt = '2026-09-24T20:00:00Z';
  assert.throws(() => normalizeMeetingEvidenceBundleV1(nonCanonicalTime), /canonical timestamp/);
});
