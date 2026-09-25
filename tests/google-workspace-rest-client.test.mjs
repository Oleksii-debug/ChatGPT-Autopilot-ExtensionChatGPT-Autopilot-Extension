import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GMAIL_API_ORIGIN,
  GOOGLE_DRIVE_API_ORIGIN,
  GoogleWorkspaceRestClientV1,
} from '../src/core/google-workspace-rest-client.js';

const rootId = 'root_123';
const folderId = 'folder_456';
const fileId = 'file_789';
const userId = 'owner@example.com';

function response(status, body, { binary = false } = {}) {
  const bytes = binary ? body : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function credentialResolver(calls, secret = 'oauth-super-secret') {
  return {
    resolveCredential: async request => {
      calls.push(request);
      return { credentialId: request.credentialId, targetOrigin: request.targetOrigin, secret };
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    nativeClient: credentialResolver([]),
    driveCredentialId: 'google-drive-main',
    gmailCredentialId: 'google-gmail-main',
    allowedDriveRootIds: [rootId],
    allowedDriveFileIds: [],
    allowedGmailUsers: [userId],
    fetchImpl: async () => response(500, { error: { message: 'unexpected test request' } }),
    ...overrides,
  };
}

function driveFile(id, { parents = [], mimeType = 'application/vnd.google-apps.folder', name = id, size = undefined } = {}) {
  return {
    id,
    name,
    mimeType,
    parents,
    modifiedTime: '2026-09-25T00:00:00.000Z',
    ...(size == null ? {} : { size: String(size) }),
    trashed: false,
    version: '1',
  };
}

test('config rejects accessor-backed authority without executing getter', () => {
  let getterReads = 0;
  const config = baseConfig();
  Object.defineProperty(config, 'allowedGmailUsers', {
    enumerable: true,
    get() { getterReads += 1; return [userId]; },
  });
  assert.throws(() => new GoogleWorkspaceRestClientV1(config), /enumerable data property/i);
  assert.equal(getterReads, 0);
});

test('config allowlists are descriptor-snapshotted without ordinary array reads', () => {
  let reads = 0;
  const users = new Proxy([userId], {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const client = new GoogleWorkspaceRestClientV1(baseConfig({ allowedGmailUsers: users }));
  assert.deepEqual(client.allowedGmailUsers, [userId]);
  assert.equal(reads, 0, 'owner allowlist normalization must not read caller properties');
});

test('Drive search is root-scoped, bounded, credential-origin-bound and secret-free', async () => {
  const credentialCalls = [];
  const fetchCalls = [];
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    nativeClient: credentialResolver(credentialCalls),
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === `/drive/v3/files/${rootId}`) return response(200, driveFile(rootId));
      if (parsed.pathname === '/drive/v3/files') {
        return response(200, {
          files: [driveFile(fileId, { parents: [rootId], mimeType: 'text/plain', name: 'notes.txt', size: 7 })],
          nextPageToken: 'next-token',
        });
      }
      return response(404, { error: { message: 'missing' } });
    },
  }));

  const result = await client.searchDrive({ parentId: rootId, nameContains: "O'Brien\\draft", pageSize: 25 });
  assert.equal(result.parentId, rootId);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].id, fileId);
  assert.equal(result.nextPageToken, 'next-token');
  assert.equal(fetchCalls.length, 3);
  const listUrl = new URL(fetchCalls[1].url);
  assert.equal(listUrl.origin, GOOGLE_DRIVE_API_ORIGIN);
  assert.match(listUrl.searchParams.get('q'), /root_123/);
  assert.match(listUrl.searchParams.get('q'), /O\\'Brien\\\\draft/);
  assert.equal(listUrl.searchParams.get('pageSize'), '25');
  assert.equal(fetchCalls[1].options.method, 'GET');
  assert.equal(fetchCalls[1].options.redirect, 'error');
  assert.equal(fetchCalls[1].options.headers.Authorization, 'Bearer oauth-super-secret');
  assert.equal(JSON.stringify(result).includes('oauth-super-secret'), false);
  assert.deepEqual(credentialCalls, [
    { credentialId: 'google-drive-main', targetOrigin: GOOGLE_DRIVE_API_ORIGIN },
    { credentialId: 'google-drive-main', targetOrigin: GOOGLE_DRIVE_API_ORIGIN },
    { credentialId: 'google-drive-main', targetOrigin: GOOGLE_DRIVE_API_ORIGIN },
  ]);
});

