import { CoreCommand } from '../shared/protocol.js';
import { OperationPhase, PromptMode, RunMode, RunState, TabStrategy, createSession, createTask, normalizeChatUrl } from './schema.js';
import { pauseSession, resumeSession, startSession, stopSession } from './state-machine.js';
import { appendLog } from './logger.js';
import { EXECUTION_UNAVAILABLE_MESSAGE } from './recovery.js';

const promptModeFromUi = value => String(value).toLowerCase() === 'unique' ? PromptMode.UNIQUE : PromptMode.SHARED;
const runModeFromUi = value => String(value).toLowerCase() === 'one-pass' ? RunMode.ONE_PASS : RunMode.CONTINUOUS;
const tabStrategyFromUi = value => ({ worker: TabStrategy.ONE_WORKER_TAB_PER_SESSION, 'open-close': TabStrategy.OPEN_CLOSE_PER_TASK }[String(value).toLowerCase()] || TabStrategy.KEEP_TASK_TABS_OPEN);
const ACTIVE_STATES = new Set([RunState.RUNNING, RunState.RECOVERING]);
const STARTABLE_STATES = new Set([RunState.STOPPED, RunState.ERROR]);
const TERMINAL_OPERATION_PHASES = new Set([OperationPhase.NONE, OperationPhase.SENT_VERIFIED, OperationPhase.FAILED_SAFE]);
const URL_OWNERSHIP_ERROR = 'Another active or unresolved session already owns one of these ChatGPT conversations';

function hasUnresolvedOperation(session) {
  return Boolean(session.operation && !TERMINAL_OPERATION_PHASES.has(session.operation.phase));
}

function requireSession(state, sessionId) {
  const session = state.sessionsById[sessionId];
  if (!session) throw new Error('Session not found');
  return session;
}

function taskFromUi(raw) {
  const id = raw?.id || crypto.randomUUID();
  if (!raw?.url) return { id, enabled: raw?.enabled !== false, label: raw?.label || '', url: '', normalizedUrl: '', promptOverride: raw?.promptOverride || '', status:'IDLE', lastCheckedAt:0, lastVerifiedSendAt:0, lastVerifiedFingerprint:'', retryAfterAt:0, manualReviewReason:'' };
  return createTask({ id, enabled: raw.enabled !== false, label: raw.label || '', url: raw.url, promptOverride: raw.promptOverride || '' });
}

export function sessionFromUi(config, now = Date.now()) {
  const tasks = (config.tasks?.length ? config.tasks : [{ id: crypto.randomUUID(), url: '' }]).slice(0, 50).map(taskFromUi);
  const session = createSession({
    id: config.id || crypto.randomUUID(), name: config.name || 'New session', tasks,
    promptMode: promptModeFromUi(config.promptMode), sharedPrompt: config.sharedPrompt || '', runMode: runModeFromUi(config.runMode),
    minimumSendIntervalMs: Math.max(1, Number(config.minimumSendIntervalMinutes || 2)) * 60000,
    preSendDelayMs: Math.min(30000, Math.max(1000, Number(config.preSendDelaySeconds || 5) * 1000)),
    busyCheckDelayMs: Math.max(500, Number(config.busyCheckDelaySeconds || 2) * 1000),
    retryBackoffMs: Math.max(5000, Number(config.retryBackoffSeconds || 30) * 1000),
    tabStrategy: tabStrategyFromUi(config.tabStrategy), now
  });
  session.version = Math.max(1, Number(config.version) || 1);
  session.defaultUniquePrompt = config.defaultUniquePrompt || '';
  session.retryPolicy = config.retryPolicy === 'manual' ? 'manual' : 'safe';
  session.busyChatBehavior = 'skip-next';
  session.pausedByMaster = false;
  return session;
}

export function validateRunnableSession(session) {
  if (hasUnresolvedOperation(session)) throw new Error('Resolve the uncertain send operation before starting');
  if (!session.name.trim()) throw new Error('Session name is required');
  if (session.taskOrder.length < 1 || session.taskOrder.length > 50) throw new Error('Session requires 1-50 tasks');
  const normalizedUrls = [];
  let enabledCount = 0;
  for (const id of session.taskOrder) {
    const task = session.tasksById[id];
    if (!task.enabled) continue;
    enabledCount += 1;
    if (!task.url) throw new Error(`Task ${id} URL is required`);
    task.normalizedUrl = normalizeChatUrl(task.url);
    normalizedUrls.push(task.normalizedUrl);
    const prompt = session.promptMode === PromptMode.UNIQUE ? task.promptOverride : session.sharedPrompt;
    if (!prompt?.trim()) throw new Error(`Prompt is required for task ${id}`);
  }
  if (enabledCount === 0) throw new Error('Enable at least one task before starting');
  if (new Set(normalizedUrls).size !== normalizedUrls.length) throw new Error('The same ChatGPT conversation cannot appear twice in one active session');
  return session;
}

