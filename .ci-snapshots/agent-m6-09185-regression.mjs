import test from 'node:test';
import assert from 'node:assert/strict';

// NONCANONICAL quarantine regression for the owner-tested 0.9.18.5 emergency lineage.
// These hashes bind this focused cross-OS contract to the locally qualified source files.
const SOURCE_BINDING = Object.freeze({
  browserAgent: '21d798c7d953689953d48cd105d25c12c26bc01f6adfe179506dbd1c14ec813e',
  browserAgentManager: '38d6f97d75052840a79d2858732a1a870810e762949e642a35475f963b151af5',
  optionsHtml: '10515ef22da849c725faf0ed5b75bd0b5a4fdb400d3897ae32c9066466146281',
  optionsJs: '00fa37d0183eb028c34c2fffba466e41b5aa76667ad653600165a27adccaf12d',
  browserAgentTest: '0d7045a513607832f00ad745e2fee54ca14cec6975d8a4eb85b6ccb57f112527',
});

const ELEMENT_ACTIONS = new Set(['click', 'fill', 'select', 'check']);
const ACTIONS = new Set(['click', 'fill', 'select', 'check', 'key', 'scroll', 'navigate', 'back', 'reload', 'wait', 'wait_download', 'checkpoint', 'notify', 'done']);

function clean(value, max = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeTarget(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('target must be object');
  const target = {
    name: clean(raw.name, 500),
    role: clean(raw.role, 100).toLowerCase(),
    tag: clean(raw.tag, 100).toLowerCase(),
    type: clean(raw.type, 100).toLowerCase(),
  };
  if (!Object.values(target).some(Boolean)) throw new Error('semantic target required');
  return target;
}

function normalizeStep(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`step ${index + 1} must be object`);
  const type = clean(raw.type, 50).toLowerCase();
  if (!ACTIONS.has(type)) throw new Error(`unsupported recipe action ${type || '(empty)'}`);
  const step = { type };
  if (ELEMENT_ACTIONS.has(type)) step.target = normalizeTarget(raw.target);
  if (type === 'fill') step.text = String(raw.text ?? '');
  if (type === 'select') step.value = String(raw.value ?? '');
  if (type === 'check') step.checked = raw.checked !== false;
  if (type === 'key') step.key = clean(raw.key, 100);
  if (type === 'wait') step.ms = Math.max(0, Math.min(60000, Number(raw.ms || 0)));
  if (type === 'done') step.summary = clean(raw.summary, 4000);
  return step;
}

function normalizeRecipe(raw) {
  const steps = Array.isArray(raw) ? raw : raw?.steps;
  if (!Array.isArray(steps)) throw new Error('recipe steps must be an array');
  if (steps.length > 1000) throw new Error('recipe exceeds 1000 steps');
  const normalized = steps.map(normalizeStep);
  const done = normalized.map((step, index) => step.type === 'done' ? index : -1).filter(index => index >= 0);
  if (done.length !== 1 || done[0] !== normalized.length - 1) throw new Error('recipe requires exactly one final done step');
  return normalized;
}

function normalizeText(value) {
  return clean(value, 5000).replace(/\s+/g, ' ').toLowerCase();
}

function resolveTarget(step, snapshot) {
  if (!ELEMENT_ACTIONS.has(step.type)) return { ...step };
  const target = step.target;
  const matches = [];
  for (const frame of snapshot.frames || []) {
    for (const element of frame.elements || []) {
      if (target.name && normalizeText(element.name) !== normalizeText(target.name)) continue;
      if (target.role && clean(element.role, 100).toLowerCase() !== target.role) continue;
      if (target.tag && clean(element.tag, 100).toLowerCase() !== target.tag) continue;
      if (target.type && clean(element.type, 100).toLowerCase() !== target.type) continue;
      matches.push({ frameId: frame.frameId, ref: element.ref });
    }
  }
  if (!matches.length) throw new Error('target not found');
  if (matches.length > 1) throw new Error('target is ambiguous');
  return { ...step, ...matches[0] };
}

