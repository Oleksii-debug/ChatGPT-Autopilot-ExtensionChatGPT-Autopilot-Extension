import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ORCHESTRATION_CONFIG } from '../src/core/orchestration-v2.js';
import {
  exportOrchestrationProfile,
  importOrchestrationProfileDocument,
  previewOrchestrationProfile,
} from '../src/core/orchestration-v2-profile.js';

const CONFIG = {
  ...DEFAULT_ORCHESTRATION_CONFIG,
  projectId: 'subagent-policy-project',
  targetRepository: 'owner/target',
  controlRepository: 'owner/control',
  controlIssueNumber: 42,
  masterCoordinatorPrompt: 'MASTER',
};

const SUBAGENT_POLICY = {
  schemaVersion: 1,
  allowAgentCreatedChildren: true,
  maxDepth: 4,
  maxChildrenPerAgent: 7,
};

test('legacy orchestration profiles remain valid and default dynamic subagent creation closed', () => {
  const profile = exportOrchestrationProfile(CONFIG, { name: 'Legacy-compatible' });
  assert.equal(Object.hasOwn(profile, 'subagent_policy'), false);

  const document = importOrchestrationProfileDocument(profile);
  assert.deepEqual(document.subagentPolicy, {
    schemaVersion: 1,
    allowAgentCreatedChildren: false,
    maxDepth: 0,
    maxChildrenPerAgent: 0,
  });

  const preview = previewOrchestrationProfile(profile);
  assert.equal(Object.hasOwn(preview, 'subagentPolicy'), false);
});

test('owner subagent policy round-trips through the existing portable profile', () => {
  const profile = exportOrchestrationProfile(CONFIG, {
    name: 'Dynamic children',
    subagentPolicy: SUBAGENT_POLICY,
  });

  assert.deepEqual(profile.subagent_policy, {
    allow_agent_created_children: true,
    max_depth: 4,
    max_children_per_agent: 7,
  });

  const document = importOrchestrationProfileDocument(profile);
  assert.deepEqual(document.subagentPolicy, SUBAGENT_POLICY);

  const preview = previewOrchestrationProfile(profile);
  assert.deepEqual(preview.subagentPolicy, {
    allowAgentCreatedChildren: true,
    maxDepth: 4,
    maxChildrenPerAgent: 7,
  });
});

test('portable subagent policy fails closed on unknown, missing and out-of-range fields', () => {
  const profile = exportOrchestrationProfile(CONFIG, { subagentPolicy: SUBAGENT_POLICY });

  const unknown = structuredClone(profile);
  unknown.subagent_policy.surprise = true;
  assert.throws(() => importOrchestrationProfileDocument(unknown), /Unknown subagent_policy field/);

  const missing = structuredClone(profile);
  delete missing.subagent_policy.max_depth;
  assert.throws(() => importOrchestrationProfileDocument(missing), /max_depth/);

  const tooDeep = structuredClone(profile);
  tooDeep.subagent_policy.max_depth = 65;
  assert.throws(() => importOrchestrationProfileDocument(tooDeep), /max_depth/);

  const coercion = structuredClone(profile);
  coercion.subagent_policy.max_children_per_agent = '7';
  assert.throws(() => importOrchestrationProfileDocument(coercion), /max_children_per_agent/);
});


test('portable subagent policy rejects inherited authority fields and accepts explicit null-prototype own fields', () => {
  const profile = exportOrchestrationProfile(CONFIG, { subagentPolicy: SUBAGENT_POLICY });

  const inherited = structuredClone(profile);
  inherited.subagent_policy = Object.create({
    allow_agent_created_children: true,
    max_depth: 4,
    max_children_per_agent: 7,
  });
  assert.throws(() => importOrchestrationProfileDocument(inherited), /Invalid subagent_policy/);

  const nullPrototype = structuredClone(profile);
  nullPrototype.subagent_policy = Object.assign(Object.create(null), {
    allow_agent_created_children: true,
    max_depth: 4,
    max_children_per_agent: 7,
  });
  const parsed = importOrchestrationProfileDocument(nullPrototype);
  assert.deepEqual(parsed.subagentPolicy, SUBAGENT_POLICY);
});