test('Drive descendant text read validates ancestry before downloading bytes', async () => {
  const urls = [];
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    fetchImpl: async (url) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === `/drive/v3/files/${fileId}` && parsed.searchParams.get('alt') === 'media') {
        return response(200, new TextEncoder().encode('привіт'), { binary: true });
      }
      if (parsed.pathname === `/drive/v3/files/${fileId}`) return response(200, driveFile(fileId, { parents: [folderId], mimeType: 'text/plain', size: 12 }));
      if (parsed.pathname === `/drive/v3/files/${folderId}`) return response(200, driveFile(folderId, { parents: [rootId] }));
      if (parsed.pathname === `/drive/v3/files/${rootId}`) return response(200, driveFile(rootId));
      return response(404, { error: { message: 'missing' } });
    },
  }));

  const result = await client.readDriveText({ fileId });
  assert.equal(result.file.id, fileId);
  assert.equal(result.text, 'привіт');
  assert.equal(result.mediaType, 'text/plain');
  assert.equal(urls.filter(url => new URL(url).searchParams.get('alt') === 'media').length, 1);
  assert.ok(urls.includes(`${GOOGLE_DRIVE_API_ORIGIN}/drive/v3/files/${fileId}?alt=media`));
});

test('Drive native document uses only admitted text export types', async () => {
  const urls = [];
  const docId = 'doc_123';
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    allowedDriveFileIds: [docId],
    fetchImpl: async (url) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === `/drive/v3/files/${docId}/export`) return response(200, '# title\n');
      if (parsed.pathname === `/drive/v3/files/${docId}`) return response(200, driveFile(docId, { mimeType: 'application/vnd.google-apps.document' }));
      return response(404, { error: { message: 'missing' } });
    },
  }));
  const exported = await client.readDriveText({ fileId: docId, exportMimeType: 'text/markdown' });
  assert.equal(exported.mediaType, 'text/markdown');
  assert.equal(exported.text, '# title\n');
  assert.ok(urls.some(url => new URL(url).pathname.endsWith(`/${docId}/export`) && new URL(url).searchParams.get('mimeType') === 'text/markdown'));
  await assert.rejects(() => client.readDriveText({ fileId: docId, exportMimeType: 'application/pdf' }), error => error.code === 'GOOGLE_DRIVE_EXPORT_NOT_ALLOWED');
});

test('Drive search revalidates descendant scope after list observation before returning data', async () => {
  let listed = false;
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/drive/v3/files') {
        listed = true;
        return response(200, { files: [driveFile(fileId, { parents: [folderId], mimeType: 'text/plain' })] });
      }
      if (parsed.pathname === `/drive/v3/files/${folderId}`) {
        return response(200, driveFile(folderId, { parents: [listed ? 'foreign_root' : rootId] }));
      }
      if (parsed.pathname === `/drive/v3/files/${rootId}`) return response(200, driveFile(rootId));
      if (parsed.pathname === '/drive/v3/files/foreign_root') return response(200, driveFile('foreign_root'));
      return response(404, { error: { message: 'missing' } });
    },
  }));
  await assert.rejects(
    () => client.searchDrive({ parentId: folderId }),
    error => ['GOOGLE_DRIVE_RESOURCE_NOT_ALLOWED', 'GOOGLE_DRIVE_SCOPE_CHANGED'].includes(error.code),
  );
});

test('Drive file metadata revalidates descendant scope after observation before returning data', async () => {
  let targetReads = 0;
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === `/drive/v3/files/${fileId}`) {
        targetReads += 1;
        return response(200, driveFile(fileId, {
          parents: [targetReads === 1 ? folderId : 'foreign_root'],
          mimeType: 'text/plain',
        }));
      }
      if (parsed.pathname === `/drive/v3/files/${folderId}`) {
        return response(200, driveFile(folderId, { parents: [rootId] }));
      }
      if (parsed.pathname === `/drive/v3/files/${rootId}`) return response(200, driveFile(rootId));
      if (parsed.pathname === '/drive/v3/files/foreign_root') return response(200, driveFile('foreign_root'));
      return response(404, { error: { message: 'missing' } });
    },
  }));

  await assert.rejects(
    () => client.getDriveFile({ fileId }),
    error => ['GOOGLE_DRIVE_RESOURCE_NOT_ALLOWED', 'GOOGLE_DRIVE_SCOPE_CHANGED'].includes(error.code),
  );
  assert.equal(targetReads, 2);
});

