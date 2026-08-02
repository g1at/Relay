// Claude Code stream-json -> Relay structured activity stream.
// Kept independent from app.js so live rendering and history restoration share one data model.
(function () {
  'use strict';

  const VERSION = 3;
  const MAX_INPUT_CHARS = 6000;
  const MAX_RESULT_CHARS = 8000;

  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const trimText = (value, max) => {
    const text = String(value == null ? '' : value);
    return text.length > max ? `${text.slice(0, max)}\n…（内容过长，已截断）` : text;
  };

  function redact(value) {
    if (value == null) return value;
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === 'object') {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        out[key] = /token|secret|password|authorization|cookie|api[_-]?key|credential/i.test(key)
          ? '••••••••'
          : redact(child);
      }
      return out;
    }
    return value;
  }

  function safeJson(value, max = MAX_INPUT_CHARS) {
    try { return trimText(JSON.stringify(redact(value), null, 2), max); }
    catch (_) { return trimText(String(value == null ? '' : value), max); }
  }

  function compactValue(value, max = MAX_INPUT_CHARS) {
    const safe = redact(value);
    try {
      const raw = JSON.stringify(safe);
      return raw.length > max ? { preview: `${raw.slice(0, max)}…`, truncated: true } : safe;
    } catch (_) {
      return { preview: trimText(String(value == null ? '' : value), max), truncated: true };
    }
  }

  function resultText(block) {
    if (!block) return '';
    if (typeof block.content === 'string') return block.content;
    if (Array.isArray(block.content)) {
      return block.content.map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        return part.text || part.content || '';
      }).filter(Boolean).join('\n');
    }
    return block.content == null ? '' : safeJson(block.content, MAX_RESULT_CHARS);
  }

  function basename(path) {
    const parts = String(path || '').split(/[\\/]/);
    return parts[parts.length - 1] || '文件';
  }

  function friendlyTool(name, input) {
    const data = input || {};
    const tool = String(name || '工具');
    if (tool === 'ListMcpResourcesTool') return { title: '查看当前会话的 MCP 服务', detail: '读取已加载的服务与资源' };
    if (tool === 'ReadMcpResourceTool') return { title: '读取 MCP 资源', detail: data.uri || data.server || '' };
    if (tool === 'Glob') return { title: '搜索文件', detail: [data.path, data.pattern].filter(Boolean).join(' · ') };
    if (tool === 'Grep') return { title: '搜索内容', detail: [data.path, data.pattern].filter(Boolean).join(' · ') };
    if (tool === 'Read') return { title: `读取 ${basename(data.file_path || data.path)}`, detail: data.file_path || data.path || '' };
    if (tool === 'Write') return { title: `写入 ${basename(data.file_path || data.path)}`, detail: data.file_path || data.path || '' };
    if (tool === 'Edit') return { title: `修改 ${basename(data.file_path || data.path)}`, detail: data.file_path || data.path || '' };
    if (tool === 'Bash' || tool === 'PowerShell') return { title: '运行命令', detail: data.command || '' };
    if (tool === 'WebSearch') return { title: '搜索网页', detail: data.query || '' };
    if (tool === 'WebFetch') return { title: '读取网页', detail: data.url || '' };
    if (tool === 'Agent' || tool === 'Task') return { title: data.description || '启动子代理', detail: data.subagent_type ? `${data.subagent_type} 子代理` : '' };
    if (tool.startsWith('mcp__')) {
      const parts = tool.split('__');
      return { title: `调用 ${parts[1] || 'MCP'} 服务`, detail: parts.slice(2).join('__') };
    }
    return { title: `调用 ${tool}`, detail: '' };
  }

  function createState(initial) {
    const saved = initial || {};
    const state = {
      version: VERSION,
      phase: saved.phase || 'running',
      startedAt: saved.startedAt || Date.now(),
      endedAt: saved.endedAt || null,
      received: Number(saved.received || 0),
      session: clone(saved.session || null),
      items: clone(Array.isArray(saved.items) ? saved.items : []),
      result: clone(saved.result || null),
      error: saved.error || null,
      eventKinds: Array.isArray(saved.eventKinds) ? [...saved.eventKinds] : [],
      _blocks: new Map(),
      _tools: new Map(),
      _tasks: new Map(),
      _currentMessageId: null,
      _messageSequence: 0,
    };
    for (const item of state.items) {
      if (item.type === 'tool' && item.toolUseId) state._tools.set(item.toolUseId, item);
      if (item.type === 'task') {
        if (item.taskId) state._tasks.set(item.taskId, item);
        if (item.toolUseId) state._tasks.set(item.toolUseId, item);
      }
    }
    return state;
  }

  function publicSnapshot(state) {
    return {
      version: VERSION,
      phase: state.phase,
      startedAt: state.startedAt,
      endedAt: state.endedAt,
      received: state.received,
      session: clone(state.session),
      items: state.items.map((item) => {
        const clean = clone(item);
        if (clean.input) clean.input = compactValue(clean.input);
        if (clean.result) clean.result = trimText(clean.result, MAX_RESULT_CHARS);
        delete clean.structuredResult;
        delete clean.inputJson;
        return clean;
      }),
      result: clone(state.result),
      error: state.error,
      eventKinds: [...state.eventKinds],
    };
  }

  function rememberKind(state, kind) {
    if (kind && !state.eventKinds.includes(kind)) state.eventKinds.push(kind);
  }

  function itemFor(state, id, patch) {
    let item = state.items.find((candidate) => candidate.id === id);
    if (!item) {
      item = { id, type: 'status', status: 'running', title: '', detail: '', startedAt: Date.now() };
      state.items.push(item);
    }
    if (patch) Object.assign(item, patch);
    return item;
  }

  function rememberTask(state, item, event) {
    const taskId = (event && event.task_id) || item.taskId || null;
    const toolUseId = (event && event.tool_use_id) || item.toolUseId || null;
    if (taskId) {
      item.taskId = taskId;
      state._tasks.set(taskId, item);
    }
    if (toolUseId) {
      item.toolUseId = toolUseId;
      state._tasks.set(toolUseId, item);
    }
    return item;
  }

  function taskItemFor(state, event) {
    const taskId = event.task_id || null;
    const toolUseId = event.tool_use_id || null;
    let item = (taskId && state._tasks.get(taskId))
      || (toolUseId && state._tasks.get(toolUseId))
      || (toolUseId && state._tools.get(toolUseId))
      || null;
    if (!item) {
      const id = taskId || toolUseId || event.uuid || `${Date.now()}:${state.items.length}`;
      item = itemFor(state, `task:${id}`, {
        type: 'task', taskId, toolUseId, title: '后台任务', detail: '', status: 'running'
      });
    }
    item.type = 'task';
    return rememberTask(state, item, event);
  }

  function hasRunningBackgroundTasks(state) {
    return state.items.some((item) => (
      item.type === 'task' && (item.status === 'running' || item.status === 'preparing')
    ));
  }

  function isAsyncLaunch(event, block, resultCount) {
    const structured = event.tool_use_result || event.toolUseResult || {};
    const text = resultText(block);
    return (resultCount === 1 && (
      structured.isAsync === true || structured.status === 'async_launched'
    ))
      || /Async agent launched successfully/i.test(text);
  }

  function activeCompaction(state) {
    for (let index = state.items.length - 1; index >= 0; index -= 1) {
      const item = state.items[index];
      if (item.type === 'compact' && (item.status === 'running' || item.status === 'preparing')) return item;
    }
    return null;
  }

  function compactionMetadata(event) {
    const raw = event.compactMetadata || event.compact_metadata || {};
    const metadata = {};
    if (raw.trigger) metadata.trigger = String(raw.trigger);
    const fields = [
      ['preTokens', raw.preTokens ?? raw.pre_tokens],
      ['postTokens', raw.postTokens ?? raw.post_tokens],
      ['durationMs', raw.durationMs ?? raw.duration_ms],
      ['cumulativeDroppedTokens', raw.cumulativeDroppedTokens ?? raw.cumulative_dropped_tokens],
    ];
    for (const [key, value] of fields) {
      const count = tokenCount(value);
      if (count != null) metadata[key] = count;
    }
    return metadata;
  }

  function tokenCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
  }

  function formatTokenCount(value) {
    const count = tokenCount(value);
    return count == null ? '' : count.toLocaleString('zh-CN');
  }

  function compactionDetail(metadata) {
    const preTokens = tokenCount(metadata.preTokens ?? metadata.pre_tokens);
    const postTokens = tokenCount(metadata.postTokens ?? metadata.post_tokens);
    if (preTokens != null && postTokens != null) {
      return `${formatTokenCount(preTokens)} → ${formatTokenCount(postTokens)} Token`;
    }
    const droppedTokens = tokenCount(metadata.cumulativeDroppedTokens ?? metadata.cumulative_dropped_tokens);
    return droppedTokens == null ? '' : `已释放 ${formatTokenCount(droppedTokens)} Token`;
  }

  function streamMessageId(state, wrapper, raw) {
    if (raw.type === 'message_start' && raw.message && raw.message.id) {
      state._currentMessageId = raw.message.id;
      state._messageSequence += 1;
    }
    return state._currentMessageId || (wrapper && wrapper.uuid) || `message-${state._messageSequence}`;
  }

  function ingestStream(state, wrapper) {
    const raw = wrapper.event || {};
    rememberKind(state, `stream:${raw.delta && raw.delta.type ? raw.delta.type : raw.type || 'unknown'}`);
    const messageId = streamMessageId(state, wrapper, raw);

    if (raw.type === 'content_block_start') {
      const block = raw.content_block || {};
      const key = `${messageId}:${raw.index}`;
      const record = { key, messageId, index: raw.index, type: block.type, text: '', json: '', id: block.id || null, item: null };
      state._blocks.set(key, record);
      if (block.type === 'thinking') {
        record.text = block.thinking || '';
        record.item = itemFor(state, `thinking:${key}`, {
          type: 'thinking', status: 'running', title: record.text || '正在思考…', detail: ''
        });
      } else if (block.type === 'tool_use') {
        const label = friendlyTool(block.name, block.input);
        record.item = itemFor(state, block.id || `tool:${key}`, {
          type: 'tool', toolUseId: block.id || null, toolName: block.name || '工具',
          input: clone(block.input || {}), inputJson: '', status: 'preparing', ...label
        });
        if (block.id) state._tools.set(block.id, record.item);
      }
      return;
    }

    if (raw.type === 'content_block_delta') {
      const key = `${messageId}:${raw.index}`;
      const record = state._blocks.get(key);
      if (!record) return;
      const delta = raw.delta || {};
      if (delta.type === 'thinking_delta') {
        record.text += delta.thinking || '';
        if (record.item) Object.assign(record.item, { title: record.text || '正在思考…', status: 'running' });
      } else if (delta.type === 'input_json_delta' && record.item) {
        record.json += delta.partial_json || '';
        record.item.inputJson = record.json;
        try {
          record.item.input = JSON.parse(record.json);
          Object.assign(record.item, friendlyTool(record.item.toolName, record.item.input));
        } catch (_) { /* partial JSON is intentionally invalid until block_stop */ }
      }
      return;
    }

    if (raw.type === 'content_block_stop') {
      const key = `${messageId}:${raw.index}`;
      const record = state._blocks.get(key);
      if (!record) return;
      if (record.type === 'thinking' && record.item) {
        Object.assign(record.item, { title: record.text || '完成思考', status: 'success', endedAt: Date.now() });
      } else if (record.type === 'tool_use' && record.item) {
        try { record.item.input = JSON.parse(record.json || '{}'); }
        catch (_) { record.item.inputParseError = true; }
        Object.assign(record.item, friendlyTool(record.item.toolName, record.item.input), { status: 'running' });
      }
      return;
    }

    if (raw.type === 'error') {
      const error = raw.error || {};
      itemFor(state, `stream-error:${wrapper.uuid || Date.now()}`, {
        type: 'status', status: 'error', title: error.type || '流式响应出错', detail: error.message || '', endedAt: Date.now()
      });
    }
  }

  function reconcileAssistant(state, event) {
    const message = event.message || {};
    if (event.subagent_type && event.parent_tool_use_id) {
      // 新版 CLI 会把子 Agent 的完整 assistant 回合作为顶层事件透出。
      // 普通对话不应把它混进主助手最终回答；将正文归入对应后台任务的详情，
      // 等完成通知到达后再由主助手继续汇总。
      const item = taskItemFor(state, { tool_use_id: event.parent_tool_use_id });
      const text = (message.content || [])
        .filter((block) => block && block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('');
      if (text) {
        item.result = trimText(
          item.result ? `${item.result}\n\n${text}` : text,
          MAX_RESULT_CHARS
        );
        item.detail = '子 Agent 已返回，等待主任务汇总';
      }
      item.status = 'running';
      item.endedAt = null;
      state.phase = 'running';
      state.endedAt = null;
      return;
    }
    for (const block of (message.content || [])) {
      if (block.type === 'tool_use') {
        let item = block.id ? state._tools.get(block.id) : null;
        if (!item) {
          const label = friendlyTool(block.name, block.input);
          item = itemFor(state, block.id || `tool:${message.id || event.uuid}:${state.items.length}`, {
            type: 'tool', toolUseId: block.id || null, toolName: block.name || '工具',
            input: clone(block.input || {}), status: 'running', ...label
          });
          if (block.id) state._tools.set(block.id, item);
        } else {
          item.input = clone(block.input || item.input || {});
          Object.assign(item, friendlyTool(block.name || item.toolName, item.input));
          if (item.status === 'preparing') item.status = 'running';
        }
      } else if (block.type === 'thinking') {
        const text = block.thinking || '';
        if (!text) continue;
        const existing = state.items.find((item) => item.type === 'thinking' && item.title === text);
        if (!existing) {
          itemFor(state, `thinking:${message.id || event.uuid}:${state.items.length}`, {
            type: 'thinking', status: 'success', title: text, detail: '', endedAt: Date.now()
          });
        }
      }
    }
  }

  function ingestToolProgress(state, event) {
    let item = state._tools.get(event.tool_use_id);
    if (!item) {
      const label = friendlyTool(event.tool_name, {});
      item = itemFor(state, event.tool_use_id || `tool-progress:${event.uuid || Date.now()}`, {
        type: 'tool', toolUseId: event.tool_use_id || null, toolName: event.tool_name || '工具',
        input: {}, status: 'running', ...label
      });
      if (event.tool_use_id) state._tools.set(event.tool_use_id, item);
    }
    item.status = 'running';
    item.elapsedMs = Math.round(Number(event.elapsed_time_seconds || 0) * 1000);
    if (event.task_id) item.taskId = event.task_id;
  }

  function ingestUser(state, event) {
    const content = event.message && event.message.content;
    if (!Array.isArray(content)) return;
    const resultCount = content.filter((block) => block && block.type === 'tool_result').length;
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      let item = state._tools.get(block.tool_use_id);
      if (!item) {
        item = itemFor(state, block.tool_use_id || `tool-result:${event.uuid || Date.now()}`, {
          type: 'tool', toolUseId: block.tool_use_id || null, toolName: '工具',
          title: '工具执行', detail: '', input: {}
        });
        if (block.tool_use_id) state._tools.set(block.tool_use_id, item);
      }
      // Unwrap nested MCP envelopes before truncating. Otherwise a long
      // {"response":"..."} payload is cut into invalid JSON and cannot restore
      // source line endings when reopened from history.
      item.structuredResult = redact(event.tool_use_result);
      if (!block.is_error && isAsyncLaunch(event, block, resultCount)) {
        // Agent 的首个 tool_result 只是后台启动回执，并不是任务已经成功。
        // 保持运行态，等待 task_progress / task_notification 在同一行原位更新。
        item.type = 'task';
        item.result = '';
        item.error = '';
        item.status = 'running';
        item.detail = item.detail || '后台运行中';
        item.endedAt = null;
        rememberTask(state, item, { tool_use_id: block.tool_use_id });
        state.phase = 'running';
        state.endedAt = null;
        continue;
      }
      item.result = trimText(inspectorResultText(resultText(block)), MAX_RESULT_CHARS);
      item.status = block.is_error ? 'error' : 'success';
      item.error = block.is_error ? item.result : '';
      item.endedAt = Date.now();
      if (!item.elapsedMs) item.elapsedMs = Math.max(1, item.endedAt - item.startedAt);
    }
  }

  function ingestSystem(state, event) {
    if (event.subtype === 'init') {
      state.session = {
        id: event.session_id || null,
        model: event.model || null,
        version: event.claude_code_version || null,
        cwd: event.cwd || null,
        tools: clone(event.tools || []),
        mcpServers: clone(event.mcp_servers || [])
      };
      return;
    }
    if (event.subtype === 'permission_denied') {
      const item = state._tools.get(event.tool_use_id);
      if (item) Object.assign(item, {
        status: 'error', error: event.message || event.decision_reason || '权限被拒绝',
        result: event.message || event.decision_reason || '', endedAt: Date.now()
      });
      return;
    }
    if (event.subtype === 'task_started') {
      const item = taskItemFor(state, event);
      Object.assign(item, {
        type: 'task',
        title: event.description || item.title || '后台任务',
        detail: event.summary || event.task_type || item.detail || '',
        status: 'running',
        endedAt: null,
      });
      state.phase = 'running';
      state.endedAt = null;
      return;
    }
    if (event.subtype === 'task_progress') {
      const item = taskItemFor(state, event);
      Object.assign(item, {
        title: event.description || item.title || '后台任务',
        detail: event.summary || (event.last_tool_name ? `正在调用 ${event.last_tool_name}` : item.detail || ''),
        status: 'running', elapsedMs: event.usage && event.usage.duration_ms,
        usage: clone(event.usage || null), endedAt: null,
      });
      state.phase = 'running';
      state.endedAt = null;
      return;
    }
    if (event.subtype === 'task_updated') {
      const item = taskItemFor(state, event);
      if (item && event.patch) {
        if (event.patch.status) item.status = event.patch.status === 'completed' ? 'success' : (event.patch.status === 'failed' || event.patch.status === 'killed') ? 'error' : 'running';
        if (event.patch.description) item.title = event.patch.description;
        if (event.patch.error) item.error = event.patch.error;
        if (event.patch.end_time) item.endedAt = event.patch.end_time;
      }
      if (item.status === 'running' || item.status === 'preparing') {
        state.phase = 'running';
        state.endedAt = null;
      }
      return;
    }
    if (event.subtype === 'task_notification') {
      const item = taskItemFor(state, event);
      const taskStatus = String(event.status || '').toLowerCase();
      const status = taskStatus === 'running' || taskStatus === 'pending'
        ? 'running'
        : (taskStatus === 'completed' || taskStatus === 'success' || taskStatus === 'succeeded')
          ? 'success'
          : 'error';
      Object.assign(item, {
        title: event.description || item.title || '后台任务',
        detail: event.summary || item.detail || '',
        result: item.result || event.summary || '',
        status,
        usage: clone(event.usage || null),
        elapsedMs: event.usage && event.usage.duration_ms,
        endedAt: status === 'running' ? null : Date.now(),
      });
      if (status === 'running') {
        state.phase = 'running';
        state.endedAt = null;
      }
      return;
    }
    if (event.subtype === 'status' && event.status === 'compacting') {
      const item = activeCompaction(state) || itemFor(state, `compact:${event.uuid || Date.now()}`);
      Object.assign(item, {
        type: 'compact', status: 'running', title: '正在压缩对话上下文', detail: '',
        startedAt: item.startedAt || Date.now(), endedAt: null
      });
      return;
    }
    if (event.subtype === 'compact_boundary') {
      const metadata = compactionMetadata(event);
      const elapsedMs = tokenCount(metadata.durationMs ?? metadata.duration_ms);
      const endedAt = Date.now();
      const activeItem = activeCompaction(state);
      const item = activeItem || itemFor(state, `compact:${event.uuid || endedAt}`);
      Object.assign(item, {
        type: 'compact',
        status: 'success',
        title: '已压缩对话上下文',
        detail: compactionDetail(metadata),
        compaction: metadata,
        elapsedMs,
        startedAt: activeItem && activeItem.startedAt
          ? activeItem.startedAt
          : (elapsedMs ? endedAt - elapsedMs : endedAt),
        endedAt,
      });
      return;
    }
  }

  function compactResult(event) {
    return {
      subtype: event.subtype || null,
      durationMs: Number(event.duration_ms || 0),
      durationApiMs: Number(event.duration_api_ms || 0),
      isError: Boolean(event.is_error),
      turns: Number(event.num_turns || 0),
      stopReason: event.stop_reason || null,
      costUsd: Number(event.total_cost_usd || 0),
      usage: clone(event.usage || null),
      ttftMs: Number(event.ttft_ms || 0),
      terminalReason: event.terminal_reason || null,
      errors: clone(event.errors || []),
      permissionDenials: clone(event.permission_denials || [])
    };
  }

  function ingest(state, event) {
    if (!state || !event) return state;
    state.received += 1;
    if (state.phase === 'idle') state.phase = 'running';
    rememberKind(state, event.type);

    if (event.type === 'system') ingestSystem(state, event);
    else if (event.type === 'stream_event') ingestStream(state, event);
    else if (event.type === 'assistant') reconcileAssistant(state, event);
    else if (event.type === 'tool_progress') ingestToolProgress(state, event);
    else if (event.type === 'user') ingestUser(state, event);
    else if (event.type === 'result') {
      state.result = compactResult(event);
      const failed = event.is_error || event.subtype && event.subtype !== 'success';
      state.error = failed ? (event.errors || []).join('\n') || event.result || '执行出错' : null;
      if (failed) {
        state.phase = 'error';
        state.endedAt = Date.now();
      } else if (hasRunningBackgroundTasks(state)) {
        // 后台 Agent 启动后产生的 result 只是阶段性回合结束。主进程仍在监听，
        // 活动流也必须保持运行态，不能提前显示“已处理”并自动折叠。
        state.phase = 'running';
        state.endedAt = null;
      } else {
        state.phase = 'complete';
        state.endedAt = Date.now();
      }
    } else if (event.type === 'rate_limit_event') {
      const info = event.rate_limit_info || {};
      if (info.status !== 'allowed') itemFor(state, `rate:${event.uuid || Date.now()}`, {
        type: 'status', status: info.status === 'rejected' ? 'error' : 'running',
        title: info.status === 'rejected' ? '请求受到速率限制' : '即将达到速率限制',
        detail: info.resetsAt ? `恢复时间 ${new Date(info.resetsAt).toLocaleTimeString()}` : ''
      });
    }
    return state;
  }

  function finish(state, error) {
    if (!state) return;
    if (error) {
      state.phase = 'error';
      state.error = String(error);
    } else if (state.phase === 'running' || state.phase === 'idle') {
      state.phase = 'complete';
    }
    state.endedAt = state.endedAt || Date.now();
    for (const item of state.items) {
      if (item.status === 'preparing' || item.status === 'running') {
        item.status = error ? 'error' : 'success';
        if (item.type === 'compact') {
          item.title = error ? '上下文压缩未完成' : '已压缩对话上下文';
        }
        item.endedAt = item.endedAt || state.endedAt;
      }
    }
  }

  function fromLegacy(thinking) {
    const state = createState({ phase: 'complete', startedAt: null, endedAt: null });
    const text = String(thinking || '').trim();
    if (!text) return state;
    const segments = text.split(/\n*-{2,}\s*下一段思考\s*-{2,}\n*/);
    let index = 0;
    for (const segment of segments) {
      const value = segment.trim();
      if (!value) continue;
      const tool = value.match(/^\[调用工具:\s*(.+)\]$/);
      if (tool) {
        const label = friendlyTool(tool[1], {});
        state.items.push({
          id: `legacy-tool:${index++}`, type: 'tool', toolName: tool[1], toolUseId: null,
          input: {}, result: '', status: 'success', ...label
        });
      } else {
        state.items.push({ id: `legacy-thinking:${index++}`, type: 'thinking', title: value, detail: '', status: 'success' });
      }
    }
    return state;
  }

  function iconFor(item) {
    if (item.status === 'running' || item.status === 'preparing') return '<span class="process-spinner"></span>';
    if (item.status === 'error') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="m9 9 6 6m0-6-6 6"/></svg>';
    if (item.type === 'thinking') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18h6M10 22h4"/><path d="M8.2 14.5A7 7 0 1 1 15.8 14.5C14.7 15.3 14 16 14 18h-4c0-2-.7-2.7-1.8-3.5Z"/></svg>';
    if (item.type === 'task') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01"/></svg>';
    if (item.type === 'compact') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 17h16M9 3l3 4 3-4M9 21l3-4 3 4"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m5 12 4 4L19 6"/></svg>';
  }

  function hasInspectorValue(value) {
    if (value == null) return false;
    if (typeof value === 'string') return Boolean(value.trim());
    if (Array.isArray(value)) return value.some(hasInspectorValue);
    if (typeof value === 'object') return Object.values(value).some(hasInspectorValue);
    return true;
  }

  function inspectorInputText(item) {
    const input = item.input || {};
    if (typeof input === 'string') return normalizeInspectorText(input);
    if ((item.toolName === 'Bash' || item.toolName === 'PowerShell') && input.command) {
      return trimText(input.command, MAX_INPUT_CHARS);
    }
    return safeJson(input);
  }

  function normalizeInspectorText(value) {
    let text = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
    // Some CLI/tool results arrive as transport text with line endings escaped a
    // second time ("\\r\\n" instead of an actual newline). Decode layout escapes
    // only when the text clearly looks serialized, so ordinary Windows paths and
    // source-code backslashes keep their original meaning.
    const escapedCrLf = (text.match(/\\r\\n/g) || []).length;
    const escapedLf = (text.match(/\\n/g) || []).length;
    const hasRealLineBreak = text.includes('\n');
    if (escapedCrLf > 0) {
      text = text.replace(/\\r\\n/g, '\n').replace(/\\t/g, '\t');
    } else if (!hasRealLineBreak && escapedLf >= 2) {
      text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    return text;
  }

  function parseJsonText(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return { parsed: false, value: text };
    const first = text[0];
    const last = text[text.length - 1];
    if (!((first === '{' && last === '}') || (first === '[' && last === ']') || (first === '"' && last === '"'))) {
      return { parsed: false, value: text };
    }
    try { return { parsed: true, value: JSON.parse(text) }; }
    catch (_) { return { parsed: false, value: text }; }
  }

  function unwrapTruncatedWrapper(value) {
    const text = String(value == null ? '' : value);
    const match = text.match(/^\s*\{\s*"(?:response|result|content|output|text|body|payload)"\s*:\s*"/i);
    if (!match) return { matched: false, value: text };
    let encoded = text.slice(match[0].length);
    // trimText adds the first real newline after the serialized value. Escaped
    // source line endings are two visible characters (\\n), so this is safe.
    const truncationMarker = encoded.indexOf('\n');
    if (truncationMarker >= 0) encoded = encoded.slice(0, truncationMarker);
    encoded = encoded.replace(/"\s*}\s*$/, '');
    while (/(^|[^\\])(?:\\\\)*\\$/.test(encoded)) encoded = encoded.slice(0, -1);
    try { return { matched: true, value: JSON.parse(`"${encoded}"`) }; }
    catch (_) {
      return {
        matched: true,
        value: normalizeInspectorText(encoded.replace(/\\"/g, '"').replace(/\\\\/g, '\\')),
      };
    }
  }

  function unwrapInspectorPayload(value) {
    let current = value;
    const wrapperKeys = new Set(['response', 'result', 'content', 'output', 'text', 'body', 'payload']);
    for (let depth = 0; depth < 4; depth += 1) {
      if (typeof current === 'string') {
        const normalized = normalizeInspectorText(current).trim();
        const nested = parseJsonText(normalized);
        if (!nested.parsed) return normalized;
        current = nested.value;
        continue;
      }
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        const keys = Object.keys(current);
        if (keys.length === 1 && wrapperKeys.has(keys[0].toLowerCase())) {
          current = current[keys[0]];
          continue;
        }
      }
      break;
    }
    return current;
  }

  function inspectorResultText(value) {
    let initial = value;
    if (!(value && typeof value === 'object')) {
      const parsed = parseJsonText(value);
      const recovered = parsed.parsed ? null : unwrapTruncatedWrapper(value);
      initial = parsed.parsed ? parsed.value : (recovered.matched ? recovered.value : parsed.value);
    }
    const display = redact(unwrapInspectorPayload(initial));
    if (display == null) return '';
    if (typeof display === 'string') return normalizeInspectorText(display).trim();
    try { return JSON.stringify(display, null, 2); }
    catch (_) { return normalizeInspectorText(display); }
  }

  function looksLikeMarkdown(text) {
    const value = String(text || '').trim();
    if (!value || value.startsWith('{') || value.startsWith('[')) return false;
    const signals = [
      /^\s{0,3}#{1,6}\s+\S/m,
      /^\s{0,3}(?:[-*+] |\d+[.)]\s+)\S/m,
      /^\s{0,3}>\s+\S/m,
      /(^|\n)\s*```[\w-]*\s*(?:\n|$)/,
      /\*\*[^*\n]+\*\*/,
      /^\s*\|.+\|\s*\n\s*\|?\s*:?-{3,}/m,
    ];
    return signals.filter((pattern) => pattern.test(value)).length >= 2;
  }

  function markdownFileInput(item) {
    const input = item && item.input && typeof item.input === 'object' ? item.input : {};
    const path = input.file_path || input.path || '';
    return /\.(?:md|mdx|markdown)$/i.test(String(path));
  }

  function stripReadLineNumbers(text) {
    return String(text || '').split('\n').map((line) => (
      line.replace(/^\s*\d+(?:→|\t|\s{2,})/, '')
    )).join('\n');
  }

  function inspectorSectionContent(item, content, kind) {
    let text = String(content == null ? '' : content);
    if (kind === 'result' && markdownFileInput(item)) {
      text = stripReadLineNumbers(text);
      return { text, format: 'markdown' };
    }
    if (kind === 'result' && looksLikeMarkdown(text)) return { text, format: 'markdown' };
    if (kind === 'input' && typeof item.input === 'string' && looksLikeMarkdown(text)) return { text, format: 'markdown' };
    return { text, format: 'code' };
  }

  function inspectSection(label, content, kind, item) {
    const display = inspectorSectionContent(item, content, kind);
    const body = display.format === 'markdown'
      ? `<div class="process-inspect-markdown">${renderThinkingMarkdown(display.text)}</div>`
      : `<pre class="process-inspect-code">${escapeHtml(display.text)}</pre>`;
    return `<section class="process-inspect-section${kind ? ` is-${kind}` : ''}">
      <div class="process-inspect-label">${escapeHtml(label)}</div>
      ${body}
    </section>`;
  }

  function renderInspector(item) {
    if (item.type !== 'tool' && item.type !== 'task') return '';
    const blocks = [];
    if (item.type === 'tool' && hasInspectorValue(item.input)) {
      blocks.push(inspectSection('输入', inspectorInputText(item), 'input', item));
    }
    if (item.result || item.error) {
      blocks.push(inspectSection(item.status === 'error' ? '错误' : '结果', trimText(inspectorResultText(item.error || item.result), MAX_RESULT_CHARS), item.status === 'error' ? 'error' : 'result', item));
    }
    if (item.usage) blocks.push(inspectSection('用量', safeJson(item.usage, 2000), 'usage', item));
    if (!blocks.length) return '';
    return `<div class="process-inspector">${blocks.join('')}</div>`;
  }

  function renderThinkingMarkdown(value) {
    const text = String(value == null ? '' : value);
    if (typeof window.relayRenderMarkdown === 'function') {
      try { return window.relayRenderMarkdown(text); }
      catch (_) { /* fall through to escaped plain text */ }
    }
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  function renderItem(item, expanded) {
    const hasDetails = item.type === 'thinking' || hasInspectorValue(item.input) || Boolean(item.result || item.error || item.usage);
    const inspectable = (item.type === 'tool' || item.type === 'task' || item.type === 'thinking') && hasDetails;
    const className = ['process-item', `is-${item.type || 'status'}`, `is-${item.status || 'success'}`, inspectable ? 'is-inspectable' : '', expanded ? 'is-expanded' : ''].filter(Boolean).join(' ');
    const titleText = item.title || (item.type === 'thinking' ? '正在思考…' : '处理中');
    const badge = item.toolName ? `<span class="process-tool-name">${escapeHtml(item.toolName)}</span>` : (item.type === 'task' ? '<span class="process-tool-name">Task</span>' : '');
    const detail = item.detail ? `<span class="process-item-detail">${escapeHtml(item.detail)}</span>` : '';
    const caret = item.type === 'thinking' && (item.status === 'running' || item.status === 'preparing') ? '<span class="process-caret"></span>' : '';
    const title = item.type === 'thinking'
      ? `<div class="process-item-markdown">${renderThinkingMarkdown(titleText)}${caret}</div>`
      : `${escapeHtml(titleText)}${caret}${badge}`;
    return `<div class="${className}" data-process-id="${escapeHtml(item.id)}">
      <span class="process-item-icon">${iconFor(item)}</span>
      <div class="process-item-main"><div class="process-item-title">${title}</div>${detail}</div>
      ${renderInspector(item)}
    </div>`;
  }

  function summaryFor(state) {
    const failed = state.items.filter((item) => item.status === 'error').length;
    if (state.phase === 'error') return { title: '处理未完成', meta: failed ? `· ${failed} 项失败` : '' };
    if (state.phase === 'complete') {
      const duration = state.result && state.result.durationMs
        ? `${(state.result.durationMs / 1000).toFixed(1)} 秒`
        : state.startedAt && state.endedAt ? `${((state.endedAt - state.startedAt) / 1000).toFixed(1)} 秒` : '';
      return { title: `已处理 ${state.items.length} 项活动`, meta: duration ? `· ${duration}` : '' };
    }
    if (state.items.some((item) => item.status === 'running' || item.status === 'preparing')) {
      return { title: '正在处理', meta: failed ? `· ${failed} 项失败，已继续` : `· ${state.received} 个事件` };
    }
    return { title: '正在准备 AI 助手', meta: state.received ? `· ${state.received} 个事件` : '· 刚刚' };
  }

  function itemSignature(item, expanded) {
    try { return JSON.stringify([item, Boolean(expanded)]); }
    catch (_) { return `${item.id}:${item.status}:${item.title}:${Boolean(expanded)}`; }
  }

  // Keep completed DOM rows stable. Only the row whose data actually changed is replaced;
  // this prevents thinking_delta from replaying every completed row's enter animation.
  function syncItemElements(container, items, expanded) {
    const existing = new Map();
    for (const row of Array.from(container.children)) existing.set(row.dataset.processId, row);
    const seen = new Set();
    for (const item of items) {
      const isExpanded = expanded.has(item.id);
      const signature = itemSignature(item, isExpanded);
      let row = existing.get(item.id);
      seen.add(item.id);
      if (row && row._processSignature === signature) continue;

      const template = document.createElement('template');
      template.innerHTML = renderItem(item, isExpanded).trim();
      const nextRow = template.content.firstElementChild;
      if (!nextRow) continue;
      nextRow._processSignature = signature;
      if (row) {
        nextRow.classList.add('is-refreshing');
        row.replaceWith(nextRow);
      } else {
        container.appendChild(nextRow);
      }
    }
    for (const [id, row] of existing) {
      if (!seen.has(id)) row.remove();
    }
  }

  function updateElement(element, state, options) {
    if (!element || !state) return element;
    const opts = options || {};
    const previousPhase = element.dataset.phase;
    const summary = summaryFor(state);
    const expanded = element._processExpanded || new Set();
    element._processExpanded = expanded;
    element.dataset.phase = state.phase;
    element.classList.toggle('is-running', state.phase === 'running' || state.phase === 'idle');
    element.classList.toggle('has-error', state.items.some((item) => item.status === 'error'));
    element.querySelector('.process-summary-title').textContent = summary.title;
    element.querySelector('.process-summary-meta').textContent = summary.meta;
    syncItemElements(element.querySelector('.process-items'), state.items, expanded);
    if (!element.dataset.userToggled && state.phase !== 'running' && previousPhase === 'running' && opts.collapseOnComplete !== false) {
      element.classList.add('is-collapsed');
      element.querySelector('.process-summary').setAttribute('aria-expanded', 'false');
    }
    return element;
  }

  function createElement(state, options) {
    const opts = options || {};
    const element = document.createElement('div');
    element.className = 'process-stream';
    if (opts.collapsed) element.classList.add('is-collapsed');
    element.innerHTML = `
      <button class="process-summary" type="button" aria-expanded="${opts.collapsed ? 'false' : 'true'}">
        <span class="process-summary-mark"></span>
        <span class="process-summary-title"></span>
        <span class="process-summary-meta"></span>
        <svg class="process-summary-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7 9 5 5 5-5"/></svg>
      </button>
      <div class="process-items"></div>`;
    element._processExpanded = new Set();
    element.addEventListener('click', (event) => {
      const summaryButton = event.target.closest('.process-summary');
      if (summaryButton) {
        element.classList.toggle('is-collapsed');
        element.dataset.userToggled = '1';
        summaryButton.setAttribute('aria-expanded', String(!element.classList.contains('is-collapsed')));
        return;
      }
      const row = event.target.closest('.is-inspectable');
      if (!row) return;
      const id = row.dataset.processId;
      if (element._processExpanded.has(id)) element._processExpanded.delete(id);
      else element._processExpanded.add(id);
      row.classList.toggle('is-expanded', element._processExpanded.has(id));
    });
    return updateElement(element, state, opts);
  }

  window.RelayActivity = {
    VERSION,
    createState,
    ingest,
    finish,
    serialize: publicSnapshot,
    hydrate: createState,
    fromLegacy,
    createElement,
    updateElement,
  };
})();
