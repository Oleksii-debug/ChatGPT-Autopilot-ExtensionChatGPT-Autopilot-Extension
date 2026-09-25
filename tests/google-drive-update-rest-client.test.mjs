import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_DRIVE_API_ORIGIN,
  GOOGLE_DRIVE_FILE_SCOPE,
  GoogleWorkspaceRestClientV1,
} from '../src/core/google-workspace-rest-client.js';

const rootId = 'root_123';
const sourceFolderId = 'folder_source';
const destinationFolderId = 'folder_destination';
const fileId = 'file_789';

function response(status, body) {
  const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function file(id, { parents = [], name = id, mimeType = 'application/vnd.google-apps.folder', version = '1' } = {}) {
  return {
    id,
    name,
    mimeType,
    parents,
    modifiedTime: '2026-09-25T08:45:00.000Z',
    trashed: false,
    version,
  };
}

function nativeClient(calls = []) {
  return {
    resolveCredential: async request => {
      calls.push(request);
      return {
        credentialId: request.credentialId,
        targetOrigin: request.targetOrigin,
        secret: 'drive-oauth-secret',
      };
    },
  };
}

function config(fetchImpl, overrides = {}) {
  return {
    nativeClient: nativeClient(),
    driveCredentialId: 'google-drive-main',
    allowedDriveRootIds: [rootId],
    allowedDriveFileIds: [fileId, destinationFolderId],
    allowedGmailUsers: [],
    fetchImpl,
    ...overrides,
  };
}

function stableMetadata(parsed, { sourceParent = sourceFolderId } = {}) {
  if (parsed.pathname === `/drive/v3/files/${fileId}`) {
    return response(200, file(fileId, { parents: [sourceParent], name: 'old.txt', mimeType: 'text/plain' }));
  }
  if (parsed.pathname === `/drive/v3/files/${sourceFolderId}`) {
    return response(200, file(sourceFolderId, { parents: [rootId] }));
  }
  if (parsed.pathname === `/drive/v3/files/${destinationFolderId}`) {
    return response(200, file(destinationFolderId, { parents: [rootId] }));
  }
  if (parsed.pathname === `/drive/v3/files/${rootId}`) return response(200, file(rootId));
  return null;
}

test('Drive file scope constant is the least-privilege mutation scope', () => {
  assert.equal(GOOGLE_DRIVE_FILE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
});

test('Drive update renames and moves only after stable source/destination scope revalidation', async () => {
  const calls = [];
  const client = new GoogleWorkspaceRestClientV1(config(async (url, options) => {
    const parsed = new URL(url);
    calls.push({ parsed, options });
    if (options?.method === 'PATCH') {
      assert.equal(parsed.origin, GOOGLE_DRIVE_API_ORIGIN);
      assert.equal(parsed.pathname, `/drive/v3/files/${fileId}`);
      assert.equal(parsed.searchParams.get('supportsAllDrives'), 'true');
      assert.equal(parsed.searchParams.get('addParents'), destinationFolderId);
      assert.equal(parsed.searchParams.get('removeParents'), sourceFolderId);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer drive-oauth-secret');
      assert.deepEqual(JSON.parse(options.body), { name: 'renamed.txt' });
      return response(200, file(fileId, {
        parents: [destinationFolderId],
        name: 'renamed.txt',
        mimeType: 'text/plain',
        version: '2',
      }));
    }
    return stableMetadata(parsed) ?? response(404, { error: { message: 'missing' } });
  }));

  const result = await client.updateDriveFile({
    fileId,
    name: 'renamed.txt',
    destinationParentId: destinationFolderId,
  });

  assert.equal(result.file.id, fileId);
  assert.equal(result.file.name, 'renamed.txt');
  assert.deepEqual(result.file.parents, [destinationFolderId]);
  assert.equal(calls.filter(call => call.options?.method === 'PATCH').length, 1);
  assert.equal(JSON.stringify(result).includes('drive-oauth-secret'), false);
});

test('Drive rename preserves exact Unicode/spaces without trim canonicalization', async () => {
  const requestedName = '  Звіт 2026 — фінал  ';
  let patchBody = null;
  const client = new GoogleWorkspaceRestClientV1(config(async (url, options) => {
    const parsed = new URL(url);
    if (options?.method === 'PATCH') {
      patchBody = JSON.parse(options.body);
      return response(200, file(fileId, {
        parents: [sourceFolderId],
        name: requestedName,
        mimeType: 'text/plain',
        version: '2',
      }));
    }
    return stableMetadata(parsed) ?? response(404, {});
  }));
  const result = await client.updateDriveFile({ fileId, name: requestedName });
  assert.equal(result.file.name, requestedName);
  assert.deepEqual(patchBody, { name: requestedName });
});

test('foreign Drive destination is rejected before any mutation dispatch', async () => {
  let patchCalls = 0;
  const client = new GoogleWorkspaceRestClientV1(config(async (url, options) => {
    const parsed = new URL(url);
    if (options?.method === 'PATCH') {
      patchCalls += 1;
      return response(500, {});
    }
    if (parsed.pathname === '/drive/v3/files/foreign_folder') {
      return response(200, file('foreign_folder', { parents: [] }));
    }
    return stableMetadata(parsed) ?? response(404, {});
  }));

  await assert.rejects(
    () => client.updateDriveFile({ fileId, destinationParentId: 'foreign_folder' }),
    error => error.code === 'GOOGLE_DRIVE_RESOURCE_NOT_ALLOWED',
  );
  assert.equal(patchCalls, 0);
});

test('Drive source scope drift before PATCH fails closed with zero mutation dispatch', async () => {
  let fileReads = 0;
  let patchCalls = 0;
  const client = new GoogleWorkspaceRestClientV1(config(async (url, options) => {
    const parsed = new URL(url);
    if (options?.method === 'PATCH') {
      patchCalls += 1;
      return response(500, {});
    }
    if (parsed.pathname === `/drive/v3/files/${fileId}`) {
      fileReads += 1;
      return response(200, file(fileId, {
        parents: [fileReads === 1 ? sourceFolderId : 'foreign_root'],
        name: 'old.txt',
        mimeType: 'text/plain',
      }));
    }
    if (parsed.pathname === '/drive/v3/files/foreign_root') return response(200, file('foreign_root'));
    return stableMetadata(parsed) ?? response(404, {});
  }));

  await assert.rejects(
    () => client.updateDriveFile({ fileId, name: 'new.txt' }),
    error => ['GOOGLE_DRIVE_RESOURCE_NOT_ALLOWED', 'GOOGLE_DRIVE_SCOPE_CHANGED'].includes(error.code),
  );
  assert.equal(patchCalls, 0);
});

test('Drive folder move into its descendant is rejected before PATCH', async () => {
  let patchCalls = 0;
  const folderToMove = 'folder_parent';
  const descendant = 'folder_child';
  const client = new GoogleWorkspaceRestClientV1(config(async (url, options) => {
    const parsed = new URL(url);
    if (options?.method === 'PATCH') {
      patchCalls += 1;
      return response(500, {});
    }
    if (parsed.pathname === `/drive/v3/files/${folderToMove}`) {
      return response(200, file(folderToMove, { parents: [rootId] }));
    }
    if (parsed.pathname === `/drive/v3/files/${descendant}`) {
      return response(200, file(descendant, { parents: [folderToMove] }));
    }
    if (parsed.pathname === `/drive/v3/files/${rootId}`) return response(200, file(rootId));
    return response(404, {});
  }, { allowedDriveFileIds: [folderToMove, descendant] }));

  await assert.rejects(
    () => client.updateDriveFile({ fileId: folderToMove, destinationParentId: descendant }),
    error => error.code === 'GOOGLE_DRIVE_MOVE_CYCLE',
  );
  assert.equal(patchCalls, 0);
});

test('Drive update request rejects empty/no-op schema and hostile accessor before network', async () => {
  let fetchCalls = 0;
  const client = new GoogleWorkspaceRestClientV1(config(async () => {
    fetchCalls += 1;
    return response(500, {});
  }));
  await assert.rejects(
    () => client.updateDriveFile({ fileId }),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );

  let getterReads = 0;
  const hostile = { fileId };
  Object.defineProperty(hostile, 'name', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'stolen.txt';
    },
  });
  await assert.rejects(
    () => client.updateDriveFile(hostile),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  assert.equal(getterReads, 0);
  assert.equal(fetchCalls, 0);
});

test('effectful Drive mutation requires exact owner allowlist even when the file is a root descendant', async () => {
  let patchCalls = 0;
  const client = new GoogleWorkspaceRestClientV1(config(async (url, options) => {
    const parsed = new URL(url);
    if (options?.method === 'PATCH') patchCalls += 1;
    return stableMetadata(parsed) ?? response(404, {});
  }, { allowedDriveFileIds: [destinationFolderId] }));

  await assert.rejects(
    () => client.updateDriveFile({ fileId, name: 'blocked.txt' }),
    error => error.code === 'GOOGLE_DRIVE_MUTATION_IDENTITY_NOT_ALLOWED',
  );
  assert.equal(patchCalls, 0);
});

test('effectful Drive destination must be an exact owner-allowlisted identity, not merely an admitted descendant', async () => {
  let patchCalls = 0;
  const client = new GoogleWorkspaceRestClientV1(config(async (url, options) => {
    const parsed = new URL(url);
    if (options?.method === 'PATCH') patchCalls += 1;
    return stableMetadata(parsed) ?? response(404, {});
  }, { allowedDriveFileIds: [fileId] }));

  await assert.rejects(
    () => client.updateDriveFile({ fileId, destinationParentId: destinationFolderId }),
    error => error.code === 'GOOGLE_DRIVE_MUTATION_IDENTITY_NOT_ALLOWED',
  );
  assert.equal(patchCalls, 0);
});

test('post-dispatch Drive transport loss is explicitly ambiguous and never retry-safe', async () => {
  let patchCalls = 0;
  const client = new GoogleWorkspaceRestClientV1(config(async (url, options) => {
    const parsed = new URL(url);
    if (options?.method === 'PATCH') {
      patchCalls += 1;
      throw new Error('socket lost after request write');
    }
    return stableMetadata(parsed) ?? response(404, {});
  }));

  await assert.rejects(
    () => client.updateDriveFile({ fileId, name: 'new.txt' }),
    error => error.code === 'GOOGLE_MUTATION_TRANSPORT_UNCERTAIN'
      && error.effectMayHaveOccurred === true
      && error.safeToRetry === false
      && !String(error.message).includes('socket lost'),
  );
  assert.equal(patchCalls, 1);
});

test('Drive mutation response must bind exact file identity and requested postcondition', async () => {
  const cases = [
    file('other_file', { parents: [sourceFolderId], name: 'new.txt', mimeType: 'text/plain' }),
    file(fileId, { parents: [sourceFolderId], name: 'wrong.txt', mimeType: 'text/plain' }),
  ];
  for (const mutationBody of cases) {
    const client = new GoogleWorkspaceRestClientV1(config(async (url, options) => {
      const parsed = new URL(url);
      if (options?.method === 'PATCH') return response(200, mutationBody);
      return stableMetadata(parsed) ?? response(404, {});
    }));
    await assert.rejects(
      () => client.updateDriveFile({ fileId, name: 'new.txt' }),
      error => error.effectMayHaveOccurred === true && error.safeToRetry === false,
    );
  }
});
