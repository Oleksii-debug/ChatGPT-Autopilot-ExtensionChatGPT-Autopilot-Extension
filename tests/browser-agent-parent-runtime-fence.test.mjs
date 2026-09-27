import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserAgentRunState } from '../src/core/browser-agent.js';
import {
  BrowserAgentParentRuntimeFenceStatus,
  createBrowserAgentParentRuntimeFenceV1,
  inspectBrowserAgentParentRuntimeFenceV1,
  normalizeBrowserAgentParentRuntimeFenceV1,
} from '../src/core/browser-agent-parent-runtime-fence.js';

function live(overrides = {}) {
  return {
    jobId: 'job parent',
    runState: BrowserAgentRunState.RUNNING,
    controlEpoch: 7,
    capabilityIds: ['data.read', 'data.analyze'],
    toolIds: ['artifact.write', 'data.query'],
    ...overrides,
  };
}

test('creates an immutable canonical fence only from a RUNNING parent', () => {
  const fence = createBrowserAgentParentRuntimeFenceV1(live({
    capabilityIds: ['data.read', 'data.analyze'],
    toolIds: ['data.query', 'artifact.write'],
  }));

  assert.deepEqual(fence, {
    schemaVersion: 1,
    jobId: 'job parent',
    controlEpoch: 7,
    capabilityIds: ['data.analyze', 'data.read'],
    toolIds: ['artifact.write', 'data.query'],
  });
  assert.equal(Object.isFrozen(fence), true);
  assert.equal(Object.isFrozen(fence.capabilityIds), true);
  assert.equal(Object.isFrozen(fence.toolIds), true);
  assert.deepEqual(normalizeBrowserAgentParentRuntimeFenceV1(fence), fence);

  for (const state of [
    BrowserAgentRunState.STOPPED,
    BrowserAgentRunState.PAUSED,
    BrowserAgentRunState.WAITING_PERMISSION,
    BrowserAgentRunState.WAITING_APPROVAL,
    BrowserAgentRunState.WAITING_CAPABILITY,
    BrowserAgentRunState.WAITING_SCHEDULE,
    BrowserAgentRunState.COMPLETED,
    BrowserAgentRunState.ERROR,
  ]) {
    assert.throws(
      () => createBrowserAgentParentRuntimeFenceV1(live({ runState: state })),
      /must be RUNNING/,
      state,
    );
  }
});

test('CURRENT requires exact live job, epoch and narrowed scope', () => {
  const fence = createBrowserAgentParentRuntimeFenceV1(live());
  const result = inspectBrowserAgentParentRuntimeFenceV1({
    fence,
    live: live({
      capabilityIds: ['data.analyze', 'data.read'],
      toolIds: ['data.query', 'artifact.write'],
    }),
  });

  assert.equal(result.status, BrowserAgentParentRuntimeFenceStatus.CURRENT);
  assert.equal(result.current, true);
  assert.equal(result.live.runState, BrowserAgentRunState.RUNNING);
  assert.deepEqual(result.live.capabilityIds, ['data.analyze', 'data.read']);
  assert.deepEqual(result.live.toolIds, ['artifact.write', 'data.query']);
  assert.deepEqual(result.authority, {
    childAdmissionAuthorized: false,
    childExecutionAuthorized: false,
    providerExecutionAuthorized: false,
    policyAuthorized: false,
    schedulingAuthorized: false,
    recoveryAuthorized: false,
    credentialAuthorized: false,
    completionAuthorized: false,
    verificationAuthorized: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.authority), true);
});

test('PAUSED, STOPPED and every other non-RUNNING live state fail closed', () => {
  const fence = createBrowserAgentParentRuntimeFenceV1(live());
  for (const state of Object.values(BrowserAgentRunState).filter(
    value => value !== BrowserAgentRunState.RUNNING,
  )) {
    const result = inspectBrowserAgentParentRuntimeFenceV1({
      fence,
      live: live({ runState: state, controlEpoch: 8 }),
    });
    assert.equal(result.current, false, state);
    assert.equal(result.status, BrowserAgentParentRuntimeFenceStatus.NOT_RUNNING, state);
  }
});