test('Drive resource outside admitted roots is rejected before content download', async () => {
  let mediaReads = 0;
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.searchParams.get('alt') === 'media') mediaReads += 1;
      if (parsed.pathname === '/drive/v3/files/foreign_1') return response(200, driveFile('foreign_1', { parents: [], mimeType: 'text/plain', size: 3 }));
      return response(404, { error: { message: 'missing' } });
    },
  }));
  await assert.rejects(() => client.readDriveText({ fileId: 'foreign_1' }), error => error.code === 'GOOGLE_DRIVE_RESOURCE_NOT_ALLOWED');
  assert.equal(mediaReads, 0);
});

test('Gmail principal must be an exact explicit owner email and never ambiguous me', async () => {
  for (const invalid of ['me', ' owner@example.com', 'owner@example.com ', `owner${String.fromCharCode(0)}@example.com`, `owner@example.com${String.fromCharCode(127)}`]) {
    assert.throws(
      () => new GoogleWorkspaceRestClientV1(baseConfig({ allowedGmailUsers: [invalid] })),
      /exact owner-configured email address/i,
    );
  }
  const credentialCalls = [];
  let fetchCount = 0;
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    nativeClient: credentialResolver(credentialCalls),
    fetchImpl: async () => { fetchCount += 1; return response(200, {}); },
  }));
  await assert.rejects(
    () => client.searchGmail({ userId: 'me' }),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  await assert.rejects(
    () => client.searchGmail({ userId: 'OWNER@example.com' }),
    error => error.code === 'GOOGLE_GMAIL_USER_NOT_ALLOWED',
  );
  assert.equal(fetchCount, 0);
  assert.deepEqual(credentialCalls, []);
});

test('public transport rejects malformed path and query objects before credential resolution', async () => {
  let resolverCalls = 0;
  let queryStringCalls = 0;
  const nativeClient = {
    resolveCredential: async () => {
      resolverCalls += 1;
      return { credentialId: 'google-drive-main', targetOrigin: GOOGLE_DRIVE_API_ORIGIN, secret: 'must-not-be-used' };
    },
  };
  const client = new GoogleWorkspaceRestClientV1(baseConfig({ nativeClient }));
  await assert.rejects(
    () => client.request(GOOGLE_DRIVE_API_ORIGIN, 7, null, 'google-drive-main', 1024),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  class HostileParams extends URLSearchParams {
    toString() {
      queryStringCalls += 1;
      return 'x=1';
    }
  }
  await assert.rejects(
    () => client.request(GOOGLE_DRIVE_API_ORIGIN, '/drive/v3/files', new HostileParams(), 'google-drive-main', 1024),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  await assert.rejects(
    () => client.request(GOOGLE_DRIVE_API_ORIGIN, '/drive/v3/files', null, 'google-drive-main', 0),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  await assert.rejects(
    () => client.request(GOOGLE_DRIVE_API_ORIGIN, '/drive/v3/files', null, 'google-drive-main', 1024, 'application/json\r\nX-Leak: 1'),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  assert.equal(queryStringCalls, 0);
  assert.equal(resolverCalls, 0);
});

test('resolved credential identity and target origin are exact-bound before fetch', async () => {
  const cases = [
    { credentialId: undefined, targetOrigin: GOOGLE_DRIVE_API_ORIGIN, secret: 'wrongly-unbound-secret' },
    { credentialId: 'google-gmail-main', targetOrigin: GOOGLE_DRIVE_API_ORIGIN, secret: 'wrong-id-secret' },
    { credentialId: 'google-drive-main', targetOrigin: GMAIL_API_ORIGIN, secret: 'wrong-origin-secret' },
  ];
  for (const resolved of cases) {
    let fetchCount = 0;
    const nativeClient = {
      resolveCredential: async request => ({
        ...(resolved.credentialId === undefined ? {} : { credentialId: resolved.credentialId }),
        targetOrigin: resolved.targetOrigin,
        secret: resolved.secret,
      }),
    };
    const client = new GoogleWorkspaceRestClientV1(baseConfig({
      nativeClient,
      fetchImpl: async () => { fetchCount += 1; return response(200, {}); },
    }));
    await assert.rejects(
      () => client.request(GOOGLE_DRIVE_API_ORIGIN, '/drive/v3/files', new URLSearchParams(), 'google-drive-main', 1024),
      error => error.code === 'GOOGLE_CREDENTIAL_SCOPE_MISMATCH',
    );
    assert.equal(fetchCount, 0);
  }
});

test('transport binds each Google service origin to its configured credential before resolver or fetch', async () => {
  const credentialCalls = [];
  let fetchCount = 0;
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    nativeClient: credentialResolver(credentialCalls),
    fetchImpl: async () => { fetchCount += 1; return response(200, {}); },
  }));
  await assert.rejects(
    () => client.request(GOOGLE_DRIVE_API_ORIGIN, '/drive/v3/files', new URLSearchParams(), 'google-gmail-main', 1024),
    error => error.code === 'GOOGLE_CREDENTIAL_SCOPE_MISMATCH',
  );
  await assert.rejects(
    () => client.request(GMAIL_API_ORIGIN, `/gmail/v1/users/${encodeURIComponent(userId)}/messages`, new URLSearchParams(), 'google-drive-main', 1024),
    error => error.code === 'GOOGLE_CREDENTIAL_SCOPE_MISMATCH',
  );
  assert.equal(fetchCount, 0);
  assert.deepEqual(credentialCalls, []);
});

test('Gmail user outside owner allowlist is denied before credential resolution or network', async () => {
  const credentialCalls = [];
  let fetchCount = 0;
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    nativeClient: credentialResolver(credentialCalls),
    fetchImpl: async () => { fetchCount += 1; return response(200, {}); },
  }));
  await assert.rejects(() => client.searchGmail({ userId: 'other@example.com' }), error => error.code === 'GOOGLE_GMAIL_USER_NOT_ALLOWED');
  assert.equal(fetchCount, 0);
  assert.deepEqual(credentialCalls, []);
});

