'use strict';

const { createHash } = require('node:crypto');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function mcpConfigKey(servers) {
  return createHash('sha256').update(JSON.stringify(stableValue(servers || {}))).digest('hex');
}

function publicMcpItems(statuses, expectedNames = []) {
  const items = new Map();
  for (const status of Array.isArray(statuses) ? statuses : []) {
    if (!status || typeof status.name !== 'string' || !status.name) continue;
    items.set(status.name, {
      name: status.name,
      status: ['connected', 'failed', 'needs-auth', 'pending', 'disabled'].includes(status.status)
        ? status.status : 'unknown',
      toolCount: Array.isArray(status.tools) ? status.tools.length : null,
    });
  }
  for (const name of expectedNames) {
    if (!items.has(name)) items.set(name, { name, status: 'missing', toolCount: null });
  }
  return [...items.values()];
}

// A Query has one MCP configuration. Settings-page controls and send-time
// readiness must observe the same order, including requests whose UI timed out.
class McpControlQueue {
  constructor() { this.tail = Promise.resolve(); }

  run(operation) {
    const pending = this.tail.then(operation);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  // A read must observe earlier writes, but a stuck read has no state to commit
  // later and must not prevent the next turn from querying/recovering the MCP.
  read(operation) { return this.tail.then(operation); }

  whenIdle() { return this.tail; }
}

// Readiness belongs to a Query, not its first init event or any assistant text.
// Calls only use the SDK control channel; they never invoke an MCP business tool.
class LiveMcpReadiness {
  constructor(control, { signal = null, pollIntervalMs = 250, initialServers = {}, initialServersApplied = false, reconnectCooldownMs = 30000, protectedNames = [] } = {}) {
    this.control = control;
    this.signal = signal;
    this.pollIntervalMs = pollIntervalMs;
    // Query options may already contain this exact registry. Replacing that
    // initial collection before even reading its state needlessly reconnects
    // transports; status below remains authoritative, including missing entries.
    this.configKey = initialServersApplied ? mcpConfigKey(initialServers) : null;
    this.configRevision = 0;
    this.prepareRevision = 0;
    this.prepareKey = null;
    this.syncInFlight = null;
    this.reconnectInFlight = new Map();
    this.reconnectCooldownMs = Math.max(0, Number(reconnectCooldownMs) || 0);
    this.reconnectAttempts = new Map();
    this.toggleInFlight = new Map();
    this.managedNames = new Set(Object.keys(initialServers || {}));
    this.protectedNames = new Set(protectedNames);
  }

  adoptInitialServers(servers) {
    // SDK setup is asynchronous. Only adopt before any settings write or
    // competing send-time synchronization has taken ownership of this Query.
    if (this.configRevision || this.syncInFlight || this.configKey !== null) return false;
    this.configKey = mcpConfigKey(servers);
    for (const name of Object.keys(servers || {})) this.managedNames.add(name);
    return true;
  }

  invalidate(servers) {
    this.configKey = null;
    this.configRevision += 1;
    this.reconnectAttempts.clear();
    for (const name of Object.keys(servers || {})) this.managedNames.add(name);
  }

