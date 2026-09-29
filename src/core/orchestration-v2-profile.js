import { DEFAULT_ORCHESTRATION_CONFIG, validateOrchestrationConfig } from './orchestration-v2.js';
import { validateOrchestrationGraphV1 } from './orchestration-hierarchy.js';
import { normalizeSubagentStructurePolicyV1 } from './subagent-structure-policy.js';

export const ORCHESTRATION_PROFILE_KIND = 'chatgpt-autopilot-orchestration-v2';
export const ORCHESTRATION_PROFILE_VERSION = 1;

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function seconds(ms) { return Math.round(Number(ms || 0) / 1000); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`); return value; }
function plainObject(value, label) { const source = object(value, label); const prototype = Object.getPrototypeOf(source); if (prototype !== Object.prototype && prototype !== null) throw new Error(`Invalid ${label}`); return source; }
function requiredOwn(value, key, label) { if (!Object.hasOwn(value, key)) throw new Error(`Invalid ${label}`); return value[key]; }
function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`Unknown ${label} field: ${extras[0]}`);
}
function requiredString(value, label, max = 200000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`Invalid ${label}`);
  return value.trim();
}
function strictInteger(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
function strictBoolean(value, label) { if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`); return value; }
function repository(value, label) {
  const v = requiredString(value, label, 250);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(v)) throw new Error(`Invalid ${label}`);
  return v;
}

function portableHierarchyGraph(raw) {
  const source = object(raw, 'hierarchy');
  exactKeys(source, ['schemaVersion','graphId','controlEpoch','loopPolicy','promptProfiles','nodes','rootIds','nodeOrder','nodesById'], 'hierarchy');
  const graph = validateOrchestrationGraphV1(source);
  return {
    schemaVersion: graph.schemaVersion,
    graphId: graph.graphId,
    controlEpoch: graph.controlEpoch,
    loopPolicy: { ...graph.loopPolicy },
    promptProfiles: graph.promptProfiles.map(profile => ({ ...profile })),
    nodes: graph.nodeOrder.map(nodeId => {
      const node = graph.nodesById[nodeId];
      const portable = {
        id: node.id,
        parentId: node.parentId,
        childIds: [...node.childIds],
        chatMode: node.chatMode,
        promptProfileId: node.promptProfileId,
        recoveryPromptProfileId: node.recoveryPromptProfileId,
        maxActiveChildren: node.maxActiveChildren,
        barrier: {
          mode: node.barrier.mode,
          childIds: [...node.barrier.childIds],
        },
      };
      if (node.providerBinding) portable.providerBinding = { ...node.providerBinding };
      return portable;
    }),
  };
}

function portableSubagentPolicy(raw) {
  const source = plainObject(raw, 'subagent_policy');
  exactKeys(source, ['allow_agent_created_children','max_depth','max_children_per_agent'], 'subagent_policy');
  return normalizeSubagentStructurePolicyV1({
    allowAgentCreatedChildren: strictBoolean(
      requiredOwn(source, 'allow_agent_created_children', 'subagent_policy.allow_agent_created_children'),
      'subagent_policy.allow_agent_created_children',
    ),
    maxDepth: strictInteger(
      requiredOwn(source, 'max_depth', 'subagent_policy.max_depth'),
      'subagent_policy.max_depth',
      0,
      64,
    ),
    maxChildrenPerAgent: strictInteger(
      requiredOwn(source, 'max_children_per_agent', 'subagent_policy.max_children_per_agent'),
      'subagent_policy.max_children_per_agent',
      0,
      1000,
    ),
  });
}

