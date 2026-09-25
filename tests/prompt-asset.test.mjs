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

test('render compares exact source assertions without granting freshness authority', () => {
  const normalized = normalizePromptAssetV1(asset());
  const result = renderPromptAssetV1(normalized, {
    values: { target: 'PR #216' },
    sourceBindingAssertions: [source()],
  });
  assert.equal(result.rendered, 'Review PR #216 against North Star.\nReturn evidence only.');
  assert.equal(result.assetId, 'prompt:release-review');
  assert.equal(result.version, 1);
  assert.deepEqual(result.sourceBindings, [source()]);
  assert.deepEqual(result.sourceComparison, {
    authority: 'UNVERIFIED_INPUT',
    matchesDeclaredBindings: true,
    freshnessVerified: false,
    requiresTrustedSourceAdmission: true,
  });
  assert.deepEqual(result.cadenceComparison, {
    authority: 'UNVERIFIED_INPUT',
    matchesDeclaredCadence: true,
    triggerVerified: false,
    requiresTrustedTriggerAdmission: false,
  });
  assert.equal(result.executionAuthorized, false);
  assert.equal(Object.isFrozen(result), true);

  assert.throws(
    () => renderPromptAssetV1(normalized, {
      values: { target: 'PR #216', unexpected: 'authority' },
      sourceBindingAssertions: [source()],
    }),
    /unknown variable: unexpected/,
  );
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      values: {},
      sourceBindingAssertions: [source()],
    }),
    /required variable is missing: target/,
  );
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      values: { target: 'x'.repeat(201) },
      sourceBindingAssertions: [source()],
    }),
    /exceeds maxChars/,
  );
});

test('render comparison fails closed on mismatched, missing, duplicate or type-aliased source assertions', () => {
  const normalized = normalizePromptAssetV1(asset());
  const base = { values: { target: 'PR #216' } };
  assert.throws(
    () => renderPromptAssetV1(normalized, { ...base, sourceBindingAssertions: [] }),
    /does not match declared bindings/,
  );
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      ...base,
      sourceBindingAssertions: [source('spec', 'rev-2', SHA_A)],
    }),
    /source binding comparison mismatch: spec/,
  );
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      ...base,
      sourceBindingAssertions: [{ sourceId: 7, revisionId: 'rev-1', contentSha256: SHA_A }],
    }),
    /identity fields must be strings/,
  );
  assert.throws(
    () => normalizePromptAssetV1(asset({ assetId: ' prompt-main' })),
    /exact canonical ID representation/,
  );
  for (const nonCanonical of [
    { sourceId: ' spec', revisionId: 'rev-1', contentSha256: SHA_A },
    { sourceId: 'spec', revisionId: 'rev-1 ', contentSha256: SHA_A },
    { sourceId: 'spec', revisionId: 'rev-1', contentSha256: SHA_A.toUpperCase() },
  ]) {
    assert.throws(
      () => normalizePromptAssetV1(asset({ sourceBindings: [nonCanonical] })),
      /exact canonical representation/,
    );
  }
  assert.throws(
    () => normalizePromptAssetV1(asset({ sourceBindings: [source(), source()] })),
    /duplicate sourceId/,
  );
});

test('cadence matching is comparison-only and never invents scheduler authority', () => {
  const scheduled = normalizePromptAssetV1(asset({
    cadence: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
  }));
  assert.throws(
    () => renderPromptAssetV1(scheduled, {
      values: { target: 'main' },
      sourceBindingAssertions: [source()],
    }),
    /trigger.*plain object/,
  );
  assert.throws(
    () => renderPromptAssetV1(scheduled, {
      values: { target: 'main' },
      sourceBindingAssertions: [source()],
      triggerAssertion: { mode: PromptAssetCadenceMode.EVENT, referenceId: 'schedule:nightly' },
    }),
    /trigger mode/,
  );
  assert.throws(
    () => renderPromptAssetV1(scheduled, {
      values: { target: 'main' },
      sourceBindingAssertions: [source()],
      triggerAssertion: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:other' },
    }),
    /referenceId/,
  );
  const result = renderPromptAssetV1(scheduled, {
    values: { target: 'main' },
    sourceBindingAssertions: [source()],
    triggerAssertion: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
  });
  assert.equal(result.cadence.referenceId, 'schedule:nightly');

  assert.throws(
    () => normalizePromptAssetV1(asset({
      cadence: { mode: PromptAssetCadenceMode.MANUAL, referenceId: 'schedule:hidden' },
    })),
    /MANUAL cadence cannot/,
  );
});