function hasReservedUrlCollision(state, session) {
  const targetUrls = new Set(session.taskOrder
    .map(id => session.tasksById[id])
    .filter(task => task.enabled)
    .map(task => task.normalizedUrl));
  if (hasUnresolvedOperation(session) && session.operation?.targetUrl) targetUrls.add(session.operation.targetUrl);
  for (const other of Object.values(state.sessionsById)) {
    if (other.id === session.id) continue;
    if (ACTIVE_STATES.has(other.runState)) {
      const collision = other.taskOrder
        .map(id => other.tasksById[id])
        .filter(task => task.enabled)
        .some(task => targetUrls.has(task.normalizedUrl));
      if (collision) return true;
    }
    if (hasUnresolvedOperation(other) && targetUrls.has(other.operation?.targetUrl || '')) {
      return true;
    }
  }
  return false;
}

function assertNoActiveUrlCollision(state, session) {
  if (hasReservedUrlCollision(state, session)) throw new Error(URL_OWNERSHIP_ERROR);
}

function cleanTabHintsForUpdatedSession(state, oldSession, replacement) {
  const workerHintKey = `__session_worker__:${oldSession.id}`;
  const workerMode = replacement.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION;
  for (const [key, hint] of Object.entries(state.tabHintsByTaskId || {})) {
    if (hint?.sessionId !== oldSession.id) continue;
    if (key === workerHintKey) {
      if (!workerMode) delete state.tabHintsByTaskId[key];
      continue;
    }
    if (workerMode) {
      delete state.tabHintsByTaskId[key];
      continue;
    }
    const nextTask = replacement.tasksById[key];
    if (!nextTask || hint.normalizedUrl !== nextTask.normalizedUrl) delete state.tabHintsByTaskId[key];
  }
}

export function sessionToUi(session, state) {
  const tasks = session.taskOrder.map(id => session.tasksById[id]);
  const currentTask = tasks[session.currentTaskIndex] || null;
  const log = state.logs[session.id] || [];
  const lastLog = log.at(-1);
  return {
    ...structuredClone(session), version: session.version || 0,
    promptMode: session.promptMode === PromptMode.UNIQUE ? 'unique' : 'shared',
    runMode: session.runMode === RunMode.ONE_PASS ? 'one-pass' : 'continuous',
    tabStrategy: session.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION ? 'worker' : session.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK ? 'open-close' : 'keep-open',
    tasks, minimumSendIntervalMinutes: session.minimumSendIntervalMs / 60000, preSendDelaySeconds: session.preSendDelayMs / 1000,
    busyCheckDelaySeconds: session.busyCheckDelayMs / 1000, retryBackoffSeconds: session.retryBackoffMs / 1000,
    actionAvailability: { start: STARTABLE_STATES.has(session.runState), pause: session.runState === RunState.RUNNING || session.runState === RunState.RECOVERING, resume: session.runState === RunState.PAUSED, stop: session.runState !== RunState.STOPPED },
    status: {
      currentTaskLabel: currentTask?.label || '',
      currentTaskUrl: currentTask?.url || '',
      currentTaskStatus: currentTask?.status || 'IDLE',
      currentTaskRetryAt: currentTask?.retryAfterAt || 0,
      currentTaskManualReviewReason: currentTask?.manualReviewReason || '',
      operationPhase: session.operation?.phase || OperationPhase.NONE,
      lastAction: lastLog?.message || '',
      lastActionAt: lastLog?.at || session.lastActionAt || 0,
      lastSuccessfulSendAt: session.lastSuccessfulSendAt,
      nextAllowedSendAt: session.nextAllowedSendAt,
      enabledTaskCount: tasks.filter(t=>t.enabled).length,
      lastError: session.lastError
    },
    log
  };
}

