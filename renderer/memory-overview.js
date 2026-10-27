/* Governed memory overview. Uses existing IPC revisions, document host and Relay controls. */
(() => {
  'use strict';
  const TYPES = { user: '用户', feedback: '反馈', project: '项目', reference: '参考' };
  const UNDO_TTL_MS = 5 * 60 * 1000;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const glyphs = {
    inbox:'<path d="M4 4h16l2 13H2L4 4Z"/><path d="M2 12h6l2 3h4l2-3h6"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>', search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    settings:'<path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', check:'<path d="m5 12 4 4L19 6"/>',
    edit:'<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/>',
    chat:'<path d="M21 11a8 8 0 0 1-8 8H7l-4 3V6a3 3 0 0 1 3-3h7a8 8 0 0 1 8 8Z"/><path d="M7 8h10M7 12h6"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name] || ''}</svg>`;
  const stateOf = item => item.health?.state || (['expired', 'superseded'].includes(item.status) || item.scope === 'retired' ? 'inactive' : item.status === 'draft' || item.confidence === 'inferred' && item.status === 'active' ? 'draft' : 'active');

  function create(options) {
    const { mount, api, notify, confirm, openDetail, renderBody } = options;
    let items = [], archives = [], projectNames = new Map(), tab = 'active', query = '', type = 'all', scope = 'all';
    let expanded = false, filtersOpen = false, selected = null, generation = 0, checking = false, archiveError = '', listError = '', projectWarning = '';
    let checkMessage = '', notice = null, undoTimer = 0, reviewSequence = 0;
    const reviews = new Map(), busy = new Set();
    mount.className = 'mem-overview';
    mount.innerHTML = `<header class="mem-overview-header"><h2>Relay 记忆</h2><span data-count></span><button class="mem-btn mem-quiet-button" type="button" data-memory-maintenance>${icon('settings')}整理与维护</button></header>
      <div class="memory-check-summary" data-mem-check-summary role="status" aria-live="polite" hidden></div>
      <div class="mem-inline-error" data-memory-load-error role="status" hidden></div>
      <div class="mem-operation-status" data-memory-operation-status role="status" hidden></div>
      <section data-memory-pending aria-label="待确认记忆"></section>
      <div class="mem-library-tools"><nav class="mem-tabs" role="tablist" aria-label="记忆状态"></nav><button class="mem-icon-button" type="button" data-memory-search-toggle aria-label="搜索与筛选记忆" aria-expanded="false">${icon('search')}</button></div>
      <div class="mem-filters" hidden></div><div class="mem-items" data-list role="tabpanel" aria-label="已记住"></div>
      <footer class="mem-overview-footer"><span data-memory-schedule>${icon('clock')}<span data-memory-schedule-text>自动整理已关闭</span></span><button class="mem-btn mem-quiet-button" type="button" data-memory-run>立即整理</button><span class="mem-footer-spacer"></span><button class="mem-btn mem-quiet-button" type="button" data-mem-check>检查旧记忆</button><button class="mem-btn mem-quiet-button" type="button" data-mem-index>查看索引</button></footer>`;
    const q = selector => mount.querySelector(selector);
    const owned = () => options.owned ? options.owned() : mount.isConnected;
    const projectName = id => projectNames.get(id) || options.projectName?.(id) || '';
    const scopeLabel = item => item.scope === 'project' ? `项目：${projectName(item.projectId) || (item.projectId ? '项目不存在' : '未指定项目')}` : item.scope === 'retired' ? '已停用' : '所有对话';
    const typeLabel = item => TYPES[item.type] || '未分类';
    const find = file => items.find(item => item.file === file) || archives.find(item => item.file === file);
    const empty = text => `<div class="mem-empty dp-empty">${escape(text)}</div>`;
    const isBusy = file => busy.has(file) || /^Win/i.test(navigator.platform || '') && [...busy].some(name => name.toLowerCase() === String(file).toLowerCase());
    const healthyDraft = item => stateOf(item) === 'draft';
    function invalidate(file) { reviews.delete(file); options.forget?.(file); }
    function scrollTo(node) {
      const content = mount.closest('.set-content');
      if (content && node) content.scrollTop += node.getBoundingClientRect().top - content.getBoundingClientRect().top;
    }
    function restoreFocus(previous) {
      if (!previous?.file) return;
      const row = [...mount.querySelectorAll('[data-memory-file]')].find(node => node.dataset.memoryFile === previous.file);
      row?.querySelector(`[${previous.action}]`)?.focus({ preventScroll: true });
    }
    function clearUndo(entry = notice) {
      if (!entry) return;
      delete entry.undoId; delete entry.undoExpiresAt;
      if (entry === notice) { clearTimeout(undoTimer); undoTimer = 0; }
    }
    function setNotice(next) {
      clearTimeout(undoTimer); undoTimer = 0;
      clearUndo(notice); notice = next;
      if (!notice?.undoId) return;
      const expiresAt = typeof notice.undoExpiresAt === 'number' ? notice.undoExpiresAt : Date.parse(notice.undoExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) { clearUndo(); return; }
      notice.undoExpiresAt = Math.min(expiresAt, Date.now() + UNDO_TTL_MS);
      const current = notice;
      undoTimer = setTimeout(() => {
        if (notice !== current) return;
        clearUndo(current);
        if (owned()) renderStatus(); else notice = null;
      }, notice.undoExpiresAt - Date.now());
    }
    function renderStatus() {
      if (notice?.undoId && notice.undoExpiresAt <= Date.now()) clearUndo();
      const summary = q('[data-mem-check-summary]');
      summary.textContent = [checkMessage, projectWarning].filter(Boolean).join(' · '); summary.hidden = tab === 'archived' || !summary.textContent;
      summary.dataset.warning = String(!!summary.textContent);
      const error = q('[data-memory-load-error]');
      const message = tab === 'archived' ? archiveError : listError;
      error.innerHTML = message ? `<span>${escape(message)}</span><button class="row-btn" data-memory-reload type="button">重试</button>` : '';
      error.hidden = !message;
      const status = q('[data-memory-operation-status]'); status.replaceChildren(); status.hidden = !notice;
      if (notice) {
        const text = document.createElement('span'); text.textContent = notice.message; status.append(text);
        if (notice.undoId) { const button = document.createElement('button'); button.className = 'row-btn'; button.type = 'button'; button.dataset.memoryUndo = ''; button.textContent = '撤销'; button.title = '5 分钟内可撤销'; button.disabled = isBusy(notice.file); status.append(button); }
      }
      const check = q('[data-mem-check]'); check.disabled = checking; check.textContent = checking ? '检查中…' : '检查旧记忆';
    }
    function renderTabs() {
      const focusedTab = q('.mem-tabs').contains(document.activeElement) ? document.activeElement.dataset.memoryTab : null;
      const groups = [['active','已记住',items.filter(i => stateOf(i) === 'active' && !healthyDraft(i)).length],['inactive','未生效',items.filter(i => stateOf(i) === 'inactive').length],['invalid','需处理',items.filter(i => stateOf(i) === 'invalid').length],['archived','已移除',archives.length]];
      q('[data-count]').textContent = `${groups[0][2]} 条可用`;
      q('.mem-tabs').innerHTML = groups.map(([key, label, count]) => `<button type="button" role="tab" class="mem-tab${tab === key ? ' is-active' : ''}" data-memory-tab="${key}"${key === 'archived' ? ` data-mem-archived aria-pressed="${tab === key}"` : ''} aria-selected="${tab === key}" tabindex="${tab === key ? 0 : -1}">${label}<span class="mem-count">${count}</span></button>`).join('');
      q('[data-list]').setAttribute('aria-label', groups.find(group => group[0] === tab)[1]);
      options.onPendingCount?.(items.filter(healthyDraft).length);
      if (focusedTab) q(`[data-memory-tab="${tab}"]`)?.focus({preventScroll:true});
    }
    function sourcesMarkup(sources) {
      if (!sources?.length) return '<p class="mem-field-label">这条旧记忆未保存来源。</p>';
      return `<h4 class="mem-source-heading">来源 <span>${sources.length} 个记录</span></h4>` + sources.map((source, index) => {
        const date = new Date(source.at);
        const at = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN');
        const title = source.kind === 'conversation' ? source.title || '历史对话' : source.file || '关联记忆';
        return `<details class="mem-source"${index === 0 ? ' open' : ''}><summary>${icon('chat')}<span>${escape(title)}</span><time class="mem-source-date">${escape(at)}</time>${icon('chevron')}</summary>${source.quote ? `<blockquote class="mem-source-quote">${escape(source.quote)}</blockquote>` : ''}<button class="mem-btn mem-quiet-button" type="button" data-memory-source="${index}">${source.kind === 'conversation' ? '查看原对话' : '查看关联记忆'}</button></details>`;
      }).join('');
    }
    function reviewMarkup(item) {
      const record = reviews.get(item.file);
      if (!record || record.loading) return '<div class="mem-review"><div class="mem-review-scroll" role="status">正在读取候选及来源…</div></div>';
      if (record.error) return `<div class="mem-review"><div class="mem-review-scroll mem-inline-error" role="status">${escape(record.error)} <button class="row-btn" type="button" data-memory-review-retry>重试</button></div></div>`;
      const entry = record.entry, targets = record.targets || [], blocked = stateOf({ ...entry.meta, health:entry.health }) === 'invalid' || record.staleTargets;
      const reasons = record.staleTargets ? '原记忆已变化或不存在，请重新整理候选后再确认。' : entry.health?.reason;
      return `<section class="mem-review" aria-label="审核：${escape(item.name || item.file)}"><div class="mem-review-scroll">${blocked ? `<p class="mem-inline-error">${escape(reasons || '请先修复记忆数据。')}</p>` : ''}
        ${targets.length ? `<div class="mem-field-label">将替代以下 ${targets.length} 条记忆</div><div class="mem-merge-before">${targets.map(target => `<section class="mem-merge-old"><h4>${escape(target.meta?.name || target.file)}</h4>${target.ok ? renderBody(target.content) : `<p>${escape(target.message || '原记忆无法读取')}</p>`}</section>`).join('')}</div><div class="mem-field-label">归并后保留</div>` : '<div class="mem-field-label">建议记住</div>'}
        <div class="mem-review-body">${renderBody(entry.content)}</div>${targets.length ? '<p class="mem-review-hint">原记忆将保留在“未生效”中。</p>' : ''}
        ${sourcesMarkup(entry.meta?.sources || item.sources)}</div><footer class="mem-review-footer"><button class="mem-btn mem-quiet-button" type="button" data-memory-dismiss${isBusy(item.file) ? ' disabled' : ''}>忽略</button><span class="mem-review-hint">${escape(scopeLabel(item))}</span><button class="row-btn" type="button" data-memory-edit${isBusy(item.file) ? ' disabled' : ''}>${icon('edit')}修改</button><button class="row-btn mem-confirm-button" type="button" data-memory-approve${isBusy(item.file) || blocked ? ' disabled' : ''}>${icon('check')}${isBusy(item.file) ? '处理中…' : targets.length ? `确认归并 ${targets.length} 条` : '确认记住'}</button></footer></section>`;
    }
    function renderPending() {
      const drafts = items.filter(healthyDraft), region = q('[data-memory-pending]');
      const oldReview = region.querySelector('.mem-candidate.is-open'), sameReview = oldReview?.dataset.memoryFile === selected;
      const oldScroll = sameReview ? oldReview.querySelector('.mem-review-scroll')?.scrollTop : 0;
      const oldSources = sameReview ? [...oldReview.querySelectorAll('.mem-source')].map(node => node.open) : [];
      const sourceFocus = sameReview ? [...oldReview.querySelectorAll('.mem-source summary, .mem-source button')].indexOf(document.activeElement) : -1;
      const focused = region.contains(document.activeElement) ? { file:document.activeElement.closest('[data-memory-file]')?.dataset.memoryFile, action:[...document.activeElement.attributes].find(attribute=>attribute.name.startsWith('data-memory-'))?.name } : null;
      if (!drafts.some(item => item.file === selected)) selected = null;
      region.innerHTML = drafts.length ? `<div class="mem-pending"><header class="mem-pending-head">${icon('inbox')}<h3>待确认</h3><span class="mem-count">${drafts.length}</span><small>确认后才会用于对话</small></header>${drafts.map(item => `<article class="mem-candidate${selected === item.file ? ' is-open' : ''}" data-memory-file="${escape(item.file)}" data-memory-health="draft"><div class="mem-candidate-summary"><div class="mem-candidate-main"><div class="mem-candidate-title"><h3>${escape(item.name || item.file)}</h3><span class="mem-badge ${item.replaces?.length ? 'mem-badge-merge' : 'mem-badge-new'}">${item.replaces?.length ? `归并 ${item.replaces.length} 条` : '新增'}</span></div><div class="mem-candidate-meta"><span>${escape(typeLabel(item))}</span><span>·</span><span>${escape(scopeLabel(item))}</span><span>·</span><span>${item.sources?.length || 0} 个来源</span></div></div><div class="mem-candidate-actions">${selected !== item.file ? `<button class="mem-btn mem-quiet-button" type="button" data-memory-dismiss${isBusy(item.file) ? ' disabled' : ''}>忽略</button>` : ''}<button class="mem-btn mem-review-button" type="button" data-memory-review aria-expanded="${selected === item.file}">${selected === item.file ? '收起' : item.replaces?.length ? '对比并确认' : '查看并确认'}${icon('chevron')}</button></div></div>${selected === item.file ? reviewMarkup(item) : ''}</article>`).join('')}</div>` : '';
      const newReview = region.querySelector('.mem-candidate.is-open');
      if (sameReview && newReview) {
        const scroll = newReview.querySelector('.mem-review-scroll'); if (scroll) scroll.scrollTop=oldScroll || 0;
        newReview.querySelectorAll('.mem-source').forEach((node,index)=>{if(index<oldSources.length)node.open=oldSources[index];});
      }
      if (sourceFocus >= 0) newReview?.querySelectorAll('.mem-source summary, .mem-source button')[sourceFocus]?.focus({preventScroll:true});
      else if (focused?.action) restoreFocus(focused);
    }
    function renderLibrary() {
      const source = tab === 'archived' ? archives : items.filter(item => stateOf(item) === tab && !healthyDraft(item));
      const filtered = source.filter(item => (type === 'all' || (item.type || 'unclassified') === type) && (scope === 'all' || (scope === 'global' ? item.scope !== 'project' && item.scope !== 'retired' : item.projectId === scope)) && (!query || `${item.name || ''} ${item.description || ''} ${item.file} ${scopeLabel(item)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
      const limited = !expanded && !query && type === 'all' && scope === 'all';
      const shown = limited ? filtered.slice(0, 4) : filtered;
      const list = q('[data-list]');
      list.innerHTML = shown.length ? shown.map(item => {
        const invalid = stateOf(item) === 'invalid', archived = tab === 'archived';
        const health = invalid ? `<div class="memory-item-health"><span class="memory-health-badge">需修复</span><span class="memory-health-reason">${escape(item.health?.reason || '请检查记忆内容与项目归属。')}</span></div>` : '';
        const title = `${escape(item.name || item.file)}${item.pinned ? '<span class="mem-badge">核心</span>' : ''}${item.status === 'superseded' ? '<span class="mem-badge">已替代</span>' : item.status === 'expired' ? '<span class="mem-badge">已忽略 / 过期</span>' : ''}`;
        const actions = archived ? `<div class="memory-archive-actions"><button class="row-btn" data-memory-restore type="button"${isBusy(item.file) ? ' disabled' : ''}>恢复</button><button class="row-btn memory-purge" data-memory-purge type="button"${isBusy(item.file) ? ' disabled' : ''}>永久删除</button></div>` : `<span class="mem-badge">${escape(typeLabel(item))}</span><span class="mem-item-scope" title="${escape(scopeLabel(item))}">${escape(scopeLabel(item))}</span><div class="mem-item-actions dp-menu-wrap">${invalid ? '<button class="row-btn memory-repair" type="button" data-action="repair">修复</button>' : ''}<button class="dp-more" type="button" aria-label="更多操作">···</button><div class="dp-menu"><button type="button" data-action="detail">详情</button>${item.status === 'expired' ? '<button type="button" data-action="reactivate">重新确认</button>' : ''}<button type="button" data-action="pin"${item.pinnedInFile ? ' disabled title="该标记来自 Markdown frontmatter，请在编辑页修改"' : ''}>${item.pinnedInFile ? '核心来自 Markdown' : item.pinned ? '取消核心' : '设为核心'}</button><button type="button" class="danger" data-action="delete">移除</button></div></div>`;
        return `<div class="mem-item dp-item" data-memory-file="${escape(item.file)}" data-memory-health="${archived ? 'archived' : stateOf(item)}"><${archived ? 'div' : 'button type="button" data-action="detail"'} class="mem-item-main"><div class="mem-item-title dp-item-name">${title}</div><div class="mem-item-desc dp-item-desc"><span class="mem-narrow-scope">${escape(scopeLabel(item))} · </span>${escape(item.description || (archived ? '原始聊天会保留' : '暂无摘要'))}</div>${health}</${archived ? 'div' : 'button'}>${actions}</div>`;
      }).join('') + (filtered.length > 4 && !query && type === 'all' && scope === 'all' ? `<button class="mem-more" type="button" data-memory-show-all>${expanded ? '收起列表' : `查看全部 ${filtered.length} 条记忆`}</button>` : '') : empty(query || type !== 'all' || scope !== 'all' ? '没有匹配的记忆' : ({ active:'还没有可用记忆，确认候选后会显示在这里。',inactive:'没有未生效的记忆。',invalid:'没有需要处理的记忆。',archived:'没有已移除的记忆。' }[tab]));
      list.querySelectorAll('.dp-menu-wrap').forEach(node => options.bindMenu?.(node));
    }
    function render() { renderTabs(); renderStatus(); renderPending(); renderLibrary(); }
    function bindFilter(root, onChange) {
      const trigger = root.querySelector('.cs-trigger'), popup = root.querySelector('.cs-popup'), opts = [...root.querySelectorAll('.cs-option')];
      trigger.setAttribute('role','button'); trigger.setAttribute('aria-haspopup','listbox'); trigger.setAttribute('aria-expanded','false'); popup.setAttribute('role','listbox');
      opts.forEach(option => { option.tabIndex = -1; option.setAttribute('role','option'); option.setAttribute('aria-selected', String(option.classList.contains('selected'))); option.addEventListener('click', () => { opts.forEach(node => node.setAttribute('aria-selected',String(node === option))); onChange(); }); });
      root.addEventListener('keydown', event => {
        if (!['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const index = opts.indexOf(document.activeElement);
        if (['Enter',' '].includes(event.key) && index >= 0) { opts[index].click(); trigger.focus(); return; }
        if (popup.hidden) trigger.click();
        let next = index < 0 ? Math.max(0, opts.findIndex(option => option.classList.contains('selected'))) : index;
        if (event.key === 'Home') next = 0; else if (event.key === 'End') next = opts.length - 1;
        else if (index >= 0 && event.key === 'ArrowDown') next = (index + 1) % opts.length;
        else if (index >= 0 && event.key === 'ArrowUp') next = (index - 1 + opts.length) % opts.length;
        opts[next].focus({preventScroll:true}); options.revealSelectOption?.(popup, opts[next]);
      });
    }
    function renderFilters() {
      const filters = q('.mem-filters'); filters.hidden = !filtersOpen;
      q('[data-memory-search-toggle]').setAttribute('aria-expanded', String(filtersOpen));
      options.closeSelect?.();
      if (!filtersOpen) { filters.replaceChildren(); return; }
      const scopes = [{value:'all',label:'全部范围'},{value:'global',label:'所有对话'}, ...[...new Set([...items, ...archives].filter(item => item.scope === 'project' && item.projectId).map(item => item.projectId))].map(id => ({value:id,label:`项目：${projectName(id) || '项目不存在'}`}))];
      filters.innerHTML = `<label class="mem-search">${icon('search')}<input type="search" data-memory-search aria-label="搜索记忆" placeholder="搜索记忆内容" value="${escape(query)}"></label>${options.buildSelect('memory-type-filter',[{value:'all',label:'全部类型'},...Object.entries(TYPES).map(([value,label]) => ({value,label})),{value:'unclassified',label:'未分类'}],type)}${options.buildSelect('memory-scope-filter',scopes,scope)}`;
      options.bindSelects(filters);
      bindFilter(q('#memory-type-filter'), () => { type=q('#memory-type-filter').dataset.value; renderLibrary(); });
      bindFilter(q('#memory-scope-filter'), () => { scope=q('#memory-scope-filter').dataset.value; renderLibrary(); });
      q('#memory-type-filter .cs-trigger').setAttribute('aria-label','记忆类型');q('#memory-scope-filter .cs-trigger').setAttribute('aria-label','使用范围');
      q('[data-memory-search]').addEventListener('input', event => { query=event.target.value.trim(); renderLibrary(); });
    }
    async function readReview(item, force = false) {
      const cached = reviews.get(item.file);
      if (!force && cached && cached.listRevision === item.revision && !cached.error) return;
      const record = { loading:true, listRevision:item.revision, token:++reviewSequence }; reviews.set(item.file,record); renderPending();
      try {
        const entry = await api.read(item.file);
        if (!entry?.ok) throw new Error(entry?.message || '候选读取失败');
        if (reviews.get(item.file) !== record) return;
        const current = items.find(candidate => candidate.file === item.file);
        if (!current) return;
        if (entry.revision !== current.revision) { Object.assign(current, entry.meta, { revision:entry.revision, health:entry.health }); record.listRevision=entry.revision; renderTabs(); renderLibrary(); }
        const replacements = entry.meta?.replaces || item.replaces || [];
        const targets = await Promise.all(replacements.map(async target => {
          try { return { ...await api.read(target.file), file:target.file, expectedRevision:target.revision }; }
          catch (error) { return {ok:false,file:target.file,message:error.message}; }
        }));
        if (reviews.get(item.file) !== record) return;
        record.entry=entry;record.targets=targets;record.staleTargets=targets.some(target => !target.ok || target.revision !== target.expectedRevision);
      } catch (error) { record.error=error.message || '候选读取失败'; }
      finally { if (reviews.get(item.file) === record) {record.loading=false;if (owned() && selected === item.file) renderPending();} }
    }
    async function load({ check = false } = {}) {
      const request = ++generation;
      if (check) {checking=true;renderStatus();}
      const responses = await Promise.allSettled([check ? api.check() : api.list(), api.archived(), options.projects?.()]);
      if (request !== generation || !owned()) {if(check){checking=false;renderStatus();}return;}
      const [list, archived, projects] = responses.map(response => response.status === 'fulfilled' ? response.value : {ok:false,message:response.reason?.message});
      const previous = document.activeElement?.closest('[data-memory-file]');
      const focus = previous ? {file:previous.dataset.memoryFile,action:document.activeElement?.hasAttribute('data-memory-review')?'data-memory-review':'data-action="detail"'} : null;
      if (list?.ok) {
        items=list.items || [];listError='';projectWarning=list.projectCheck?.available === false ? '项目归属检查未完成，请重试' : '';
        const count=items.filter(item=>stateOf(item)==='invalid').length;checkMessage=count?`${count} 条需修复`:'';
        if(check&&!checkMessage&&!projectWarning)notify('检查完成，未发现异常');
        for(const [file,record] of reviews){const item=items.find(entry=>entry.file===file);if(!item||item.revision!==record.listRevision)reviews.delete(file);}
      } else {listError=list?.message || '记忆读取失败，请重试';if(check)checkMessage=listError;}
      if(archived?.ok){archives=(archived.items || []).map(item=>({...item.meta,...item,scope:item.scope || item.meta?.scope || 'global'}));archiveError='';}
      else archiveError=archived?.message || '已移除记忆读取失败，请重试';
      if(projects?.ok!==false&&Array.isArray(projects?.projects))projectNames=new Map(projects.projects.map(project=>[project.id,project.name]));
      checking=false;render();restoreFocus(focus);
      if(selected){const item=find(selected);if(item)void readReview(item);}
    }
    async function mutate(item, action) {
      if (!item || isBusy(item.file)) return;
      if (['approve','dismiss','delete','reactivate'].includes(action) && options.hasDraft?.(item.file)) {notify('这条记忆还有未保存的修改，请先保存或取消编辑');openDetail(item.file,item.name,{edit:true});return;}
      const record = reviews.get(item.file);
      if(action==='approve'&&(!healthyDraft(item)||!record?.entry||record.loading||record.error||record.staleTargets||record.entry.health?.state==='invalid'))return;
      busy.add(item.file);renderPending();renderLibrary();renderStatus();
      try {
        let result, message;
        if(action==='purge'){
          if(!await confirm({title:'永久删除记忆',message:`永久删除「${item.name || item.file}」及其恢复数据？此操作无法恢复，原始聊天记录会保留。`,confirmText:'永久删除',cancelText:'取消',danger:true}))return;
          result=await api.purge(item.file,item.archiveId);
          if(result?.code==='MEMORY_PURGE_PENDING')invalidate(item.file);
          message=result?.warning || '已永久删除记忆及其恢复数据';
        } else if(action==='restore'){result=await api.restoreArchived(item.file,item.archiveId);message='记忆已恢复';}
        else if(action==='delete'){
          if(!await confirm({title:'移除记忆',message:`移除「${item.name || item.file}」后，助手将不再使用这条记忆，可在“已移除”中恢复。`,confirmText:'移除',cancelText:'取消',danger:true}))return;
          result=await api.remove(item.file,item.revision);message='已移除，可随时恢复';
        } else if(action==='pin'){if(item.pinnedInFile)return;result=await api.setPinned(item.file,!item.pinned);message=item.pinned?'已取消核心记忆':'已设为核心记忆';}
        else {
          result=await api.setStatus(item.file,action==='approve'?'active':action==='reactivate'?'draft':'expired',action==='approve'?record.entry.revision:item.revision);
          message=action==='approve'?'已确认记住':action==='reactivate'?'已放回待确认':'已忽略这条候选记忆';
        }
        if(!result?.ok)throw new Error(result?.message || '操作失败，请重试');
        if(action!=='pin')invalidate(item.file);
        if(['approve','dismiss','delete'].includes(action)&&selected===item.file)selected=null;
        setNotice({message,file:item.file,undoId:['approve','dismiss'].includes(action)?result.undoId:null,undoExpiresAt:result.undoExpiresAt,revision:result.revision});
        notify(message);await load();
        if(action==='reactivate'){selected=item.file;renderPending();const restored=find(item.file);if(restored)void readReview(restored);}
      }catch(error){notify(error.message || '操作失败，请重试');}
      finally{busy.delete(item.file);if(owned()){renderPending();renderLibrary();renderStatus();}}
    }
    mount.addEventListener('click', async event => {
      const button=event.target.closest('button');if(!button||button.disabled)return;
      const row=button.closest('[data-memory-file]'),item=row?(row.dataset.memoryHealth==='archived'?archives.find(entry=>entry.file===row.dataset.memoryFile):find(row.dataset.memoryFile)):null;
      if (item && isBusy(item.file) && !button.hasAttribute('data-memory-review')) return;
      if(button.hasAttribute('data-memory-tab')){tab=button.dataset.memoryTab;expanded=false;renderTabs();renderStatus();renderLibrary();q(`[data-memory-tab="${tab}"]`)?.focus({preventScroll:true});void load();}
      else if(button.hasAttribute('data-memory-show-all')){expanded=!expanded;renderLibrary();}
      else if(button.hasAttribute('data-memory-search-toggle')){filtersOpen=!filtersOpen;if(!filtersOpen){query='';type='all';scope='all';renderLibrary();}renderFilters();if(filtersOpen)q('[data-memory-search]')?.focus({preventScroll:true});}
      else if(button.hasAttribute('data-memory-review')&&item){selected=selected===item.file?null:item.file;renderPending();if(selected){void readReview(item);scrollTo([...mount.querySelectorAll('.mem-candidate')].find(node=>node.dataset.memoryFile===item.file));}restoreFocus({file:item.file,action:'data-memory-review'});}
      else if(button.hasAttribute('data-memory-review-retry')&&item)void readReview(item,true);
      else if(button.hasAttribute('data-memory-approve'))void mutate(item,'approve');
      else if(button.hasAttribute('data-memory-dismiss'))void mutate(item,'dismiss');
      else if(button.hasAttribute('data-memory-edit')&&item)openDetail(item.file,item.name,{edit:true});
      else if(button.hasAttribute('data-memory-source')&&item){const source=(reviews.get(item.file)?.entry?.meta?.sources || item.sources || [])[Number(button.dataset.memorySource)];if(source?.kind==='conversation')await options.openConversation?.(source);else if(source?.kind==='memory')openDetail(source.file,source.file);}
      else if(button.hasAttribute('data-memory-restore'))void mutate(item,'restore');
      else if(button.hasAttribute('data-memory-purge'))void mutate(item,'purge');
      else if(button.dataset.action&&item){const action=button.dataset.action;if(action==='detail'||action==='repair')openDetail(item.file,item.name,{edit:action==='repair'});else if(['pin','delete','reactivate'].includes(action))void mutate(item,action);}
      else if(button.hasAttribute('data-mem-check')){if(!checking)void load({check:true});}
      else if(button.hasAttribute('data-memory-reload'))void load();
      else if(button.hasAttribute('data-mem-index'))openDetail('MEMORY.md','记忆索引 (MEMORY.md)');
      else if(button.hasAttribute('data-memory-maintenance'))options.openMaintenance?.();
      else if(button.hasAttribute('data-memory-run'))options.run?.();
      else if(button.hasAttribute('data-memory-undo')&&notice?.undoId&&!isBusy(notice.file)){
        const undo=notice;
        if(undo.undoExpiresAt<=Date.now()){clearUndo(undo);renderStatus();return;}
        if(options.hasDraft?.(undo.file)){notify('这条记忆还有未保存的修改，请先保存或取消编辑');openDetail(undo.file,find(undo.file)?.name,{edit:true});return;}
        busy.add(undo.file);renderStatus();
        try{
          const result=await api.undo(undo.file,undo.undoId,undo.revision);
          if(!result?.ok){if(result?.code==='MEMORY_CONFLICT'||String(result?.code||'').startsWith('MEMORY_UNDO_'))clearUndo(undo);throw new Error(result?.message||'撤销失败');}
          invalidate(undo.file);if(notice===undo)setNotice(null);notify('已撤销');await load();
        }
        catch(error){notify(error.message||'撤销失败');}finally{busy.delete(undo.file);renderStatus();}
      }
    }, true);
    q('.mem-tabs').addEventListener('keydown', event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const tabs=[...q('.mem-tabs').querySelectorAll('button')],index=tabs.indexOf(document.activeElement);if(index<0)return;event.preventDefault();tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length].click();});
    render();
    return {load,isBusy,setSchedule(text,running){q('[data-memory-schedule-text]').textContent=text;q('[data-memory-run]').disabled=!!running;q('[data-memory-run]').textContent=running?'整理中…':'立即整理';},get selected(){return selected;}};
  }
  window.RelayMemoryOverview = { create };
})();
