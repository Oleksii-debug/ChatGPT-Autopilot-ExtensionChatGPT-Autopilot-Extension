import { getDispatchApplicability } from './remote-dispatch.js';
import { REMOTE_DISPATCH_CACHE_STORAGE_KEY, RemoteDispatchCacheRepository, RemoteDispatchConfigRepository, validateRemoteDispatchConfig } from './remote-dispatch-config.js';
import { fetchLatestGitHubRemoteDispatch } from './remote-dispatch-github.js';
import {
  REMOTE_DISPATCH_LEDGER_STORAGE_KEY,
  RemoteDispatchLedgerRepository,
  recordAcceptedRemoteDispatch,
  recordRemoteFetch,
  recordRemoteSessionBinding,
  setRemoteFallbackActive,
  setRemoteFallbackEligibility,
  clearRemoteFallbackAutoStart,
} from './remote-dispatch-ledger.js';
import { reconcileRemoteDispatchIntoState } from './remote-dispatch-import.js';
import { applyRemoteDispatchGovernance, applyRemoteFallbackSession, computeRemoteDispatchDeadline, revokeRemoteDispatchAuthority, syncVerifiedRemoteSendsIntoLedger } from './remote-dispatch-runtime.js';

export const REMOTE_DISPATCH_ALARM = 'autopilot-remote-dispatch-wake';

export class RemoteDispatchController {
  constructor({ coreRepository, chromeApi, fetchFn = globalThis.fetch, now = () => Date.now() }) {
    if (!coreRepository || !chromeApi) throw new Error('Remote Dispatch controller dependencies are required');
    this.coreRepository = coreRepository;
    this.chrome = chromeApi;
    this.fetchFn = fetchFn;
    this.now = now;
    this.configRepository = new RemoteDispatchConfigRepository(chromeApi);
    this.cacheRepository = new RemoteDispatchCacheRepository(chromeApi);
    this.pollInFlight = null;
  }

  ledgerRepository(projectId) { return new RemoteDispatchLedgerRepository(this.chrome, { projectId }); }

  async cachedDispatch(projectId) {
    try {
      const cache = await this.cacheRepository.load();
      if (!cache || cache.projectId !== projectId) return null;
      return cache;
    } catch {
      return null;
    }
  }

  async cachedApplicableDispatch(projectId, nowMs) {
    const cache = await this.cachedDispatch(projectId);
    if (!cache) return null;
    const applicability = getDispatchApplicability(cache.dispatch, { projectId, nowMs });
    return applicability.applicable ? cache : null;
  }

  async revokeAuthority(projectId, nowMs = this.now()) {
    let result = null;
    await this.coreRepository.update(draft => {
      result = revokeRemoteDispatchAuthority(draft, { projectId, nowMs });
      return result.state;
    });
    return result;
  }

  async updateConfig(nextRaw) {
    const nowMs = this.now();
    const current = await this.configRepository.load();
    const next = validateRemoteDispatchConfig(nextRaw);
    const identityChanged = current.projectId !== next.projectId || current.repository !== next.repository || current.issueNumber !== next.issueNumber;
    if (current.enabled && identityChanged) throw new Error('Вимкніть Remote Dispatch перед зміною project_id, repository або Issue.');
    if (current.enabled && !next.enabled) await this.revokeAuthority(current.projectId, nowMs);
    if (!current.enabled && identityChanged) {
      await this.chrome.storage.local.remove?.([REMOTE_DISPATCH_CACHE_STORAGE_KEY, REMOTE_DISPATCH_LEDGER_STORAGE_KEY]);
    }
    const saved = await this.configRepository.save(next);
    await this.reconcileAlarm({ config: saved, nowMs });
    return saved;
  }

  async getStatus() {
    const nowMs = this.now();
    const config = await this.configRepository.load();
    const cache = config.projectId ? await this.cachedDispatch(config.projectId) : null;
    let ledger = null;
    if (config.projectId) {
      try { ledger = await this.ledgerRepository(config.projectId).load(); } catch (_) {}
    }
    const state = await this.coreRepository.load();
    const remoteSessions = Object.values(state.sessionsById || {}).filter(session => session.remoteDispatch?.managed && (!config.projectId || session.remoteDispatch.projectId === config.projectId));
    const dispatch = cache?.dispatch || null;
    const applicability = dispatch && config.projectId ? getDispatchApplicability(dispatch, { projectId: config.projectId, nowMs }) : { applicable: false, reason: 'NO_CACHE' };
    return {
      config,
      feed: {
        applicable: applicability.applicable === true,
        reason: applicability.reason || '',
        dispatchId: dispatch?.dispatch_id || '',
        strategyRevision: dispatch?.strategy_revision || 0,
        generatedAt: dispatch?.generated_at || '',
        expiresAt: dispatch?.expires_at || '',
        cachedAt: cache?.cachedAt || 0,
        commentId: cache?.commentId || '',
      },
      ledger: ledger ? {
        lastFetchAt: ledger.lastFetchAt, lastFetchOkAt: ledger.lastFetchOkAt, lastFetchError: ledger.lastFetchError,
        currentDispatchId: ledger.currentDispatchId, currentStrategyRevision: ledger.currentStrategyRevision,
        fallbackActive: ledger.fallbackActive, acceptedCount: ledger.acceptedDispatches.length, rejectedCount: ledger.rejectedDispatches.length,
      } : null,
      runtime: {
        remoteSessionCount: remoteSessions.length,
        activeRemoteSessionCount: remoteSessions.filter(session => ['RUNNING','RECOVERING'].includes(session.runState)).length,
        pausedRemoteSessionCount: remoteSessions.filter(session => session.runState === 'PAUSED').length,
      },
    };
  }

