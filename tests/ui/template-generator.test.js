import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSessionTemplate, serializeSessionTemplate, MAX_TEMPLATE_SESSIONS } from '../../src/ui/template-generator.js';
import { previewPortableProfile } from '../../src/core/portable-profile.js';

for (const count of [1, 6, 20, MAX_TEMPLATE_SESSIONS]) {
  test(`session template generates ${count} deterministic Sessions`, () => {
    const first = createSessionTemplate(count);
    const second = createSessionTemplate(count);
    assert.deepEqual(first, second);
    assert.equal(first.sessions.length, count);
    assert.equal(new Set(first.sessions.map(session => session.id)).size, count);
    assert.equal(new Set(first.sessions.map(session => session.tasks[0].id)).size, count);
    const preview = previewPortableProfile(first, 100);
    assert.equal(preview.sessionCount, count);
    assert.equal(preview.taskCount, count);
  });
}

test('session template rejects invalid counts', () => {
  for (const value of [0, -1, 1.5, MAX_TEMPLATE_SESSIONS + 1, 'x']) {
    assert.throws(() => createSessionTemplate(value), /Кількість Session/);
  }
});

test('session template keeps JSON import format stable', () => {
  const parsed = JSON.parse(serializeSessionTemplate(6));
  assert.equal(parsed.format, 'chatgpt-autopilot-profile');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sessions.length, 6);
  assert.equal(parsed.sessions[0].tasks[0].enabled, false);
  assert.equal(parsed.sessions[5].tasks[0].url, '');
  assert.deepEqual(parsed.sessions[0].promptCadence.prompt2, { enabled: false, prompt: '', everyN: 30 });
  assert.deepEqual(parsed.sessions[0].promptCadence.prompt3, { enabled: false, prompt: '', everyN: 40 });
  assert.deepEqual(parsed.sessions[0].driveSource, { sourceUrl: '', target: 'primary' });
  assert.doesNotThrow(() => previewPortableProfile(parsed, 100));
});


test('template Session count field exposes the same maximum as the generator', () => {
  const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
  const match = html.match(/id="template-session-count"[^>]*max="(\d+)"/);
  assert.ok(match, 'template Session count field must declare a max');
  assert.equal(Number(match[1]), MAX_TEMPLATE_SESSIONS);
});
