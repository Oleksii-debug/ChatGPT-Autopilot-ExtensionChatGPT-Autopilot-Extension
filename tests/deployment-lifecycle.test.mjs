import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VerificationStatus,
} from '../src/core/universal-agent-contracts.js';
import {
  ExactEffectEventType,
  createExactEffectStateV1,
  reduceExactEffectV1,
} from '../src/core/universal-agent-exact-effect.js';
import {
  DeploymentCheckKind,
  DeploymentEffectKind,
  DeploymentEventType,
  DeploymentPhase,
  createDeploymentLifecycleV1,
  normalizeDeploymentLifecycleV1,
  reduceDeploymentLifecycleV1,
} from '../src/core/deployment-lifecycle.js';

const hash = char => char.repeat(64);
const at = second => `2026-09-25T06:00:${String(second).padStart(2, '0')}.000Z`;

function artifact(sha256, createdAt = at(1)) {
  return {
    schemaVersion: 1,
    artifactId: 'release-package',
    kind: 'release',
    uri: `artifact://release/${sha256.slice(0, 8)}`,
    mediaType: 'application/zip',
    sha256,
    sizeBytes: 100,
    createdAt,
    producerInvocationId: 'build-1',
    sensitive: false,
  };
}

const candidate = artifact(hash('a'));
const rollback = artifact(hash('b'));

function baseDeployment() {
  return createDeploymentLifecycleV1({
    deploymentId: 'deploy-1',
    projectId: 'project-a',
    targetId: 'production-a',
    publisherId: 'publisher-1',
    candidateArtifactRef: candidate,
    rollbackArtifactRef: rollback,
    publishEffectId: 'publish-effect-1',
    rollbackEffectId: 'rollback-effect-1',
    createdAt: at(2),
  });
}

function verification({
  verificationId,
  status = VerificationStatus.VERIFIED,
  verifierId = 'verifier-1',
  verifiedAt,
} = {}) {
  return {
    schemaVersion: 1,
    verificationId,
    invocationId: `verify-${verificationId}`,
    observationId: `observe-${verificationId}`,
    status,
    reasonCode: status === VerificationStatus.VERIFIED ? 'PASS' : 'REGRESSION',
    summary: '',
    evidenceArtifactIds: [`evidence-${verificationId}`],
    verifiedAt,
    verifierId,
    verificationAuthorityId: 'verification-authority-1',
    effectId: null,
    executionId: null,
    attempt: 0,
  };
}

function verificationBinding({
  verificationId,
  checkKind,
  status = VerificationStatus.VERIFIED,
  artifactRef = candidate,
  verifiedAt,
  verifierId = 'verifier-1',
  projectId = 'project-a',
  targetId = 'production-a',
} = {}) {
  return {
    schemaVersion: 1,
    verificationId,
    projectId,
    targetId,
    artifactId: artifactRef.artifactId,
    artifactSha256: artifactRef.sha256,
    checkKind,
    verification: verification({ verificationId, status, verifiedAt, verifierId }),
  };
}

function committedEffect({
  effectId,
  artifactRef,
  startedAt,
  observedAt,
  verifiedAt,
  committedAt,
} = {}) {
  let state = createExactEffectStateV1({
    schemaVersion: 1,
    invocationId: effectId,
    toolId: 'deployment.publish',
    providerId: 'deployment-provider',
    requestedCapabilityIds: ['deployment.write'],
    policyDecisionId: 'policy-allow-1',
    arguments: { artifactSha256: artifactRef.sha256 },
    createdAt: startedAt,
    parentInvocationId: null,
  }, { createdAt: startedAt });

  state = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: `${effectId}-begin`,
    type: ExactEffectEventType.BEGIN_EXECUTION,
    effectId,
    at: startedAt,
    observation: null,
    verification: null,
    reasonCode: null,
    summary: null,
    outcome: null,
    commitId: null,
    executionId: '',
  }).state;

  const executionId = state.executionId;
  state = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: `${effectId}-observation`,
    type: ExactEffectEventType.RECORD_OBSERVATION,
    effectId,
    at: observedAt,
    observation: {
      schemaVersion: 1,
      observationId: `${effectId}-observation-id`,
      invocationId: effectId,
      status: 'OK',
      summary: '',
      data: { artifactSha256: artifactRef.sha256 },
      artifactRefs: [artifactRef],
      observedAt,
    },
    verification: null,
    reasonCode: null,
    summary: null,
    outcome: null,
    commitId: null,
    executionId,
  }).state;

  state = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: `${effectId}-verification`,
    type: ExactEffectEventType.RECORD_VERIFICATION,
    effectId,
    at: verifiedAt,
    observation: null,
    verification: {
      schemaVersion: 1,
      verificationId: `${effectId}-verification-id`,
      invocationId: effectId,
      observationId: `${effectId}-observation-id`,
      status: 'VERIFIED',
      reasonCode: 'DEPLOYMENT_EFFECT_VERIFIED',
      summary: '',
      evidenceArtifactIds: [artifactRef.artifactId],
      verifiedAt,
      verifierId: 'effect-verifier-1',
      verificationAuthorityId: 'effect-verification-authority-1',
      effectId,
      executionId,
      attempt: 1,
    },
    reasonCode: null,
    summary: null,
    outcome: null,
    commitId: null,
    executionId,
  }).state;

  state = reduceExactEffectV1(state, {
    schemaVersion: 1,
    eventId: `${effectId}-commit`,
    type: ExactEffectEventType.COMMIT,
    effectId,
    at: committedAt,
    observation: null,
    verification: null,
    reasonCode: null,
    summary: null,
    outcome: null,
    commitId: `${effectId}-commit-id`,
    executionId,
  }).state;
  return state;
}

