import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_DRIVE_API_ORIGIN,
  GOOGLE_SHEETS_API_ORIGIN,
  GOOGLE_SHEETS_READONLY_SCOPE,
  GoogleWorkspaceRestClientV1,
} from '../src/core/google-workspace-rest-client.js';

const spreadsheetId = 'sheet_123';
const rootId = 'root_123';

function response(status, body) {
  const bytes = new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function driveFile({
  id = spreadsheetId,
  mimeType = 'application/vnd.google-apps.spreadsheet',
  parents = [],
  version = '1',
} = {}) {
  return {
    id,
    name: 'Budget',
    mimeType,
    parents,
    modifiedTime: '2026-09-25T12:00:00.000Z',
    trashed: false,
    version,
  };
}

function config({ fetchImpl, resolverCalls = [], overrides = {} } = {}) {
  return {
    nativeClient: {
      resolveCredential: async request => {
        resolverCalls.push(structuredClone(request));
        return {
          credentialId: request.credentialId,
          targetOrigin: request.targetOrigin,
          secret: 'test-oauth-secret',
        };
      },
    },
    driveCredentialId: 'google-drive-main',
    sheetsCredentialId: 'google-sheets-main',
    allowedDriveRootIds: [],
    allowedDriveFileIds: [spreadsheetId],
    allowedGmailUsers: [],
    fetchImpl: fetchImpl ?? (async () => response(500, { error: { message: 'unexpected' } })),
    ...overrides,
  };
}

test('Sheets values read uses owner-scoped Drive proof, fixed Sheets origin, and bounded defaults', async () => {
  assert.equal(GOOGLE_SHEETS_READONLY_SCOPE, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  const resolverCalls = [];
  const fetchCalls = [];
  const client = new GoogleWorkspaceRestClientV1(config({
    resolverCalls,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.origin === GOOGLE_DRIVE_API_ORIGIN) {
        assert.equal(parsed.pathname, '/drive/v3/files/sheet_123');
        return response(200, driveFile());
      }
      assert.equal(parsed.origin, GOOGLE_SHEETS_API_ORIGIN);
      assert.equal(decodeURIComponent(parsed.pathname), '/v4/spreadsheets/sheet_123/values/Sheet1!A1:B2');
      return response(200, {
        range: 'Sheet1!A1:B2',
        majorDimension: 'ROWS',
        values: [['Item', 'Cost'], ['Wheel', 20.5]],
      });
    },
  }));

  const result = await client.readSheetsValues({ spreadsheetId, range: 'Sheet1!A1:B2' });
  assert.equal(result.spreadsheetId, spreadsheetId);
  assert.equal(result.requestedRange, 'Sheet1!A1:B2');
  assert.equal(result.majorDimension, 'ROWS');
  assert.equal(result.valueRenderOption, 'FORMATTED_VALUE');
  assert.equal(result.dateTimeRenderOption, 'SERIAL_NUMBER');
  assert.equal(result.cellCount, 4);
  assert.deepEqual(result.values, [['Item', 'Cost'], ['Wheel', 20.5]]);
  assert.equal(fetchCalls.length, 3, 'Drive preflight + Sheets read + Drive revalidation');
  const sheetsUrl = new URL(fetchCalls[1].url);
  assert.equal(sheetsUrl.origin, GOOGLE_SHEETS_API_ORIGIN);
  assert.equal(sheetsUrl.searchParams.get('majorDimension'), 'ROWS');
  assert.equal(sheetsUrl.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
  assert.equal(sheetsUrl.searchParams.get('dateTimeRenderOption'), 'SERIAL_NUMBER');
  assert.equal(fetchCalls[1].options.method, 'GET');
  assert.equal(JSON.stringify(result).includes('test-oauth-secret'), false);
  assert.deepEqual(resolverCalls, [
    { credentialId: 'google-drive-main', targetOrigin: GOOGLE_DRIVE_API_ORIGIN },
    { credentialId: 'google-sheets-main', targetOrigin: GOOGLE_SHEETS_API_ORIGIN },
    { credentialId: 'google-drive-main', targetOrigin: GOOGLE_DRIVE_API_ORIGIN },
  ]);
});

test('Sheets values read preserves exact A1 request and admitted render options', async () => {
  const seen = [];
  const client = new GoogleWorkspaceRestClientV1(config({
    fetchImpl: async url => {
      const parsed = new URL(url);
      seen.push(parsed);
      if (parsed.origin === GOOGLE_DRIVE_API_ORIGIN) return response(200, driveFile());
      return response(200, {
        range: "'Data Set'!A2:C3",
        majorDimension: 'COLUMNS',
        values: [['=A1+1', '=A2+1'], [true, false], [1, 2]],
      });
    },
  }));
  const result = await client.readSheetsValues({
    spreadsheetId,
    range: "'Data Set'!A2:C3",
    majorDimension: 'COLUMNS',
    valueRenderOption: 'FORMULA',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const sheetsUrl = seen.find(item => item.origin === GOOGLE_SHEETS_API_ORIGIN);
  assert.ok(sheetsUrl);
  assert.equal(decodeURIComponent(sheetsUrl.pathname), "/v4/spreadsheets/sheet_123/values/'Data Set'!A2:C3");
  assert.equal(sheetsUrl.searchParams.get('majorDimension'), 'COLUMNS');
  assert.equal(sheetsUrl.searchParams.get('valueRenderOption'), 'FORMULA');
  assert.equal(sheetsUrl.searchParams.get('dateTimeRenderOption'), 'FORMATTED_STRING');
  assert.equal(result.majorDimension, 'COLUMNS');
  assert.equal(result.cellCount, 6);
});

test('Sheets read rejects absent credential, foreign type, aliases, and accessors before Sheets I/O', async () => {
  let fetchCalls = 0;
  let getterReads = 0;
  const noCredential = new GoogleWorkspaceRestClientV1(config({
    overrides: { sheetsCredentialId: null },
    fetchImpl: async () => { fetchCalls += 1; return response(500, {}); },
  }));
  await assert.rejects(
    () => noCredential.readSheetsValues({ spreadsheetId, range: 'A1:B2' }),
    error => error.code === 'GOOGLE_CREDENTIAL_UNAVAILABLE',
  );
  assert.equal(fetchCalls, 0);

  const wrongType = new GoogleWorkspaceRestClientV1(config({
    fetchImpl: async url => {
      fetchCalls += 1;
      const parsed = new URL(url);
      assert.equal(parsed.origin, GOOGLE_DRIVE_API_ORIGIN);
      return response(200, driveFile({ mimeType: 'application/vnd.google-apps.document' }));
    },
  }));
  await assert.rejects(
    () => wrongType.readSheetsValues({ spreadsheetId, range: 'A1:B2' }),
    error => error.code === 'GOOGLE_SHEETS_RESOURCE_NOT_SPREADSHEET',
  );

  const args = { spreadsheetId };
  Object.defineProperty(args, 'range', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'A1:B2';
    },
  });
  await assert.rejects(
    () => wrongType.readSheetsValues(args),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  assert.equal(getterReads, 0);

  await assert.rejects(
    () => wrongType.readSheetsValues({ spreadsheetId: ' sheet_123', range: 'A1:B2' }),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  await assert.rejects(
    () => wrongType.readSheetsValues({ spreadsheetId, range: ' A1:B2' }),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  await assert.rejects(
    () => wrongType.readSheetsValues({ spreadsheetId, range: 'A1:B2', majorDimension: 'rows' }),
    error => error.code === 'GOOGLE_SCHEMA_INVALID',
  );
  assert.equal(getterReads, 0);
});

test('Sheets response is cell-bounded and rejects non-data cell values', async () => {
  const invalidCell = new GoogleWorkspaceRestClientV1(config({
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.origin === GOOGLE_DRIVE_API_ORIGIN) return response(200, driveFile());
      return response(200, { range: 'A1', majorDimension: 'ROWS', values: [[{ unsafe: true }]] });
    },
  }));
  await assert.rejects(
    () => invalidCell.readSheetsValues({ spreadsheetId, range: 'A1' }),
    error => error.code === 'GOOGLE_RESPONSE_INVALID',
  );

  const tooMany = new GoogleWorkspaceRestClientV1(config({
    maxSheetsJsonBytes: 2_000_000,
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.origin === GOOGLE_DRIVE_API_ORIGIN) return response(200, driveFile());
      return response(200, {
        range: 'A1:ZZ100',
        majorDimension: 'ROWS',
        values: Array.from({ length: 11 }, () => Array.from({ length: 5000 }, () => 0)),
      });
    },
  }));
  await assert.rejects(
    () => tooMany.readSheetsValues({ spreadsheetId, range: 'A1:ZZ100' }),
    error => error.code === 'GOOGLE_RESPONSE_TOO_LARGE',
  );
});

test('Sheets result is withheld when Drive authorization material drifts during the read', async () => {
  let driveReads = 0;
  let sheetsReads = 0;
  const client = new GoogleWorkspaceRestClientV1(config({
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.origin === GOOGLE_DRIVE_API_ORIGIN) {
        driveReads += 1;
        return response(200, driveFile({ version: String(driveReads) }));
      }
      sheetsReads += 1;
      return response(200, { range: 'A1', majorDimension: 'ROWS', values: [['ok']] });
    },
  }));
  await assert.rejects(
    () => client.readSheetsValues({ spreadsheetId, range: 'A1' }),
    error => error.code === 'GOOGLE_DRIVE_SCOPE_CHANGED',
  );
  assert.equal(sheetsReads, 1);
  assert.equal(driveReads, 2);
});
