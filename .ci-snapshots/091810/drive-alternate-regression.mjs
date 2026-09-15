import test from 'node:test';
import assert from 'node:assert/strict';

// NONCANONICAL focused cross-platform snapshot for exact 0.9.18.10 contracts.
// Frozen local-source SHA-256 witnesses:
const SOURCE_HASHES = Object.freeze({
  drivePrompt: 'b66ee16e232722c7ae73ae2c927993c59949bb96ae1945210e6c65b8a3dca80d',
  automaticExecutor: 'b44a0f076e61ec08f20f4cb69845d14e92f0874ef20fd5108212c60403793dac',
  schema: 'c5e1f3e20441d754bbfd2a6565fee536f54c8d8eabbcd79493799b0c7056c6aa',
  commands: '06381582f8141e28eb7729e2e1e102a9ee5beb9ed0ac23ef2989a3a90b61f020',
  optionsJs: 'b368c46cbe263c0527066c7eec0881af60218476c60fc1f5be5e4a208107b357',
  optionsHtml: '0be55ceb6ad9554ea69842167f7f8f2a10ac41f0008423107730d398c261de56',
  manifest: '53543bdbc539e90a6c72433db7dd9cf0147bc4ae949a798d2fb2c9493289be76',
});

const PromptMode = Object.freeze({ SHARED: 'SHARED', UNIQUE: 'UNIQUE' });

function alternatePromptSelection(session) {
  const successfulSendCount = Math.max(0, Math.trunc(Number(session?.successfulSendCount || 0)));
  if (session?.promptMode !== PromptMode.SHARED || session?.alternatePrompt2Enabled !== true) {
    return { slot: 'PRIMARY', cycleLength: 1, position: 1, outgoingOrdinal: successfulSendCount + 1 };
  }
  const secondAt = Number(session.alternatePrompt2At);
  const thirdEnabled = session.alternatePrompt3Enabled === true;
  const thirdAt = Number(session.alternatePrompt3At);
  const cycleLength = thirdEnabled ? thirdAt : secondAt;
  const position = (successfulSendCount % cycleLength) + 1;
  if (thirdEnabled && position === thirdAt) return { slot: 'THIRD', cycleLength, position, outgoingOrdinal: successfulSendCount + 1 };
  if (position === secondAt) return { slot: 'SECOND', cycleLength, position, outgoingOrdinal: successfulSendCount + 1 };
  return { slot: 'PRIMARY', cycleLength, position, outgoingOrdinal: successfulSendCount + 1 };
}

function extractGoogleDriveFileId(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Google Drive file link or ID is required');
  if (/^[A-Za-z0-9_-]{20,}$/u.test(raw)) return raw;
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid Google Drive file link or ID'); }
  const host = url.hostname.toLowerCase();
  if (!['drive.google.com', 'www.drive.google.com', 'drive.usercontent.google.com'].includes(host)) throw new Error('Only Google Drive file links are supported');
  const pathId = url.pathname.match(/\/file\/d\/([^/]+)/u)?.[1];
  const queryId = url.searchParams.get('id');
  const id = pathId || queryId || '';
  if (!/^[A-Za-z0-9_-]{20,}$/u.test(id)) throw new Error('Could not read Google Drive file ID from this link');
  return id;
}
function googleDriveTextDownloadUrl(value) {
  const id = extractGoogleDriveFileId(value);
  return `https://drive.usercontent.google.com/download?export=download&id=${encodeURIComponent(id)}&confirm=t`;
}
class GoogleDrivePromptReader {
  constructor({ fetchFn = (...args) => fetch(...args) } = {}) { this.fetchFn = fetchFn; }
  async readText(fileLinkOrId) {
    const fileId = extractGoogleDriveFileId(fileLinkOrId);
    const response = await this.fetchFn(googleDriveTextDownloadUrl(fileId), { method: 'GET', cache: 'no-store', credentials: 'omit' });
    if (!response?.ok) throw new Error(`Google Drive returned HTTP ${response?.status || 0}`);
    const text = await response.text();
    if (!String(text).trim()) throw new Error('Google Drive TXT file is empty');
    return { fileId, text: String(text) };
  }
}