function effectBinding({
  effectId,
  kind,
  artifactRef,
  state,
  projectId = 'project-a',
  targetId = 'production-a',
} = {}) {
  return {
    schemaVersion: 1,
    effectId,
    projectId,
    targetId,
    artifactId: artifactRef.artifactId,
    artifactSha256: artifactRef.sha256,
    kind,
    state,
  };
}

function resolvers(verificationBindings = [], effectBindings = []) {
  const verifications = new Map(verificationBindings.map(item => [item.verificationId, item]));
  const effects = new Map(effectBindings.map(item => [item.effectId, item]));
  return {
    resolveVerificationBinding(id) {
      if (!verifications.has(id)) throw new Error(`Unknown verification: ${id}`);
      return verifications.get(id);
    },
    resolveEffectBinding(id) {
      if (!effects.has(id)) throw new Error(`Unknown effect: ${id}`);
      return effects.get(id);
    },
  };
}

function event(state, {
  eventId,
  type,
  evidenceId,
  at: eventAt,
} = {}) {
  return {
    schemaVersion: 1,
    eventId,
    deploymentId: state.deploymentId,
    previousRevision: state.revision,
    type,
    evidenceId,
    at: eventAt,
  };
}

function record(state, eventArgs, resolution) {
  return reduceDeploymentLifecycleV1(state, event(state, eventArgs), resolution).state;
}

function qualify(state = baseDeployment(), startSecond = 3) {
  const rows = [
    verificationBinding({
      verificationId: 'test-pass',
      checkKind: DeploymentCheckKind.TEST,
      verifiedAt: at(startSecond),
    }),
    verificationBinding({
      verificationId: 'a11y-pass',
      checkKind: DeploymentCheckKind.ACCESSIBILITY,
      verifiedAt: at(startSecond + 1),
    }),
    verificationBinding({
      verificationId: 'perf-pass',
      checkKind: DeploymentCheckKind.PERFORMANCE,
      verifiedAt: at(startSecond + 2),
    }),
  ];
  const resolution = resolvers(rows);
  let current = state;
  rows.forEach((row, index) => {
    current = record(current, {
      eventId: `qualify-${index}`,
      type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
      evidenceId: row.verificationId,
      at: at(startSecond + index),
    }, resolution);
  });
  return current;
}

function publish(state = qualify()) {
  const effect = committedEffect({
    effectId: 'publish-effect-1',
    artifactRef: candidate,
    startedAt: at(6),
    observedAt: at(7),
    verifiedAt: at(8),
    committedAt: at(9),
  });
  const binding = effectBinding({
    effectId: 'publish-effect-1',
    kind: DeploymentEffectKind.PUBLISH,
    artifactRef: candidate,
    state: effect,
  });
  return record(state, {
    eventId: 'publish-record',
    type: DeploymentEventType.RECORD_PUBLISH_EFFECT,
    evidenceId: 'publish-effect-1',
    at: at(10),
  }, resolvers([], [binding]));
}

