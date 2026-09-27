import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SpecialistProviderReadinessSource,
  inspectSpecialistProviderReadinessV1,
} from '../src/core/specialist-provider-readiness.js';

function selection(overrides = {}) {
  return {
    schemaVersion: 1,
    registryId: 'specialists',
    registryRevision: 3,
    specialistId: 'coding.local',
    providerId: 'provider.local',
    definitionRevision: 2,
    executionPlane: 'LOCAL',
    requestedCapabilityIds: ['code.write'],
    grantedToolIds: ['fs.read', 'fs.write'],
    resultContractId: 'code.result',
    ...overrides,
  };
}

function readiness(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: 'provider.local',
    toolId: '',
    health: 'READY',
    installationRequired: false,
    installed: true,
    authenticationRequired: false,
    authenticated: true,
    pathKind: 'CLI',
    latencyMs: 10,
    reasonCode: '',
    ...overrides,
  };
}

test('provider-wide readiness satisfies every selected specialist tool without granting execution authority', () => {
  const result = inspectSpecialistProviderReadinessV1({
    selection: selection(),
    providerStates: [readiness()],
  });

  assert.equal(result.readiness, 'READY');
  assert.equal(result.executable, true);
  assert.deepEqual(result.requiredToolIds, ['fs.read', 'fs.write']);
  assert.deepEqual(
    result.checks.map(check => [check.toolId, check.source, check.readiness]),
    [
      ['fs.read', SpecialistProviderReadinessSource.PROVIDER_WIDE, 'READY'],
      ['fs.write', SpecialistProviderReadinessSource.PROVIDER_WIDE, 'READY'],
    ],
  );
  assert.equal(result.requiresFreshTrustedResolution, true);
  assert.deepEqual(result.authority, {
    providerExecutionAuthorized: false,
    toolExecutionAuthorized: false,
    policyAuthorized: false,
    schedulingAuthorized: false,
    recoveryAuthorized: false,
    credentialAuthorized: false,
    completionAuthorized: false,
    verificationAuthorized: false,
    capacityReserved: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
});

test('tool-specific readiness overrides provider-wide fallback for the exact selected tool', () => {
  const unavailable = inspectSpecialistProviderReadinessV1({
    selection: selection(),
    providerStates: [
      readiness(),
      readiness({ toolId: 'fs.read', health: 'UNAVAILABLE', reasonCode: 'down' }),
    ],
  });

  assert.equal(unavailable.readiness, 'UNAVAILABLE');
  assert.equal(unavailable.executable, false);
  assert.equal(unavailable.checks[0].source, SpecialistProviderReadinessSource.TOOL_SPECIFIC);
  assert.equal(unavailable.checks[0].readiness, 'UNAVAILABLE');
  assert.equal(unavailable.checks[1].source, SpecialistProviderReadinessSource.PROVIDER_WIDE);
  assert.equal(unavailable.checks[1].readiness, 'READY');

  const exactRecovery = inspectSpecialistProviderReadinessV1({
    selection: selection({ grantedToolIds: ['fs.read'] }),
    providerStates: [
      readiness({ health: 'UNAVAILABLE', reasonCode: 'provider-wide-down' }),
      readiness({ toolId: 'fs.read', health: 'READY', reasonCode: 'tool-live' }),
    ],
  });
  assert.equal(exactRecovery.readiness, 'READY');
  assert.equal(exactRecovery.executable, true);
  assert.equal(exactRecovery.checks[0].source, SpecialistProviderReadinessSource.TOOL_SPECIFIC);
});

test('tool-specific facts can satisfy the selected tool set without a provider-wide fact', () => {
  const result = inspectSpecialistProviderReadinessV1({
    selection: selection(),
    providerStates: [
      readiness({ toolId: 'fs.write' }),
      readiness({ toolId: 'fs.read' }),
      readiness({ providerId: 'provider.other', toolId: '', health: 'READY' }),
    ],
  });

  assert.equal(result.readiness, 'READY');
  assert.equal(result.executable, true);
  assert.deepEqual(result.checks.map(check => check.source), [
    SpecialistProviderReadinessSource.TOOL_SPECIFIC,
    SpecialistProviderReadinessSource.TOOL_SPECIFIC,
  ]);
});

test('missing or unknown provider facts require a health check and never become executable', () => {
  const missing = inspectSpecialistProviderReadinessV1({
    selection: selection({ grantedToolIds: ['fs.read'] }),
    providerStates: [readiness({ providerId: 'provider.other' })],
  });
  assert.equal(missing.readiness, 'NEEDS_HEALTH_CHECK');
  assert.equal(missing.executable, false);
  assert.equal(missing.checks[0].source, SpecialistProviderReadinessSource.MISSING);
  assert.equal(missing.checks[0].providerReadiness, null);

  const unknown = inspectSpecialistProviderReadinessV1({
    selection: selection({ grantedToolIds: ['fs.read'] }),
    providerStates: [readiness({ health: 'UNKNOWN', reasonCode: 'not-probed' })],
  });
  assert.equal(unknown.readiness, 'NEEDS_HEALTH_CHECK');
  assert.equal(unknown.executable, false);
});

test('install and authentication requirements fail closed before provider use', () => {
  const install = inspectSpecialistProviderReadinessV1({
    selection: selection({ grantedToolIds: ['fs.read'] }),
    providerStates: [readiness({ installationRequired: true, installed: false })],
  });
  assert.equal(install.readiness, 'NEEDS_INSTALL');
  assert.equal(install.executable, false);

  const auth = inspectSpecialistProviderReadinessV1({
    selection: selection({ grantedToolIds: ['fs.read'] }),
    providerStates: [readiness({ authenticationRequired: true, authenticated: false })],
  });
  assert.equal(auth.readiness, 'NEEDS_AUTH');
  assert.equal(auth.executable, false);
});

test('DEGRADED remains operationally executable exactly like canonical capability discovery', () => {
  const result = inspectSpecialistProviderReadinessV1({
    selection: selection({ grantedToolIds: ['fs.read'] }),
    providerStates: [readiness({ health: 'DEGRADED', reasonCode: 'slow' })],
  });
  assert.equal(result.readiness, 'DEGRADED');
  assert.equal(result.executable, true);
  assert.equal(result.authority.providerExecutionAuthorized, false);
});

test('a specialist with no tool grant still requires provider-wide readiness', () => {
  const ready = inspectSpecialistProviderReadinessV1({
    selection: selection({ grantedToolIds: [] }),
    providerStates: [readiness()],
  });
  assert.equal(ready.readiness, 'READY');
  assert.equal(ready.executable, true);
  assert.equal(ready.checks.length, 1);
  assert.equal(ready.checks[0].toolId, '');
  assert.equal(ready.checks[0].source, SpecialistProviderReadinessSource.PROVIDER_WIDE);

  const missing = inspectSpecialistProviderReadinessV1({
    selection: selection({ grantedToolIds: [] }),
    providerStates: [readiness({ toolId: 'fs.read' })],
  });
  assert.equal(missing.readiness, 'NEEDS_HEALTH_CHECK');
  assert.equal(missing.executable, false);
});

test('duplicate provider/tool readiness identities fail closed independent of ordering', () => {
  assert.throws(
    () => inspectSpecialistProviderReadinessV1({
      selection: selection(),
      providerStates: [readiness(), readiness({ health: 'DEGRADED' })],
    }),
    /duplicate provider\/tool readiness identity/u,
  );
});

test('selection identity and ProviderReadinessV1 representation remain exact', () => {
  assert.throws(
    () => inspectSpecialistProviderReadinessV1({
      selection: selection({ providerId: ' provider.local ' }),
      providerStates: [readiness()],
    }),
    /exact canonical identity representation/u,
  );
  assert.throws(
    () => inspectSpecialistProviderReadinessV1({
      selection: selection(),
      providerStates: [readiness({ providerId: ' provider.local ' })],
    }),
    /exact canonical identity representation/u,
  );
  assert.throws(
    () => inspectSpecialistProviderReadinessV1({
      selection: selection(),
      providerStates: [readiness({ health: 'ready' })],
    }),
    /canonical enum representation/u,
  );
});

test('outer request and providerStates are descriptor-safe and dense before nested admission', () => {
  let reads = 0;
  const request = { providerStates: [readiness()] };
  Object.defineProperty(request, 'selection', {
    enumerable: true,
    get() {
      reads += 1;
      return selection();
    },
  });
  assert.throws(
    () => inspectSpecialistProviderReadinessV1(request),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0, 'request getters must never execute');

  const providerStates = [];
  providerStates.length = 1;
  Object.defineProperty(providerStates, '0', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return readiness();
    },
  });
  assert.throws(
    () => inspectSpecialistProviderReadinessV1({
      selection: selection(),
      providerStates,
    }),
    /enumerable own data property/u,
  );
  assert.equal(reads, 0, 'providerStates getters must never execute');

  const sparse = new Array(1);
  assert.throws(
    () => inspectSpecialistProviderReadinessV1({
      selection: selection(),
      providerStates: sparse,
    }),
    /enumerable own data property/u,
  );

  const symbolArray = [readiness()];
  symbolArray[Symbol('hidden')] = readiness({ providerId: 'provider.hidden' });
  assert.throws(
    () => inspectSpecialistProviderReadinessV1({
      selection: selection(),
      providerStates: symbolArray,
    }),
    /non-canonical array fields/u,
  );
});

test('null-prototype request is accepted but unknown authority fields fail closed', () => {
  const request = Object.create(null);
  request.selection = selection({ grantedToolIds: ['fs.read'] });
  request.providerStates = [readiness()];
  assert.equal(inspectSpecialistProviderReadinessV1(request).executable, true);

  assert.throws(
    () => inspectSpecialistProviderReadinessV1({
      selection: selection(),
      providerStates: [readiness()],
      executionAuthorized: true,
    }),
    /unknown field/u,
  );
});
