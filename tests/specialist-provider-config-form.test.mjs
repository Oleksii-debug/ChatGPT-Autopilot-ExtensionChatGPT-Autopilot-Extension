import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENHANDS_SPECIALIST_PROVIDER_KIND,
  buildOpenHandsSpecialistProviderConfigRequestV1,
} from '../src/ui/specialist-provider-config-form.js';

function form(overrides = {}) {
  return {
    serverUrl: 'http://127.0.0.1:3000',
    agentProfileId: '12345678-1234-4234-8234-123456789abc',
    agentProfileRevision: '7',
    workspacePath: 'C:\\work\\autopilot',
    qualifiedCapabilityIdsText: 'repo.read\nrepo.write',
    requestTimeoutSeconds: '30',
    maxExecutionSeconds: '1800',
    pollIntervalMs: '1000',
    maxIterations: '100',
    maxResponseBytes: '1000000',
    ...overrides,
  };
}

test('builds only the canonical BrowserAgent OpenHands provider-config request', () => {
  const request = buildOpenHandsSpecialistProviderConfigRequestV1(form(), { expectedRevision: 4 });
  assert.equal(request.providerId, 'openhands-agent-server');
  assert.equal(request.kind, OPENHANDS_SPECIALIST_PROVIDER_KIND);
  assert.equal(request.expectedRevision, 4);
  assert.equal(request.config.schemaVersion, 1);
  assert.equal(request.config.agentServerVersion, '1.49.5');
  assert.equal(request.config.authMode, 'LOCAL_UNAUTHENTICATED');
  assert.equal(request.config.serverUrl, 'http://127.0.0.1:3000');
  assert.deepEqual(request.config.qualifiedCapabilityIds, ['repo.read', 'repo.write']);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.config));
});

test('normalizes capability order without widening capability identity', () => {
  const request = buildOpenHandsSpecialistProviderConfigRequestV1(form({
    qualifiedCapabilityIdsText: 'z.cap\na.cap',
  }));
  assert.deepEqual(request.config.qualifiedCapabilityIds, ['a.cap', 'z.cap']);
});

test('rejects remote servers, paths in server URL and non-absolute workspaces', () => {
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(form({ serverUrl: 'https://example.com:3000' })),
    /localhost|local http/u,
  );
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(form({ serverUrl: 'http://localhost:3000/api' })),
    /must not contain a path/u,
  );
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(form({ workspacePath: 'relative/work' })),
    /must be absolute/u,
  );
});

test('rejects non-canonical UUID, duplicate capabilities and out-of-range execution bounds', () => {
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(form({ agentProfileId: 'NOT-A-UUID' })),
    /canonical lowercase UUID/u,
  );
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(form({ qualifiedCapabilityIdsText: 'repo.read\nrepo.read' })),
    /duplicate identity/u,
  );
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(form({ pollIntervalMs: '99' })),
    /outside the supported range/u,
  );
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(form({ maxResponseBytes: '2000001' })),
    /outside the supported range/u,
  );
});

test('rejects signed zero, coercive integer text and hostile accessors without executing getters', () => {
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(form(), { expectedRevision: -0 }),
    /expected revision is invalid/u,
  );
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(form({ agentProfileRevision: '01' })),
    /canonical positive integer/u,
  );
  let gets = 0;
  const hostile = form();
  Object.defineProperty(hostile, 'serverUrl', {
    enumerable: true,
    get() {
      gets += 1;
      return 'http://127.0.0.1:3000';
    },
  });
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1(hostile),
    /enumerable own data property/u,
  );
  assert.equal(gets, 0);
});

test('rejects unknown form authority fields', () => {
  assert.throws(
    () => buildOpenHandsSpecialistProviderConfigRequestV1({
      ...form(),
      apiKey: 'must-never-exist',
    }),
    /unknown field: apiKey/u,
  );
});