test('preview requires all three independent verified quality gates before qualification', () => {
  const initial = baseDeployment();
  const testBinding = verificationBinding({
    verificationId: 'test-pass',
    checkKind: DeploymentCheckKind.TEST,
    verifiedAt: at(3),
  });
  const result = reduceDeploymentLifecycleV1(initial, event(initial, {
    eventId: 'quality-1',
    type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
    evidenceId: 'test-pass',
    at: at(3),
  }), resolvers([testBinding]));
  assert.equal(result.state.phase, DeploymentPhase.PREVIEW);
  assert.equal(result.state.publishAuthorized, false);
  assert.equal(result.state.executionAuthorized, false);

  const qualified = qualify();
  assert.equal(qualified.phase, DeploymentPhase.QUALIFIED);
  assert.equal(qualified.qualifiedAt, at(5));
  assert.equal(qualified.qualificationEvidence.length, 3);
  assert.equal(qualified.publishAuthorized, false);
});

test('publish is admitted only from a canonically COMMITTED VERIFIED exact effect bound to candidate bytes', () => {
  const qualified = qualify();
  const published = publish(qualified);
  assert.equal(published.phase, DeploymentPhase.PUBLISHED_UNVERIFIED);
  assert.equal(published.publishedAt, at(7));
  assert.equal(published.publishCommitId, 'publish-effect-1-commit-id');
  assert.equal(published.executionAuthorized, false);

  const wrongArtifact = effectBinding({
    effectId: 'publish-effect-1',
    kind: DeploymentEffectKind.PUBLISH,
    artifactRef: rollback,
    state: committedEffect({
      effectId: 'publish-effect-1',
      artifactRef: rollback,
      startedAt: at(6),
      observedAt: at(7),
      verifiedAt: at(8),
      committedAt: at(9),
    }),
  });
  assert.throws(
    () => reduceDeploymentLifecycleV1(qualified, event(qualified, {
      eventId: 'wrong-publish',
      type: DeploymentEventType.RECORD_PUBLISH_EFFECT,
      evidenceId: 'publish-effect-1',
      at: at(10),
    }), resolvers([], [wrongArtifact])),
    /artifact mismatch/,
  );
});

test('a PREPARED/noncommitted exact effect can never become publish evidence', () => {
  const qualified = qualify();
  const prepared = createExactEffectStateV1({
    schemaVersion: 1,
    invocationId: 'publish-effect-1',
    toolId: 'deployment.publish',
    providerId: 'deployment-provider',
    requestedCapabilityIds: ['deployment.write'],
    policyDecisionId: 'policy-allow-1',
    arguments: {},
    createdAt: at(6),
    parentInvocationId: null,
  });
  const binding = effectBinding({
    effectId: 'publish-effect-1',
    kind: DeploymentEffectKind.PUBLISH,
    artifactRef: candidate,
    state: prepared,
  });
  assert.throws(
    () => reduceDeploymentLifecycleV1(qualified, event(qualified, {
      eventId: 'publish-prepared',
      type: DeploymentEventType.RECORD_PUBLISH_EFFECT,
      evidenceId: 'publish-effect-1',
      at: at(7),
    }), resolvers([], [binding])),
    /canonically COMMITTED/,
  );
});

test('production is healthy only after independent SYNTHETIC and LIVE verification of exact published bytes', () => {
  let state = publish();
  const synthetic = verificationBinding({
    verificationId: 'synthetic-pass',
    checkKind: DeploymentCheckKind.SYNTHETIC,
    verifiedAt: at(11),
  });
  const live = verificationBinding({
    verificationId: 'live-pass',
    checkKind: DeploymentCheckKind.LIVE,
    verifiedAt: at(12),
  });
  const resolution = resolvers([synthetic, live]);
  state = record(state, {
    eventId: 'health-synth',
    type: DeploymentEventType.RECORD_HEALTH_VERIFICATION,
    evidenceId: synthetic.verificationId,
    at: at(11),
  }, resolution);
  assert.equal(state.phase, DeploymentPhase.PUBLISHED_UNVERIFIED);
  state = record(state, {
    eventId: 'health-live',
    type: DeploymentEventType.RECORD_HEALTH_VERIFICATION,
    evidenceId: live.verificationId,
    at: at(12),
  }, resolution);
  assert.equal(state.phase, DeploymentPhase.HEALTHY);
  assert.equal(state.lastHealthyAt, at(12));
});

