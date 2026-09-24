import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ControlActionType,
  applyControlDecision,
  createOrchestrationRuntime,
  normalizeOrchestrationRuntime,
  orchestrationSnapshot,
  validateOrchestrationConfig,
} from '../src/core/orchestration-v2.js';

const NOW = Date.parse('2026-09-24T16:20:00Z');
const BASE = {
  projectId: 'proj',
  targetRepository: 'owner/repo',
  controlRepository: 'owner/repo',
  controlIssueNumber: 150,
  defaultDesiredWorkers: 3,
  absoluteMaxWorkers: 8,
};

function control(value, revision = 1) {
  return {
    schema_version: 2,
    project_id: 'proj',
    revision,
    coordinator_generation: 1,
    generated_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(),
    mode: 'RUN',
    actions: [{ type: ControlActionType.SET_DESIRED_CONCURRENCY, value }],
  };
}

test('owner fixed concurrency defaults off for backward compatibility', () => {
  const config = validateOrchestrationConfig(BASE);
  assert.equal(config.ownerFixedDesiredWorkers, false);
});

test('owner fixed concurrency restores owner desired count during normalization', () => {
  const config = { ...BASE, ownerFixedDesiredWorkers: true };
  const runtime = createOrchestrationRuntime(config, NOW);
  runtime.desiredActiveWorkers = 7;
  const normalized = normalizeOrchestrationRuntime(runtime, config, NOW + 1);
  assert.equal(normalized.desiredActiveWorkers, 3);
  assert.equal(orchestrationSnapshot(normalized, config).ownerFixedDesiredWorkers, true);
});

test('owner fixed concurrency records coordinator request without changing effective desired workers', () => {
  const config = { ...BASE, ownerFixedDesiredWorkers: true };
  const runtime = createOrchestrationRuntime(config, NOW);
  const { result } = applyControlDecision(runtime, control(7), config, NOW + 1, { consumeCoordinatorLease: false, source: 'test' });
  assert.equal(runtime.lastRequestedDesiredWorkers, 7);
  assert.equal(runtime.desiredActiveWorkers, 3);
  assert.equal(result.concurrencyChanged, false);
  assert.match(result.notes.join('\n'), /Owner-fixed worker count retained at 3/);
});

test('adaptive concurrency remains unchanged when owner fixed mode is off', () => {
  const runtime = createOrchestrationRuntime(BASE, NOW);
  const { result } = applyControlDecision(runtime, control(7), BASE, NOW + 1, { consumeCoordinatorLease: false, source: 'test' });
  assert.equal(runtime.lastRequestedDesiredWorkers, 7);
  assert.equal(runtime.desiredActiveWorkers, 7);
  assert.equal(result.concurrencyChanged, true);
});

test('options UI persists and renders owner fixed worker policy', async () => {
  const [html, js] = await Promise.all([
    readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="orchestration-v2-owner-fixed-workers"/);
  assert.match(js, /ownerFixedDesiredWorkers: \$\('orchestration-v2-owner-fixed-workers'\)\.checked/);
  assert.match(js, /\$\('orchestration-v2-owner-fixed-workers'\)\.checked = config\.ownerFixedDesiredWorkers === true/);
});
