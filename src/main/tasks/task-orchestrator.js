'use strict';

const {
  RUN_STATES,
  RUN_HEALTH,
  EXECUTOR_STATES,
  isTerminalState,
} = require('./task-protocol');
const { DEFAULTS: GENERAL_PREFERENCE_DEFAULTS } = require('../app/general-preferences');

const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  claude: GENERAL_PREFERENCE_DEFAULTS.maxParallelTasks,
  image: 1,
  command: 1,
});

const DEFAULT_AGING_INTERVAL_MS = 60 * 1000;
const DEFAULT_AGING_STEP = 1;
const DEFAULT_SILENT_AFTER_MS = 2 * 60 * 1000;
const DEFAULT_STALLED_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 15 * 1000;

const ACTIVE_STATES = new Set([
  RUN_STATES.STARTING,
  RUN_STATES.RUNNING,
  RUN_STATES.WAITING_USER,
  RUN_STATES.STOPPING,
]);

const HEALTH_WATCH_STATES = new Set([
  RUN_STATES.STARTING,
  RUN_STATES.RUNNING,
  RUN_STATES.STOPPING,
]);

class TaskOrchestratorError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TaskOrchestratorError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function finiteNonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function timestampMs(value) {
  if (value == null || value === '') return null;
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function inferResource(input = {}) {
  const explicit = input.resource
    || (input.metadata && input.metadata.orchestration
      && input.metadata.orchestration.resource)
    || (input.execution && input.execution.resource);
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const kind = String(input.kind || '').toLowerCase();
  if (kind === 'image' || kind.endsWith('_image')) return 'image';
  if (kind === 'command' || kind.endsWith('_command')) return 'command';
  return 'claude';
}

function conversationKeyOf(input = {}) {
  const value = input.conversationKey
    || (input.source && input.source.conversationId)
    || (input.metadata && input.metadata.conversationId)
    || (input.metadata && input.metadata.orchestration
      && input.metadata.orchestration.conversationKey);
  return value == null || value === '' ? null : String(value);
}

// One schedule may have at most one queued/running occurrence. Callers that need a more granular
// policy can pass scheduleDedupeKey explicitly (for example "daily-summary@2026-08-25T09:00Z").
function scheduleKeyOf(input = {}) {
  const value = input.scheduleDedupeKey
    || (input.metadata && input.metadata.orchestration
      && input.metadata.orchestration.scheduleKey)
    || (input.source && input.source.scheduleId)
    || (input.metadata && input.metadata.scheduleId);
  return value == null || value === '' ? null : String(value);
}

function queuedAtMs(run) {
  return timestampMs(run && (run.queuedAt || run.createdAt)) || 0;
}

function effectivePriority(run, nowMs, agingIntervalMs, agingStep) {
  const base = Number.isFinite(run && run.priority) ? Number(run.priority) : 50;
  if (agingIntervalMs <= 0 || agingStep <= 0) return base;
  const ageMs = Math.max(0, nowMs - queuedAtMs(run));
  return base + Math.floor(ageMs / agingIntervalMs) * agingStep;
}

function compareQueuedRuns(left, right, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const agingIntervalMs = finiteNonNegative(
    options.agingIntervalMs,
    DEFAULT_AGING_INTERVAL_MS,
  );
  const agingStep = finiteNonNegative(options.agingStep, DEFAULT_AGING_STEP);
  const byPriority = effectivePriority(right, nowMs, agingIntervalMs, agingStep)
    - effectivePriority(left, nowMs, agingIntervalMs, agingStep);
  if (byPriority !== 0) return byPriority;
  const byQueuedAt = queuedAtMs(left) - queuedAtMs(right);
  if (byQueuedAt !== 0) return byQueuedAt;
  return String(left.runId || '').localeCompare(String(right.runId || ''));
}

function normalizeExecutorError(error) {
  const source = error instanceof Error ? error : new Error(String(error || 'Executor failed'));
  return {
    code: typeof source.code === 'string' && source.code ? source.code : 'EXECUTOR_FAILED',
    message: source.message || 'Executor failed',
  };
}

class TaskOrchestrator {
  constructor(options = {}) {
    if (!options.ledger
      || typeof options.ledger.create !== 'function'
      || typeof options.ledger.get !== 'function'
      || typeof options.ledger.list !== 'function'
      || typeof options.ledger.update !== 'function'
      || typeof options.ledger.terminal !== 'function'
      || typeof options.ledger.recover !== 'function') {
      throw new TaskOrchestratorError(
        'INVALID_ORCHESTRATOR_OPTIONS',
        'TaskOrchestrator requires a TaskLedger-compatible ledger',
      );
    }

    this.ledger = options.ledger;
    this.logger = options.logger || console;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.poolLimits = { ...DEFAULT_RESOURCE_LIMITS };
    if (isPlainObject(options.poolLimits)) {
      for (const [resource, limit] of Object.entries(options.poolLimits)) {
        if (!resource || !Number.isSafeInteger(limit) || limit < 0) {
          throw new TaskOrchestratorError(
            'INVALID_RESOURCE_LIMIT',
            `Invalid concurrency limit for ${String(resource)}`,
          );
        }
        this.poolLimits[resource] = limit;
      }
    }

    this.agingIntervalMs = finiteNonNegative(
      options.agingIntervalMs,
      DEFAULT_AGING_INTERVAL_MS,
    );
    this.agingStep = finiteNonNegative(options.agingStep, DEFAULT_AGING_STEP);
    this.silentAfterMs = finiteNonNegative(
      options.silentAfterMs,
      DEFAULT_SILENT_AFTER_MS,
    );
    this.stalledAfterMs = finiteNonNegative(
      options.stalledAfterMs,
      DEFAULT_STALLED_AFTER_MS,
    );
    if (this.stalledAfterMs < this.silentAfterMs) {
      throw new TaskOrchestratorError(
        'INVALID_HEALTH_THRESHOLDS',
        'stalledAfterMs must be greater than or equal to silentAfterMs',
      );
    }
    this.healthCheckIntervalMs = finiteNonNegative(
      options.healthCheckIntervalMs,
      DEFAULT_HEALTH_CHECK_INTERVAL_MS,
    );
    this._setInterval = typeof options.setInterval === 'function'
      ? options.setInterval
      : setInterval;
    this._clearInterval = typeof options.clearInterval === 'function'
      ? options.clearInterval
      : clearInterval;

    this.executors = new Map();
    this.active = new Map();
    this.externalWaiting = new Map();
    this.externalActive = new Map();
    this.executorHandles = new Map();
    this.cancelRequests = new Map();
    this.started = false;
    this.recovered = false;
    this.pumping = false;
    this.pumpAgain = false;
    this.healthTimer = null;

    if (isPlainObject(options.executors)) {
      for (const [resource, executor] of Object.entries(options.executors)) {
        this.registerExecutor(resource, executor);
      }
    }
  }

