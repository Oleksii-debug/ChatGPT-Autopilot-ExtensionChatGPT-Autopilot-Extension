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
      return { credentialId: request.credentialId, secret };
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
  for (const invalid of ['me', ' owner@example.com', 'owner@example.com ', 'owner\\u0000@example.com', 'owner@example.com\\u007f']) {
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
  assert.equal(fetchCount, 0);
  assert.deepEqual(credentialCalls, []);
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