  async prepare({ servers = {}, timeoutMs = 15000, signal = null, reconnect = true } = {}) {
    const configRevision = this.configRevision;
    let prepareRevision = null;
    const deadline = Date.now() + Math.max(1, Math.min(15000, Number(timeoutMs) || 15000));
    const signals = [this.signal, signal].filter(Boolean);
    let items = [];
    let synced = false;
    let expectedNames = [];
    const reconnected = [];
    const attemptedReconnect = new Set();
    const attemptedToggle = new Set();
    const aborted = () => signals.some((entry) => entry.aborted);
    const stale = () => this.configRevision !== configRevision
      || prepareRevision !== null && this.prepareRevision !== prepareRevision;
    const stopped = error => ['MCP_PREPARE_TIMEOUT', 'MCP_PREPARE_CANCELED', 'MCP_PREPARE_SUPERSEDED'].includes(error?.code);
    const failure = (code) => {
      const error = new Error(code);
      error.code = code;
      return error;
    };
    const bounded = (operation) => {
      if (aborted()) return Promise.reject(failure('MCP_PREPARE_CANCELED'));
      if (stale()) return Promise.reject(failure('MCP_PREPARE_SUPERSEDED'));
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(failure('MCP_PREPARE_TIMEOUT'));
      return new Promise((resolve, reject) => {
        let timer;
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          for (const entry of signals) entry.removeEventListener('abort', onAbort);
        };
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback(value);
        };
        const onAbort = () => finish(reject, failure('MCP_PREPARE_CANCELED'));
        for (const entry of signals) entry.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(reject, failure(stale() ? 'MCP_PREPARE_SUPERSEDED' : 'MCP_PREPARE_TIMEOUT')), remaining);
        Promise.resolve().then(() => {
          if (aborted()) throw failure('MCP_PREPARE_CANCELED');
          if (stale()) throw failure('MCP_PREPARE_SUPERSEDED');
          if (settled || Date.now() >= deadline) throw failure('MCP_PREPARE_TIMEOUT');
          return operation();
        }).then(
          (value) => stale() ? finish(reject, failure('MCP_PREPARE_SUPERSEDED')) : finish(resolve, value),
          (error) => finish(reject, stale() ? failure('MCP_PREPARE_SUPERSEDED') : error),
        );
      });
    };
    const result = (code = null) => ({
      ok: !code && expectedNames.every((name) => items.find((item) => item.name === name)?.status === 'connected'),
      items,
      code,
      timedOut: code === 'MCP_PREPARE_TIMEOUT',
      canceled: code === 'MCP_PREPARE_CANCELED',
      ...(code === 'MCP_PREPARE_SUPERSEDED' ? { stale: true } : {}),
      synced,
      reconnected,
    });

    try {
      if (aborted()) throw failure('MCP_PREPARE_CANCELED');
      // Freeze this request's registry snapshot; retain no printable credentials.
      const config = JSON.parse(JSON.stringify(servers || {}));
      expectedNames = Object.keys(config);
      items = expectedNames.map((name) => ({ name, status: 'unknown', toolCount: null }));
      const key = mcpConfigKey(config);
      // A newer registry may arrive through another preparation without an
      // explicit settings write. Same-registry readers can share work; a new
      // registry owns recovery from here on and supersedes older snapshots.
      if (this.prepareKey !== key) {
        this.prepareKey = key;
        this.prepareRevision += 1;
      }
      prepareRevision = this.prepareRevision;
      let syncFailedNames = new Set();
      const sync = async (force = false) => {
        // A timed-out SDK call may still settle later. A following preparation has
        // its own finite deadline; don't send a competing replacement meanwhile.
        while (this.syncInFlight && this.syncInFlight.key !== key) {
          const previous = this.syncInFlight;
          try { await bounded(() => previous.promise); }
          catch (error) {
            if (stopped(error)) throw error;
          }
        }
        if (!force && this.configKey === key) return;
        let response;
        let selected;
        try {
          response = await bounded(() => {
            if (!this.syncInFlight) {
              const revision = this.configRevision;
              const pending = { key, promise: null };
              pending.promise = Promise.resolve().then(() => this.control.setMcpServers(config)).then((value) => {
                if (this.configRevision === revision && !stale()) {
                  if (this.configKey !== key) this.reconnectAttempts.clear();
                  this.configKey = key;
                }
                for (const name of Object.keys(config)) this.managedNames.add(name);
                return value;
              }).finally(() => {
                if (this.syncInFlight === pending) this.syncInFlight = null;
              });
              this.syncInFlight = pending;
            }
            selected = this.syncInFlight;
            return selected.promise;
          });
        }
        catch (error) {
          if (stopped(error)) throw error;
          if (selected && selected.key !== key) return sync(force);
          throw failure('MCP_SYNC_FAILED');
        }
        if (selected.key !== key) return sync(force);
        synced = true;
        syncFailedNames = new Set(Object.keys(response && response.errors || {}));
      };

      // An interrupted preparation may have left a control request in progress.
      // Let it settle before reading state or replacing config for another turn.
      await bounded(() => Promise.allSettled([
        ...this.reconnectInFlight.values(), ...this.toggleInFlight.values(),
        ...(typeof this.control.whenIdle === 'function' ? [this.control.whenIdle()] : []),
      ]));
      await sync();
      while (true) {
        let statuses;
        try { statuses = await bounded(() => this.control.mcpServerStatus()); }
        catch (error) {
          if (stopped(error)) throw error;
          throw failure('MCP_STATUS_FAILED');
        }
        items = publicMcpItems(statuses, expectedNames);
        for (const item of items) {
          if (item.status === 'connected') this.reconnectAttempts.delete(item.name);
        }
        const required = items.filter((item) => expectedNames.includes(item.name));
        // setMcpServers only replaces the dynamic collection. A settings-owned
        // copy of a removed server can remain connected; disable that copy too.
        const retired = items.filter((item) => this.managedNames.has(item.name)
          && !this.protectedNames.has(item.name)
          && !expectedNames.includes(item.name) && item.status !== 'disabled');
        let toggled = false;
        for (const item of [...retired, ...required.filter((entry) => entry.status === 'disabled')]) {
          const enabled = expectedNames.includes(item.name);
          const toggleKey = `${enabled}:${item.name}`;
          if (attemptedToggle.has(toggleKey)) continue;
          attemptedToggle.add(toggleKey);
          try {
            await bounded(() => {
              if (!this.toggleInFlight.has(toggleKey)) {
                const pending = Promise.resolve().then(() => this.control.toggleMcpServer(item.name, enabled));
                this.toggleInFlight.set(toggleKey, pending);
                pending.finally(() => {
                  if (this.toggleInFlight.get(toggleKey) === pending) this.toggleInFlight.delete(toggleKey);
                }).catch(() => {});
              }
              return this.toggleInFlight.get(toggleKey);
            });
          } catch (error) {
            if (stopped(error)) throw error;
          }
          toggled = true;
        }
        if (toggled) continue;
        if (required.every((item) => item.status === 'connected') && !retired.length) return result();
        if (!synced && required.some((item) => item.status === 'missing')) {
          await sync(true);
          continue;
        }

        let retried = false;
        for (const item of required) {
          // A normal send waits for connecting tools, but a known failed
          // transport's recovery belongs to the background/settings path.
          if (!reconnect || item.status !== 'failed' || attemptedReconnect.has(item.name)) continue;
          // A known offline server must not consume another full reconnect on
          // each ordinary message. Still read its live status every turn, and
          // allow explicit settings-page reconnects immediately.
          const lastAttempt = this.reconnectAttempts.get(item.name);
          if (lastAttempt != null && Date.now() - lastAttempt < this.reconnectCooldownMs) continue;
          attemptedReconnect.add(item.name);
          this.reconnectAttempts.set(item.name, Date.now());
          try {
            await bounded(() => {
              if (!this.reconnectInFlight.has(item.name)) {
                const pending = Promise.resolve().then(() => this.control.reconnectMcpServer(item.name));
                this.reconnectInFlight.set(item.name, pending);
                pending.finally(() => {
                  if (this.reconnectInFlight.get(item.name) === pending) this.reconnectInFlight.delete(item.name);
                }).catch(() => {});
              }
              return this.reconnectInFlight.get(item.name);
            });
            reconnected.push(item.name);
          } catch (error) {
            if (stopped(error)) throw error;
            // The following real status read remains authoritative; do not expose
            // transport error messages, which may contain configuration secrets.
          }
          retried = true;
        }
        if (retried) continue;
        const waiting = required.some((item) => item.status === 'pending'
          || (item.status === 'missing' && !syncFailedNames.has(item.name)));
        if (!waiting) return result('MCP_NOT_READY');
        await bounded(() => new Promise((resolve) => setTimeout(resolve, Math.max(1, this.pollIntervalMs))));
      }
    } catch (error) {
      const knownCodes = ['MCP_PREPARE_TIMEOUT', 'MCP_PREPARE_CANCELED', 'MCP_PREPARE_SUPERSEDED', 'MCP_SYNC_FAILED', 'MCP_STATUS_FAILED'];
      return result(knownCodes.includes(error && error.code) ? error.code : 'MCP_PREPARE_FAILED');
    }
  }
}

module.exports = { LiveMcpReadiness, McpControlQueue, mcpConfigKey, publicMcpItems };