  _warn(message, error) {
    try {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn(`[task-orchestrator] ${message}${error ? `: ${error.message}` : ''}`);
      }
    } catch (_) {}
  }

  _nowMs(explicit) {
    const source = explicit === undefined ? this.now() : explicit;
    const value = timestampMs(source);
    if (value == null) {
      throw new TaskOrchestratorError('INVALID_TIMESTAMP', `Invalid timestamp: ${String(source)}`);
    }
    return value;
  }

  _iso(explicit) {
    return new Date(this._nowMs(explicit)).toISOString();
  }

  _orchestrationMetadata(input, values = {}) {
    const metadata = isPlainObject(input && input.metadata) ? jsonClone(input.metadata) : {};
    const prior = isPlainObject(metadata.orchestration) ? metadata.orchestration : {};
    metadata.orchestration = {
      ...prior,
      ...values,
    };
    return metadata;
  }

  _resourceOf(run) {
    return inferResource(run);
  }

  _conversationKeyOf(run) {
    return conversationKeyOf(run);
  }

  _scheduleKeyOf(run) {
    return scheduleKeyOf(run);
  }

  // Zero means unlimited; keep it finite in settings, task snapshots and IPC.
  setPoolLimits(patch = {}) {
    if (!isPlainObject(patch)) throw new TaskOrchestratorError('INVALID_RESOURCE_LIMIT', 'Resource limits must be an object');
    for (const [resource, limit] of Object.entries(patch)) {
      if (!resource || !Number.isSafeInteger(limit) || limit < 0) {
        throw new TaskOrchestratorError('INVALID_RESOURCE_LIMIT', `Invalid concurrency limit for ${String(resource)}`);
      }
    }
    Object.assign(this.poolLimits, patch);
    // Reconsider both registered executors and the existing execution leases.
    // Lower limits only delay future starts; active tasks retain their slots.
    this.dispatch();
    return { ...this.poolLimits };
  }

