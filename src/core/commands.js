import { CoreCommand } from '../shared/protocol.js';
import { PromptMode, RunMode, RunState, TabStrategy, createSession, createTask, normalizeChatUrl } from './schema.js';
import { pauseSession, resumeSession, startSession, stopSession } from './state-machine.js';
import { appendLog } from './logger.js';

const promptModeFromUi = value => String(value).toLowerCase() === 'unique' ? PromptMode.UNIQUE : PromptMode.SHARED;
const runModeFromUi = value => String(value).toLowerCase() === 'one-pass' ? RunMode.ONE_PASS : RunMode.CONTINUOUS;
const tabStrategyFromUi = value => ({ worker: TabStrategy.ONE_WORKER_TAB_PER_SESSION, 'open-close': TabStrategy.OPEN_CLOSE_PER_TASK }[String(value).toLowerCase()] || TabStrategy.KEEP_TASK_TABS_OPEN);

function taskFromUi(raw) {
  const id = raw?.id || crypto.randomUUID();
  if (!raw?.url) return { id, enabled: raw?.enabled !== false, label: raw?.label || '', url: '', normalizedUrl: '', promptOverride: raw?.promptOverride || '', status:'IDLE', lastCheckedAt:0, lastVerifiedSendAt:0, lastVerifiedFingerprint:'', retryAfterAt:0, manualReviewReason:'' };
  return createTask({ id, enabled: raw.enabled !== false, label: raw.label || '', url: raw.url, promptOverride: raw.promptOverride || '' });
}

export function sessionFromUi(config, now = Date.now()) {
  const tasks = (config.tasks?.length ? config.tasks : [{ id: crypto.randomUUID(), url: '' }]).slice(0, 50).map(taskFromUi);
  return createSession({
    id: config.id || crypto.randomUUID(), name: config.name || 'New session', tasks,
    promptMode: promptModeFromUi(config.promptMode), sharedPrompt: config.sharedPrompt || '', runMode: runModeFromUi(config.runMode),
    minimumSendIntervalMs: Math.max(1, Number(config.minimumSendIntervalMinutes || 2)) * 60000,
    preSendDelayMs: Math.min(30000, Math.max(1000, Number(config.preSendDelaySeconds || 5) * 1000)),
    busyCheckDelayMs: Math.max(500, Number(config.busyCheckDelaySeconds || 2) * 1000),
    retryBackoffMs: Math.max(5000, Number(config.retryBackoffSeconds || 30) * 1000),
    tabStrategy: tabStrategyFromUi(config.tabStrategy), now
  });
}

export function validateRunnableSession(session) {
  if (!session.name.trim()) throw new Error('Session name is required');
  if (session.taskOrder.length < 1 || session.taskOrder.length > 50) throw new Error('Session requires 1-50 tasks');
  for (const id of session.taskOrder) {
    const task = session.tasksById[id];
    if (!task.enabled) continue;
    if (!task.url) throw new Error(`Task ${id} URL is required`);
    task.normalizedUrl = normalizeChatUrl(task.url);
    const prompt = session.promptMode === PromptMode.UNIQUE ? task.promptOverride : session.sharedPrompt;
    if (!prompt?.trim()) throw new Error(`Prompt is required for task ${id}`);
  }
  return session;
}

export function sessionToUi(session, state) {
  const tasks = session.taskOrder.map(id => session.tasksById[id]);
  return {
    ...structuredClone(session), version: state.revision,
    promptMode: session.promptMode === PromptMode.UNIQUE ? 'unique' : 'shared',
    runMode: session.runMode === RunMode.ONE_PASS ? 'one-pass' : 'continuous',
    tabStrategy: session.tabStrategy === TabStrategy.ONE_WORKER_TAB_PER_SESSION ? 'worker' : session.tabStrategy === TabStrategy.OPEN_CLOSE_PER_TASK ? 'open-close' : 'keep-open',
    tasks, minimumSendIntervalMinutes: session.minimumSendIntervalMs / 60000, preSendDelaySeconds: session.preSendDelayMs / 1000,
    busyCheckDelaySeconds: session.busyCheckDelayMs / 1000, retryBackoffSeconds: session.retryBackoffMs / 1000,
    actionAvailability: { start: session.runState === RunState.STOPPED, pause: session.runState === RunState.RUNNING || session.runState === RunState.RECOVERING, resume: session.runState === RunState.PAUSED, stop: session.runState !== RunState.STOPPED },
    status: { currentTaskUrl: tasks[session.currentTaskIndex]?.url || '', lastAction: '', lastSuccessfulSendAt: session.lastSuccessfulSendAt, nextAllowedSendAt: session.nextAllowedSendAt, enabledTaskCount: tasks.filter(t=>t.enabled).length, lastError: session.lastError },
    log: state.logs[session.id] || []
  };
}

