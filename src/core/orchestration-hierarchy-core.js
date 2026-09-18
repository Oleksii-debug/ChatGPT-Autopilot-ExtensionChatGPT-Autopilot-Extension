import {
  OperationPhase,
  PromptMode,
  RunMode,
  RunState,
  TabStrategy,
  createSession,
  createTask,
  normalizeChatUrl,
} from './schema.js';
import {
  OrchestrationActivationPurpose,
  OrchestrationChatMode,
  OrchestrationHierarchyActionType,
  OrchestrationHierarchyEventType,
  validateOrchestrationGraphV1,
  validateOrchestrationHierarchyRuntimeV1,
} from './orchestration-hierarchy.js';

const SAFE_TERMINAL_PHASES = new Set([OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE]);
const CHATGPT_ROOT = 'https://chatgpt.com/';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keyPart(value) {
  return encodeURIComponent(String(value || '')).replaceAll('%', '_');
}

export function hierarchyCoreSessionId(graphId, nodeId) {
  return `orch-h:${keyPart(graphId)}:${keyPart(nodeId)}`;
}

export function hierarchyCoreTaskId(graphId, nodeId) {
  return `${hierarchyCoreSessionId(graphId, nodeId)}:task`;
}

function isUnresolvedOperation(session) {
  return Boolean(session?.operation && !SAFE_TERMINAL_PHASES.has(session.operation.phase));
}

function resetTaskForActivation(task, { targetUrl, prompt }) {
  task.url = normalizeChatUrl(targetUrl);
  task.normalizedUrl = normalizeChatUrl(targetUrl);
  task.promptOverride = prompt;
  task.enabled = true;
  task.status = 'IDLE';
  task.lastCheckedAt = 0;
  task.lastVerifiedSendAt = 0;
  task.lastVerifiedFingerprint = '';
  task.retryAfterAt = 0;
  task.manualReviewReason = '';
  task.lastConversationUrl = '';
  task.lastAssistantReport = '';
  task.lastAssistantReportAt = 0;
  task.lastAssistantBaselineCount = 0;
  task.lastAssistantBaselineKnown = false;
}

function promptForAction(graph, action, promptResolver) {
  const node = graph.nodesById[action.nodeId];
  const profile = graph.promptProfiles.find(item => item.id === node.promptProfileId);
  const resolved = typeof promptResolver === 'function'
    ? promptResolver({ graph, node, profile, action })
    : profile?.prompt;
  const prompt = typeof resolved === 'string' ? resolved.trim() : '';
  if (!prompt) throw new Error(`Missing prompt payload for hierarchy node ${action.nodeId}`);
  return prompt;
}

function targetUrlForAction(existingSession, node, action) {
  if (node.chatMode === OrchestrationChatMode.NEW_CHAT_PER_ACTIVATION) return CHATGPT_ROOT;
  if (!existingSession) return CHATGPT_ROOT;
  const previous = existingSession.orchestrationHierarchy;
  if (previous?.generation !== action.generation) return CHATGPT_ROOT;
  const taskId = existingSession.taskOrder?.[0];
  const task = taskId ? existingSession.tasksById?.[taskId] : null;
  return task?.lastConversationUrl || task?.normalizedUrl || CHATGPT_ROOT;
}

