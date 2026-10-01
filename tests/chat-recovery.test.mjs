import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatRecoveryAction,
  planChatRecovery,
} from '../src/core/chat-recovery.js';

test('frozen Scenario tab enters bounded canonical recovery instead of waiting until response timeout', () => {
  const frozen = {
    status: 'TEMPORARY_ERROR',
    safeDiagnosticCode: 'ASSISTANT_RESPONSE_TAB_FROZEN',
    recoveryCategory: 'TAB_FROZEN',
    recoveryErrorLabel: 'Scenario conversation tab was frozen by Chrome',
    retryAvailable: false,
  };
  const first = planChatRecovery(null, frozen, 1_000, {
    retryAttempts: 1,
    reloadAttempts: 1,
    reopenAttempts: 1,
    cooldownMs: 30_000,
    requireCompletedResponse: true,
  });
  assert.equal(first.action, ChatRecoveryAction.SAME_URL_RELOAD);
  assert.equal(first.state.reloadAttempts, 1);

  const cooldown = planChatRecovery(first.state, frozen, 2_000, {
    retryAttempts: 1,
    reloadAttempts: 1,
    reopenAttempts: 1,
    cooldownMs: 30_000,
    requireCompletedResponse: true,
  });
  assert.equal(cooldown.action, ChatRecoveryAction.WAIT);

  const second = planChatRecovery(first.state, frozen, 31_001, {
    retryAttempts: 1,
    reloadAttempts: 1,
    reopenAttempts: 1,
    cooldownMs: 30_000,
    requireCompletedResponse: true,
  });
  assert.equal(second.action, ChatRecoveryAction.SAME_URL_REOPEN);
  assert.equal(second.state.reopenAttempts, 1);

  const exhausted = planChatRecovery(second.state, frozen, 61_002, {
    retryAttempts: 1,
    reloadAttempts: 1,
    reopenAttempts: 1,
    cooldownMs: 30_000,
    requireCompletedResponse: true,
  });
  assert.equal(exhausted.action, ChatRecoveryAction.RECOVERY_FAILED);
  assert.equal(exhausted.exhausted, true);
});

test('successful completed reply clears frozen-tab recovery ledger', () => {
  const frozen = {
    safeDiagnosticCode: 'ASSISTANT_RESPONSE_TAB_FROZEN',
    recoveryCategory: 'TAB_FROZEN',
    retryAvailable: false,
  };
  const started = planChatRecovery(null, frozen, 10_000, {
    reloadAttempts: 1,
    reopenAttempts: 1,
    cooldownMs: 30_000,
    requireCompletedResponse: true,
  });
  const complete = planChatRecovery(started.state, {
    status: 'READY',
    assistantComplete: true,
    safeDiagnosticCode: 'ASSISTANT_RESPONSE_READY',
  }, 12_000, {
    reloadAttempts: 1,
    reopenAttempts: 1,
    cooldownMs: 30_000,
    requireCompletedResponse: true,
  });
  assert.equal(complete.action, ChatRecoveryAction.RECOVERY_SUCCESS);
});
