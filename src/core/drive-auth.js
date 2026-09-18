export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function inspectDriveOAuthConfig(manifest) {
  const oauth2 = manifest?.oauth2;
  const scopes = Array.isArray(oauth2?.scopes) ? oauth2.scopes : [];
  return {
    configured: Boolean(oauth2?.client_id) && scopes.includes(DRIVE_FILE_SCOPE),
    clientIdPresent: Boolean(oauth2?.client_id),
    driveFileScopePresent: scopes.includes(DRIVE_FILE_SCOPE),
  };
}

export async function getDriveAccessToken(chromeApi, { interactive = false } = {}) {
  if (!chromeApi?.identity?.getAuthToken) {
    const error = new Error('Chrome Identity API недоступний.');
    error.code = 'IDENTITY_UNAVAILABLE';
    throw error;
  }
  const status = inspectDriveOAuthConfig(chromeApi.runtime?.getManifest?.());
  if (!status.configured) {
    const error = new Error('OAuth для Google Drive не налаштований: потрібні oauth2.client_id і scope drive.file.');
    error.code = 'OAUTH_NOT_CONFIGURED';
    throw error;
  }
  try {
    const result = await chromeApi.identity.getAuthToken({ interactive });
    if (!result?.token) {
      const error = new Error('Google Drive не повернув access token.');
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    return result.token;
  } catch (error) {
    if (error?.code) throw error;
    const wrapped = new Error('Не вдалося отримати авторизацію Google Drive.');
    wrapped.code = 'AUTH_REQUIRED';
    throw wrapped;
  }
}
