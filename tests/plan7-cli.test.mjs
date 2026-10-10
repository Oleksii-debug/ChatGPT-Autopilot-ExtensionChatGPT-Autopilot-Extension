import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseStrictControlJsonV1 } from '../companion/local-api/control-json.mjs';
import { startAutopilotLocalApiLoopbackV1 } from '../companion/local-api/server.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const cli=resolve(here,'../companion/local-api/cli.mjs');
const secret='FAKE_TEST_ONLY_NEVER_A_REAL_TOKEN_'.repeat(3);

test('keyboard-first CLI help is Ukrainian, deterministic and usable without auth',()=>{
  const r=spawnSync(process.execPath,[cli,'--help'],{
    encoding:'utf8',timeout:10_000,env:{...process.env,AUTOPILOT_LOCAL_API_TOKEN:''}});
  assert.equal(r.status,0);
  assert.match(r.stdout,/Автопілот — локальний CLI/);
  assert.match(r.stdout,/requestId/);
  assert.match(r.stdout,/UNKNOWN_NETWORK_RESULT/);
  assert.equal(r.stderr,'');
});

test('CLI errors stay private, no stack or secrets in stdout/stderr',()=>{
  const r=spawnSync(process.execPath,[cli],{
    input:'{invalid',encoding:'utf8',timeout:10_000,
    env:{...process.env,AUTOPILOT_LOCAL_API_TOKEN:secret,AUTOPILOT_LOCAL_API_PORT:'12345'}});
  assert.equal(r.status,1);
  assert.match(r.stderr,/Помилка CLI/);
  assert.equal(r.stdout,'');
  assert.equal((r.stderr+r.stdout).includes(secret),false);
  assert.equal((r.stderr+r.stdout).includes('Error:'),false);
});

test('CLI does not allow missing local token or any network dispatch',()=>{
  const r=spawnSync(process.execPath,[cli],{
    input:'{}',encoding:'utf8',timeout:10_000,
    env:{...process.env,AUTOPILOT_LOCAL_API_TOKEN:'',AUTOPILOT_LOCAL_API_PORT:'0'}});
  assert.equal(r.status,1);
  assert.match(r.stderr,/Помилка CLI/);
});

const CANONICAL_CLI_INPUT = JSON.stringify({
  schemaVersion: 1, requestId: 'cli-identity-1', principalId: 'owner-1',
  projectId: 'project-1', operation: 'STATUS_GET', targetId: 'agent-1',
  payloadArtifactRef: null, requestedAt: '2026-10-08T11:00:00.000Z',
});

test('shared CLI/HTTP strict JSON rejects escaped duplicate IDs and accepts a clean restart', () => {
  const oldId = '"requestId":"cli-identity-1"';
  const invalidBodies = [
    CANONICAL_CLI_INPUT.replace(oldId,
      '"requestId":"forged-first","requestId":"cli-identity-1"'),
    CANONICAL_CLI_INPUT.replace(oldId,
      '"requestId":"forged-escaped","\\u0072equestId":"cli-identity-1"'),
    CANONICAL_CLI_INPUT.replace('"projectId":"project-1"',
      '"projectId":"other-project","projectId":"project-1"'),
  ];
  for (const body of invalidBodies) {
    assert.throws(() => parseStrictControlJsonV1(Buffer.from(body, 'utf8')),
      /Ambiguous duplicate JSON member/u);
    // Malformed CLI JSON must fail before any network operation. Without this
    // fence the last duplicate wins, producing UNKNOWN_NETWORK_RESULT (exit 2)
    // from the deliberately closed port rather than a local validation error.
    const r = spawnSync(process.execPath, [cli], {
      input: body, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, AUTOPILOT_LOCAL_API_TOKEN: secret,
        AUTOPILOT_LOCAL_API_PORT: '1' },
    });
    assert.equal(r.status, 1, 'duplicate CLI identity is invalid before transport');
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Помилка CLI/u);
    assert.equal((r.stderr + r.stdout).includes(secret), false);
  }
  assert.deepEqual(parseStrictControlJsonV1(Buffer.from(CANONICAL_CLI_INPUT)),
    JSON.parse(CANONICAL_CLI_INPUT), 'clean canonical CLI request still parses');
});

test('shared CLI/HTTP strict JSON rejects malformed UTF-8 without replacement coercion', () => {
  const malformed = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22,
    0xc3, 0x28, 0x22, 0x7d]);
  assert.throws(() => parseStrictControlJsonV1(malformed), /encoded|valid/u);
  const r = spawnSync(process.execPath, [cli], {
    input: malformed, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, AUTOPILOT_LOCAL_API_TOKEN: secret,
      AUTOPILOT_LOCAL_API_PORT: '1' },
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Помилка CLI/u);
});