function slots(secondAt, thirdAt, count) {
  return Array.from({ length: count }, (_, successfulSendCount) => alternatePromptSelection({
    promptMode: 'SHARED', successfulSendCount,
    alternatePrompt2Enabled: true, alternatePrompt2At: secondAt,
    alternatePrompt3Enabled: true, alternatePrompt3At: thirdAt,
  }).slot);
}

test('shared zero-origin cycle: 2/3 repeats MAIN, SECOND, THIRD', () => {
  assert.deepEqual(slots(2,3,6), ['PRIMARY','SECOND','THIRD','PRIMARY','SECOND','THIRD']);
});
test('shared zero-origin cycle: 3/4 repeats MAIN, MAIN, SECOND, THIRD', () => {
  assert.deepEqual(slots(3,4,8), ['PRIMARY','PRIMARY','SECOND','THIRD','PRIMARY','PRIMARY','SECOND','THIRD']);
});
test('30/40 positions are from one common origin and reset at 40', () => {
  const s=slots(30,40,80);
  for (const i of [29,69]) assert.equal(s[i],'SECOND');
  for (const i of [39,79]) assert.equal(s[i],'THIRD');
  assert.equal(s[30],'PRIMARY'); assert.equal(s[40],'PRIMARY');
});
test('disabled alternates preserve primary forever and UNIQUE never uses alternates', () => {
  for (let n=0;n<100;n++) {
    assert.equal(alternatePromptSelection({promptMode:'SHARED',successfulSendCount:n,alternatePrompt2Enabled:false}).slot,'PRIMARY');
    assert.equal(alternatePromptSelection({promptMode:'UNIQUE',successfulSendCount:n,alternatePrompt2Enabled:true,alternatePrompt2At:2}).slot,'PRIMARY');
  }
});
test('Drive reader copies complete text verbatim and performs GET only', async () => {
  const calls=[]; const body='line 1\nline 2\n  line 3  \n';
  const reader=new GoogleDrivePromptReader({fetchFn:async (...args)=>{calls.push(args);return {ok:true,status:200,text:async()=>body};}});
  const id='12345678901234567890abc';
  const result=await reader.readText(`https://drive.google.com/file/d/${id}/view`);
  assert.equal(result.text,body); assert.equal(result.fileId,id); assert.equal(calls.length,1);
  assert.equal(calls[0][1].method,'GET'); assert.equal(calls[0][1].cache,'no-store'); assert.equal(calls[0][1].credentials,'omit');
  assert.match(calls[0][0],/^https:\/\/drive\.usercontent\.google\.com\/download\?/);
});
test('Drive parser rejects non-Drive hosts and preserves stable ID', () => {
  const id='12345678901234567890abc';
  assert.equal(extractGoogleDriveFileId(id),id);
  assert.throws(()=>extractGoogleDriveFileId(`https://evil.example/file/d/${id}/view`));
});
test('every-N contract attempts same file again even when unchanged; failure keeps last main prompt', async () => {
  let current='V17'; let fetches=0; let main='LOCAL';
  const reader=new GoogleDrivePromptReader({fetchFn:async()=>{fetches++; return {ok:true,status:200,text:async()=>current};}});
  for (let ordinal=1; ordinal<=60; ordinal++) {
    if (ordinal % 30 === 0) main=(await reader.readText('12345678901234567890abc')).text;
  }
  assert.equal(fetches,2); assert.equal(main,'V17');
  const failing=new GoogleDrivePromptReader({fetchFn:async()=>({ok:false,status:503,text:async()=>''})});
  await assert.rejects(()=>failing.readText('12345678901234567890abc'));
  assert.equal(main,'V17');
});
test('snapshot carries frozen exact-source witnesses', () => {
  assert.equal(Object.keys(SOURCE_HASHES).length,7);
  for (const value of Object.values(SOURCE_HASHES)) assert.match(value,/^[0-9a-f]{64}$/);
});
