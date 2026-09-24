import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PromptAssetCadenceMode,
  diffPromptAssetVersionsV1,
  evolvePromptAssetV1,
  normalizePromptAssetHistoryV1,
  normalizePromptAssetV1,
  renderPromptAssetV1,
} from '../src/core/prompt-asset.js';

const AT1 = '2026-09-24T20:00:00.000Z';
const AT2 = '2026-09-24T20:10:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function source(sourceId = 'spec', revisionId = 'rev-1', contentSha256 = SHA_A) {
  return { sourceId, revisionId, contentSha256 };
}

function asset(overrides = {}) {
  return {
    schemaVersion: 1,
    assetId: 'prompt:release-review',
    projectId: 'autopilot',
    version: 1,
    parentVersion: null,
    title: 'Release review',
    template: 'Review {{target}} against {{standard}}.\nReturn evidence only.',
    variables: [
      { name: 'target', required: true, maxChars: 200, defaultValue: null, sensitive: false },
      { name: 'standard', required: true, maxChars: 200, defaultValue: 'North Star', sensitive: false },
    ],
    sourceBindings: [source()],
    cadence: { mode: PromptAssetCadenceMode.MANUAL, referenceId: null },
    changeSummary: 'Initial verified instruction asset.',
    changedAt: AT1,
    ...overrides,
  };
}

test('PromptAssetV1 is strict, immutable and deterministically normalizes source bindings', () => {
  const normalized = normalizePromptAssetV1(asset({
    sourceBindings: [
      source('z-source', 'z1', SHA_B),
      source('a-source', 'a1', SHA_A),
    ],
  }));
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(normalized.sourceBindings.map(item => item.sourceId), ['a-source', 'z-source']);
  assert.throws(() => normalizePromptAssetV1({ ...asset(), schemaVersion: '1' }), /schemaVersion/);
  assert.throws(() => normalizePromptAssetV1({ ...asset(), version: '1' }), /version/);
  assert.throws(() => normalizePromptAssetV1({ ...asset(), extra: true }), /unknown field/);
  assert.throws(
    () => normalizePromptAssetV1(Object.assign(Object.create({ assetId: 'inherited' }), asset())),
    /plain object/,
  );
});

test('template variables must be explicitly declared and every declaration is used', () => {
  assert.throws(
    () => normalizePromptAssetV1(asset({ template: 'Use {{missing}}.' })),
    /undeclared variable: missing/,
  );
  assert.throws(
    () => normalizePromptAssetV1(asset({ template: 'Only {{target}}.' })),
    /declared variable is not referenced.*standard/,
  );
  assert.throws(
    () => normalizePromptAssetV1(asset({ template: 'Broken {{target.' })),
    /malformed placeholder/,
  );
  assert.throws(
    () => normalizePromptAssetV1(asset({
      variables: [
        { name: 'secret', required: true, maxChars: 100, defaultValue: 'do-not-store', sensitive: true },
      ],
      template: 'Use {{secret}}',
    })),
    /sensitive variables cannot persist defaults/,
  );
});

test('render binds exact fresh sources, declared variables and immutable identity', () => {
  const normalized = normalizePromptAssetV1(asset());
  const result = renderPromptAssetV1(normalized, {
    values: { target: 'PR #216' },
    currentSourceBindings: [source()],
  });
  assert.equal(result.rendered, 'Review PR #216 against North Star.\nReturn evidence only.');
  assert.equal(result.assetId, 'prompt:release-review');
  assert.equal(result.version, 1);
  assert.deepEqual(result.sourceBindings, [source()]);
  assert.equal(Object.isFrozen(result), true);

  assert.throws(
    () => renderPromptAssetV1(normalized, {
      values: { target: 'PR #216', unexpected: 'authority' },
      currentSourceBindings: [source()],
    }),
    /unknown variable: unexpected/,
  );
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      values: {},
      currentSourceBindings: [source()],
    }),
    /required variable is missing: target/,
  );
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      values: { target: 'x'.repeat(201) },
      currentSourceBindings: [source()],
    }),
    /exceeds maxChars/,
  );
});

test('render fails closed on stale, missing, duplicate or type-aliased source revision evidence', () => {
  const normalized = normalizePromptAssetV1(asset());
  const base = { values: { target: 'PR #216' } };
  assert.throws(
    () => renderPromptAssetV1(normalized, { ...base, currentSourceBindings: [] }),
    /stale or incomplete/,
  );
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      ...base,
      currentSourceBindings: [source('spec', 'rev-2', SHA_A)],
    }),
    /source binding is stale: spec/,
  );
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      ...base,
      currentSourceBindings: [{ sourceId: 7, revisionId: 'rev-1', contentSha256: SHA_A }],
    }),
    /identity fields must be strings/,
  );
  assert.throws(
    () => normalizePromptAssetV1(asset({ sourceBindings: [source(), source()] })),
    /duplicate sourceId/,
  );
});