export class CoreCommandDispatcher {
  constructor(repository, now = () => Date.now()) { this.repo = repository; this.now = now; }
  async execute(command, payload = {}) {
    if (command === CoreCommand.LIST_SESSIONS) {
      const state = await this.repo.load();
      return { sessions: state.sessionOrder.map(id => { const s=state.sessionsById[id]; return { id, name:s.name, runState:s.runState, enabledTaskCount:s.taskOrder.filter(t=>s.tasksById[t].enabled).length }; }) };
    }
    if (command === CoreCommand.GET_SNAPSHOT) { const state=await this.repo.load(); return { snapshot: structuredClone(state) }; }
    if (command === CoreCommand.GET_SESSION) { const state=await this.repo.load(); const s=state.sessionsById[payload.sessionId]; if(!s) throw new Error('Session not found'); return { session: sessionToUi(s,state) }; }
    if (command === CoreCommand.CREATE_SESSION) {
      const state = await this.repo.update(draft => { const s=sessionFromUi(payload.config || {}, this.now()); draft.sessionsById[s.id]=s; draft.sessionOrder.push(s.id); return draft; });
      const id=state.sessionOrder.at(-1); return { session: sessionToUi(state.sessionsById[id],state) };
    }
    if (command === CoreCommand.UPDATE_SESSION) {
      const state = await this.repo.update(draft => { const old=draft.sessionsById[payload.sessionId]; if(!old) throw new Error('Session not found'); const replacement=sessionFromUi({...payload.config,id:old.id},this.now()); replacement.runState=old.runState; replacement.currentTaskIndex=Math.min(old.currentTaskIndex,replacement.taskOrder.length-1); replacement.nextAllowedSendAt=old.nextAllowedSendAt; replacement.operation=old.operation; replacement.lastSuccessfulSendAt=old.lastSuccessfulSendAt; draft.sessionsById[old.id]=replacement; return draft; });
      return { session: sessionToUi(state.sessionsById[payload.sessionId],state) };
    }
    if (command === CoreCommand.DELETE_SESSION) { await this.repo.update(d=>{ delete d.sessionsById[payload.sessionId]; d.sessionOrder=d.sessionOrder.filter(id=>id!==payload.sessionId); delete d.logs[payload.sessionId]; return d;}); return {}; }
    if (command === CoreCommand.DUPLICATE_SESSION) {
      const state=await this.repo.update(d=>{ const old=d.sessionsById[payload.sessionId]; if(!old) throw new Error('Session not found'); const copy=structuredClone(old); copy.id=crypto.randomUUID(); copy.name=`${old.name} copy`; copy.runState=RunState.STOPPED; copy.operation=null; copy.nextAllowedSendAt=0; const nextTasks={}; copy.taskOrder=old.taskOrder.map(id=>{const nid=crypto.randomUUID(); nextTasks[nid]={...structuredClone(old.tasksById[id]),id:nid}; return nid;}); copy.tasksById=nextTasks; d.sessionsById[copy.id]=copy; d.sessionOrder.push(copy.id); return d;}); const id=state.sessionOrder.at(-1); return {session:sessionToUi(state.sessionsById[id],state)};
    }
    if ([CoreCommand.START_SESSION,CoreCommand.PAUSE_SESSION,CoreCommand.RESUME_SESSION,CoreCommand.STOP_SESSION].includes(command)) {
      const state=await this.repo.update(d=>{ const s=d.sessionsById[payload.sessionId]; if(!s) throw new Error('Session not found'); if(command===CoreCommand.START_SESSION){validateRunnableSession(s);startSession(s,this.now());appendLog(d,s.id,'Session started',{at:this.now()});} if(command===CoreCommand.PAUSE_SESSION){pauseSession(s,this.now());appendLog(d,s.id,'Session paused',{at:this.now()});} if(command===CoreCommand.RESUME_SESSION){validateRunnableSession(s);resumeSession(s,this.now());appendLog(d,s.id,'Session resumed',{at:this.now()});} if(command===CoreCommand.STOP_SESSION){stopSession(s,this.now());appendLog(d,s.id,'Session stopped',{at:this.now()});} return d;}); return {session:sessionToUi(state.sessionsById[payload.sessionId],state)};
    }
    if (command === CoreCommand.CLEAR_LOG) { const state=await this.repo.update(d=>{d.logs[payload.sessionId]=[];return d;}); return {session:sessionToUi(state.sessionsById[payload.sessionId],state)}; }
    if (command === CoreCommand.MASTER_PAUSE) { await this.repo.update(d=>{d.profile.masterPaused=true; for(const s of Object.values(d.sessionsById)) if(s.runState===RunState.RUNNING||s.runState===RunState.RECOVERING) pauseSession(s,this.now()); return d;}); return {}; }
    if (command === CoreCommand.MASTER_RESUME) { await this.repo.update(d=>{d.profile.masterPaused=false; return d;}); return {}; }
    throw new Error(`Unknown Core command: ${command}`);
  }
}
