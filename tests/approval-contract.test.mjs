import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  ApprovalResolutionDecision,
  ApprovalTicketStatus,
  approvalTicketStateAtV1,
  assertApprovedForInvocationV1,
  createApprovalBindingFingerprintV1,
  createApprovalTicketV1,
  normalizeApprovalTicketV1,
  resolveApprovalTicketV1,
} from '../src/core/approval-contract.js';

function policy(overrides = {}) {
  return {
    schemaVersion: 1,
    decisionId: 'policy-1',
    invocationId: 'inv-1',
    decision: 'REQUIRE_APPROVAL',
    reasonCode: 'OWNER_ASK',
    reason: 'Owner review required',
    approvalId: 'approval-1',
    decidedAt: '2026-09-24T22:30:00.000Z',
    ...overrides,
  };
}

function invocation(argumentOverrides = {}, overrides = {}) {
  return {
    schemaVersion: 1,
    invocationId: 'inv-1',
    toolId: 'tool.publish',
    providerId: 'provider.cms',
    requestedCapabilityIds: ['cms.publish', 'artifact.read'],
    policyDecisionId: 'policy-1',
    arguments: {
      path: '/news/update',
      body: { title: 'Release', publish: true },
      ...argumentOverrides,
    },
    createdAt: '2026-09-24T22:30:01.000Z',
    parentInvocationId: 'agent-job-1',
    ...overrides,
  };
}

function resolution(overrides = {}) {
  return {
    schemaVersion: 1,
    approvalId: 'approval-1',
    expectedRevision: 1,
    resolutionId: 'resolution-1',
    decision: ApprovalResolutionDecision.APPROVE,
    resolvedBy: 'owner:primary',
    resolvedAt: '2026-09-24T22:35:00.000Z',
    ...overrides,
  };
}

test('creates immutable pending ticket bound to exact REQUIRE_APPROVAL invocation', async () => {
  const ticket = await createApprovalTicketV1({
    policyDecision: policy(),
    invocation: invocation(),
    expiresAt: '2026-09-25T22:30:00Z',
    cryptoApi: webcrypto,
  });
  assert.equal(ticket.status, ApprovalTicketStatus.PENDING);
  assert.equal(ticket.revision, 1);
  assert.equal(ticket.approvalId, 'approval-1');
  assert.match(ticket.bindingFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(ticket), true);
});

test('canonical binding is stable across JSON object key order and capability set order', async () => {
  const a = invocation();
  const b = invocation({}, {
    requestedCapabilityIds: ['artifact.read', 'cms.publish'],
    arguments: {
      body: { publish: true, title: 'Release' },
      path: '/news/update',
    },
  });
  const left = await createApprovalBindingFingerprintV1({ policyDecision: policy(), invocation: a, cryptoApi: webcrypto });
  const right = await createApprovalBindingFingerprintV1({ policyDecision: policy(), invocation: b, cryptoApi: webcrypto });
  assert.equal(left, right);
});

test('ticket creation rejects non-approval and identity-mismatched policy decisions', async () => {
  await assert.rejects(
    createApprovalTicketV1({ policyDecision: policy({ decision: 'ALLOW', approvalId: '' }), invocation: invocation(), cryptoApi: webcrypto }),
    /REQUIRE_APPROVAL/,
  );
  await assert.rejects(
    createApprovalTicketV1({ policyDecision: policy({ invocationId: 'inv-other' }), invocation: invocation(), cryptoApi: webcrypto }),
    /invocationId does not match/,
  );
  await assert.rejects(
    createApprovalTicketV1({ policyDecision: policy(), invocation: invocation({}, { policyDecisionId: 'policy-other' }), cryptoApi: webcrypto }),
    /policyDecisionId does not match/,
  );
});