test('Gmail search and message read use fixed API origin and bounded formats', async () => {
  const credentialCalls = [];
  const urls = [];
  const messageId = '18fabc123';
  const threadId = '18fthread123';
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    nativeClient: credentialResolver(credentialCalls),
    fetchImpl: async (url) => {
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith(`/messages/${messageId}`)) {
        return response(200, { id: messageId, threadId, labelIds: ['INBOX'], snippet: 'hello', historyId: '9', internalDate: '1790294400000', sizeEstimate: 123, payload: { mimeType: 'text/plain', headers: [] } });
      }
      return response(200, { messages: [{ id: messageId, threadId }], resultSizeEstimate: 1 });
    },
  }));
  const listed = await client.searchGmail({ userId, q: 'is:unread', labelIds: ['INBOX'], pageSize: 10 });
  assert.deepEqual(listed.messages.map(item => item.id), [messageId]);
  const got = await client.getGmailMessage({ userId, messageId, format: 'metadata', metadataHeaders: ['Subject', 'From'] });
  assert.equal(got.id, messageId);
  assert.equal(got.payload.mimeType, 'text/plain');
  assert.equal(new URL(urls[0]).origin, GMAIL_API_ORIGIN);
  assert.equal(new URL(urls[0]).searchParams.get('q'), 'is:unread');
  assert.equal(new URL(urls[1]).searchParams.get('format'), 'METADATA');
  assert.deepEqual(new URL(urls[1]).searchParams.getAll('metadataHeaders'), ['Subject', 'From']);
  assert.equal(JSON.stringify(got).includes('oauth-super-secret'), false);
  assert.deepEqual(credentialCalls.map(item => item.targetOrigin), [GMAIL_API_ORIGIN, GMAIL_API_ORIGIN]);
  await assert.rejects(() => client.getGmailMessage({ userId, messageId, format: 'RAW' }), error => error.code === 'GOOGLE_SCHEMA_INVALID');
});

