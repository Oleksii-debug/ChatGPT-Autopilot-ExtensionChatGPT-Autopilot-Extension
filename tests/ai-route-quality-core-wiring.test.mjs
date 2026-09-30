import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptyState,
  validateState,
} from '../src/core/schema.js';
import {
  BenchmarkAssertionOperator,
  BenchmarkCaseOutcome,
} from '../src/core/benchmark-evaluation.js';
import {
  createAiRouteQualityEvidenceRegistryV1,
  putAiRouteQualityEvidenceRecordV1,
} from '../src/core/ai-route-quality-evidence-registry.js';
import {
  deriveAiRouteQualitySubjectRevisionIdV1,
} from '../src/core/ai-route-quality-governor.js';
import {
  AI_ROUTE_QUALITY_CORE_EVIDENCE_READER_AUTHORITY,
  createAiRouteQualityCoreEvidenceReaderV1,
} from '../src/core/ai-route-quality-core-evidence-reader.js';

const START = '2026-09-28T12:00:00.000Z';
const END = '2026-09-28T12:00:01.000Z';
const REGISTERED = '2026-09-28T12:00:02.000Z';

function route(routeId) {
  return {
    schemaVersion: 1,
    routeId,
    provider: 'ollama',
    model: 'model-' + routeId,
    roles: ['planner'],
    capabilityIds: [],
    priority: 0,
    enabled: true,
    locality: 'local',
    costClass: 'free',
    supportsVision: false,
    maxWorkers: 0,
  };
}

async function benchmarkBinding(routeValue) {
  const routeId = routeValue.routeId;
  const suiteId = 'route-quality-core';
  const suiteRevisionId = 'suite-core-1';
  const runId = 'run-' + routeId;
  const subjectRevisionId = await deriveAiRouteQualitySubjectRevisionIdV1(routeValue);
  const invocationId = 'benchmark-' + routeId;
  const artifactId = 'evidence-' + routeId;
  const result = {
    caseId: 'quality',
    outcome: BenchmarkCaseOutcome.MEASURED,
    metrics: { score: 1 },
    evidenceArtifactIds: [artifactId],
  };
  return {
    routeId,
    maxAgeMs: 60_000,
    evaluationRequest: {
      suite: {
        schemaVersion: 1,
        suiteId,
        suiteRevisionId,
        title: 'Route quality core wiring',
        cases: [{
          caseId: 'quality',
          title: 'Quality threshold',
          assertions: [{
            metricId: 'score',
            operator: BenchmarkAssertionOperator.AT_LEAST,
            threshold: 1,
          }],
        }],
      },
      run: {
        schemaVersion: 1,
        runId,
        suiteId,
        suiteRevisionId,
        subjectId: routeId,
        subjectRevisionId,
        startedAt: START,
        completedAt: END,
        results: [structuredClone(result)],
      },
      expectedSubject: { subjectId: routeId, subjectRevisionId },
      trustedExecution: {
        runId,
        suiteId,
        suiteRevisionId,
        subjectId: routeId,
        subjectRevisionId,
        producerInvocationId: invocationId,
        startedAt: START,
        completedAt: END,
        results: [structuredClone(result)],
      },
      trustedEvidenceArtifacts: [{
        schemaVersion: 1,
        artifactId,
        kind: 'benchmark-evidence',
        uri: 'artifact://benchmark/' + artifactId,
        mediaType: 'application/json',
        sha256: '1'.repeat(64),
        sizeBytes: 1,
        createdAt: END,
        producerInvocationId: invocationId,
        sensitive: false,
      }],
    },
  };
}

test('canonical Core state owns an empty validated route-quality evidence registry', () => {
  const state = createEmptyState(1);
  assert.deepEqual(state.profile.aiRouteQualityEvidenceRegistry, {
    schemaVersion: 1,
    revision: 0,
    records: [],
  });
  assert.equal(validateState(state), state);
});

test('legacy schema-v2 state without route-quality evidence remains valid', () => {
  const state = createEmptyState(1);
  delete state.profile.aiRouteQualityEvidenceRegistry;
  assert.equal(validateState(state), state);
});

test('corrupt advisory route-quality evidence cannot make the entire Core state unloadable', () => {
  const state = createEmptyState(1);
  state.profile.aiRouteQualityEvidenceRegistry = {
    schemaVersion: 1,
    revision: 1,
    records: [],
  };
  assert.equal(validateState(state), state);
});

test('Core evidence reader re-loads canonical state for every lookup and never gains write authority', async () => {
  const emptyState = createEmptyState(1);
  const routeA = route('route-a');
  const populatedState = createEmptyState(2);
  populatedState.profile.aiRouteQualityEvidenceRegistry =
    await putAiRouteQualityEvidenceRecordV1(
      createAiRouteQualityEvidenceRegistryV1(),
      {
        route: routeA,
        benchmarkRequest: await benchmarkBinding(routeA),
        registeredAt: REGISTERED,
      },
    );

  let loads = 0;
  const repository = {
    async load() {
      loads += 1;
      return structuredClone(loads === 1 ? emptyState : populatedState);
    },
  };
  const read = createAiRouteQualityCoreEvidenceReaderV1({ repository });

  const first = await read({ routeIds: ['route-a'] });
  const second = await read({ routeIds: ['route-a'] });

  assert.deepEqual(first, []);
  assert.equal(second.length, 1);
  assert.equal(second[0].routeId, 'route-a');
  assert.equal(second[0].evaluationRequest.run.runId, 'run-route-a');
  assert.equal(loads, 2);
  assert.equal(read.authority, AI_ROUTE_QUALITY_CORE_EVIDENCE_READER_AUTHORITY);
  assert.equal(read.authority.readOnly, true);
  assert.equal(read.authority.evidenceLookupAuthorized, true);
  assert.equal(read.authority.evidenceAppendAuthorized, false);
  assert.equal(read.authority.benchmarkExecutionAuthorized, false);
  assert.equal(read.authority.routeSelectionAuthorized, false);
  assert.equal(read.authority.dispatchAuthorized, false);
});

test('Core evidence reader validates persisted registry even behind a noncanonical repository double', async () => {
  const repository = {
    async load() {
      return {
        profile: {
          aiRouteQualityEvidenceRegistry: {
            schemaVersion: 1,
            revision: 1,
            records: [],
          },
        },
      };
    },
  };
  const read = createAiRouteQualityCoreEvidenceReaderV1({ repository });
  await assert.rejects(
    read({ routeIds: ['route-a'] }),
    /revision must equal append-only record count/u,
  );
});

test('Core evidence reader factory rejects extra authority surfaces', () => {
  assert.throws(
    () => createAiRouteQualityCoreEvidenceReaderV1({
      repository: { load: async () => createEmptyState(1) },
      appendEvidence: async () => {},
    }),
    /contains unknown field: appendEvidence/u,
  );
});
