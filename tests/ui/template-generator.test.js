import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.match(parsed.sessions[5].tasks[0].url, /^https:\/\/chatgpt\.com\/c\/template-session-6$/);
});
