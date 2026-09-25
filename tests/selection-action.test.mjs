import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SelectionActionOperation,
  SelectionActionSourceKind,
  normalizeSelectionActionRequestV1,
  normalizeSelectionActionSourceV1,
  selectionActionNeedsEffectAdmissionV1,
} from '../src/core/selection-action.js';

const SHA = 'a'.repeat(64);
const NOW = '2026-09-24T23:56:00.000Z';

function selectionSource(overrides = {}) {
  return {
    schemaVersion: 1,
    sourceId: 'source-selection-1',
    kind: 'SELECTION',
    capturedAt: NOW,
    text: 'Selected owner-visible text.',
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: 'micro-1',
    source: selectionSource(),
    operation: 'SUMMARIZE',
    ownerInstruction: 'Summarize this selection.',
    target: {},
    createdAt: NOW,
    ...overrides,
  };
}

test('normalizes read-only selection action without granting authority', () => {
  const normalized = normalizeSelectionActionRequestV1(request());
  assert.equal(normalized.operation, SelectionActionOperation.SUMMARIZE);
  assert.equal(normalized.source.kind, SelectionActionSourceKind.SELECTION);
  assert.equal(normalized.source.capturedContentIsUntrusted, true);
  assert.equal(normalized.source.instructionAuthority, false);
  assert.equal(normalized.source.permissionGranted, false);
  assert.equal(normalized.advisoryOnly, true);
  assert.equal(normalized.instructionAuthority, false);
  assert.equal(normalized.executionAuthorized, false);
  assert.equal(normalized.permissionGranted, false);
  assert.equal(normalized.requiresTrustedInstructionAdmission, true);
  assert.equal(normalized.requiresCanonicalExecutionAdmission, true);
  assert.equal(normalized.requiresCanonicalPolicyAdmission, true);
  assert.equal(normalized.requiresExactEffectAdmission, false);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.source), true);
  assert.equal(Object.isFrozen(normalized.target), true);
});

test('effectful micro-actions require downstream policy/effect admission', () => {
  for (const operation of [
    'SAVE_TO_PROJECT',
    'CREATE_TASK',
    'RUN_RECIPE',
    'CONTINUE_FROM_PAGE',
  ]) {
    assert.equal(selectionActionNeedsEffectAdmissionV1(operation), true);
  }
  for (const operation of ['SUMMARIZE', 'REWRITE', 'TRANSLATE', 'COMPARE_WITH_PROJECT', 'EXTRACT_STRUCTURED']) {
    assert.equal(selectionActionNeedsEffectAdmissionV1(operation), false);
  }

  const saved = normalizeSelectionActionRequestV1(request({
    operation: 'SAVE_TO_PROJECT',
    target: { projectId: 'project-1' },
  }));
  assert.equal(saved.requiresCanonicalPolicyAdmission, true);
  assert.equal(saved.requiresExactEffectAdmission, true);
  assert.equal(saved.permissionGranted, false);
  assert.equal(saved.executionAuthorized, false);
});

test('operation-specific target requirements fail closed', () => {
  for (const operation of ['SAVE_TO_PROJECT', 'CREATE_TASK', 'COMPARE_WITH_PROJECT']) {
    assert.throws(() => normalizeSelectionActionRequestV1(request({ operation })), new RegExp(`${operation} requires projectId`));
  }
  assert.throws(() => normalizeSelectionActionRequestV1(request({ operation: 'RUN_RECIPE' })), /requires recipeId/);
  assert.throws(() => normalizeSelectionActionRequestV1(request({
    operation: 'CONTINUE_FROM_PAGE',
    target: { sessionId: 'session-1' },
  })), /requires CURRENT_PAGE/);

  const continued = normalizeSelectionActionRequestV1(request({
    source: selectionSource({
      sourceId: 'page-1',
      kind: 'CURRENT_PAGE',
      uri: 'https://example.test/article',
    }),
    operation: 'CONTINUE_FROM_PAGE',
    target: { agentId: 'agent-1' },
  }));
  assert.equal(continued.target.agentId, 'agent-1');
  assert.equal(continued.requiresExactEffectAdmission, true);
});

test('current-page source requires URI and exact content evidence', () => {
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ kind: 'CURRENT_PAGE' })), /requires uri/);
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ text: '' })), /requires bounded text or an exact artifact binding/);

  const artifactSource = normalizeSelectionActionSourceV1(selectionSource({
    sourceId: 'clipboard-artifact',
    kind: 'CLIPBOARD',
    text: '',
    artifactId: 'artifact-1',
    contentSha256: SHA,
  }));
  assert.equal(artifactSource.artifactId, 'artifact-1');
  assert.equal(artifactSource.contentSha256, SHA);
  assert.equal(artifactSource.instructionAuthority, false);

  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ artifactId: 'artifact-1' })), /provided together/);
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ contentSha256: SHA })), /provided together/);
});

test('captured content cannot smuggle instruction or permission authority', () => {
  assert.throws(() => normalizeSelectionActionSourceV1({
    ...selectionSource(),
    instructionAuthority: true,
  }), /unknown field: instructionAuthority/);
  assert.throws(() => normalizeSelectionActionSourceV1({
    ...selectionSource(),
    permissionGranted: true,
  }), /unknown field: permissionGranted/);
  assert.throws(() => normalizeSelectionActionRequestV1({
    ...request(),
    executionAuthorized: true,
  }), /unknown field: executionAuthorized/);
  assert.throws(() => normalizeSelectionActionRequestV1({
    ...request(),
    instructionAuthority: true,
  }), /unknown field: instructionAuthority/);
});

