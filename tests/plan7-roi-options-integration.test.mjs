import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refreshRoiOwnerPanelV1 } from '../src/ui/roi-owner-entrypoint.js';

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.id = '';
    this.textContent = ''; this.attributes = {}; this.children = [];
    this.ownerDocument = null;
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  appendChild(node) { this.children.push(node); }
  replaceChildren(...children) { this.children = children; }
}
const document = { createElement(tag) { return new FakeNode(tag); } };
function panel() { const el = new FakeNode('div'); el.id = 'roi-owner-panel'; el.ownerDocument = document; return el; }
function all(node) { return [node, ...node.children.flatMap(all)]; }
const valid = Object.freeze({
  schemaVersion: 1, status: 'EVIDENCE_BACKED', statusText: 'proof',
  reportId: 'roi-report-1', observedRunCount: 1, verifiedOutcomeCount: 1,
  opportunities: [], deploymentAuthorized: false,
  recommendationAuthorized: false, telemetryEmitted: false,
});

test('Plan 7 ROI is a reachable native keyboard button and semantic owner view', () => {
  const html = readFileSync(new URL('../src/ui/options.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/ui/options.js', import.meta.url), 'utf8');
  assert.match(html, /<button id="roi-owner-refresh-button" type="button">/u);
  assert.match(html, /<div id="roi-owner-panel">/u);
  assert.match(js, /refreshRoiOwnerPanelV1\(\$\('roi-owner-panel'\), \(\) => core\('GET_ROI_OWNER_ADVISORY'\)\)/u);
});

test('offline and unavailable read show no remembered economics or sensitive errors', async () => {
  const root = panel();
  const outcome = await refreshRoiOwnerPanelV1(root, async () => { throw Error('private-client-secret'); });
  assert.equal(outcome, 'OFFLINE');
  const nodes = all(root);
  assert.equal(nodes.some(node => node.textContent.includes('private-client-secret')), false);
  assert.equal(nodes.some(node => node.tagName === 'TABLE'), false);
  const status = nodes.find(node => node.attributes.role === 'status');
  assert.equal(status?.attributes['aria-live'], 'polite');
});

test('canonical positive report is read-only and cannot gain effect controls', async () => {
  const root = panel();
  assert.equal(await refreshRoiOwnerPanelV1(root, async () => valid), 'EVIDENCE');
  assert.equal(all(root).some(node => node.textContent.includes('roi-report-1')), true);
  assert.equal(all(root).some(node => ['BUTTON', 'INPUT', 'A'].includes(node.tagName)), false);
});

test('malformed or forged permissions revert old ROI numbers to offline', async () => {
  const root = panel();
  await refreshRoiOwnerPanelV1(root, async () => valid);
  const status = await refreshRoiOwnerPanelV1(root, async () => ({ ...valid, deploymentAuthorized: true }));
  assert.equal(status, 'OFFLINE');
  assert.equal(all(root).some(node => node.textContent.includes('roi-report-1')), false);
});

test('slow earlier result cannot overwrite a later offline recovery', async () => {
  const root = panel();
  let done;
  const pending = new Promise(resolve => { done = resolve; });
  const first = refreshRoiOwnerPanelV1(root, () => pending);
  const second = refreshRoiOwnerPanelV1(root, () => Promise.reject(Error('disconnected')));
  assert.equal(await second, 'OFFLINE');
  done(valid);
  assert.equal(await first, 'STALE_IGNORED');
  assert.equal(all(root).some(node => node.textContent.includes('roi-report-1')), false);
});
