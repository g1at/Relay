'use strict';
const ID = /^[0-9a-f][0-9a-f-]{15,63}$/i;
const { normalize: normalizePresentation } = require('../../../renderer/supplement-timeline');
// A transport receipt and a durable write are separate facts. Keep failed writes
// out of serialized user input, and retry at a later boundary or final settlement.
const pendingUpdates = new WeakMap();
// Only a native consumption receipt may repair a persisted terminal label.
// Keep this proof local to the exact live record; renderer snapshots cannot mint it.
const consumedInputs = new WeakSet();
function publishSupplementUpdate(session, input, update) {
  let pending = pendingUpdates.get(session);
  try {
    if (update(input) === false) throw Error('not persisted');
    if (pending) pending.delete(input.id);
    return true;
  } catch (_) {
    if (!pending) pendingUpdates.set(session, pending = new Map());
    pending.set(input.id, input);
    return false;
  }
}
function flushSupplementUpdates(session, update) {
  const pending = pendingUpdates.get(session);
  for (const input of (pending || new Map()).values()) {
    if (session.supplementInputs?.get(input.id) === input) publishSupplementUpdate(session, input, update);
    else pending.delete(input.id);
  }
}
function normalizeSupplement(value = {}) {
  if (!ID.test(String(value.messageId || ''))) throw Error('补充消息标识无效');
  if (value.followUpMode !== undefined && !['steer', 'queue'].includes(value.followUpMode)) throw Error('跟进处理方式无效');
  const text = String(value.prompt || '').trim();
  if (text.length > 200000) throw Error('补充内容过长，请拆分发送');
  const files = (Array.isArray(value.files) ? value.files : []).slice(0, 32).map(file => ({
    path: String(file && file.path || ''), name: String(file && file.name || ''),
    ext: String(file && file.ext || ''), size: Number(file && file.size || 0),
    ...(file && (file.isDirectory || file.ext === 'folder') ? { isDirectory: true } : {}),
  })).filter(file => file.path && file.path.length < 32768 && !/[\0\r\n]/.test(file.path));
  if (!text && !files.length) throw Error('请输入补充要求');
  const skill = value.skill && typeof value.skill.name === 'string' ? {
    name: value.skill.name.slice(0, 200), callName: String(value.skill.callName || value.skill.name).slice(0, 200),
    displayName: String(value.skill.displayName || value.skill.name).slice(0, 200),
  } : null;
  const presentation = normalizePresentation(value.presentation);
  return { id: value.messageId, text, files, skill, ts: new Date().toISOString(), status: 'queued', followUpMode: value.followUpMode || 'steer',
    ...(presentation ? { presentation } : {}) };
}
function supplementPrompt(input, { includeAttachments = true } = {}) {
  let text = input.followUpMode === 'queue'
    ? `用户后续要求（当前工作已完成后，继续处理以下要求）：\n${input.text || '请查看补充附件。'}`
    : '用户补充要求（这是用户在本轮执行中刚刚发送的最新要求）：\n'
      + `${input.text || '请查看补充附件。'}\n\n`
      + '请在当前任务中立即纳入这条要求并继续执行。新增问题或要求是补充，不代表取消原任务；'
      + '原任务尚未完成的要求也需要继续完成，并分别回答互不冲突的问题。'
      + '只有用户明确替换原目标，或新旧要求确实冲突时，'
      + '以这条最新要求覆盖之前冲突的用户要求，保留其余仍适用的任务上下文。'
      + '相应调整后续计划、执行和最终回复，不要继续交付已经被替换的旧方案。'
      + '结束前核对原任务与全部补充要求是否都已完成；若无法满足，请明确说明原因。';
  if (input.skill) text += `\n\n请调用 Skill 工具加载「${input.skill.callName}」技能并用于这项补充要求。`;
  if (includeAttachments && input.files.length) text += '\n\n用户补充附件（绝对路径；文件用 Read 读取，文件夹用 Glob/Grep 按需查找后读取，不改变当前工作目录）：\n' + input.files.map(file => `- ${file.path}`).join('\n');
  return text;
}
function sameSupplement(a, b) {
  return a.text === b.text && JSON.stringify(a.files) === JSON.stringify(b.files) && JSON.stringify(a.skill) === JSON.stringify(b.skill)
    && (a.followUpMode || 'steer') === (b.followUpMode || 'steer');
}
function submitLiveSupplement({ session, jobId, input, persist, emit }) {
  if (!session || session.dead || !session.busy || session.jobId !== jobId || session.turnRouter.interruptRequested) {
    return { ok: false, code: 'NOT_RUNNING', message: '当前任务已结束或正在暂停，补充内容已保留' };
  }
  const records = session.supplementInputs || (session.supplementInputs = new Map());
  if (records.has(input.id)) return sameSupplement(records.get(input.id), input)
    ? { ok: true, duplicate: true, input: records.get(input.id) }
    : { ok: false, code: 'INPUT_CONFLICT', message: '这条补充消息的标识已被使用' };
  if (records.size >= 200) return { ok: false, message: '本次任务补充消息过多，请等待任务结束' };
  if (!session.turnRouter.registerSupplement(input.id)) {
    return { ok: false, code: 'INPUT_CONFLICT', message: '这条补充消息的标识已被使用' };
  }
  try { persist(input); }
  catch (_) { session.turnRouter.unregisterSupplement(input.id); return { ok: false, message: '补充内容保存失败，请重试' }; }
  records.set(input.id, input);
  session.supplementJobId = jobId;
  const publish = record => publishSupplementUpdate(session, record, value => {
    let persisted = true;
    try { persist(value); } catch (_) { persisted = false; }
    try { emit(value); } catch (_) {}
    return persisted;
  });
  try { emit(input); } catch (_) {}
  const dispatch = () => {
    if (input.status === 'canceled' || input.status === 'rejected') return;
    if (session.dead || !session.busy || session.jobId !== jobId || session.turnRouter.interruptRequested) {
      input.status = 'canceled';
      if (session.jobId === jobId) session.turnRouter.unregisterSupplement(input.id);
      publish(input); return;
    }
    try {
      // 'now' interrupts the CLI; neither Relay follow-up mode uses it.
      // 'next' may join a tool/model boundary; 'later' waits until the turn drains.
      if (!session.child.push(supplementPrompt(input, { includeAttachments: false }), {
        uuid: input.id, priority: input.followUpMode === 'queue' ? 'later' : 'next',
        ...(input.files.length ? { files: input.files } : {}),
      })) throw Error('closed');
    } catch (_) {
      input.status = 'rejected'; session.turnRouter.unregisterSupplement(input.id); publish(input);
    }
  };
  // Preserve original-prompt-first ordering while MCP is still being prepared.
  if (session.pendingInput && session.pendingInput.done) session.pendingInput.done.then(dispatch, dispatch);
  else dispatch();
  return { ok: true, input };
}
function observeSupplement(session, event, update) {
  const records = session.supplementInputs;
  if (!records || event.parent_tool_use_id || event.parentToolUseId || event.agent_id || event.subagent_type) return;
  let ids = event.type === 'command_lifecycle' ? [event.command_uuid]
    : [...new Set([event.user_message_uuid, ...(Array.isArray(event.user_message_uuids) ? event.user_message_uuids : [])])];
  let status;
  if (event.type === 'command_lifecycle') {
    if (event.state === 'started') status = 'applied';
    if (event.state === 'cancelled' || event.state === 'discarded') status = 'canceled';
    if (event.state === 'refused') status = 'rejected';
  } else if (['assistant', 'stream_event'].includes(event.type)) status = 'applied';
  else if (event.type === 'result' && event.num_turns !== 0) {
    if (Array.isArray(event.user_message_uuids)) {
      // This list records consumed prompts even when the turn later fails or
      // is interrupted. A singular error stamp alone can be a delivery failure.
      ids = [...new Set(event.user_message_uuids)];
      status = 'applied';
    } else if (event.is_error !== true
        && (!event.subtype || event.subtype === 'success')
        && !(Array.isArray(event.permission_denials) && event.permission_denials.length)
        && !/^aborted_(streaming|tools)$/.test(String(event.terminal_reason || ''))) status = 'applied';
  }
  if (!status) return;
  for (const id of ids) {
    const input = records.get(id);
    if (!input) continue;
    if (status === 'applied') consumedInputs.add(input);
    if (input.status === status || input.status === 'applied'
        || (['canceled', 'rejected'].includes(input.status) && status !== 'applied')) {
      const boundary = event.type !== 'stream_event' || event.event?.type === 'message_start';
      if (boundary && pendingUpdates.get(session)?.has(id)) publishSupplementUpdate(session, input, update);
      continue;
    }
    input.status = status;
    publishSupplementUpdate(session, input, update);
  }
}
// Delayed metadata/full-history saves must not erase accepted supplemental input.
function mergeSupplementHistory(incoming, saved, session) {
  if (!incoming || !saved || !Array.isArray(incoming.turns)) return incoming;
  for (const turn of incoming.turns) {
    if (!turn || !turn.runId) continue;
    const original = (Array.isArray(saved.turns) ? saved.turns : []).find(item => item && item.runId === turn.runId);
    if (!original || !Array.isArray(original.supplements)) continue;
    const valid = item => item && typeof item.id === 'string' && item.id;
    const items = new Map((Array.isArray(turn.supplements) ? turn.supplements : []).filter(valid).map(item => [item.id, item]));
    for (const item of original.supplements) {
      if (!valid(item)) continue;
      // Accepted text is immutable; renderer snapshots cannot downgrade delivery state.
      items.set(item.id, item);
    }
    // Only the owning executor can repair a failed receipt write. A renderer
    // status (or an executor for another run) can never promote queued input.
    if (session && session.convId === incoming.id && session.supplementJobId === turn.runId) {
      for (const item of (session.supplementInputs || new Map()).values()) {
        const accepted = items.get(item.id);
        if (accepted && sameSupplement(accepted, item)
            && (!['canceled', 'rejected'].includes(accepted.status)
              || (item.status === 'applied' && consumedInputs.has(item)))
            && (accepted.status === 'queued' || item.status !== 'queued')) items.set(item.id, { ...accepted, status: item.status });
      }
    }
    turn.supplements = [...items.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  }
  return incoming;
}
module.exports = { normalizeSupplement, supplementPrompt, sameSupplement, submitLiveSupplement, observeSupplement, flushSupplementUpdates, mergeSupplementHistory };