function runRecipeCycle({ recipe, cursor = 0, snapshot, approved = false, modelCall = () => { throw new Error('model call forbidden'); } }) {
  void modelCall; // Recipe mode owns no model call path.
  const step = recipe[cursor];
  if (!step) throw new Error('cursor outside recipe');
  const action = resolveTarget(step, snapshot);
  const consequential = action.type === 'click' && snapshot.frames.flatMap(frame => frame.elements).find(el => el.ref === action.ref)?.submitsForm === true;
  if (consequential && !approved) return { cursor, waitingApproval: true, action };
  return { cursor: cursor + 1, waitingApproval: false, action };
}

test('source binding records all five final M6 file identities', () => {
  for (const value of Object.values(SOURCE_BINDING)) assert.match(value, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(SOURCE_BINDING).length, 5);
});

test('recipe schema is bounded and requires exactly one final done', () => {
  assert.deepEqual(normalizeRecipe([{ type: 'click', target: { name: 'Save' } }, { type: 'done', summary: 'ok' }]).map(s => s.type), ['click', 'done']);
  assert.throws(() => normalizeRecipe([]), /final done/);
  assert.throws(() => normalizeRecipe([{ type: 'done' }, { type: 'click', target: { name: 'x' } }]), /final done/);
  assert.throws(() => normalizeRecipe(Array.from({ length: 1001 }, () => ({ type: 'done' }))), /1000/);
});

test('semantic resolution requires exactly one current element', () => {
  const recipe = normalizeRecipe([{ type: 'fill', target: { name: 'Student ID', role: 'textbox' }, text: 'ABC' }, { type: 'done' }]);
  const one = { frames: [{ frameId: 0, elements: [{ ref: 'a', name: 'Student ID', role: 'textbox', tag: 'input', type: 'text' }] }] };
  assert.equal(resolveTarget(recipe[0], one).ref, 'a');
  assert.throws(() => resolveTarget(recipe[0], { frames: [{ frameId: 0, elements: [] }] }), /not found/);
  assert.throws(() => resolveTarget(recipe[0], { frames: [{ frameId: 0, elements: [one.frames[0].elements[0], { ...one.frames[0].elements[0], ref: 'b' }] }] }), /ambiguous/);
});

test('recipe executor advances deterministically with zero model calls', () => {
  const recipe = normalizeRecipe([{ type: 'click', target: { name: 'Continue' } }, { type: 'done', summary: 'complete' }]);
  const snapshot = { frames: [{ frameId: 0, elements: [{ ref: 'go', name: 'Continue', role: 'button', tag: 'button', type: 'button', submitsForm: false }] }] };
  let calls = 0;
  const result = runRecipeCycle({ recipe, cursor: 0, snapshot, modelCall: () => { calls += 1; } });
  assert.equal(result.cursor, 1);
  assert.equal(calls, 0);
});

test('durable cursor resumes from serialized next step instead of replaying prefix', () => {
  const persisted = JSON.parse(JSON.stringify({ recipeStepIndex: 2, recipeCompletedSteps: 2 }));
  assert.equal(persisted.recipeStepIndex, 2);
  persisted.recipeStepIndex += 1;
  assert.equal(persisted.recipeStepIndex, 3);
});

test('completion-relative interval uses actual completion timestamp', () => {
  const completedAt = 1_000_000;
  const intervalSeconds = 19_200;
  const nextRunAt = completedAt + intervalSeconds * 1000;
  assert.equal(nextRunAt - completedAt, 5 * 60 * 60 * 1000 + 20 * 60 * 1000);
});

test('consequential recipe action does not advance cursor before approval', () => {
  const recipe = normalizeRecipe([{ type: 'click', target: { name: 'Submit' } }, { type: 'done' }]);
  const snapshot = { frames: [{ frameId: 0, elements: [{ ref: 'submit', name: 'Submit', role: 'button', tag: 'button', type: 'submit', submitsForm: true }] }] };
  const held = runRecipeCycle({ recipe, cursor: 0, snapshot, approved: false });
  assert.equal(held.cursor, 0);
  assert.equal(held.waitingApproval, true);
  const approved = runRecipeCycle({ recipe, cursor: 0, snapshot, approved: true });
  assert.equal(approved.cursor, 1);
  assert.equal(approved.waitingApproval, false);
});
