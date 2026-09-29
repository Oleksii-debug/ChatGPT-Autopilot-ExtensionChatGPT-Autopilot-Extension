import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityPathKind,
  normalizeCapabilityPathCandidateV1,
  recommendCapabilityBestPathV1,
} from '../src/core/capability-best-path.js';

function candidate({
  candidateId,
  providerId = 'provider.test',
  pathKind = CapabilityPathKind.API,
  capabilityIds = ['repo.read'],
  enabled = true,
  ready = true,
  installationRequired = false,
  authenticationRequired = false,
  configurationRequired = false,
  sourceRevision = 1,
  sourceId = 'inventory.local',
  observedAt = '2026-09-29T04:00:00.000Z',
  validThrough = '2026-09-29T05:00:00.000Z',
} = {}) {
  return {
    schemaVersion: 1,
    candidateId,
    providerId,
    sourceId,
    pathKind,
    capabilityIds,
    enabled,
    ready,
    installationRequired,
    authenticationRequired,
    configurationRequired,
    sourceRevision,
    observedAt,
    validThrough,
  };
}

test('best path prefers deterministic path classes and never grants authority', () => {
  const result = recommendCapabilityBestPathV1({
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['repo.read'],
    candidates: [
      candidate({ candidateId: 'vision', pathKind: CapabilityPathKind.VISION }),
      candidate({ candidateId: 'uia', pathKind: CapabilityPathKind.UIA }),
      candidate({ candidateId: 'api', pathKind: CapabilityPathKind.API }),
      candidate({ candidateId: 'browser', pathKind: CapabilityPathKind.BROWSER }),
    ],
  });

  assert.equal(result.selected.candidate.candidateId, 'api');
  assert.deepEqual(
    result.alternatives.map(item => item.candidate.candidateId),
    ['uia', 'browser', 'vision'],
  );
  for (const authority of [result.authority, result.selected.authority, ...result.alternatives.map(item => item.authority)]) {
    assert.equal(authority.advisoryOnly, true);
    assert.equal(authority.requiresPreauthorizedInventory, true);
    assert.equal(authority.inventoryVisibilityAuthorized, false);
    assert.equal(authority.executionAuthorized, false);
    assert.equal(authority.permissionGranted, false);
    assert.equal(authority.installationAuthorized, false);
    assert.equal(authority.authenticationAuthorized, false);
    assert.equal(authority.credentialAuthorized, false);
    assert.equal(authority.policyAuthorized, false);
    assert.equal(authority.routingAuthorized, false);
  }
});

test('unready, disabled, setup-blocked and capability-incomplete candidates cannot win', () => {
  const result = recommendCapabilityBestPathV1({
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['repo.read', 'repo.write'],
    candidates: [
      candidate({
        candidateId: 'api-unready',
        pathKind: CapabilityPathKind.API,
        capabilityIds: ['repo.read', 'repo.write'],
        ready: false,
      }),
      candidate({
        candidateId: 'cli-disabled',
        pathKind: CapabilityPathKind.CLI,
        capabilityIds: ['repo.read', 'repo.write'],
        enabled: false,
      }),
      candidate({
        candidateId: 'mcp-setup',
        pathKind: CapabilityPathKind.MCP,
        capabilityIds: ['repo.read', 'repo.write'],
        authenticationRequired: true,
      }),
      candidate({
        candidateId: 'semantic-missing',
        pathKind: CapabilityPathKind.SEMANTIC_BROWSER,
        capabilityIds: ['repo.read'],
      }),
      candidate({
        candidateId: 'uia-ready',
        pathKind: CapabilityPathKind.UIA,
        capabilityIds: ['repo.read', 'repo.write'],
      }),
    ],
  });

  assert.equal(result.selected.candidate.candidateId, 'uia-ready');
  assert.deepEqual(
    Object.fromEntries(result.blocked.map(item => [item.candidate.candidateId, item.reason])),
    {
      'api-unready': 'NOT_READY',
      'cli-disabled': 'DISABLED',
      'mcp-setup': 'AUTHENTICATION_REQUIRED',
      'semantic-missing': 'MISSING_CAPABILITY',
    },
  );
});