test('monitor regression degrades the deployment without authorizing rollback and later fresh evidence can recover health', () => {
  let state = publish();
  const synthPass = verificationBinding({
    verificationId: 'synth-pass',
    checkKind: DeploymentCheckKind.SYNTHETIC,
    verifiedAt: at(11),
  });
  const livePass = verificationBinding({
    verificationId: 'live-pass',
    checkKind: DeploymentCheckKind.LIVE,
    verifiedAt: at(12),
  });
  const liveFail = verificationBinding({
    verificationId: 'live-fail',
    checkKind: DeploymentCheckKind.LIVE,
    status: VerificationStatus.FAILED,
    verifiedAt: at(13),
  });
  const liveRecover = verificationBinding({
    verificationId: 'live-recover',
    checkKind: DeploymentCheckKind.LIVE,
    verifiedAt: at(14),
  });
  const resolution = resolvers([synthPass, livePass, liveFail, liveRecover]);
  for (const [row, id] of [[synthPass, 'hs'], [livePass, 'hl']]) {
    state = record(state, {
      eventId: id,
      type: DeploymentEventType.RECORD_HEALTH_VERIFICATION,
      evidenceId: row.verificationId,
      at: row.verification.verifiedAt,
    }, resolution);
  }
  assert.equal(state.phase, DeploymentPhase.HEALTHY);

  state = record(state, {
    eventId: 'health-regression',
    type: DeploymentEventType.RECORD_HEALTH_VERIFICATION,
    evidenceId: liveFail.verificationId,
    at: at(13),
  }, resolution);
  assert.equal(state.phase, DeploymentPhase.DEGRADED);
  assert.equal(state.rollbackRecommended, true);
  assert.equal(state.rollbackAuthorized, false);
  assert.equal(state.regressionCount, 1);

  state = record(state, {
    eventId: 'health-recover',
    type: DeploymentEventType.RECORD_HEALTH_VERIFICATION,
    evidenceId: liveRecover.verificationId,
    at: at(14),
  }, resolution);
  assert.equal(state.phase, DeploymentPhase.HEALTHY);
  assert.equal(state.rollbackRecommended, false);
  assert.equal(state.lastHealthyAt, at(14));
});

test('rollback requires canonical committed rollback effect plus independent verification of rollback bytes', () => {
  let state = publish();
  const rollbackEffect = committedEffect({
    effectId: 'rollback-effect-1',
    artifactRef: rollback,
    startedAt: at(11),
    observedAt: at(12),
    verifiedAt: at(13),
    committedAt: at(14),
  });
  const effect = effectBinding({
    effectId: 'rollback-effect-1',
    kind: DeploymentEffectKind.ROLLBACK,
    artifactRef: rollback,
    state: rollbackEffect,
  });
  state = record(state, {
    eventId: 'rollback-publish',
    type: DeploymentEventType.RECORD_ROLLBACK_EFFECT,
    evidenceId: 'rollback-effect-1',
    at: at(15),
  }, resolvers([], [effect]));
  assert.equal(state.phase, DeploymentPhase.ROLLBACK_PUBLISHED_UNVERIFIED);
  assert.equal(state.rolledBackAt, '');

  const health = verificationBinding({
    verificationId: 'rollback-live-pass',
    checkKind: DeploymentCheckKind.ROLLBACK_LIVE,
    artifactRef: rollback,
    verifiedAt: at(16),
  });
  state = record(state, {
    eventId: 'rollback-health',
    type: DeploymentEventType.RECORD_ROLLBACK_VERIFICATION,
    evidenceId: health.verificationId,
    at: at(16),
  }, resolvers([health]));
  assert.equal(state.phase, DeploymentPhase.ROLLED_BACK);
  assert.equal(state.rolledBackAt, at(16));
  assert.equal(state.rollbackAuthorized, false);
});