test('matching caller source and cadence assertions remain unverified and cannot authorize execution', () => {
  const scheduled = normalizePromptAssetV1(asset({
    cadence: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
  }));
  const result = renderPromptAssetV1(scheduled, {
    values: { target: 'main' },
    sourceBindingAssertions: [source()],
    triggerAssertion: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
  });
  assert.deepEqual(result.sourceComparison, {
    authority: 'UNVERIFIED_INPUT',
    matchesDeclaredBindings: true,
    freshnessVerified: false,
    requiresTrustedSourceAdmission: true,
  });
  assert.deepEqual(result.cadenceComparison, {
    authority: 'UNVERIFIED_INPUT',
    matchesDeclaredCadence: true,
    triggerVerified: false,
    requiresTrustedTriggerAdmission: true,
  });
  assert.equal(result.executionAuthorized, false);

  assert.throws(
    () => renderPromptAssetV1(scheduled, {
      values: { target: 'main' },
      currentSourceBindings: [source()],
      triggerAssertion: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
    }),
    /unknown field: currentSourceBindings/,
  );
  assert.throws(
    () => renderPromptAssetV1(scheduled, {
      values: { target: 'main' },
      sourceBindingAssertions: [source()],
      trigger: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
    }),
    /unknown field: trigger/,
  );
});

test('sensitive values remain opaque and generic render output never contains secret bytes', () => {
  const secretAsset = normalizePromptAssetV1(asset({
    template: 'Authenticate with {{secret}} then review {{target}}.',
    variables: [
      { name: 'secret', required: true, maxChars: 200, defaultValue: null, sensitive: true },
      { name: 'target', required: true, maxChars: 200, defaultValue: null, sensitive: false },
    ],
  }));
  const rawSecret = 'owner-private-token-value';
  assert.throws(
    () => renderPromptAssetV1(secretAsset, {
      values: { secret: rawSecret, target: 'release' },
      sourceBindingAssertions: [source()],
    }),
    /opaque credential reference/,
  );

  const credentialRef = {
    schemaVersion: 1,
    brokerId: 'native-companion',
    credentialId: 'ais-main',
  };
  const rendered = renderPromptAssetV1(secretAsset, {
    values: { secret: credentialRef, target: 'release' },
    sourceBindingAssertions: [source()],
  });
  assert.equal(rendered.rendered, 'Authenticate with {{SENSITIVE_REF:secret}} then review release.');
  assert.equal(rendered.rendered.includes(rawSecret), false);
  assert.deepEqual(rendered.sensitiveBindings, [{ variableName: 'secret', credentialRef }]);
  assert.deepEqual(rendered.sensitiveVariableNames, ['secret']);
  assert.equal(JSON.stringify(secretAsset).includes(rawSecret), false);

  let reads = 0;
  const values = { target: 'release' };
  Object.defineProperty(values, 'secret', {
    enumerable: true,
    get() {
      reads += 1;
      return rawSecret;
    },
  });
  assert.throws(
    () => renderPromptAssetV1(secretAsset, { values, sourceBindingAssertions: [source()] }),
    /enumerable own data property/,
  );
  assert.equal(reads, 0, 'generic renderer must not execute secret-bearing accessors');
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
  assert.equal(diff.variableChanges.find(item => item.name === 'standard').defaultChanged, true);
  assert.equal(diff.sourceChanges[0].change, 'CHANGED');
  assert.equal(diff.cadenceChanged, true);
  assert.equal(JSON.stringify(diff).includes('North Star'), false, 'default values are represented only as hasDefault');
  assert.equal(JSON.stringify(diff).includes('Updated standard'), false, 'new default value must not enter diff metadata');
});

test('render options cannot inherit values, source evidence or cadence authority', () => {
  const normalized = normalizePromptAssetV1(asset());
  const inheritedOptions = Object.assign(Object.create({
    values: { target: 'inherited' },
    sourceBindingAssertions: [source()],
  }), {});
  assert.throws(
    () => renderPromptAssetV1(normalized, inheritedOptions),
    /render options must be a plain object/,
  );
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      values: { target: 'main' },
      sourceBindingAssertions: [source()],
      extraAuthority: true,
    }),
    /unknown field: extraAuthority/,
  );
});

test('plain value maps cannot smuggle inherited variable values', () => {
  const normalized = normalizePromptAssetV1(asset());
  const inherited = Object.assign(Object.create({ target: 'inherited' }), {});
  assert.throws(
    () => renderPromptAssetV1(normalized, {
      values: inherited,
      sourceBindingAssertions: [source()],
    }),
    /values must be a plain object/,
  );
});