  async testFeed(configRaw = null) {
    const nowMs = this.now();
    const raw = configRaw || await this.configRepository.load();
    const config = validateRemoteDispatchConfig({ ...raw, enabled: true });
    if (!config.projectId || !config.repository || !config.issueNumber) throw new Error('Заповніть project_id, repository та Issue number.');
    const fetched = await fetchLatestGitHubRemoteDispatch({
      fetchFn: this.fetchFn, repository: config.repository, issueNumber: config.issueNumber, projectId: config.projectId, sinceMs: 0, nowMs,
    });
    return {
      ok: true,
      selected: fetched.selected ? {
        commentId: fetched.selected.commentId, dispatchId: fetched.selected.dispatch.dispatch_id, strategyRevision: fetched.selected.dispatch.strategy_revision, expiresAt: fetched.selected.dispatch.expires_at,
      } : null,
      diagnostics: fetched.diagnostics || [],
    };
  }

  async reconcileAlarm({ config = null, dispatch = null, ledger = null, nowMs = this.now() } = {}) {
    config ||= await this.configRepository.load();
    if (!config.enabled) {
      await this.chrome.alarms.clear(REMOTE_DISPATCH_ALARM);
      return null;
    }
    let intervalSeconds = config.minimumPollIntervalSeconds;
    if (dispatch) intervalSeconds = Math.max(intervalSeconds, dispatch.policy.poll_interval_seconds);
    let wakeAt = nowMs + intervalSeconds * 1000;
    if (dispatch && ledger) {
      const deadline = computeRemoteDispatchDeadline(dispatch, ledger, nowMs);
      if (deadline) wakeAt = Math.min(wakeAt, deadline);
    }
    await this.chrome.alarms.create(REMOTE_DISPATCH_ALARM, { when: Math.max(nowMs + 1000, wakeAt) });
    return wakeAt;
  }

  async reconcileFallback(config, ledgerRepo, hasValidDispatch, nowMs) {
    let ledger = await ledgerRepo.load();
    const eligible = config.fallbackEnabled === true && Boolean(config.fallbackSessionId) && !hasValidDispatch;
    await ledgerRepo.update(draft => setRemoteFallbackEligibility(draft, eligible, { nowMs }), { nowMs });
    ledger = await ledgerRepo.load();
    const thresholdReached = eligible && ledger.fallbackEligibleSince > 0
      && nowMs - ledger.fallbackEligibleSince >= config.fallbackAfterSeconds * 1000;
    let fallbackResult = null;
    await this.coreRepository.update(draft => {
      fallbackResult = applyRemoteFallbackSession(draft, ledger, config, thresholdReached, { nowMs });
      return fallbackResult.state;
    });
    await ledgerRepo.update(draft => {
      setRemoteFallbackActive(draft, thresholdReached, {
        nowMs,
        sessionId: config.fallbackSessionId,
        autoStarted: fallbackResult?.autoStarted === true,
      });
      if (!thresholdReached && fallbackResult?.autoStarted !== true) clearRemoteFallbackAutoStart(draft, { nowMs });
      return draft;
    }, { nowMs });
    return { eligible, thresholdReached, ...fallbackResult };
  }

  async applyDispatch(dispatch, commentId, config, ledgerRepo, nowMs) {
    let reconcileResult = null;
    const ledger = await ledgerRepo.load();
    await this.coreRepository.update(draft => {
      reconcileResult = reconcileRemoteDispatchIntoState(draft, dispatch, { nowMs });
      const governed = applyRemoteDispatchGovernance(reconcileResult.state, dispatch, ledger, { nowMs, autoStart: config.autoStart });
      return governed.state;
    });
    await ledgerRepo.update(draft => {
      recordAcceptedRemoteDispatch(draft, {
        dispatchId: dispatch.dispatch_id,
        strategyRevision: dispatch.strategy_revision,
        expiresAtMs: Date.parse(dispatch.expires_at),
        commentId,
        supersedesDispatchIds: dispatch.supersedes_dispatch_ids,
      }, { nowMs });
      for (const item of reconcileResult?.applied || []) recordRemoteSessionBinding(draft, item.sessionKey, item.localSessionId, { nowMs });
      return draft;
    }, { nowMs });
    return reconcileResult;
  }