test('Gmail thread rejects a foreign message and attachment is exact-size bounded', async () => {
  const threadId = 'thread_1';
  const messageId = 'msg_1';
  const attachmentId = 'att_1';
  const data = 'aGk'; // "hi"
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    maxAttachmentBytes: 1024,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.includes('/attachments/')) return response(200, { size: 2, data });
      return response(200, {
        id: threadId,
        historyId: '4',
        messages: [{ id: messageId, threadId, labelIds: [], snippet: '', internalDate: '1', sizeEstimate: 2 }],
      });
    },
  }));
  const thread = await client.getGmailThread({ userId, threadId });
  assert.equal(thread.messages[0].threadId, threadId);
  const attachment = await client.getGmailAttachment({ userId, messageId, attachmentId });
  assert.equal(attachment.sizeBytes, 2);
  assert.equal(attachment.dataBase64Url, data);

  const bad = new GoogleWorkspaceRestClientV1(baseConfig({
    maxAttachmentBytes: 1024,
    fetchImpl: async () => response(200, { size: 3, data }),
  }));
  await assert.rejects(() => bad.getGmailAttachment({ userId, messageId, attachmentId }), error => error.code === 'GOOGLE_RESPONSE_INVALID');
});

test('read timeout is no-effect/retry-safe and malformed/oversized API data fails closed', async () => {
  const immediateTimer = callback => { callback(); return 1; };
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    setTimeoutImpl: immediateTimer,
    clearTimeoutImpl: () => {},
    requestTimeoutMs: 1000,
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal.aborted, true);
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  }));
  await assert.rejects(
    () => client.searchGmail({ userId }),
    error => error.code === 'GOOGLE_REQUEST_TIMEOUT' && error.effectMayHaveOccurred === false && error.safeToRetry === true,
  );

  const malformed = new GoogleWorkspaceRestClientV1(baseConfig({ fetchImpl: async () => response(200, '{bad json') }));
  await assert.rejects(() => malformed.searchGmail({ userId }), error => error.code === 'GOOGLE_RESPONSE_INVALID');

  const oversized = new GoogleWorkspaceRestClientV1(baseConfig({
    maxJsonBytes: 1024,
    fetchImpl: async () => response(200, { messages: [], padding: 'x'.repeat(2000) }),
  }));
  await assert.rejects(() => oversized.searchGmail({ userId }), error => error.code === 'GOOGLE_RESPONSE_TOO_LARGE');
});

test('public method rejects accessor request with zero getter execution', async () => {
  let reads = 0;
  const client = new GoogleWorkspaceRestClientV1(baseConfig());
  const request = {};
  Object.defineProperty(request, 'userId', { enumerable: true, get() { reads += 1; return userId; } });
  await assert.rejects(() => client.searchGmail(request), error => error.code === 'GOOGLE_SCHEMA_INVALID');
  assert.equal(reads, 0);
});

test('exact Drive file allowlist never widens into descendant-folder search authority', async () => {
  let listCalls = 0;
  const exactFolder = 'exact_folder';
  const child = 'child_file';
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    allowedDriveRootIds: [],
    allowedDriveFileIds: [exactFolder],
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === `/drive/v3/files/${exactFolder}`) return response(200, driveFile(exactFolder));
      if (parsed.pathname === '/drive/v3/files') { listCalls += 1; return response(200, { files: [driveFile(child, { parents: [exactFolder], mimeType: 'text/plain' })] }); }
      return response(404, { error: { message: 'missing' } });
    },
  }));
  const exact = await client.getDriveFile({ fileId: exactFolder });
  assert.equal(exact.id, exactFolder);
  await assert.rejects(() => client.searchDrive({ parentId: exactFolder }), error => error.code === 'GOOGLE_DRIVE_RESOURCE_NOT_ALLOWED');
  assert.equal(listCalls, 0);
});


test('credential resolver accessor is rejected without getter execution', () => {
  let getterReads = 0;
  const nativeClient = {};
  Object.defineProperty(nativeClient, 'resolveCredential', {
    enumerable: true,
    get() {
      getterReads += 1;
      return async () => ({ secret: 'must-not-run' });
    },
  });
  assert.throws(
    () => new GoogleWorkspaceRestClientV1(baseConfig({ nativeClient })),
    /data method/i,
  );
  assert.equal(getterReads, 0);
});

test('credential and transport failures redact provider-controlled secret text', async () => {
  const credentialSecret = 'credential-secret-must-not-leak';
  const badCredential = new GoogleWorkspaceRestClientV1(baseConfig({
    nativeClient: {
      resolveCredential: async () => {
        throw new Error(credentialSecret);
      },
    },
  }));
  await assert.rejects(
    () => badCredential.searchGmail({ userId }),
    error => error.code === 'GOOGLE_CREDENTIAL_UNAVAILABLE'
      && !String(error.message).includes(credentialSecret),
  );

  const transportSecret = 'transport-secret-must-not-leak';
  const badTransport = new GoogleWorkspaceRestClientV1(baseConfig({
    nativeClient: credentialResolver([], transportSecret),
    fetchImpl: async () => {
      throw new Error(`Bearer ${transportSecret} failed`);
    },
  }));
  await assert.rejects(
    () => badTransport.searchGmail({ userId }),
    error => error.code === 'GOOGLE_TRANSPORT_ERROR'
      && !String(error.message).includes(transportSecret),
  );
});


