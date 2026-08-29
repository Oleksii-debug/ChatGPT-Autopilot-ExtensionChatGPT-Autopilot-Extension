import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../src/ui/options.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../../src/ui/options.js', import.meta.url), 'utf8');

test('delete dialog exposes its destructive description to assistive technology', () => {
  assert.match(
    html,
    /id="delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-heading" aria-describedby="delete-dialog-description"/,
  );
  assert.match(js, /delete-dialog-description'\)\.textContent = `Delete session \$\{sessionName\}\./);
  assert.match(js, /confirm-delete-button'\)\.setAttribute\('aria-label', `Delete session \$\{sessionName\}`\)/);
});

test('repeated session actions have session-specific accessible names', () => {
  assert.match(js, /Rename session \$\{sessionName\}/);
  assert.match(js, /Duplicate session \$\{sessionName\}/);
  assert.match(js, /Delete session \$\{sessionName\}/);
});

test('successful delete restores focus to a surviving session or Create session', () => {
  assert.match(js, /function deleteFocusTargetId\(sessionId\)/);
  assert.match(js, /ui\.sessions\[index \+ 1\] \|\| ui\.sessions\[index - 1\]/);
  assert.match(js, /closeDeleteDialog\(\{ restoreFocus: false \}\)/);
  assert.match(js, /await loadSessions\(\{ preserveFocus: false \}\)/);
  assert.match(js, /\(\$\(focusTargetId\) \|\| \$\('create-session-button'\)\)\.focus\(\)/);
});

test('delete failure remains visible as normal status text as well as announced', () => {
  assert.match(js, /catch \(e\) \{ setAppStatus\(e\.message\); announce\(e\.message\); \}/);
});