  registerExecutor(resource, executor) {
    if (typeof resource !== 'string' || !resource.trim() || typeof executor !== 'function') {
      throw new TaskOrchestratorError(
        'INVALID_EXECUTOR',
        'registerExecutor requires a resource name and callback',
      );
    }
    const key = resource.trim();
    this.executors.set(key, executor);
    if (!(key in this.poolLimits)) this.poolLimits[key] = 1;
    if (this.started) this.dispatch();
    return () => {
      if (this.executors.get(key) === executor) this.executors.delete(key);
    };
  }

  registerExecutorHandle(runId, handle) {
    const run = this.ledger.get(runId);
    if (!run) {
      throw new TaskOrchestratorError('RUN_NOT_FOUND', `Run not found: ${String(runId)}`);
    }
    if (isTerminalState(run.state)) {
      throw new TaskOrchestratorError('RUN_TERMINAL', `Run is already terminal: ${runId}`);
    }
    if (handle == null || (typeof handle !== 'function' && typeof handle !== 'object')) {
      throw new TaskOrchestratorError('INVALID_EXECUTOR_HANDLE', 'Executor handle is not cancellable');
    }
    this.executorHandles.set(runId, handle);
    const cancellation = this.cancelRequests.get(runId);
    if (cancellation) {
      try {
        const pending = this._cancelHandle(handle, cancellation.reason);
        if (pending && typeof pending.catch === 'function') {
          pending.catch((error) => this._warn(
            `late executor cancellation rejected for ${runId}`,
            error,
          ));
        }
      } catch (error) {
        this._warn(`late executor cancellation failed for ${runId}`, error);
      }
    }
    return () => {
      if (this.executorHandles.get(runId) === handle) this.executorHandles.delete(runId);
    };
  }

  // 让现有执行链租用统一资源池。任务记录由调用方预先创建，orchestrator 只负责公平排队、
  // 会话互斥、资源计数和取消信号；终态仍由原执行链按真实结果唯一写入。
  acquireExisting(runId, options = {}) {
    const key = String(runId || '');
    const prior = this.externalWaiting.get(key) || this.externalActive.get(key);
    if (prior) {
      return Promise.reject(new TaskOrchestratorError(
        'RUN_ALREADY_ACQUIRING',
        `Run already owns or is waiting for a resource lease: ${key}`,
      ));
    }
    const run = this.ledger.get(key);
    if (!run) return Promise.reject(new TaskOrchestratorError('RUN_NOT_FOUND', `Run not found: ${key}`));
    if (isTerminalState(run.state)) return Promise.resolve(null);
    if (run.state !== RUN_STATES.QUEUED || run.startedAt) {
      return Promise.reject(new TaskOrchestratorError('RUN_NOT_QUEUED', `Run is not waiting for a resource: ${key}`));
    }
    const resource = String(options.resource || inferResource(run));
    const conversationKey = options.conversationKey == null
      ? conversationKeyOf(run) : String(options.conversationKey || '') || null;
    let resolveLease;
    const promise = new Promise((resolve) => { resolveLease = resolve; });
    const entry = {
      run, resource, conversationKey, resolveLease, promise,
      controller: new AbortController(), settled: false,
    };
    this.externalWaiting.set(key, entry);
    if (this.started) this._pumpExternal();
    return promise;
  }