  poll() {
    if (this.pollInFlight) return this.pollInFlight;
    const cycle = (async () => {
      const nowMs = this.now();
      const config = await this.configRepository.load();
      if (!config.enabled) {
        await this.reconcileAlarm({ config, nowMs });
        return { kind: 'DISABLED', config };
      }
      const ledgerRepo = this.ledgerRepository(config.projectId);
      let ledger = await ledgerRepo.load();
      let fetched = null;
      let fetchError = null;
      if (!config.intakePaused) try {
        fetched = await fetchLatestGitHubRemoteDispatch({
          fetchFn: this.fetchFn,
          repository: config.repository,
          issueNumber: config.issueNumber,
          projectId: config.projectId,
          sinceMs: ledger.lastFetchOkAt,
          nowMs,
        });
        await ledgerRepo.update(draft => recordRemoteFetch(draft, {
          ok: true,
          commentId: fetched.selected?.commentId || draft.lastCommentId,
        }, { nowMs }), { nowMs });
        if (fetched.selected) {
          await this.cacheRepository.save({ projectId: config.projectId, commentId: fetched.selected.commentId, cachedAt: nowMs, dispatch: fetched.selected.dispatch });
        }
      } catch (error) {
        fetchError = error;
        await ledgerRepo.update(draft => recordRemoteFetch(draft, { ok: false, error: error?.code || error?.message || 'FETCH_FAILED' }, { nowMs }), { nowMs });
      }

      const cache = fetched?.selected
        ? { projectId: config.projectId, commentId: fetched.selected.commentId, cachedAt: nowMs, dispatch: fetched.selected.dispatch }
        : await this.cachedDispatch(config.projectId);
      const cacheApplicability = cache?.dispatch ? getDispatchApplicability(cache.dispatch, { projectId: config.projectId, nowMs }) : { applicable: false, reason: 'NO_CACHE' };
      let reconcile = null;
      // Even an expired cached dispatch is reconciled once more so top-level expiry
      // removes its authority to launch future work while unresolved sends remain protected.
      if (cache?.dispatch) reconcile = await this.applyDispatch(cache.dispatch, cache.commentId, config, ledgerRepo, nowMs);
      const fallback = await this.reconcileFallback(config, ledgerRepo, cacheApplicability.applicable, nowMs);
      ledger = await ledgerRepo.load();
      const wakeAt = await this.reconcileAlarm({ config, dispatch: cacheApplicability.applicable ? cache?.dispatch || null : null, ledger, nowMs });
      const kind = config.intakePaused
        ? (cacheApplicability.applicable ? 'INTAKE_PAUSED_APPLIED' : fallback.thresholdReached ? 'INTAKE_PAUSED_FALLBACK' : 'INTAKE_PAUSED')
        : fetchError ? (cacheApplicability.applicable ? 'CACHED_AFTER_FETCH_ERROR' : 'FETCH_ERROR')
          : cacheApplicability.applicable ? 'APPLIED' : cache ? 'STALE_DISPATCH' : 'NO_DISPATCH';
      return {
        kind,
        config,
        fetched,
        fetchError: fetchError ? { code: fetchError.code || 'FETCH_ERROR', message: fetchError.message || String(fetchError) } : null,
        dispatch: cache?.dispatch || null,
        reconcile,
        fallback,
        ledger,
        wakeAt,
      };
    })();
    this.pollInFlight = cycle.finally(() => { this.pollInFlight = null; });
    return this.pollInFlight;
  }

  async syncAfterCoreCycle() {
    const nowMs = this.now();
    const config = await this.configRepository.load();
    if (!config.enabled) return { kind: 'DISABLED' };
    const ledgerRepo = this.ledgerRepository(config.projectId);
    const state = await this.coreRepository.load();
    let counted = [];
    await ledgerRepo.update(draft => {
      counted = syncVerifiedRemoteSendsIntoLedger(state, draft, { nowMs });
      return draft;
    }, { nowMs });
    const cache = await this.cachedApplicableDispatch(config.projectId, nowMs);
    if (cache?.dispatch) {
      const ledger = await ledgerRepo.load();
      await this.coreRepository.update(draft => applyRemoteDispatchGovernance(draft, cache.dispatch, ledger, { nowMs, autoStart: config.autoStart }).state);
    }
    const fallback = await this.reconcileFallback(config, ledgerRepo, Boolean(cache?.dispatch), nowMs);
    const finalLedger = await ledgerRepo.load();
    await this.reconcileAlarm({ config, dispatch: cache?.dispatch || null, ledger: finalLedger, nowMs });
    return { kind: 'SYNCED', counted, fallback };
  }
}