function parseProfile(raw) {
  const root = object(raw, 'orchestration configuration file');
  exactKeys(root, ['kind','version','name','project','github_control','providers','coordinator','safety','local_limits','timing','hierarchy','subagent_policy'], 'root');
  if (root.kind !== ORCHESTRATION_PROFILE_KIND || root.version !== ORCHESTRATION_PROFILE_VERSION) throw new Error('Unsupported orchestration configuration format');
  if (typeof root.name !== 'string' || root.name.trim().length > 120) throw new Error('Invalid name');

  const project = object(root.project, 'project');
  const github = object(root.github_control, 'github_control');
  const providers = object(root.providers, 'providers');
  const coordinator = object(root.coordinator, 'coordinator');
  const safety = object(root.safety, 'safety');
  const limits = object(root.local_limits, 'local_limits');
  const timing = object(root.timing, 'timing');
  exactKeys(project, ['id','target_repository'], 'project');
  exactKeys(github, ['repository','issue','comment_id','bootstrap_pinned_control_first'], 'github_control');
  exactKeys(providers, ['coordinator','worker'], 'providers');
  exactKeys(coordinator, ['launch_url','master_prompt','tick_prompt','prompt_version','max_turns_per_chat'], 'coordinator');
  exactKeys(safety, ['fallback_universal_prompt_enabled'], 'safety');
  exactKeys(limits, ['initial_workers','max_active_workers','max_launches_per_window','launch_window_seconds','minimum_launch_interval_seconds','worker_probe_interval_seconds','watchdog_seconds','stale_worker_seconds'], 'local_limits');
  exactKeys(timing, ['worker_pre_send_seconds','worker_busy_check_seconds','worker_retry_seconds','coordinator_pre_send_seconds','coordinator_retry_seconds'], 'timing');

  const maxWorkers = strictInteger(limits.max_active_workers, 'local_limits.max_active_workers', 1, 200);
  const initialWorkers = strictInteger(limits.initial_workers, 'local_limits.initial_workers', 0, 200);
  if (initialWorkers > maxWorkers) throw new Error('initial_workers exceeds max_active_workers');
  const config = validateOrchestrationConfig({
    ...DEFAULT_ORCHESTRATION_CONFIG,
    enabled: false,
    projectId: requiredString(project.id, 'project.id', 180),
    targetRepository: repository(project.target_repository, 'project.target_repository'),
    controlRepository: repository(github.repository, 'github_control.repository'),
    controlIssueNumber: strictInteger(github.issue, 'github_control.issue', 1, 1000000000),
    controlCommentId: strictInteger(github.comment_id, 'github_control.comment_id', 0, Number.MAX_SAFE_INTEGER),
    bootstrapPinnedControlFirst: strictBoolean(github.bootstrap_pinned_control_first ?? false, 'github_control.bootstrap_pinned_control_first'),
    coordinatorAgentProviderId: requiredString(providers.coordinator, 'providers.coordinator', 120),
    workerAgentProviderId: requiredString(providers.worker, 'providers.worker', 120),
    coordinatorLaunchUrl: requiredString(coordinator.launch_url, 'coordinator.launch_url', 2000),
    masterCoordinatorPrompt: requiredString(coordinator.master_prompt, 'coordinator.master_prompt'),
    coordinatorTickPrompt: requiredString(coordinator.tick_prompt, 'coordinator.tick_prompt'),
    masterPromptVersion: strictInteger(coordinator.prompt_version, 'coordinator.prompt_version', 1, 100000),
    maxCoordinatorTurns: strictInteger(coordinator.max_turns_per_chat, 'coordinator.max_turns_per_chat', 1, 1000),
    fallbackUniversalPromptEnabled: strictBoolean(safety.fallback_universal_prompt_enabled, 'safety.fallback_universal_prompt_enabled'),
    defaultDesiredWorkers: initialWorkers,
    absoluteMaxWorkers: maxWorkers,
    maxLaunchesPerWindow: strictInteger(limits.max_launches_per_window, 'local_limits.max_launches_per_window', 0, 10000),
    launchWindowSeconds: strictInteger(limits.launch_window_seconds, 'local_limits.launch_window_seconds', 10, 86400),
    minimumWorkerLaunchIntervalMs: strictInteger(limits.minimum_launch_interval_seconds, 'local_limits.minimum_launch_interval_seconds', 0, 3600) * 1000,
    workerProbeIntervalSeconds: strictInteger(limits.worker_probe_interval_seconds, 'local_limits.worker_probe_interval_seconds', 30, 600),
    watchdogIntervalSeconds: strictInteger(limits.watchdog_seconds, 'local_limits.watchdog_seconds', 60, 3600),
    staleWorkerAfterSeconds: strictInteger(limits.stale_worker_seconds, 'local_limits.stale_worker_seconds', 300, 86400),
    workerPreSendDelayMs: strictInteger(timing.worker_pre_send_seconds, 'timing.worker_pre_send_seconds', 1, 30) * 1000,
    workerBusyCheckDelayMs: strictInteger(timing.worker_busy_check_seconds, 'timing.worker_busy_check_seconds', 1, 30) * 1000,
    workerRetryBackoffMs: strictInteger(timing.worker_retry_seconds, 'timing.worker_retry_seconds', 5, 3600) * 1000,
    coordinatorPreSendDelayMs: strictInteger(timing.coordinator_pre_send_seconds, 'timing.coordinator_pre_send_seconds', 1, 30) * 1000,
    coordinatorRetryBackoffMs: strictInteger(timing.coordinator_retry_seconds, 'timing.coordinator_retry_seconds', 5, 3600) * 1000,
  });
  const hierarchy = root.hierarchy === undefined ? null : portableHierarchyGraph(root.hierarchy);
  const subagentPolicy = root.subagent_policy === undefined
    ? normalizeSubagentStructurePolicyV1({})
    : portableSubagentPolicy(root.subagent_policy);
  return { config, hierarchy, subagentPolicy };
}

