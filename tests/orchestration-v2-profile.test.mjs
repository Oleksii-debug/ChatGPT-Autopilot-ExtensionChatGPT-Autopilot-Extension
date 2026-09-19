import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORCHESTRATION_PROFILE_KIND,
  ORCHESTRATION_PROFILE_VERSION,
  exportOrchestrationProfile,
  importOrchestrationProfile,
  importOrchestrationProfileDocument,
  previewOrchestrationProfile,
} from '../src/core/orchestration-v2-profile.js';

const CONFIG = {
  enabled: true,
  projectId: 'proj-main',
  targetRepository: 'owner/target',
  controlRepository: 'owner/control',
  controlIssueNumber: 121,
  controlCommentId: 987654,
  bootstrapPinnedControlFirst: true,
  coordinatorLaunchUrl: 'https://chatgpt.com/',
  masterCoordinatorPrompt: 'MASTER',
  coordinatorTickPrompt: 'TICK',
  masterPromptVersion: 3,
  maxCoordinatorTurns: 20,
  defaultDesiredWorkers: 6,
  absoluteMaxWorkers: 30,
  maxLaunchesPerWindow: 20,
  launchWindowSeconds: 600,
  minimumWorkerLaunchIntervalMs: 5000,
  workerProbeIntervalSeconds: 45,
  watchdogIntervalSeconds: 300,
  staleWorkerAfterSeconds: 3600,
  workerPreSendDelayMs: 8000,
  workerBusyCheckDelayMs: 2000,
  workerRetryBackoffMs: 90000,
  coordinatorPreSendDelayMs: 7000,
  coordinatorRetryBackoffMs: 120000,
};

const HIERARCHY = {
  schemaVersion: 1,
  graphId: 'proj-main-hierarchy',
  controlEpoch: 3,
  promptProfiles: [
    { id: 'director-v1', role: 'GLOBAL_DIRECTOR', version: 1, prompt: 'DIRECTOR' },
    { id: 'manager-v1', role: 'DOMAIN_MANAGER', version: 1, prompt: 'MANAGER' },
    { id: 'worker-v1', role: 'WORKER', version: 1, prompt: 'WORKER' },
    { id: 'recovery-v1', role: 'RECOVERY', version: 1, prompt: 'RECOVER FROM EXTERNAL TRUTH' },
  ],
  nodes: [
    {
      id: 'director',
      parentId: null,
      childIds: ['manager'],
      promptProfileId: 'director-v1',
      recoveryPromptProfileId: 'recovery-v1',
      chatMode: 'PERSISTENT_CHAT',
      maxActiveChildren: 1,
      barrier: { mode: 'ALL_DIRECT_CHILDREN' },
    },
    {
      id: 'manager',
      parentId: 'director',
      childIds: ['worker'],
      promptProfileId: 'manager-v1',
      recoveryPromptProfileId: 'recovery-v1',
      chatMode: 'PERSISTENT_CHAT',
      maxActiveChildren: 1,
      barrier: { mode: 'ALL_DIRECT_CHILDREN' },
    },
    {
      id: 'worker',
      parentId: 'manager',
      childIds: [],
      promptProfileId: 'worker-v1',
      recoveryPromptProfileId: 'recovery-v1',
      chatMode: 'NEW_CHAT_PER_ACTIVATION',
      maxActiveChildren: 0,
      barrier: { mode: 'NONE' },
    },
  ],
};

test('orchestration profile round-trip preserves owner policy but never auto-enables', () => {
  const profile = exportOrchestrationProfile(CONFIG, { name: 'Night development' });
  assert.equal(profile.kind, ORCHESTRATION_PROFILE_KIND);
  assert.equal(profile.version, ORCHESTRATION_PROFILE_VERSION);
  assert.equal(profile.local_limits.max_active_workers, 30);
  assert.equal(profile.local_limits.max_launches_per_window, 20);
  assert.equal(profile.local_limits.launch_window_seconds, 600);
  assert.equal(profile.local_limits.minimum_launch_interval_seconds, 5);
  const imported = importOrchestrationProfile(profile);
  assert.equal(imported.enabled, false);
  assert.equal(imported.projectId, CONFIG.projectId);
  assert.equal(imported.targetRepository, CONFIG.targetRepository);
  assert.equal(imported.controlRepository, CONFIG.controlRepository);
  assert.equal(imported.controlIssueNumber, CONFIG.controlIssueNumber);
  assert.equal(imported.controlCommentId, CONFIG.controlCommentId);
  assert.equal(profile.github_control.bootstrap_pinned_control_first, true);
  assert.equal(imported.bootstrapPinnedControlFirst, true);
  assert.equal(imported.maxCoordinatorTurns, 20);
  assert.equal(imported.defaultDesiredWorkers, 6);
  assert.equal(imported.absoluteMaxWorkers, 30);
  assert.equal(imported.maxLaunchesPerWindow, 20);
  assert.equal(imported.minimumWorkerLaunchIntervalMs, 5000);
});

test('profile preview is concise and reports execution limits', () => {
  const profile = exportOrchestrationProfile(CONFIG, { name: 'Night development' });
  const preview = previewOrchestrationProfile(profile);
  assert.deepEqual(preview, {
    name: 'Night development',
    projectId: 'proj-main',
    targetRepository: 'owner/target',
    controlRepository: 'owner/control',
    controlIssueNumber: 121,
    controlCommentId: 987654,
    bootstrapPinnedControlFirst: true,
    coordinatorProviderId: 'chatgpt-browser',
    workerProviderId: 'chatgpt-browser',
    initialWorkers: 6,
    maxActiveWorkers: 30,
    maxLaunchesPerWindow: 20,
    launchWindowSeconds: 600,
    minimumLaunchIntervalSeconds: 5,
    maxCoordinatorTurns: 20,
  });
});