test('failed rollback live verification is explicit and never misreported as rolled back', () => {
  let state = publish();
  const rollbackEffect = committedEffect({
    effectId: 'rollback-effect-1',
    artifactRef: rollback,
    startedAt: at(11),
    observedAt: at(12),
    verifiedAt: at(13),
    committedAt: at(14),
  });
  state = record(state, {
    eventId: 'rollback-effect',
    type: DeploymentEventType.RECORD_ROLLBACK_EFFECT,
    evidenceId: 'rollback-effect-1',
    at: at(15),
  }, resolvers([], [effectBinding({
    effectId: 'rollback-effect-1',
    kind: DeploymentEffectKind.ROLLBACK,
    artifactRef: rollback,
    state: rollbackEffect,
  })]));

  const failed = verificationBinding({
    verificationId: 'rollback-live-fail',
    checkKind: DeploymentCheckKind.ROLLBACK_LIVE,
    artifactRef: rollback,
    status: VerificationStatus.FAILED,
    verifiedAt: at(16),
  });
  state = record(state, {
    eventId: 'rollback-fail',
    type: DeploymentEventType.RECORD_ROLLBACK_VERIFICATION,
    evidenceId: failed.verificationId,
    at: at(16),
  }, resolvers([failed]));
  assert.equal(state.phase, DeploymentPhase.ROLLBACK_FAILED);
  assert.equal(state.rolledBackAt, '');
  assert.equal(state.rollbackRecommended, true);
  assert.equal(state.rollbackAuthorized, false);
});

test('trusted verification resolver cannot relabel project, target or artifact subject', () => {
  const initial = baseDeployment();
  for (const binding of [
    verificationBinding({
      verificationId: 'foreign-project',
      checkKind: DeploymentCheckKind.TEST,
      projectId: 'project-b',
      verifiedAt: at(3),
    }),
    verificationBinding({
      verificationId: 'foreign-target',
      checkKind: DeploymentCheckKind.TEST,
      targetId: 'production-b',
      verifiedAt: at(3),
    }),
    verificationBinding({
      verificationId: 'foreign-artifact',
      checkKind: DeploymentCheckKind.TEST,
      artifactRef: rollback,
      verifiedAt: at(3),
    }),
  ]) {
    assert.throws(
      () => reduceDeploymentLifecycleV1(initial, event(initial, {
        eventId: `event-${binding.verificationId}`,
        type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
        evidenceId: binding.verificationId,
        at: at(3),
      }), resolvers([binding])),
      /mismatch/,
    );
  }
});

test('publisher cannot self-verify and future or stale evidence fails closed', () => {
  const initial = baseDeployment();
  const self = verificationBinding({
    verificationId: 'self-check',
    checkKind: DeploymentCheckKind.TEST,
    verifierId: 'publisher-1',
    verifiedAt: at(3),
  });
  assert.throws(
    () => reduceDeploymentLifecycleV1(initial, event(initial, {
      eventId: 'self-event',
      type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
      evidenceId: self.verificationId,
      at: at(3),
    }), resolvers([self])),
    /independent/,
  );

  const future = verificationBinding({
    verificationId: 'future-check',
    checkKind: DeploymentCheckKind.TEST,
    verifiedAt: at(5),
  });
  assert.throws(
    () => reduceDeploymentLifecycleV1(initial, event(initial, {
      eventId: 'future-event',
      type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
      evidenceId: future.verificationId,
      at: at(4),
    }), resolvers([future])),
    /postdate/,
  );

  const stale = verificationBinding({
    verificationId: 'stale-check',
    checkKind: DeploymentCheckKind.TEST,
    verifiedAt: at(0),
  });
  assert.throws(
    () => reduceDeploymentLifecycleV1(initial, event(initial, {
      eventId: 'stale-event',
      type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
      evidenceId: stale.verificationId,
      at: at(3),
    }), resolvers([stale])),
    /predates candidate/,
  );
});

test('event revision fence gives immediate idempotent retry and rejects stale distinct events', () => {
  const initial = baseDeployment();
  const binding = verificationBinding({
    verificationId: 'test-pass',
    checkKind: DeploymentCheckKind.TEST,
    verifiedAt: at(3),
  });
  const firstEvent = event(initial, {
    eventId: 'event-1',
    type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
    evidenceId: binding.verificationId,
    at: at(3),
  });
  const first = reduceDeploymentLifecycleV1(initial, firstEvent, resolvers([binding]));
  const replay = reduceDeploymentLifecycleV1(first.state, firstEvent, resolvers([binding]));
  assert.equal(replay.deduplicated, true);
  assert.deepEqual(replay.state, first.state);

  assert.throws(
    () => reduceDeploymentLifecycleV1(first.state, {
      ...firstEvent,
      eventId: 'stale-distinct',
    }, resolvers([binding])),
    /previousRevision mismatch/,
  );
});

