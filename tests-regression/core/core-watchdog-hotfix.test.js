import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('core keeps a periodic fallback watchdog beside the precise one-shot alarm', async () => {
  const source = await readFile(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /CORE_WATCHDOG_ALARM = 'autopilot-core-watchdog'/u);
  assert.match(source, /CORE_WATCHDOG_PERIOD_MINUTES = 0\.5/u);
  assert.match(source, /periodInMinutes: CORE_WATCHDOG_PERIOD_MINUTES/u);
  assert.match(source, /if \(alarm\.name === CORE_WATCHDOG_ALARM\) runSafely\(runExecutionCycle\(\)\)/u);
  assert.match(source, /reconcileCoreWatchdog\(coreRecovery\.state\)/u);
});
