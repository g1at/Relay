// Text provenance shared by live UI, replay and history. Never interprets tool text as code.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RelayAssistantOutput = api;
})(typeof window === 'object' ? window : null, function () {
  'use strict';
  const copy = (value) => JSON.parse(JSON.stringify(value));

  // Only standalone protocol-shaped blocks outside quoted/code examples qualify.
  // Preserve every isolated byte in diagnostics; ordinary XML and inline explanations stay intact.
  function splitProtocol(value) {
    const source = String(value || '');
    const lines = source.split(/(?<=\n)/);
    let offset = 0, fence = null, precedingCharacter = '', isolatedUntil = 0;
    const ranges = [];
    for (const line of lines) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      }
      if (offset >= isolatedUntil && !fence && !marker && !/^\s*>|^ {4}|^\t/.test(line)) {
        const tail = source.slice(offset);
        const match = tail.match(/^ {0,3}<(tool_call|function_calls|tool_calls)>\s*<(?:function\s*=|invoke\s+(?:name|tool)=|tool_call>)/i);
        // The old per-line prefix.trimEnd() scan made ordinary long answers
        // quadratic. Track its last non-whitespace character once per line.
        const introducedExample = precedingCharacter === ':' || precedingCharacter === '：';
        if (match && !introducedExample) {
          const close = new RegExp('</' + match[1] + '\\s*>', 'i').exec(tail.slice(match[0].length));
          isolatedUntil = close ? offset + match[0].length + close.index + close[0].length : source.length;
          ranges.push({ start: offset, end: isolatedUntil });
        }
      }
      const content = line.trimEnd();
      if (content) precedingCharacter = content[content.length - 1];
      offset += line.length;
    }
    let text = '', cursor = 0;
    const diagnostics = [];
    for (const range of ranges) {
      text += source.slice(cursor, range.start);
      diagnostics.push(source.slice(range.start, range.end));
      cursor = range.end;
    }
    text += source.slice(cursor);
    return { text: ranges.length ? text.trim() : source, diagnostics };
  }

  function createState(saved) {
    return {
      version: 5, messages: copy(saved && saved.messages || []),
      current: copy(saved && saved.current || {}), seen: new Set(saved && saved.seen || []),
      sequence: Number(saved && saved.sequence || 0), revision: Number(saved && saved.revision || 0),
      eventOrder: Number(saved && saved.eventOrder || 0),
      lastResult: copy(saved && saved.lastResult || null), resultRevision: Number(saved && saved.resultRevision || 0),
      resultMessageId: saved && saved.resultMessageId || null,
      final: String(saved && saved.final || ''), finalMessageId: saved && saved.finalMessageId || null,
      resultCandidates: copy(saved && saved.resultCandidates || []), answers: copy(saved && saved.answers || []),
      status: saved && saved.status || 'running', notice: saved && saved.notice || '',
      retractedMessageUuids: [...new Set(saved && saved.retractedMessageUuids || [])],
      contextEpoch: Number(saved && saved.contextEpoch || 0),
      conversationId: saved && saved.conversationId || null,
      resets: copy(saved && saved.resets || []),
    };
  }
  function owner(event) { return String(event.parent_tool_use_id || event.parentToolUseId
    || (event.agent_id ? 'agent:' + event.agent_id : event.subagent_type ? 'subagent:' + event.subagent_type : '')); }
  function messageFor(state, id, parent) {
    let message = state.messages.find((item) => item.id === id && item.parent === parent && Number(item.contextEpoch || 0) === state.contextEpoch);
    if (!message) {
      message = { id, parent, blocks: [], stopReason: null, aborted: false, order: state.eventOrder, contextEpoch: state.contextEpoch };
      state.messages.push(message);
    }
    return message;
  }
  function blockFor(message, index, type = 'text') {
    let block = message.blocks.find((item) => item.index === index);
    if (!block) { block = { index, type, text: '', streamed: false, full: false }; message.blocks.push(block); }
    return block;
  }
  function textFor(message) { return message.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''); }
  function retractionIds(event) {
    const value = event.type === 'assistant' ? event.supersedes
      : event.type === 'system' && event.subtype === 'model_refusal_fallback' ? event.retracted_message_uuids : null;
    return Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id))] : [];
  }
  function retract(state, ids) {
    if (!ids.length) return;
    const removed = new Set(ids);
    state.retractedMessageUuids = [...new Set([...state.retractedMessageUuids, ...ids])];
    let changed = false;
    state.messages = state.messages.filter(message => {
      const frames = message.fullFrameIds || [];
      if (!frames.some(id => removed.has(id))) return true;
      const retainedFrames = frames.filter(id => !removed.has(id));
      // Old snapshots only recorded frame IDs at message level. Evict an old
      // message only if all its frames were retired; never guess which sibling
      // block a UUID referred to. New snapshots keep per-block provenance.
      const oldBlocks = message.blocks.length;
      message.hasRetractedFrames = true;
      message.blocks = message.blocks.filter(block => {
        if (!Array.isArray(block.wireUuids)) return retainedFrames.length > 0;
        block.wireUuids = block.wireUuids.filter(id => !removed.has(id));
        return block.wireUuids.length > 0;
      });
      message.fullFrameIds = retainedFrames;
      changed = changed || oldBlocks !== message.blocks.length;
      if (message.blocks.length) return true;
      for (const key of Object.keys(state.current)) if (state.current[key] === message.id) delete state.current[key];
      return false;
    });
    if (changed) {
      state.revision += 1;
      state.final = ''; state.finalMessageId = null; state.answers = [];
      state.resultCandidates = state.resultCandidates.filter(candidate => !(candidate.sourceFrameIds || []).some(id => removed.has(id))
        && (!candidate.messageId || state.messages.some(message => message.id === candidate.messageId && textFor(message) === candidate.text)));
      state.lastResult = null; state.resultRevision = -1; state.resultMessageId = null;
    }
  }
  function resetContext(state, event) {
    if (owner(event) || !event.new_conversation_id) return;
    if (event.uuid && state.resets.some(reset => reset.uuid === event.uuid)) return;
    state.contextEpoch += 1;
    state.conversationId = String(event.new_conversation_id);
    state.resets.push({ uuid: event.uuid || null, conversationId: state.conversationId, order: state.eventOrder, contextEpoch: state.contextEpoch });
    state.current = {}; state.lastResult = null; state.resultRevision = -1; state.resultMessageId = null;
    state.final = ''; state.finalMessageId = null; state.answers = []; state.notice = ''; state.status = 'running';
    state.revision += 1;
  }
  function ingest(state, event) {
    if (!state || !event) return state;
    // SDK error frames are transport status, not model-authored progress/answers.
    if (event.type === 'assistant' && event.error) return state;
    if (event.uuid && state.retractedMessageUuids.includes(event.uuid)) return state;
    if (event.uuid) {
      if (state.seen.has(event.uuid)) return state;
      state.seen.add(event.uuid);
      // Stream wrapper IDs can number in the hundreds of thousands. Replay also
      // reconciles full blocks, so only the recent delivery overlap needs IDs.
      if (state.seen.size > 1024) state.seen.delete(state.seen.values().next().value);
    }
    const parent = owner(event);
    state.eventOrder += 1;
    retract(state, retractionIds(event));
    if (event.type === 'conversation_reset') { resetContext(state, event); return state; }
    if (!parent && (event.type === 'assistant' || event.type === 'stream_event')) state.revision += 1;
    if (event.type === 'stream_event' && event.event) {
      const raw = event.event;
      if (raw.type === 'message_start') {
        state.current[parent] = raw.message && raw.message.id || 'stream-' + (++state.sequence);
        messageFor(state, state.current[parent], parent);
      }
      const id = state.current[parent] || (state.current[parent] = 'stream-' + (++state.sequence));
      const message = messageFor(state, id, parent);
      message.settled = false;
      if (raw.type === 'content_block_start') {
        const input = raw.content_block || {};
        const block = blockFor(message, raw.index, input.type);
        if (block.order == null) block.order = state.eventOrder;
        if (block.full && block.streamed) { block.replaying = true; return state; }
        block.type = input.type; block.text = input.text || ''; block.streamed = true;
      } else if (raw.type === 'content_block_delta' && raw.delta && raw.delta.type === 'text_delta') {
        const block = blockFor(message, raw.index);
        if (block.order == null) block.order = state.eventOrder;
        if (block.replaying) return state;
        block.streamed = true; block.text += raw.delta.text || '';
        if (!parent) state.revision += 1;
      } else if (raw.type === 'content_block_stop') {
        blockFor(message, raw.index).stopped = true;
      } else if (raw.type === 'message_delta') {
        message.stopReason = raw.delta && raw.delta.stop_reason || message.stopReason;
      }
    } else if (event.type === 'assistant' && event.message) {
      const raw = event.message;
      const id = raw.id || state.current[parent] || 'full-' + (++state.sequence);
      state.current[parent] = id;
      const message = messageFor(state, id, parent);
      message.settled = false;
      if (!message.fullFrameIds) message.fullFrameIds = [];
      if (event.uuid && message.fullFrameIds.includes(event.uuid)) return state;
      if (event.uuid) message.fullFrameIds.push(event.uuid);
      message.stopReason = raw.stop_reason || message.stopReason;
      message.aborted = !!(message.aborted || event.aborted);
      if (event.resumed_from_incomplete_thinking === true) message.resumed_from_incomplete_thinking = true;
      const used = new Set();
      for (const [index, input] of (raw.content || []).entries()) {
        // A complete SDK frame can contain just one block sharing the same message.id.
        const candidates = message.blocks.filter((b) => !used.has(b) && b.type === input.type && (!b.full || raw.content.length > 1));
        let block = candidates.find((b) => input.type !== 'text' || b.text === (input.text || '')) || candidates[0];
        if (!block) {
          // UUID-less replay fallback; do not deduplicate independent streamed blocks.
          if (!event.uuid && message.blocks.some((b) => !used.has(b) && b.full && !b.streamed && b.type === input.type && b.text === (input.text || ''))) continue;
          block = blockFor(message, 'full-' + (++state.sequence), input.type);
        }
        if (block.order == null) block.order = state.eventOrder + index / 1000;
        if (input.type === 'text') {
          const value = input.text || '';
          if (!parent && block.text !== value) state.revision += 1;
          block.text = value;
        }
        block.full = true;
        if (event.uuid) block.wireUuids = [...new Set([...(block.wireUuids || []), event.uuid])];
        if (event.resumed_from_incomplete_thinking === true) block.resumed_from_incomplete_thinking = true;
        used.add(block);
      }
    } else if (event.type === 'result' && !parent) {
      const message = state.messages.findLast(item => !item.parent && !item.resultOnly
        && Number(item.contextEpoch || 0) === state.contextEpoch);
      state.resultMessageId = message && message.id || null;
      if (message) message.settled = true;
      // A result sometimes contains prose absent from the stream. Retain it at
      // the result's event position until job-done promotes the actual answer.
      // It must not become the current streaming message for subsequent deltas.
      const text = typeof event.result === 'string' && !event.is_error && event.subtype === 'success' ? event.result : '';
      if (text && (!message || textFor(message) !== text)
          && !state.messages.some(item => item.resultOnly && item.resultRevision === state.revision
            && Number(item.contextEpoch || 0) === state.contextEpoch && textFor(item) === text)) {
        const resultMessage = messageFor(state, 'result-' + (++state.sequence), '');
        resultMessage.resultOnly = true; resultMessage.resultRevision = state.revision; resultMessage.settled = true;
        resultMessage.blocks.push({ index: 0, type: 'text', text, full: true, order: state.eventOrder });
      }
      recordResultEvidence(state, event);
      state.lastResult = copy(event); state.resultRevision = state.revision;
    }
    return state;
  }
  function resultSucceeded(result) {
    return !!result && !owner(result) && result.type === 'result' && result.subtype === 'success'
      && !result.is_error && !Number(result.queued_turn_count || 0)
      && !Number(result.relay_pending_inputs || 0) && !Number(result.relay_pending_background_tasks || 0)
      && !/^aborted_/.test(String(result.terminal_reason || ''));
  }
  function permissionNotice(result) {
    const denials = Array.isArray(result && result.permission_denials) ? result.permission_denials : [];
    if (!denials.length) return '';
    const names = [...new Set(denials.map(item => String(item && (item.tool_name || item.toolName) || '')
      .replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean))].slice(0, 12);
    return `本轮有 ${denials.length} 次工具请求被拒绝${names.length ? `（${names.join('、')}）` : ''}，具体原因见执行过程。`;
  }
  function consumedInputIds(result) {
    const values = Array.isArray(result && result.user_message_uuids) ? result.user_message_uuids
      : result && result.user_message_uuid ? [result.user_message_uuid] : [];
    return [...new Set(values.filter(id => typeof id === 'string' && id && id.length <= 200))];
  }
  // A result may finish one user input while another input remains queued.
  // Store its evidence now; only job-done may expose it as a confirmed answer.
  // This isolated helper also restores evidence from a retained event journal
  // without replaying deltas into an already persisted transcript.
  function recordResultEvidence(state, event, options = {}) {
    if (!state || !event || owner(event) || event.type !== 'result' || event.subtype !== 'success'
        || event.is_error
        || /^aborted_/.test(String(event.terminal_reason || ''))
        || event.num_turns != null && !(Number(event.num_turns) > 0)) return null;
    const text = typeof event.result === 'string' ? event.result : '';
    if (!text.trim() || splitProtocol(text).diagnostics.length) return null;
    const roots = state.messages.filter(message => !message.parent && !message.aborted
      && Number(message.contextEpoch || 0) === state.contextEpoch);
    const message = roots.findLast(item => textFor(item) === text);
    const source = message && !message.resultOnly ? message : roots.findLast(item => !item.resultOnly);
    const userMessageIds = consumedInputIds(event);
    const existing = state.resultCandidates.find(candidate => candidate.contextEpoch === state.contextEpoch
      && candidate.text === text && candidate.messageId === (message && message.id || null)
      && candidate.userMessageIds.length === userMessageIds.length
      && candidate.userMessageIds.every(id => userMessageIds.includes(id)));
    if (existing) return existing;
    const candidate = { text, messageId: message && message.id || null, userMessageIds,
      order: Number.isFinite(options.order) ? options.order
        : state.status !== 'running' && message ? message.order : state.eventOrder,
      contextEpoch: state.contextEpoch, resultUuid: event.uuid || null,
      sourceFrameIds: [...(source && source.fullFrameIds || [])] };
    // Goal continuations and repeated Agent stages answer the same input set.
    // Their prose remains in messages; only the most recent result is eligible
    // for delivery, avoiding a second growing copy of a long task's transcript.
    state.resultCandidates = state.resultCandidates.filter(previous => previous.contextEpoch !== state.contextEpoch
      || previous.userMessageIds.length !== userMessageIds.length
      || !previous.userMessageIds.every(id => userMessageIds.includes(id)));
    state.resultCandidates.push(candidate);
    return candidate;
  }
  function confirmedAnswers(state, terminal, supplements) {
    const inputIds = new Set((Array.isArray(supplements) ? supplements : [])
      .filter(input => input && !['canceled', 'rejected'].includes(input.status))
      .map(input => input.id).filter(id => typeof id === 'string' && id));
    if (!inputIds.size || !terminal.userMessageIds.length) return [terminal];
    const retracted = new Set(state.retractedMessageUuids);
    const candidates = state.resultCandidates.filter(candidate => candidate.contextEpoch === state.contextEpoch
      && candidate.order <= terminal.order && candidate.userMessageIds.length
      && !(candidate.sourceFrameIds || []).some(id => retracted.has(id))
      && (!candidate.messageId || state.messages.some(message => !message.parent && !message.aborted
        && message.id === candidate.messageId && Number(message.contextEpoch || 0) === state.contextEpoch && textFor(message) === candidate.text)));
    // An input's later result replaces its earlier Agent/Goal stages. A merged
    // result covers every UUID it names. Retain a partly covered reply when it
    // still answers another input; prose cannot be safely split by semantics.
    const selected = [terminal], covered = new Set(terminal.userMessageIds);
    for (const candidate of candidates.slice().sort((a, b) => b.order - a.order)) {
      if (candidate === terminal) continue;
      const fullyCovered = candidate.userMessageIds.every(id => covered.has(id));
      if (!fullyCovered) selected.push(candidate);
      candidate.userMessageIds.forEach(id => covered.add(id));
    }
    if (!selected.some(answer => answer.userMessageIds.some(id => inputIds.has(id)))) return [terminal];
    return selected.sort((a, b) => a.order - b.order);
  }
  function finish(state, done, options = {}) {
    const ok = !options.aborted && !options.error && !(done && done.error)
      && !(done && typeof done.exitCode === 'number' && done.exitCode !== 0);
    state.final = ''; state.finalMessageId = null; state.answers = [];
    state.status = options.aborted ? 'canceled' : ok ? 'complete' : 'error';
    state.notice = '';
    const result = done && done.finalResult || (state.resultRevision === state.revision ? state.lastResult : null);
    if (!ok) return '';
    const deniedNotice = permissionNotice(result);
    if (!resultSucceeded(result)) {
      state.notice = ['任务已结束，但未取得最终回复。已保留可恢复的执行过程。', deniedNotice].filter(Boolean).join('\n');
      return '';
    }
    const roots = state.messages.filter((m) => !m.parent && Number(m.contextEpoch || 0) === state.contextEpoch);
    const last = roots.findLast((message) => !message.resultOnly);
    const resultText = typeof result.result === 'string' ? result.result : '';
    // A completed Agent/Goal continuation can carry an empty result string even
    // after delivering its full answer. Use only the current root end_turn;
    // a zero-turn notification, retraction or later tool message cannot borrow
    // prose from an earlier stage. Thinking blocks contribute no answer text.
    const fallback = (result.num_turns == null || Number(result.num_turns) > 0)
      && last && state.current[''] === last.id && !last.aborted && !last.hasRetractedFrames
      && last.stopReason === 'end_turn' && last.blocks.every((block) => ['text', 'thinking', 'redacted_thinking'].includes(block.type))
      ? textFor(last) : '';
    const candidate = resultText.trim() ? resultText : fallback;
    if (!candidate.trim() || splitProtocol(candidate).diagnostics.length) {
      state.notice = candidate.trim()
        ? '回复中出现工具协议文本，已保留在执行过程详情中；未将其作为最终回复。'
        : '任务已结束，但未取得最终回复。已保留可恢复的执行过程。';
      state.notice = [state.notice, deniedNotice].filter(Boolean).join('\n');
      if (candidate && !roots.some((m) => textFor(m) === candidate)) {
        const message = messageFor(state, 'result-diagnostic-' + (++state.sequence), '');
        message.blocks.push({ index: 0, type: 'text', text: candidate, full: true });
      }
      return '';
    }
    const matched = roots.findLast((m) => textFor(m) === candidate);
    state.finalMessageId = matched && matched.id || null;
    const terminal = recordResultEvidence(state, { ...result, result: candidate }) || {
      text: candidate, messageId: state.finalMessageId, userMessageIds: consumedInputIds(result),
      order: state.eventOrder, contextEpoch: state.contextEpoch,
    };
    state.answers = confirmedAnswers(state, terminal, options.supplements).map(answer => copy(answer));
    state.final = state.answers.map(answer => answer.text).join('\n\n');
    state.notice = deniedNotice;
    return state.final;
  }
  const processCache = new WeakMap();
  function processMessage(state, message) {
    const live = state.status === 'running' && !message.settled && Number(message.contextEpoch || 0) === state.contextEpoch;
    const signature = [live, message.id, message.parent, message.order, message.stopReason,
      ...message.blocks.flatMap(block => [block.index, block.type, block.text, block.order, block.full, block.stopped])];
    const cached = processCache.get(message);
    if (cached && signature.length === cached.signature.length && signature.every((value, index) => value === cached.signature[index])) return cached.items;
    const text = textFor(message);
    const diagnostic = splitProtocol(text).diagnostics.length > 0;
    const items = diagnostic ? [{
        id: 'output:' + message.parent + ':' + message.id, type: diagnostic ? 'diagnostic' : 'narration',
        status: live && !message.stopReason ? 'running' : 'success',
        title: '工具协议文本（已隔离）',
        detail: '原始文本供排查；实际工具状态请查看对应工具活动。',
        result: text, outputOwned: true, order: message.order,
      }] : message.blocks.filter((block) => block.type === 'text' && block.text).map((block) => ({
        id: 'output:' + message.parent + ':' + message.id + ':' + block.index,
        type: 'narration', title: '执行过程', detail: '', result: block.text,
        displayText: visibleText(block.text, block.full || block.stopped || !live),
        status: live && !block.full && !block.stopped ? 'running' : 'success',
        outputOwned: true, order: block.order == null ? message.order : block.order,
      }));
    processCache.set(message, { signature, items });
    return items;
  }
  function processItems(state, options = {}) {
    const answerIds = new Set((state.answers || []).map(answer => answer.messageId).filter(Boolean));
    return state.messages.filter((message) => (options.includeChildren || !message.parent)
      && (message.parent || (!answerIds.has(message.id) && message.id !== state.finalMessageId && message.id !== options.previewMessageId)))
      .flatMap(message => processMessage(state, message));
  }
  function partialProtocolText(text, settled) {
    if (settled) return text;
    const start = text.lastIndexOf('\n') + 1;
    const tail = text.slice(start).trimStart();
    // A partial protocol opener must not flash in the prose before its next token.
    return tail && ['<tool_call>', '<tool_calls>', '<function_calls>'].some((tag) => tag.startsWith(tail) || tail.startsWith(tag))
      ? text.slice(0, start) : text;
  }
  function visibleText(value, settled = true) {
    return partialProtocolText(splitProtocol(value).text, settled);
  }
  // Display the latest main message while it streams, without committing it as
  // an answer. A tool call or a later message moves it back into the process.
  // Only finish(), after job-done, can persist a confirmed final answer.
  function preview(state) {
    if (!state || state.status !== 'running') return null;
    const message = state.messages.findLast((item) => !item.parent && !item.resultOnly && Number(item.contextEpoch || 0) === state.contextEpoch);
    if (!message || message.aborted || message.stopReason === 'tool_use'
        || message.blocks.some((block) => block.type === 'tool_use')) return null;
    if (state.lastResult && state.resultMessageId === message.id && state.resultRevision === state.revision) return null;
    const raw = textFor(message);
    const isolated = splitProtocol(raw);
    if (isolated.diagnostics.length) return null;
    const text = partialProtocolText(isolated.text, !!message.stopReason);
    return text.trim() ? { messageId: message.id, text } : null;
  }
  function mergeActivityItems(items, outputItems) {
    const merged = items.filter((item) => !item.outputOwned).concat(outputItems);
    // Old records did not preserve event order. Keep their existing layout instead
    // of guessing chronology; every new run has a shared stable event ordinal.
    if (merged.every((item) => Number.isFinite(item.order))) merged.sort((a, b) => a.order - b.order);
    return merged;
  }
  function serialize(state) { return { ...copy({ ...state, seen: [] }), seen: [...state.seen] }; }
  return { createState, ingest, finish, recordResultEvidence, permissionNotice, processItems, preview, serialize, splitProtocol, visibleText, mergeActivityItems, textFor, owner, retractionIds };
});