test('last-event replay is payload-bound and conflicting reuse fails before resolver work', () => {
  const initial = baseDeployment();
  const binding = verificationBinding({
    verificationId: 'test-pass',
    checkKind: DeploymentCheckKind.TEST,
    verifiedAt: at(3),
  });
  let resolverCalls = 0;
  const resolution = {
    resolveVerificationBinding(id) {
      resolverCalls += 1;
      assert.equal(id, binding.verificationId);
      return binding;
    },
    resolveEffectBinding() {
      throw new Error('effect resolver must not run');
    },
  };
  const firstEvent = event(initial, {
    eventId: 'payload-bound-event',
    type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
    evidenceId: binding.verificationId,
    at: at(3),
  });
  const first = reduceDeploymentLifecycleV1(initial, firstEvent, resolution);
  assert.equal(resolverCalls, 1);

  const replay = reduceDeploymentLifecycleV1(first.state, firstEvent, resolution);
  assert.equal(replay.deduplicated, true);
  assert.equal(resolverCalls, 1);

  for (const conflicting of [
    { ...firstEvent, evidenceId: 'different-evidence' },
    { ...firstEvent, at: at(4) },
    { ...firstEvent, type: DeploymentEventType.RECORD_HEALTH_VERIFICATION },
    { ...firstEvent, previousRevision: firstEvent.previousRevision + 1 },
  ]) {
    assert.throws(
      () => reduceDeploymentLifecycleV1(first.state, conflicting, resolution),
      /idempotency conflict/u,
    );
  }
  assert.equal(resolverCalls, 1);
});

test('publish and rollback gates bind to exact-effect occurrence time, not later commit time', () => {
  const qualified = qualify();
  const preQualificationObservation = committedEffect({
    effectId: 'publish-effect-1',
    artifactRef: candidate,
    startedAt: at(3),
    observedAt: at(4),
    verifiedAt: at(6),
    committedAt: at(7),
  });
  assert.throws(
    () => reduceDeploymentLifecycleV1(qualified, event(qualified, {
      eventId: 'publish-pre-gate-observation',
      type: DeploymentEventType.RECORD_PUBLISH_EFFECT,
      evidenceId: 'publish-effect-1',
      at: at(8),
    }), resolvers([], [effectBinding({
      effectId: 'publish-effect-1',
      kind: DeploymentEffectKind.PUBLISH,
      artifactRef: candidate,
      state: preQualificationObservation,
    })])),
    /observation predates completed qualification/u,
  );

  const preparedBeforeQualification = committedEffect({
    effectId: 'publish-effect-1',
    artifactRef: candidate,
    startedAt: at(4),
    observedAt: at(6),
    verifiedAt: at(7),
    committedAt: at(8),
  });
  const published = reduceDeploymentLifecycleV1(qualified, event(qualified, {
    eventId: 'publish-post-gate-observation',
    type: DeploymentEventType.RECORD_PUBLISH_EFFECT,
    evidenceId: 'publish-effect-1',
    at: at(9),
  }), resolvers([], [effectBinding({
    effectId: 'publish-effect-1',
    kind: DeploymentEffectKind.PUBLISH,
    artifactRef: candidate,
    state: preparedBeforeQualification,
  })])).state;
  assert.equal(published.publishedAt, at(6));

  const prePublishRollbackObservation = committedEffect({
    effectId: 'rollback-effect-1',
    artifactRef: rollback,
    startedAt: at(5),
    observedAt: at(5),
    verifiedAt: at(10),
    committedAt: at(11),
  });
  assert.throws(
    () => reduceDeploymentLifecycleV1(published, event(published, {
      eventId: 'rollback-pre-publish-observation',
      type: DeploymentEventType.RECORD_ROLLBACK_EFFECT,
      evidenceId: 'rollback-effect-1',
      at: at(12),
    }), resolvers([], [effectBinding({
      effectId: 'rollback-effect-1',
      kind: DeploymentEffectKind.ROLLBACK,
      artifactRef: rollback,
      state: prePublishRollbackObservation,
    })])),
    /observation predates current publish/u,
  );
});

