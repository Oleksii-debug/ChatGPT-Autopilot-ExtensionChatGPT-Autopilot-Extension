import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MobileAskDecision,
  MobileInputMethod,
  MobileJobState,
  MobileNotificationKind,
  MobileQuickIntentKind,
  normalizeMobileQuickControlIntentV1,
  projectMobileQuickControlStatusV1,
} from '../src/core/mobile-quick-control.js';

const T0 = '2026-09-25T06:00:00.000Z';
const T1 = '2026-09-25T06:05:00.000Z';

function common(kind, inputMethod = MobileInputMethod.KEYBOARD) {
  return {
    schemaVersion: 1,
    intentId: 'intent-1',
    kind,
    inputMethod,
    sourcePrincipalId: 'owner-1',
    sourceDeviceId: 'device-1',
    sourceSessionId: 'session-1',
    policyEnvelopeId: 'policy-1',
    issuedAt: T0,
    expiresAt: T1,
  };
}

function steering(kind, inputMethod = MobileInputMethod.KEYBOARD) {
  return {
    ...common(kind, inputMethod),
    jobId: 'job-1',
    planId: 'plan-1',
    expectedJobRevision: 7,
    expectedPlanRevision: 4,
  };
}

function statusInput() {
  return {
    schemaVersion: 1,
    projectionId: 'projection-1',
    generatedAt: T1,
    jobs: [
      {
        jobId: 'job-b',
        planId: 'plan-b',
        projectId: 'project-1',
        jobRevision: 3,
        planRevision: 2,
        policyEnvelopeId: 'policy-b',
        state: MobileJobState.PAUSED,
        label: 'Другий агент',
        attentionCount: 1,
        observedAt: T0,
      },
      {
        jobId: 'job-a',
        planId: 'plan-a',
        projectId: '',
        jobRevision: 8,
        planRevision: 5,
        policyEnvelopeId: 'policy-a',
        state: MobileJobState.RUNNING,
        label: 'Перший агент',
        attentionCount: 0,
        observedAt: T0,
      },
    ],
    notifications: [
      {
        notificationId: 'notification-b',
        jobId: 'job-b',
        kind: MobileNotificationKind.ASK,
        label: 'Потрібне рішення',
        observedAt: T0,
        supervisionId: 'supervision-1',
      },
      {
        notificationId: 'notification-a',
        jobId: 'job-a',
        kind: MobileNotificationKind.ATTENTION,
        label: 'Потрібна увага',
        observedAt: T0,
        supervisionId: '',
      },
    ],
  };
}

test('voice pause maps exactly to canonical remote steering shape without gaining authority', () => {
  const result = normalizeMobileQuickControlIntentV1(steering(MobileQuickIntentKind.PAUSE, MobileInputMethod.VOICE));
  assert.equal(result.semanticAction, 'PAUSE');
  assert.equal(result.nonVoiceEquivalent, true);
  assert.deepEqual(result.remoteSteeringCommand, {
    schemaVersion: 1,
    commandId: 'intent-1',
    action: 'PAUSE',
    jobId: 'job-1',
    planId: 'plan-1',
    expectedJobRevision: 7,
    expectedPlanRevision: 4,
    policyEnvelopeId: 'policy-1',
    sourcePrincipalId: 'owner-1',
    sourceDeviceId: 'device-1',
    sourceSessionId: 'session-1',
    issuedAt: T0,
    expiresAt: T1,
  });
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.permissionGranted, false);
  assert.equal(result.sourceAuthenticated, false);
  assert.equal(result.requiresCanonicalPrincipalAuthentication, true);
  assert.equal(result.requiresFreshStateRecheck, true);
});

test('resume and stop map to the existing remote steering actions', () => {
  for (const kind of [MobileQuickIntentKind.RESUME, MobileQuickIntentKind.STOP]) {
    const result = normalizeMobileQuickControlIntentV1(steering(kind));
    assert.equal(result.remoteSteeringCommand.action, kind);
    assert.equal(result.remoteSteeringCommand.commandId, 'intent-1');
  }
});

test('quick task creation is only an Agent admission proposal', () => {
  const result = normalizeMobileQuickControlIntentV1({
    ...common(MobileQuickIntentKind.CREATE_TASK, MobileInputMethod.TOUCH),
    projectId: 'project-1',
    taskGoal: 'Перевірити стан сайту і сформувати звіт.',
  });
  assert.equal(result.remoteSteeringCommand, null);
  assert.equal(result.taskProposal.goal, 'Перевірити стан сайту і сформувати звіт.');
  assert.equal(result.taskProposal.requiresCanonicalAgentAdmission, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.nonVoiceEquivalent, true);
});

