// interaction-surface.js — 模型原生提问与权限审批的专用决策面。
// 它是输入框上方的常驻文档流卡片，不借用 Relay 的 modal / toast 体系。
(function initInteractionSurface() {
  'use strict';

  const mount = document.getElementById('interactionSurfaceMount');
  const interactionsApi = window.api && window.api.interactions;

  if (!mount || !interactionsApi
      || typeof interactionsApi.list !== 'function'
      || typeof interactionsApi.respond !== 'function'
      || typeof interactionsApi.onEvent !== 'function') {
    if (mount) mount.hidden = true;
    return;
  }

  const state = {
    items: new Map(),
    currentId: '',
    currentConversationId: '',
    busyIds: new Set(),
    currentView: 'chat',
    conversationLoading: false,
    permissionMenu: null,
    loading: true,
    refreshPromise: null,
    bufferedEvents: [],
    errors: new Map(),
    drafts: new Map(),
    questionPages: new Map(),
    pendingFocus: null,
    offEvent: null,
    renderFrame: 0,
    deadlineTimer: 0,
  };

  const ui = buildShell();
  bindShell();
  connect();

  function buildShell() {
    mount.hidden = true;
    mount.classList.add('interaction-surface-mount');

    const shell = element('section', 'interaction-surface');
    shell.setAttribute('role', 'region');
    shell.setAttribute('aria-labelledby', 'interactionSurfaceTitle');
    shell.setAttribute('aria-live', 'polite');
    shell.setAttribute('aria-atomic', 'false');

    const top = element('header', 'interaction-surface-top');
    const kindMark = element('span', 'interaction-kind-mark');
    kindMark.setAttribute('aria-hidden', 'true');
    kindMark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10" width="14" height="10" rx="3"></rect><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"></path><path d="M12 14v2"></path></svg>';
    const heading = element('div', 'interaction-heading');
    const eyebrow = element('div', 'interaction-eyebrow', '等待回复');
    const title = element('h2', 'interaction-title', '继续之前，想确认一下');
    title.id = 'interactionSurfaceTitle';
    title.tabIndex = -1;
    heading.append(eyebrow, title);

    const deadline = element('span', 'interaction-deadline');
    const pager = element('div', 'interaction-pager');
    pager.setAttribute('aria-label', '待处理请求切换');
    const previous = iconButton('上一个请求', 'previous');
    const position = element('span', 'interaction-position', '1 / 1');
    position.setAttribute('aria-live', 'polite');
    const next = iconButton('下一个请求', 'next');
    pager.append(previous, position, next);
    pager.title = '待处理请求';
    const questionPager = element('div', 'interaction-question-progress');
    questionPager.setAttribute('aria-label', '问题分页');
    const questionPrevious = iconButton('上一题', 'previous');
    questionPrevious.classList.add('interaction-question-back');
    questionPrevious.title = '上一题';
    const questionPosition = element('span', 'interaction-question-position');
    questionPosition.setAttribute('aria-live', 'polite');
    const questionNext = iconButton('下一题', 'next');
    questionNext.classList.add('interaction-question-next');
    questionNext.title = '选择答案后继续下一题';
    questionPager.append(questionPrevious, questionPosition, questionNext);
    const close = button('', 'interaction-close');
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
    close.setAttribute('aria-label', '跳过这个请求');
    close.title = '跳过整个请求，不提交已选答案 · Esc';
    const chrome = element('div', 'interaction-chrome');
    chrome.append(deadline, pager, questionPager, close);
    top.append(kindMark, heading, chrome);

    const source = element('div', 'interaction-source');
    source.hidden = true;
    const sourceText = element('span', 'interaction-source-text');
    const openSource = element('button', 'interaction-source-open', '打开来源对话');
    openSource.type = 'button';
    source.append(sourceText, openSource);

    const content = element('div', 'interaction-content');
    const liveStatus = element('div', 'interaction-live-status');
    liveStatus.setAttribute('role', 'status');
    liveStatus.setAttribute('aria-live', 'polite');
    liveStatus.hidden = true;

    shell.append(top, source, content, liveStatus);
    mount.replaceChildren(shell);
    return {
      shell,
      kindMark,
      eyebrow,
      title,
      deadline,
      pager,
      previous,
      position,
      next,
      questionPager,
      questionPrevious,
      questionPosition,
      questionNext,
      close,
      source,
      sourceText,
      openSource,
      content,
      liveStatus,
    };
  }

  function bindShell() {
    ui.previous.addEventListener('click', () => moveSelection(-1));
    ui.next.addEventListener('click', () => moveSelection(1));
    ui.openSource.addEventListener('click', openSourceConversation);
    ui.close.addEventListener('click', dismissCurrent);
    ui.shell.addEventListener('keydown', onShellKeydown);
    window.addEventListener('relay:conversation-changed', onConversationChanged);
    window.addEventListener('relay:view-changed', onViewChanged);
    window.addEventListener('resize', closePermissionMenu);
    ui.content.addEventListener('scroll', closePermissionMenu, { passive: true });
    window.addEventListener('relay:focus-interaction', onFocusInteraction);
    window.addEventListener('beforeunload', cleanup, { once: true });
    state.deadlineTimer = window.setInterval(updateDeadline, 30000);
  }

  async function connect() {
    try {
      const off = interactionsApi.onEvent(onInteractionEvent);
      if (typeof off === 'function') state.offEvent = off;
    } catch (_) {
      // list() 仍可提供当前状态；订阅失败不应制造一套额外通知。
    }

    await refresh();
  }

  async function refresh() {
    // 订阅后只允许一个快照请求在途；否则较旧响应可能晚到并复活已解决的卡片。
    if (state.refreshPromise) return state.refreshPromise;
    state.loading = true;
    const operation = (async () => {
      try {
        const response = await interactionsApi.list({});
        if (response && response.ok === false) throw new Error(response.error || '读取请求失败');
        const items = extractItems(response);
        state.items = new Map(items.filter(isPending).map((item) => [String(item.id), item]));
      } catch (_) {
        // 初次读取失败时保持隐藏；后续 pending 事件仍可唤起决策面。
      } finally {
        state.loading = false;
        const buffered = state.bufferedEvents.splice(0);
        for (const event of buffered) applyEvent(event);
        honorPendingFocus();
        scheduleRender();
      }
    })();
    state.refreshPromise = operation;
    try { await operation; }
    finally { if (state.refreshPromise === operation) state.refreshPromise = null; }
  }

  function onInteractionEvent(event) {
    if (state.loading) {
      state.bufferedEvents.push(event);
      return;
    }
    const currentId = state.currentId;
    const currentItem = currentId ? state.items.get(currentId) : null;
    applyEvent(event);
    if (honorPendingFocus()) return;

    // 其它任务产生或解决审批时，只更新队列计数，不重建当前卡片。这样用户已展开的
    // 参数、滚动位置和键盘焦点不会因为无关事件突然丢失。
    if (currentId && state.currentId === currentId && state.items.get(currentId) === currentItem) {
      updateQueueChrome();
      return;
    }
    scheduleRender();
  }

  function applyEvent(event) {
    if (!event) return;
    if (Array.isArray(event)) {
      for (const item of event) applyEvent(item);
      return;
    }

    const interaction = event.interaction || event.item || (event.id ? event : null);
    if (!interaction || !interaction.id) return;
    const id = String(interaction.id);
    const type = String(event.type || '');
    const resolved = type.endsWith('.resolved') || !isPending(interaction);
    if (resolved) {
      state.items.delete(id);
      state.errors.delete(id);
      state.drafts.delete(id);
      state.questionPages.delete(id);
      state.busyIds.delete(id);
      if (state.currentId === id) state.currentId = '';
      return;
    }
    state.items.set(id, interaction);
  }

  function onConversationChanged(event) {
    const detail = event && event.detail;
    const nextId = detail && typeof detail === 'object'
      ? (detail.conversationId || detail.convId || detail.id || '')
      : (typeof detail === 'string' ? detail : '');
    closePermissionMenu();
    state.currentConversationId = String(nextId || '');
    state.conversationLoading = Boolean(detail && typeof detail === 'object' && detail.loading);
    if (!state.conversationLoading && state.pendingFocus) {
      const focus = state.pendingFocus;
      const directId = String(focus.interactionId || focus.id || '');
      const runId = String(focus.runId || focus.taskId || '');
      const target = state.items.get(directId) || [...state.items.values()].find((item) => runId && String(item.runId || '') === runId);
      const targetConversation = String(focus.conversationId || focus.convId || target && target.conversationId || '');
      if (!state.currentConversationId || targetConversation !== state.currentConversationId) state.pendingFocus = null;
    }
    // Hide synchronously: a queued animation frame must never leave controls
    // from the previous conversation clickable during navigation.
    mount.hidden = true;
    delete ui.shell.dataset.focusAfterRender;
    state.currentId = '';
    const local = sortedItems()[0];
    if (local) state.currentId = String(local.id);
    if (!honorPendingFocus()) scheduleRender();
  }

  function onViewChanged(event) {
    const detail = event && event.detail || {};
    state.currentView = String(detail.view || 'chat');
    closePermissionMenu();
    if (state.currentView !== 'chat') {
      state.pendingFocus = null;
      mount.hidden = true;
      delete ui.shell.dataset.focusAfterRender;
    }
    if (!honorPendingFocus()) scheduleRender();
  }

  function onFocusInteraction(event) {
    state.pendingFocus = event && event.detail && typeof event.detail === 'object'
      ? event.detail
      : {};
    if (!honorPendingFocus()) refresh();
  }

  function honorPendingFocus() {
    if (!state.pendingFocus) return false;
    const detail = state.pendingFocus;
    const directId = String(detail.interactionId || detail.id || '');
    const runId = String(detail.runId || detail.taskId || '');
    const conversationId = String(detail.conversationId || detail.convId || '');
    const match = sortedItems().find((item) => (
      (directId && String(item.id) === directId)
      || (runId && String(item.runId || '') === runId)
      || (conversationId && String(item.conversationId || '') === conversationId)
    ));
    if (!match) return false;

    state.currentId = String(match.id);
    state.pendingFocus = null;
    scheduleRender({ focus: true });
    return true;
  }

  function scheduleRender(options = {}) {
    if (options.focus) ui.shell.dataset.focusAfterRender = 'true';
    if (state.renderFrame) return;
    state.renderFrame = window.requestAnimationFrame(() => {
      state.renderFrame = 0;
      render();
      if (ui.shell.dataset.focusAfterRender === 'true') {
        delete ui.shell.dataset.focusAfterRender;
        const focusedId = state.currentId;
        const focusedConversation = state.currentConversationId;
        window.requestAnimationFrame(() => {
          if (focusedId === state.currentId && focusedConversation === state.currentConversationId) focusDecision();
        });
      }
    });
  }

  function render() {
    closePermissionMenu();
    const items = sortedItems();
    if (!items.length) {
      state.currentId = '';
      mount.hidden = true;
      ui.shell.setAttribute('aria-busy', 'false');
      ui.content.replaceChildren();
      return;
    }

    let index = items.findIndex((item) => String(item.id) === state.currentId);
    if (index < 0) {
      index = preferredIndex(items);
      state.currentId = String(items[index].id);
    }
    const interaction = items[index];
    const isQuestion = interaction.kind === 'question';
    const isElicitation = interaction.kind === 'elicitation';
    const isBusy = isInteractionBusy(interaction);
    const permissionView = isQuestion || isElicitation ? null : permissionPresentation(interaction);

    mount.hidden = false;
    ui.shell.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    ui.shell.dataset.kind = isQuestion ? 'question' : isElicitation ? 'elicitation' : 'permission';
    ui.eyebrow.textContent = isQuestion ? '' : isElicitation ? (interaction.elicitation?.displayName || interaction.elicitation?.serverName || '工具请求') : permissionView.category;
    ui.title.textContent = isQuestion ? '请选择一个答案' : isElicitation ? (interaction.elicitation?.title || '工具需要你补充信息') : permissionView.title;
    ui.kindMark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-6a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-12.8 4L4.5 15a1.7 1.7 0 0 1 2.7-2l1.8 2"/></svg>';
    ui.questionPager.hidden = true;
    ui.close.hidden = !isQuestion && !isElicitation;
    ui.close.disabled = isBusy;
    ui.title.title = ui.title.textContent;
    ui.previous.disabled = isBusy;
    ui.next.disabled = isBusy;
    updateQueueChrome(items);
    renderSource(interaction);
    ui.content.replaceChildren(
      isQuestion ? renderQuestion(interaction, isBusy) : isElicitation ? renderElicitation(interaction, isBusy) : renderPermission(interaction, isBusy, permissionView),
    );
    renderStatus(interaction, isBusy);
  }

  function updateQueueChrome(items = sortedItems()) {
    const index = items.findIndex((item) => String(item.id) === state.currentId);
    ui.position.textContent = `${Math.max(0, index) + 1} / ${items.length}`;
    ui.pager.hidden = items.length < 2;
    ui.previous.disabled = isInteractionBusy();
    ui.next.disabled = isInteractionBusy();
    updateDeadline();
  }

  function renderSource(interaction) {
    const conversationId = String(interaction.conversationId || '');
    const isOther = conversationId && state.currentConversationId
      && conversationId !== state.currentConversationId;
    const hasUnlocatedSource = conversationId && !state.currentConversationId;
    ui.source.hidden = !(isOther || hasUnlocatedSource);
    ui.source.classList.toggle('is-other', Boolean(isOther));
    ui.sourceText.textContent = isOther
      ? '这个请求来自其他对话，回复会继续那里的任务。'
      : '这个请求来自一条进行中的对话。';
    ui.openSource.hidden = !conversationId;
  }

  function renderQuestion(interaction, isBusy) {
    const form = element('form', 'interaction-question-form');
    form.noValidate = true;
    const questions = interaction.question && Array.isArray(interaction.question.questions)
      ? interaction.question.questions.slice(0, 4)
      : [];
    const draft = getDraft(interaction.id);
    const pageKey = String(interaction.id);
    let page = Math.max(0, Math.min(questions.length - 1, state.questionPages.get(pageKey) || 0));
    ui.questionPager.hidden = questions.length < 2;

    questions.forEach((question, questionIndex) => {
      const fieldset = element('fieldset', 'interaction-question');
      fieldset.disabled = isBusy;
      fieldset.hidden = questionIndex !== page;
      fieldset.dataset.question = question.question || '';
      const legend = element('legend', 'interaction-question-legend');
      const header = element('span', 'interaction-question-header', question.header || `问题 ${questionIndex + 1}`);
      const prompt = element('span', 'interaction-question-prompt', question.question || '请选择一个答案');
      legend.append(header, prompt);
      fieldset.appendChild(legend);

      if (question.multiSelect) fieldset.appendChild(element('p', 'interaction-question-help', '可选择多项，也可以补充自己的答案'));

      const options = element('div', 'interaction-options');
      options.setAttribute('role', question.multiSelect ? 'group' : 'radiogroup');
      const questionDraft = draft[question.question] || { selected: [], other: '' };
      const selected = new Set(Array.isArray(questionDraft.selected) ? questionDraft.selected : []);
      const inputType = question.multiSelect ? 'checkbox' : 'radio';
      const groupName = `interaction-${safeId(interaction.id)}-q${questionIndex}`;

      (Array.isArray(question.options) ? question.options.slice(0, 4) : []).forEach((option, optionIndex) => {
        const optionId = `${groupName}-o${optionIndex}`;
        const label = element('label', 'interaction-option');
        label.htmlFor = optionId;
        const input = document.createElement('input');
        input.id = optionId;
        input.type = inputType;
        input.name = groupName;
        input.value = option.label || '';
        input.dataset.option = 'true';
        input.checked = selected.has(option.label);
        const copy = element('span', 'interaction-option-copy');
        const labelText = option.label || `选项 ${optionIndex + 1}`;
        const recommendation = /\s*[（(](?:推荐|recommended)[）)]\s*$/i.test(labelText);
        const labelLine = element('span', 'interaction-option-label-line');
        labelLine.appendChild(element('strong', 'interaction-option-label', recommendation
          ? labelText.replace(/\s*[（(](?:推荐|recommended)[）)]\s*$/i, '') : labelText));
        if (recommendation) labelLine.appendChild(element('span', 'interaction-recommended', '推荐'));
        copy.appendChild(labelLine);
        if (option.description) copy.appendChild(element('span', 'interaction-option-description', option.description));
        if (option.preview) copy.appendChild(element('span', 'interaction-option-preview', option.preview));
        const ordinal = element('span', 'interaction-option-number', String(optionIndex + 1));
        ordinal.setAttribute('aria-hidden', 'true');
        const arrow = element('span', 'interaction-option-arrow', '→');
        arrow.setAttribute('aria-hidden', 'true');
        label.append(input, ordinal, copy, arrow);
        options.appendChild(label);
      });

      const otherId = `${groupName}-other`;
      const otherLabel = element('div', 'interaction-option interaction-option-other');
      const otherChoice = document.createElement('input');
      otherChoice.id = otherId;
      otherChoice.type = inputType;
      otherChoice.name = groupName;
      otherChoice.value = '__relay_other__';
      otherChoice.dataset.otherChoice = 'true';
      otherChoice.setAttribute('aria-label', '填写自己的答案');
      otherChoice.checked = Boolean(questionDraft.otherSelected);
      const otherCopy = element('span', 'interaction-option-copy');
      const otherText = document.createElement('textarea');
      otherText.className = 'interaction-other-input';
      otherText.rows = 1;
      otherText.maxLength = 2000;
      otherText.placeholder = '补充你的答案…';
      otherText.title = '输入自己的答案，Ctrl + Enter 继续';
      otherText.value = questionDraft.other || '';
      otherText.setAttribute('aria-label', `${question.question || '此问题'}的其他答案`);
      otherCopy.appendChild(otherText);
      const otherOrdinal = element('label', 'interaction-option-number interaction-other-mark');
      otherOrdinal.htmlFor = otherId;
      otherOrdinal.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-4-4L5 15Z"/></svg>';
      otherOrdinal.setAttribute('aria-hidden', 'true');
      otherLabel.append(otherChoice, otherOrdinal, otherCopy);
      fieldset.appendChild(options);
      fieldset.appendChild(otherLabel);

      const errorId = `${groupName}-error`;
      const error = element('p', 'interaction-field-error');
      error.id = errorId;
      error.setAttribute('role', 'alert');
      error.hidden = true;
      fieldset.appendChild(error);
      fieldset.setAttribute('aria-describedby', errorId);

      fieldset.addEventListener('change', () => {
        saveQuestionDraft(interaction.id, question, fieldset, otherText);
        clearFieldError(fieldset);
      });
      otherText.addEventListener('input', () => {
        resizeOtherInput(otherText);
        if (otherText.value && !otherChoice.checked) {
          otherChoice.checked = true;
          if (!question.multiSelect) {
            for (const option of fieldset.querySelectorAll('input[data-option]')) option.checked = false;
          }
        }
        saveQuestionDraft(interaction.id, question, fieldset, otherText);
        clearFieldError(fieldset);
      });

      form.appendChild(fieldset);
    });

    const actions = element('div', 'interaction-actions interaction-question-actions');
    ui.questionPrevious.onclick = () => { if (!isInteractionBusy(interaction)) showQuestionPage(page - 1, true); };
    ui.questionNext.onclick = () => { if (!isInteractionBusy(interaction) && page < questions.length - 1) form.requestSubmit(); };
    const cancel = button('跳过', 'interaction-button interaction-button-quiet interaction-question-skip');
    cancel.title = '跳过整个请求，不提交已选答案';
    cancel.type = 'button';
    cancel.disabled = isBusy;
    cancel.addEventListener('click', () => respond(interaction, {
      action: 'deny',
      message: '用户暂不回答这个问题',
    }));
    const submit = button('继续', 'interaction-button interaction-button-primary');
    submit.type = 'submit';
    submit.disabled = isBusy || questions.length === 0;
    const actionGroup = element('div', 'interaction-action-group');
    const shortcut = element('span', 'interaction-submit-hint', 'Ctrl ↵');
    shortcut.setAttribute('aria-hidden', 'true');
    actionGroup.append(cancel, submit);
    actions.append(shortcut, actionGroup);
    form.appendChild(actions);

    function showQuestionPage(nextPage, focus = false) {
      if (!questions.length) return;
      page = Math.max(0, Math.min(questions.length - 1, nextPage));
      state.questionPages.set(pageKey, page);
      const fieldsets = [...form.querySelectorAll('.interaction-question')];
      fieldsets.forEach((fieldset, index) => { fieldset.hidden = index !== page; });
      fieldsets[page].querySelector('.interaction-option-other').appendChild(actions);
      const otherInput = fieldsets[page].querySelector('.interaction-other-input');
      resizeOtherInput(otherInput);
      // The initial form is attached after this call; measure again once it has
      // its real width. Restored drafts and page changes use the same path.
      window.requestAnimationFrame(() => resizeOtherInput(otherInput));
      ui.title.textContent = questions[page].question || '请选择一个答案';
      ui.title.title = ui.title.textContent;
      ui.questionPosition.textContent = `${page + 1} / ${questions.length}`;
      ui.questionPrevious.disabled = isBusy || page === 0;
      ui.questionNext.disabled = isBusy || page === questions.length - 1;
      submit.title = page < questions.length - 1 ? '保存当前选择，继续下一题' : '提交回答并继续任务';
      if (focus) {
        const fieldset = fieldsets[page];
        const target = fieldset.querySelector('input:checked')
          || fieldset.querySelector('input[data-option], .interaction-other-input');
        if (target) target.focus({ preventScroll: true });
        ui.content.scrollTop = 0;
      }
    }
    showQuestionPage(page);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (isInteractionBusy()) return;
      if (page < questions.length - 1) {
        if (collectAnswers(form, questions, { onlyIndex: page })) showQuestionPage(page + 1, true);
        return;
      }
      const answers = collectAnswers(form, questions, { onInvalid: (index) => showQuestionPage(index) });
      if (answers) respond(interaction, { action: 'submit', answers });
    });
    form.addEventListener('keydown', (event) => {
      if (!event.isComposing && event.keyCode !== 229 && !event.repeat
          && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    return form;
  }

  function renderElicitation(interaction, isBusy) {
    const request = interaction.elicitation || {};
    const form = element('form', 'interaction-elicitation-form');
    form.noValidate = true;
    if (request.message) form.appendChild(element('p', 'interaction-elicitation-message', request.message));
    if (request.description && request.description !== request.message) form.appendChild(element('p', 'interaction-question-help', request.description));
    const draft = getDraft(interaction.id);
    const fields = request.schema?.fields || [];
    if (request.unsupported) {
      form.appendChild(element('p', 'interaction-field-error', `${request.unsupported}。可以拒绝此请求，让工具改用支持的方式。`));
    } else if (request.mode === 'url') {
      let label = '工具授权网页';
      try { const parsed = new URL(request.url); label = parsed.origin + parsed.pathname; } catch (_) {}
      form.appendChild(element('p', 'interaction-elicitation-url', label));
      form.appendChild(element('p', 'interaction-question-help', '点击后打开工具提供的网页。是否完成授权，以工具返回的结果为准。'));
    } else {
      const fieldList = element('div', 'interaction-elicitation-fields');
      fields.forEach((field, index) => {
        const block = element('div', 'interaction-elicitation-field');
        const inputId = `elicitation-${safeId(interaction.id)}-${index}`;
        const label = element('label', 'interaction-elicitation-label', field.label + (field.required ? ' *' : ''));
        label.htmlFor = inputId;
        block.appendChild(label);
        if (field.description) block.appendChild(element('p', 'interaction-question-help', field.description));
        const restored = Object.prototype.hasOwnProperty.call(draft, field.name) ? draft[field.name] : field.default;
        let input;
        if (field.type === 'array') {
          input = element('fieldset', 'interaction-elicitation-multiple');
          const legend = element('legend', 'interaction-elicitation-sr-only', field.label);
          input.appendChild(legend);
          const selected = new Set(Array.isArray(restored) ? restored : []);
          (field.options || []).forEach(option => {
            const optionLabel = element('label', 'interaction-elicitation-check');
            const control = document.createElement('input');
            control.type = 'checkbox'; control.value = option.value; control.checked = selected.has(option.value);
            optionLabel.append(control, element('span', '', option.label));
            input.appendChild(optionLabel);
          });
        } else if (field.options || field.type === 'boolean') {
          input = element('select', 'interaction-elicitation-input');
          input.appendChild(element('option', '', '请选择'));
          input.firstChild.value = '';
          const options = field.type === 'boolean' ? [{ value: 'true', label: '是' }, { value: 'false', label: '否' }]
            : (field.options || []).map((option, optionIndex) => ({ value: String(optionIndex), label: option.label }));
          options.forEach(option => {
            const node = element('option', '', option.label); node.value = option.value; input.appendChild(node);
          });
          // Index values avoid confusing an enum whose actual value is '' with
          // the optional field's unselected placeholder.
          if (restored !== undefined) input.value = field.type === 'boolean' ? String(restored)
            : String(field.options.findIndex(option => option.value === restored));
        } else {
          input = element('input', 'interaction-elicitation-input');
          input.type = field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'date' ? 'date' : 'text';
          input.autocomplete = 'off';
          input.spellcheck = false;
          if (field.type === 'number' || field.type === 'integer') input.step = field.type === 'integer' ? '1' : 'any';
          if (restored !== undefined) input.value = String(restored);
          if (field.format === 'date-time') input.placeholder = '2026-09-11T12:00:00+08:00';
          if (field.maxLength !== undefined && input.type === 'text') input.maxLength = field.maxLength * 2;
        }
        input.id = inputId; input.disabled = isBusy;
        input.dataset.elicitationField = field.name;
        if (field.required) input.setAttribute('aria-required', 'true');
        input.addEventListener('input', () => saveField());
        input.addEventListener('change', () => saveField());
        function saveField() {
          if (field.type === 'array') draft[field.name] = [...input.querySelectorAll('input:checked')].map(control => control.value);
          else if (field.type === 'boolean') { draft[field.name] = input.value ? input.value === 'true' : undefined; }
          else if (field.options) { draft[field.name] = input.value ? field.options[Number(input.value)]?.value : undefined; }
          else if (field.type === 'number' || field.type === 'integer') { draft[field.name] = input.value === '' ? undefined : Number(input.value); }
          else { draft[field.name] = input.value === '' && !field.required ? undefined : input.value; }
        }
        // Defaults are visible suggestions only. No callback is sent until the
        // user submits; the broker validates again against the original schema.
        saveField();
        block.appendChild(input); fieldList.appendChild(block);
      });
      form.appendChild(fieldList);
    }
    const actions = element('div', 'interaction-actions interaction-permission-actions');
    const decline = button('拒绝', 'interaction-button interaction-button-quiet');
    decline.type = 'button'; decline.disabled = isBusy;
    decline.addEventListener('click', () => respond(interaction, { action: 'decline' }));
    const submit = button(request.mode === 'url' ? '打开并继续' : '提交', 'interaction-button interaction-button-primary');
    submit.type = 'submit'; submit.disabled = isBusy || Boolean(request.unsupported);
    submit.dataset.elicitationSubmit = 'true';
    actions.append(decline, submit); form.appendChild(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (request.unsupported || !isVisibleInteraction(interaction) || isInteractionBusy(interaction)) return;
      if (request.mode === 'url') {
        const id = String(interaction.id);
        state.busyIds.add(id); state.errors.delete(id); setCurrentBusyState(interaction, true);
        try {
          const open = window.relayWorkspacePanel?.openUrl;
          const result = typeof open === 'function' ? await open(request.url) : await window.api.openExternal(request.url);
          if (result === false || result?.ok === false) throw new Error(result?.error || '暂时无法打开工具网页');
        } catch (error) {
          state.errors.set(id, error?.message || '暂时无法打开工具网页');
          state.busyIds.delete(id); setCurrentBusyState(interaction, false); return;
        }
        state.busyIds.delete(id);
        // A delayed browser launch cannot approve a request after navigation,
        // cancellation or timeout; respond checks the live conversation again.
        await respond(interaction, { action: 'accept' });
      } else await respond(interaction, { action: 'accept', content: Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined)) });
    });
    return form;
  }

  function resizeOtherInput(input) {
    if (!input || !input.isConnected || input.closest('fieldset').hidden) return;
    input.style.overflowY = 'hidden';
    input.style.height = '0px';
    const height = input.scrollHeight;
    input.style.height = `${Math.max(29, Math.min(100, height))}px`;
    input.style.overflowY = height > 100 ? 'auto' : 'hidden';
  }

  function renderPermission(interaction, isBusy, view = permissionPresentation(interaction)) {
    const permission = interaction.permission || {};
    const card = element('div', 'interaction-permission-card');
    const preview = permissionInputPreview(permission.input, view);
    const description = cleanPermissionDescription(permission.description, preview, view);
    const decisionReason = redactDisplayText(permission.decisionReason);
    if (description || decisionReason) {
      const context = element('div', 'interaction-permission-context');
      if (description) context.appendChild(element('p', 'interaction-permission-description', description));
      if (decisionReason) {
        const reason = element('p', 'interaction-permission-reason');
        reason.append(element('strong', '', '用途：'), document.createTextNode(decisionReason));
        context.appendChild(reason);
      }
      card.appendChild(context);
    }

    if (preview) {
      const previewBlock = element('div', 'interaction-permission-preview');
      const previewHead = element('div', 'interaction-permission-preview-head');
      previewHead.append(
        element('span', 'interaction-permission-preview-label', preview.label),
        element('code', 'interaction-permission-tool', view.toolLabel),
      );
      const previewCode = element('code', 'interaction-permission-preview-code', preview.text);
      previewCode.title = preview.fullText;
      previewBlock.append(previewHead, previewCode);
      card.appendChild(previewBlock);
    }

    if (decisionReason) {
      card.dataset.hasReason = 'true';
    }

    const facts = element('dl', 'interaction-permission-facts');
    appendFact(facts, '路径', permission.blockedPath);
    appendFact(facts, 'Agent', interaction.agentID);
    if (facts.children.length) card.appendChild(facts);

    if (hasPermissionInput(permission.input)) {
      const inputBlock = element('details', 'interaction-permission-input');
      const inputSummary = element('summary', '', '查看完整参数（已脱敏）');
      const code = element('pre', 'interaction-permission-code');
      code.textContent = stringifyRedacted(permission.input);
      inputBlock.append(inputSummary, code);
      card.appendChild(inputBlock);
    }

    const actions = element('div', 'interaction-actions interaction-permission-actions');
    const allowGroup = element('div', 'interaction-action-group interaction-action-allow');
    const deny = button('拒绝', 'interaction-button interaction-button-quiet');
    deny.dataset.action = 'deny';
    deny.appendChild(element('kbd', 'interaction-key', 'Esc'));
    deny.title = '只拒绝当前操作，任务仍可继续';
    deny.disabled = isBusy;
    deny.addEventListener('click', () => respond(interaction, {
      action: 'deny', message: '用户拒绝了此操作',
    }));
    const split = element('div', 'interaction-allow-split');
    const allowOnce = button('允许一次', 'interaction-button interaction-button-primary');
    allowOnce.dataset.action = 'allow_once';
    allowOnce.appendChild(element('kbd', 'interaction-key', '↵'));
    allowOnce.title = '只允许当前这一项操作';
    allowOnce.disabled = isBusy;
    allowOnce.addEventListener('click', () => respond(interaction, { action: 'allow_once' }));
    split.appendChild(allowOnce);
    if (permission.canAllowForSession) {
      const toggle = button('', 'interaction-allow-menu-toggle');
      toggle.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg>';
      toggle.setAttribute('aria-label', '选择允许范围');
      toggle.setAttribute('aria-haspopup', 'menu');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.disabled = isBusy;
      const menu = element('div', 'interaction-allow-menu');
      menu.id = `interaction-allow-menu-${safeId(interaction.id)}`;
      menu.setAttribute('popover', 'auto');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', '允许范围');
      toggle.setAttribute('aria-controls', menu.id);
      const options = [
        ['allow_once', '允许一次', '仅允许当前这一项操作'],
        ['allow_session', '允许此对话', '按建议的权限范围，在本对话中允许后续同类操作'],
      ];
      for (const [action, label, hint] of options) {
        const option = button(label, 'interaction-allow-menu-option');
        option.dataset.action = action;
        option.setAttribute('role', 'menuitem');
        option.title = hint;
        option.disabled = isBusy;
        option.addEventListener('click', () => {
          closePermissionMenu();
          respond(interaction, { action });
        });
        menu.appendChild(option);
      }
      const openMenu = (last = false) => {
        if (!isVisibleInteraction(interaction) || isInteractionBusy(interaction)) return;
        closePermissionMenu();
        menu.showPopover();
        const anchor = split.getBoundingClientRect();
        const rect = menu.getBoundingClientRect();
        const left = Math.max(8, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 8));
        const top = anchor.top - rect.height - 6;
        menu.style.left = `${left}px`;
        menu.style.top = `${top >= 8 ? top : Math.min(anchor.bottom + 6, window.innerHeight - rect.height - 8)}px`;
        toggle.setAttribute('aria-expanded', 'true');
        state.permissionMenu = { menu, toggle, interactionId: String(interaction.id) };
        const choices = [...menu.querySelectorAll('button')];
        choices[last ? choices.length - 1 : 0].focus({ preventScroll: true });
      };
      toggle.addEventListener('click', () => {
        if (menu.matches(':popover-open')) closePermissionMenu();
        else openMenu();
      });
      toggle.addEventListener('keydown', (event) => {
        if (event.isComposing || event.repeat || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        openMenu(event.key === 'ArrowUp');
      });
      menu.addEventListener('toggle', (event) => {
        if (event.newState === 'closed') {
          toggle.setAttribute('aria-expanded', 'false');
          if (state.permissionMenu && state.permissionMenu.menu === menu) state.permissionMenu = null;
        }
      });
      menu.addEventListener('keydown', (event) => {
        if (event.isComposing || event.repeat || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const choices = [...menu.querySelectorAll('button:not(:disabled)')];
        const index = choices.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
        if (choices[next]) choices[next].focus({ preventScroll: true });
      });
      split.append(toggle, menu);
    }
    allowGroup.append(deny, split);
    actions.appendChild(allowGroup);
    card.appendChild(actions);
    return card;
  }

  function closePermissionMenu(restoreFocus = false) {
    const current = state.permissionMenu;
    if (!current) return false;
    state.permissionMenu = null;
    if (current.menu.matches(':popover-open')) current.menu.hidePopover();
    current.toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus === true && current.toggle.isConnected && !mount.hidden) {
      current.toggle.focus({ preventScroll: true });
    }
    return true;
  }

  function permissionPresentation(interaction) {
    const permission = interaction && interaction.permission || {};
    const toolName = String(interaction && interaction.toolName || '').trim();
    const displayName = redactDisplayText(permission.displayName || toolName || '工具');
    let actionLabel = '执行这个工具操作';
    let category = '权限';
    let previewKeys = [];

    if (/(?:^|\b)(bash|shell|terminal)(?:$|\b)/i.test(toolName)) {
      actionLabel = '运行这条终端命令';
      category = '终端';
      previewKeys = [['command', '将运行']];
    } else if (/powershell/i.test(toolName)) {
      actionLabel = '运行这条 PowerShell 命令';
      category = '终端';
      previewKeys = [['command', '将运行']];
    } else if (/^(?:read|readfile)$/i.test(toolName)) {
      actionLabel = '读取这个文件';
      previewKeys = [['file_path', '目标文件'], ['path', '目标文件']];
    } else if (/^(?:write|edit|multiedit)$/i.test(toolName)) {
      actionLabel = '修改这个文件';
      previewKeys = [['file_path', '目标文件'], ['path', '目标文件']];
    } else if (/^(?:glob|grep|search)$/i.test(toolName)) {
      actionLabel = '搜索这些文件';
      previewKeys = [['pattern', '搜索内容'], ['query', '搜索内容'], ['path', '搜索范围']];
    } else if (/webfetch|fetch/i.test(toolName)) {
      actionLabel = '访问这个网页';
      category = '互联网访问';
      previewKeys = [['url', '目标地址'], ['prompt', '用途']];
    } else if (/websearch/i.test(toolName)) {
      actionLabel = '进行这次联网搜索';
      category = '互联网访问';
      previewKeys = [['query', '搜索内容']];
    } else if (/^(?:agent|task)$/i.test(toolName)) {
      actionLabel = '启动这个 Agent';
      previewKeys = [['description', '任务'], ['prompt', '任务']];
    } else if (/^mcp[_:.-]|mcp__/i.test(toolName)) {
      actionLabel = '调用这个外部服务';
      previewKeys = [['query', '请求内容'], ['url', '目标地址'], ['path', '目标对象']];
    }

    const suppliedTitle = redactDisplayText(permission.title);
    const genericTitles = new Set([redactDisplayText(toolName), displayName]
      .filter(Boolean)
      .map((value) => value.toLowerCase()));
    const title = suppliedTitle && !genericTitles.has(suppliedTitle.toLowerCase())
      ? suppliedTitle
      : `允许 Relay ${actionLabel}吗？`;
    return {
      title,
      category,
      toolLabel: compactPermissionText(displayName, 36) || '工具',
      previewKeys,
    };
  }

  function permissionInputPreview(input, view) {
    if (!hasPermissionInput(input)) return null;
    for (const [key, label] of view.previewKeys) {
      if (input[key] == null || input[key] === '') continue;
      const fullText = previewValue(input[key]);
      return { label, fullText, text: truncatePermissionPreview(fullText) };
    }
    const fullText = stringifyRedacted(input);
    return { label: '操作摘要', fullText, text: truncatePermissionPreview(fullText) };
  }

  function previewValue(value) {
    if (typeof value === 'string') return redactString(value).trim() || '（空）';
    return stringifyRedacted(value);
  }

  function truncatePermissionPreview(value, maxLength = 1200) {
    const text = String(value || '');
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n…` : text;
  }

  function compactPermissionText(value, maxLength) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
  }

  function cleanPermissionDescription(value, preview, view) {
    const text = redactDisplayText(value);
    if (!text) return '';
    const compact = text.replace(/\s+/g, ' ');
    if (preview && compact === String(preview.fullText || '').replace(/\s+/g, ' ')) return '';
    if (compact.toLowerCase() === String(view.toolLabel || '').toLowerCase()) return '';
    return text;
  }

  function redactDisplayText(value) {
    return redactString(String(value || '')).trim();
  }

  function hasPermissionInput(input) {
    return Boolean(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length);
  }

  function collectAnswers(form, questions, { onlyIndex = null, onInvalid } = {}) {
    const answers = {};
    let firstInvalid = null;
    const fieldsets = [...form.querySelectorAll('.interaction-question')];

    questions.forEach((question, index) => {
      if (onlyIndex !== null && index !== onlyIndex) return;
      const fieldset = fieldsets[index];
      if (!fieldset) return;
      const selected = [...fieldset.querySelectorAll('input[data-option]:checked')]
        .map((input) => input.value)
        .filter(Boolean);
      const otherChoice = fieldset.querySelector('input[data-other-choice]');
      const otherText = fieldset.querySelector('.interaction-other-input');
      const usesOther = Boolean(otherChoice && otherChoice.checked);
      const other = otherText ? otherText.value.trim() : '';

      let invalidMessage = '';
      if (!selected.length && !usesOther) invalidMessage = '请选择一个选项，或填写“其他”。';
      else if (usesOther && !other) invalidMessage = '请填写“其他”的具体内容。';

      if (invalidMessage) {
        showFieldError(fieldset, invalidMessage);
        if (!firstInvalid) {
          if (onInvalid) onInvalid(index);
          firstInvalid = usesOther && otherText ? otherText : fieldset.querySelector('input');
        }
        return;
      }

      const values = usesOther ? [...selected, other] : selected;
      answers[question.question] = question.multiSelect ? values : values[0];
    });

    if (firstInvalid) {
      firstInvalid.focus();
      return null;
    }
    return answers;
  }

  async function respond(interaction, decision) {
    const id = String(interaction.id || '');
    if (!id || !state.items.has(id) || !isVisibleInteraction(interaction) || isInteractionBusy(interaction)) return;
    closePermissionMenu();
    const focusedControl = document.activeElement;
    state.busyIds.add(id);
    state.errors.delete(id);
    setCurrentBusyState(interaction, true);
    try {
      const result = await interactionsApi.respond(id, decision);
      if (result && result.ok === false) throw new Error(result.error || '提交失败');
      state.items.delete(id);
      state.drafts.delete(id);
      state.questionPages.delete(id);
      state.errors.delete(id);
      if (state.currentId === id) state.currentId = '';
    } catch (error) {
      state.busyIds.delete(id);
      if (!state.items.has(id)) {
        state.errors.delete(id);
        if (isVisibleInteraction(interaction)) scheduleRender();
        return;
      }
      state.errors.set(id, error && error.message ? error.message : '暂时无法提交，请重试。');
      if (state.currentId === id && isVisibleInteraction(interaction)) {
        setCurrentBusyState(interaction, false);
        if (focusedControl && focusedControl.isConnected && typeof focusedControl.focus === 'function') focusedControl.focus();
      }
      return;
    }
    state.busyIds.delete(id);
    if (isVisibleInteraction(interaction)) scheduleRender({ focus: true });
  }

  function setCurrentBusyState(interaction, isBusy) {
    if (state.currentId !== String(interaction.id) || !isVisibleInteraction(interaction)) return;
    ui.shell.setAttribute('aria-busy', isBusy ? 'true' : 'false');
    ui.previous.disabled = isBusy;
    ui.next.disabled = isBusy;
    ui.close.disabled = isBusy;
    const questions = interaction.question && interaction.question.questions || [];
    const page = state.questionPages.get(String(interaction.id)) || 0;
    ui.questionPrevious.disabled = isBusy || page === 0;
    ui.questionNext.disabled = isBusy || page >= questions.length - 1;
    for (const control of ui.content.querySelectorAll('button, input, textarea, select')) {
      control.disabled = isBusy || (control.dataset.elicitationSubmit === 'true' && Boolean(interaction.elicitation?.unsupported));
    }
    for (const fieldset of ui.content.querySelectorAll('fieldset')) fieldset.disabled = isBusy;
    renderStatus(interaction, isBusy);
  }

  function renderStatus(interaction, isBusy) {
    const error = state.errors.get(String(interaction.id));
    ui.liveStatus.hidden = !(error || isBusy);
    ui.liveStatus.classList.toggle('is-error', Boolean(error));
    ui.liveStatus.textContent = error || (isBusy ? '正在提交你的决定…' : '');
  }

  function updateDeadline() {
    const interaction = state.items.get(state.currentId);
    if (!interaction || !interaction.expiresAt) {
      ui.deadline.textContent = '';
      ui.deadline.hidden = true;
      return;
    }
    const remaining = new Date(interaction.expiresAt).getTime() - Date.now();
    if (!Number.isFinite(remaining)) {
      ui.deadline.hidden = true;
      return;
    }
    ui.deadline.hidden = false;
    if (remaining <= 0) ui.deadline.textContent = '正在自动拒绝';
    else if (remaining < 60000) ui.deadline.textContent = '不到 1 分钟后自动拒绝';
    else ui.deadline.textContent = `${Math.ceil(remaining / 60000)} 分钟后自动拒绝`;
    ui.deadline.title = interaction.expiresAt
      ? `将在 ${new Date(interaction.expiresAt).toLocaleTimeString('zh-CN')} 后自动安全拒绝`
      : '';
  }

  function moveSelection(delta) {
    if (isInteractionBusy()) return;
    const items = sortedItems();
    if (items.length < 2) return;
    const current = Math.max(0, items.findIndex((item) => String(item.id) === state.currentId));
    const next = (current + delta + items.length) % items.length;
    state.currentId = String(items[next].id);
    scheduleRender({ focus: true });
  }

  function preferredIndex(items) {
    if (!state.currentConversationId) return 0;
    const index = items.findIndex((item) => sameConversation(item, state.currentConversationId));
    return index < 0 ? 0 : index;
  }

  function sortedItems() {
    return [...state.items.values()]
      .filter((item) => isPending(item) && isVisibleInteraction(item))
      .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  }

  function isVisibleInteraction(interaction) {
    return state.currentView === 'chat' && !state.conversationLoading
      && sameConversation(interaction, state.currentConversationId);
  }

  function isInteractionBusy(interaction = state.items.get(state.currentId)) {
    return Boolean(interaction && state.busyIds.has(String(interaction.id)));
  }

  function sameConversation(interaction, conversationId) {
    return Boolean(conversationId && interaction && String(interaction.conversationId || '') === conversationId);
  }

  function openSourceConversation() {
    const interaction = state.items.get(state.currentId);
    if (!interaction || !interaction.conversationId) return;
    window.dispatchEvent(new CustomEvent('relay:open-conversation', {
      cancelable: true,
      detail: {
        conversationId: interaction.conversationId,
        runId: interaction.runId || '',
        source: 'interaction-surface',
      },
    }));
  }

  function onShellKeydown(event) {
    if (mount.hidden || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return;
    if (event.key === 'Escape' && closePermissionMenu(true)) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismissCurrent();
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      const interaction = state.items.get(state.currentId);
      if (!interaction || interaction.kind !== 'permission' || isInteractionBusy(interaction) || !isVisibleInteraction(interaction)) return;
      // Enter activates a focused native control normally; it must not turn a
      // focused denial, details summary or editable field into an approval.
      if (event.target && event.target.closest('button, input, textarea, select, summary, [contenteditable="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      respond(interaction, { action: 'allow_once' });
    }
  }

  function dismissCurrent() {
    const interaction = state.items.get(state.currentId);
    if (!interaction || isInteractionBusy(interaction) || !isVisibleInteraction(interaction)) return;
    respond(interaction, { action: interaction.kind === 'elicitation' ? 'cancel' : 'deny', message: interaction.kind === 'question'
      ? '用户跳过了这个请求，未提交答案' : '用户拒绝了此操作' });
  }

  function focusDecision() {
    if (mount.hidden) return;
    const interaction = state.items.get(state.currentId);
    const activeQuestion = ui.content.querySelector('.interaction-question:not([hidden])');
    // Permission focus lands on the question. Enter explicitly allows once;
    // Escape explicitly denies. No focus change itself submits a decision.
    const target = interaction && interaction.kind === 'question'
      ? activeQuestion && (activeQuestion.querySelector('input:checked')
        || activeQuestion.querySelector('input:not([disabled]), textarea'))
      : ui.title;
    (target || ui.title).focus();
    ui.shell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function getDraft(id) {
    const key = String(id);
    if (!state.drafts.has(key)) state.drafts.set(key, {});
    return state.drafts.get(key);
  }

  function saveQuestionDraft(id, question, fieldset, otherText) {
    const draft = getDraft(id);
    const selected = [...fieldset.querySelectorAll('input[data-option]:checked')].map((input) => input.value);
    const otherChoice = fieldset.querySelector('input[data-other-choice]');
    draft[question.question] = {
      selected,
      otherSelected: Boolean(otherChoice && otherChoice.checked),
      other: otherText ? otherText.value : '',
    };
  }

  function showFieldError(fieldset, message) {
    const error = fieldset.querySelector('.interaction-field-error');
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
    fieldset.classList.add('is-invalid');
    fieldset.setAttribute('aria-invalid', 'true');
  }

  function clearFieldError(fieldset) {
    const error = fieldset.querySelector('.interaction-field-error');
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
    fieldset.classList.remove('is-invalid');
    fieldset.removeAttribute('aria-invalid');
  }

  function appendFact(list, label, value) {
    if (value == null || value === '') return;
    const safeValue = redactDisplayText(value);
    if (!safeValue) return;
    const term = element('dt', '', label);
    const description = element('dd', '', safeValue);
    description.title = safeValue;
    list.append(term, description);
  }

  function stringifyRedacted(input) {
    let serialized;
    try {
      serialized = JSON.stringify(redactValue(input), null, 2);
    } catch (_) {
      serialized = '（内容无法显示）';
    }
    if (!serialized) serialized = '{}';
    const maxLength = 24000;
    return serialized.length > maxLength
      ? `${serialized.slice(0, maxLength)}\n…（内容已截断）`
      : serialized;
  }

  function redactValue(value, depth = 0, seen = new WeakSet()) {
    if (typeof value === 'string') return redactString(value);
    if (value == null || typeof value !== 'object') return value;
    if (depth > 8) return '…（层级过深）';
    if (seen.has(value)) return '…（循环引用）';
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1, seen));
      const result = {};
      Object.keys(value).slice(0, 100).forEach((key) => {
        if (/pass(word)?|passwd|secret|token|api.?key|authorization|cookie|credential|private.?key/i.test(key)) {
          result[key] = '••••••••';
        } else {
          result[key] = redactValue(value[key], depth + 1, seen);
        }
      });
      return result;
    } finally {
      seen.delete(value);
    }
  }

  function redactString(value) {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return '••••••••（私钥已隐藏）';
    return value
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1••••••••')
      .replace(/\b(Basic\s+)[A-Za-z0-9+/_=-]+/gi, '$1••••••••')
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1••••••••@')
      .replace(/((?:--(?:password|passwd|pass|secret|token|api[-_]?key|credential))\s*(?:=\s*|\s+))(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1••••••••')
      .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, 'sk-••••••••')
      .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;&]+/gi, '$1••••••••');
  }

  function extractItems(response) {
    if (Array.isArray(response)) return response;
    if (response && Array.isArray(response.items)) return response.items;
    if (response && Array.isArray(response.interactions)) return response.interactions;
    return [];
  }

  function isPending(item) {
    return Boolean(item && item.id && (!item.state || item.state === 'pending'));
  }

  function safeId(value) {
    return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(text, className) {
    const node = element('button', className, text);
    node.type = 'button';
    return node;
  }

  function iconButton(label, direction) {
    const node = button(direction === 'previous' ? '‹' : '›', 'interaction-pager-button');
    node.setAttribute('aria-label', label);
    node.title = `${label}（Alt + ${direction === 'previous' ? '←' : '→'}）`;
    return node;
  }

  function cleanup() {
    closePermissionMenu();
    if (state.renderFrame) window.cancelAnimationFrame(state.renderFrame);
    if (state.deadlineTimer) window.clearInterval(state.deadlineTimer);
    if (typeof state.offEvent === 'function') {
      try { state.offEvent(); } catch (_) {}
    }
    window.removeEventListener('relay:conversation-changed', onConversationChanged);
    window.removeEventListener('relay:view-changed', onViewChanged);
    window.removeEventListener('resize', closePermissionMenu);
    window.removeEventListener('relay:focus-interaction', onFocusInteraction);
  }
})();