test('artifact and boundary aliases fail before they can gain deployment identity', () => {
  const padded = { ...candidate, artifactId: ' release-package' };
  assert.throws(
    () => createDeploymentLifecycleV1({
      deploymentId: 'deploy-1',
      projectId: 'project-a',
      targetId: 'production-a',
      publisherId: 'publisher-1',
      candidateArtifactRef: padded,
      rollbackArtifactRef: rollback,
      publishEffectId: 'publish-effect-1',
      rollbackEffectId: 'rollback-effect-1',
      createdAt: at(2),
    }),
    /exact canonical identity/,
  );

  const upper = { ...candidate, sha256: 'A'.repeat(64) };
  assert.throws(
    () => createDeploymentLifecycleV1({
      deploymentId: 'deploy-1',
      projectId: 'project-a',
      targetId: 'production-a',
      publisherId: 'publisher-1',
      candidateArtifactRef: upper,
      rollbackArtifactRef: rollback,
      publishEffectId: 'publish-effect-1',
      rollbackEffectId: 'rollback-effect-1',
      createdAt: at(2),
    }),
    /lowercase SHA-256/,
  );

  const timeAlias = { ...candidate, createdAt: '2026-09-25T06:00:01Z' };
  assert.throws(
    () => createDeploymentLifecycleV1({
      deploymentId: 'deploy-1',
      projectId: 'project-a',
      targetId: 'production-a',
      publisherId: 'publisher-1',
      candidateArtifactRef: timeAlias,
      rollbackArtifactRef: rollback,
      publishEffectId: 'publish-effect-1',
      rollbackEffectId: 'rollback-effect-1',
      createdAt: at(2),
    }),
    /canonical ISO-8601/,
  );
});

test('input descriptor boundary rejects accessors/hidden/symbol fields without getter execution', () => {
  let getterCalls = 0;
  const input = {
    deploymentId: 'deploy-1',
    projectId: 'project-a',
    targetId: 'production-a',
    publisherId: 'publisher-1',
    candidateArtifactRef: candidate,
    rollbackArtifactRef: rollback,
    publishEffectId: 'publish-effect-1',
    rollbackEffectId: 'rollback-effect-1',
    createdAt: at(2),
  };
  Object.defineProperty(input, 'createdAt', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return at(2);
    },
  });
  assert.throws(() => createDeploymentLifecycleV1(input), /enumerable own data properties/);
  assert.equal(getterCalls, 0);

  const hidden = { ...candidate };
  Object.defineProperty(hidden, 'hiddenAuthority', { value: true, enumerable: false });
  assert.throws(
    () => createDeploymentLifecycleV1({
      deploymentId: 'deploy-1',
      projectId: 'project-a',
      targetId: 'production-a',
      publisherId: 'publisher-1',
      candidateArtifactRef: hidden,
      rollbackArtifactRef: rollback,
      publishEffectId: 'publish-effect-1',
      rollbackEffectId: 'rollback-effect-1',
      createdAt: at(2),
    }),
    /unknown field/,
  );

  const symbol = { ...candidate };
  symbol[Symbol('authority')] = true;
  assert.throws(
    () => createDeploymentLifecycleV1({
      deploymentId: 'deploy-1',
      projectId: 'project-a',
      targetId: 'production-a',
      publisherId: 'publisher-1',
      candidateArtifactRef: symbol,
      rollbackArtifactRef: rollback,
      publishEffectId: 'publish-effect-1',
      rollbackEffectId: 'rollback-effect-1',
      createdAt: at(2),
    }),
    /unknown field/,
  );
});

test('normalized state cannot be forged into authority-bearing flags or healthy status without evidence', () => {
  const state = baseDeployment();
  assert.throws(
    () => normalizeDeploymentLifecycleV1({ ...state, executionAuthorized: true }),
    /executionAuthorized is inconsistent/,
  );
  assert.throws(
    () => normalizeDeploymentLifecycleV1({
      ...state,
      phase: DeploymentPhase.HEALTHY,
    }),
    /requires all qualification gates/,
  );
});


test('publish exact-effect verifier must be independent from publisher', () => {
  const qualified = qualify();
  const effect = committedEffect({
    effectId: 'publish-effect-1',
    artifactRef: candidate,
    startedAt: at(6),
    observedAt: at(7),
    verifiedAt: at(8),
    committedAt: at(9),
  });
  const forged = structuredClone(effect);
  forged.verification.verifierId = 'publisher-1';
  const binding = effectBinding({
    effectId: 'publish-effect-1',
    kind: DeploymentEffectKind.PUBLISH,
    artifactRef: candidate,
    state: forged,
  });
  assert.throws(
    () => reduceDeploymentLifecycleV1(qualified, event(qualified, {
      eventId: 'self-verified-publish',
      type: DeploymentEventType.RECORD_PUBLISH_EFFECT,
      evidenceId: 'publish-effect-1',
      at: at(10),
    }), resolvers([], [binding])),
    /independent/,
  );
});

