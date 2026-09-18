import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveApiError, extractDriveFileId, listAuthorizedDriveFiles, readAuthorizedDriveSnapshot } from '../../src/core/drive-api.js';

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

test('Drive URL parser handles Docs and Drive file links', () => {
  assert.deepEqual(extractDriveFileId('https://docs.google.com/document/d/doc-123/edit'), { fileId: 'doc-123', kind: 'google-doc' });
  assert.deepEqual(extractDriveFileId('https://drive.google.com/file/d/file-456/view'), { fileId: 'file-456', kind: 'drive-file' });
  assert.throws(() => extractDriveFileId('https://example.com/file-1'), error => error instanceof DriveApiError && error.code === 'INVALID_URL');
});

test('authorized Drive snapshot exports Docs and verifies version before acceptance', async () => {
  const calls = [];
  let metadataCalls = 0;
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    if (url.includes('/files/doc-123?fields=')) {
      metadataCalls += 1;
      return response({ id: 'doc-123', version: metadataCalls === 1 ? '10' : '10', mimeType: 'application/vnd.google-apps.document' });
    }
    if (url.includes('/files/doc-123/export?')) return response('prompt contents');
    throw new Error(`unexpected URL ${url}`);
  };
  const result = await readAuthorizedDriveSnapshot({ fileId: 'doc-123', accessToken: 'token', fetchImpl, retryDelayMs: 0 });
  assert.equal(result.version, '10');
  assert.equal(result.content, 'prompt contents');
  assert.equal(calls.filter(([url]) => url.includes('/files/doc-123?fields=')).length, 2);
  assert.match(calls[1][0], /export/);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer token');
});

test('authorized Drive snapshot discards a version race and accepts only the next stable content', async () => {
  let versionCall = 0;
  let contentCall = 0;
  const fetchImpl = async url => {
    if (url.includes('/files/file-1?fields=')) {
      versionCall += 1;
      const version = versionCall === 1 ? '20' : versionCall === 2 ? '21' : '21';
      return response({ id: 'file-1', version, mimeType: 'text/plain' });
    }
    if (url.includes('/files/file-1?alt=media')) {
      contentCall += 1;
      return response(contentCall === 1 ? 'stale' : 'stable');
    }
    throw new Error('unexpected URL');
  };
  const result = await readAuthorizedDriveSnapshot({ fileId: 'file-1', accessToken: 'token', fetchImpl, retryDelayMs: 0 });
  assert.equal(result.version, '21');
  assert.equal(result.content, 'stable');
  assert.equal(contentCall, 2);
});

test('Drive file listing uses narrow fields and fails closed without token', async () => {
  await assert.rejects(() => listAuthorizedDriveFiles({}), error => error instanceof DriveApiError && error.code === 'AUTH_REQUIRED');
  const result = await listAuthorizedDriveFiles({
    accessToken: 'token',
    fetchImpl: async (url, options) => {
      assert.match(url, /fields=files%28id%2Cname%2CmimeType%2CmodifiedTime%2Cversion%2CwebViewLink%29/);
      assert.equal(options.headers.Authorization, 'Bearer token');
      return response({ files: [{ id: 'file-1', name: 'Prompt.txt', mimeType: 'text/plain', version: '7' }] });
    },
  });
  assert.deepEqual(result, [{ id: 'file-1', name: 'Prompt.txt', mimeType: 'text/plain', version: '7' }]);
});