test('prompt asset record boundaries snapshot descriptors before ordinary caller reads', () => {
  let reads = 0;
  const target = asset();
  const proxiedAsset = new Proxy(target, {
    get(object, property, receiver) {
      reads += 1;
      if (property === 'assetId') return 'prompt:swapped';
      return Reflect.get(object, property, receiver);
    },
  });
  const normalized = normalizePromptAssetV1(proxiedAsset);
  assert.equal(reads, 0, 'PromptAssetV1 must not perform ordinary Proxy reads');
  assert.equal(normalized.assetId, 'prompt:release-review');

  let assetIdDescriptorReads = 0;
  const descriptorProxy = new Proxy(asset(), {
    getOwnPropertyDescriptor(object, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
      if (property === 'assetId') {
        assetIdDescriptorReads += 1;
        return {
          ...descriptor,
          value: assetIdDescriptorReads === 1 ? descriptor.value : 'prompt:swapped',
        };
      }
      return descriptor;
    },
  });
  const snapshotted = normalizePromptAssetV1(descriptorProxy);
  assert.equal(assetIdDescriptorReads, 1, 'PromptAssetV1 fields must be snapshotted exactly once');
  assert.equal(snapshotted.assetId, 'prompt:release-review');

  const scheduled = normalizePromptAssetV1(asset({
    cadence: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
  }));
  const optionTarget = {
    values: { target: 'main' },
    sourceBindingAssertions: [source()],
    triggerAssertion: { mode: PromptAssetCadenceMode.SCHEDULE, referenceId: 'schedule:nightly' },
  };
  const proxiedOptions = new Proxy(optionTarget, {
    get(object, property, receiver) {
      reads += 1;
      return Reflect.get(object, property, receiver);
    },
  });
  const rendered = renderPromptAssetV1(scheduled, proxiedOptions);
  assert.equal(reads, 0, 'render options must not perform ordinary Proxy reads');
  assert.equal(rendered.executionAuthorized, false);
  assert.equal(rendered.sourceComparison.authority, 'UNVERIFIED_INPUT');
  assert.equal(rendered.cadenceComparison.authority, 'UNVERIFIED_INPUT');
});

test('authority-bearing prompt asset arrays reject accessors before reading values', () => {
  for (const field of ['variables', 'sourceBindings']) {
    let reads = 0;
    const values = field === 'variables'
      ? [{ name: 'target', required: true, maxChars: 400, defaultValue: null, sensitive: false }]
      : [source()];
    Object.defineProperty(values, '0', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return field === 'variables'
          ? { name: 'target', required: true, maxChars: 400, defaultValue: null, sensitive: false }
          : source();
      },
    });
    assert.throws(
      () => normalizePromptAssetV1(asset({ [field]: values })),
      /dense enumerable own data items/,
    );
    assert.equal(reads, 0, field + ' getter must never execute');
  }
});

test('prompt asset authority arrays snapshot length and indices without ordinary Proxy reads', () => {
  let reads = 0;
  const variables = new Proxy(
    [{ name: 'target', required: true, maxChars: 400, defaultValue: null, sensitive: false }],
    {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const normalized = normalizePromptAssetV1(asset({
    variables,
    template: 'Use {{target}}',
  }));
  assert.equal(reads, 0, 'variables array must be descriptor-only');
  assert.equal(normalized.variables[0].name, 'target');

  const assertions = new Proxy([source()], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const rendered = renderPromptAssetV1(normalizePromptAssetV1(asset()), {
    values: { target: 'main' },
    sourceBindingAssertions: assertions,
  });
  assert.equal(reads, 0, 'sourceBindingAssertions array must be descriptor-only');
  assert.equal(rendered.executionAuthorized, false);
});

test('prompt asset array boundaries reject sparse, custom, symbol, hidden and exotic arrays', () => {
  const sparse = new Array(1);
  assert.throws(
    () => normalizePromptAssetV1(asset({ variables: sparse })),
    /dense enumerable own data items/,
  );

  const custom = [source()];
  custom.extra = source('other', 'rev-2', SHA_B);
  assert.throws(
    () => normalizePromptAssetV1(asset({ sourceBindings: custom })),
    /non-canonical array fields/,
  );

  const symbol = [source()];
  symbol[Symbol('authority')] = source('other', 'rev-2', SHA_B);
  assert.throws(
    () => normalizePromptAssetV1(asset({ sourceBindings: symbol })),
    /non-canonical array fields/,
  );

  const hidden = [source()];
  Object.defineProperty(hidden, '0', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: source(),
  });
  assert.throws(
    () => normalizePromptAssetV1(asset({ sourceBindings: hidden })),
    /dense enumerable own data items/,
  );

  const exotic = [source()];
  Object.setPrototypeOf(exotic, null);
  assert.throws(
    () => normalizePromptAssetV1(asset({ sourceBindings: exotic })),
    /plain array/,
  );
});

test('source binding normalization uses locale-independent code-unit ordering', () => {
  const bindings = [
    source('a_', 'rev-1', SHA_A),
    source('a-', 'rev-1', SHA_A),
    source('a', 'rev-1', SHA_A),
    source('A', 'rev-1', SHA_A),
  ];
  const left = normalizePromptAssetV1(asset({ sourceBindings: bindings }));
  const right = normalizePromptAssetV1(asset({ sourceBindings: [...bindings].reverse() }));
  const expected = ['A', 'a', 'a-', 'a_'];
  assert.deepEqual(left.sourceBindings.map(item => item.sourceId), expected);
  assert.deepEqual(right.sourceBindings.map(item => item.sourceId), expected);
});