function createManagedSession({ graph, node, action, prompt, targetUrl, nowMs, timings }) {
  const sid = hierarchyCoreSessionId(graph.graphId, node.id);
  const tid = hierarchyCoreTaskId(graph.graphId, node.id);
  const task = createTask({
    id: tid,
    url: targetUrl,
    promptOverride: prompt,
    enabled: true,
    label: `Оркестрація: ${node.id}`,
  });
  const session = createSession({
    id: sid,
    name: `Оркестрація: ${node.id}`,
    tasks: [task],
    promptMode: PromptMode.UNIQUE,
    sharedPrompt: '',
    runMode: RunMode.ONE_PASS,
    minimumSendIntervalMs: Math.max(0, Number(timings.minimumSendIntervalMs || 0)),
    preSendDelayMs: Math.max(1000, Number(timings.preSendDelayMs || 8000)),
    busyCheckDelayMs: Math.max(1000, Number(timings.busyCheckDelayMs || 2000)),
    retryBackoffMs: Math.max(5000, Number(timings.retryBackoffMs || 60000)),
    tabStrategy: TabStrategy.KEEP_TASK_TABS_OPEN,
    now: nowMs,
  });
  session.runState = RunState.RUNNING;
  session.orchestrationHierarchy = {
    managed: true,
    graphId: graph.graphId,
    nodeId: node.id,
    generation: action.generation,
    activationId: action.activationId,
    purpose: action.purpose,
    chatMode: node.chatMode,
    promptProfileId: node.promptProfileId,
    actionType: action.type,
  };
  return { session, sessionId: sid, taskId: tid };
}

export function materializeHierarchyActionsIntoCore(
  coreState,
  graphRaw,
  runtime,
  actions,
  {
    nowMs = Date.now(),
    promptResolver = null,
    timings = {},
  } = {},
) {
  if (!isObject(coreState) || !isObject(coreState.sessionsById) || !Array.isArray(coreState.sessionOrder)) {
    throw new Error('Invalid Core state for hierarchy materialization');
  }
  if (!isObject(runtime)) throw new Error('Invalid hierarchy runtime');
  const graph = validateOrchestrationGraphV1(graphRaw);
  if (runtime.graphId !== graph.graphId || runtime.controlEpoch !== graph.controlEpoch) {
    throw new Error('Hierarchy runtime does not match graph');
  }

  const materialized = [];
  const reused = [];
  const blocked = [];

  for (const action of Array.isArray(actions) ? actions : []) {
    if (![OrchestrationHierarchyActionType.ACTIVATE_NODE, OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT].includes(action?.type)) continue;
    const node = graph.nodesById[action.nodeId];
    if (!node) throw new Error(`Unknown hierarchy action node ${action.nodeId}`);
    const nodeRuntime = runtime.nodesById?.[action.nodeId];
    const ledger = nodeRuntime?.activationLedger?.[action.activationId];
    if (!ledger || ledger.generation !== action.generation) {
      blocked.push({ nodeId: action.nodeId, activationId: action.activationId, reason: 'MISSING_DURABLE_ACTIVATION' });
      continue;
    }

    const sid = hierarchyCoreSessionId(graph.graphId, node.id);
    const tid = hierarchyCoreTaskId(graph.graphId, node.id);
    let session = coreState.sessionsById[sid];

    if (session?.orchestrationHierarchy?.activationId === action.activationId
        && session.orchestrationHierarchy?.generation === action.generation) {
      reused.push({ nodeId: node.id, activationId: action.activationId, sessionId: sid, taskId: tid, reason: 'ALREADY_MATERIALIZED' });
      continue;
    }

    if (session && isUnresolvedOperation(session)) {
      blocked.push({
        nodeId: node.id,
        activationId: action.activationId,
        sessionId: sid,
        taskId: tid,
        reason: 'CORE_OPERATION_UNRESOLVED',
      });
      continue;
    }

    const prompt = promptForAction(graph, action, promptResolver);
    const targetUrl = targetUrlForAction(session, node, action);

    if (!session) {
      const created = createManagedSession({ graph, node, action, prompt, targetUrl, nowMs, timings });
      session = created.session;
      if (coreState.profile?.masterPaused) session.runState = RunState.PAUSED;
      coreState.sessionsById[sid] = session;
      if (!coreState.sessionOrder.includes(sid)) coreState.sessionOrder.push(sid);
    } else {
      if (session.operation && SAFE_TERMINAL_PHASES.has(session.operation.phase)) session.operation = null;
      let task = session.tasksById?.[tid];
      if (!task) {
        task = createTask({
          id: tid,
          url: targetUrl,
          promptOverride: prompt,
          enabled: true,
          label: `Оркестрація: ${node.id}`,
        });
        session.tasksById[tid] = task;
        if (!session.taskOrder.includes(tid)) session.taskOrder.push(tid);
      }
      resetTaskForActivation(task, { targetUrl, prompt });
      session.runState = coreState.profile?.masterPaused ? RunState.PAUSED : RunState.RUNNING;
      session.completedAt = 0;
      session.onePassCompletedTaskIds = [];
      session.currentTaskIndex = session.taskOrder.indexOf(tid);
      session.lastError = '';
      session.orchestrationHierarchy = {
        managed: true,
        graphId: graph.graphId,
        nodeId: node.id,
        generation: action.generation,
        activationId: action.activationId,
        purpose: action.purpose,
        chatMode: node.chatMode,
        promptProfileId: node.promptProfileId,
        actionType: action.type,
      };
      session.updatedAt = nowMs;
    }

    materialized.push({
      nodeId: node.id,
      activationId: action.activationId,
      sessionId: sid,
      taskId: tid,
      targetUrl,
      chatMode: node.chatMode,
      actionType: action.type,
    });
  }

  return { state: coreState, materialized, reused, blocked };
}

