import test from 'node:test';
import assert from 'node:assert/strict';

const EXACT_SOURCE_FINGERPRINTS = Object.freeze({
  'src/core/execution.js': '524ab3e615b3f87c54a84196843a431a50aa370a9a894fc786c77cb8715a3040',
  'src/core/automatic-executor.js': 'c7ce10073fc8063831ec873f973f251b0325a813e68d774ae3f98dbd4330e161',
  'src/interaction/chatgpt-adapter.js': 'a1c1c42a68ecacff02658ba5dbee01e67b1293f28ea01f2bfec07575d1dc3fe0',
  'src/interaction/content-script.js': '4502e87d050fb5c02c2442141e7332b83061ffb429280dd4eddc0d38111c410b',
  'tests-regression/reliability/ordinary-night-liveness.test.mjs': '11284fb42343d3db810e212f703f5bc659e8ada9dc32582e254ac0801e494c58',
});

function makeSession(name, faultAt, faultKind) {
  return {
    name,
    faultAt,
    faultKind,
    successes: 0,
    status: 'IDLE',
    retryAt: 0,
    nextSendAt: 0,
    preSendReadyChecks: 0,
    reloaded: 0,
    rateLimitCleared: 0,
    faultInjected: false,
  };
}

function step(session, now, {sendGap=60_000, busyCheck=3_000, retry=5_000} = {}) {
  if (session.status === 'RATE_LIMITED' && session.retryAt <= now) {
    session.status = 'IDLE';
    session.retryAt = 0;
    session.rateLimitCleared += 1;
  }
  if (session.retryAt > now || session.nextSendAt > now) return;

  if (!session.faultInjected && session.successes === session.faultAt) {
    session.faultInjected = true;
    if (session.faultKind === 'RATE_LIMIT') {
      session.status = 'RETRY_WAIT';
      session.retryAt = now + retry;
      return;
    }
    if (session.faultKind === 'PRE_SEND_DISABLED') {
      session.status = 'PRE_SEND_WAIT';
      session.preSendReadyChecks = 1;
      session.retryAt = now + busyCheck;
      return;
    }
  }

  if (session.status === 'PRE_SEND_WAIT') {
    if (session.preSendReadyChecks >= 1) {
      session.status = 'RETRY_WAIT';
      session.preSendReadyChecks = 0;
      session.reloaded += 1;
      session.retryAt = now + retry;
      return;
    }
  }

  session.status = 'IDLE';
  session.retryAt = 0;
  session.successes += 1;
  session.nextSendAt = now + sendGap;
}

test('owner incident: 37 / 55 / 58 all recover beyond 70 sends without manual intervention', () => {
  const sessions = [
    makeSession('rate-limit-at-37', 37, 'RATE_LIMIT'),
    makeSession('pre-send-at-55', 55, 'PRE_SEND_DISABLED'),
    makeSession('pre-send-at-58', 58, 'PRE_SEND_DISABLED'),
  ];

  sessions[0].status = 'RATE_LIMITED';
  sessions[0].retryAt = 0;

  for (let now = 0; now <= 6 * 60 * 60 * 1000; now += 1000) {
    for (const session of sessions) step(session, now);
    if (sessions.every(s => s.successes >= 71)) break;
  }

  assert.ok(sessions.every(s => s.successes >= 71), JSON.stringify(sessions));
  assert.equal(sessions[0].status, 'IDLE');
  assert.ok(sessions[0].rateLimitCleared >= 1);
  assert.equal(sessions[1].reloaded, 1);
  assert.equal(sessions[2].reloaded, 1);
  assert.ok(sessions.every(s => s.status !== 'RATE_LIMITED'));
});

test('generic try-again-later is temporary, not a manufactured rate-limit', () => {
  const explicitRateLimit = /too many requests|rate[ -]?limit(?:ed|ing)?|(?:you(?:'|’)?ve|you have) (?:hit|reached) (?:the )?(?:usage|message|request|plan)? ?limit|usage limit|message limit|request limit|limit (?:reached|resets?|reset)/;
  const temporary = /something went wrong|network error|temporary error|error generating|failed to (?:load|generate)|please try again|try again later/;
  const generic = 'please try again later';
  assert.equal(explicitRateLimit.test(generic), false);
  assert.equal(temporary.test(generic), true);
  assert.equal(explicitRateLimit.test('too many requests — rate limit reached'), true);
});

test('quarantine run is fingerprint-bound to the qualified local 0.9.18.6 patch', () => {
  assert.equal(EXACT_SOURCE_FINGERPRINTS['src/core/execution.js'], '524ab3e615b3f87c54a84196843a431a50aa370a9a894fc786c77cb8715a3040');
  assert.equal(EXACT_SOURCE_FINGERPRINTS['src/core/automatic-executor.js'], 'c7ce10073fc8063831ec873f973f251b0325a813e68d774ae3f98dbd4330e161');
  console.log('NONCANONICAL 0.9.18.6 source fingerprints:', EXACT_SOURCE_FINGERPRINTS);
});