export class CoreCommandDispatcher {
  constructor(repository, now = () => Date.now(), { executionAvailable = true } = {}) {
    this.repo = repository;
    this.now = now;
    this.executionAvailable = executionAvailable;
  }
  async execute(command, payload = {}) {
    if (command === CoreCommand.LIST_SESSIONS) {
      const state = await this.repo.load();
      return { sessions: state.sessionOrder.map(id => { const s=state.sessionsById[id]; return { id, name:s.name, runState:s.runState, enabledTaskCount:s.taskOrder.filter(t=>s.tasksById[t].enabled).length }; }) };
    }
    if (command === CoreCommand.GET_SNAPSHOT) { const state=await this.repo.load(); return { snapshot: structuredClone(state) }; }
    if (command === CoreCommand.GET_SESSION) { const state=await this.repo.load(); const s=state.sessionsById[payload.sessionId]; if(!s) throw new Error('Session not found'); return { session: sessionToUi(s,state) }; }
    if (command === CoreCommand.CREATE_SESSION) {
      const state = await this.repo.update(draft => { const s=sessionFromUi(payload.config || {}, this.now()); if(draft.sessionsById[s.id]) throw new Error('Session id already exists'); draft.sessionsById[s.id]=s; draft.sessionOrder.push(s.id); appendLog(draft,s.id,'Session created',{at:this.now()}); return draft; });
      const id=state.sessionOrder.at(-1); return { session: sessionToUi(state.sessionsById[id],state) };
    }
    if (command === CoreCommand.UPDATE_SESSION) {
      const state = await this.repo.update(draft => {
        const old=requireSession(draft,payload.sessionId);
        if(ACTIVE_STATES.has(old.runState)||hasUnresolvedOperation(old)) throw new Error('Pause or stop the session and resolve uncertain work before editing');
        if(Number(payload.expectedVersion)!==Number(old.version||0)) throw new Error('This session changed in another view. Reload before saving');
        const replacement=sessionFromUi({...payload.config,id:old.id,version:(old.version||0)+1},this.now());
        replacement.runState=old.runState;
        const oldTaskId=old.taskOrder[old.currentTaskIndex];
        replacement.currentTaskIndex=Math.max(0,replacement.taskOrder.indexOf(oldTaskId));
        replacement.nextAllowedSendAt=old.nextAllowedSendAt;
        replacement.operation=old.operation;
        replacement.lastSuccessfulSendAt=old.lastSuccessfulSendAt;
        replacement.createdAt=old.createdAt;
        replacement.onePassCompletedTaskIds=(old.onePassCompletedTaskIds||[]).filter(id=>replacement.tasksById[id]);
        for(const id of replacement.taskOrder){const previous=old.tasksById[id];const current=replacement.tasksById[id];if(previous&&previous.normalizedUrl===current.normalizedUrl){for(const field of ['status','lastCheckedAt','lastVerifiedSendAt','lastVerifiedFingerprint','retryAfterAt','manualReviewReason']) current[field]=previous[field];}}
        cleanTabHintsForUpdatedSession(draft, old, replacement);
        draft.sessionsById[old.id]=replacement;
        appendLog(draft,old.id,'Session configuration saved',{at:this.now()});
        return draft;
      });
      return { session: sessionToUi(state.sessionsById[payload.sessionId],state) };
    }
    if (command === CoreCommand.DELETE_SESSION) { await this.repo.update(d=>{ const s=requireSession(d,payload.sessionId); if(s.runState!==RunState.STOPPED||hasUnresolvedOperation(s)) throw new Error('Stop the session and resolve uncertain work before deleting'); delete d.sessionsById[payload.sessionId]; d.sessionOrder=d.sessionOrder.filter(id=>id!==payload.sessionId); delete d.logs[payload.sessionId]; for(const [taskId,hint] of Object.entries(d.tabHintsByTaskId)) if(hint?.sessionId===payload.sessionId) delete d.tabHintsByTaskId[taskId]; return d;}); return {}; }
    if (command === CoreCommand.DUPLICATE_SESSION) {
      const state=await this.repo.update(d=>{
        const old=requireSession(d,payload.sessionId);
        if(hasUnresolvedOperation(old)) throw new Error('Resolve the uncertain send operation before duplicating');
        const copy=structuredClone(old);
        const now=this.now();
        copy.id=crypto.randomUUID();
        copy.version=1;
        copy.name=`${old.name} copy`;
        copy.runState=RunState.STOPPED;
        copy.currentTaskIndex=0;
        copy.operation=null;
        copy.nextAllowedSendAt=0;
        copy.lastActionAt=0;
        copy.lastSuccessfulSendAt=0;
        copy.lastError='';
        copy.onePassCompletedTaskIds=[];
        copy.createdAt=now;
        copy.updatedAt=now;
        copy.pausedByMaster=false;
        const nextTasks={};
        copy.taskOrder=old.taskOrder.map(id=>{
          const nid=crypto.randomUUID();
          nextTasks[nid]={...structuredClone(old.tasksById[id]),id:nid,status:'IDLE',lastCheckedAt:0,lastVerifiedSendAt:0,lastVerifiedFingerprint:'',retryAfterAt:0,manualReviewReason:''};
          return nid;
        });
        copy.tasksById=nextTasks;
        d.sessionsById[copy.id]=copy;
        d.sessionOrder.push(copy.id);
        appendLog(d,copy.id,'Session duplicated',{at:now});
        return d;
      });
      const id=state.sessionOrder.at(-1);
      return {session:sessionToUi(state.sessionsById[id],state)};
    }
    if ([CoreCommand.START_SESSION,CoreCommand.PAUSE_SESSION,CoreCommand.RESUME_SESSION,CoreCommand.STOP_SESSION].includes(command)) {
      const state=await this.repo.update(d=>{ const s=requireSession(d,payload.sessionId); if(command===CoreCommand.START_SESSION){if(!this.executionAvailable) throw new Error(EXECUTION_UNAVAILABLE_MESSAGE);if(d.profile.masterPaused) throw new Error('Resume the extension before starting a session');if(!STARTABLE_STATES.has(s.runState)) throw new Error('Session is already active');validateRunnableSession(s);assertNoActiveUrlCollision(d,s);if(s.runMode===RunMode.ONE_PASS)s.onePassCompletedTaskIds=[];startSession(s,this.now());s.pausedByMaster=false;appendLog(d,s.id,'Session started',{at:this.now()});} if(command===CoreCommand.PAUSE_SESSION){if(!ACTIVE_STATES.has(s.runState)) throw new Error('Only an active session can be paused');pauseSession(s,this.now());appendLog(d,s.id,'Session paused',{at:this.now()});} if(command===CoreCommand.RESUME_SESSION){if(!this.executionAvailable) throw new Error(EXECUTION_UNAVAILABLE_MESSAGE);if(d.profile.masterPaused) throw new Error('Resume the extension before resuming a session');if(s.runState!==RunState.PAUSED) throw new Error('Only a paused session can be resumed');const unresolved=hasUnresolvedOperation(s);if(unresolved&&s.operation?.phase===OperationPhase.MANUAL_REVIEW)throw new Error('Resolve manual review before resuming');if(!unresolved)validateRunnableSession(s);assertNoActiveUrlCollision(d,s);resumeSession(s,this.now());if(unresolved)s.runState=RunState.RECOVERING;s.pausedByMaster=false;appendLog(d,s.id,unresolved?'Session resumed into recovery':'Session resumed',{at:this.now()});} if(command===CoreCommand.STOP_SESSION){stopSession(s,this.now());appendLog(d,s.id,hasUnresolvedOperation(s)?'Session stopped; unresolved operation preserved':'Session stopped',{at:this.now()});} return d;}); return {session:sessionToUi(state.sessionsById[payload.sessionId],state)};
    }
    if (command === CoreCommand.CLEAR_LOG) { const state=await this.repo.update(d=>{requireSession(d,payload.sessionId);d.logs[payload.sessionId]=[];return d;}); return {session:sessionToUi(state.sessionsById[payload.sessionId],state)}; }
    if (command === CoreCommand.MASTER_PAUSE) { await this.repo.update(d=>{d.profile.masterPaused=true; for(const s of Object.values(d.sessionsById)) if(ACTIVE_STATES.has(s.runState)){pauseSession(s,this.now());s.pausedByMaster=true;appendLog(d,s.id,'Session paused by master pause',{at:this.now()});} return d;}); return {masterPaused:true}; }
    if (command === CoreCommand.MASTER_RESUME) { await this.repo.update(d=>{d.profile.masterPaused=false; for(const s of Object.values(d.sessionsById)) if(s.runState===RunState.PAUSED&&s.pausedByMaster){if(this.executionAvailable){const unresolved=hasUnresolvedOperation(s);s.pausedByMaster=false;s.lastActionAt=this.now();if(unresolved&&s.operation?.phase===OperationPhase.MANUAL_REVIEW){appendLog(d,s.id,'Session remains paused for manual review after master resume',{at:this.now()});}else if(hasReservedUrlCollision(d,s)){s.lastError=URL_OWNERSHIP_ERROR;appendLog(d,s.id,'Session remains paused because another active or unresolved session owns a ChatGPT conversation',{at:this.now()});}else{s.runState=unresolved?RunState.RECOVERING:RunState.RUNNING;appendLog(d,s.id,'Session resumed after master pause',{at:this.now()});}}else{s.lastError=EXECUTION_UNAVAILABLE_MESSAGE;appendLog(d,s.id,'Session remains paused because automatic execution is unavailable',{at:this.now()});}} return d;}); return {masterPaused:false}; }
    throw new Error(`Unknown Core command: ${command}`);
  }
}
