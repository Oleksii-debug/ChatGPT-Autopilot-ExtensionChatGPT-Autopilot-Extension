import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_WORKSPACE_PROVIDER_ID,
  GoogleWorkspaceAgentProviderV1,
  GoogleWorkspaceCapabilityId,
  GoogleWorkspaceToolId,
} from '../src/core/google-workspace-agent-provider.js';

const at = '2026-09-25T00:10:00.000Z';

function invocation(toolId, capabilityId, args = {}, invocationId = 'google-inv-1') {
  return {
    schemaVersion: 1,
    invocationId,
    toolId,
    providerId: GOOGLE_WORKSPACE_PROVIDER_ID,
    requestedCapabilityIds: [capabilityId],
    policyDecisionId: `decision-${invocationId}`,
    arguments: args,
    createdAt: at,
    parentInvocationId: null,
  };
}

function decision(invocationId = 'google-inv-1', kind = 'ALLOW') {
  return {
    schemaVersion: 1,
    decisionId: `decision-${invocationId}`,
    invocationId,
    decision: kind,
    reasonCode: 'OWNER_POLICY',
    reason: '',
    approvalId: null,
    decidedAt: at,
  };
}

function client(overrides = {}) {
  return {
    searchDrive: async args => ({ operation: 'searchDrive', args }),
    getDriveFile: async args => ({ operation: 'getDriveFile', args }),
    readDriveText: async args => ({ operation: 'readDriveText', args }),
    searchGmail: async args => ({ operation: 'searchGmail', args }),
    getGmailMessage: async args => ({ operation: 'getGmailMessage', args }),
    getGmailThread: async args => ({ operation: 'getGmailThread', args }),
    getGmailAttachment: async args => ({ operation: 'getGmailAttachment', args }),
    createGmailDraft: async args => ({ operation: 'createGmailDraft', args }),
    sendGmailDraft: async args => ({ operation: 'sendGmailDraft', args }),
    ...overrides,
  };
}

const allCapabilities = Object.values(GoogleWorkspaceCapabilityId);

test('Google Workspace V1 advertises seven reads plus draft-create and draft-send mutations', () => {
  const provider = new GoogleWorkspaceAgentProviderV1({ workspaceClient: client(), grantedCapabilityIds: allCapabilities });
  const tools = provider.tools();
  assert.equal(tools.length, 9);
  assert.equal(tools.filter(tool => tool.readOnly === true).length, 7);
  const effectful = tools.filter(tool => tool.readOnly === false);
  assert.deepEqual(effectful.map(tool => tool.toolId), [GoogleWorkspaceToolId.GMAIL_DRAFT_CREATE, GoogleWorkspaceToolId.GMAIL_DRAFT_SEND]);
  assert.ok(tools.every(tool => tool.providerId === GOOGLE_WORKSPACE_PROVIDER_ID));
  assert.ok(tools.every(tool => !/(trash|delete|update|reply|forward)/iu.test(tool.toolId)));
});

test('provider requires exact owner ALLOW and granted capability before client invocation', async () => {
  let calls = 0;
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client({ searchGmail: async args => { calls += 1; return { args }; } }),
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_SEARCH],
    now: () => Date.parse(at),
  });
  const inv = invocation(GoogleWorkspaceToolId.GMAIL_SEARCH, GoogleWorkspaceCapabilityId.GMAIL_SEARCH, { userId: 'me' });
  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: decision('google-inv-1', 'DENY') }), /not authorized/i);
  await assert.rejects(
    () => provider.invoke({ invocation: { ...inv, requestedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_READ] }, policyDecision: decision() }),
    /capabilit|granted|tool/i,
  );
  assert.equal(calls, 0);
  const result = await provider.invoke({ invocation: inv, policyDecision: decision() });
  assert.equal(result.providerId, GOOGLE_WORKSPACE_PROVIDER_ID);
  assert.equal(result.invocationId, 'google-inv-1');
  assert.equal(result.observedAt, at);
  assert.equal(calls, 1);
});

