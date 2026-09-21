// Synthetic plugin management data; no actual packages, settings or MCP tools.
(() => {
  const base = window.api, copy = value => JSON.parse(JSON.stringify(value));
  const skills = [
    ['weekly-notes', '周报整理', '整理一周工作进展与待办事项'],
    ['doc-reader', '文档阅读', '提取文档中的要点与相关资料'],
    ['image-helper', '图像助手', '根据描述生成图像创作方案'],
    ['sheet-helper', '表格分析', '汇总数据并生成可读的图表'],
    ['meeting-notes', '会议纪要', '记录讨论结论和后续行动'],
    ['writing-helper', '写作助手', '润色文字，调整结构和语气'],
  ].map(([name, displayName, summary], i) => ({ name, displayName, summary, useCount: i + 1, lastUsedAt: '2026-09-07T01:00:00Z', state: 'active' }));
  const agents = [{ name: 'organizer', displayName: '资料整理助手', file: 'organizer.md', desc: '整理本地资料，梳理文档结构与结论' }, { name: 'reviewer', displayName: '审阅助手', file: 'reviewer.md', desc: '检查内容的完整性与一致性' }];
  const servers = [{ name: '本地资料工具', enabled: true, summary: '本地文件与资料' }, { name: '日程工具', enabled: false, summary: '查看与管理本地日程' }];
  const state = window.pluginsFixture = {
    calls: [], writes: [], imports: [], reads: [], reveals: [], overviewCount: 0,
    mcpFail: false, skillFail: false, writeMode: 'ok', readMode: 'ok', toggleFail: false,
    pendingRead: null, pendingWrite: null,
  };
  function read(kind, key) {
    state.reads.push({ kind, key });
    const response = { ok: true, content: `---\nname: ${key}\n---\n# 合成的详情\n\n用于验证插件页的阅读与编辑。` };
    if (state.readMode === 'fail') return { ok: false, message: '模拟详情读取失败' };
    if (state.readMode === 'hold') return new Promise(resolve => { state.pendingRead = () => { state.pendingRead = null; resolve(response); }; });
    return response;
  }
  const overrides = {
    data: {
      listAgents: () => ({ ok: true, items: copy(agents) }),
      listSkills: () => ({ ok: true, items: copy(skills) }),
      readItem: read,
      writeItem: (kind, key, content) => {
        state.writes.push({ kind, key, content });
        if (state.writeMode === 'fail') return { ok: false, message: '模拟保存失败' };
        if (state.writeMode === 'hold') return new Promise(resolve => { state.pendingWrite = () => { state.pendingWrite = null; resolve({ ok: true }); }; });
        return { ok: true };
      },
      revealItem: (kind, key) => { state.reveals.push({ kind, key }); return { ok: true }; },
      pickImportZip: kind => ({ ok: true, path: `C:\\relay-test-only\\${kind}.zip` }),
      importZip: (kind, path) => { state.imports.push({ kind, path }); return { ok: true, items: copy(kind === 'agent' ? agents : skills) }; },
      renameAgent: (file, name) => { state.writes.push({ action: 'rename', file, name }); agents.find(a => a.file === file).displayName = name; return { ok: true, items: copy(agents) }; },
    },
    skills: {
      overview: () => { state.overviewCount++; return state.skillFail ? { ok: false, message: '模拟技能读取失败' } : { ok: true, items: copy(skills), archived: [{ name: 'old-helper', useCount: 1 }], staleDays: 30, usageReady: true }; },
      getReviewConfig: () => ({ ok: true, enabled: false, everyTurns: 6 }),
      backfillMetadata: () => ({ ok: true, total: 0 }),
    },
    mcp: {
      list: () => state.mcpFail ? { ok: false, message: '模拟 MCP 读取失败' } : { ok: true, items: copy(servers) },
      status: id => ({ ok: true, available: true, busy: false, items: [{ name: servers[0].name, status: 'connected', toolCount: 3 }] }),
      toggle: (name, enabled, convId) => { state.writes.push({ action: 'mcpToggle', name, enabled, convId }); if (state.toggleFail) return { ok: false, message: '模拟 MCP 修改失败' }; servers.find(item => item.name === name).enabled = enabled; return { ok: true, liveApplied: true }; },
      sync: convId => { state.writes.push({ action: 'sync', convId }); return { ok: true }; },
      reconnect: (convId, name) => { state.writes.push({ action: 'reconnect', convId, name }); return { ok: true }; },
    },
  };
  window.api = new Proxy(base, { get(target, category) {
    if (category === 'getPathForFile') return file => `C:\\relay-test-only\\${file.name}`;
    if (!overrides[category]) return target[category];
    return new Proxy(target[category], { get(original, method) {
      if (!Object.prototype.hasOwnProperty.call(overrides[category], method)) return original[method];
      return async (...args) => { state.calls.push(category + '.' + String(method)); return overrides[category][method](...args); };
    } });
  } });
})();
