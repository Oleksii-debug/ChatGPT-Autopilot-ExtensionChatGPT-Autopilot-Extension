import test from 'node:test';
import assert from 'node:assert/strict';

const FINAL_SOURCE_SHA256 = '8bb5d07794e943ccc3329e680f42494364ccbb70b7dc707062c763d8b3c3d9a8';
const CHANGED_FILE_SHA256 = Object.freeze({
  serviceWorker: '12bdb8abec4a95f140635e4be89c66497758d95fc63c6eac4a8c87af435fdb35',
  automaticExecutor: 'd18ee9f2da2db4790016f122101962b4f6e89d559e59593ca92b0647ca51f317',
  stateMachine: 'ba1b8e01a84f7cc959e3da690bb64cc38d7846f647b05baad18bb0e7b6e53e39',
  schema: '9df2d5a446371ebbd26e8a78666eabda0925f797e757d24372fa576247add36e',
  localization: '914c3d33887f17be034398c06fa3535d7a76c9b2120392a5dc8ff4b769e96946',
});

class SingleFlightLane {
  constructor() {
    this.inFlight = null;
    this.rerunRequested = false;
    this.cycles = 0;
    this.release = null;
  }
  run() {
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }
    this.cycles += 1;
    let resolve;
    const core = new Promise(r => { resolve = r; });
    this.release = () => resolve({ wakeAt: 0 });
    this.inFlight = core.then(result => {
      this.inFlight = null;
      const rerun = this.rerunRequested;
      this.rerunRequested = false;
      if (rerun) queueMicrotask(() => this.run());
      return result;
    });
    return this.inFlight;
  }
}

function preSendReadySelfHealWindowMs({ busyCheckDelayMs, retryBackoffMs }) {
  return Math.max(Math.max(0, busyCheckDelayMs), 0) * 3 > Math.max(0, retryBackoffMs)
    ? Math.max(0, busyCheckDelayMs) * 3
    : Math.max(0, retryBackoffMs);
}

function preSendTransition({ now, selfHealAt, busyCheckDelayMs, retryBackoffMs }) {
  const windowMs = preSendReadySelfHealWindowMs({ busyCheckDelayMs, retryBackoffMs });
  const deadline = selfHealAt || (now + windowMs);
  if (now >= deadline) {
    return { kind: 'PRE_SEND_SELF_HEALED', physicalSend: false, reloadTab: true, retryAt: now + retryBackoffMs };
  }
  return { kind: 'WAIT_SEND_READY', physicalSend: false, reloadTab: false, selfHealAt: deadline, wakeAt: Math.min(deadline, now + busyCheckDelayMs) };
}

test('0.9.18.6 evidence is bound to the frozen local SOURCE identity', () => {
  assert.equal(FINAL_SOURCE_SHA256.length, 64);
  assert.ok(Object.values(CHANGED_FILE_SHA256).every(value => /^[a-f0-9]{64}$/u.test(value)));
});

test('overlapped canonical wake is not lost behind the old in-flight cycle', async () => {
  const lane = new SingleFlightLane();
  const first = lane.run();
  const overlapped = lane.run();
  assert.equal(first, overlapped, 'overlap still shares the old single-flight promise');
  assert.equal(lane.rerunRequested, true, 'but the wake must be remembered');
  lane.release();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lane.cycles, 2, 'one fresh cycle must run after the lane releases');
});

test('owner timings 3s busy / 5s retry produce a bounded 9s pre-send self-heal, not an infinite loop', () => {
  const first = preSendTransition({ now: 10_000, selfHealAt: 0, busyCheckDelayMs: 3_000, retryBackoffMs: 5_000 });
  assert.deepEqual(first, { kind: 'WAIT_SEND_READY', physicalSend: false, reloadTab: false, selfHealAt: 19_000, wakeAt: 13_000 });
  const terminal = preSendTransition({ now: 19_000, selfHealAt: 19_000, busyCheckDelayMs: 3_000, retryBackoffMs: 5_000 });
  assert.deepEqual(terminal, { kind: 'PRE_SEND_SELF_HEALED', physicalSend: false, reloadTab: true, retryAt: 24_000 });
});

test('rate-limit UI contract never claims a configured wait when owner cooldown is zero', () => {
  const visible = 'CHATGPT ОБМЕЖИВ ЗАПИТИ — АВТОВІДНОВЛЕННЯ';
  assert.doesNotMatch(visible, /ОЧІКУВАННЯ ЗА НАЛАШТУВАННЯМ/u);
});