test('each tool dispatches through the single workspace client without creating another control plane', async () => {
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client(),
    grantedCapabilityIds: allCapabilities,
    now: () => Date.parse(at),
  });
  const cases = [
    [GoogleWorkspaceToolId.DRIVE_SEARCH, GoogleWorkspaceCapabilityId.DRIVE_SEARCH, 'searchDrive', { parentId: 'root_1' }],
    [GoogleWorkspaceToolId.DRIVE_FILE_GET, GoogleWorkspaceCapabilityId.DRIVE_FILE_READ, 'getDriveFile', { fileId: 'file_1' }],
    [GoogleWorkspaceToolId.DRIVE_FILE_READ_TEXT, GoogleWorkspaceCapabilityId.DRIVE_FILE_READ, 'readDriveText', { fileId: 'file_1' }],
    [GoogleWorkspaceToolId.GMAIL_SEARCH, GoogleWorkspaceCapabilityId.GMAIL_SEARCH, 'searchGmail', { userId: 'me' }],
    [GoogleWorkspaceToolId.GMAIL_MESSAGE_GET, GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_READ, 'getGmailMessage', { userId: 'me', messageId: 'msg_1' }],
    [GoogleWorkspaceToolId.GMAIL_THREAD_GET, GoogleWorkspaceCapabilityId.GMAIL_MESSAGE_READ, 'getGmailThread', { userId: 'me', threadId: 'thread_1' }],
    [GoogleWorkspaceToolId.GMAIL_ATTACHMENT_GET, GoogleWorkspaceCapabilityId.GMAIL_ATTACHMENT_READ, 'getGmailAttachment', { userId: 'me', messageId: 'msg_1', attachmentId: 'att_1' }],
    [GoogleWorkspaceToolId.GMAIL_DRAFT_CREATE, GoogleWorkspaceCapabilityId.GMAIL_DRAFT_CREATE, 'createGmailDraft', { userId: 'owner@example.com', rawMessageBase64Url: 'QUJD' }],
    [GoogleWorkspaceToolId.GMAIL_DRAFT_SEND, GoogleWorkspaceCapabilityId.GMAIL_DRAFT_SEND, 'sendGmailDraft', { userId: 'owner@example.com', draftId: 'draft_1', rawMessageBase64Url: 'QUJD' }],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const [toolId, capabilityId, operation, args] = cases[index];
    const invocationId = `google-inv-${index + 10}`;
    const result = await provider.invoke({ invocation: invocation(toolId, capabilityId, args, invocationId), policyDecision: decision(invocationId) });
    assert.equal(result.result.operation, operation);
    assert.deepEqual(result.result.args, args);
  }
});

test('client read failures remain explicitly no-effect and retry-safe', async () => {
  const leakedSecret = 'provider-secret-must-not-cross-boundary';
  const failure = Object.assign(new Error(`offline ${leakedSecret}`), { code: 'GOOGLE_TRANSPORT_ERROR', status: 0, secret: leakedSecret });
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client({ getDriveFile: async () => { throw failure; } }),
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.DRIVE_FILE_READ],
  });
  const inv = invocation(GoogleWorkspaceToolId.DRIVE_FILE_GET, GoogleWorkspaceCapabilityId.DRIVE_FILE_READ, { fileId: 'file_1' });
  await assert.rejects(
    () => provider.invoke({ invocation: inv, policyDecision: decision() }),
    error => error.code === 'GOOGLE_TRANSPORT_ERROR'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true
      && error.invocationId === 'google-inv-1'
      && !String(error.message).includes(leakedSecret)
      && !Object.prototype.hasOwnProperty.call(error, 'cause'),
  );
});

test('accessor-backed invocation argument is rejected before getter execution or client call', async () => {
  let getterReads = 0;
  let calls = 0;
  const args = {};
  Object.defineProperty(args, 'userId', { enumerable: true, get() { getterReads += 1; return 'me'; } });
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client({ searchGmail: async value => { calls += 1; return value; } }),
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_SEARCH],
  });
  const inv = invocation(GoogleWorkspaceToolId.GMAIL_SEARCH, GoogleWorkspaceCapabilityId.GMAIL_SEARCH, args);
  await assert.rejects(() => provider.invoke({ invocation: inv, policyDecision: decision() }), /enumerable data property/i);
  assert.equal(getterReads, 0);
  assert.equal(calls, 0);
});

test('accessor/sparse capability arrays fail closed before value reads', () => {
  let getterReads = 0;
  const capabilities = [];
  Object.defineProperty(capabilities, '0', { enumerable: true, get() { getterReads += 1; return GoogleWorkspaceCapabilityId.GMAIL_SEARCH; } });
  capabilities.length = 1;
  assert.throws(
    () => new GoogleWorkspaceAgentProviderV1({ workspaceClient: client(), grantedCapabilityIds: capabilities }),
    /enumerable text data property/i,
  );
  assert.equal(getterReads, 0);

  const sparse = new Array(1);
  assert.throws(() => new GoogleWorkspaceAgentProviderV1({ workspaceClient: client(), grantedCapabilityIds: sparse }), /dense canonical array/i);
});

test('authority arrays are descriptor-snapshotted without ordinary caller reads', async () => {
  let reads = 0;
  const proxiedGranted = new Proxy([GoogleWorkspaceCapabilityId.GMAIL_SEARCH], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client(),
    grantedCapabilityIds: proxiedGranted,
    now: () => Date.parse(at),
  });
  assert.equal(reads, 0, 'granted capability normalization must not read caller properties');

  const proxiedRequested = new Proxy([GoogleWorkspaceCapabilityId.GMAIL_SEARCH], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const inv = invocation(
    GoogleWorkspaceToolId.GMAIL_SEARCH,
    GoogleWorkspaceCapabilityId.GMAIL_SEARCH,
    { userId: 'me' },
  );
  inv.requestedCapabilityIds = proxiedRequested;
  const result = await provider.invoke({ invocation: inv, policyDecision: decision() });
  assert.equal(result.result.operation, 'searchGmail');
  assert.equal(reads, 0, 'requested capability normalization must not read caller properties');
});