test('ASK response is bounded proposal to canonical HumanSupervision/Approval authorities', () => {
  const result = normalizeMobileQuickControlIntentV1({
    ...common(MobileQuickIntentKind.RESOLVE_ASK, MobileInputMethod.VOICE),
    jobId: 'job-1',
    planId: 'plan-1',
    expectedJobRevision: 7,
    expectedPlanRevision: 4,
    supervisionId: 'supervision-1',
    responseId: 'response-1',
    decision: MobileAskDecision.APPROVE,
    choiceId: '',
    clarificationText: '',
    reasonCode: 'owner-approved',
  });
  assert.equal(result.supervisionProposal.decision, MobileAskDecision.APPROVE);
  assert.equal(result.supervisionProposal.requiresCanonicalHumanSupervisionResolution, true);
  assert.equal(result.supervisionProposal.requiresCanonicalApprovalResolution, true);
  assert.equal(result.permissionGranted, false);
  assert.equal(result.nonVoiceEquivalent, true);
});

test('ASK SELECT and FREE_TEXT payloads are exact and mutually exclusive', () => {
  const base = {
    ...common(MobileQuickIntentKind.RESOLVE_ASK),
    jobId: 'job-1', planId: 'plan-1', expectedJobRevision: 1, expectedPlanRevision: 1,
    supervisionId: 'supervision-1', responseId: 'response-1', reasonCode: 'owner-response',
  };
  const selected = normalizeMobileQuickControlIntentV1({
    ...base, decision: MobileAskDecision.SELECT, choiceId: 'choice-a', clarificationText: '',
  });
  assert.equal(selected.supervisionProposal.choiceId, 'choice-a');
  assert.throws(() => normalizeMobileQuickControlIntentV1({
    ...base, decision: MobileAskDecision.SELECT, choiceId: '', clarificationText: '',
  }), /requires choiceId/);

  const free = normalizeMobileQuickControlIntentV1({
    ...base, decision: MobileAskDecision.FREE_TEXT, choiceId: '', clarificationText: 'Уточнення власника',
  });
  assert.equal(free.supervisionProposal.clarificationText, 'Уточнення власника');
  assert.throws(() => normalizeMobileQuickControlIntentV1({
    ...base, decision: MobileAskDecision.APPROVE, choiceId: 'choice-a', clarificationText: '',
  }), /only valid for SELECT/);
});

test('intent kind cannot smuggle payload fields from another authority path', () => {
  assert.throws(() => normalizeMobileQuickControlIntentV1({
    ...steering(MobileQuickIntentKind.PAUSE), taskGoal: 'smuggled',
  }), /does not allow field taskGoal/);
  assert.throws(() => normalizeMobileQuickControlIntentV1({
    ...common(MobileQuickIntentKind.CREATE_TASK), projectId: '', taskGoal: 'Task', jobId: 'job-1',
  }), /does not allow field jobId/);
});

test('intent TTL and timestamp representation fail closed', () => {
  const alias = steering(MobileQuickIntentKind.STOP);
  alias.issuedAt = '2026-09-25T06:00:00Z';
  assert.throws(() => normalizeMobileQuickControlIntentV1(alias), /canonical ISO-8601/);

  const reversed = steering(MobileQuickIntentKind.STOP);
  reversed.expiresAt = '2026-09-25T05:59:59.000Z';
  assert.throws(() => normalizeMobileQuickControlIntentV1(reversed), /expiry must follow issuance/);

  const long = steering(MobileQuickIntentKind.STOP);
  long.expiresAt = '2026-09-25T06:15:00.001Z';
  assert.throws(() => normalizeMobileQuickControlIntentV1(long), /TTL exceeds/);
});

test('mobile status projection is deterministic, keyboard reachable and has non-voice semantic twins', () => {
  const result = projectMobileQuickControlStatusV1(statusInput());
  assert.deepEqual(result.jobs.map(job => [job.focusOrdinal, job.jobId]), [[1, 'job-a'], [2, 'job-b']]);
  assert.deepEqual(result.jobs[0].controls, [MobileQuickIntentKind.PAUSE, MobileQuickIntentKind.STOP]);
  assert.deepEqual(result.jobs[1].controls, [MobileQuickIntentKind.RESUME, MobileQuickIntentKind.STOP]);
  assert.deepEqual(result.notifications.map(item => item.notificationId), ['notification-a', 'notification-b']);
  assert.equal(result.notifications[1].semanticAction, MobileQuickIntentKind.RESOLVE_ASK);
  assert.deepEqual(result.globalControls, [MobileQuickIntentKind.CREATE_TASK]);
  assert.equal(result.semanticControlOrder, 'LINEAR');
  assert.equal(result.voiceOptional, true);
  assert.equal(result.nonVoiceEquivalent, true);
  assert.equal(result.keyboardReachable, true);
  assert.equal(result.executionAuthorized, false);
});