export function projectHierarchyDeliveryEventsFromCore(
  graphRaw,
  runtime,
  coreState,
  { eventPrefix = 'core-hierarchy' } = {},
) {
  const graph = validateOrchestrationGraphV1(graphRaw);
  if (!isObject(runtime) || runtime.graphId !== graph.graphId || runtime.controlEpoch !== graph.controlEpoch) {
    throw new Error('Hierarchy runtime does not match graph');
  }
  if (!isObject(coreState?.sessionsById)) throw new Error('Invalid Core state');
  const events = [];

  for (const nodeId of graph.nodeOrder) {
    const nodeRuntime = runtime.nodesById?.[nodeId];
    const activationId = nodeRuntime?.currentActivationId;
    if (!activationId) continue;
    const ledger = nodeRuntime.activationLedger?.[activationId];
    if (!ledger || ledger.phase !== 'PREPARED' || ledger.generation !== nodeRuntime.generation) continue;

    const sid = hierarchyCoreSessionId(graph.graphId, nodeId);
    const tid = hierarchyCoreTaskId(graph.graphId, nodeId);
    const session = coreState.sessionsById[sid];
    const task = session?.tasksById?.[tid];
    const binding = session?.orchestrationHierarchy;
    if (!task || !binding) continue;
    if (binding.activationId !== activationId || binding.generation !== nodeRuntime.generation) continue;
    if (!(Number(task.lastVerifiedSendAt || 0) > 0) || !task.lastConversationUrl) continue;

    events.push({
      type: OrchestrationHierarchyEventType.NODE_EFFECT_CONFIRMED,
      eventId: `${eventPrefix}:${graph.graphId}:${nodeId}:${activationId}:${task.lastVerifiedSendAt}`,
      controlEpoch: runtime.controlEpoch,
      nodeId,
      generation: nodeRuntime.generation,
      activationId,
      effectRef: `core:${sid}:${tid}:${task.lastVerifiedSendAt}`,
      conversationUrl: task.lastConversationUrl,
    });
  }

  return events;
}


export function preparedHierarchyActions(graphRaw, runtimeRaw) {
  const graph = validateOrchestrationGraphV1(graphRaw);
  const runtime = validateOrchestrationHierarchyRuntimeV1(graph, runtimeRaw);
  const actions = [];
  for (const nodeId of graph.nodeOrder) {
    const node = graph.nodesById[nodeId];
    const nodeRuntime = runtime.nodesById[nodeId];
    const activationId = nodeRuntime.currentActivationId;
    if (!activationId) continue;
    const ledger = nodeRuntime.activationLedger[activationId];
    if (!ledger || ledger.phase !== 'PREPARED' || ledger.generation !== nodeRuntime.generation) continue;
    actions.push({
      type: ledger.purpose === OrchestrationActivationPurpose.RECONCILE
        ? OrchestrationHierarchyActionType.SEND_RECONCILIATION_PROMPT
        : OrchestrationHierarchyActionType.ACTIVATE_NODE,
      nodeId,
      activationId,
      generation: nodeRuntime.generation,
      round: ledger.round,
      purpose: ledger.purpose,
      chatMode: node.chatMode,
      promptProfileId: node.promptProfileId,
      authority: 'EXISTING_CORE_SESSION_TASK_PATH',
    });
  }
  return actions;
}


