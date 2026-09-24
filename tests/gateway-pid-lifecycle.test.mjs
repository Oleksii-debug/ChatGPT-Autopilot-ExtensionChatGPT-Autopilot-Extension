import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Gateway did not become healthy');
}

test('direct Gateway process writes its own PID file and removes it on graceful stop', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'autopilot-gateway-pid-'));
  const gateway = path.join(tmp, 'gateway.mjs');
  const providerPresets = path.join(tmp, 'provider-presets.mjs');
  await copyFile(new URL('../companion/ai-gateway/gateway.mjs', import.meta.url), gateway);
  await copyFile(new URL('../companion/ai-gateway/provider-presets.mjs', import.meta.url), providerPresets);
  const port = await freePort();
  const child = spawn(process.execPath, [gateway], {
    cwd: tmp,
    env: { ...process.env, AUTOPILOT_AI_GATEWAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });

  const url = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(url);
  assert.equal(health.pid, child.pid);
  assert.equal(health.version, '0.7.0');

  const pidFile = path.join(tmp, 'runtime-state', 'gateway.pid');
  assert.equal((await readFile(pidFile, 'utf8')).trim(), String(child.pid));

  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  assert.equal(stderr, '');
  await assert.rejects(access(pidFile));
});