test('provider rejects noncanonical authority timestamp aliases before canonical contract normalizers', async () => {
  let calls = 0;
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client({
      searchGmail: async args => {
        calls += 1;
        return { operation: 'searchGmail', args };
      },
    }),
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_SEARCH],
    now: () => Date.parse(at),
  });
  const base = invocation(
    GoogleWorkspaceToolId.GMAIL_SEARCH,
    GoogleWorkspaceCapabilityId.GMAIL_SEARCH,
    { userId: 'me' },
  );

  await assert.rejects(
    () => provider.invoke({
      invocation: { ...base, createdAt: '2026-09-25T00:10:00Z' },
      policyDecision: decision(),
    }),
    /ToolInvocationV1\.createdAt must be an exact canonical timestamp/i,
  );
  await assert.rejects(
    () => provider.invoke({
      invocation: base,
      policyDecision: { ...decision(), decidedAt: '2026-09-25T00:10:00Z' },
    }),
    /PolicyDecisionV1\.decidedAt must be an exact canonical timestamp/i,
  );
  assert.equal(calls, 0);

  const result = await provider.invoke({ invocation: base, policyDecision: decision() });
  assert.equal(result.result.operation, 'searchGmail');
  assert.equal(calls, 1);
});

test('provider rejects coercive authority aliases before canonical contract normalizers', async () => {
  const provider = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client(),
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_SEARCH],
  });
  const base = invocation(GoogleWorkspaceToolId.GMAIL_SEARCH, GoogleWorkspaceCapabilityId.GMAIL_SEARCH, { userId: 'me' });
  await assert.rejects(
    () => provider.invoke({ invocation: { ...base, schemaVersion: '1' }, policyDecision: decision() }),
    /schemaVersion must be numeric 1/i,
  );
  await assert.rejects(
    () => provider.invoke({ invocation: { ...base, invocationId: 7 }, policyDecision: { ...decision(), invocationId: 7 } }),
    /canonical text identity/i,
  );
  await assert.rejects(
    () => provider.invoke({ invocation: { ...base, requestedCapabilityIds: [7] }, policyDecision: decision() }),
    /canonical text identity/i,
  );
  await assert.rejects(
    () => provider.invoke({
      invocation: {
        ...base,
        requestedCapabilityIds: [` ${GoogleWorkspaceCapabilityId.GMAIL_SEARCH}`],
      },
      policyDecision: decision(),
    }),
    /exact canonical text identity/i,
  );
  await assert.rejects(
    () => provider.invoke({
      invocation: { ...base, toolId: ` ${GoogleWorkspaceToolId.GMAIL_SEARCH}` },
      policyDecision: decision(),
    }),
    /exact canonical text identity/i,
  );
});


test('workspace client method accessors are rejected without executing getters', () => {
  let getterReads = 0;
  const workspaceClient = client();
  Object.defineProperty(workspaceClient, 'searchGmail', {
    enumerable: true,
    configurable: true,
    get() {
      getterReads += 1;
      return async () => ({});
    },
  });
  assert.throws(
    () => new GoogleWorkspaceAgentProviderV1({
      workspaceClient,
      grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_SEARCH],
    }),
    /data method/i,
  );
  assert.equal(getterReads, 0);
});


test('effectful Gmail draft failures preserve no-effect preflight vs uncertain post-dispatch semantics without leaking causes', async () => {
  const providerNoEffect = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client({
      createGmailDraft: async () => {
        const error = new Error('raw secret');
        error.code = 'GOOGLE_SCHEMA_INVALID';
        error.effectMayHaveOccurred = false;
        error.safeToRetry = true;
        throw error;
      },
    }),
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_DRAFT_CREATE],
  });
  const inv = invocation(
    GoogleWorkspaceToolId.GMAIL_DRAFT_CREATE,
    GoogleWorkspaceCapabilityId.GMAIL_DRAFT_CREATE,
    { userId: 'owner@example.com', rawMessageBase64Url: 'QUJD' },
    'google-draft-effect',
  );
  await assert.rejects(
    () => providerNoEffect.invoke({ invocation: inv, policyDecision: decision(inv.invocationId) }),
    error => error.effectMayHaveOccurred === false && error.safeToRetry === true && !String(error.message).includes('raw secret'),
  );

  const providerAmbiguous = new GoogleWorkspaceAgentProviderV1({
    workspaceClient: client({
      createGmailDraft: async () => {
        const error = new Error('Bearer secret disappeared');
        error.code = 'GOOGLE_MUTATION_TRANSPORT_UNCERTAIN';
        error.effectMayHaveOccurred = true;
        error.safeToRetry = false;
        throw error;
      },
    }),
    grantedCapabilityIds: [GoogleWorkspaceCapabilityId.GMAIL_DRAFT_CREATE],
  });
  await assert.rejects(
    () => providerAmbiguous.invoke({ invocation: inv, policyDecision: decision(inv.invocationId) }),
    error => error.effectMayHaveOccurred === true && error.safeToRetry === false && !String(error.message).includes('Bearer secret'),
  );
});