export function exportOrchestrationProfile(configRaw, { name = 'Orchestration', hierarchy = null, subagentPolicy = null } = {}) {
  const config = validateOrchestrationConfig(configRaw || {});
  const profile = {
    kind: ORCHESTRATION_PROFILE_KIND,
    version: ORCHESTRATION_PROFILE_VERSION,
    name: clean(name) || 'Orchestration',
    project: {
      id: config.projectId,
      target_repository: config.targetRepository,
    },
    github_control: {
      repository: config.controlRepository,
      issue: config.controlIssueNumber,
      comment_id: config.controlCommentId || 0,
      bootstrap_pinned_control_first: config.bootstrapPinnedControlFirst === true,
    },
    providers: {
      coordinator: config.coordinatorAgentProviderId,
      worker: config.workerAgentProviderId,
    },
    coordinator: {
      launch_url: config.coordinatorLaunchUrl,
      master_prompt: config.masterCoordinatorPrompt,
      tick_prompt: config.coordinatorTickPrompt,
      prompt_version: config.masterPromptVersion,
      max_turns_per_chat: config.maxCoordinatorTurns,
    },
    safety: {
      fallback_universal_prompt_enabled: config.fallbackUniversalPromptEnabled === true,
    },
    local_limits: {
      initial_workers: config.defaultDesiredWorkers,
      max_active_workers: config.absoluteMaxWorkers,
      max_launches_per_window: config.maxLaunchesPerWindow,
      launch_window_seconds: config.launchWindowSeconds,
      minimum_launch_interval_seconds: seconds(config.minimumWorkerLaunchIntervalMs),
      worker_probe_interval_seconds: config.workerProbeIntervalSeconds,
      watchdog_seconds: config.watchdogIntervalSeconds,
      stale_worker_seconds: config.staleWorkerAfterSeconds,
    },
    timing: {
      worker_pre_send_seconds: seconds(config.workerPreSendDelayMs),
      worker_busy_check_seconds: seconds(config.workerBusyCheckDelayMs),
      worker_retry_seconds: seconds(config.workerRetryBackoffMs),
      coordinator_pre_send_seconds: seconds(config.coordinatorPreSendDelayMs),
      coordinator_retry_seconds: seconds(config.coordinatorRetryBackoffMs),
    },
  };
  if (hierarchy) profile.hierarchy = portableHierarchyGraph(hierarchy);
  if (subagentPolicy !== null) {
    const normalized = normalizeSubagentStructurePolicyV1(subagentPolicy);
    profile.subagent_policy = {
      allow_agent_created_children: normalized.allowAgentCreatedChildren,
      max_depth: normalized.maxDepth,
      max_children_per_agent: normalized.maxChildrenPerAgent,
    };
  }
  return profile;
}

export function importOrchestrationProfileDocument(raw) {
  return parseProfile(raw);
}

export function importOrchestrationProfile(raw) {
  return parseProfile(raw).config;
}

export function previewOrchestrationProfile(raw) {
  const parsed = parseProfile(raw);
  const config = parsed.config;
  const preview = {
    name: clean(raw.name) || 'Orchestration',
    projectId: config.projectId,
    targetRepository: config.targetRepository,
    controlRepository: config.controlRepository,
    controlIssueNumber: config.controlIssueNumber,
    controlCommentId: config.controlCommentId,
    bootstrapPinnedControlFirst: config.bootstrapPinnedControlFirst === true,
    coordinatorProviderId: config.coordinatorAgentProviderId,
    workerProviderId: config.workerAgentProviderId,
    initialWorkers: config.defaultDesiredWorkers,
    maxActiveWorkers: config.absoluteMaxWorkers,
    maxLaunchesPerWindow: config.maxLaunchesPerWindow,
    launchWindowSeconds: config.launchWindowSeconds,
    minimumLaunchIntervalSeconds: seconds(config.minimumWorkerLaunchIntervalMs),
    maxCoordinatorTurns: config.maxCoordinatorTurns,
  };
  if (parsed.hierarchy) {
    preview.hierarchy = {
      graphId: parsed.hierarchy.graphId,
      controlEpoch: parsed.hierarchy.controlEpoch,
      loopMode: parsed.hierarchy.loopPolicy?.mode || 'ONE_SHOT',
      maxRounds: parsed.hierarchy.loopPolicy?.maxRounds || 0,
      rootCount: parsed.hierarchy.nodes.filter(node => node.parentId === null).length,
      nodeCount: parsed.hierarchy.nodes.length,
      promptProfileCount: parsed.hierarchy.promptProfiles.length,
    };
  }
  if (raw.subagent_policy !== undefined) {
    preview.subagentPolicy = {
      allowAgentCreatedChildren: parsed.subagentPolicy.allowAgentCreatedChildren,
      maxDepth: parsed.subagentPolicy.maxDepth,
      maxChildrenPerAgent: parsed.subagentPolicy.maxChildrenPerAgent,
    };
  }
  return preview;
}
