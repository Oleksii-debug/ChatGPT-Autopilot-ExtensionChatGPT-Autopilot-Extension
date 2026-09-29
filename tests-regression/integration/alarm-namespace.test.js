import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ALARM_NAME as CORE_ALARM } from '../../src/core/recovery.js';
import { BROWSER_AGENT_ALARM } from '../../src/core/browser-agent.js';
import { SCENARIO_WORK_ALARM } from '../../src/core/scenario-work-manager.js';
import { ORCHESTRATION_V2_ALARM } from '../../src/core/orchestration-v2-controller.js';
import { ORCHESTRATION_V2_ALARM_PREFIX } from '../../src/core/orchestration-v2-manager.js';

const serviceWorkerSource = fs.readFileSync(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');

test('core, Browser Agent, Scenario Work and per-orchestra alarms occupy disjoint namespaces', () => {
  const exact = [CORE_ALARM, BROWSER_AGENT_ALARM, SCENARIO_WORK_ALARM, ORCHESTRATION_V2_ALARM];
  assert.equal(new Set(exact).size, exact.length, 'top-level alarm names must remain unique');
  assert.ok(ORCHESTRATION_V2_ALARM_PREFIX.endsWith(':'));
  assert.ok(!exact.some(name => name.startsWith(ORCHESTRATION_V2_ALARM_PREFIX)));

  const orchestraA = `${ORCHESTRATION_V2_ALARM_PREFIX}orchestra-a`;
  const orchestraB = `${ORCHESTRATION_V2_ALARM_PREFIX}orchestra-b`;
  assert.notEqual(orchestraA, orchestraB);
  assert.ok(orchestraA.startsWith(ORCHESTRATION_V2_ALARM_PREFIX));
  assert.ok(orchestraB.startsWith(ORCHESTRATION_V2_ALARM_PREFIX));
});

test('service worker routes each alarm independently instead of using an exclusive else-if chain', () => {
  const expectedRoutes = [
    `alarm.name === '${CORE_ALARM}'`,
    'alarm.name === AI_REPORT_ALARM',
    'alarm.name === AI_MANAGER_ALARM',
    'alarm.name === BROWSER_AGENT_ALARM',
    'alarm.name === REMOTE_DISPATCH_ALARM',
    'orchestrationV2.isAlarm(alarm.name)',
    'scenarioWork.isAlarm(alarm.name)',
  ];
  for (const route of expectedRoutes) assert.match(serviceWorkerSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const alarmHandler = serviceWorkerSource.slice(serviceWorkerSource.indexOf('chrome.alarms.onAlarm.addListener'));
  assert.doesNotMatch(alarmHandler.slice(0, 1800), /else\s+if\s*\(/, 'alarm namespaces must not suppress one another through an else-if chain');
});
