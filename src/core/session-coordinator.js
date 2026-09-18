import { AutomaticSessionExecutor } from './automatic-executor.js';
import { ModuleWorkspaceRepository } from './module-repository.js';
import {
  ExecutionModuleId,
  createModuleSessionView,
  ensureSessionModuleState,
  listExecutionModuleIds,
  unresolvedOperationModuleIds,
} from './module-workspaces.js';
import { selectNextTask } from './scheduler.js';

const ACTIVE_STATES = new Set(['RUNNING', 'RECOVERING']);

function requireSession(state, sessionId) {
  const session = state.sessionsById?.[sessionId];
  if (!session) throw new Error('Session not found');
  return session;
}

function decisionRank(decision) {
  if (decision?.kind === 'TASK') return 4;
  if (decision?.kind === 'COMPLETE') return 3;
  if (decision?.kind === 'COOLDOWN' || decision?.kind === 'WAIT') return 2;
  return 0;
}

function chooseAlternate(entries, lastModuleId) {
  if (entries.length <= 1) return entries[0] || null;
  return entries.find(entry => entry.moduleId !== lastModuleId) || entries[0];
}

export class SessionCoordinatorExecutor {
  constructor(repository, chromeApi, transport, options = {}) {
    this.repo = repository;
    this.now = options.now || (() => Date.now());
    this.executors = {
      [ExecutionModuleId.STANDARD_SENDS]: new AutomaticSessionExecutor(
        new ModuleWorkspaceRepository(repository, ExecutionModuleId.STANDARD_SENDS),
        chromeApi,
        transport,
        options,
      ),
      [ExecutionModuleId.BATCH_CHAT]: new AutomaticSessionExecutor(
        new ModuleWorkspaceRepository(repository, ExecutionModuleId.BATCH_CHAT),
        chromeApi,
        transport,
        options,
      ),
    };
  }

  async markSelected(sessionId, moduleId) {
    await this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      ensureSessionModuleState(session);
      session.moduleCoordinator.lastModuleId = moduleId;
      return draft;
    });
  }

  async stopRootIfAllModulesFinished(sessionId) {
    await this.repo.update(draft => {
      const session = requireSession(draft, sessionId);
      if (!ACTIVE_STATES.has(session.runState)) return draft;
      const moduleIds = listExecutionModuleIds(session, { includeDisabledWithOperation: true });
      const anyActive = moduleIds.some(moduleId => {
        const view = createModuleSessionView(session, moduleId);
        return view && ACTIVE_STATES.has(view.runState) && view.moduleCompleted !== true;
      });
      if (!anyActive) session.runState = 'STOPPED';
      return draft;
    });
  }

  async runSessionOnce(sessionId) {
    const state = await this.repo.load();
    const session = requireSession(state, sessionId);
    ensureSessionModuleState(session);
    if (!ACTIVE_STATES.has(session.runState)) return { kind: 'IDLE' };

    const unresolved = unresolvedOperationModuleIds(session);
    let selected = null;

    if (unresolved.length) {
      const candidates = unresolved.map(moduleId => {
        const view = createModuleSessionView(session, moduleId);
        return { moduleId, createdAt: Number(view?.operation?.createdAt || 0) };
      }).sort((a, b) => a.createdAt - b.createdAt || a.moduleId.localeCompare(b.moduleId));
      selected = candidates[0];
    } else {
      const moduleIds = listExecutionModuleIds(session);
      const decisions = moduleIds.map(moduleId => {
        const view = createModuleSessionView(session, moduleId);
        return { moduleId, decision: view ? selectNextTask(view, this.now()) : { kind: 'IDLE' } };
      });
      const maxRank = Math.max(0, ...decisions.map(entry => decisionRank(entry.decision)));
      if (maxRank >= 3) {
        const highest = decisions.filter(entry => decisionRank(entry.decision) === maxRank);
        selected = chooseAlternate(highest, session.moduleCoordinator.lastModuleId);
      } else if (maxRank === 2) {
        const waiting = decisions.filter(entry => decisionRank(entry.decision) === 2);
        const wakeAt = Math.min(...waiting.map(entry => Number(entry.decision.wakeAt || this.now())));
        const kind = waiting.some(entry => entry.decision.kind === 'COOLDOWN') ? 'COOLDOWN' : 'WAIT';
        return { kind, wakeAt };
      }
    }

    if (!selected) {
      await this.stopRootIfAllModulesFinished(sessionId);
      return { kind: 'IDLE' };
    }

    await this.markSelected(sessionId, selected.moduleId);
    try {
      const result = await this.executors[selected.moduleId].runSessionOnce(sessionId);
      await this.stopRootIfAllModulesFinished(sessionId);
      return { ...result, moduleId: selected.moduleId };
    } catch (error) {
      if (!error.autopilotModuleId) error.autopilotModuleId = selected.moduleId;
      throw error;
    }
  }
}
