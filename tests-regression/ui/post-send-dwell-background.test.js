import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSimplifiedSessionConfig } from '../../src/ui/simplified-session-config.js';
import { normalizeScenarioWorkConfig } from '../../src/core/scenario-work.js';

const fields = (overrides = {}) => ({
  mode:'shared-shared', url:'https://chatgpt.com/', prompt:'test prompt', cycles:'1',
  interval:'1', intervalUnit:'minutes', delay:'1', tabReady:'0',
  postSend:'2', postSendUnit:'minutes', busy:'1', retry:'5', retryUnit:'seconds',
  ...overrides,
});
test('simplified post-Send unit converts minutes to canonical seconds', () => {
  assert.equal(buildSimplifiedSessionConfig(fields()).postSendDelaySeconds,120);
  assert.equal(buildSimplifiedSessionConfig(fields()).postSendDelayUnit,'minutes');
  assert.equal(buildSimplifiedSessionConfig(fields({postSend:'45',postSendUnit:'seconds'})).postSendDelaySeconds,45);
  assert.equal(buildSimplifiedSessionConfig(fields({postSend:'45',postSendUnit:'seconds'})).postSendDelayUnit,'seconds');
  assert.throws(() => buildSimplifiedSessionConfig(fields({postSend:'61',postSendUnit:'minutes'})));
});
test('scenario post-Send dwell accepts minutes converted to seconds without clipping at 60', () => {
  assert.equal(normalizeScenarioWorkConfig({postSendDelaySeconds:180,postSendDelayUnit:'minutes'}).postSendDelaySeconds,180);
  assert.equal(normalizeScenarioWorkConfig({postSendDelaySeconds:180,postSendDelayUnit:'minutes'}).postSendDelayUnit,'minutes');
  assert.equal(normalizeScenarioWorkConfig({postSendDelaySeconds:3600}).postSendDelaySeconds,3600);
});
test('both accessible configuration surfaces expose units after Send', () => {
  const html = readFileSync(new URL('../../src/ui/options.html', import.meta.url),'utf8');
  for (const id of ['simplified-post-send-unit','scenario-work-post-send-unit']) {
    assert.match(html,new RegExp('id="'+id+'"'));
    assert.match(html,/value="minutes">Хвилини/);
  }
});
test('hidden composer has an activation-based readiness retry without automatic double-send', () => {
  const code=readFileSync(new URL('../../src/interaction/chatgpt-adapter.js',import.meta.url),'utf8');
  assert.match(code,/ready\.status !== STATUS\.READY \|\| Number\(request\.postSendDelayMs/);
  assert.match(code,/if \(activated\) \{[\s\S]*?ready = prepareSend\(doc, request, start\)/);
});
