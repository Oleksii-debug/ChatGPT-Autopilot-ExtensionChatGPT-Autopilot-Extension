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
  assert.match(source, /import \{ runRuntimeCycle \} from '\.\.\/core\/runtime-execution\.js';/);
  assert.match(source, /const executor = new AutomaticSessionExecutor\(repo, chrome, transport\);/);
  assert.match(source, /executionAvailable: EXECUTION_AVAILABLE/);
});

test('startup and canonical alarm invoke the execution cycle', () => {
  assert.match(source, /onStartup\.addListener\(\(\) => \{ runSafely\(runExecutionCycle\(\{ startup: true \}\)\); \}\);/);
  assert.match(source, /alarm\.name === 'autopilot-core-wake'\) runSafely\(runExecutionCycle\(\)\)/);
});

test('production automatic execution remains fail closed until composed safety gates pass', () => {
  assert.match(source, /const EXECUTION_AVAILABLE = false;/);
  assert.doesNotMatch(source, /const EXECUTION_AVAILABLE = true;/);
});