export function syncHierarchyScopeStatesIntoCore(coreState, graphRaw, runtimeRaw) {
  const graph = validateOrchestrationGraphV1(graphRaw);
  const runtime = validateOrchestrationHierarchyRuntimeV1(graph, runtimeRaw);
  if (!isObject(coreState?.sessionsById)) throw new Error('Invalid Core state');

  const transitions = [];
  for (const nodeId of graph.nodeOrder) {
    const sessionId = hierarchyCoreSessionId(graph.graphId, nodeId);
    const session = coreState.sessionsById[sessionId];
    const binding = session?.orchestrationHierarchy;
    if (!binding?.managed || binding.graphId !== graph.graphId || binding.nodeId !== nodeId) continue;

    const nodeRuntime = runtime.nodesById[nodeId];
    const nextScope = nodeRuntime.scopeState;
    const previousScope = binding.scopeState || 'RUNNING';
    binding.scopeState = nextScope;

    if (nextScope === 'STOPPED') {
      session.enabled = false;
      if (!isUnresolvedOperation(session)) session.runState = RunState.STOPPED;
    } else if (nextScope === 'PAUSED') {
      if (session.runState !== RunState.STOPPED) session.runState = RunState.PAUSED;
    } else if (
      nextScope === 'RUNNING'
      && previousScope === 'PAUSED'
      && session.enabled
      && session.runState === RunState.PAUSED
      && coreState.profile?.masterPaused !== true
    ) {
      session.runState = RunState.RUNNING;
    }

    if (previousScope !== nextScope) {
      transitions.push({
        nodeId,
        sessionId,
        from: previousScope,
        to: nextScope,
        runState: session.runState,
        enabled: session.enabled,
      });
    }
  }

  return { state: coreState, transitions };
}

export function hierarchyCompletionProbesFromCore(graphRaw, runtimeRaw, coreState) {
  const graph = validateOrchestrationGraphV1(graphRaw);
  const runtime = validateOrchestrationHierarchyRuntimeV1(graph, runtimeRaw);
  if (!isObject(coreState?.sessionsById)) throw new Error('Invalid Core state');
  const probes = [];

  for (const nodeId of graph.nodeOrder) {
    const nodeRuntime = runtime.nodesById[nodeId];
    const activationId = nodeRuntime.currentActivationId;
    if (!activationId) continue;
    const ledger = nodeRuntime.activationLedger[activationId];
    if (!ledger || ledger.phase !== 'EFFECT_CONFIRMED' || ledger.generation !== nodeRuntime.generation) continue;

    const sid = hierarchyCoreSessionId(graph.graphId, nodeId);
    const tid = hierarchyCoreTaskId(graph.graphId, nodeId);
    const session = coreState.sessionsById[sid];
    const task = session?.tasksById?.[tid];
    const binding = session?.orchestrationHierarchy;
    if (!task || !binding) continue;
    if (binding.activationId !== activationId || binding.generation !== nodeRuntime.generation) continue;
    if (!task.lastConversationUrl || task.lastAssistantBaselineKnown !== true) continue;

    probes.push({
      nodeId,
      activationId,
      generation: nodeRuntime.generation,
      conversationUrl: task.lastConversationUrl,
      taskId: tid,
      sessionId: sid,
      assistantBaselineCount: Math.max(0, Number(task.lastAssistantBaselineCount || 0)),
      assistantBaselineKnown: true,
    });
  }

  return probes;
}