test('strict control JSON rejects leading UTF-8 BOM before CLI network access and recovers', () => {
  // TextDecoder defaults to stripping the BOM. That must not reinterpret
  // noncanonical raw bytes as an authorized control request.
  const prefixed = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(CANONICAL_CLI_INPUT, 'utf8'),
  ]);
  assert.throws(() => parseStrictControlJsonV1(prefixed),
    'BOM-prefixed control JSON must not be canonicalized by TextDecoder');
  const result = spawnSync(process.execPath, [cli], {
    input: prefixed, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, AUTOPILOT_LOCAL_API_TOKEN: secret,
      AUTOPILOT_LOCAL_API_PORT: '1' },
  });
  assert.equal(result.status, 1, 'CLI must reject before attempting transport');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Помилка CLI/u);
  assert.equal((result.stderr + result.stdout).includes(secret), false);
  assert.deepEqual(parseStrictControlJsonV1(Buffer.from(CANONICAL_CLI_INPUT)),
    JSON.parse(CANONICAL_CLI_INPUT), 'clean JSON still parses after denial');
});

 
// End-to-end CLI -> loopback HTTP -> canonical programmatic-control fixture.
// The fixture does not grant policy/effect rights or simulate a provider login.
async function runRealLoopbackCli(port, requestId) {
  const child = spawn(process.execPath, [cli], {
    env: { ...process.env, AUTOPILOT_LOCAL_API_TOKEN: secret,
      AUTOPILOT_LOCAL_API_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => resolveExit({ code, signal, stdout, stderr }));
  });
  child.stdin.end(JSON.stringify({ ...JSON.parse(CANONICAL_CLI_INPUT), requestId }));
  return exit;
}

test('CLI reports canonical Core REJECTED as exit 2, then a fresh COMPLETED returns exit 0', async () => {
  const seen = { scopes: 0, dispatches: 0 };
  const at = '2026-10-08T11:02:00.000Z';
  const server = await startAutopilotLocalApiLoopbackV1({
    token: secret,
    dependencies: {
      now() { return Date.parse(at); },
      resolveTrustedScope({ request }) {
        seen.scopes++;
        return {
          schemaVersion: 1, scopeRevisionId: 'core-scope-revision-1',
          requestId: request.requestId, principalId: request.principalId,
          projectId: request.projectId, operation: request.operation,
          targetId: request.targetId, payloadArtifactId: null, payloadSha256: null,
          allowed: true, verifiedAt: '2026-10-08T11:01:00.000Z',
          validThrough: '2026-10-08T11:05:00.000Z',
        };
      },
      dispatchCanonicalControl({ request }) {
        seen.dispatches++;
        return {
          schemaVersion: 1, requestId: request.requestId,
          projectId: request.projectId, operation: request.operation,
          dispatchId: 'core-dispatch-' + seen.dispatches,
          status: request.requestId === 'cli-core-rejected' ? 'REJECTED' : 'COMPLETED',
          resultArtifactRef: null, observedAt: at,
        };
      },
    },
  });
  try {
    const port = server.address().port;
    const rejected = await runRealLoopbackCli(port, 'cli-core-rejected');
    assert.equal(rejected.signal, null);
    assert.equal(rejected.code, 2, 'a rejected canonical outcome is not a successful shell action');
    assert.equal(rejected.stderr, '');
    const rejectedReceipt = JSON.parse(rejected.stdout);
    assert.equal(rejectedReceipt.status, 'RECEIVED', 'transport did receive Core evidence');
    assert.equal(rejectedReceipt.result.receipt.status, 'REJECTED');
    assert.equal(rejectedReceipt.result.executionAuthorized, false);
    const completed = await runRealLoopbackCli(port, 'cli-core-completed');
    assert.equal(completed.signal, null);
    assert.equal(completed.code, 0, 'a separate verified completed Core response stays compatible');
    assert.equal(completed.stderr, '');
    const completedReceipt = JSON.parse(completed.stdout);
    assert.equal(completedReceipt.status, 'RECEIVED');
    assert.equal(completedReceipt.result.receipt.status, 'COMPLETED');
    assert.deepEqual(seen, { scopes: 2, dispatches: 2 });
    assert.equal((rejected.stderr + completed.stderr).includes(secret), false);
  } finally {
    await new Promise((resolveClose, rejectClose) =>
      server.close(error => error ? rejectClose(error) : resolveClose()));
  }
});