test('WAITING status cannot offer RESUME before the blocking ASK or permission is resolved', () => {
  const input = statusInput();
  input.jobs[0].state = MobileJobState.WAITING;
  const result = projectMobileQuickControlStatusV1(input);
  const waiting = result.jobs.find(job => job.jobId === 'job-b');
  assert.deepEqual(waiting.controls, [MobileQuickIntentKind.STOP]);
  const ask = result.notifications.find(item => item.jobId === 'job-b');
  assert.equal(ask.semanticAction, MobileQuickIntentKind.RESOLVE_ASK);
});

test('status schema refuses evidence/secret fields and dangling notifications', () => {
  const secret = statusInput();
  secret.jobs[0].credentialRef = 'secret-ref';
  assert.throws(() => projectMobileQuickControlStatusV1(secret), /unknown field/);

  const evidence = statusInput();
  evidence.notifications[0].evidence = 'raw evidence';
  assert.throws(() => projectMobileQuickControlStatusV1(evidence), /unknown field/);

  const dangling = statusInput();
  dangling.notifications[0].jobId = 'missing-job';
  assert.throws(() => projectMobileQuickControlStatusV1(dangling), /unknown jobId/);
});

test('status duplicates, future observations and ASK binding are rejected', () => {
  const duplicateJob = statusInput();
  duplicateJob.jobs[1].jobId = duplicateJob.jobs[0].jobId;
  assert.throws(() => projectMobileQuickControlStatusV1(duplicateJob), /duplicate mobile status jobId/);

  const duplicateNotification = statusInput();
  duplicateNotification.notifications[1].notificationId = duplicateNotification.notifications[0].notificationId;
  assert.throws(() => projectMobileQuickControlStatusV1(duplicateNotification), /duplicate notificationId/);

  const future = statusInput();
  future.jobs[0].observedAt = '2026-09-25T06:05:00.001Z';
  assert.throws(() => projectMobileQuickControlStatusV1(future), /postdates generatedAt/);

  const ask = statusInput();
  ask.notifications[0].supervisionId = '';
  assert.throws(() => projectMobileQuickControlStatusV1(ask), /ASK requires supervisionId/);
});

test('accessors and exotic records fail without executing getters', () => {
  let reads = 0;
  const intent = steering(MobileQuickIntentKind.PAUSE);
  Object.defineProperty(intent, 'jobId', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return 'job-1'; },
  });
  assert.throws(() => normalizeMobileQuickControlIntentV1(intent), /enumerable own data properties/);
  assert.equal(reads, 0);

  const exotic = steering(MobileQuickIntentKind.PAUSE);
  Object.setPrototypeOf(exotic, { authority: 'ALLOW' });
  assert.throws(() => normalizeMobileQuickControlIntentV1(exotic), /plain data object/);
});

test('status arrays are descriptor-snapshotted without ordinary Proxy reads', () => {
  let reads = 0;
  const wrap = value => new Proxy(value, {
    get(target, property, receiver) { reads += 1; return Reflect.get(target, property, receiver); },
  });
  const input = statusInput();
  input.jobs = wrap(input.jobs);
  input.notifications = wrap(input.notifications);
  const result = projectMobileQuickControlStatusV1(input);
  assert.equal(result.jobCount, 2);
  assert.equal(reads, 0);
});

test('null-prototype intent and status records are accepted as data-only inputs', () => {
  const intent = Object.assign(Object.create(null), steering(MobileQuickIntentKind.RESUME));
  const normalized = normalizeMobileQuickControlIntentV1(intent);
  assert.equal(normalized.remoteSteeringCommand.action, 'RESUME');

  const input = statusInput();
  input.jobs[0] = Object.assign(Object.create(null), input.jobs[0]);
  const request = Object.assign(Object.create(null), input);
  const projected = projectMobileQuickControlStatusV1(request);
  assert.equal(projected.jobCount, 2);
});