test('owner approval resolves once and permits durable later resume of exact binding', async () => {
  const p = policy();
  const i = invocation();
  const pending = await createApprovalTicketV1({
    policyDecision: p,
    invocation: i,
    expiresAt: '2026-09-24T23:00:00Z',
    cryptoApi: webcrypto,
  });
  const approved = await resolveApprovalTicketV1({
    ticket: pending,
    resolution: resolution(),
    policyDecision: p,
    invocation: i,
    cryptoApi: webcrypto,
  });
  assert.equal(approved.status, ApprovalTicketStatus.APPROVED);
  assert.equal(approved.revision, 2);
  assert.equal(approved.resolutionDecision, ApprovalResolutionDecision.APPROVE);
  assert.equal(Object.isFrozen(approved), true);

  const resumed = await assertApprovedForInvocationV1({
    ticket: approved,
    policyDecision: p,
    invocation: i,
    at: '2026-10-24T22:35:00Z',
    cryptoApi: webcrypto,
  });
  assert.equal(resumed.approvalId, pending.approvalId);
  await assert.rejects(
    resolveApprovalTicketV1({ ticket: approved, resolution: resolution({ resolutionId: 'resolution-2' }), policyDecision: p, invocation: i, cryptoApi: webcrypto }),
    /Only a PENDING/,
  );
});

test('argument, capability, policy or parent identity swap invalidates an approval binding', async () => {
  const p = policy();
  const i = invocation();
  const pending = await createApprovalTicketV1({ policyDecision: p, invocation: i, cryptoApi: webcrypto });
  for (const changed of [
    invocation({ path: '/news/other' }),
    invocation({}, { requestedCapabilityIds: ['cms.publish'] }),
    invocation({}, { parentInvocationId: 'agent-job-2' }),
  ]) {
    await assert.rejects(
      resolveApprovalTicketV1({ ticket: pending, resolution: resolution(), policyDecision: p, invocation: changed, cryptoApi: webcrypto }),
      /binding fingerprint/,
    );
  }
  await assert.rejects(
    resolveApprovalTicketV1({
      ticket: pending,
      resolution: resolution(),
      policyDecision: policy({ reasonCode: 'DIFFERENT_REASON' }),
      invocation: i,
      cryptoApi: webcrypto,
    }),
    /binding fingerprint/,
  );
});

test('deny is durable and can never satisfy approved-resume assertion', async () => {
  const p = policy();
  const i = invocation();
  const pending = await createApprovalTicketV1({ policyDecision: p, invocation: i, cryptoApi: webcrypto });
  const denied = await resolveApprovalTicketV1({
    ticket: pending,
    resolution: resolution({ decision: ApprovalResolutionDecision.DENY }),
    policyDecision: p,
    invocation: i,
    cryptoApi: webcrypto,
  });
  assert.equal(denied.status, ApprovalTicketStatus.DENIED);
  await assert.rejects(
    assertApprovedForInvocationV1({ ticket: denied, policyDecision: p, invocation: i, at: '2026-09-24T22:36:00Z', cryptoApi: webcrypto }),
    /not approved/,
  );
});

test('pending expiry blocks late owner resolution but does not erase an approval granted in time', async () => {
  const p = policy();
  const i = invocation();
  const pending = await createApprovalTicketV1({
    policyDecision: p,
    invocation: i,
    expiresAt: '2026-09-24T22:34:00Z',
    cryptoApi: webcrypto,
  });
  assert.equal(approvalTicketStateAtV1(pending, '2026-09-24T22:34:01Z'), 'EXPIRED');
  await assert.rejects(
    resolveApprovalTicketV1({ ticket: pending, resolution: resolution(), policyDecision: p, invocation: i, cryptoApi: webcrypto }),
    /expired before resolution/,
  );

  const pending2 = await createApprovalTicketV1({
    policyDecision: p,
    invocation: i,
    expiresAt: '2026-09-24T22:36:00Z',
    cryptoApi: webcrypto,
  });
  const approved = await resolveApprovalTicketV1({
    ticket: pending2,
    resolution: resolution(),
    policyDecision: p,
    invocation: i,
    cryptoApi: webcrypto,
  });
  assert.equal(
    (await assertApprovedForInvocationV1({
      ticket: approved,
      policyDecision: p,
      invocation: i,
      at: '2027-01-01T00:00:00Z',
      cryptoApi: webcrypto,
    })).status,
    ApprovalTicketStatus.APPROVED,
  );
});