test('future-dated exact-effect verification cannot prove a present deployment effect', () => {
  const qualified = qualify();
  const effect = committedEffect({
    effectId: 'publish-effect-1',
    artifactRef: candidate,
    startedAt: at(6),
    observedAt: at(7),
    verifiedAt: at(8),
    committedAt: at(9),
  });
  const forged = structuredClone(effect);
  forged.verification.verifiedAt = at(20);
  const binding = effectBinding({
    effectId: 'publish-effect-1',
    kind: DeploymentEffectKind.PUBLISH,
    artifactRef: candidate,
    state: forged,
  });
  assert.throws(
    () => reduceDeploymentLifecycleV1(qualified, event(qualified, {
      eventId: 'future-effect-verification',
      type: DeploymentEventType.RECORD_PUBLISH_EFFECT,
      evidenceId: 'publish-effect-1',
      at: at(10),
    }), resolvers([], [binding])),
    /cannot postdate durable effect state/,
  );
});


test('deployment chronology uses epoch ordering across 9999 to extended year +010000', () => {
  const beforeCreate = '9999-12-31T23:59:59.900Z';
  const beforeArtifact = '9999-12-31T23:59:59.800Z';
  const afterBoundary = '+010000-01-01T00:00:00.000Z';

  const crossBoundaryCreate = createDeploymentLifecycleV1({
    deploymentId: 'deploy-boundary-create',
    projectId: 'project-a',
    targetId: 'production-a',
    publisherId: 'publisher-1',
    candidateArtifactRef: artifact(hash('c'), beforeArtifact),
    rollbackArtifactRef: artifact(hash('d'), beforeArtifact),
    publishEffectId: 'publish-effect-boundary-create',
    rollbackEffectId: 'rollback-effect-boundary-create',
    createdAt: afterBoundary,
  });
  assert.equal(crossBoundaryCreate.createdAt, afterBoundary);

  const candidateBoundary = artifact(hash('e'), '9999-12-31T23:59:59.700Z');
  const rollbackBoundary = artifact(hash('f'), '9999-12-31T23:59:59.700Z');
  let state = createDeploymentLifecycleV1({
    deploymentId: 'deploy-boundary-events',
    projectId: 'project-a',
    targetId: 'production-a',
    publisherId: 'publisher-1',
    candidateArtifactRef: candidateBoundary,
    rollbackArtifactRef: rollbackBoundary,
    publishEffectId: 'publish-effect-boundary-events',
    rollbackEffectId: 'rollback-effect-boundary-events',
    createdAt: beforeCreate,
  });

  const rows = [
    verificationBinding({
      verificationId: 'boundary-test',
      checkKind: DeploymentCheckKind.TEST,
      artifactRef: candidateBoundary,
      verifiedAt: '9999-12-31T23:59:59.950Z',
    }),
    verificationBinding({
      verificationId: 'boundary-a11y',
      checkKind: DeploymentCheckKind.ACCESSIBILITY,
      artifactRef: candidateBoundary,
      verifiedAt: '+010000-01-01T00:00:00.001Z',
    }),
    verificationBinding({
      verificationId: 'boundary-performance',
      checkKind: DeploymentCheckKind.PERFORMANCE,
      artifactRef: candidateBoundary,
      verifiedAt: '+010000-01-01T00:00:00.002Z',
    }),
  ];
  const resolution = resolvers(rows);

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    state = record(state, {
      eventId: `boundary-qualification-${index}`,
      type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
      evidenceId: row.verificationId,
      at: row.verification.verifiedAt,
    }, resolution);
  }

  assert.equal(state.phase, DeploymentPhase.QUALIFIED);
  assert.equal(state.qualifiedAt, '+010000-01-01T00:00:00.002Z');
  assert.equal(state.updatedAt, '+010000-01-01T00:00:00.002Z');

  assert.throws(
    () => reduceDeploymentLifecycleV1(state, event(state, {
      eventId: 'boundary-regressed-event',
      type: DeploymentEventType.RECORD_QUALIFICATION_VERIFICATION,
      evidenceId: rows[0].verificationId,
      at: '9999-12-31T23:59:59.999Z',
    }), resolution),
    /cannot predate durable state/u,
  );
});