test('cadence is a reference-only execution gate and never invents scheduler authority', () => {
  const scheduled = normalizePromptAssetV1(asset({
    cadence: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
  }));
  assert.throws(
    () => renderPromptAssetV1(scheduled, {
      values: { target: 'main' },
      currentSourceBindings: [source()],
    }),
    /trigger.*plain object/,
  );
  assert.throws(
    () => renderPromptAssetV1(scheduled, {
      values: { target: 'main' },
      currentSourceBindings: [source()],
      trigger: { mode: PromptAssetCadenceMode.EVENT, referenceId: 'schedule:nightly' },
    }),
    /trigger mode/,
  );
  assert.throws(
    () => renderPromptAssetV1(scheduled, {
      values: { target: 'main' },
      currentSourceBindings: [source()],
      trigger: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:other' },
    }),
    /referenceId/,
  );
  const result = renderPromptAssetV1(scheduled, {
    values: { target: 'main' },
    currentSourceBindings: [source()],
    trigger: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
  });
  assert.equal(result.cadence.referenceId, 'schedule:nightly');

  assert.throws(
    () => normalizePromptAssetV1(asset({
      cadence: { mode: PromptAssetCadenceMode.MANUAL, referenceId: 'schedule:hidden' },
    })),
    /MANUAL cadence cannot/,
  );
});

test('sensitive values may render for execution but never enter diff/history metadata', () => {
  const secretAsset = normalizePromptAssetV1(asset({
    template: 'Authenticate with {{secret}} then review {{target}}.',
    variables: [
      { name: 'secret', required: true, maxChars: 200, defaultValue: null, sensitive: true },
      { name: 'target', required: true, maxChars: 200, defaultValue: null, sensitive: false },
    ],
  }));
  const secret = 'owner-private-token-value';
  const rendered = renderPromptAssetV1(secretAsset, {
    values: { secret, target: 'release' },
    currentSourceBindings: [source()],
  });
  assert.match(rendered.rendered, new RegExp(secret));
  assert.deepEqual(rendered.sensitiveVariableNames, ['secret']);
  assert.equal(JSON.stringify(secretAsset).includes(secret), false);
});

test('version lineage is exact and history cannot skip, reorder or change identity', () => {
  const v1 = normalizePromptAssetV1(asset());
  const v2 = evolvePromptAssetV1(v1, asset({
    version: 2,
    parentVersion: 1,
    template: 'Review {{target}} against {{standard}}.\nRecord reproducible evidence.',
    changeSummary: 'Require reproducible evidence.',
    changedAt: AT2,
  }));
  const history = normalizePromptAssetHistoryV1([v1, v2]);
  assert.deepEqual(history.map(item => item.version), [1, 2]);

  assert.throws(
    () => evolvePromptAssetV1(v1, asset({ version: 3, parentVersion: 1, changedAt: AT2 })),
    /advance exactly by one/,
  );
  assert.throws(
    () => evolvePromptAssetV1(v1, asset({ version: 2, parentVersion: 1, assetId: 'other', changedAt: AT2 })),
    /identity cannot change/,
  );
  assert.throws(
    () => normalizePromptAssetHistoryV1([v2]),
    /start at version 1/,
  );
});

test('diff is deterministic, bounded to changed template window and never exposes variable defaults', () => {
  const v1 = normalizePromptAssetV1(asset());
  const v2 = normalizePromptAssetV1(asset({
    version: 2,
    parentVersion: 1,
    template: 'Review {{target}} against {{standard}}.\nReturn reproducible evidence only.',
    variables: [
      { name: 'target', required: true, maxChars: 400, defaultValue: null, sensitive: false },
      { name: 'standard', required: true, maxChars: 200, defaultValue: 'Updated standard', sensitive: false },
    ],
    sourceBindings: [source('spec', 'rev-2', SHA_B)],
    cadence: { mode: PromptAssetCadenceMode.EVENT, referenceId: 'event:source-change' },
    changeSummary: 'Tighten evidence and source revision.',
    changedAt: AT2,
  }));
  const diff = diffPromptAssetVersionsV1(v1, v2);
  assert.equal(diff.fromVersion, 1);
  assert.equal(diff.toVersion, 2);
  assert.equal(diff.templateChanged, true);
  assert.deepEqual(diff.templateDiff, {
    startLine: 2,
    beforeLineCount: 1,
    afterLineCount: 1,
    before: ['Return evidence only.'],
    after: ['Return reproducible evidence only.'],
  });
  assert.equal(diff.variableChanges.length, 2);
  assert.equal(diff.sourceChanges[0].change, 'CHANGED');
  assert.equal(diff.cadenceChanged, true);
  assert.equal(JSON.stringify(diff).includes('North Star'), false, 'default values are represented only as hasDefault');
  assert.equal(JSON.stringify(diff).includes('Updated standard'), false, 'new default value must not enter diff metadata');
});

test('plain value maps cannot smuggle inherited variable values', () => {
  const normalized = normalizePromptAssetV1(asset());
  const inherited = Object.assign(Object.create({ target: 'inherited' }), {});
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      values: inherited,
      currentSourceBindings: [source()],
    }),
    /values must be a plain object/,
  );
});
