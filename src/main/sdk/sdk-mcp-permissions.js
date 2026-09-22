'use strict';

// Relay only exposes tightening to per-action approval or following the session.
// The SDK's 'auto' classifier is intentionally not another permission setting.
const validName = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
function normalizeMcpPermissionOverrides(value) {
  return Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
    .filter(([name, mode]) => validName(name) && mode === 'default').slice(0, 500));
}
function requiresMcpApproval(toolName, overrides) {
  if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return false;
  let policy;
  try { policy = typeof overrides === 'function' ? overrides() : overrides; }
  catch (_) { return true; } // A failed policy read cannot turn into approval.
  return Object.entries(normalizeMcpPermissionOverrides(policy)).some(([name]) =>
    toolName.startsWith(`mcp__${name}__`) || toolName.startsWith(`mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__`));
}
function mcpApprovalHook(overrides) {
  return async input => requiresMcpApproval(input.tool_name, overrides) ? {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
      permissionDecisionReason: '此 MCP 已设为始终请求批准，请确认本次操作。' },
  } : {};
}

class McpPermissionOverrides {
  constructor(overrides = {}) {
    this.desired = normalizeMcpPermissionOverrides(overrides);
    this.applied = new Map();
  }
  snapshot() { return { ...this.desired }; }
  replace(overrides) { this.desired = normalizeMcpPermissionOverrides(overrides); }
  set(name, mode) {
    if (!validName(name) || !['default', null].includes(mode)) throw fail('INVALID_MCP_PERMISSION', 'MCP 审批设置无效');
    const next = { ...this.desired }; if (mode === null) delete next[name]; else Object.defineProperty(next, name, { value: mode, enumerable: true, configurable: true });
    this.desired = next;
  }
  async apply(query, { names = [], force = false } = {}) {
    const snapshot = this.snapshot();
    const targets = [...new Set([...names.filter(validName), ...this.applied.keys(), ...Object.keys(snapshot)])];
    if (typeof query?.setMcpPermissionModeOverride !== 'function') {
      if (Object.keys(snapshot).length || this.applied.size) throw fail('MCP_PERMISSION_UNSUPPORTED', '当前运行时不支持独立 MCP 审批，请重新创建会话');
      return { ok: true, warnings: [] };
    }
    const warnings = [];
    // Tighten new names before clearing old ones during a rename/refresh.
    targets.sort((a, b) => Number(snapshot[b] === 'default') - Number(snapshot[a] === 'default'));
    for (const name of targets) {
      const mode = Object.hasOwn(snapshot, name) ? snapshot[name] : null;
      if (!force && this.applied.has(name) && this.applied.get(name) === mode) continue;
      const result = await query.setMcpPermissionModeOverride(name, mode);
      this.applied.set(name, mode);
      if (result?.warning) warnings.push({ name, code: 'MCP_NOT_CONNECTED' });
    }
    return { ok: true, warnings };
  }
}

function createMcpPermissions({ readSettings, writeSettings, readServers, listSessions = () => [], stopSession } = {}) {
  if (typeof readSettings !== 'function' || typeof writeSettings !== 'function' || typeof readServers !== 'function') throw TypeError('MCP permissions require host settings and registry access');
  let tail = Promise.resolve();
  const serial = action => { const next = tail.then(action); tail = next.catch(() => {}); return next; };
  const allNames = () => {
    const registry = readServers() || {};
    return new Set((Array.isArray(registry) ? registry.map(item => typeof item === 'string' ? item : item?.name) : Object.keys(registry)).filter(validName));
  };
  const overrides = () => normalizeMcpPermissionOverrides(readSettings()?.mcpPermissionOverrides);
  const get = () => {
    const selected = overrides();
    return [...allNames()].map(name => ({ name, mode: selected[name] === 'default' ? 'default' : null }));
  };
  const persist = next => writeSettings({ ...readSettings(), mcpPermissionOverrides: next });
  async function syncSessions({ previous = null, retired = [] } = {}) {
    const selected = overrides();
    const tightened = previous === null ? Object.keys(selected).length > 0 : Object.keys(selected).some(name => previous[name] !== 'default');
    const failures = [], warnings = [];
    let applied = 0;
    // Start every live controller update before waiting for acknowledgements, so
    // a slow Query cannot leave other active conversations on their old policy.
    await Promise.all((listSessions() || []).map(async session => {
      const child = session?.child || session;
      try {
        for (const name of retired) {
          if (typeof child?.toggleMcpServer !== 'function') throw fail('MCP_PERMISSION_UNSUPPORTED', '旧任务需要暂停');
          await child.toggleMcpServer(name, false);
        }
        if (typeof child?.syncMcpPermissionOverrides !== 'function') throw fail('MCP_PERMISSION_UNSUPPORTED', '旧会话需要重建');
        const result = await child.syncMcpPermissionOverrides(selected);
        warnings.push(...(result?.warnings || [])); applied++;
      } catch (_) {
        // A runtime that cannot acknowledge a tighter policy cannot keep running
        // tools under its old bypass mode. Host persistence already protects new runs.
        if (tightened || retired.length) {
          try { if (stopSession) await stopSession(session); else await child?.kill?.(); } catch (_) {}
        }
        failures.push({ code: 'MCP_PERMISSION_SYNC_FAILED', needsRestart: !!(tightened || retired.length) });
      }
    }));
    return { ok: failures.length === 0, applied, warnings, failures };
  }
  async function commit(next, retired = []) {
    const previous = overrides();
    if (JSON.stringify(previous) === JSON.stringify(next) && !retired.length) return { ok: true, applied: 0, warnings: [], failures: [], items: get() };
    await persist(next);
    return { ...(await syncSessions({ previous, retired })), items: get() };
  }
  return { get, overrides, syncSessions,
    set({ name, mode } = {}) {
      if (!validName(name) || !['default', null].includes(mode)) return Promise.reject(fail('INVALID_MCP_PERMISSION', 'MCP 审批设置无效'));
      return serial(() => {
        if (!allNames().has(name)) throw fail('MCP_NOT_FOUND', 'MCP 已被删除或改名，请刷新列表');
        const next = overrides(); if (mode === null) delete next[name]; else Object.defineProperty(next, name, { value: mode, enumerable: true, configurable: true });
        return commit(next);
      });
    },
    // Disabled servers are still in readServers. Only deletion or an explicit
    // host-reported rename changes stored approvals; similar configs are not identities.
    reconcileRegistry({ renames = {} } = {}) {
      return serial(() => {
        const next = overrides(), names = allNames(), retired = Object.keys(next).filter(name => !names.has(name));
        for (const [from, to] of Object.entries(renames)) if (next[from] === 'default' && validName(to) && names.has(to)) {
          Object.defineProperty(next, to, { value: 'default', enumerable: true, configurable: true }); delete next[from];
        }
        for (const name of Object.keys(next)) if (!names.has(name)) delete next[name];
        return commit(next, retired);
      });
    },
  };
}

module.exports = { normalizeMcpPermissionOverrides, requiresMcpApproval, mcpApprovalHook, McpPermissionOverrides, createMcpPermissions };
