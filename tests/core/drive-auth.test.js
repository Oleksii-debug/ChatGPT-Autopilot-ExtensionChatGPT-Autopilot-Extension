import test from 'node:test';
import assert from 'node:assert/strict';
import { DRIVE_FILE_SCOPE, getDriveAccessToken, inspectDriveOAuthConfig } from '../../src/core/drive-auth.js';

const configuredManifest = { oauth2: { client_id: '123.apps.googleusercontent.com', scopes: [DRIVE_FILE_SCOPE] } };

test('Drive OAuth inspection requires both client id and drive.file scope', () => {
  assert.deepEqual(inspectDriveOAuthConfig(configuredManifest), { configured: true, clientIdPresent: true, driveFileScopePresent: true });
  assert.equal(inspectDriveOAuthConfig({ oauth2: { client_id: '' , scopes: [DRIVE_FILE_SCOPE] } }).configured, false);
  assert.equal(inspectDriveOAuthConfig({ oauth2: { client_id: 'x', scopes: [] } }).configured, false);
});

test('Drive access token acquisition fails closed when OAuth is not configured', async () => {
  await assert.rejects(
    () => getDriveAccessToken({ runtime: { getManifest: () => ({}) }, identity: { getAuthToken: async () => ({ token: 'unexpected' }) } }),
    error => error.code === 'OAUTH_NOT_CONFIGURED',
  );
});

test('Drive access token acquisition is user-interactive only when requested', async () => {
  const calls = [];
  const token = await getDriveAccessToken({
    runtime: { getManifest: () => configuredManifest },
    identity: { getAuthToken: async details => { calls.push(details); return { token: 'abc' }; } },
  }, { interactive: true });
  assert.equal(token, 'abc');
  assert.deepEqual(calls, [{ interactive: true }]);
});