test('request deadline stays armed through streamed response body consumption', async () => {
  let deadline = null;
  let signal = null;
  let clearCalls = 0;
  let bodyReads = 0;
  let releaseCalls = 0;
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    requestTimeoutMs: 1000,
    setTimeoutImpl(callback) {
      deadline = callback;
      return 77;
    },
    clearTimeoutImpl(timer) {
      assert.equal(timer, 77);
      clearCalls += 1;
    },
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        status: 200,
        body: {
          getReader() {
            return {
              async read() {
                bodyReads += 1;
                assert.equal(typeof deadline, 'function', 'deadline must remain armed while body is consumed');
                deadline();
                assert.equal(signal.aborted, true);
                const error = new Error('aborted during body read');
                error.name = 'AbortError';
                throw error;
              },
              releaseLock() {
                releaseCalls += 1;
              },
            };
          },
        },
      };
    },
  }));

  await assert.rejects(
    () => client.searchGmail({ userId }),
    error => error.code === 'GOOGLE_REQUEST_TIMEOUT'
      && error.effectMayHaveOccurred === false
      && error.safeToRetry === true,
  );
  assert.equal(bodyReads, 1);
  assert.equal(releaseCalls, 1);
  assert.equal(clearCalls, 1);
});


test('Gmail draft create uses the exact owner principal, fixed POST endpoint, and bounded canonical body', async () => {
  const calls = [];
  const raw = 'RnJvbTogb3duZXJAZXhhbXBsZS5jb20NClRvOiB0b0BleGFtcGxlLmNvbQ0KU3ViamVjdDogVGVzdA0KDQpCb2R5';
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { id: 'draft_1', message: { id: 'msg_1', threadId: 'thread_1', labelIds: ['DRAFT'] } });
    },
  }));
  const result = await client.createGmailDraft({ userId, rawMessageBase64Url: raw });
  assert.equal(result.userId, userId);
  assert.equal(result.draftId, 'draft_1');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, GMAIL_API_ORIGIN);
  assert.equal(url.pathname, `/gmail/v1/users/${encodeURIComponent(userId)}/drafts`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.parse(calls[0].options.body).message.raw, raw);
  assert.equal(String(calls[0].options.body).includes('oauth-super-secret'), false);
});

test('Gmail draft create rejects aliases before network and treats post-dispatch transport loss as ambiguous', async () => {
  let calls = 0;
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('response lost after POST');
    },
  }));
  await assert.rejects(
    () => client.createGmailDraft({ userId: 'me', rawMessageBase64Url: 'QUJD' }),
    error => error.code === 'GOOGLE_GMAIL_USER_NOT_ALLOWED' && error.effectMayHaveOccurred === false,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => client.createGmailDraft({ userId, rawMessageBase64Url: 'QUJD=' }),
    error => error.code === 'GOOGLE_SCHEMA_INVALID' && error.effectMayHaveOccurred === false,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => client.createGmailDraft({ userId, rawMessageBase64Url: 'QUJD' }),
    error => error.code === 'GOOGLE_MUTATION_TRANSPORT_UNCERTAIN'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false,
  );
  assert.equal(calls, 1);
});

test('Gmail draft readback returns exact raw bytes only for the admitted principal and draft identity', async () => {
  const raw = 'QUJD';
  const client = new GoogleWorkspaceRestClientV1(baseConfig({
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      const parsed = new URL(url);
      assert.equal(parsed.pathname, `/gmail/v1/users/${encodeURIComponent(userId)}/drafts/draft_1`);
      assert.equal(parsed.searchParams.get('format'), 'raw');
      return response(200, { id: 'draft_1', message: { id: 'msg_1', threadId: 'thread_1', labelIds: ['DRAFT'], raw } });
    },
  }));
  const result = await client.getGmailDraft({ userId, draftId: 'draft_1' });
  assert.equal(result.rawMessageBase64Url, raw);
  assert.equal(result.draftId, 'draft_1');
});
