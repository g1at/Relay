// Claude Code stream-json -> Relay structured activity stream.
// Kept independent from app.js so live rendering and history restoration share one data model.
(function (window) {
  'use strict';

  const VERSION = 9;
  const continuity = window.RelayTaskContinuity || (typeof module === 'object' && module.exports ? require('./task-continuity') : null);
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

  function taskResources(event) {
    const links = Array.isArray(event.resource_links) ? event.resource_links : [];
    const candidates = links.slice(0, 50).map(link => ({ uri: link && link.uri, name: link && (link.title || link.name) }));
    // SDK output_file is the task's internal transcript, not a user deliverable.
    // It stays in the host resource registry for the model, without a UI link.
    const outputFile = typeof event.output_file === 'string' ? event.output_file.trim() : '';
    const seen = new Set(), resources = [];
    for (const candidate of candidates) {
      const uri = typeof candidate.uri === 'string' ? candidate.uri.trim() : '';
      if (!uri || uri === outputFile || uri.length > 4096 || /[\u0000-\u001f\u007f]/.test(uri) || seen.has(uri)) continue;
      let kind = 'resource';
      if (/^(?:[a-z]:[\\/]|\/|\\\\|file:\/\/)/i.test(uri)) kind = 'file';
      else if (/^https?:\/\//i.test(uri)) {
        try { const parsed = new URL(uri); if (parsed.username || parsed.password) continue; } catch (_) { continue; }
        kind = 'url';
      } else if (!/^[a-z][a-z\d+.-]*:/i.test(uri) || /^(?:javascript|vbscript|data|blob|shell):/i.test(uri)) continue;
      seen.add(uri);
      resources.push({ uri, kind, name: String(candidate.name || basename(uri)).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) });
    }
    return resources;
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

  function hasToolResultReceipt(item) {
    if (typeof item.resultConfirmed === 'boolean') return item.resultConfirmed;
    // Older snapshots predate the explicit marker. An empty result is still a
    // real receipt; neither a streamed tool name nor parent success is one.
    return Object.prototype.hasOwnProperty.call(item, 'result') && item.result != null
      || Boolean(item.resultMessageUuids?.length || item.structuredResult != null || item.error);
  }

  function restoreUnconfirmedTools(state, saved) {
    if (Number(saved.version || 0) >= VERSION || state.phase !== 'complete' || !Number.isFinite(state.endedAt)) return;
    for (const item of state.items) {
      // v8 finish assigned success and the same end time to orphaned stream
      // previews. Repair only that signature on this cloned display state.
      if (item.type !== 'tool' || item.status !== 'success' || item.outputOwned
          || Number(item.contextEpoch || 0) !== state.contextEpoch
          || typeof item.sourceMessageId !== 'string' || !item.sourceMessageId
          || Object.prototype.hasOwnProperty.call(item, 'sourceMessageUuids')
          || item.endedAt !== state.endedAt
          || ['resultConfirmed', 'result', 'error', 'structuredResult', 'resultMessageUuids']
            .some(key => Object.prototype.hasOwnProperty.call(item, key))) continue;
      item.status = 'unconfirmed';
    }
  }

  function createState(initial) {
    const saved = initial || {};
    const state = {
      version: VERSION,
      phase: saved.phase || 'running',
      startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt
        : Object.prototype.hasOwnProperty.call(saved, 'startedAt') || /^(complete|error)$/.test(saved.phase) ? null : Date.now(),
      endedAt: Number.isFinite(saved.endedAt) ? saved.endedAt : null,
      taskStartedAt: Number.isFinite(saved.taskStartedAt) ? saved.taskStartedAt : null,
      taskFinishedAt: Number.isFinite(saved.taskFinishedAt) ? saved.taskFinishedAt : null,
      taskDurationMs: Number.isFinite(saved.taskDurationMs) ? saved.taskDurationMs : null,
      taskRun: continuity?.normalize(saved.taskRun) || null,
      hasWork: Boolean(saved.hasWork || saved.result || saved.items && saved.items.length),
      received: Number(saved.received || 0),
      session: clone(saved.session || null),
      // Preparation is presentation state, not a synthetic thinking/tool event.
      // Persist its phase so switching away during the first-response wait does
      // not turn a settled connection check into a completed task indicator.
      startupPhase: /^(complete|error)$/.test(saved.phase) ? null : Object.prototype.hasOwnProperty.call(saved, 'startupPhase')
        ? (['preparing', 'waiting'].includes(saved.startupPhase) ? saved.startupPhase : null)
        : saved.hasWork || saved.result || saved.items?.some(item => /^(thinking|tool|task|narration)$/.test(item.type))
          ? null : saved.session ? 'waiting' : 'preparing',
      // 旧版把长命令每 30 秒的 synthetic heartbeat 当成独立 Bash 行持久化。
      // 这些行没有输入也永远没有 tool_result，恢复历史时直接丢弃。
      items: clone(Array.isArray(saved.items)
        ? saved.items.filter((item) => !(
          item && item.type === 'tool' && /-heartbeat-\d+$/.test(String(item.toolUseId || item.id || ''))
        ) && !(item && item.ambient === true))
        : []),
      result: clone(saved.result || null),
      error: saved.error || null,
      eventKinds: Array.isArray(saved.eventKinds) ? [...saved.eventKinds] : [],
      retractedMessageUuids: [...new Set(saved.retractedMessageUuids || [])],
      retractedToolIds: [...new Set(saved.retractedToolIds || [])],
      contextEpoch: Number(saved.contextEpoch || 0),
      contextResetUuids: [...new Set(saved.contextResetUuids || [])],
      _blocks: new Map(),
      _tools: new Map(),
      _tasks: new Map(),
      _ambientTasks: new Set(),
      _currentMessageId: null,
      _messageSequence: 0,
      _currentOrder: 0,
    };
    restoreUnconfirmedTools(state, saved);
    for (const item of state.items) {
      if (Number(item.contextEpoch || 0) !== state.contextEpoch) continue;
      if (item.type === 'tool' && item.toolUseId) state._tools.set(item.toolUseId, item);
      if (item.type === 'task') {
        if (item.taskId) state._tasks.set(item.taskId, item);
        if (item.toolUseId) state._tasks.set(item.toolUseId, item);
      }
    }
    const cursor = saved.streamCursor;
    if (cursor && typeof cursor === 'object') {
      state._currentMessageId = typeof cursor.currentMessageId === 'string' ? cursor.currentMessageId : null;
      state._messageSequence = Number.isSafeInteger(cursor.messageSequence) ? cursor.messageSequence : 0;
      state._currentOrder = Number.isFinite(cursor.currentOrder) ? cursor.currentOrder : 0;
      state._ambientTasks = new Set(Array.isArray(cursor.ambientTasks) ? cursor.ambientTasks : []);
      const items = new Map(state.items.map(item => [item.id, item]));
      for (const savedBlock of Array.isArray(cursor.blocks) ? cursor.blocks : []) {
        if (!savedBlock || typeof savedBlock.key !== 'string' || savedBlock.messageId !== state._currentMessageId) continue;
        const { itemId, ...block } = savedBlock;
        const item = items.get(itemId) || null;
        if (item && block.json) item.inputJson = block.json;
        state._blocks.set(block.key, { ...block, item });
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
      taskStartedAt: state.taskStartedAt,
      taskFinishedAt: state.taskFinishedAt,
      taskDurationMs: state.taskDurationMs,
      taskRun: continuity?.normalize(state.taskRun) || null,
      hasWork: state.hasWork,
      received: state.received,
      session: clone(state.session),
      startupPhase: state.startupPhase,
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
      retractedMessageUuids: [...state.retractedMessageUuids],
      retractedToolIds: [...state.retractedToolIds],
      contextEpoch: state.contextEpoch,
      contextResetUuids: [...state.contextResetUuids],
      // Crash checkpoints can occur in the middle of a thinking/tool block.
      // Preserve only the current message's parser cursor, referencing the
      // public items by ID so hydration continues the same row after replay.
      ...(state.phase === 'running' ? { streamCursor: {
        currentMessageId: state._currentMessageId,
        messageSequence: state._messageSequence,
        currentOrder: state._currentOrder,
        ambientTasks: [...state._ambientTasks],
        blocks: [...state._blocks.values()].filter(block => block.messageId === state._currentMessageId)
          .map(({ item, ...block }) => ({ ...block, itemId: item?.id || null })),
      } } : {}),
    };
  }

  function rememberKind(state, kind) {
    if (kind && !state.eventKinds.includes(kind)) state.eventKinds.push(kind);
  }

  function isChildEvent(event) {
    return Boolean(event.parent_tool_use_id || event.parentToolUseId || event.agent_id || event.subagent_type);
  }

  function taskTiming(state, event, terminal = false) {
    if (!event || isChildEvent(event)) return;
    if (Number.isFinite(event.relay_task_started_at) && !Number.isFinite(state.taskStartedAt)) {
      state.taskStartedAt = event.relay_task_started_at;
    }
    // The host supplies timing corrections for this run; resume identity still
    // comes from the explicit, persisted user action.
    if (state.taskRun && event.relay_task_id === state.taskRun.taskId) {
      const timing = { ...state.taskRun };
      if (Number.isFinite(event.relay_task_started_at)) timing.rootStartedAt = event.relay_task_started_at;
      if (Number.isFinite(event.relay_task_segment_started_at)) timing.segmentStartedAt = event.relay_task_segment_started_at;
      if (Number.isFinite(event.relay_task_elapsed_before_ms)) timing.elapsedBeforeMs = event.relay_task_elapsed_before_ms;
      state.taskRun = continuity?.normalize(timing) || state.taskRun;
    }
    // Result frames report individual SDK rounds. Only job-done may freeze the
    // task clock, including preparation, retries and time waiting for children.
    if (!terminal) return;
    if (Number.isFinite(event.relay_task_finished_at)) state.taskFinishedAt = event.relay_task_finished_at;
    if (Number.isFinite(event.relay_task_duration_ms) && event.relay_task_duration_ms >= 0) {
      state.taskDurationMs = event.relay_task_duration_ms;
    }
  }

  function messageSource(item, messageId, uuid) {
    if (messageId) item.sourceMessageId = messageId;
    if (uuid) item.sourceMessageUuids = [...new Set([...(item.sourceMessageUuids || []), uuid])];
    return item;
  }

  function retractMessages(state, event) {
    const ids = event.type === 'assistant' ? event.supersedes
      : event.type === 'system' && event.subtype === 'model_refusal_fallback' ? event.retracted_message_uuids : null;
    if (!Array.isArray(ids) || !ids.length) return;
    const removed = new Set(ids.filter(id => typeof id === 'string' && id));
    state.retractedMessageUuids = [...new Set([...state.retractedMessageUuids, ...removed])];
    const retired = new Set();
    state.items = state.items.filter(item => {
      if (item.sourceMessageUuids?.some(id => removed.has(id))) {
        item.sourceMessageUuids = item.sourceMessageUuids.filter(id => !removed.has(id));
        if (!item.sourceMessageUuids.length) {
          if (item.toolUseId) state.retractedToolIds.push(item.toolUseId);
          retired.add(item); return false;
        }
      }
      if (item.resultMessageUuids?.some(id => removed.has(id))) {
        item.resultMessageUuids = item.resultMessageUuids.filter(id => !removed.has(id));
        if (!item.resultMessageUuids.length) {
          item.result = ''; item.error = ''; item.resultConfirmed = false; delete item.structuredResult;
          item.status = 'superseded'; item.detail = '本次结果已被后续响应替换';
          item.endedAt = Date.now();
        }
      }
      if (item.childResults?.some(frame => removed.has(frame.uuid))) {
        item.childResults = item.childResults.filter(frame => !removed.has(frame.uuid));
        item.result = trimText(item.childResults.map(frame => frame.text).join('\n\n'), MAX_RESULT_CHARS);
      }
      return true;
    });
    for (const map of [state._tools, state._tasks]) for (const [key, item] of map) if (retired.has(item)) map.delete(key);
    for (const [key, record] of state._blocks) if (retired.has(record.item)) state._blocks.delete(key);
    state.retractedToolIds = [...new Set(state.retractedToolIds)];
  }

  function resetContext(state, event) {
    if (event.parent_tool_use_id || event.parentToolUseId || event.agent_id || !event.new_conversation_id) return;
    if (event.uuid && state.contextResetUuids.includes(event.uuid)) return;
    if (event.uuid) state.contextResetUuids.push(event.uuid);
    state.contextEpoch += 1;
    state.session = { ...(state.session || {}), id: event.new_conversation_id };
    state.result = null; state.error = null; state.phase = 'running'; state.endedAt = null;
    // /clear and plan exit replace the runtime transcript, not Relay's visible
    // history. Finish orphaned active rows without asserting tool success.
    for (const item of state.items) if (/^(running|preparing)$/.test(item.status)) {
      item.status = 'superseded'; item.endedAt = Date.now();
    }
    state._blocks.clear(); state._tools.clear(); state._tasks.clear(); state._ambientTasks.clear();
    state._currentMessageId = null;
    itemFor(state, `context-reset:${event.uuid || state.contextEpoch}`, {
      type: 'status', status: 'success', title: '已开始新的运行上下文',
      detail: '之前的对话记录仍保留在此处', endedAt: Date.now(),
    });
  }

  function itemFor(state, id, patch) {
    state.hasWork = true;
    let item = state.items.find((candidate) => candidate.id === id);
    if (!item) {
      item = { id, type: 'status', status: 'running', title: '', detail: '', startedAt: Date.now(), order: state._currentOrder, contextEpoch: state.contextEpoch };
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

  function taskEventIds(event) {
    return [event && event.task_id, event && event.tool_use_id].filter(Boolean).map(String);
  }

  function forgetTask(state, event) {
    const ids = new Set(taskEventIds(event));
    let item = null;
    for (const id of ids) item = item || state._tasks.get(id) || state._tools.get(id) || null;
    if (!item) return;
    state.items = state.items.filter((candidate) => candidate !== item);
    for (const map of [state._tasks, state._tools]) {
      for (const [key, value] of map) {
        if (value === item || ids.has(String(key))) map.delete(key);
      }
    }
  }

  function markAmbientTask(state, event) {
    for (const id of taskEventIds(event)) state._ambientTasks.add(id);
    forgetTask(state, event);
  }

  function isAmbientTaskEvent(state, event) {
    return !!(event && event.ambient === true)
      || taskEventIds(event).some((id) => state._ambientTasks.has(id));
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
    for (const id of taskEventIds(event)) state._ambientTasks.delete(id);
    return rememberTask(state, item, event);
  }

  function isAsyncLaunch(event, block, resultCount) {
    const structured = event.tool_use_result || event.toolUseResult || {};
    const text = resultText(block);
    return (resultCount === 1 && (
      structured.isAsync === true || structured.status === 'async_launched'
      || structured.backgroundTaskId || structured.background_task_id
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
          type: 'thinking', status: 'running', title: record.text || '正在思考…', detail: '', sourceMessageId: messageId,
        });
      } else if (block.type === 'tool_use') {
        const label = friendlyTool(block.name, block.input);
        const existing = block.id && state._tools.get(block.id);
        record.item = existing && !/^(running|preparing)$/.test(existing.status) ? existing : itemFor(state, block.id || `tool:${key}`, {
          type: 'tool', toolUseId: block.id || null, toolName: block.name || '工具',
          input: clone(block.input || {}), inputJson: '', status: 'preparing', sourceMessageId: messageId, ...label
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
        if (!/^(running|preparing)$/.test(record.item.status)) return;
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
    if (isChildEvent(event)) {
      // 新版 CLI 会把子 Agent 的完整 assistant 回合作为顶层事件透出。
      // 普通对话不应把它混进主助手最终回答；将正文归入对应后台任务的详情，
      // 等完成通知到达后再由主助手继续汇总。
      const item = taskItemFor(state, { tool_use_id: event.parent_tool_use_id || event.parentToolUseId,
        task_id: event.agent_id });
      const text = (message.content || [])
        .filter((block) => block && block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('');
      if (text) {
        item.childResults = item.childResults || [];
        if (!event.uuid || !item.childResults.some(frame => frame.uuid === event.uuid)) {
          item.childResults.push({ uuid: event.uuid || null, text: trimText(text, MAX_RESULT_CHARS),
            resumed_from_incomplete_thinking: event.resumed_from_incomplete_thinking === true });
        }
        item.result = trimText(item.childResults.map(frame => frame.text).join('\n\n'), MAX_RESULT_CHARS);
        item.detail = '子 Agent 已返回，等待主任务汇总';
      }
      item.status = 'running';
      item.endedAt = null;
      state.phase = 'running';
      state.endedAt = null;
      return;
    }
    const eventOrder = state._currentOrder;
    for (const [index, block] of (message.content || []).entries()) {
      state._currentOrder = eventOrder + index / 1000;
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
        messageSource(item, message.id, event.uuid);
      } else if (block.type === 'thinking') {
        const text = block.thinking || '';
        if (!text) continue;
        let existing = state.items.find((item) => item.type === 'thinking'
          && item.sourceMessageId === message.id && item.title === text);
        if (!existing) {
          existing = itemFor(state, `thinking:${message.id || event.uuid}:${state.items.length}`, {
            type: 'thinking', status: 'success', title: text, detail: '', endedAt: Date.now()
          });
        }
        messageSource(existing, message.id, event.uuid);
        if (event.resumed_from_incomplete_thinking === true) existing.resumed_from_incomplete_thinking = true;
      }
    }
  }

  function ingestToolProgress(state, event) {
    const rawToolUseId = String(event.tool_use_id || '');
    const hasHeartbeatSuffix = /-heartbeat-\d+$/.test(rawToolUseId);
    const syntheticHeartbeat = event.heartbeat === true || hasHeartbeatSuffix;
    const baseToolUseId = hasHeartbeatSuffix
      ? rawToolUseId.replace(/-heartbeat-\d+$/, '')
      : rawToolUseId;
    if (state.retractedToolIds.includes(baseToolUseId)) return;
    const itemByTask = event.task_id && state._tasks.get(event.task_id);
    let item = itemByTask
      || (baseToolUseId && state._tools.get(baseToolUseId))
      || (baseToolUseId && state._tasks.get(baseToolUseId))
      || null;
    // heartbeat 只是既有长工具的活性信号。关联不到原工具时宁可忽略，不能制造一条
    // 永远收不到 tool_result 的空白“运行命令”。
    if (!item && syntheticHeartbeat) return;
    if (!item) {
      const label = friendlyTool(event.tool_name, {});
      item = itemFor(state, baseToolUseId || `tool-progress:${event.uuid || Date.now()}`, {
        type: 'tool', toolUseId: baseToolUseId || null, toolName: event.tool_name || '工具',
        input: {}, status: 'running', ...label
      });
      if (baseToolUseId) state._tools.set(baseToolUseId, item);
    }
    // Progress is not a result receipt. Late frames cannot revive a terminal row.
    if (!/^(running|preparing)$/.test(item.status)) return;
    item.status = 'running';
    item.elapsedMs = Math.round(Number(event.elapsed_time_seconds || 0) * 1000);
    if (event.subagent_retry) {
      const retry = event.subagent_retry;
      item.detail = `子任务正在重试 · 第 ${Number(retry.attempt) || 1} 次${retry.error_status ? ' · HTTP ' + retry.error_status : ''}`;
    }
    // 某些 SDK 版本 heartbeat=true，但 tool_use_id 是不可推导的帧 ID。若已通过 task_id
    // 找到真实工具，必须保留原 toolUseId，不能让心跳帧覆盖它。
    const canonicalToolUseId = syntheticHeartbeat && !hasHeartbeatSuffix && itemByTask && itemByTask.toolUseId
      ? itemByTask.toolUseId
      : baseToolUseId;
    if (event.task_id) rememberTask(state, item, { ...event, tool_use_id: canonicalToolUseId || null });
  }

  function ingestUser(state, event) {
    const content = event.message && event.message.content;
    if (!Array.isArray(content)) return;
    const resultCount = content.filter((block) => block && block.type === 'tool_result').length;
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      if (state.retractedToolIds.includes(block.tool_use_id)) continue;
      let item = state._tools.get(block.tool_use_id) || state._tasks.get(block.tool_use_id);
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
      item.resultConfirmed = true;
      item.structuredResult = redact(event.tool_use_result);
      if (resultCount === 1) {
        const links = [event.tool_use_result?.persistedOutputPath, event.tool_use_result?.rawOutputPath].filter(Boolean).map(uri => ({ uri, name: '查看完整输出' }));
        if (links.length) { item.resources = taskResources({ resource_links: links }); item.resourceTaskId = block.tool_use_id; }
      }
      if (event.uuid) item.resultMessageUuids = [...new Set([...(item.resultMessageUuids || []), event.uuid])];
      if (!block.is_error && isAsyncLaunch(event, block, resultCount)) {
        // Agent 的首个 tool_result 只是后台启动回执，并不是任务已经成功。
        // 保持运行态，等待 task_progress / task_notification 在同一行原位更新。
        item.type = 'task';
        item.result = '';
        item.error = '';
        item.status = 'running';
        item.isBackgrounded = true;
        item.detail = item.detail || '后台运行中';
        item.endedAt = null;
        const structured = event.tool_use_result || event.toolUseResult || {};
        rememberTask(state, item, { tool_use_id: block.tool_use_id,
          task_id: structured.backgroundTaskId || structured.background_task_id || structured.agentId || structured.taskId || null });
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
    if (event.subtype === 'thinking_tokens') {
      if (!Number.isFinite(event.estimated_tokens) || event.estimated_tokens < 0) return;
      if (!isChildEvent(event)) state.startupPhase = null;
      const existing = [...state.items].reverse().find(item => item.type === 'thinking' && item.status === 'running');
      const target = existing || itemFor(state, 'sdk-thinking-progress', {type:'status',status:'running',title:'正在思考',detail:'',ambient:true});
      target.detail = `约 ${Math.round(event.estimated_tokens).toLocaleString()} Token`; target.estimatedTokens = event.estimated_tokens;
      return;
    }

    if (event.subtype === 'model_refusal_fallback' && !event.content && !event.fallback_model) return;
    if (['informational', 'notification', 'local_command_output', 'model_refusal_fallback', 'model_refusal_no_fallback', 'plugin_install', 'memory_recall'].includes(event.subtype)) {
      const content = event.content || event.text || event.message || '';
      const key = event.subtype === 'notification' ? `sdk-notice:${event.key}`
        : event.subtype === 'informational' && event.tool_use_id ? `sdk-info:${event.tool_use_id}`
        : event.subtype === 'plugin_install' ? `sdk-plugin:${event.name || 'batch'}` : `sdk-${event.subtype}:${event.uuid || content}`;
      const labels = { informational: event.prevent_continuation ? '等待进一步指示' : '运行提示', notification: '运行通知', local_command_output: '命令结果',
        model_refusal_fallback: '模型响应已更新', model_refusal_no_fallback: '模型未能处理这次请求', plugin_install: '插件安装', memory_recall: '已调用 SDK 记忆' };
      const fallback = event.subtype === 'memory_recall' ? `${Array.isArray(event.memories) ? event.memories.length : 0} 条 · ${event.mode === 'synthesize' ? '综合摘要' : '文件记忆'}`
        : event.subtype === 'plugin_install' ? [event.name, event.status, event.error].filter(Boolean).join(' · ') : '';
      itemFor(state, key, { type: 'status', status: event.subtype === 'plugin_install' && event.status === 'started' ? 'running'
        : event.subtype === 'model_refusal_no_fallback' || event.prevent_continuation || event.status === 'failed' ? 'error' : 'success',
        title: labels[event.subtype], detail: trimText(content || fallback, 4000), priority: event.priority || event.level || null,
        endedAt: event.subtype === 'plugin_install' && event.status === 'started' ? null : Date.now() });
      if (state.session && event.subtype === 'model_refusal_fallback' && event.scope !== 'local' && event.fallback_model) {
        state.session.model = event.direction === 'revert' ? event.original_model : event.fallback_model;
      }
      return;
    }
    if (event.subtype === 'init') {
      if (state.startupPhase) state.startupPhase = 'waiting';
      state.session = {
        id: event.session_id || null,
        model: event.model || null,
        version: event.claude_code_version || null,
        cwd: event.cwd || null,
        tools: clone(event.tools || []),
        mcpServers: clone(event.mcp_servers || []),
        permissionMode: event.permissionMode || null,
        effort: event.effort == null ? null : event.effort,
        capabilities: clone(event.capabilities || []),
        skills: clone(event.skills || []),
        agents: clone(event.agents || []),
        plugins: clone(event.plugins || []),
        slashCommands: clone(event.slash_commands || []),
        terminalSlashCommands: clone(event.terminal_slash_commands || []),
        fastModeState: event.fast_mode_state || null,
        fastModeDisabledReason: event.fast_mode_disabled_reason || null
      };
      return;
    }
    if (event.subtype === 'relay_mcp_status') {
      const preparing = event.phase === 'preparing';
      const items = Array.isArray(event.items) ? event.items : [];
      const labels = { connected: '已连接', pending: '连接中', failed: '连接失败', disabled: '已停用', missing: '未加载', 'needs-auth': '需要认证' };
      if (state.startupPhase) state.startupPhase = preparing ? 'preparing' : 'waiting';
      // Successful preflight is not a user-facing milestone. Actual connection
      // problems remain inspectable while the model's reply is still pending.
      if (!preparing && !event.ok) itemFor(state, 'relay-mcp-ready', {
        type: 'diagnostic', status: 'error', title: '部分工具连接失败', detail: '', outputOwned: true,
        result: items.map((item) => `${item.name}：${labels[item.status] || '状态待确认'}`).join('\n')
          || '可在「插件 → MCP」查看连接状态或重试同步。',
        endedAt: Date.now(),
      });
      else if (!preparing && event.ok) state.items = state.items.filter(item => item.id !== 'relay-mcp-ready');
      return;
    }
    if (event.subtype === 'api_retry' && !event.parent_tool_use_id && !event.agent_id) {
      const seconds = Math.max(0, Math.ceil(Number(event.retry_delay_ms) / 1000) || 0);
      const attempt = Math.max(1, Math.floor(Number(event.attempt)) || 1);
      const maximum = Math.max(attempt, Math.floor(Number(event.max_retries)) || attempt);
      const status = Number(event.error_status);
      const persistent = event.relay_retry_policy === 'persistent';
      const previous = state.items.find(item => item.id === 'relay-api-retry');
      const retry = itemFor(state, 'relay-api-retry', {
        type: 'status', status: 'running',
        title: status === 429 ? '服务商限流，等待重试'
          : status >= 500 ? '服务商暂时繁忙，等待重试'
          : status > 0 ? '请求暂时失败，等待重试' : '连接暂时中断，等待重试',
        detail: persistent
          ? `第 ${attempt} 次${seconds ? ` · 约 ${seconds} 秒后重试` : ''}`
          : `${seconds ? `约 ${seconds} 秒后重试 · ` : ''}第 ${attempt}/${maximum} 次`, endedAt: null,
        order: state._currentOrder, contextEpoch: state.contextEpoch,
        startedAt: previous?.status === 'running' ? previous.startedAt : Date.now(),
      });
      // Aggregate retries in one row, but place the current wait at its latest
      // event position. Keeping the first order strands later retries above
      // newer tools, narration and in-turn user input.
      const position = state.items.indexOf(retry);
      if (position !== state.items.length - 1) { state.items.splice(position, 1); state.items.push(retry); }
      return;
    }
    if (event.subtype === 'status') {
      if (state.session && event.permissionMode) state.session.permissionMode = event.permissionMode;
      if (event.compact_result === 'success' || event.compact_result === 'failed' || event.compact_error) {
        const latest = state.items.findLast(item => item.type === 'compact');
        const item = activeCompaction(state)
          || (latest && (!latest.compactStatusUuid || latest.compactStatusUuid === event.uuid) ? latest : null)
          || itemFor(state, `compact:${event.uuid || Date.now()}`);
        const failed = event.compact_result === 'failed' || Boolean(event.compact_error);
        Object.assign(item, {
          type: 'compact', status: failed ? 'error' : 'success',
          title: failed ? '上下文压缩失败' : '已压缩对话上下文',
          detail: failed ? trimText(event.compact_error || '本次未能完成压缩，可继续发送消息重试', 2000) : item.detail || '',
          compactStatusUuid: event.uuid || null, endedAt: Date.now(),
        });
        return;
      }
      if (event.status === 'compacting') {
        const item = activeCompaction(state) || itemFor(state, `compact:${event.uuid || Date.now()}`);
        Object.assign(item, {
          type: 'compact', status: 'running', title: '正在压缩对话上下文', detail: '',
          startedAt: item.startedAt || Date.now(), endedAt: null,
        });
      }
      return;
    }
    if (event.subtype === 'background_tasks_changed') {
      const active = new Set();
      for (const task of Array.isArray(event.tasks) ? event.tasks : []) {
        if (!task || !task.task_id) continue;
        if (task.tool_use_id && state.retractedToolIds.includes(task.tool_use_id)) continue;
        if (task.ambient === true) {
          markAmbientTask(state, task);
          continue;
        }
        const taskId = String(task.task_id);
        active.add(taskId);
        state._ambientTasks.delete(taskId);
        const item = taskItemFor(state, task);
        Object.assign(item, {
          type: 'task', taskType: task.task_type || item.taskType || null,
          title: task.description || item.title || '后台任务', status: 'running',
          isBackgrounded: true, ambient: false, endedAt: null,
        });
      }
      for (const item of state.items) {
        if (item.type !== 'task' || item.isBackgrounded !== true || !item.taskId) continue;
        if (!active.has(String(item.taskId)) && (item.status === 'running' || item.status === 'preparing')) {
          item.status = 'success';
          item.endedAt = Date.now();
        }
      }
      if (active.size) {
        state.phase = 'running';
        state.endedAt = null;
      }
      return;
    }
    if (event.subtype === 'permission_denied') {
      const item = state._tools.get(event.tool_use_id) || itemFor(state, `sdk-denied:${event.tool_use_id || event.uuid}`, {
        type: 'status', title: `${event.tool_name || '工具'} 未获批准`, toolUseId: event.tool_use_id || null,
      });
      if (event.tool_use_id) state._tools.set(event.tool_use_id, item);
      if (item) Object.assign(item, {
        status: 'error', error: event.message || event.decision_reason || '权限被拒绝',
        result: event.message || event.decision_reason || '', endedAt: Date.now()
      });
      return;
    }
    if (event.subtype === 'task_started') {
      if (event.ambient === true) {
        markAmbientTask(state, event);
        return;
      }
      const item = taskItemFor(state, event);
      Object.assign(item, {
        type: 'task',
        title: event.description || item.title || '后台任务',
        detail: event.summary || event.task_type || item.detail || '',
        taskType: event.task_type || item.taskType || null,
        subagentType: event.subagent_type || item.subagentType || null,
        isBackgrounded: event.is_backgrounded == null ? item.isBackgrounded : event.is_backgrounded === true,
        spawnDepth: Number.isFinite(event.spawn_depth) ? event.spawn_depth : item.spawnDepth,
        ambient: false,
        status: 'running',
        endedAt: null,
      });
      state.phase = 'running';
      state.endedAt = null;
      return;
    }
    if (event.subtype === 'task_progress') {
      if (isAmbientTaskEvent(state, event)) return;
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
      if (isAmbientTaskEvent(state, event)) return;
      const item = taskItemFor(state, event);
      if (item && event.patch) {
        if (event.patch.status) item.status = event.patch.status === 'completed' ? 'success' : (event.patch.status === 'failed' || event.patch.status === 'killed') ? 'error' : 'running';
        if (event.patch.description) item.title = event.patch.description;
        if (event.patch.error) item.error = event.patch.error;
        if (event.patch.end_time) item.endedAt = event.patch.end_time;
        if (event.patch.is_backgrounded != null) item.isBackgrounded = event.patch.is_backgrounded === true;
      }
      if (item.status === 'running' || item.status === 'preparing') {
        state.phase = 'running';
        state.endedAt = null;
      }
      return;
    }
    if (event.subtype === 'task_notification') {
      if (event.ambient === true || isAmbientTaskEvent(state, event)) {
        markAmbientTask(state, event);
        return;
      }
      const item = taskItemFor(state, event);
      const taskStatus = String(event.status || '').toLowerCase();
      const status = taskStatus === 'running' || taskStatus === 'pending'
        ? 'running'
        : taskStatus === 'stopped' ? 'canceled'
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
      const resources = taskResources(event);
      if (resources.length) item.resources = resources;
      if (status === 'running') {
        state.phase = 'running';
        state.endedAt = null;
      }
      return;
    }
    if (event.subtype === 'compact_boundary') {
      const metadata = compactionMetadata(event);
      const elapsedMs = tokenCount(metadata.durationMs ?? metadata.duration_ms);
      const endedAt = Date.now();
      const activeItem = activeCompaction(state);
      const latest = state.items.findLast(item => item.type === 'compact');
      const item = activeItem
        || (latest && (latest.compactBoundaryUuid === event.uuid || latest.compactStatusUuid && !latest.compactBoundaryUuid) ? latest : null)
        || itemFor(state, `compact:${event.uuid || endedAt}`);
      Object.assign(item, {
        type: 'compact',
        status: 'success',
        title: '已压缩对话上下文',
        detail: compactionDetail(metadata),
        compaction: metadata,
        compactBoundaryUuid: event.uuid || null,
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
    const denied = permissionDenialSummary(event);
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
      queuedTurnCount: Number(event.queued_turn_count || 0),
      userMessageUuid: event.user_message_uuid || null,
      apiErrorStatus: event.api_error_status == null ? null : Number(event.api_error_status),
      modelUsage: clone(event.modelUsage || null),
      fastModeState: event.fast_mode_state || null,
      fastModeDisabledReason: event.fast_mode_disabled_reason || null,
      errors: clone(event.errors || []),
      errorCategory: event.relay_error_category || null,
      permissionDenials: denied
    };
  }

  function permissionDenialSummary(event) {
    const denials = Array.isArray(event && event.permission_denials) ? event.permission_denials : [];
    if (!denials.length) return null;
    const tools = [];
    const seen = new Set();
    for (const denial of denials) {
      const name = String(denial && (denial.tool_name || denial.toolName) || '').replace(/\s+/g, ' ').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (tools.length < 12) tools.push(name.slice(0, 120));
    }
    return { count: denials.length, tools };
  }

  function permissionDenialError(event) {
    const denied = permissionDenialSummary(event);
    if (!denied) return null;
    return `工具权限被拒绝（${denied.count} 次）${denied.tools.length ? `：${denied.tools.join('、')}` : ''}`;
  }

  function ingest(state, event) {
    if (!state || !event) return state;
    if (event.uuid && state.retractedMessageUuids.includes(event.uuid)) return state;
    if (event.tool_use_id && state.retractedToolIds.includes(event.tool_use_id)) return state;
    state.received += 1;
    taskTiming(state, event);
    if (/^(assistant|stream_event|tool_progress|result)$/.test(event.type)) state.hasWork = true;
    state._currentOrder = Number.isFinite(event.presentation_order) ? event.presentation_order : state.received;
    if (state.phase === 'idle') state.phase = 'running';
    rememberKind(state, event.type);
    retractMessages(state, event);
    if (event.type === 'conversation_reset') { resetContext(state, event); return state; }

    if (!isChildEvent(event)) {
      const raw = event.type === 'stream_event' ? event.event || {} : {};
      if (state.startupPhase && raw.type === 'message_start') state.startupPhase = 'waiting';
      const block = raw.content_block || {};
      const responseBlock = value => value && (value.type === 'thinking' || value.type === 'tool_use'
        || value.type === 'text' && Boolean(value.text));
      if (raw.type === 'content_block_start' && responseBlock(block)
          || raw.type === 'content_block_delta' && /^(thinking_delta|text_delta|input_json_delta)$/.test(raw.delta?.type)
            && Boolean(raw.delta.thinking || raw.delta.text || raw.delta.partial_json)
          || event.type === 'assistant' && !event.error && Array.isArray(event.message?.content) && event.message.content.some(responseBlock)
          || event.type === 'tool_progress' || event.type === 'result') state.startupPhase = null;
    }

    if (!event.parent_tool_use_id && !event.agent_id &&
        (event.type === 'stream_event' && event.event?.type === 'message_start' || event.type === 'assistant' && !event.error)) {
      const retry = state.items.find(item => item.id === 'relay-api-retry' && item.status === 'running');
      if (retry) Object.assign(retry, { status: 'success', title: '服务商已恢复响应', detail: '', endedAt: Date.now() });
    }
    if (event.type === 'system') ingestSystem(state, event);
    else if (event.type === 'tool_use_summary') {
      const ids = Array.isArray(event.preceding_tool_use_ids) ? event.preceding_tool_use_ids : [];
      const matches = ids.map(id => state._tools.get(id) || state._tasks.get(id)).filter(Boolean);
      if (matches.length) matches[matches.length - 1].detail = trimText(event.summary, 2000);
    }
    else if (event.type === 'stream_event') ingestStream(state, event);
    else if (event.type === 'assistant') {
      const estimate = state.items.find(item => item.id === 'sdk-thinking-progress');
      if (estimate && !event.parent_tool_use_id) { estimate.status = 'success'; estimate.title = '已完成思考'; estimate.endedAt = Date.now(); }
      reconcileAssistant(state, event);
    }
    else if (event.type === 'tool_progress') ingestToolProgress(state, event);
    else if (event.type === 'user') ingestUser(state, event);
    else if (event.type === 'result' && !isChildEvent(event)) {
      state.result = compactResult(event);
      const deniedError = permissionDenialError(event);
      const failed = event.is_error || event.subtype && event.subtype !== 'success';
      state.error = failed ? (event.errors || []).join('\n') || event.result || event.error || deniedError || '执行出错' : null;
      if (failed && event.relay_error_description) state.error = `${event.relay_error_description}\n\n${state.error}`;
      // An SDK round can end before more work, a retry or a queued input starts.
      // Missing pending counters are not evidence that the Relay task finished.
      state.phase = 'running';
      state.endedAt = null;
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

  function finish(state, error, doneEvent) {
    if (!state) return;
    state.startupPhase = null;
    taskTiming(state, doneEvent, true);
    const finalResult = doneEvent && doneEvent.finalResult;
    if (finalResult && finalResult.type === 'result' && !isChildEvent(finalResult)) {
      state.result = compactResult(finalResult);
      const denied = permissionDenialError(finalResult);
      state.error = finalResult.is_error || finalResult.subtype && finalResult.subtype !== 'success'
        ? (finalResult.errors || []).join('\n') || finalResult.result || finalResult.error || denied || '执行出错' : null;
    }
    const terminalError = error || doneEvent && doneEvent.error || state.error
      || (/^aborted_/.test(String(finalResult?.terminal_reason || '')) ? '执行已中止' : null)
      || (doneEvent && Number.isFinite(doneEvent.exitCode) && doneEvent.exitCode !== 0 ? `执行退出（${doneEvent.exitCode}）` : null);
    if (terminalError) {
      state.phase = 'error';
      state.error = String(terminalError);
    } else {
      state.phase = 'complete';
    }
    state.endedAt = Number.isFinite(state.taskFinishedAt) ? state.taskFinishedAt : state.endedAt || Date.now();
    if (state.taskRun) state.taskRun = continuity.finish(state.taskRun, { finishedAt: state.endedAt, durationMs: state.taskDurationMs });
    for (const item of state.items) {
      if (item.status === 'preparing' || item.status === 'running') {
        item.status = item.type === 'tool' && !hasToolResultReceipt(item) ? 'unconfirmed'
          : terminalError ? 'error' : 'success';
        if (item.type === 'compact') {
          item.title = terminalError ? '上下文压缩未完成' : '已压缩对话上下文';
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
    if (item.status === 'superseded' || item.status === 'canceled' || item.status === 'unconfirmed') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 12h12"/></svg>';
    if (item.type === 'thinking') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18h6M10 22h4"/><path d="M8.2 14.5A7 7 0 1 1 15.8 14.5C14.7 15.3 14 16 14 18h-4c0-2-.7-2.7-1.8-3.5Z"/></svg>';
    if (item.type === 'task') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01"/></svg>';
    if (item.type === 'compact') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 17h16M9 3l3 4 3-4M9 21l3-4 3 4"/></svg>';
    if (item.toolName === 'Read') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z"/><path d="M12 5v15"/></svg>';
    if (item.toolName === 'Edit' || item.toolName === 'Write') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m15 4 5 5M4 20l1-6L16 3a2 2 0 0 1 5 5L10 19Z"/></svg>';
    if (item.toolName === 'Bash' || item.toolName === 'PowerShell') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/></svg>';
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

  function inspectorFields(content) {
    // Parse the already redacted, bounded display value. Never parse the raw
    // input again: long inputs and restored previews retain their existing cap.
    const parsed = parseJsonText(content);
    if (!parsed.parsed || !parsed.value || Array.isArray(parsed.value) || typeof parsed.value !== 'object') return '';
    return Object.entries(parsed.value).map(([key, value]) => {
      const text = typeof value === 'string' ? (value || '""') : JSON.stringify(value, null, 2);
      return `<div class="process-inspect-field"><dt>${escapeHtml(key)}</dt><dd><pre>${escapeHtml(text)}</pre></dd></div>`;
    }).join('');
  }

  function inspectorCode(text) {
    // Only JSON receives token colour. Every segment is escaped independently;
    // arbitrary tool text/HTML never becomes markup or an executable link.
    const parsed = parseJsonText(text);
    if (!parsed.parsed || !parsed.value || typeof parsed.value !== 'object') return escapeHtml(text);
    const token = /"(?:\\.|[^"\\])*"\s*(?=:)|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
    let html = '', cursor = 0;
    for (const match of text.matchAll(token)) {
      const value = match[0], end = match.index + value.length;
      const kind = value.startsWith('"') ? (/^\s*:/.test(text.slice(end)) ? 'key' : 'string') : 'literal';
      html += escapeHtml(text.slice(cursor, match.index)) + `<span class="process-json-${kind}">${escapeHtml(value)}</span>`;
      cursor = end;
    }
    return html + escapeHtml(text.slice(cursor));
  }

  function inspectSection(label, content, kind, item) {
    const display = inspectorSectionContent(item, content, kind);
    const fields = kind === 'input' ? inspectorFields(display.text) : '';
    const format = fields ? '参数' : display.format === 'markdown' ? 'Markdown' : parseJsonText(display.text).parsed ? 'JSON' : '文本';
    const body = fields
      ? `<dl class="process-inspect-fields" tabindex="0" aria-label="输入参数">${fields}</dl>`
      : display.format === 'markdown'
        ? `<div class="process-inspect-markdown" tabindex="0" aria-label="${escapeHtml(label)}">${renderThinkingMarkdown(display.text)}</div>`
        : `<pre class="process-inspect-code" tabindex="0" aria-label="${escapeHtml(label)}">${inspectorCode(display.text)}</pre>`;
    return `<section class="process-inspect-section${kind ? ` is-${kind}` : ''}">
      <div class="process-inspect-label"><span>${escapeHtml(label)}</span><span class="process-inspect-format">${format}</span></div>
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
    return `<div class="process-inspector"><div class="process-inspect-panel"><div class="process-inspect-heading"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14"/></svg><span title="${escapeHtml(item.toolName || '子任务')}">${escapeHtml(item.toolName || '子任务')}</span></div>${blocks.join('')}</div></div>`;
  }

  function renderError(value) {
    // Older callers prepend emoji to an error string. Preserve the diagnostic
    // itself, while giving every error the same quiet, accessible presentation.
    const text = String(value == null ? '' : value).replace(/^\s*(?:❌|🖼️?|⚠️?)\s*/u, '') || '执行未完成，请重试。';
    return `<div class="bubble conversation-error" role="alert"><span class="conversation-error-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M12 8v5m0 3h.01" stroke-linecap="round"/></svg></span><div class="conversation-error-copy" tabindex="0" aria-label="错误详情">${escapeHtml(text)}</div></div>`;
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
    if (item.type === 'narration') {
      const text = item.displayText == null ? item.result || '' : item.displayText;
      return `<div class="process-item is-narration" data-process-id="${escapeHtml(item.id)}"><div class="conversation-narration body">${escapeHtml(text)}</div></div>`;
    }
    const hasDetails = item.type === 'thinking' || hasInspectorValue(item.input) || Boolean(item.result || item.error || item.usage);
    const inspectable = (item.type === 'tool' || item.type === 'task' || item.type === 'thinking' || item.type === 'narration' || item.type === 'diagnostic') && hasDetails;
    const className = ['process-item', `is-${item.type || 'status'}`, `is-${item.status || 'success'}`, inspectable ? 'is-inspectable' : '', expanded ? 'is-expanded' : ''].filter(Boolean).join(' ');
    const titleText = item.type === 'thinking'
      ? (item.status === 'running' || item.status === 'preparing' ? '正在思考' : '已完成思考')
      : item.title || '处理中';
    const badge = item.toolName ? `<span class="process-tool-name">${escapeHtml(item.toolName)}</span>` : (item.type === 'task' ? '<span class="process-tool-name">Task</span>' : '');
    const detailText = [item.status === 'unconfirmed' ? '结果未确认' : '', item.detail].filter(Boolean).join(' · ');
    const detail = detailText ? `<span class="process-item-detail">${escapeHtml(detailText)}</span>` : '';
    const title = `<span class="process-item-label">${escapeHtml(titleText)}</span>${badge}`;
    const stop = item.type === 'task' && item.taskId && /^(?:running|preparing)$/.test(item.status)
      ? '<button class="process-task-stop" type="button" title="停止此任务" aria-label="停止此任务"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg></button>' : '';
    const background = canBackground(item)
      ? '<button class="process-task-background" type="button" title="转到后台继续运行" aria-label="转到后台继续运行"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2" width="9" height="9" rx="1.5"/><path d="M5 13h7a1 1 0 0 0 1-1V5M5 5l3 3m-3 0h3V5"/></svg><span>转后台</span></button>' : '';
    // Old snapshots persisted the generated transcript shortcut. Hide it on
    // restoration too, preserving original indexes for real resource actions.
    const resources = (item.resources || []).map((resource, index) => resource.name === '查看任务输出' ? '' :
      `<button class="process-task-resource" type="button" data-resource-index="${index}" title="${escapeHtml(resource.uri)}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 2h5l4 4v12H5V2Z"/><path d="M11 2v5h4M8 11h4M8 14h4"/></svg><span>${escapeHtml(resource.name)}</span></button>`).join('');
    const inspector = item.type === 'thinking'
      ? `<div class="process-inspector"><pre class="process-output-text">${escapeHtml(item.title || '')}</pre></div>`
      : item.outputOwned ? `<div class="process-inspector"><pre class="process-output-text">${escapeHtml(item.result || '')}</pre></div>` : renderInspector(item);
    return `<div class="${className}" data-process-id="${escapeHtml(item.id)}"${inspectable ? ` role="button" tabindex="0" aria-expanded="${Boolean(expanded)}"` : ''}>
      <span class="process-item-icon">${iconFor(item)}</span>
      <div class="process-item-main"><div class="process-item-title">${title}${background}${stop}</div>${detail}${resources ? `<div class="process-task-resources">${resources}</div>` : ''}</div>
      ${inspector}
    </div>`;
  }

  function canBackground(item) {
    return !!(item?.toolUseId && /^(?:tool|task)$/.test(item.type)
      && /^(?:Bash|Agent|Task)$/.test(item.toolName || '') && item.status === 'running' && !item.isBackgrounded && !item.outputOwned);
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return [hours ? `${hours}h` : '', hours || minutes ? `${minutes}m` : '', `${seconds % 60}s`].filter(Boolean).join(' ');
  }

  function summaryFor(state, options = {}) {
    if (options.segment === 'previous') return { title: '此前过程', meta: '' };
    const live = state.phase === 'running' || state.phase === 'idle';
    const resultDuration = state.result && Number(state.result.durationMs);
    const start = Number.isFinite(state.taskStartedAt) ? state.taskStartedAt : state.startedAt;
    const end = live ? Date.now() : Number.isFinite(state.taskFinishedAt) ? state.taskFinishedAt : state.endedAt;
    const taskElapsed = state.taskRun && continuity?.activeDuration(state.taskRun, live ? Date.now() : end);
    const elapsed = Number.isFinite(taskElapsed) ? taskElapsed
      : Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start
      : !live && Number.isFinite(state.taskDurationMs) ? state.taskDurationMs
        : !live && resultDuration > 0 ? resultDuration : null;
    const duration = formatDuration(elapsed);
    const meta = duration ? `· 用时 ${duration}` : '';
    // The main renderer passes this exact sentinel only for an explicit user pause.
    // Keep underlying tool errors intact; ordinary failures mentioning a pause are not pauses.
    if (state.phase === 'error' && state.error === '已暂停') return { title: '已暂停', meta, paused: true };
    if (state.phase === 'error') return { title: '处理未完成', meta };
    if (state.phase === 'complete') return { title: '已结束', meta };
    const retry = state.items.find(item => item.id === 'relay-api-retry' && item.status === 'running');
    if (retry) return { title: retry.title || '等待服务商重试', meta };
    if (state.result && state.result.queuedTurnCount > 0) {
      return { title: '正在处理排队消息', meta: [meta, `· 还有 ${state.result.queuedTurnCount} 条`].filter(Boolean).join(' ') };
    }
    if (state.startupPhase) return { title: state.startupPhase === 'waiting' ? '正在等待回复' : '正在准备', meta };
    if (state.hasWork || state.result || state.items.length) {
      return { title: '正在处理', meta };
    }
    return { title: '正在准备', meta };
  }

  function visibleItems(state, options = {}) {
    // Older histories stored an initialization checkmark as an activity. Keep
    // only its real diagnostic; never replay a completed startup decoration.
    const items = state.items.flatMap(item => item.id !== 'relay-mcp-ready' ? [item]
      : item.status !== 'error' ? [] : [{ ...item, type: 'diagnostic', outputOwned: true,
        title: '部分工具连接失败', result: item.result || item.detail, detail: '' }]);
    if (state.startupPhase && /^(running|idle)$/.test(state.phase) && options.segment !== 'previous'
        && !items.some(item => /^(running|preparing)$/.test(item.status))) {
      items.push({ id: 'relay-startup', type: 'status', status: 'running',
        title: state.startupPhase === 'waiting' ? '正在等待回复' : '正在准备', detail: '' });
    }
    return items;
  }

  function itemSignature(item, expanded) {
    // Compare visible strings by identity/value; do not serialize large result
    // bodies, raw structuredResult or provenance on every unrelated heartbeat.
    let fields = '';
    try { fields = JSON.stringify([item.input, item.usage, item.resources]); } catch (_) {}
    return [item.id, item.type, item.status, item.title, item.detail, item.toolName,
      item.result, item.error, item.displayText, item.outputOwned, item.taskId, item.toolUseId, item.isBackgrounded, fields, Boolean(expanded)];
  }

  function sameSignature(previous, next) {
    return Array.isArray(previous) && previous.length === next.length && next.every((value, index) => previous[index] === value);
  }

  function toolGroupKey(item) {
    if (item.type !== 'tool' || item.outputOwned || !item.toolName || /^(?:Agent|Task)$/.test(item.toolName)) return null;
    return /^(?:Bash|PowerShell)$/.test(item.toolName) ? 'command' : item.toolName;
  }

  // This is a display projection only: history keeps every original call in order.
  // Prose, thinking and agents form boundaries, even when the same tool resumes later.
  function groupToolItems(items) {
    const result = [];
    for (const item of items) {
      const key = toolGroupKey(item), previous = result[result.length - 1];
      if (key && previous && previous.key === key) previous.items.push(item);
      else result.push({ key, id: item.id, items: [item] });
    }
    return result;
  }

  function toolGroupSummary(group) {
    const running = group.items.filter(item => /^(?:running|preparing)$/.test(item.status)).length;
    const errors = group.items.filter(item => item.status === 'error').length;
    const unconfirmed = group.items.filter(item => item.status === 'unconfirmed').length;
    const labels = { Read: '读取文件', Write: '写入文件', Edit: '修改文件', Glob: '搜索文件', Grep: '搜索内容', command: '运行命令', WebSearch: '搜索网页', WebFetch: '读取网页' };
    const action = labels[group.key] || friendlyTool(group.items[0].toolName, {}).title;
    return {
      title: (running ? '正在' : errors || unconfirmed ? '' : '已') + action,
      count: `${group.items.length} 次`,
      detail: [running ? `${running} 进行中` : '', errors ? `${errors} 失败` : '', unconfirmed ? `${unconfirmed} 项结果未确认` : ''].filter(Boolean).join(' · '),
      status: running ? 'running' : errors ? 'error' : unconfirmed ? 'unconfirmed' : 'success', errors,
    };
  }

  // Patch the existing DOM, including expanded inspectors. Stream updates must not
  // replace the focused call or reset the scroll position of its result/code block.
  function syncRenderedNode(current, next) {
    if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) {
      current.replaceWith(next); return;
    }
    if (current.nodeType !== 1) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    for (const attribute of Array.from(current.attributes)) {
      if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(next.attributes)) {
      if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    }
    const currentChildren = Array.from(current.childNodes), nextChildren = Array.from(next.childNodes);
    for (let index = 0; index < Math.max(currentChildren.length, nextChildren.length); index += 1) {
      if (!nextChildren[index]) currentChildren[index].remove();
      else if (!currentChildren[index]) current.appendChild(nextChildren[index]);
      else syncRenderedNode(currentChildren[index], nextChildren[index]);
    }
  }

  let groupSequence = 0;
  function setGroupExpanded(group, expanded) {
    group.classList.toggle('is-expanded', expanded);
    group.querySelector('.process-tool-group-summary').setAttribute('aria-expanded', String(expanded));
    const body = group.querySelector('.process-tool-group-body');
    body.inert = !expanded;
    body.setAttribute('aria-hidden', String(!expanded));
  }

  function syncItemElements(container, items, expanded, groupPreferences) {
    const existing = new Map(Array.from(container.querySelectorAll('.process-item[data-process-id]'), row => [row.dataset.processId, row]));
    const existingGroups = new Map(Array.from(container.querySelectorAll('.process-tool-group'), row => [row.dataset.processGroupId, row]));
    const seen = new Set(), seenGroups = new Set(), active = document.activeElement;
    // Reparenting a previously standalone call into its first group can reset
    // native scroll offsets even though the exact same element is retained.
    // Reading every historical <pre>.scrollTop forces layout after each streamed
    // update, particularly while a sidebar changes the available width. Capture
    // offsets only for a row that is actually about to move in the DOM.
    const scrollPositions = [];
    let previousRow = null;
    const place = (parent, row, previous) => {
      const before = previous ? previous.nextElementSibling : parent.firstElementChild;
      if (row !== before) {
        if (row.isConnected) for (const node of row.querySelectorAll('pre, .process-inspect-markdown, .process-inspect-fields')) {
          if (node.scrollTop || node.scrollLeft) scrollPositions.push({ node, top: node.scrollTop, left: node.scrollLeft });
        }
        parent.insertBefore(row, before);
      }
      return row;
    };
    const syncCall = item => {
      const isExpanded = expanded.has(item.id), signature = itemSignature(item, isExpanded);
      let row = existing.get(item.id);
      seen.add(item.id);
      if (!row || !sameSignature(row._processSignature, signature)) {
        if (!row || item.type !== 'narration' || !row.classList.contains('is-narration')) {
          const template = document.createElement('template');
          template.innerHTML = renderItem(item, isExpanded).trim();
          const next = template.content.firstElementChild;
          if (row) syncRenderedNode(row, next);
          else row = next;
        }
        row._processSignature = signature;
      }
      row._processItem = item;
      if (item.type === 'narration') {
        const body = row.querySelector('.conversation-narration');
        const text = String(item.displayText == null ? item.result || '' : item.displayText);
        const renderer = window.relayRenderReadOnlyMarkdown;
        if (body._narrationText !== text || body._narrationRenderer !== renderer) {
          try {
            if (typeof renderer !== 'function') throw new Error('Markdown renderer unavailable');
            renderer(body, text, { incremental: true });
          } catch (_) { body.textContent = text; body.classList.add('is-plain-text'); }
          body._narrationText = text; body._narrationRenderer = renderer;
        }
      }
      const inspector = row.querySelector('.process-inspector');
      if (inspector) inspector.inert = !isExpanded;
      return row;
    };
    for (const group of groupToolItems(items)) {
      if (group.items.length < 2) {
        previousRow = place(container, syncCall(group.items[0]), previousRow);
        continue;
      }
      let row = existingGroups.get(group.id);
      seenGroups.add(group.id);
      if (!row) {
        row = document.createElement('div'); row.className = 'process-tool-group'; row.dataset.processGroupId = group.id;
        const bodyId = `process-tool-group-${++groupSequence}`;
        row.innerHTML = `<button type="button" class="process-tool-group-summary" aria-controls="${bodyId}" aria-expanded="false">
          <span class="process-item-icon"></span><span class="process-tool-group-title"></span><span class="process-tool-group-count"></span><span class="process-tool-group-status"></span>
          <svg class="process-tool-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
        </button><div class="process-tool-group-body" id="${bodyId}"><div class="process-tool-group-content"></div></div>`;
        if (!groupPreferences.has(group.id)) {
          groupPreferences.set(group.id, group.items.some(item => expanded.has(item.id) || existing.get(item.id)?.contains(active)));
        }
      }
      const summary = toolGroupSummary(group), icon = row.querySelector('.process-item-icon');
      const iconMarkup = iconFor({ ...group.items[0], status: summary.status });
      if (icon._markup !== iconMarkup) { icon.innerHTML = iconMarkup; icon._markup = iconMarkup; }
      row.classList.toggle('has-error', summary.errors > 0);
      row.dataset.status = summary.status;
      for (const [className, value] of [['title', summary.title], ['count', summary.count], ['status', summary.detail]]) {
        const label = row.querySelector(`.process-tool-group-${className}`);
        if (label.textContent !== value) label.textContent = value;
      }
      const content = row.querySelector('.process-tool-group-content');
      let previousCall = null;
      for (const item of group.items) previousCall = place(content, syncCall(item), previousCall);
      setGroupExpanded(row, groupPreferences.get(group.id));
      previousRow = place(container, row, previousRow);
    }
    for (const [id, row] of existing) if (!seen.has(id)) row.remove();
    for (const [id, row] of existingGroups) if (!seenGroups.has(id)) row.remove();
    if (active && active.isConnected && container.contains(active) && !active.closest('[inert]') && document.activeElement !== active) active.focus({ preventScroll: true });
    for (const position of scrollPositions) {
      if (position.node.isConnected) { position.node.scrollTop = position.top; position.node.scrollLeft = position.left; }
    }
  }

  // A quiet SDK/tool stream must not freeze the visible task clock. Keep one
  // timer for live summaries only; never rebuild process rows or scroll here.
  const liveSummaries = new Set();
  let summaryClock = null;
  function stopSummaryClock() {
    if (summaryClock !== null) window.clearTimeout(summaryClock);
    summaryClock = null;
  }
  function scheduleSummaryClock() {
    if (!liveSummaries.size) { stopSummaryClock(); return; }
    if (summaryClock === null && !window.document.hidden) {
      summaryClock = window.setTimeout(refreshSummaryClocks, 1000);
    }
  }
  function refreshSummaryClocks() {
    stopSummaryClock();
    for (const element of liveSummaries) {
      if (!element.isConnected) { liveSummaries.delete(element); continue; }
      if (window.document.hidden) continue;
      // A resumed task's first header belongs to an older segment. Its summary
      // state points to the latest segment, unlike its own process-row state.
      updateSummary(element, element._processSummaryState, {
        summaryMode: element.dataset.summaryMode, segment: element.dataset.segment,
      });
    }
    scheduleSummaryClock();
  }
  if (window.document) {
    window.document.addEventListener('visibilitychange', refreshSummaryClocks);
    window.addEventListener('focus', refreshSummaryClocks);
    window.addEventListener('beforeunload', () => {
      liveSummaries.clear(); stopSummaryClock();
    }, { once: true });
  }

  function updateSummary(element, state, options = {}) {
    const mode = options.summaryMode || '';
    const summary = mode === 'hidden' ? { title: '', meta: '' }
      : summaryFor(state, { ...options, segment: mode === 'task' ? 'current' : options.segment });
    element.dataset.summaryMode = mode;
    element._processSummaryState = state;
    element.classList.toggle('is-paused', summary.paused === true);
    const button = element.querySelector('.process-summary');
    button.hidden = mode === 'hidden';
    const title = element.querySelector('.process-summary-title'), meta = element.querySelector('.process-summary-meta');
    if (title.textContent !== summary.title) title.textContent = summary.title;
    if (meta.textContent !== summary.meta) meta.textContent = summary.meta;
    if (/^(running|idle)$/.test(state.phase) && mode !== 'hidden'
        && (mode === 'task' || options.segment !== 'previous')) liveSummaries.add(element);
    else liveSummaries.delete(element);
    scheduleSummaryClock();
  }

  const taskSummaryGroups = new WeakMap();
  function clearTaskSummaries(host) {
    // The host stays mounted for the lifetime of the app. Explicitly release
    // its groups when replacing a conversation, including an empty new chat.
    if (host) {
      taskSummaryGroups.delete(host);
      for (const element of liveSummaries) {
        if (!element.isConnected || host.contains(element)) liveSummaries.delete(element);
      }
      scheduleSummaryClock();
    }
  }
  function syncTaskSummary(element, taskKey, expanded) {
    const host = element?.parentElement;
    const key = taskKey || element?._processOptions?.taskKey || element?._processState?.taskRun?.taskId;
    if (!host || !key) return;
    element._processOptions.taskKey = key;
    let groups = taskSummaryGroups.get(host);
    if (!groups) { groups = new Map(); taskSummaryGroups.set(host, groups); }
    if (!groups.has(key)) {
      // The same transcript host survives conversation switches. Drop its
      // detached groups on registration, never scanning old conversations for
      // every streamed token or retaining their DOM indefinitely.
      for (const [oldKey, group] of groups) {
        if (![...group.elements].some(node => node.parentElement === host)) groups.delete(oldKey);
      }
      groups.set(key, { elements: new Set(), phase: null, collapsed: null, userToggled: false, autoCollapsed: false });
    }
    const group = groups.get(key);
    group.elements.add(element);
    const members = [...group.elements].filter(node => node.parentElement === host)
      .sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1);
    group.elements = new Set(members);
    const first = members[0], state = members.at(-1)._processState;
    const live = /^(running|idle)$/.test(state.phase);
    if (members.some(member => member.dataset.userToggled)) group.userToggled = true;
    if (typeof expanded === 'boolean') {
      group.collapsed = !expanded; group.userToggled = true; group.autoCollapsed = false;
    } else if (group.collapsed == null) {
      group.collapsed = first.classList.contains('is-collapsed');
      group.userToggled = Boolean(first.dataset.userToggled);
      group.autoCollapsed = group.collapsed && !group.userToggled;
    } else if (live && !/^(running|idle)$/.test(group.phase) && group.autoCollapsed) {
      group.collapsed = false; group.autoCollapsed = false;
    } else if (!live && /^(running|idle)$/.test(group.phase) && !group.userToggled
        && members.at(-1)._processOptions.collapseOnComplete !== false) {
      group.collapsed = true; group.autoCollapsed = true;
    }
    group.phase = state.phase;
    for (const member of members) {
      updateSummary(member, member === first ? state : member._processState,
        { summaryMode: member === first ? 'task' : 'hidden' });
      member.classList.toggle('is-collapsed', group.collapsed);
      member.querySelector('.process-summary').setAttribute('aria-expanded', String(!group.collapsed));
      member.querySelector('.process-items').inert = group.collapsed;
      if (group.userToggled) member.dataset.userToggled = '1';
      if (group.autoCollapsed) member.dataset.autoCollapsed = '1';
      else delete member.dataset.autoCollapsed;
    }
  }

  function updateElement(element, state, options) {
    if (!element || !state) return element;
    const opts = { ...element._processOptions, ...options };
    element._processOptions = opts;
    element._processState = state;
    element._processCwd = state.session && state.session.cwd || null;
    const previousPhase = element.dataset.phase;
    const items = visibleItems(state, opts);
    const expanded = element._processExpanded || new Set();
    element._processExpanded = expanded;
    element.dataset.phase = state.phase;
    element.dataset.segment = opts.segment || 'current';
    element.classList.toggle('is-running', state.phase === 'running' || state.phase === 'idle');
    element.classList.toggle('has-items', items.length > 0);
    element.classList.toggle('has-error', state.items.some((item) => item.status === 'error'));
    updateSummary(element, state, opts);
    const groupPreferences = element._processGroupExpanded || new Map();
    element._processGroupExpanded = groupPreferences;
    syncItemElements(element.querySelector('.process-items'), items, expanded, groupPreferences);
    if (!element.dataset.userToggled && element.dataset.autoCollapsed && (state.phase === 'running' || opts.segment === 'previous')) {
      element.classList.remove('is-collapsed');
      delete element.dataset.autoCollapsed;
      element.querySelector('.process-summary').setAttribute('aria-expanded', 'true');
    }
    if (!element.dataset.userToggled && /^(complete|error)$/.test(state.phase) && previousPhase === 'running'
        && opts.segment !== 'previous' && opts.collapseOnComplete !== false) {
      element.classList.add('is-collapsed');
      element.dataset.autoCollapsed = '1';
      element.querySelector('.process-summary').setAttribute('aria-expanded', 'false');
    }
    element.querySelector('.process-items').inert = element.classList.contains('is-collapsed');
    syncTaskSummary(element);
    return element;
  }

  function createElement(state, options) {
    const opts = options || {};
    const element = document.createElement('div');
    element.className = 'process-stream conversation-stream';
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
      const action = event.target.closest('.process-task-resource, .process-task-stop, .process-task-background');
      if (action) {
        event.preventDefault(); event.stopPropagation();
        const row = action.closest('.process-item'), item = row && row._processItem;
        if (!item) return;
        const stopping = action.classList.contains('process-task-stop');
        const backgrounding = action.classList.contains('process-task-background');
        if (stopping && (!item.taskId || !/^(?:running|preparing)$/.test(item.status))) return;
        if (backgrounding && !canBackground(item)) return;
        const resource = stopping || backgrounding ? null : item.resources && item.resources[Number(action.dataset.resourceIndex)];
        if (!stopping && !backgrounding && !resource) return;
        const detail = { ...(resource || {}), taskId: item.resourceTaskId || item.taskId || null, toolUseId: item.toolUseId || null,
          cwd: element._processCwd || null };
        const callback = element._processOptions && element._processOptions[stopping ? 'onStopTask' : backgrounding ? 'onBackgroundTask' : 'onResource'];
        if (typeof callback === 'function') {
          action.disabled = true;
          Promise.resolve().then(() => callback(detail)).catch(error => {
            element.dispatchEvent(new CustomEvent('relay:task-action-error', { bubbles: true,
              detail: { ...detail, message: String(error && error.message || error) } }));
          }).finally(() => { if (action.isConnected) action.disabled = false; });
        } else element.dispatchEvent(new CustomEvent(stopping ? 'relay:task-stop' : backgrounding ? 'relay:task-background' : 'relay:task-resource', { bubbles: true, detail }));
        return;
      }
      const summaryButton = event.target.closest('.process-summary');
      if (summaryButton) {
        element.classList.toggle('is-collapsed');
        element.dataset.userToggled = '1';
        summaryButton.setAttribute('aria-expanded', String(!element.classList.contains('is-collapsed')));
        element.querySelector('.process-items').inert = element.classList.contains('is-collapsed');
        syncTaskSummary(element, null, !element.classList.contains('is-collapsed'));
        return;
      }
      const groupButton = event.target.closest('.process-tool-group-summary');
      if (groupButton) {
        const group = groupButton.closest('.process-tool-group');
        const expanded = !group.classList.contains('is-expanded');
        element.dataset.userToggled = '1';
        element._processGroupExpanded.set(group.dataset.processGroupId, expanded);
        setGroupExpanded(group, expanded);
        return;
      }
      const row = event.target.closest('.is-inspectable');
      if (!row) return;
      if (event.target.closest('.process-inspector') || (window.getSelection && String(window.getSelection()))) return;
      element.dataset.userToggled = '1';
      const id = row.dataset.processId;
      if (element._processExpanded.has(id)) element._processExpanded.delete(id);
      else element._processExpanded.add(id);
      row.classList.toggle('is-expanded', element._processExpanded.has(id));
      row.setAttribute('aria-expanded', String(element._processExpanded.has(id)));
      const inspector = row.querySelector('.process-inspector');
      if (inspector) inspector.inert = !element._processExpanded.has(id);
    });
    element.addEventListener('keydown', (event) => {
      const row = event.target.closest('.is-inspectable');
      if (!row || event.target !== row || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      row.click();
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
    syncTaskSummary,
    clearTaskSummaries,
    renderItem,
    renderError,
    groupToolItems,
    formatDuration,
    summaryFor,
    visibleItems,
    taskResources,
  };
  if (typeof module === 'object' && module.exports) module.exports = window.RelayActivity;
})(typeof window !== 'undefined' ? window : {});
