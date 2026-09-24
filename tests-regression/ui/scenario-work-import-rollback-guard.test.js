import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScenarioWorkRollback,
  scenarioWorkRollbackTruthMessage,
} from '../../src/ui/scenario-work-import-rollback-guard.js';

test('pending Scenario Work delete is residual, never verified rollback', () => {
  const result = classifyScenarioWorkRollback(['existing'], {
    scenarios: [
      { id: 'existing', name: 'Existing', runtime: { runState: 'STOPPED' } },
      { id: 'partial-1', name: 'Partial', runtime: { runState: 'STOPPED', deletePending: true } },
    ],
  });

  assert.equal(result.status, 'RESIDUAL');
  assert.deepEqual(result.residuals.map(item => item.id), ['partial-1']);
  const message = scenarioWorkRollbackTruthMessage(result, 'start failed');
  assert.match(message, /rollback НЕ завершено/);
  assert.match(message, /partial-1/);
  assert.match(message, /deletePending/);
  assert.doesNotMatch(message, /часткових сценаріїв не залишилося/);
});

test('failed STOP or DELETE that leaves a running imported scenario is surfaced', () => {
  const result = classifyScenarioWorkRollback([], {
    scenarios: [
      { id: 'partial-running', name: 'Still running', runtime: { runState: 'RUNNING' } },
    ],
  });

  assert.equal(result.status, 'RESIDUAL');
  const message = scenarioWorkRollbackTruthMessage(result, 'transport failed');
  assert.match(message, /partial-running/);
  assert.match(message, /RUNNING/);
  assert.match(message, /Перевірте\/видаліть/);
});

test('rollback is called verified only after follow-up list proves no new scenario remains', () => {
  const result = classifyScenarioWorkRollback(['existing'], {
    scenarios: [{ id: 'existing', name: 'Existing', runtime: { runState: 'STOPPED' } }],
  });

  assert.equal(result.status, 'VERIFIED_REMOVED');
  assert.equal(result.residuals.length, 0);
  assert.match(scenarioWorkRollbackTruthMessage(result, 'create failed'), /rollback перевірено/);
});

test('missing pre-import baseline fails closed as ambiguous', () => {
  const result = classifyScenarioWorkRollback(null, { scenarios: [] });
  assert.equal(result.status, 'AMBIGUOUS');
  assert.match(scenarioWorkRollbackTruthMessage(result, 'baseline unavailable'), /НЕ ПІДТВЕРДЖЕНО/);
});
