import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../src/ui/options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/ui/options.js', import.meta.url), 'utf8');

test('Agent screen exposes an explicitly opt-in, bounded, NVDA-labelled Specialist automation policy', () => {
  assert.match(html, /<fieldset[^>]+id="agent-specialist-automation-policy-group"[^>]+aria-describedby="agent-specialist-automation-policy-help"/);
  assert.match(html, /<legend>Автоматичне виконання Specialist<\/legend>/);
  assert.match(html, /id="agent-specialist-automation-enabled" type="checkbox"/);
  assert.match(
    html,
    /id="agent-specialist-automation-max-concurrent" type="number" min="0" max="256" step="1"[^>]+aria-describedby="agent-specialist-automation-policy-help"/,
  );
  assert.match(html, /id="agent-specialist-automation-status" role="status"/);
  assert.match(html, /Вимкнено за замовчуванням/);
  assert.match(html, /Успіх provider не завершує Agent без окремої канонічної перевірки/);
});

test('Agent UI reads and mutates the durable policy only through exact BrowserAgent commands', () => {
  assert.match(source, /core\('GET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY'\)/);
  assert.match(
    source,
    /core\('SET_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY', \{[\s\S]*?expectedRevision: ui\.specialistAutomationPolicyRevision,[\s\S]*?enabled: \$\('agent-specialist-automation-enabled'\)\.checked,[\s\S]*?maxConcurrentHandoffs/,
  );
  assert.match(
    source,
    /core\('CLEAR_BROWSER_AGENT_SPECIALIST_AUTOMATION_POLICY', \{[\s\S]*?expectedRevision: ui\.specialistAutomationPolicyRevision/,
  );
  assert.match(
    source,
    /parseStrictBoundedInteger\([\s\S]*?agent-specialist-automation-max-concurrent[\s\S]*?min: 0, max: 256/,
  );
});

test('UI treats missing or corrupt policy as fail-closed and reloads on CAS drift', () => {
  assert.match(source, /Policy не налаштовано\. Автоматичний Specialist CLAIM вимкнено fail-closed/);
  assert.match(source, /Автоматичний CLAIM заблоковано до явного відновлення storage/);
  assert.match(source, /revision drifted/i);
  assert.match(source, /await loadSpecialistAutomationPolicy\(\)/);
});
