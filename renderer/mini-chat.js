/* A persistent conversation surface. The main process owns its session and run. */
(function initMiniChat() {
  'use strict';
  const api = window.api && window.api.mini;
  const providers = window.api && window.api.providers;
  const TaskContinuity = window.RelayTaskContinuity;
  const permissionsApi = window.api && window.api.permissions;
  const byId = (id) => document.getElementById(id);
  const ui = {
    card: byId('miniCard'), input: byId('miniInput'), form: byId('miniForm'),
    transcript: byId('miniTranscript'), turns: byId('miniTurns'),
    send: byId('miniSend'), error: byId('miniError'), pin: byId('miniPin'),
    newChat: byId('miniNew'), openMain: byId('miniOpenMain'), hide: byId('miniHide'),
    model: byId('miniModelButton'), modelLabel: byId('miniModelLabel'), menu: byId('miniModelMenu'),
    brand: byId('miniBrand'), logo: byId('miniLogo'), live: byId('miniLiveStatus'),
    decision: byId('interactionSurfaceMount'), permission: byId('miniPermissionMode'),
  };
  const names = { haiku: '快速', sonnet: '思考', opus: '专家' };
  const MIN_WINDOW_HEIGHT = 246, MAX_WINDOW_HEIGHT = 600;
  const turnViews = new Map();
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
  let state = { conversation: null, running: false, pinned: false };
  let model = 'sonnet', modelChosen = false, pending = false, followOutput = true;
  let stateRevision = 0, renderFrame = 0, layoutFrame = 0, requestedHeight = 0;
  let theme = 'light', conversationId = '', disposed = false;
  let routes = [], routeStatus = 'loading', routeRevision = 0;
  let permissionState = null, permissionStatus = 'loading', permissionRequest = 0, permissionWriting = false;
  let permissionControl = null;
  const composerDrafts = new Map();
  let composerOwner = { text: '', selectionStart: 0, selectionEnd: 0 };
  let composerConversationId = '';
  let pendingSubmission = null;
  const off = [];

  function captureComposerDraft() {
    composerOwner.text = ui.input.value;
    composerOwner.selectionStart = ui.input.selectionStart;
    composerOwner.selectionEnd = ui.input.selectionEnd;
    return composerOwner;
  }
  function switchComposerConversation(nextId, conversation) {
    captureComposerDraft();
    // The host creates the conversation during its first submit. Any text typed
    // while that submit is being prepared still belongs to the same composer.
    const firstSubmission = !composerConversationId && nextId && pendingSubmission
      && pendingSubmission.owner === composerOwner && pendingSubmission.newConversation
      && conversation.turns?.[0]?.user === pendingSubmission.text;
    if (firstSubmission) composerDrafts.set(nextId, composerOwner);
    else {
      composerOwner = nextId && composerDrafts.get(nextId) || { text: '', selectionStart: 0, selectionEnd: 0 };
      if (nextId) composerDrafts.set(nextId, composerOwner);
      ui.input.value = composerOwner.text;
      ui.input.setSelectionRange(composerOwner.selectionStart, composerOwner.selectionEnd);
    }
    setError(''); autoGrow();
  }

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
  if (window.marked) {
    window.marked.use({ breaks: true, renderer: {
      html(token) { return escapeHtml(typeof token === 'string' ? token : token.text || ''); },
      image(...args) { return window.RelayLocalMarkdownImages?.image(...args) ?? false; },
    } });
    window.relayRenderMarkdown = (text) => window.marked.parse(String(text || '').replace(/([^\n`])(```+)/g, '$1\n$2'));
  }
  function markdown(node, text) {
    const value = String(text || '');
    if (node._renderedText === value) return;
    node._renderedText = value;
    if (typeof window.relayRenderReadOnlyMarkdown === 'function') window.relayRenderReadOnlyMarkdown(node, value, { localImages: true });
    else node.textContent = value;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function setError(message) {
    ui.error.textContent = message || '';
    ui.error.hidden = !message;
    scheduleLayout();
  }
  function applyBrand(brand) {
    if (!brand) return;
    const name = String(brand.name || 'Relay');
    ui.brand.textContent = name;
    ui.brand.title = name;
    document.title = name + ' 快捷对话';
    ui.logo.classList.toggle('relay-default-logo', !brand.logo);
    const source = brand.logo || 'logo.svg';
    if (ui.logo.getAttribute('src') !== source) ui.logo.src = source;
    theme = brand.theme || theme;
    applyTheme();
  }
  function applyTheme() {
    document.documentElement.dataset.theme = theme === 'dark' || (theme === 'system' && darkMedia.matches) ? 'dark' : 'light';
  }
  async function refreshBrand() {
    if (!api || typeof api.brand !== 'function') return;
    try { applyBrand(await api.brand()); } catch (_) {}
  }
  function routingFrom(value) {
    const routing = value && (value.routes || value.active && value.active.routes || value);
    return routing && Array.isArray(routing.chatRoutes) ? routing : null;
  }
  function routeFor(tier) { return routes.find(route => route && route.tier === tier) || null; }
  function routeAvailable(tier) {
    const route = routeFor(tier);
    return routeStatus === 'ready' && !!(route && route.configured && route.available);
  }
  function routeDisplay(tier) {
    if (routeStatus === 'error') return { label: '模型加载失败', tooltip: '暂时无法读取模型配置，重新打开菜单重试' };
    return window.RelayModelDisplay.describeRoute(routeFor(tier), { loaded: routeStatus === 'ready' });
  }
  function applyRoutes(routing) {
    routes = routing.chatRoutes;
    routeStatus = 'ready';
    // A provider change updates availability, never changes the current chat's
    // selected tier or pretends a running task switched its model.
    updateControls(); scheduleLayout();
  }
  async function refreshRoutes() {
    const revision = ++routeRevision;
    try {
      if (!providers || typeof providers.list !== 'function') throw Error('Unavailable provider API');
      const response = await providers.list();
      if (disposed || revision !== routeRevision) return;
      const routing = response && response.ok !== false && routingFrom(response);
      if (!routing) throw Error('Unavailable provider routes');
      applyRoutes(routing);
    } catch (_) {
      if (disposed || revision !== routeRevision) return;
      routeStatus = 'error'; updateControls();
    }
  }
  const currentPermissionId = () => String(state.conversation && state.conversation.id || '');
  function applyPermissionState(value) {
    if (!value || value.ok !== true || String(value.conversationId || '') !== currentPermissionId()
        || !['default', 'acceptEdits', 'bypassPermissions'].includes(value.permissionMode)
        || !value.executionMode || !['default', 'plan', 'goal'].includes(value.executionMode.kind)) return false;
    if (permissionState && String(permissionState.conversationId || '') === currentPermissionId()
        && Number(value.revision) < Number(permissionState.revision)) return false;
    permissionState = value;
    permissionStatus = 'ready';
    updateControls();
    return true;
  }
  async function refreshPermissions({ strict = false } = {}) {
    const request = ++permissionRequest, id = currentPermissionId();
    try {
      if (!permissionsApi || typeof permissionsApi.get !== 'function') throw Error('暂时无法读取对话权限');
      const response = await permissionsApi.get(id || undefined);
      if (disposed || request !== permissionRequest || id !== currentPermissionId()) return;
      if (!applyPermissionState(response)) throw Error(response && (response.error || response.message) || '暂时无法读取对话权限');
    } catch (error) {
      if (disposed || request !== permissionRequest || id !== currentPermissionId()) return;
      permissionStatus = 'error'; updateControls();
      if (strict) throw error;
    }
  }
  function permissionView() {
    return { permissionMode: permissionState && permissionState.permissionMode || undefined,
      plan: !!(permissionState && (permissionState.legacyPlan || permissionState.executionMode.kind === 'plan')),
      disabled: permissionStatus !== 'ready' || pending,
      busy: permissionWriting };
  }
  function canResume() {
    return !state.running && !!state.conversation?.paused?.runId && !!TaskContinuity?.begin({
      runId: 'mini-resume-preview', startedAt: Date.now(), conversation: state.conversation,
      resumedFromRunId: state.conversation.paused.runId,
    });
  }
  function taskTime(turn) {
    const taskRun = TaskContinuity?.normalize(turn.taskRun);
    if (!taskRun) return '';
    const seconds = Math.floor(TaskContinuity.activeDuration(taskRun) / 1000);
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    return (hours ? hours + '小时' : '') + (hours || minutes ? minutes + '分' : '') + seconds % 60 + '秒';
  }
  function refreshTaskTimes() {
    for (const view of turnViews.values()) {
      const text = view.isTaskHead ? taskTime(view.taskSource || view.turn || {}) : '';
      view.time.textContent = text; view.time.hidden = !text;
      if (view.timelineSegments) {
        const parts = [...view.timelineSegments.values()];
        parts.forEach(part => { part.time.textContent = ''; part.time.hidden = true; });
      }
    }
  }
  function syncTaskProcesses() {
    const groups = new Map();
    for (const view of turnViews.values()) {
      const group = groups.get(view.taskKey) || [];
      group.push(view); groups.set(view.taskKey, group);
    }
    for (const views of groups.values()) {
      const head = views.find(view => view.isTaskHead);
      if (!head) continue;
      for (const view of views) {
        const processes = [view.process, ...[...(view.timelineSegments?.values() || [])].map(part => part.process)];
        for (const process of processes) {
          const isHead = process === head.process;
          process.dataset.taskHead = String(isHead);
          process.querySelector('summary').hidden = !isHead;
          process.classList.toggle('is-continuation', !isHead);
          if (!isHead && process.open !== head.process.open) process.open = head.process.open;
        }
      }
    }
  }
  function updateControls() {
    const hasText = !!ui.input.value.trim();
    const stopping = !!state.running && !hasText;
    const resuming = !hasText && canResume();
    ui.send.classList.toggle('is-stop', stopping);
    const unavailable = !state.running && !routeAvailable(model);
    ui.send.disabled = pending || permissionWriting || (!hasText && !state.running && !resuming) || !api || unavailable
      || (!state.running && permissionStatus !== 'ready');
    const sendLabel = stopping ? '暂停' : state.running ? (state.followUpMode === 'queue' ? '加入队列 · Ctrl+Enter 调整方向' : '调整方向 · Ctrl+Enter 加入队列') : unavailable ? '请先选择可用模型' : resuming ? '继续任务' : '发送';
    ui.send.title = sendLabel;
    ui.send.setAttribute('aria-label', sendLabel);
    ui.newChat.disabled = !!state.running || pending;
    ui.newChat.title = state.running ? '回复完成后新建对话' : '新对话';
    ui.openMain.disabled = !!state.running || pending;
    ui.openMain.title = state.running ? '回复完成后在主窗口查看' : '在主窗口中打开';
    ui.pin.setAttribute('aria-pressed', state.pinned ? 'true' : 'false');
    ui.pin.title = state.pinned ? '取消置顶' : '置顶窗口';
    ui.pin.setAttribute('aria-label', ui.pin.title);
    ui.input.placeholder = state.running ? (state.followUpMode === 'queue' ? '添加下一项要求…' : '补充要求，继续当前任务…') : '问点什么…';
    ui.modelLabel.textContent = names[model] || names.sonnet;
    const currentDisplay = routeDisplay(model);
    ui.model.title = `${names[model] || names.sonnet} · ${currentDisplay.tooltip}`;
    ui.model.setAttribute('aria-label', `当前模型 ${names[model] || names.sonnet}，${currentDisplay.label}，打开模型选择`);
    for (const button of ui.menu.querySelectorAll('[data-model]')) {
      const tier = button.dataset.model, display = routeDisplay(tier), available = routeAvailable(tier);
      button.disabled = !available;
      button.setAttribute('aria-disabled', String(!available));
      button.setAttribute('aria-checked', String(tier === model));
      button.setAttribute('aria-label', `${names[tier]}，${display.label}${available ? '' : '，不可用'}`);
      button.title = `${display.tooltip}${routeStatus === 'ready' && !available ? ' · 当前不可用，请在设置中配置服务商' : ''}`;
      button.querySelector('small').textContent = display.label;
    }
    if (permissionControl) permissionControl.sync();
  }
  function receiveState(next) {
    if (!next || disposed) return;
    const nextId = String(next.conversation?.id || '');
    if (nextId !== composerConversationId) {
      switchComposerConversation(nextId, next.conversation || {});
      composerConversationId = nextId;
    }
    stateRevision += 1;
    state = next;
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => { renderFrame = 0; render(); });
  }
  function render() {
    const conversation = state.conversation || {};
    const nextId = String(conversation.id || '');
    if (nextId !== conversationId) {
      conversationId = nextId;
      turnViews.clear();
      ui.turns.replaceChildren();
      followOutput = true;
      modelChosen = false;
      permissionState = null; permissionStatus = 'loading';
      if (permissionControl) permissionControl.close();
      void refreshPermissions();
      window.dispatchEvent(new CustomEvent('relay:conversation-changed', { detail: { conversationId } }));
    }
    if (!modelChosen && names[conversation.model || state.model]) model = conversation.model || state.model;
    applyBrand(state.brand);
    const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
    const retained = new Set();
    const lastTaskRuns = new Map();
    for (const turn of turns) {
      const taskRun = TaskContinuity?.normalize(turn.taskRun);
      if (taskRun) lastTaskRuns.set(taskRun.taskId, turn);
      if (TaskContinuity?.isResume(turn)) lastTaskRuns.set(turn.taskRun.resumedFromRunId, turn);
    }
    const firstTaskRuns = new Set();
    turns.forEach((turn, index) => {
      const key = String(turn.id || index);
      retained.add(key);
      let view = turnViews.get(key);
      if (!view) {
        view = createTurnView();
        turnViews.set(key, view);
        ui.turns.append(view.root);
      }
      const taskId = TaskContinuity?.normalize(turn.taskRun)?.taskId || turn.runId;
      view.turn = turn; view.priorTask = !!lastTaskRuns.get(taskId) && lastTaskRuns.get(taskId) !== turn;
      view.taskSource = lastTaskRuns.get(taskId) || turn;
      view.taskKey = TaskContinuity?.normalize(view.taskSource.taskRun)?.taskId || taskId || key;
      view.isTaskHead = !firstTaskRuns.has(view.taskKey); firstTaskRuns.add(view.taskKey);
      view.taskRunning = !!state.running && view.taskSource === turns.at(-1);
      renderTurn(view, turn, !!state.running && index === turns.length - 1);
    });
    for (const [key, view] of turnViews) if (!retained.has(key)) { view.root.remove(); turnViews.delete(key); }
    ui.transcript.hidden = !turns.length;
    ui.card.classList.toggle('has-conversation', !!turns.length);
    updateControls();
    syncTaskProcesses();
    refreshTaskTimes();
    const statusText = state.running ? activityLabelFor(turns.at(-1)) : turns.length ? '回复已结束' : '';
    if (ui.live.textContent !== statusText) ui.live.textContent = statusText;
    scheduleLayout();
  }
  function createTurnView() {
    const root = element('article', 'mini-turn');
    const user = element('div', 'mini-user');
    const supplements = element('div', 'mini-supplements');
    const process = element('details', 'mini-process');
    const summary = element('summary');
    const mark = element('span', 'mini-process-mark');
    mark.setAttribute('aria-hidden', 'true');
    const label = element('span', 'mini-process-label');
    const time = element('span', 'mini-task-time');
    summary.append(mark, label, time);
    const processContent = element('div', 'mini-process-content');
    process.append(summary, processContent);
    process.addEventListener('toggle', () => {
      if (process.dataset.taskHead === 'true') syncTaskProcesses();
      scheduleLayout();
    });
    summary.addEventListener('click', () => { process.dataset.userToggled = '1'; });
    const answer = element('div', 'mini-answer');
    const error = element('div', 'mini-turn-error');
    const status = element('div', 'mini-turn-status');
    const actions = element('div', 'mini-answer-actions');
    const copy = element('button', 'mini-icon-button mini-copy');
    copy.type = 'button'; copy.title = '复制回复'; copy.setAttribute('aria-label', '复制回复');
    copy.innerHTML = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
    const timestamp = element('time', 'mini-message-time');
    timestamp.hidden = true;
    actions.append(copy, timestamp);
    const view = { root, user, supplements, process, label, time, processContent, answer, error, status, actions, copy, timestamp, finalText: '', processSignature: '', supplementSignature: '' };
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(view.finalText);
        copy.title = '已复制'; copy.setAttribute('aria-label', '已复制');
        ui.live.textContent = '已复制回复';
        setTimeout(() => { copy.title = '复制回复'; copy.setAttribute('aria-label', '复制回复'); }, 1400);
      } catch (_) { setError('暂时无法复制，请选中回复后复制。'); }
    });
    root.append(user, process, supplements, answer, error, status, actions);
    return view;
  }
  function activityLabelFor(turn) {
    const activity = turn?.activity;
    const retry = activity?.items?.find(item => item.id === 'relay-api-retry' && item.status === 'running');
    if (retry) return retry.title;
    if (activity?.startupPhase === 'preparing') return '正在准备';
    if (activity?.startupPhase === 'waiting') return '正在等待回复';
    return String(turn?.activityLabel || '正在处理');
  }
  function renderTurn(view, turn, running) {
    view.user.textContent = String(turn.user || '');
    view.user.hidden = !view.user.textContent;
    const inputs = Array.isArray(turn.supplements) ? turn.supplements : [];
    const timelineMode = !!window.RelaySupplementTimeline && inputs.some(input => window.RelaySupplementTimeline.normalize(input.presentation));
    const supplementSignature = JSON.stringify(inputs);
    if (!timelineMode && view.supplementSignature !== supplementSignature) {
      view.supplementSignature = supplementSignature;
      view.supplements.replaceChildren(...inputs.map((input) => {
        const entry = element('div', 'mini-supplement');
        const message = element('div', 'mini-user', String(input.text || ''));
        const label = element('div', 'mini-supplement-status', ({ queued: input.followUpMode === 'queue' ? '后续要求 · 已排队' : '补充要求 · 等待接收', applied: '补充要求 · 已送达', canceled: '补充要求 · 未处理', rejected: '补充要求 · 未送达' })[input.status] || '补充要求');
        entry.append(message, label); return entry;
      }));
    }
    view.supplements.hidden = timelineMode || !inputs.length;
    let processItems = [], output = null;
    if (turn.output && window.RelayAssistantOutput) {
      output = window.RelayAssistantOutput.createState(turn.output);
      processItems = window.RelayAssistantOutput.processItems(output, { includeChildren: true });
    }
    if (!output && running && turn.preview) {
      const text = typeof turn.preview === 'string' ? turn.preview : String(turn.preview.text || '');
      if (text) processItems.push({ id: 'legacy-preview', type: 'narration', title: '执行过程', result: text, status: 'running' });
    }
    if (Array.isArray(turn.activities)) processItems = processItems.concat(turn.activities);
    const finalText = !running && (!output || output.status === 'complete') ? String(turn.assistant || output?.final || '') : '';
    const visible = finalText;
    if (!timelineMode) markdown(view.answer, visible);
    view.answer.hidden = timelineMode || !visible;
    view.answer.classList.toggle('is-streaming', running && !finalText);
    view.finalText = finalText;
    view.actions.hidden = running || !finalText;
    const stamp = window.RelayMessageTime.compact(turn.assistantTs);
    view.timestamp.hidden = running || !finalText || !stamp;
    view.timestamp.textContent = stamp;
    view.timestamp.dateTime = stamp ? turn.assistantTs : '';
    view.timestamp.title = window.RelayMessageTime.full(turn.assistantTs);
    view.error.textContent = [turn.error, turn.saveError].filter(Boolean).map(String).join('\n');
    view.error.hidden = !view.error.textContent;
    view.status.textContent = view.priorTask ? '' : turn.status === 'paused' || turn.status === 'canceled' ? '已暂停' : turn.status === 'queued' ? '已补充，等待继续处理' : String(turn.outputNotice || '');
    view.status.hidden = !view.status.textContent;
    view.process.hidden = !view.isTaskHead && (timelineMode || !processItems.length);
    if (!view.process.dataset.userToggled) view.process.open = view.taskRunning;
    view.process.classList.toggle('is-running', view.isTaskHead ? view.taskRunning : running);
    const source = view.taskSource || turn;
    view.label.textContent = view.isTaskHead ? view.taskRunning ? activityLabelFor(source)
      : /^(paused|canceled)$/.test(source.status) ? '已暂停'
        : source.status === 'error' ? '处理未完成' : source.status === 'complete' ? '已结束' : '思考与工作过程' : '';
    if (timelineMode) {
      view.processContent.hidden = true;
      renderSupplementTimeline(view, turn, output, processItems, running);
      return;
    }
    if (view.timeline) view.timeline.hidden = true;
    const signature = JSON.stringify(processItems);
    if (view.processSignature !== signature) {
      view.processSignature = signature;
      const nodes = [];
      for (const item of processItems) {
        const entry = element('div', 'mini-process-entry');
        const title = element('div', 'mini-process-entry-title', String(item.title || item.toolName || '执行过程'));
        const content = element('div', 'mini-process-entry-body');
        // Tool data is text, never a DOM or an executable preview.
        content.textContent = String(item.displayText || item.result || item.detail || item.text || '');
        entry.append(title, content); nodes.push(entry);
      }
      view.processContent.replaceChildren(...nodes);
      view.processContent.hidden = !nodes.length;
    }
  }
  function renderSupplementTimeline(view, turn, output, processItems, running) {
    if (!view.timeline) {
      view.timeline = element('div', 'mini-timeline');
      view.process.after(view.timeline);
      view.timelineSegments = new Map();
    }
    view.timeline.hidden = false;
    const segments = window.RelaySupplementTimeline.plan({ output, activityItems: processItems,
      supplements: turn.supplements });
    const nodes = [];
    segments.forEach((segment, index) => {
      let part = view.timelineSegments.get(segment.key);
      if (!part) {
        const root = element('div', 'mini-timeline-segment');
        root.dataset.segment = segment.key;
        const process = element('details', 'mini-process');
        const summary = element('summary'), mark = element('span', 'mini-process-mark');
        mark.setAttribute('aria-hidden', 'true');
        const label = element('span', 'mini-process-label');
        const time = element('span', 'mini-task-time');
        summary.append(mark, label, time);
        const content = element('div', 'mini-process-content');
        process.append(summary, content); process.addEventListener('toggle', scheduleLayout);
        summary.addEventListener('click', () => { process.dataset.userToggled = '1'; });
        const answer = element('div', 'mini-answer');
        const input = element('div', 'mini-supplement');
        const message = element('div', 'mini-user'), status = element('div', 'mini-supplement-status');
        input.append(message, status); root.append(process, answer, input);
        part = { root, process, label, time, content, answer, input, message, status, signature: null };
        view.timelineSegments.set(segment.key, part);
      }
      const last = index === segments.length - 1;
      const pending = running && (last || segment.items.some(item => item.status === 'running'));
      part.process.hidden = !segment.items.length && !last;
      if (!part.process.dataset.userToggled) part.process.open = running;
      part.process.classList.toggle('is-running', pending);
      part.label.textContent = !last || view.priorTask ? '此前过程' : pending ? activityLabelFor(turn) : '思考与工作过程';
      const signature = JSON.stringify(segment.items);
      if (signature !== part.signature) {
        part.signature = signature;
        part.content.replaceChildren(...segment.items.map(item => {
          const entry = element('div', 'mini-process-entry');
          entry.append(element('div', 'mini-process-entry-title', String(item.title || item.toolName || '执行过程')),
            element('div', 'mini-process-entry-body', String(item.displayText || item.result || item.detail || item.text || '')));
          return entry;
        }));
        part.content.hidden = !segment.items.length;
      }
      markdown(part.answer, segment.displayText ?? segment.text); part.answer.hidden = !segment.text;
      part.answer.classList.toggle('is-streaming', running && last);
      part.input.hidden = !segment.inputAfter;
      if (segment.inputAfter) {
        const input = segment.inputAfter;
        part.input.dataset.supplementId = input.id;
        part.message.textContent = input.text || '';
        part.status.textContent = ({ queued: input.followUpMode === 'queue' ? '后续要求 · 已排队' : '补充要求 · 等待接收',
          applied: '补充要求 · 已送达', canceled: '补充要求 · 未处理', rejected: '补充要求 · 未送达' })[input.status] || '补充要求';
      }
      nodes.push(part.root);
    });
    let next = null;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (nodes[index].parentNode !== view.timeline || nodes[index].nextSibling !== next) view.timeline.insertBefore(nodes[index], next);
      next = nodes[index];
    }
  }
  function autoGrow() {
    ui.input.style.height = '0px';
    const wanted = ui.input.scrollHeight;
    ui.input.style.height = Math.max(42, Math.min(150, wanted)) + 'px';
    ui.input.style.overflowY = wanted > 150 ? 'auto' : 'hidden';
    updateControls();
    scheduleLayout();
  }
  function scheduleLayout() {
    if (layoutFrame || disposed) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      const head = document.querySelector('.mini-head').offsetHeight;
      const composer = ui.form.offsetHeight;
      const decision = ui.decision.hidden ? 0 : ui.decision.scrollHeight;
      const error = ui.error.hidden ? 0 : ui.error.offsetHeight + 3;
      const fixed = head + composer + decision + error + 34;
      const body = ui.transcript.hidden ? 0 : Math.max(96, ui.turns.scrollHeight);
      // Measure the desired content size without assigning it to the viewport.
      // The native window approaches this target over several frames; flex
      // layout follows its actual height so the composer never jumps ahead.
      const height = Math.ceil(Math.max(MIN_WINDOW_HEIGHT, Math.min(MAX_WINDOW_HEIGHT, fixed + body)));
      if (Math.abs(height - requestedHeight) > 1) {
        requestedHeight = height;
        if (api && typeof api.resize === 'function') Promise.resolve(api.resize({ height, reducedMotion: motionMedia.matches })).catch(() => {});
      }
      if (followOutput) ui.transcript.scrollTop = ui.transcript.scrollHeight;
    });
  }
  async function submit(reverseFollowUp = false) {
    if (pending || permissionWriting || !api) return;
    const draft = ui.input.value;
    const text = draft.trim();
    const resuming = !text && canResume();
    if (!text && !state.running && !resuming) return;
    if (!state.running && permissionStatus !== 'ready') {
      setError('暂时无法确认对话权限，请重新打开小窗后重试。'); return;
    }
    if (!state.running && !routeAvailable(model)) {
      setError(routeStatus === 'error' ? '暂时无法读取模型配置，请重新打开模型菜单重试。' : '当前档位没有可用模型，请先选择已配置的模型。');
      return;
    }
    const submission = { owner: captureComposerDraft(), text, newConversation: !state.conversation };
    pendingSubmission = submission;
    pending = true; updateControls(); setError(''); closeModelMenu();
    try {
      const result = text || resuming ? await api.submit({ text, model, reverseFollowUp, ...(resuming ? { resume: true } : {}),
        ...(!state.conversation && permissionState ? { permissionMode: permissionState.permissionMode,
          executionMode: permissionState.legacyPlan ? { kind: 'plan' } : permissionState.executionMode } : {}) }) : await api.pause();
      if (result && result.ok === false) throw new Error(result.error || '暂时无法发送，请重试。');
      if (composerOwner === submission.owner) {
        if (text && ui.input.value === draft) ui.input.value = '';
        captureComposerDraft(); followOutput = true; autoGrow();
        ui.input.focus({ preventScroll: true });
      } else if (text && submission.owner.text === draft) submission.owner.text = '';
    } catch (error) {
      if (composerOwner === submission.owner) setError(error && error.message || '发送失败，请重试。');
    }
    finally { if (pendingSubmission === submission) pendingSubmission = null; pending = false; updateControls(); }
  }
  function closeModelMenu(restoreFocus = false) {
    ui.menu.hidden = true;
    ui.model.setAttribute('aria-expanded', 'false');
    if (restoreFocus) ui.model.focus({ preventScroll: true });
  }
  function openModelMenu() {
    if (permissionControl) permissionControl.close();
    ui.menu.hidden = false;
    ui.model.setAttribute('aria-expanded', 'true');
    const selected = ui.menu.querySelector('[aria-checked="true"]:not(:disabled)') || ui.menu.querySelector('button:not(:disabled)');
    if (selected) selected.focus({ preventScroll: true });
    void refreshRoutes();
  }
  if (window.RelayPermissionControls && ui.permission) {
    permissionControl = window.RelayPermissionControls.create({
      button: ui.permission, getState: permissionView,
      beforeOpen: async () => {
        closeModelMenu();
        if (currentPermissionId() || permissionStatus !== 'ready') await refreshPermissions({ strict: true });
      },
      notify: message => setError(String(message && message.message || message || '权限更新失败')),
      onChange: async permissionMode => {
        if (!permissionsApi || typeof permissionsApi.set !== 'function') throw Error('权限设置未连接');
        const id = currentPermissionId();
        permissionWriting = true; ++permissionRequest; updateControls();
        try {
          const result = await permissionsApi.set({ conversationId: id || undefined, permissionMode,
            ...(id && permissionState ? { expectedRevision: permissionState.revision } : {}) });
          if (!result || result.ok !== true) {
            if (result && result.current) applyPermissionState(result.current);
            throw Error(result && (result.error || result.message) || '权限更新失败');
          }
          if (disposed || id !== currentPermissionId()) return;
          if (!applyPermissionState(result)) await refreshPermissions({ strict: true });
          setError('');
        } finally { permissionWriting = false; updateControls(); }
      },
    });
  }
  ui.model.addEventListener('click', () => ui.menu.hidden ? openModelMenu() : closeModelMenu(true));
  ui.menu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-model]');
    if (!button || button.disabled) return;
    model = button.dataset.model; modelChosen = true;
    updateControls(); closeModelMenu(true);
  });
  ui.menu.addEventListener('keydown', (event) => {
    const buttons = [...ui.menu.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (buttons.length) buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus({ preventScroll: true });
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); if (buttons.length) buttons[event.key === 'Home' ? 0 : buttons.length - 1].focus({ preventScroll: true });
    } else if (event.key === 'Tab') closeModelMenu();
  });
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.mini-model')) closeModelMenu(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    if (!ui.menu.hidden) closeModelMenu(true);
    else if (api) Promise.resolve(api.hide()).catch(() => {});
  });
  ui.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.repeat && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); submit(event.ctrlKey || event.metaKey); }
  });
  ui.input.addEventListener('input', autoGrow);
  ui.form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  function revealScrollbarAtEdge(node) {
    let timer = null, dragging = false;
    const overflowing = () => node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 1;
    const nearEdge = event => {
      const rect = node.getBoundingClientRect();
      return overflowing() && event.clientX >= rect.right - 18 && event.clientX <= rect.right + 1
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
    };
    const move = event => node.classList.toggle('is-scroll-near', nearEdge(event));
    const clearNear = () => node.classList.remove('is-scroll-near');
    const scroll = () => {
      if (!overflowing()) return;
      node.classList.add('is-scroll-active');
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; node.classList.remove('is-scroll-active'); }, 900);
    };
    const down = event => {
      if (event.button !== 0 || !nearEdge(event)) return;
      dragging = true; node.classList.add('is-scroll-dragging');
      // Do not capture or cancel the pointer: Chromium owns native thumb drag.
    };
    const up = () => { if (dragging) { dragging = false; node.classList.remove('is-scroll-dragging'); scroll(); } };
    const blur = () => { clearNear(); up(); };
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerdown', down, { passive: true });
    document.addEventListener('pointerup', up, { passive: true });
    document.addEventListener('pointercancel', up, { passive: true });
    document.documentElement.addEventListener('pointerleave', clearNear, { passive: true });
    window.addEventListener('blur', blur);
    node.addEventListener('scroll', scroll, { passive: true });
    off.push(() => {
      clearTimeout(timer);
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerdown', down);
      document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
      document.documentElement.removeEventListener('pointerleave', clearNear);
      window.removeEventListener('blur', blur); node.removeEventListener('scroll', scroll);
    });
  }
  revealScrollbarAtEdge(ui.transcript); revealScrollbarAtEdge(ui.input);
  ui.transcript.addEventListener('scroll', () => {
    followOutput = ui.transcript.scrollHeight - ui.transcript.clientHeight - ui.transcript.scrollTop < 48;
  }, { passive: true });
  ui.hide.addEventListener('click', () => { if (api) Promise.resolve(api.hide()).catch(() => {}); });
  ui.pin.addEventListener('click', async () => {
    if (!api || ui.pin.disabled) return;
    ui.pin.disabled = true;
    try {
      const result = await api.setPinned(!state.pinned);
      if (result && result.ok === false) throw new Error(result.error || '置顶设置失败');
    } catch (error) { setError(error.message); }
    finally { ui.pin.disabled = false; }
  });
  ui.newChat.addEventListener('click', async () => {
    if (!api || state.running || pending) return;
    pending = true; updateControls();
    try {
      const result = await api.newChat();
      if (result && result.ok === false) throw new Error(result.error || '新建对话失败');
      if (state.conversation) return;
      permissionState = null; permissionStatus = 'loading';
      const newConversation = state;
      await refreshPermissions();
      if (state !== newConversation && state.conversation) return;
      ui.input.value = ''; modelChosen = false; setError(''); autoGrow();
      captureComposerDraft();
      ui.input.focus({ preventScroll: true });
    } catch (error) { setError(error.message); }
    finally { pending = false; updateControls(); }
  });
  async function openMain() {
    if (!api || state.running || pending) return;
    try {
      const result = await api.openMain();
      if (result && result.ok === false) throw new Error(result.error || '打开主窗口失败');
    } catch (error) { setError(error.message); }
  }
  ui.openMain.addEventListener('click', openMain);
  window.addEventListener('relay:open-conversation', (event) => { event.preventDefault(); openMain(); });
  darkMedia.addEventListener('change', applyTheme);
  const observer = new ResizeObserver(scheduleLayout);
  const localImages = window.RelayLocalMarkdownImages?.install(ui.turns, {
    context: () => ({ conversationId: state.conversation?.id || null }),
    read: input => api?.readLocalImage?.(input),
    onChange: scheduleLayout,
  });
  observer.observe(ui.turns); observer.observe(ui.form); observer.observe(ui.decision);
  window.addEventListener('resize', () => { scheduleLayout(); if (followOutput) ui.transcript.scrollTop = ui.transcript.scrollHeight; });
  const clockTimer = setInterval(() => { if (state.running && !document.hidden) refreshTaskTimes(); }, 1000);
  window.addEventListener('beforeunload', () => {
    disposed = true;
    clearInterval(clockTimer);
    observer.disconnect(); off.forEach((fn) => fn());
    localImages?.destroy();
    if (permissionControl) permissionControl.destroy();
    if (renderFrame) cancelAnimationFrame(renderFrame);
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
  }, { once: true });
  async function connect() {
    if (!api || typeof api.state !== 'function') { setError('快捷对话未连接，请重新启动 Relay。'); return; }
    if (typeof api.onState === 'function') {
      const unsubscribe = api.onState(receiveState);
      if (typeof unsubscribe === 'function') off.push(unsubscribe);
    }
    if (typeof api.onFocus === 'function') {
      const unsubscribe = api.onFocus(() => {
        // Hiding can stop a native resize partway through. Reissue the content
        // target when revealed, while keeping the same draft and transcript.
        requestedHeight = 0;
        const revision = stateRevision;
        if (typeof api.state === 'function') api.state().then(snapshot => {
          if (!disposed && revision === stateRevision) receiveState(snapshot);
        }).catch(() => {});
        refreshBrand();
        void refreshRoutes();
        if (currentPermissionId() || permissionStatus !== 'ready') void refreshPermissions();
        requestAnimationFrame(() => { ui.input.focus({ preventScroll: true }); autoGrow(); });
      });
      if (typeof unsubscribe === 'function') off.push(unsubscribe);
    }
    if (providers && typeof providers.onChanged === 'function') {
      const unsubscribe = providers.onChanged(payload => {
        const routing = routingFrom(payload);
        if (!routing) { void refreshRoutes(); return; }
        ++routeRevision;
        applyRoutes(routing);
      });
      if (typeof unsubscribe === 'function') off.push(unsubscribe);
    }
    if (permissionsApi && typeof permissionsApi.onChanged === 'function') {
      const unsubscribe = permissionsApi.onChanged(() => { if (currentPermissionId()) void refreshPermissions(); });
      if (typeof unsubscribe === 'function') off.push(unsubscribe);
    }
    void refreshRoutes();
    const revision = stateRevision;
    try {
      const initial = await api.state();
      if (revision === stateRevision) receiveState(initial);
    } catch (_) { setError('暂时无法读取快捷对话，请稍后重试。'); }
    await refreshPermissions();
    await refreshBrand();
    autoGrow(); ui.input.focus({ preventScroll: true });
  }
  connect();
})();
