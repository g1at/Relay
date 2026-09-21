(function (root) {
  'use strict';
  function createSubagentHistory({ api = root.api?.sessionHistory, document = root.document } = {}) {
    let revision = 0, owner = null, selected = null, offset = 0, busy = false, previousFocus = null;
    const element = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text != null) node.textContent = text; return node; };
    const button = (text, label) => { const node = element('button', 'subagent-history-button', text); node.type = 'button'; if (label) node.setAttribute('aria-label', label); return node; };
    const overlay = element('div', 'subagent-history-overlay'); overlay.hidden = true;
    const dialog = element('section', 'subagent-history-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', '子 Agent 历史'); dialog.tabIndex = -1;
    const header = element('header', 'subagent-history-header'), heading = element('div', 'subagent-history-heading');
    const eyebrow = element('span', 'subagent-history-eyebrow', '子 Agent'), title = element('h2', '', '工作记录');
    heading.append(eyebrow, title);
    const closeButton = button('×', '关闭子 Agent 历史'); closeButton.classList.add('subagent-history-close'); header.append(heading, closeButton);
    const tabs = element('nav', 'subagent-history-tabs'); tabs.setAttribute('aria-label', '子 Agent 切换');
    const body = element('div', 'subagent-history-body'); body.tabIndex = 0;
    const status = element('div', 'subagent-history-status'); status.setAttribute('role', 'status');
    const messages = element('div', 'subagent-history-messages');
    const footer = element('footer', 'subagent-history-footer'), more = button('加载更多'), retry = button('重新读取');
    footer.append(more, retry); body.append(status, messages); dialog.append(header, tabs, body, footer); overlay.append(dialog); document.body.append(overlay);
    function setStatus(text, error = false) { status.textContent = text; status.hidden = !text; status.classList.toggle('is-error', error); }
    function current(ticket) { return ticket === revision && owner && !overlay.hidden; }
    function close() {
      revision++; owner = null; selected = null; busy = false; overlay.hidden = true; messages.replaceChildren(); tabs.replaceChildren();
      previousFocus?.isConnected && previousFocus.focus?.(); previousFocus = null;
    }
    function textOf(content) {
      if (typeof content === 'string') return content;
      return (Array.isArray(content) ? content : []).map(block => block?.type === 'text' ? block.text || '' : block?.type === 'image' ? '[图片]' : '').filter(Boolean).join('\n');
    }
    function codeSection(container, label, value) {
      const details = element('details', 'subagent-history-tool'), summary = element('summary', '', label), code = element('pre', '');
      let text; try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch (_) { text = '无法显示此内容'; }
      code.textContent = String(text || '').slice(0, 48000); details.append(summary, code); container.append(details);
      if (String(text || '').length > 48000) details.append(element('span', 'subagent-history-muted', '内容较长，此处显示前 48,000 个字符。'));
    }
    function renderMessage(message) {
      const row = element('article', `subagent-history-message is-${message.type === 'user' ? 'user' : 'assistant'}`);
      row.dataset.messageId = message.uuid || '';
      row.append(element('div', 'subagent-history-role', message.type === 'user' ? '任务输入' : 'Agent'));
      const content = message.message?.content;
      for (const block of typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && block.text) {
          const copy = element('div', 'subagent-history-text');
          if (root.relayRenderReadOnlyMarkdown) root.relayRenderReadOnlyMarkdown(copy, String(block.text).slice(0, 48000)); else copy.textContent = String(block.text).slice(0, 48000);
          row.append(copy);
          if (String(block.text).length > 48000) row.append(element('span', 'subagent-history-muted', '内容较长，此处显示前 48,000 个字符。'));
        } else if (block?.type === 'tool_use') codeSection(row, block.name || '工具调用', block.input);
        else if (block?.type === 'tool_result') codeSection(row, block.is_error ? '工具错误' : '工具结果', textOf(block.content));
        else if (block?.type === 'image') row.append(element('span', 'subagent-history-muted', '图片附件'));
      }
      if (row.childElementCount === 1) row.append(element('span', 'subagent-history-muted', '这条记录没有可展示的文本。'));
      messages.append(row);
    }
    async function loadPage({ reset = false } = {}) {
      if (!owner || !selected || busy) return;
      const ticket = revision, request = { ...owner, agentId: selected, offset: reset ? 0 : offset, limit: 30 };
      busy = true; more.disabled = true; retry.hidden = true;
      if (reset) { messages.replaceChildren(); offset = 0; body.scrollTop = 0; }
      setStatus(reset ? '正在读取原生工作记录…' : '正在读取更多记录…');
      try {
        const result = await api.getSubagentMessages(request); if (!current(ticket)) return;
        if (!result?.ok) throw Error(result?.message || '无法读取这条子 Agent 记录。');
        for (const message of result.items || []) renderMessage(message);
        offset = result.nextOffset || request.offset + (result.items || []).length;
        more.hidden = !result.hasMore;
        setStatus(messages.childElementCount ? '' : '这条子 Agent 尚无可展示的记录。');
      } catch (error) { if (current(ticket)) { setStatus(error.message || '读取失败，请重试。', true); retry.hidden = false; more.hidden = true; } }
      finally { if (current(ticket)) { busy = false; more.disabled = false; } }
    }
    function choose(agentId) {
      revision++; busy = false; selected = agentId;
      for (const node of tabs.children) node.setAttribute('aria-current', node.dataset.agentId === agentId ? 'true' : 'false');
      return loadPage({ reset: true });
    }
    async function open(input) {
      revision++; owner = { convId: input.convId, runId: input.runId }; selected = null; busy = true; offset = 0;
      const ticket = revision; if (overlay.hidden) previousFocus = document.activeElement;
      overlay.hidden = false; title.textContent = input.title || '工作记录'; messages.replaceChildren(); tabs.replaceChildren();
      footer.hidden = false; more.hidden = true; retry.hidden = true; setStatus('正在查找本轮子 Agent…'); dialog.focus();
      try {
        if (!api?.listSubagents || !api?.getSubagentMessages) throw Error('当前版本尚未连接原生子 Agent 历史。');
        const result = await api.listSubagents(owner); if (!current(ticket)) return;
        if (!result?.ok) throw Error(result?.message || '无法读取本轮子 Agent。');
        const agents = result.items || [];
        if (!agents.length) { setStatus('这轮任务没有保留可读取的原生子 Agent 记录。'); footer.hidden = true; busy = false; return; }
        if (input.agentId && !agents.some(item => item.agentId === input.agentId)) throw Error('这个子 Agent 的原生记录已清理或不属于当前轮次。');
        agents.forEach((agent, index) => {
          const tab = button(agent.title || `Agent ${index + 1}`); tab.dataset.agentId = agent.agentId; tab.title = agent.agentId;
          tab.addEventListener('click', () => choose(agent.agentId)); tabs.append(tab);
        });
        tabs.hidden = agents.length < 2; busy = false; return choose(input.agentId || agents[0].agentId);
      } catch (error) { if (current(ticket)) { busy = false; setStatus(error.message || '读取失败，请重试。', true); retry.hidden = false; } }
    }
    closeButton.addEventListener('click', close); overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    more.addEventListener('click', () => loadPage()); retry.addEventListener('click', () => selected ? loadPage({ reset: true }) : open({ ...owner, title: title.textContent }));
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Tab') {
        const nodes = [...dialog.querySelectorAll('button:not(:disabled),[tabindex="0"],summary')].filter(node => !node.closest('[hidden]'));
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    const change = event => { const value = event.detail; const id = typeof value === 'string' ? value : value?.conversationId || value?.convId || value?.id; if (owner && id !== owner.convId) close(); };
    root.addEventListener('relay:conversation-changed', change); root.addEventListener('relay:view-changed', close);
    return { open, close, destroy() { close(); root.removeEventListener('relay:conversation-changed', change); root.removeEventListener('relay:view-changed', close); overlay.remove(); } };
  }
  root.RelaySubagentHistory = { create: createSubagentHistory };
  if (root.document?.body) root.relaySubagentHistory = createSubagentHistory();
})(typeof window === 'undefined' ? globalThis : window);
