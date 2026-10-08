import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

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