test('ranking is deterministic and uses least surplus within the same path kind', () => {
  const first = recommendCapabilityBestPathV1({
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['repo.read'],
    candidates: [
      candidate({
        candidateId: 'api-wide',
        providerId: 'provider.z',
        pathKind: CapabilityPathKind.API,
        capabilityIds: ['repo.read', 'repo.write', 'repo.admin'],
      }),
      candidate({
        candidateId: 'api-narrow-b',
        providerId: 'provider.b',
        pathKind: CapabilityPathKind.API,
        capabilityIds: ['repo.read'],
      }),
      candidate({
        candidateId: 'api-narrow-a',
        providerId: 'provider.a',
        pathKind: CapabilityPathKind.API,
        capabilityIds: ['repo.read'],
      }),
    ],
  });
  const second = recommendCapabilityBestPathV1({
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['repo.read'],
    candidates: [
      candidate({
        candidateId: 'api-narrow-a',
        providerId: 'provider.a',
        pathKind: CapabilityPathKind.API,
        capabilityIds: ['repo.read'],
      }),
      candidate({
        candidateId: 'api-wide',
        providerId: 'provider.z',
        pathKind: CapabilityPathKind.API,
        capabilityIds: ['repo.read', 'repo.write', 'repo.admin'],
      }),
      candidate({
        candidateId: 'api-narrow-b',
        providerId: 'provider.b',
        pathKind: CapabilityPathKind.API,
        capabilityIds: ['repo.read'],
      }),
    ],
  });

  assert.equal(first.selected.candidate.candidateId, 'api-narrow-a');
  assert.deepEqual(first, second);
  assert.equal(first.selected.capabilitySurplus, 0);
  assert.equal(first.alternatives.at(-1).candidate.candidateId, 'api-wide');
});

test('authentication-required API remains blocked instead of silently outranking a ready fallback', () => {
  const result = recommendCapabilityBestPathV1({
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['mail.read'],
    candidates: [
      candidate({
        candidateId: 'gmail-api-needs-auth',
        providerId: 'gmail',
        pathKind: CapabilityPathKind.API,
        capabilityIds: ['mail.read'],
        authenticationRequired: true,
      }),
      candidate({
        candidateId: 'browser-ready',
        providerId: 'browser',
        pathKind: CapabilityPathKind.SEMANTIC_BROWSER,
        capabilityIds: ['mail.read'],
      }),
    ],
  });

  assert.equal(result.selected.candidate.candidateId, 'browser-ready');
  assert.equal(result.blocked[0].candidate.candidateId, 'gmail-api-needs-auth');
  assert.equal(result.blocked[0].reason, 'AUTHENTICATION_REQUIRED');
  assert.equal(result.authority.authenticationAuthorized, false);
});

test('installation and configuration blockers remain advisory and explicit', () => {
  const result = recommendCapabilityBestPathV1({
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['files.read'],
    candidates: [
      candidate({
        candidateId: 'cli-needs-install',
        pathKind: CapabilityPathKind.CLI,
        capabilityIds: ['files.read'],
        installationRequired: true,
      }),
      candidate({
        candidateId: 'mcp-needs-config',
        pathKind: CapabilityPathKind.MCP,
        capabilityIds: ['files.read'],
        configurationRequired: true,
      }),
      candidate({
        candidateId: 'uia-ready-files',
        pathKind: CapabilityPathKind.UIA,
        capabilityIds: ['files.read'],
      }),
    ],
  });

  assert.equal(result.selected.candidate.candidateId, 'uia-ready-files');
  assert.deepEqual(
    Object.fromEntries(result.blocked.map(item => [item.candidate.candidateId, item.reason])),
    {
      'cli-needs-install': 'INSTALLATION_REQUIRED',
      'mcp-needs-config': 'CONFIGURATION_REQUIRED',
    },
  );
  assert.equal(result.authority.installationAuthorized, false);
  assert.equal(result.authority.authenticationAuthorized, false);
});

test('stale and future readiness observations cannot win recommendation', () => {
  const result = recommendCapabilityBestPathV1({
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['repo.read'],
    candidates: [
      candidate({
        candidateId: 'api-stale',
        pathKind: CapabilityPathKind.API,
        observedAt: '2026-09-29T03:00:00.000Z',
        validThrough: '2026-09-29T04:00:00.000Z',
      }),
      candidate({
        candidateId: 'cli-future',
        pathKind: CapabilityPathKind.CLI,
        observedAt: '2026-09-29T04:45:00.000Z',
        validThrough: '2026-09-29T05:00:00.000Z',
      }),
      candidate({
        candidateId: 'uia-current',
        pathKind: CapabilityPathKind.UIA,
      }),
    ],
  });

  assert.equal(result.selected.candidate.candidateId, 'uia-current');
  assert.equal(result.asOf, '2026-09-29T04:30:00.000Z');
  assert.deepEqual(
    Object.fromEntries(result.blocked.map(item => [item.candidate.candidateId, item.reason])),
    {
      'api-stale': 'STALE',
      'cli-future': 'FUTURE_OBSERVATION',
    },
  );
  assert.equal(result.selected.candidate.sourceId, 'inventory.local');
  assert.equal(result.selected.candidate.sourceRevision, 1);
});

