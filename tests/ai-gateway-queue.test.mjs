import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer, createInferenceQueue } from '../companion/ai-gateway/gateway.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function postComplete(baseUrl, prompt) {
  const res = await fetch(`${baseUrl}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', model: 'local-test', prompt }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for queue state');
}

test('gateway serializes concurrent inference in strict FIFO order', async () => {
  let active = 0;
  let maxActive = 0;
  const started = [];
  const completed = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const fetchFn = async (url, init = {}) => {
    if (!url.endsWith('/api/chat')) throw new Error(`unexpected ${url}`);
    const payload = JSON.parse(init.body);
    const prompt = payload.messages.at(-1).content;
    started.push(prompt);
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (prompt === 'one') await firstGate;
    else await new Promise(resolve => setTimeout(resolve, 10));
    completed.push(prompt);
    active -= 1;
    return response({ message: { content: `answer:${prompt}` } });
  };

  const queue = createInferenceQueue({ maxPending: 8 });
  const server = createGatewayServer({ fetchFn, inferenceQueue: queue });
  const baseUrl = await listen(server);
  try {
    const one = postComplete(baseUrl, 'one');
    await waitFor(() => started.length === 1);
    const two = postComplete(baseUrl, 'two');
    await waitFor(() => queue.snapshot().pending === 1);
    const three = postComplete(baseUrl, 'three');
    await waitFor(() => queue.snapshot().pending === 2);

    releaseFirst();
    const results = await Promise.all([one, two, three]);
    assert.deepEqual(results.map(item => item.status), [200, 200, 200]);
    assert.deepEqual(results.map(item => item.body.text), ['answer:one', 'answer:two', 'answer:three']);
    assert.deepEqual(started, ['one', 'two', 'three']);
    assert.deepEqual(completed, ['one', 'two', 'three']);
    assert.equal(maxActive, 1);
    assert.deepEqual(queue.snapshot(), { active: 0, pending: 0, maxPending: 8 });
  } finally {
    releaseFirst?.();
    await new Promise(resolve => server.close(resolve));
  }
});

test('gateway bounds pending inference and recovers after queue-full rejection', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const seen = [];

  const fetchFn = async (url, init = {}) => {
    if (!url.endsWith('/api/chat')) throw new Error(`unexpected ${url}`);
    const payload = JSON.parse(init.body);
    const prompt = payload.messages.at(-1).content;
    seen.push(prompt);
    if (prompt === 'one') await firstGate;
    return response({ message: { content: `answer:${prompt}` } });
  };

  const queue = createInferenceQueue({ maxPending: 1 });
  const server = createGatewayServer({ fetchFn, inferenceQueue: queue });
  const baseUrl = await listen(server);
  try {
    const one = postComplete(baseUrl, 'one');
    await waitFor(() => queue.snapshot().active === 1);
    const two = postComplete(baseUrl, 'two');
    await waitFor(() => queue.snapshot().pending === 1);

    const overflow = await postComplete(baseUrl, 'three');
    assert.equal(overflow.status, 429);
    assert.equal(overflow.body.code, 'AI_INFERENCE_QUEUE_FULL');
    assert.match(overflow.body.error, /queue is full/i);
    assert.deepEqual(seen, ['one']);

    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.deepEqual(health.inferenceQueue, { active: 1, pending: 1, maxPending: 1 });

    releaseFirst();
    const results = await Promise.all([one, two]);
    assert.deepEqual(results.map(item => item.status), [200, 200]);
    assert.deepEqual(seen, ['one', 'two']);
    await waitFor(() => queue.snapshot().active === 0 && queue.snapshot().pending === 0);
  } finally {
    releaseFirst?.();
    await new Promise(resolve => server.close(resolve));
  }
});