  _pumpExternal() {
    if (!this.started || !this.externalWaiting.size) return [];
    const occupancy = this._occupancy();
    const nowMs = this._nowMs();
    const candidates = [...this.externalWaiting.values()].sort((left, right) => compareQueuedRuns(
      left.run,
      right.run,
      { nowMs, agingIntervalMs: this.agingIntervalMs, agingStep: this.agingStep },
    ));
    const started = [];
    for (const entry of candidates) {
      const runId = entry.run.runId;
      if (!this.externalWaiting.has(runId)) continue;
      const limit = Number.isSafeInteger(this.poolLimits[entry.resource])
        ? this.poolLimits[entry.resource] : 1;
      if (limit !== 0 && (occupancy.resources.get(entry.resource) || 0) >= limit) continue;
      if (entry.conversationKey && occupancy.conversations.has(entry.conversationKey)) continue;
      let run = this.ledger.get(runId);
      if (!run || run.state !== RUN_STATES.QUEUED || run.startedAt) {
        this.externalWaiting.delete(runId);
        entry.settled = true;
        entry.resolveLease(null);
        continue;
      }
      run = this.ledger.update(runId, {
        state: RUN_STATES.STARTING,
        phase: 'preparing',
        health: RUN_HEALTH.OK,
        executorState: EXECUTOR_STATES.ACTIVE,
        progress: { label: '正在准备' },
        metadata: this._orchestrationMetadata(run, {
          resource: entry.resource,
          conversationKey: entry.conversationKey,
          lastActivityAt: this._iso(),
        }),
      });
      entry.run = run;
      this.externalWaiting.delete(runId);
      this.externalActive.set(runId, entry);
      occupancy.resources.set(entry.resource, (occupancy.resources.get(entry.resource) || 0) + 1);
      if (entry.conversationKey) occupancy.conversations.add(entry.conversationKey);
      const release = () => {
        if (entry.settled) return false;
        entry.settled = true;
        this.externalActive.delete(runId);
        this.executorHandles.delete(runId);
        this.cancelRequests.delete(runId);
        if (this.started) {
          this.dispatch();
          this._pumpExternal();
        }
        return true;
      };
      entry.release = release;
      entry.resolveLease(Object.freeze({ runId, resource: entry.resource, signal: entry.controller.signal, release }));
      started.push(run);
    }
    return started;
  }

  enqueue(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TaskOrchestratorError('INVALID_RUN', 'enqueue input must be an object');
    }
    const resource = inferResource(input);
    const conversationKey = conversationKeyOf(input);
    const scheduleKey = scheduleKeyOf(input);

    if (scheduleKey) {
      const duplicate = this.ledger.list({ terminal: false }).find((run) => (
        this._scheduleKeyOf(run) === scheduleKey
      ));
      if (duplicate) {
        return {
          run: duplicate,
          enqueued: false,
          duplicateOf: duplicate.runId,
        };
      }
    }