test('impossible candidate validity window fails closed as malformed provenance', () => {
  assert.throws(
    () => recommendCapabilityBestPathV1({
      schemaVersion: 1,
      asOf: '2026-09-29T04:30:00.000Z',
      requiredCapabilityIds: ['repo.read'],
      candidates: [
        candidate({
          candidateId: 'api-invalid-window',
          observedAt: '2026-09-29T04:20:00.000Z',
          validThrough: '2026-09-29T04:10:00.000Z',
        }),
      ],
    }),
    /validThrough cannot predate observedAt/,
  );
});

test('no eligible candidate returns null selected without manufacturing permission', () => {
  const result = recommendCapabilityBestPathV1({
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['calendar.write'],
    candidates: [
      candidate({
        candidateId: 'calendar-api',
        capabilityIds: ['calendar.write'],
        ready: false,
      }),
    ],
  });

  assert.equal(result.selected, null);
  assert.deepEqual(result.alternatives, []);
  assert.equal(result.blocked[0].reason, 'NOT_READY');
  assert.equal(result.authority.executionAuthorized, false);
});

test('candidate and request admission reject unknown/accessor authority without invoking getters', () => {
  let reads = 0;
  const hostile = candidate({ candidateId: 'hostile' });
  Object.defineProperty(hostile, 'ready', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return true;
    },
  });
  assert.throws(() => normalizeCapabilityPathCandidateV1(hostile), /data property/);
  assert.equal(reads, 0);

  const request = {
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['repo.read'],
    candidates: [candidate({ candidateId: 'safe' })],
  };
  Object.defineProperty(request, 'candidates', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return [];
    },
  });
  assert.throws(() => recommendCapabilityBestPathV1(request), /data property/);
  assert.equal(reads, 0);

  assert.throws(
    () => recommendCapabilityBestPathV1({
      schemaVersion: 1,
      requiredCapabilityIds: ['repo.read'],
      candidates: [candidate({ candidateId: 'safe' })],
      permissionGranted: true,
    }),
    /unknown field/,
  );
});

test('canonical arrays, duplicate identity and exact scalar representation fail closed', () => {
  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => recommendCapabilityBestPathV1({
      schemaVersion: 1,
      asOf: '2026-09-29T04:30:00.000Z',
      requiredCapabilityIds: ['repo.read'],
      candidates: sparse,
    }),
    /enumerable own data property/,
  );

  assert.throws(
    () => recommendCapabilityBestPathV1({
      schemaVersion: 1,
      asOf: '2026-09-29T04:30:00.000Z',
      requiredCapabilityIds: ['repo.read'],
      candidates: [
        candidate({ candidateId: 'dup' }),
        candidate({ candidateId: 'dup', providerId: 'provider.other' }),
      ],
    }),
    /duplicate candidateId/,
  );

  assert.throws(
    () => normalizeCapabilityPathCandidateV1(candidate({
      candidateId: 'bad',
      sourceRevision: -0,
    })),
    /positive safe integer/,
  );
});

test('normalized output is deeply frozen and independent of caller mutation', () => {
  const raw = candidate({
    candidateId: 'api',
    capabilityIds: ['repo.write', 'repo.read'],
  });
  const result = recommendCapabilityBestPathV1({
    schemaVersion: 1,
    asOf: '2026-09-29T04:30:00.000Z',
    requiredCapabilityIds: ['repo.read'],
    candidates: [raw],
  });

  raw.capabilityIds.push('repo.admin');
  raw.ready = false;

  assert.deepEqual(result.selected.candidate.capabilityIds, ['repo.read', 'repo.write']);
  assert.equal(result.selected.candidate.ready, true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.selected), true);
  assert.equal(Object.isFrozen(result.selected.candidate.capabilityIds), true);
});
