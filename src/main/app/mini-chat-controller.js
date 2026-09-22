'use strict';

const { randomUUID } = require('node:crypto');
const Output = require('../../../renderer/assistant-output');
const Activity = require('../../../renderer/activity-stream');
const Timeline = require('../../../renderer/supplement-timeline');
const TaskContinuity = require('../../../renderer/task-continuity');
const { conversationContext, directoryValue } = require('../projects/conversation-workspaces');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const errorText = error => String(error && (error.message || error.error) || error || '请稍后重试');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const MODELS = new Set(['haiku', 'sonnet', 'opus']);

// The main process owns this conversation. Hiding/recreating either renderer must
// never terminate a turn or make its final history write depend on a webContents.
function createMiniChatController({
  run, pause: pauseRun, steer, loadConversation, saveConversation, generateTitle,
  getDefaultModel = () => 'sonnet', getSessionRoute = null, getPermissions = null, setPermissions = null,
  onState = () => {}, onHistoryChanged = () => {},
  idFactory = randomUUID, now = () => new Date().toISOString(),
} = {}) {
  if (typeof run !== 'function' || typeof loadConversation !== 'function' || typeof saveConversation !== 'function') {
    throw new TypeError('Mini chat requires run, loadConversation and saveConversation');
  }
  let conversation = null, active = null, destroyed = false, stateTimer = null;
  let pendingTerminalSave = null, terminalSaveRetry = null, resetting = false;
  const timestamp = () => { const value = now(); return new Date(value).toISOString(); };
  const defaultModel = () => {
    try { const value = typeof getDefaultModel === 'function' ? getDefaultModel() : getDefaultModel; return MODELS.has(value) ? value : 'sonnet'; }
    catch (_) { return 'sonnet'; }
  };
  const state = () => {
    const snapshot = clone({ conversation, model: conversation && conversation.model || defaultModel(),
      running: !!active, runId: active && active.id || null });
    if (active && active.turn && !active.finished && snapshot.conversation) {
      const turn = snapshot.conversation.turns.find(item => item.runId === active.id);
      if (turn) {
        turn.output = Output.serialize(active.output);
        if (active.activity) turn.activity = Activity.serialize(active.activity);
      }
    }
    return snapshot;
  };
  const notify = immediate => {
    if (destroyed) return;
    if (!immediate && stateTimer) return;
    const send = () => { stateTimer = null; if (!destroyed) { try { onState(state()); } catch (_) {} } };
    if (immediate) { clearTimeout(stateTimer); send(); }
    else { stateTimer = setTimeout(send, 32); if (stateTimer.unref) stateTimer.unref(); }
  };
  const changed = id => { try { onHistoryChanged(id); } catch (_) {} };
  const failure = (error, code) => ({ ok: false, error: errorText(error), ...(code ? { code } : {}) });
  const savedConversation = async id => { const record = await loadConversation(id); return record && record.id === id ? clone(record) : null; };

  async function resolvePermissions(record) {
    if (typeof getPermissions !== 'function') {
      // Standalone embedders still retain a saved plan instead of converting it
      // to ordinary execution. The application injects its authoritative host.
      const planned = record && (record.permissionMode === 'plan' || record.permissionLegacyPlan);
      return { permissionMode: planned ? 'default' : record && record.permissionMode || 'default',
        executionMode: planned ? { kind: 'plan' } : clone(record && record.executionMode || { kind: 'default' }) };
    }
    const result = await getPermissions(record && record.id || undefined);
    if (!result || result.ok !== true) throw Error(result && (result.error || result.message) || '暂时无法读取当前对话权限');
    if (!['default', 'acceptEdits', 'bypassPermissions'].includes(result.permissionMode)
        || !result.executionMode || !['default', 'plan', 'goal'].includes(result.executionMode.kind)) {
      throw Error('当前对话权限状态无效，请重新打开小窗');
    }
    if (record && result.conversationId !== record.id) throw Error('对话权限已变化，请重新发送');
    return { permissionMode: result.permissionMode,
      executionMode: result.legacyPlan ? { kind: 'plan' } : clone(result.executionMode),
      permissionRevision: result.revision, permissionLegacyPlan: !!result.legacyPlan };
  }

  function routeFor(record) {
    return record && record.sessionProviderId ? {
      providerId: record.sessionProviderId, providerRevision: Number(record.sessionProviderRevision || 0),
      routeTier: record.sessionRouteTier || record.sessionModel || record.model,
      agentEnvironment: record.sessionAgentEnvironment || 'native',
    } : null;
  }
  function adoptRuntime(task, value = {}) {
    if (task.contextResetSessionId) task.sessionId = task.contextResetSessionId;
    else if (value.session_id || value.sessionId) task.sessionId = value.session_id || value.sessionId;
    // The runner resolves a null default cwd to its managed conversation folder.
    // Keep that trusted launch path separate from the originally requested path.
    if (Object.hasOwn(value, 'workingDir')) task.runtimeWorkingDir = directoryValue(value.workingDir);
    const route = value.sessionRoute || value;
    if (route.providerId) task.route = {
      providerId: route.providerId, providerRevision: Number(route.providerRevision || 0),
      routeTier: route.routeTier || task.model,
      agentEnvironment: route.agentEnvironment || 'native',
    };
  }
  function updateSupplement(task, record) {
    if (!record || !record.id) return;
    const inputs = task.turn.supplements || (task.turn.supplements = []);
    const index = inputs.findIndex(input => input.id === record.id);
    if (index < 0) inputs.push(clone(record)); else inputs[index] = clone(record);
  }
  function labelFor(event) {
    if (event.type === 'tool_progress') return '正在使用工具';
    const block = event.type === 'stream_event' && event.event && event.event.content_block
      || event.type === 'assistant' && event.message && (event.message.content || []).find(item => item.type === 'tool_use');
    if (block && block.type === 'thinking') return '正在思考';
    if (block && block.type === 'tool_use') {
      return ({ Read: '正在读取文件', Write: '正在写入文件', Edit: '正在编辑文件',
        Bash: '正在运行命令', PowerShell: '正在运行命令', Glob: '正在查找文件',
        Grep: '正在搜索内容', WebSearch: '正在搜索网页', WebFetch: '正在读取网页',
        Agent: '正在协作处理', Task: '正在协作处理' })[block.name] || '正在使用工具';
    }
    if (event.type === 'system' && event.subtype === 'init') return '正在思考';
    return null;
  }

  // Title generation must outlive hiding/newChat, but never delay the next turn.
  // Reload after inference and change metadata only: the user may have renamed,
  // deleted, or continued the conversation while the title model was responding.
  function requestTitle(task, record) {
    const first = record.turns?.[0];
    const logicalTaskId = TaskContinuity.normalize(task.turn.taskRun)?.taskId || task.id;
    if (typeof generateTitle !== 'function' || task.titleRequested || record.titleGenerated
        || record.titleManual || task.turn.status !== 'complete' || !first?.user
        || first.runId !== logicalTaskId || record.turns.some(turn => turn !== first
          && (!TaskContinuity.isResume(turn) || turn.taskRun.taskId !== logicalTaskId))) return;
    task.titleRequested = true;
    const text = `用户:${first.user.slice(0, 400)}\n助手:${(task.turn.assistant || '').slice(0, 300)}`;
    void (async () => {
      const response = await generateTitle(text);
      const title = String(response && response.title || '').trim();
      if (!title) return;
      const latest = await savedConversation(task.conversationId);
      if (!latest || latest.titleManual || latest.titleGenerated
          || latest.turns?.[0]?.runId !== logicalTaskId) return;
      latest.title = title;
      latest.titleGenerated = true;
      const saved = await saveConversation(latest);
      if (saved && saved.error) throw Error(saved.error);
      if (conversation && conversation.id === latest.id) {
        // Do not replace a running turn's in-memory stream with a disk snapshot.
        conversation.title = saved?.title || latest.title;
        conversation.titleGenerated = true;
        notify(true);
      }
      changed(latest.id);
    })().catch(() => { /* Keep the first-input fallback if inference/save fails. */ });
  }

  async function persistFinished(task) {
    // Reload just before writing, so a rename/pin/project edit or accepted live
    // supplement made during the run cannot be overwritten by our old snapshot.
    const latest = await savedConversation(task.conversationId);
    const record = latest;
    if (!record || record.id !== task.conversationId) return false;
    const turns = Array.isArray(record.turns) ? record.turns : (record.turns = []);
    const index = turns.findIndex(turn => turn && turn.runId === task.id);
    if (index < 0) return false; // A deliberately deleted turn must not be resurrected.
    const supplements = new Map((task.turn.supplements || []).map(input => [input.id, input]));
    for (const input of turns[index].supplements || []) supplements.set(input.id, input);
    turns[index] = { ...turns[index], ...clone(task.turn), ...(supplements.size ? { supplements: [...supplements.values()] } : {}) };
    delete turns[index].saveError;
    record.updatedAt = timestamp();
    if (index === turns.length - 1) {
      if (task.turn.status === 'paused' || (task.turn.status === 'error' && TaskContinuity.isResume(task.turn))) record.paused = { runId: task.id, at: record.updatedAt };
      if (task.turn.status === 'interrupted') {
        record.sessionId = null;
        record.carryContextOnNextTurn = record.carryContextOnNextTurn || 'interrupted';
      }
      if (task.turn.status === 'complete') {
        if (record.paused && record.paused.runId === task.resumedPauseId) delete record.paused;
        if (record.carryContextOnNextTurn === task.carryContextReason) delete record.carryContextOnNextTurn;
      }
      const runtimeStillCurrent = directoryValue(record.workingDir) === (task.runtimeWorkingDir === undefined ? task.workingDir : task.runtimeWorkingDir)
        && (!record.carryContextOnNextTurn || record.carryContextOnNextTurn === task.carryContextReason);
      if (task.contextResetSessionId) {
        delete turns[index].contextUsage;
        delete turns[index].goalRecovery;
        // The main host normally persisted the reset already. Standalone
        // runners can still have the pre-reset record: retire only that stale
        // metadata, without replacing a newer host-owned session or preference.
        const sameResetContext = !record.sessionId || record.sessionId === task.preResetSessionId
          || record.sessionId === task.contextResetSessionId;
        const preferenceUnchanged = (Number(record.permissionRevision) || 0) <= (task.contextResetPermissionRevision || 0);
        if (runtimeStillCurrent && sameResetContext && preferenceUnchanged) {
          record.sessionId = task.contextResetSessionId;
          delete record.contextUsage; delete record.goalRecovery;
          if (record.executionMode?.kind === 'goal') record.executionMode = { kind: 'default' };
        }
      }
      if (['complete', 'paused'].includes(task.turn.status) && task.sessionId && runtimeStillCurrent) {
        record.sessionId = task.sessionId;
        record.sessionModel = task.model;
        if (task.route) {
          record.sessionProviderId = task.route.providerId;
          record.sessionProviderRevision = task.route.providerRevision;
          record.sessionRouteTier = task.route.routeTier;
          record.sessionAgentEnvironment = task.route.agentEnvironment || 'native';
        }
      }
    }
    const saved = await saveConversation(record);
    if (saved && saved.error) throw Error(saved.error);
    if (conversation && conversation.id === record.id) conversation = clone(saved && Array.isArray(saved.turns) ? saved : record);
    delete task.turn.saveError;
    changed(record.id);
    requestTitle(task, record);
    return true;
  }

  function retryTerminalSave() {
    if (terminalSaveRetry) return terminalSaveRetry;
    const task = pendingTerminalSave;
    if (!task) return Promise.resolve();
    terminalSaveRetry = (async () => {
      try {
        if (!await persistFinished(task)) throw Error('原对话记录已被移除，请先复制保留当前回复');
        if (pendingTerminalSave === task) pendingTerminalSave = null;
        notify(true);
      } catch (error) {
        task.turn.saveError = `对话记录保存失败：${errorText(error)}`;
        notify(true);
        throw Error(`上一条回复尚未保存，已保留在小窗中。${errorText(error)}`);
      } finally { terminalSaveRetry = null; }
    })();
    return terminalSaveRetry;
  }

  function finish(task, event) {
    if (task.finishPromise) return task.finishPromise;
    task.finished = true;
    const terminal = event.finalResult || (task.output.resultRevision === task.output.revision ? task.output.lastResult : null);
    const natural = terminal && terminal.subtype === 'success' && !terminal.is_error
      && !Number(terminal.queued_turn_count || 0)
      && !/^aborted_/.test(String(terminal.terminal_reason || ''));
    const completedBeforePause = task.pauseRequested && event.finalResult && natural;
    const aborted = !completedBeforePause && (!!event.aborted
      || /^aborted_/.test(String(terminal?.terminal_reason || ''))
      || !!(task.pauseRequested && !natural && event.exitCode !== 0));
    const resultError = terminal && (terminal.is_error || (terminal.subtype && terminal.subtype !== 'success'))
      ? (terminal.errors || []).join('\n') || terminal.result || '任务未能完成' : null;
    const error = !aborted && (event.error || resultError || (Number(event.exitCode || 0) !== 0 ? task.stderr || '任务异常结束' : null));
    // Keep the task clock even for failures without an assistant reply. SDK
    // result.duration_ms describes one attempt, not preparation/retry wall time.
    const reportedStart = Number(event.relay_task_started_at);
    const startedAt = Number.isFinite(reportedStart) && reportedStart > 0 ? reportedStart : task.startedAt;
    const reportedEnd = Number(event.relay_task_finished_at);
    const finishedAt = Number.isFinite(reportedEnd) && reportedEnd >= startedAt
      ? reportedEnd : Math.max(startedAt, Date.parse(timestamp()));
    task.turn.taskStartedAt = task.turn.taskRun?.rootStartedAt || startedAt;
    task.turn.taskFinishedAt = finishedAt;
    task.turn.taskRun = TaskContinuity.finish(task.turn.taskRun, {
      finishedAt, durationMs: event.relay_task_duration_ms,
    });
    task.turn.taskDurationMs = task.turn.taskRun
      ? TaskContinuity.activeDuration(task.turn.taskRun, finishedAt) : finishedAt - startedAt;
    task.turn.assistant = Output.finish(task.output, event, { aborted, error, supplements: task.turn.supplements || [] });
    task.turn.output = Output.serialize(task.output);
    if (task.activity) {
      task.activity.taskRun = task.turn.taskRun;
      Activity.finish(task.activity, aborted ? '已暂停' : error, { ...event,
        relay_task_started_at: task.turn.taskStartedAt, relay_task_finished_at: finishedAt,
        relay_task_duration_ms: task.turn.taskDurationMs });
      task.turn.activity = Activity.serialize(task.activity);
    }
    task.turn.preview = '';
    task.turn.status = event.interrupted ? 'interrupted' : aborted ? 'paused' : error ? 'error' : 'complete';
    task.turn.error = error ? String(error) : null;
    task.turn.outputNotice = event.interrupted ? 'Relay 已退出，任务已中断。可从对话记录继续。' : task.output.notice || null;
    task.turn.activityLabel = event.interrupted ? '已中断' : aborted ? '已暂停' : error ? '未能完成' : '已完成';
    if (task.turn.assistant) task.turn.assistantTs = timestamp();
    for (const input of event.relay_unapplied_inputs || []) updateSupplement(task, input);
    task.finishPromise = (async () => {
      // A fast executor can finish before its launch promise returns route data.
      await task.launchReady.promise;
      try { await persistFinished(task); }
      catch (error) { pendingTerminalSave = task; task.turn.saveError = `对话记录保存失败：${errorText(error)}`; }
      finally { if (active === task) active = null; notify(true); }
    })();
    return task.finishPromise;
  }

  function receive(task, event) {
    if (!event || task.finished || active !== task || (event.jobId && event.jobId !== task.id)) return;
    const child = !!Output.owner(event);
    if (task.contextResetSessionId && !child && event.session_id && event.session_id !== task.contextResetSessionId) return;
    if (event.type === 'system' && event.subtype === 'relay_user_input') {
      updateSupplement(task, event.input); notify(false); return;
    }
    const previousOrder = task.output.eventOrder;
    Output.ingest(task.output, event);
    if (task.output.eventOrder === previousOrder) return;
    // Use the same bounded tool ledger as the main renderer. Full child text
    // is attached to its Agent row; nested tools/stream cursors and terminal
    // frames cannot overwrite a root tool, reset its context or end its task.
    if (task.activity && (!child || event.type === 'assistant')) {
      Activity.ingest(task.activity, { ...event, presentation_order: task.output.eventOrder });
    }
    // Children contribute process records, never the parent answer or completion.
    if (child) { notify(false); return; }
    if (event.type === 'conversation_reset' && event.new_conversation_id) {
      if (!task.contextResetSessionId) task.preResetSessionId = task.sessionId;
      task.contextResetSessionId = event.new_conversation_id;
      task.contextResetPermissionRevision = Number(conversation?.id === task.conversationId && conversation.permissionRevision) || 0;
      adoptRuntime(task, event);
      task.stderr = ''; task.turn.error = null; task.turn.preview = ''; task.turn.outputNotice = null;
      delete task.turn.contextUsage; delete task.turn.goalRecovery;
      if (task.turn.executionMode?.kind === 'goal') task.turn.executionMode = { kind: 'default' };
      if (conversation && conversation.id === task.conversationId) {
        conversation.sessionId = task.contextResetSessionId;
        delete conversation.contextUsage; delete conversation.goalRecovery;
        if (conversation.executionMode?.kind === 'goal') conversation.executionMode = { kind: 'default' };
      }
      if (!task.pauseRequested) task.turn.activityLabel = '已开始新的运行上下文';
      notify(true); return;
    }
    if (event.type === 'system' && event.subtype === 'init') adoptRuntime(task, event);
    if (event.type === 'stderr') task.stderr = (task.stderr + String(event.text || event.data || '')).slice(-8000);
    if (event.type === 'job-done') { finish(task, event); return; }
    const preview = Output.preview(task.output);
    task.turn.preview = preview && preview.text || '';
    const label = labelFor(event);
    if (!task.pauseRequested) task.turn.activityLabel = preview ? '正在回复' : label || task.turn.activityLabel;
    notify(false);
  }

  async function supplement(task, text, messageId, followUp = {}) {
    if (task.pauseRequested || task.finished) return failure('任务正在结束，请稍后发送', 'TURN_STOPPING');
    if (!task.dispatched) return failure('任务仍在准备，请稍后发送补充要求', 'NOT_READY');
    if (typeof steer !== 'function') return failure('请等待当前回复结束后发送', 'UNSUPPORTED_EXECUTOR');
    try {
      const result = await steer({ jobId: task.id, runId: task.id, conversationId: task.conversationId,
        messageId: messageId || idFactory(), prompt: text, text, files: [],
        presentation: Timeline.capture(task.output), ...followUp });
      if (!result || result.ok !== true) return failure(result && (result.message || result.error) || '补充要求未能发送', result && result.code);
      updateSupplement(task, result.input);
      // steerLiveTurn already persists this input atomically. Never save a stale
      // full conversation here, particularly if it finished during await steer.
      if (active === task) notify(true);
      return { ...result, runId: task.id, conversationId: task.conversationId };
    } catch (error) { return failure(error); }
  }

  async function submit({ text, model, messageId, permissionMode, executionMode, followUpMode, reverseFollowUp, resume = false } = {}) {
    if (destroyed) return failure('快捷对话已关闭', 'DESTROYED');
    if (resetting) return failure('正在保存上一条回复，请稍后重试', 'HISTORY_SAVE_PENDING');
    text = String(text || '').trim();
    if (resume && (text || active)) return failure('任务状态已变化，请重试', 'INVALID_RESUME');
    if (!text && !resume) return failure('请输入内容', 'EMPTY_INPUT');
    if (text.length > 200000) return failure('内容过长，请拆分发送', 'INPUT_TOO_LONG');
    if (active) return supplement(active, text, messageId, { followUpMode, reverseFollowUp: reverseFollowUp === true });
    const preferred = model || conversation && conversation.model || defaultModel();
    model = MODELS.has(preferred) ? preferred : 'sonnet';
    let previous = conversation;
    const task = active = { id: idFactory(), conversationId: conversation && conversation.id || idFactory(), model,
      output: Output.createState(), launchReady: deferred(), savedReady: deferred(), dispatched: false, finished: false,
      pauseRequested: false, stderr: '', turn: null, sessionId: null, route: null, startedAt: Date.parse(timestamp()) };
    try {
      // A previous terminal write may have failed while the reply survived in
      // memory. Commit it before any disk reload can replace that only copy.
      await retryTerminalSave();
      previous = conversation;
      const latest = conversation && await savedConversation(conversation.id);
      if (latest) previous = clone(latest);
      const creating = !latest && !conversation;
      const permissions = await resolvePermissions(latest || conversation);
      if (creating && permissionMode !== undefined) {
        if (!['default', 'acceptEdits', 'bypassPermissions'].includes(permissionMode)) throw Error('无效的对话权限');
        permissions.permissionMode = permissionMode;
        // A visible draft plan remains a plan even if another window updates
        // the new-chat default before this first send. Never relax a legacy plan.
        if (executionMode && ['default', 'plan', 'goal'].includes(executionMode.kind)
            && !permissions.permissionLegacyPlan) permissions.executionMode = clone(executionMode);
      }
      conversation = latest || clone(conversation) || {
        id: task.conversationId, title: Array.from(text.replace(/\s+/g, ' ')).slice(0, 64).join(''),
        createdAt: timestamp(), mode: 'plain', agent: null, agentLabel: null, orchestrateAgents: null,
        sessionId: null, model, sessionModel: model, effort: null,
        workingDir: null, projectId: null, turns: [],
      };
      const resumedFromRunId = resume ? conversation.paused && conversation.paused.runId : null;
      const taskRun = TaskContinuity.begin({ runId: task.id, startedAt: task.startedAt,
        conversation, resumedFromRunId: resume ? resumedFromRunId || 'missing-paused-run' : null });
      if (!taskRun) throw Error('此对话没有可继续的暂停任务');
      const rootTurn = resume && conversation.turns.find(turn => turn.runId === taskRun.taskId);
      const userPrompt = resume ? String(rootTurn && rootTurn.user || '') : text;
      const executionPrompt = resume ? TaskContinuity.RESUME_PROMPT : text;
      Object.assign(conversation, permissions);
      task.carryContextReason = conversation.carryContextOnNextTurn;
      task.resumedPauseId = conversation.paused && conversation.paused.runId;
      task.workingDir = directoryValue(conversation.workingDir);
      task.route = routeFor(conversation);
      const targetRoute = typeof getSessionRoute === 'function' ? await getSessionRoute(model) : null;
      const routeChanged = targetRoute && (!task.route || task.route.providerId !== targetRoute.providerId
        || task.route.providerRevision !== Number(targetRoute.providerRevision || 0) || task.route.routeTier !== model);
      const fresh = !!task.carryContextReason || !!routeChanged || (conversation.sessionModel && conversation.sessionModel !== model);
      task.sessionId = fresh ? null : conversation.sessionId;
      const turnIndex = conversation.turns.length;
      let prompt = executionPrompt;
      if (turnIndex && (fresh || !task.sessionId)) {
        // Explicitly bound prior turns; paused/failed assistant work is retained.
        const context = conversationContext(conversation, { turnIndex });
        if (context) prompt = `${context}\n\n${executionPrompt}`;
      }
      task.turn = { user: text, assistant: '', thinking: null, files: [], skill: null,
        ts: new Date(task.startedAt).toISOString(), taskStartedAt: task.startedAt,
        runId: task.id, taskRun, ...(resume ? { inputKind: 'resume' } : {}), executionMode: clone(conversation.executionMode),
        preview: '', status: 'running', error: null, activityLabel: '正在准备' };
      task.activity = Activity.createState({ phase: 'running', startedAt: task.startedAt,
        taskStartedAt: taskRun.rootStartedAt, taskRun });
      conversation.model = model;
      conversation.updatedAt = task.turn.ts;
      conversation.turns.push(task.turn);
      notify(true);
      const saved = await saveConversation(clone(conversation));
      if (saved && saved.error) throw Error(saved.error);
      task.historySaved = true;
      // The save can initialize/migrate the record or race an explicit change in
      // the main window. Resolve again before launching; never force default.
      if (typeof getPermissions === 'function') {
        if (creating && typeof setPermissions === 'function') {
          const selected = await setPermissions({ conversationId: conversation.id,
            permissionMode: permissions.permissionMode, executionMode: clone(permissions.executionMode) });
          if (!selected || selected.ok !== true) throw Error(selected && (selected.error || selected.message) || '无法保存对话权限');
        }
        Object.assign(conversation, await resolvePermissions(conversation));
        task.turn.executionMode = clone(conversation.executionMode);
      }
      task.savedReady.resolve();
      changed(conversation.id);
      if (task.pauseRequested) {
        task.launchReady.resolve();
        await finish(task, { type: 'job-done', aborted: true, interrupted: task.shutdownRequested, exitCode: -1 });
        return { ok: true, paused: true, runId: task.id, conversationId: task.conversationId };
      }
      task.dispatched = true;
      const request = { prompt, taskStartedAt: task.startedAt, sessionId: task.sessionId || null, sessionRoute: task.route,
        mode: 'plain', files: [], model, effort: conversation.effort || null, agentName: null,
        workingDir: task.workingDir, orchestrateAgents: null,
        convId: task.conversationId, sourceConvId: task.conversationId, runId: task.id,
        forceFreshSession: !!fresh, executionMode: clone(conversation.executionMode),
        taskContext: { userPrompt, taskRun, taskStartedAt: task.startedAt,
          ...(resume ? { inputKind: 'resume' } : {}), turnRef: { index: turnIndex, ts: task.turn.ts } } };
      // Acceptance follows durable user history, not resource admission. A queued
      // launch may wait a long time; the composer must already allow pause/steer.
      task.launchPromise = (async () => {
        let result;
        try { result = await run(request, event => receive(task, event)); }
        catch (error) { result = { error: errorText(error) }; }
        adoptRuntime(task, result || {});
        task.launchReady.resolve();
        if (task.finished) { await task.finishPromise; return; }
        if (!result || result.error || result.ok === false) {
          await finish(task, { ...result, type: 'job-done', exitCode: -1,
            aborted: task.pauseRequested && result && result.code === 'TURN_CANCELED',
            error: result && (result.error || result.message) || '任务启动失败' });
        }
      })().catch(error => {
        task.launchReady.resolve();
        return finish(task, { type: 'job-done', exitCode: -1, error: errorText(error) });
      });
      return { ok: true, runId: task.id, conversationId: task.conversationId };
    } catch (error) {
      task.savedReady.resolve();
      task.launchReady.resolve();
      if (task.historySaved && task.turn) {
        await finish(task, { type: 'job-done', exitCode: -1, error: errorText(error) });
        return failure(`对话无法开始：${errorText(error)}`);
      }
      // Nothing was dispatched: keep the user's text in the composer for retry.
      conversation = previous;
      if (active === task) active = null;
      notify(true);
      return failure(`对话无法开始：${errorText(error)}`);
    }
  }

  async function pause() {
    const task = active;
    if (!task) return { ok: true, paused: false, settled: true };
    if (task.finished) { await task.finishPromise; return { ok: true, paused: false, settled: true }; }
    if (task.pausePromise) return task.pausePromise;
    task.pauseRequested = true;
    if (task.turn) task.turn.activityLabel = '正在暂停';
    notify(true);
    if (!task.dispatched) return { ok: true, paused: true, preparing: true, runId: task.id };
    task.pausePromise = (async () => {
      try {
        if (typeof pauseRun !== 'function') throw Error('当前任务暂时无法暂停');
        const result = await pauseRun(task.id);
        if (task.finished) { await task.finishPromise; return { ...result, ok: true }; }
        if (result && result.paused && result.settled) {
          await finish(task, { type: 'job-done', aborted: true, exitCode: -1 });
          return { ...result, ok: true };
        }
        task.pauseRequested = false;
        task.turn.activityLabel = '正在处理';
        return failure(result && (result.message || result.error) || '未能确认暂停，请稍后重试', result && result.code);
      } catch (error) {
        task.pauseRequested = false;
        if (task.turn) task.turn.activityLabel = '正在处理';
        return failure(error);
      } finally { task.pausePromise = null; notify(true); }
    })();
    return task.pausePromise;
  }

  async function refresh() {
    const previous = conversation;
    if (!previous || active || resetting || pendingTerminalSave || destroyed) return state();
    const latest = await savedConversation(previous.id);
    if (conversation === previous && !active && !resetting && !pendingTerminalSave && !destroyed) {
      conversation = latest; notify(true);
    }
    return state();
  }

  async function newChat() {
    if (destroyed) return failure('快捷对话已关闭', 'DESTROYED');
    if (active) return failure('请先等待回复完成或暂停当前任务', 'RUNNING');
    if (resetting) return failure('正在保存上一条回复，请稍后重试', 'HISTORY_SAVE_PENDING');
    resetting = true;
    try {
      await retryTerminalSave();
      conversation = null; notify(true);
      return { ok: true };
    } catch (error) { return failure(error, 'HISTORY_SAVE_FAILED'); }
    finally { resetting = false; }
  }
  async function shutdown() {
    destroyed = true; clearTimeout(stateTimer); stateTimer = null;
    const task = active;
    if (!task) { await retryTerminalSave(); return; }
    task.shutdownRequested = true;
    task.pauseRequested = true;
    // before-quit awaits this history barrier before its existing executor cleanup.
    // This marks an interrupted process, never claims it was gracefully paused.
    await task.savedReady.promise;
    task.launchReady.resolve();
    if (task.turn && active === task) await finish(task, { type: 'job-done', aborted: true, interrupted: true, exitCode: -1 });
  }
  async function flush() {
    if (active) return failure('请先等待回复完成或暂停当前任务', 'RUNNING');
    if (resetting) return failure('正在保存上一条回复，请稍后重试', 'HISTORY_SAVE_PENDING');
    resetting = true;
    try { await retryTerminalSave(); return { ok: true }; }
    catch (error) { return failure(error, 'HISTORY_SAVE_FAILED'); }
    finally { resetting = false; }
  }
  return {
    state, submit, pause, newChat, shutdown, flush, refresh,
    getConversationId: () => conversation && conversation.id || null,
    isRunning: () => !!active,
    destroy() { destroyed = true; clearTimeout(stateTimer); stateTimer = null; },
  };
}

module.exports = { createMiniChatController };