    const at = this._iso(input.createdAt);
    const supplied = jsonClone(input);
    delete supplied.resource;
    delete supplied.conversationKey;
    delete supplied.scheduleDedupeKey;
    delete supplied.startedAt;
    delete supplied.endedAt;
    delete supplied.updatedAt;
    delete supplied.lastEventAt;
    delete supplied.state;
    delete supplied.health;
    delete supplied.executorState;
    const run = this.ledger.create({
      ...supplied,
      state: RUN_STATES.QUEUED,
      phase: input.phase || RUN_STATES.QUEUED,
      health: RUN_HEALTH.OK,
      executorState: EXECUTOR_STATES.IDLE,
      createdAt: at,
      queuedAt: at,
      metadata: this._orchestrationMetadata(input, {
        resource,
        conversationKey,
        scheduleKey,
        lastActivityAt: at,
        lastHealthCheckAt: null,
      }),
    });
    if (this.started) this.dispatch();
    return { run, enqueued: true, duplicateOf: null };
  }

  start(options = {}) {
    if (this.started) {
      this.dispatch();
      return { recovery: null, alreadyStarted: true };
    }
    const recover = options.recover !== false;
    let recovery = null;
    if (recover) {
      recovery = this.ledger.recover({
        reason: options.reason || 'Relay restarted before the task reached a terminal state',
        at: this._iso(options.at),
      });
      this.recovered = true;
    }
    this.started = true;
    if (this.healthCheckIntervalMs > 0) {
      this.healthTimer = this._setInterval(() => {
        try { this.tickHealth(); }
        catch (error) { this._warn('health tick failed', error); }
      }, this.healthCheckIntervalMs);
      if (this.healthTimer && typeof this.healthTimer.unref === 'function') {
        this.healthTimer.unref();
      }
    }
    this.dispatch();
    this._pumpExternal();
    return { recovery, alreadyStarted: false };
  }

  shutdown() {
    this.started = false;
    if (this.healthTimer) {
      this._clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    for (const entry of this.externalWaiting.values()) {
      if (!entry.settled) { entry.settled = true; entry.resolveLease(null); }
    }
    this.externalWaiting.clear();
    for (const entry of this.externalActive.values()) {
      try { entry.controller.abort('orchestrator shutdown'); } catch (_) {}
    }
  }

  _externalActiveRuns() {
    return this.ledger.list({ terminal: false }).filter((run) => (
      ACTIVE_STATES.has(run.state) && !this.active.has(run.runId) && !this.externalActive.has(run.runId)
    ));
  }

  _occupancy() {
    const resources = new Map();
    const conversations = new Set();
    const add = (run, resourceOverride = null) => {
      const resource = resourceOverride || this._resourceOf(run);
      resources.set(resource, (resources.get(resource) || 0) + 1);
      const conversationKey = this._conversationKeyOf(run);
      if (conversationKey) conversations.add(conversationKey);
    };
    for (const entry of this.active.values()) add(entry.run, entry.resource);
    for (const entry of this.externalActive.values()) add(entry.run, entry.resource);
    for (const run of this._externalActiveRuns()) add(run);
    return { resources, conversations };
  }

  _queuedCandidates(nowMs) {
    return this.ledger.list({ state: RUN_STATES.QUEUED })
      .filter((run) => !run.startedAt && this.executors.has(this._resourceOf(run)))
      .sort((left, right) => compareQueuedRuns(left, right, {
        nowMs,
        agingIntervalMs: this.agingIntervalMs,
        agingStep: this.agingStep,
      }));
  }

  dispatch() {
    if (!this.started) return [];
    if (this.pumping) {
      this.pumpAgain = true;
      return [];
    }
    this.pumping = true;
    const dispatched = [];
    try {
      do {
        this.pumpAgain = false;
        const nowMs = this._nowMs();
        const occupancy = this._occupancy();
        const candidates = this._queuedCandidates(nowMs);
        let madeProgress = false;
        for (const run of candidates) {
          if (this.active.has(run.runId)) continue;
          const resource = this._resourceOf(run);
          const limit = Number.isSafeInteger(this.poolLimits[resource])
            ? this.poolLimits[resource]
            : 1;
          if (limit !== 0 && (occupancy.resources.get(resource) || 0) >= limit) continue;
          const conversationKey = this._conversationKeyOf(run);
          if (conversationKey && occupancy.conversations.has(conversationKey)) continue;
          const started = this._dispatchRun(run, resource, nowMs);
          if (!started) continue;
          dispatched.push(started);
          occupancy.resources.set(resource, (occupancy.resources.get(resource) || 0) + 1);
          if (conversationKey) occupancy.conversations.add(conversationKey);
          madeProgress = true;
        }
        if (!madeProgress) break;
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
    this._pumpExternal();
    return dispatched;
  }

  _dispatchRun(queuedRun, resource, nowMs) {
    const executor = this.executors.get(resource);
    if (!executor) return null;
    let run = this.ledger.get(queuedRun.runId);
    if (!run || run.state !== RUN_STATES.QUEUED || run.startedAt) return null;
    const at = new Date(nowMs).toISOString();
    run = this.ledger.update(run.runId, {
      state: RUN_STATES.STARTING,
      phase: RUN_STATES.STARTING,
      health: RUN_HEALTH.OK,
      executorState: EXECUTOR_STATES.ACTIVE,
      progress: { label: '正在启动' },
      metadata: this._orchestrationMetadata(run, {
        resource,
        lastActivityAt: at,
        lastHealthCheckAt: null,
      }),
    }, { at });
    run = this.ledger.update(run.runId, {
      state: RUN_STATES.RUNNING,
      phase: RUN_STATES.RUNNING,
      health: RUN_HEALTH.OK,
      executorState: EXECUTOR_STATES.ACTIVE,
      progress: { label: '正在运行' },
      metadata: this._orchestrationMetadata(run, {
        resource,
        lastActivityAt: at,
        lastHealthCheckAt: null,
      }),
    }, { at });

    const controller = new AbortController();
    const entry = {
      run,
      resource,
      controller,
      promise: null,
    };
    this.active.set(run.runId, entry);
    const context = Object.freeze({
      runId: run.runId,
      resource,
      signal: controller.signal,
      getRun: () => this.ledger.get(run.runId),
      heartbeat: (patch) => this.heartbeat(run.runId, patch),
      registerHandle: (handle) => this.registerExecutorHandle(run.runId, handle),
    });

    let execution;
    try {
      execution = executor(jsonClone(run), context);
    } catch (error) {
      execution = Promise.reject(error);
    }
    entry.promise = Promise.resolve(execution)
      .then(
        (outcome) => this._settleExecution(run.runId, outcome, null),
        (error) => this._settleExecution(run.runId, null, error),
      )
      .finally(() => {
        this.active.delete(run.runId);
        this.executorHandles.delete(run.runId);
        this.cancelRequests.delete(run.runId);
        if (this.started) this.dispatch();
      });
    return run;
  }

  _settleExecution(runId, outcome, error) {
    const current = this.ledger.get(runId);
    if (!current || isTerminalState(current.state)) return current;
    const canceled = this.cancelRequests.has(runId)
      || (this.active.get(runId) && this.active.get(runId).controller.signal.aborted);
    let state;
    if (canceled) state = RUN_STATES.CANCELED;
    else if (outcome && isTerminalState(outcome.status)) state = outcome.status;
    else if (error || (outcome && outcome.ok === false)) state = RUN_STATES.FAILED;
    else state = RUN_STATES.SUCCEEDED;

    const details = isPlainObject(outcome && outcome.details)
      ? jsonClone(outcome.details)
      : {};
    const result = isPlainObject(outcome && outcome.result)
      ? jsonClone(outcome.result)
      : {};
    if (error) result.error = normalizeExecutorError(error);
    if (!error && outcome && outcome.ok === false && outcome.error != null) {
      result.error = typeof outcome.error === 'object'
        ? jsonClone(outcome.error)
        : { code: 'EXECUTOR_FAILED', message: String(outcome.error) };
    }
    if (state === RUN_STATES.CANCELED) {
      const request = this.cancelRequests.get(runId);
      result.error = result.error || {
        code: 'CANCELED',
        message: request && request.reason || 'Task canceled',
      };
    }
    const label = state === RUN_STATES.SUCCEEDED ? '已完成'
      : state === RUN_STATES.CANCELED ? '已取消'
        : state === RUN_STATES.INTERRUPTED ? '已中断'
          : '执行失败';
    return this.ledger.terminal(runId, state, {
      ...details,
      phase: details.phase || 'terminal',
      executorState: details.executorState || EXECUTOR_STATES.STOPPED,
      progress: { label, ...(details.progress || {}) },
      result: { ...result, ...(details.result || {}) },
    }, { at: this._iso() });
  }

  _cancelHandle(handle, reason) {
    if (!handle) return;
    if (typeof handle === 'function') return handle(reason);
    for (const method of ['cancel', 'abort', 'stop', 'kill']) {
      if (typeof handle[method] === 'function') return handle[method](reason);
    }
  }

  cancel(runId, reason = 'Canceled by user') {
    const run = this.ledger.get(runId);
    if (!run) throw new TaskOrchestratorError('RUN_NOT_FOUND', `Run not found: ${String(runId)}`);
    if (isTerminalState(run.state)) return run;
    if (run.state === RUN_STATES.QUEUED && !run.startedAt) {
      const waiting = this.externalWaiting.get(runId);
      if (waiting) {
        this.externalWaiting.delete(runId);
        waiting.settled = true;
        try { waiting.controller.abort(reason); } catch (_) {}
        waiting.resolveLease(null);
      }
      const canceled = this.ledger.terminal(runId, RUN_STATES.CANCELED, {
        phase: 'terminal',
        executorState: EXECUTOR_STATES.STOPPED,
        progress: { label: '已取消' },
        result: { error: { code: 'CANCELED_BEFORE_START', message: String(reason) } },
      }, { at: this._iso() });
      if (this.started) this.dispatch();
      return canceled;
    }

    this.cancelRequests.set(runId, { reason: String(reason), requestedAt: this._iso() });
    let stopping = run;
    if (run.state !== RUN_STATES.STOPPING) {
      stopping = this.ledger.update(runId, {
        state: RUN_STATES.STOPPING,
        phase: RUN_STATES.STOPPING,
        executorState: EXECUTOR_STATES.DRAINING,
        progress: { label: '正在停止' },
        cancelRequestedAt: this._iso(),
      }, { at: this._iso() });
    }
    const active = this.active.get(runId);
    if (active && !active.controller.signal.aborted) active.controller.abort(reason);
    const external = this.externalActive.get(runId);
    if (external && !external.controller.signal.aborted) external.controller.abort(reason);
    try {
      const pending = this._cancelHandle(this.executorHandles.get(runId), reason);
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) => this._warn(`executor cancellation rejected for ${runId}`, error));
      }
    } catch (error) {
      this._warn(`executor cancellation failed for ${runId}`, error);
    }
    return stopping;
  }

  heartbeat(runId, patch = {}) {
    const current = this.ledger.get(runId);
    if (!current) throw new TaskOrchestratorError('RUN_NOT_FOUND', `Run not found: ${String(runId)}`);
    if (isTerminalState(current.state)) return current;
    const at = this._iso();
    const supplied = isPlainObject(patch) ? jsonClone(patch) : {};
    return this.ledger.update(runId, {
      ...supplied,
      health: RUN_HEALTH.OK,
      metadata: this._orchestrationMetadata(current, {
        lastActivityAt: at,
        lastHealthCheckAt: null,
      }),
    }, { at });
  }

  _lastActivityMs(run) {
    const orchestration = run && run.metadata && run.metadata.orchestration || {};
    const trackedMs = timestampMs(orchestration.lastActivityAt);
    const healthCheckMs = timestampMs(orchestration.lastHealthCheckAt);
    const eventMs = timestampMs(run && run.lastEventAt);
    // Ledger updates made by the health monitor itself advance lastEventAt. Ignore that timestamp;
    // later normal ledger updates are still recognized as real executor activity.
    const externalEventMs = eventMs != null && (healthCheckMs == null || eventMs > healthCheckMs)
      ? eventMs
      : null;
    return Math.max(
      trackedMs == null ? 0 : trackedMs,
      externalEventMs == null ? 0 : externalEventMs,
      timestampMs(run && run.startedAt) || 0,
    );
  }

  tickHealth(at) {
    const nowMs = this._nowMs(at);
    const nowIso = new Date(nowMs).toISOString();
    const changed = [];
    for (const run of this.ledger.list({ terminal: false })) {
      if (!HEALTH_WATCH_STATES.has(run.state)) continue;
      const activityMs = this._lastActivityMs(run);
      const elapsed = Math.max(0, nowMs - activityMs);
      const health = elapsed >= this.stalledAfterMs ? RUN_HEALTH.STALLED
        : elapsed >= this.silentAfterMs ? RUN_HEALTH.SILENT
          : RUN_HEALTH.OK;
      if (run.health === health) continue;
      const orchestration = run.metadata && run.metadata.orchestration || {};
      const eventMs = timestampMs(run.lastEventAt);
      const previousHealthCheckMs = timestampMs(orchestration.lastHealthCheckAt);
      const observedExternalActivity = eventMs != null
        && (previousHealthCheckMs == null || eventMs > previousHealthCheckMs);
      const next = this.ledger.update(run.runId, {
        health,
        metadata: this._orchestrationMetadata(run, {
          lastActivityAt: observedExternalActivity
            ? new Date(eventMs).toISOString()
            : orchestration.lastActivityAt,
          lastHealthCheckAt: nowIso,
        }),
      }, { at: nowIso });
      changed.push(next);
    }
    return changed;
  }

  getStats() {
    const queued = this.ledger.list({ state: RUN_STATES.QUEUED })
      .filter((run) => !run.startedAt);
    const byResource = {};
    for (const [resource, limit] of Object.entries(this.poolLimits)) {
      byResource[resource] = { active: 0, queued: 0, limit };
    }
    const ensure = (resource) => {
      if (!byResource[resource]) byResource[resource] = { active: 0, queued: 0, limit: 1 };
      return byResource[resource];
    };
    for (const entry of this.active.values()) ensure(entry.resource).active += 1;
    for (const entry of this.externalActive.values()) ensure(entry.resource).active += 1;
    const untrackedActive = this._externalActiveRuns();
    for (const run of untrackedActive) ensure(this._resourceOf(run)).active += 1;
    for (const run of queued) ensure(this._resourceOf(run)).queued += 1;
    return {
      started: this.started,
      active: this.active.size + this.externalActive.size + untrackedActive.length,
      queued: queued.length,
      byResource,
    };
  }

}

module.exports = {
  DEFAULT_RESOURCE_LIMITS,
  DEFAULT_AGING_INTERVAL_MS,
  DEFAULT_AGING_STEP,
  DEFAULT_SILENT_AFTER_MS,
  DEFAULT_STALLED_AFTER_MS,
  DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  TaskOrchestrator,
  TaskOrchestratorError,
  inferResource,
  conversationKeyOf,
  scheduleKeyOf,
  effectivePriority,
  compareQueuedRuns,
};