test('contract rejects coercive IDs, versions, operations, timestamps and digests', () => {
  assert.throws(() => normalizeSelectionActionRequestV1(request({ schemaVersion: '1' })), /schemaVersion/);
  assert.throws(() => normalizeSelectionActionRequestV1(request({ requestId: 7 })), /must be text/);
  assert.throws(() => normalizeSelectionActionRequestV1(request({ requestId: ' micro-1' })), /requestId is invalid/);
  assert.throws(() => normalizeSelectionActionRequestV1(request({ operation: true })), /operation must be text/);
  assert.throws(() => normalizeSelectionActionRequestV1(request({ operation: 'summarize' })), /operation is invalid/);
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ kind: 'selection' })), /source kind is invalid/);
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ capturedAt: 7 })), /must be a timestamp/);
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ capturedAt: '2026-09-24T23:56:00Z' })), /canonical timestamp/);
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({
    text: '', artifactId: 'artifact-1', contentSha256: SHA.toUpperCase(),
  })), /lowercase SHA-256/);
  assert.throws(() => selectionActionNeedsEffectAdmissionV1(true), /operation must be text/);
  assert.throws(() => selectionActionNeedsEffectAdmissionV1(' save_to_project '), /operation is invalid/);
});

test('request, source and target accessors are rejected without getter execution', () => {
  let reads = 0;
  const source = selectionSource();
  Object.defineProperty(source, 'kind', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return 'SELECTION'; },
  });
  assert.throws(() => normalizeSelectionActionSourceV1(source), /enumerable own data property/);
  assert.equal(reads, 0);

  const req = request();
  Object.defineProperty(req, 'operation', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return 'SUMMARIZE'; },
  });
  assert.throws(() => normalizeSelectionActionRequestV1(req), /enumerable own data property/);
  assert.equal(reads, 0);

  const target = { projectId: 'project-1' };
  Object.defineProperty(target, 'projectId', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return 'project-1'; },
  });
  assert.throws(() => normalizeSelectionActionRequestV1(request({
    operation: 'SAVE_TO_PROJECT',
    target,
  })), /enumerable own data property/);
  assert.equal(reads, 0);
});

test('hidden, symbol and exotic authority fields fail closed', () => {
  const hidden = request();
  Object.defineProperty(hidden, 'operation', {
    value: 'SUMMARIZE',
    enumerable: false,
    configurable: true,
  });
  assert.throws(() => normalizeSelectionActionRequestV1(hidden), /enumerable own data property/);

  const symbolic = request();
  symbolic[Symbol('authority')] = true;
  assert.throws(() => normalizeSelectionActionRequestV1(symbolic), /unknown field/);

  const exotic = Object.assign(Object.create({ admin: true }), request());
  assert.throws(() => normalizeSelectionActionRequestV1(exotic), /plain object/);
});

test('null-prototype JSON-style envelopes remain supported', () => {
  const source = Object.assign(Object.create(null), selectionSource({ kind: 'CLIPBOARD' }));
  const target = Object.assign(Object.create(null), { projectId: 'project-1' });
  const req = Object.assign(Object.create(null), request({
    source,
    operation: 'SAVE_TO_PROJECT',
    target,
  }));
  const normalized = normalizeSelectionActionRequestV1(req);
  assert.equal(normalized.source.kind, 'CLIPBOARD');
  assert.equal(normalized.target.projectId, 'project-1');
});

test('source and owner instruction bounds are enforced', () => {
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ text: 'x'.repeat(100_001) })), /source text is invalid/);
  assert.throws(() => normalizeSelectionActionRequestV1(request({ ownerInstruction: 'x'.repeat(16_001) })), /ownerInstruction is invalid/);
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ uri: 'x'.repeat(4097) })), /uri is invalid/);
  assert.throws(() => normalizeSelectionActionSourceV1(selectionSource({ uri: ' https://example.test/' })), /uri is invalid/);
});

test('request chronology cannot predate its captured source', () => {
  assert.throws(() => normalizeSelectionActionRequestV1(request({
    source: selectionSource({ capturedAt: '2026-09-25T00:00:00.000Z' }),
    createdAt: '2026-09-24T23:59:59.999Z',
  })), /capturedAt cannot be later/);

  const equal = normalizeSelectionActionRequestV1(request());
  assert.equal(equal.createdAt, equal.source.capturedAt);
});

test('normalization is deterministic and does not mutate caller inputs', () => {
  const input = request({
    source: selectionSource({ kind: 'CLIPBOARD' }),
    operation: 'REWRITE',
  });
  const before = structuredClone(input);
  const one = normalizeSelectionActionRequestV1(input);
  const two = normalizeSelectionActionRequestV1(input);
  assert.deepEqual(one, two);
  assert.deepEqual(input, before);
  assert.equal(one.operation, 'REWRITE');
  assert.equal(one.source.kind, 'CLIPBOARD');
  assert.equal(one.createdAt, NOW);
});
