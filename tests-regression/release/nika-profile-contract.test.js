import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const profile = JSON.parse(fs.readFileSync(path.join(root, 'tests-regression', 'fixtures', 'Nika-30-cycles-profile.json'), 'utf8'));
const session = profile.sessions[0];

test('legacy Nika regression fixture preserves the user-approved 30-cycle timing and unattended settings', () => {
  assert.equal(profile.profileName, 'Nika — 30 нових чатів');
  assert.equal(profile.sessions.length, 1);
  assert.equal(session.name, 'Nika — 30 циклів');
  assert.equal(session.promptMode, 'shared');
  assert.equal(session.urlMode, 'shared');
  assert.equal(session.runMode, 'one-pass');
  assert.equal(session.minimumSendIntervalMinutes, 1);
  assert.equal(session.preSendDelaySeconds, 10);
  assert.equal(session.busyCheckDelaySeconds, 10);
  assert.equal(session.retryBackoffSeconds, 15);
  assert.equal(session.retryPolicy, 'safe');
  assert.equal(session.tabStrategy, 'open-close');
  assert.equal(session.tasks.length, 30);
  assert.ok(session.tasks.every((task, index) => task.url === 'https://chatgpt.com/' && task.enabled === true && task.label === `Nika ${index + 1}`));
});

test('legacy Nika regression fixture shared prompt is byte-for-byte unchanged from the approved prompt', () => {
  assert.equal(session.sharedPrompt.length, 3942);
  assert.equal(crypto.createHash('sha256').update(session.sharedPrompt, 'utf8').digest('hex'), '7a0829622b8fe0d271d9803ee795c820543967dfafc856d551a8fda7493fb7b5');
});