test('pause/resume-style control epoch movement invalidates an old fence', () => {
  const fence = createBrowserAgentParentRuntimeFenceV1(live({ controlEpoch: 7 }));
  const result = inspectBrowserAgentParentRuntimeFenceV1({
    fence,
    live: live({ runState: BrowserAgentRunState.RUNNING, controlEpoch: 9 }),
  });
  assert.equal(result.current, false);
  assert.equal(result.status, BrowserAgentParentRuntimeFenceStatus.CONTROL_EPOCH_DRIFTED);
});

test('capability and tool scope changes invalidate the fence independently', () => {
  const fence = createBrowserAgentParentRuntimeFenceV1(live());

  const capabilityDrift = inspectBrowserAgentParentRuntimeFenceV1({
    fence,
    live: live({ capabilityIds: ['data.read'] }),
  });
  assert.equal(capabilityDrift.current, false);
  assert.equal(
    capabilityDrift.status,
    BrowserAgentParentRuntimeFenceStatus.CAPABILITY_SCOPE_DRIFTED,
  );

  const toolDrift = inspectBrowserAgentParentRuntimeFenceV1({
    fence,
    live: live({ toolIds: ['artifact.write'] }),
  });
  assert.equal(toolDrift.current, false);
  assert.equal(toolDrift.status, BrowserAgentParentRuntimeFenceStatus.TOOL_SCOPE_DRIFTED);
});

test('job substitution fails closed before lifecycle and scope comparison', () => {
  const fence = createBrowserAgentParentRuntimeFenceV1(live());
  const result = inspectBrowserAgentParentRuntimeFenceV1({
    fence,
    live: live({
      jobId: 'job replacement',
      runState: BrowserAgentRunState.PAUSED,
      controlEpoch: 100,
      capabilityIds: [],
      toolIds: [],
    }),
  });
  assert.equal(result.current, false);
  assert.equal(result.status, BrowserAgentParentRuntimeFenceStatus.JOB_DRIFTED);
});

test('rejects unknown fields, accessors, sparse arrays, duplicates and coercive epochs', () => {
  assert.throws(
    () => createBrowserAgentParentRuntimeFenceV1({ ...live(), extra: true }),
    /unknown field/,
  );

  const accessor = {};
  Object.defineProperty(accessor, 'jobId', { enumerable: true, get: () => 'job parent' });
  for (const [key, value] of Object.entries({
    runState: BrowserAgentRunState.RUNNING,
    controlEpoch: 7,
    capabilityIds: [],
    toolIds: [],
  })) {
    Object.defineProperty(accessor, key, { enumerable: true, value });
  }
  assert.throws(
    () => createBrowserAgentParentRuntimeFenceV1(accessor),
    /enumerable own data property/,
  );

  const sparse = new Array(2);
  sparse[1] = 'data.read';
  assert.throws(
    () => createBrowserAgentParentRuntimeFenceV1(live({ capabilityIds: sparse })),
    /enumerable own data property/,
  );

  assert.throws(
    () => createBrowserAgentParentRuntimeFenceV1(
      live({ capabilityIds: ['data.read', 'data.read'] }),
    ),
    /duplicate identity/,
  );
  assert.throws(
    () => createBrowserAgentParentRuntimeFenceV1(live({ controlEpoch: '7' })),
    /controlEpoch is invalid/,
  );
  assert.throws(
    () => createBrowserAgentParentRuntimeFenceV1(live({ controlEpoch: -0 })),
    /controlEpoch is invalid/,
  );
});

test('normalizer rejects authority-shaped or noncanonical fence bytes', () => {
  const fence = createBrowserAgentParentRuntimeFenceV1(live());
  assert.throws(
    () => normalizeBrowserAgentParentRuntimeFenceV1({
      ...fence,
      executionAuthorized: true,
    }),
    /unknown field/,
  );
  assert.throws(
    () => normalizeBrowserAgentParentRuntimeFenceV1({
      ...fence,
      schemaVersion: 2,
    }),
    /Unsupported/,
  );
  assert.throws(
    () => inspectBrowserAgentParentRuntimeFenceV1({
      fence,
      live: {
        ...live(),
        runState: 'ACTIVE',
      },
    }),
    /runState is invalid/,
  );
});
