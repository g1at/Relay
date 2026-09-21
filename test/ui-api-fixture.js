// Browser-only fixture. No IPC, network, provider calls, or user history.
(() => {
  const listeners = new Map(), history = new Map(), permissions = new Map();
  let defaultPermission = { ok: true, conversationId: null, permissionMode: 'default', executionMode: { kind: 'default' }, revision: 1 };
  const copy = value => JSON.parse(JSON.stringify(value));
  const routes = { defaultModel: 'opus', chatRoutes: [
    { tier: 'haiku', modelId: 'vendor/mimo-v2.5-pro[1m]' },
    { tier: 'sonnet', modelId: 'vendor/mimo-x-flash-preview' },
    { tier: 'opus', modelId: 'vendor/mimo-x-pro-preview' },
  ].map(route => ({ ...route, providerId: 'fixture', providerName: 'Fixture', providerRevision: 1, configured: true, available: true })), imageRoutes: [] };
  const state = window.uiFixture = {
    errors: [], calls: [], decisions: [], runId: '', routes, permissionWrites: [], failNextPermission: false,
    failNextDecision: false, holdDecision: false, pendingDecision: null,
    emit(channel, value) { for (const fn of listeners.get(channel) || []) fn(copy(value)); },
    resolveDecision() { if (state.pendingDecision) { state.pendingDecision({ ok: true }); state.pendingDecision = null; } },
  };
  window.addEventListener('error', e => state.errors.push(e.message));
  window.addEventListener('unhandledrejection', e => state.errors.push(String(e.reason && e.reason.stack || e.reason)));
  const methods = {
    'permissions.get': id => copy(id ? permissions.get(id) || { ...defaultPermission, conversationId: id,
      executionMode: history.get(id)?.executionMode || { kind: 'default' } } : defaultPermission),
    'permissions.set': request => {
      state.permissionWrites.push(copy(request));
      if (state.failNextPermission) { state.failNextPermission = false; return { ok: false, error: '模拟权限更新失败' }; }
      const id = request.conversationId || null;
      const previous = methods['permissions.get'](id);
      const next = { ...previous, permissionMode: request.permissionMode,
        executionMode: request.executionMode || previous.executionMode, revision: previous.revision + 1 };
      if (id) permissions.set(id, next); else defaultPermission = next;
      state.emit('permissions.onChanged', next);
      return copy(next);
    },
    'settings.read': () => ({ app: { theme: 'light' }, claude: { routes, defaultModel: 'opus' } }),
    'history.list': () => [...history.values()],
    'history.load': id => copy(history.get(id) || null),
    'history.save': conv => { const next = copy({ ...conv, id: conv.id || 'fixture-conversation', updatedAt: new Date().toISOString() }); history.set(next.id, next); return next; },
    'brand.get': () => ({ name: 'Relay' }),
    'probeEnv': () => ({ ok: true }),
    'relayUpdate.status': () => ({ state: 'idle' }),
    'tasks.snapshot': () => ({ ok: true, runs: [] }),
    'tasks.replay': () => ({ ok: true, events: [] }),
    'tasks.replayStream': () => ({ ok: true, events: [] }),
    'interactions.list': () => ({ ok: true, items: [] }),
    'interactions.respond': (id, decision) => {
      state.decisions.push(copy({ id, ...decision }));
      if (state.failNextDecision) { state.failNextDecision = false; return { ok: false, error: '合成提交失败，请重试' }; }
      if (state.holdDecision) return new Promise(resolve => { state.pendingDecision = resolve; });
      return { ok: true };
    },
    'skills.getReviewConfig': () => ({ enabled: false }),
    'claudeRuntimeInfo': () => ({ ok: true, providerId: 'fixture', model: 'opus', effort: 'max', models: [
      { value: 'opus', resolvedModel: 'old/claude-opus', displayName: 'old/claude-opus', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
      { value: 'vendor/mimo-x-pro-preview', displayName: 'Fixture model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
    ] }),
    'setClaudeRuntime': (id, model, effort) => ({ ok: true, model, effort }),
    'runClaude': (...args) => { state.runId = args[11]; return { ok: true, jobId: args[11] }; },
    'summarizeTitle': () => null,
  };
  function endpoint(path = '') {
    return new Proxy(() => {}, {
      get(_target, key) { if (key === 'then') return undefined; if (!path && key === 'windowChrome') return { overlay: false, initialTheme: 'light', setTheme() {} }; return endpoint(path ? path + '.' + String(key) : String(key)); },
      apply(_target, _this, args) {
        state.calls.push(path);
        if (/(?:^|\.)on[A-Z]/.test(path)) {
          if (!listeners.has(path)) listeners.set(path, []);
          listeners.get(path).push(args[0]);
          return () => listeners.set(path, listeners.get(path).filter(fn => fn !== args[0]));
        }
        return Promise.resolve(methods[path] ? methods[path](...args) : { ok: true, items: [], runs: [], events: [] });
      },
    });
  }
  window.api = endpoint();
})();
