import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../../src/background/service-worker.js'), 'utf8');

test('service worker owns a real runtime-cycle wiring behind the release gate', () => {
  assert.match(source, /import \{ AutomaticSessionExecutor \} from '\.\.\/core\/automatic-executor\.js';/);
  assert.match(source, /import \{ ChromeInteractionTransport \} from '\.\.\/core\/interaction-transport\.js';/);
  assert.match(source, /import \{ reconcileRuntimeColdStart, runRuntimeCycle \} from '\.\.\/core\/runtime-execution\.js';/);
  assert.match(source, /const executor = new AutomaticSessionExecutor\(repo, chrome, transport\);/);
  assert.match(source, /executionAvailable: EXECUTION_AVAILABLE/);
});

test('cold worker load reconciles durable state without executing a Session', () => {
  assert.match(source, /const coldStartBarrier = reconcileRuntimeColdStart\(\{/);
  assert.match(source, /await ensureColdStartReconciled\(\);/);
  assert.doesNotMatch(
    source,
    /\nrunSafely\(runExecutionCycle\(\)\);\s*$/,
    'module evaluation must not launch an executor cycle',
  );
});

test('startup and canonical alarm invoke the event-driven execution cycle', () => {
  assert.match(source, /onInstalled\.addListener\(\(\) => \{ runSafely\(runExecutionCycle\(\)\); \}\);/);
  assert.match(source, /onStartup\.addListener\(\(\) => \{ runSafely\(runExecutionCycle\(\)\); \}\);/);
  assert.match(source, /alarm\.name === 'autopilot-core-wake'\) runSafely\(runExecutionCycle\(\)\)/);
});

test('overlapping wake events share one in-flight execution cycle', () => {
  assert.match(source, /let executionCycleInFlight = null;/);
  assert.match(source, /if \(executionCycleInFlight\) return executionCycleInFlight;/);
  assert.match(source, /executionCycleInFlight = cycle\.then\(/);
});

test('production automatic execution remains fail closed until composed safety gates pass', () => {
  assert.match(source, /const EXECUTION_AVAILABLE = false;/);
  assert.doesNotMatch(source, /const EXECUTION_AVAILABLE = true;/);
});