test('profile import rejects wrong kind/version, unknown fields, missing fields and unsafe values fail-closed', () => {
  const profile = exportOrchestrationProfile(CONFIG);
  assert.throws(() => importOrchestrationProfile({ ...profile, kind: 'other' }), /Unsupported/);
  assert.throws(() => importOrchestrationProfile({ ...profile, version: 2 }), /Unsupported/);
  assert.throws(() => importOrchestrationProfile({ ...profile, surprise: true }), /Unknown root field/);
  const missing = structuredClone(profile); delete missing.timing.worker_retry_seconds;
  assert.throws(() => importOrchestrationProfile(missing), /worker_retry_seconds/);
  const unsafe = structuredClone(profile); unsafe.local_limits.max_active_workers = 99999;
  assert.throws(() => importOrchestrationProfile(unsafe), /max_active_workers/);
  const relationship = structuredClone(profile); relationship.local_limits.initial_workers = 31; relationship.local_limits.max_active_workers = 30;
  assert.throws(() => importOrchestrationProfile(relationship), /exceeds/);
  const unsafeUrl = structuredClone(profile); unsafeUrl.coordinator.launch_url = 'https://example.com/';
  assert.throws(() => importOrchestrationProfile(unsafeUrl), /does not accept URL/);
  const adapterMismatch = structuredClone(profile); adapterMismatch.coordinator.launch_url = 'https://www.chatgpt.com/';
  assert.throws(() => importOrchestrationProfile(adapterMismatch), /does not accept URL/);
});

test('three user roles round-trip without auto-start and preserve explicit limits', () => {
  for (const role of [
    { name:'Conservative', initial:1, max:2, launches:2, window:300, gap:30 },
    { name:'Balanced', initial:4, max:8, launches:8, window:300, gap:5 },
    { name:'Throughput', initial:12, max:20, launches:30, window:600, gap:0 },
  ]) {
    const config = { ...CONFIG, enabled:true, defaultDesiredWorkers:role.initial, absoluteMaxWorkers:role.max, maxLaunchesPerWindow:role.launches, launchWindowSeconds:role.window, minimumWorkerLaunchIntervalMs:role.gap * 1000 };
    const imported = importOrchestrationProfile(exportOrchestrationProfile(config, {name:role.name}));
    assert.equal(imported.enabled, false);
    assert.equal(imported.defaultDesiredWorkers, role.initial);
    assert.equal(imported.absoluteMaxWorkers, role.max);
    assert.equal(imported.maxLaunchesPerWindow, role.launches);
    assert.equal(imported.minimumWorkerLaunchIntervalMs, role.gap * 1000);
  }
});


test('hierarchy graph and role prompt profiles round-trip with orchestra profile without auto-start', () => {
  const profile = exportOrchestrationProfile(CONFIG, { name: 'Hierarchy project', hierarchy: HIERARCHY });
  assert.equal(profile.hierarchy.graphId, 'proj-main-hierarchy');
  assert.equal(profile.hierarchy.nodes.length, 3);
  assert.equal(profile.hierarchy.promptProfiles.find(item => item.id === 'director-v1').prompt, 'DIRECTOR');

  const document = importOrchestrationProfileDocument(profile);
  assert.equal(document.config.enabled, false);
  assert.equal(document.hierarchy.controlEpoch, 3);
  assert.deepEqual(document.hierarchy.nodes.map(node => node.id), ['director', 'manager', 'worker']);
  assert.equal(document.hierarchy.nodes.find(node => node.id === 'worker').chatMode, 'NEW_CHAT_PER_ACTIVATION');
  assert.equal(document.hierarchy.nodes.find(node => node.id === 'manager').recoveryPromptProfileId, 'recovery-v1');

  const legacyConfigApi = importOrchestrationProfile(profile);
  assert.equal(legacyConfigApi.projectId, CONFIG.projectId);
  assert.equal(legacyConfigApi.enabled, false);

  const preview = previewOrchestrationProfile(profile);
  assert.deepEqual(preview.hierarchy, {
    graphId: 'proj-main-hierarchy',
    controlEpoch: 3,
    rootCount: 1,
    nodeCount: 3,
    promptProfileCount: 4,
  });
});

test('hierarchy profile export accepts the normalized durable graph shape used after restart', () => {
  const portable = exportOrchestrationProfile(CONFIG, { hierarchy: HIERARCHY });
  const first = importOrchestrationProfileDocument(portable);
  const normalizedLike = {
    ...first.hierarchy,
    rootIds: ['director'],
    nodeOrder: first.hierarchy.nodes.map(node => node.id),
    nodesById: Object.fromEntries(first.hierarchy.nodes.map(node => [node.id, node])),
  };
  delete normalizedLike.nodes;

  const reexported = exportOrchestrationProfile(CONFIG, { hierarchy: normalizedLike });
  const second = importOrchestrationProfileDocument(reexported);
  assert.deepEqual(second.hierarchy, first.hierarchy);
});

test('hierarchy profile fails closed on unknown envelope fields and invalid role bindings', () => {
  const profile = exportOrchestrationProfile(CONFIG, { hierarchy: HIERARCHY });

  const extra = structuredClone(profile);
  extra.hierarchy.surprise = true;
  assert.throws(() => importOrchestrationProfileDocument(extra), /Unknown hierarchy field/);

  const unknownProfile = structuredClone(profile);
  unknownProfile.hierarchy.nodes.find(node => node.id === 'worker').promptProfileId = 'missing-profile';
  assert.throws(() => importOrchestrationProfileDocument(unknownProfile), /Unknown prompt profile/);
});