test('resolution must match approval id and optimistic revision', async () => {
  const pending = await createApprovalTicketV1({ policyDecision: policy(), invocation: invocation(), cryptoApi: webcrypto });
  await assert.rejects(
    resolveApprovalTicketV1({
      ticket: pending,
      resolution: resolution({ approvalId: 'approval-other' }),
      policyDecision: policy(),
      invocation: invocation(),
      cryptoApi: webcrypto,
    }),
    /approvalId mismatch/,
  );
  await assert.rejects(
    resolveApprovalTicketV1({
      ticket: pending,
      resolution: resolution({ expectedRevision: 2 }),
      policyDecision: policy(),
      invocation: invocation(),
      cryptoApi: webcrypto,
    }),
    /revision mismatch/,
  );
});

test('strict boundary rejects coerced, prototype, accessor, symbol and hidden authority fields', async () => {
  await assert.rejects(
    createApprovalTicketV1({ policyDecision: policy({ schemaVersion: '1' }), invocation: invocation(), cryptoApi: webcrypto }),
    /schemaVersion/,
  );
  await assert.rejects(
    createApprovalTicketV1({ policyDecision: policy({ approvalId: 1 }), invocation: invocation(), cryptoApi: webcrypto }),
    /approvalId must be a string/,
  );

  const inherited = Object.create({ resolutionId: 'inherited' });
  Object.assign(inherited, resolution());
  await assert.rejects(
    resolveApprovalTicketV1({
      ticket: await createApprovalTicketV1({ policyDecision: policy(), invocation: invocation(), cryptoApi: webcrypto }),
      resolution: inherited,
      policyDecision: policy(),
      invocation: invocation(),
      cryptoApi: webcrypto,
    }),
    /plain object/,
  );

  const accessor = resolution();
  Object.defineProperty(accessor, 'resolvedBy', { enumerable: true, get() { throw new Error('getter executed'); } });
  await assert.rejects(
    resolveApprovalTicketV1({
      ticket: await createApprovalTicketV1({ policyDecision: policy(), invocation: invocation(), cryptoApi: webcrypto }),
      resolution: accessor,
      policyDecision: policy(),
      invocation: invocation(),
      cryptoApi: webcrypto,
    }),
    /enumerable data fields only/,
  );

  const symbol = resolution();
  symbol[Symbol('authority')] = 'owner';
  await assert.rejects(
    resolveApprovalTicketV1({
      ticket: await createApprovalTicketV1({ policyDecision: policy(), invocation: invocation(), cryptoApi: webcrypto }),
      resolution: symbol,
      policyDecision: policy(),
      invocation: invocation(),
      cryptoApi: webcrypto,
    }),
    /symbol fields/,
  );

  const hidden = resolution();
  Object.defineProperty(hidden, 'shadowAuthority', { value: 'owner', enumerable: false });
  await assert.rejects(
    resolveApprovalTicketV1({
      ticket: await createApprovalTicketV1({ policyDecision: policy(), invocation: invocation(), cryptoApi: webcrypto }),
      resolution: hidden,
      policyDecision: policy(),
      invocation: invocation(),
      cryptoApi: webcrypto,
    }),
    /enumerable data fields only|unknown field/,
  );
});

test('normalized ticket rejects caller-supplied resolved state without complete coherent resolution', () => {
  assert.throws(() => normalizeApprovalTicketV1({
    schemaVersion: 1,
    revision: 2,
    approvalId: 'approval-1',
    invocationId: 'inv-1',
    policyDecisionId: 'policy-1',
    bindingFingerprint: `sha256:${'a'.repeat(64)}`,
    requestedAt: '2026-09-24T22:30:00Z',
    expiresAt: '',
    status: 'APPROVED',
    resolutionId: '',
    resolutionDecision: 'APPROVE',
    resolvedBy: 'owner:primary',
    resolvedAt: '2026-09-24T22:35:00Z',
  }), /complete resolution fields/);
});
