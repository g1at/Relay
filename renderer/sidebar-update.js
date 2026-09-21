(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelaySidebarUpdate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATES = new Set(['idle', 'checking', 'available', 'downloading', 'ready', 'error', 'disabled']);
  const text = (value) => typeof value === 'string' ? value : '';
  const version = (value) => value ? `v${value.replace(/^v/i, '')}` : '新版本';
  function normalize(st) {
    return {
      state: STATES.has(st && st.state) ? st.state : 'idle',
      current: text(st && st.current).trim(), latest: text(st && st.latest).trim(),
      progress: Math.max(0, Math.min(100, Math.round(Number(st && st.progress) || 0))),
      error: text(st && st.error), checkedAt: Number(st && st.checkedAt) || 0,
      releaseNotes: text(st && st.releaseNotes),
    };
  }

  function describe(input, failure = null, pending = '') {
    const st = normalize(input);
    const knownVersion = !!st.latest && st.latest.replace(/^v/i, '') !== st.current.replace(/^v/i, '');
    const visible = st.state !== 'disabled' && (knownVersion || ['available', 'downloading', 'ready'].includes(st.state));
    const target = version(st.latest);
    const view = {
      visible, title: 'Relay 更新', description: '', error: '', action: '', actionLabel: '',
      note: '', noteKind: '', progress: null, pending: !!pending,
      versions: `${st.current ? `当前 ${version(st.current)}` : 'Relay'}${st.latest ? ` → ${target}` : ''}`,
      releaseNotes: st.releaseNotes,
    };
    switch (st.state) {
      case 'available':
        Object.assign(view, { title: `发现${st.latest ? `新版本 ${target}` : '可用更新'}`, description: '下载后，你可以选择何时重启安装。', action: 'download', actionLabel: st.error ? '重试下载' : '下载更新', note: st.error ? `下载失败，点击重试 ${target}` : `点击更新到 ${target}`, noteKind: st.error ? 'err' : 'accent', error: st.error ? `下载失败：${st.error}` : '' });
        break;
      case 'downloading':
        Object.assign(view, { title: '正在下载更新', description: '下载完成后，你可以选择何时重启安装。', progress: st.progress, actionLabel: '正在下载…', note: `正在下载 ${target} ${st.progress}%`, noteKind: 'accent' });
        break;
      case 'ready':
        Object.assign(view, { title: `${target} 已准备就绪`, description: '安装会退出并重启 Relay。请先保存当前工作，再选择重启安装。', action: 'install', actionLabel: '重启安装', note: `${target} 已就绪，点击重启安装`, noteKind: 'accent' });
        break;
      case 'checking':
        Object.assign(view, { title: '正在检查更新', description: knownVersion ? `此前发现 ${target}，正在确认最新更新状态。` : '正在确认最新更新状态。', actionLabel: '正在检查…', note: '检查更新中…' });
        break;
      case 'error':
        Object.assign(view, { title: '更新检查失败', description: knownVersion ? `此前发现 ${target}，这次检查未完成。请重新检查后再下载。` : '暂时无法确认是否有新版本。', action: 'check', actionLabel: '重新检查', note: knownVersion ? `检查失败，已知 ${target}，点击重试` : '检查失败，点击重试', noteKind: 'err', error: st.error ? `检查失败：${st.error}` : '' });
        break;
      case 'disabled':
        Object.assign(view, { note: '开发模式' });
        break;
      default:
        Object.assign(view, { title: knownVersion ? '更新状态待确认' : 'Relay 更新', description: knownVersion ? `此前发现 ${target}，请重新检查更新状态。` : '', action: 'check', actionLabel: '检查更新', note: knownVersion ? `已知 ${target}，点击重新检查` : st.checkedAt ? '已是最新版本' : '检查更新', noteKind: knownVersion ? 'accent' : st.checkedAt ? 'ok' : '' });
    }
    if (failure) {
      view.error = failure.message;
      view.note = `${failure.message}，点击重试`;
      view.noteKind = 'err';
      if (view.action === 'download') view.actionLabel = '重试下载';
      if (view.action === 'install') view.actionLabel = '重试安装';
    }
    if (pending) {
      view.actionLabel = { check: '正在检查…', download: '正在开始下载…', install: '正在重启…' }[pending] || '正在读取…';
      view.note = view.actionLabel;
      view.noteKind = 'accent';
    }
    return view;
  }

  // The store owns the one updater subscription shared by the sidebar and settings row.
  function createStore(api, onChange = () => {}) {
    let state = normalize({ state: 'idle' });
    let failure = null, pending = '', installAccepted = false;
    let revision = 0, snapshotId = 0, started = false, disposed = false, unsubscribe = null;
    const getView = () => describe(state, failure, installAccepted ? 'install' : pending);
    const publish = () => { if (!disposed) onChange({ ...state }, getView()); };
    function receive(st) {
      if (disposed || !st || !STATES.has(st.state)) return false;
      state = normalize(st); revision++; failure = null;
      if (state.state !== 'ready') installAccepted = false;
      publish();
      return true;
    }
    function fail(action, error) {
      const label = { status: '读取更新状态失败', check: '检查更新失败', download: '启动下载失败', install: '启动安装失败' }[action];
      const detail = text(error && error.message) || text(error) || '请稍后重试';
      failure = { action, message: `${label}：${detail}` };
      publish();
    }
    async function refresh() {
      const ticket = ++snapshotId, atRevision = revision;
      try {
        const st = await api.status();
        if (disposed) return false;
        if (ticket !== snapshotId || atRevision !== revision) return true;
        if (!receive(st)) throw new Error('未取得有效状态');
        return true;
      } catch (error) {
        if (!disposed && ticket === snapshotId && atRevision === revision) fail('status', error);
        return false;
      }
    }
    async function run(action) {
      if (disposed || pending || installAccepted || action !== getView().action || !action) return false;
      const method = { check: 'check', download: 'download', install: 'quitAndInstall' }[action];
      if (!method) return false;
      pending = action; failure = null; publish();
      const atRevision = revision;
      try {
        const result = await api[method]();
        if (disposed) return false;
        if (result && result.ok === false) throw new Error(text(result.error) || '操作未完成');
        if (action !== 'check' && (!result || result.ok !== true)) throw new Error('未收到操作确认，请重试');
        if (result && STATES.has(result.state) && atRevision === revision) receive(result);
        if (action === 'install') installAccepted = true;
        else await refresh();
        return true;
      } catch (error) {
        if (!disposed) fail(action, error);
        return false;
      } finally {
        pending = ''; publish();
      }
    }
    return {
      receive, refresh, run, getView, getState: () => ({ ...state }),
      start() {
        if (started || disposed) return;
        started = true;
        try { unsubscribe = api.onEvent(receive); } catch (error) { fail('status', error); }
        return refresh();
      },
      async activateFromSettings() {
        if (pending || installAccepted || disposed || !await refresh()) return false;
        return run(getView().action);
      },
      destroy() { disposed = true; if (typeof unsubscribe === 'function') unsubscribe(); },
    };
  }

  function create({ api, button, panel, label, onState = () => {} }) {
    if (!button || !panel) throw new Error('更新入口缺少页面容器');
    const doc = button.ownerDocument, win = doc.defaultView;
    let open = false;
    const hidden = (el, value) => { el.hidden = value; el.classList.toggle('hidden', value); };
    panel.classList.add('sidebar-update-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'sidebarUpdateTitle');
    panel.innerHTML = `<header class="sidebar-update-heading"><h2 id="sidebarUpdateTitle"></h2><button type="button" class="sidebar-update-close" data-update-close aria-label="关闭更新说明"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="sidebar-update-body"><p class="sidebar-update-versions"></p><p class="sidebar-update-description"></p><div class="sidebar-update-progress" hidden><div class="sidebar-update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin="0" aria-valuemax="100"><div class="sidebar-update-progress-fill"></div></div><p class="sidebar-update-progress-label"></p></div><div class="sidebar-update-notes" hidden><h3>更新说明</h3><p></p></div><p class="sidebar-update-error" role="status" aria-live="polite" hidden></p></div><footer class="sidebar-update-actions"><button type="button" class="sidebar-update-later" data-update-close>稍后</button><button type="button" class="sidebar-update-primary"></button></footer>`;
    const $ = (selector) => panel.querySelector(selector);
    const primary = $('.sidebar-update-primary');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', 'false');
    if (label) label.textContent = '更新';
    hidden(panel, true);
    hidden(button, true);
    function close(restoreFocus = false) {
      open = false; hidden(panel, true); button.setAttribute('aria-expanded', 'false');
      if (restoreFocus) {
        const candidates = [button, ...['btnSettings', 'btnExplore', 'btnToggleSidebar', 'btnNewChat'].map(id => doc.getElementById(id))];
        for (const target of candidates) {
          if (!target || target.hidden || target.disabled || target.closest('[hidden], [inert]')
              || !target.getClientRects().length) continue;
          target.focus({ preventScroll: true });
          if (doc.activeElement === target) break;
        }
      }
    }
    function position() {
      if (!open) return;
      const margin = 12, width = Math.max(0, Math.min(350, win.innerWidth - margin * 2));
      const chromeBottom = doc.getElementById('windowChrome')?.getBoundingClientRect().bottom || 0;
      const topInset = Math.max(margin, chromeBottom + 8);
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${Math.max(0, win.innerHeight - topInset - margin)}px`;
      const anchor = button.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
      const above = anchor.top - bounds.height - 10;
      const preferred = above >= topInset ? above : anchor.top + anchor.height + 10;
      panel.style.left = `${Math.max(margin, Math.min(anchor.left, win.innerWidth - width - margin))}px`;
      panel.style.top = `${Math.max(topInset, Math.min(preferred, win.innerHeight - bounds.height - margin))}px`;
    }
    const store = createStore(api, (st, view) => {
      hidden(button, !view.visible);
      button.title = view.title;
      button.setAttribute('aria-label', `更新：${view.title}`);
      if (!view.visible && open) close(panel.contains(doc.activeElement));
      $('#sidebarUpdateTitle').textContent = view.title;
      $('.sidebar-update-versions').textContent = view.versions;
      $('.sidebar-update-description').textContent = view.description;
      $('.sidebar-update-error').textContent = view.error;
      hidden($('.sidebar-update-error'), !view.error);
      $('.sidebar-update-notes p').textContent = view.releaseNotes;
      hidden($('.sidebar-update-notes'), !view.releaseNotes);
      hidden($('.sidebar-update-progress'), view.progress === null);
      $('.sidebar-update-progress-track').setAttribute('aria-valuenow', String(view.progress || 0));
      $('.sidebar-update-progress-fill').style.width = `${view.progress || 0}%`;
      $('.sidebar-update-progress-label').textContent = `${view.progress || 0}% · 下载完成后可选择何时重启`;
      primary.textContent = view.actionLabel;
      primary.disabled = !view.action || view.pending;
      primary.dataset.action = view.action;
      hidden(primary, !view.actionLabel);
      panel.setAttribute('aria-busy', String(view.pending));
      position(); onState(st, view);
    });
    function toggle() {
      if (open) { close(true); return; }
      if (!store.getView().visible) return;
      open = true; hidden(panel, false); button.setAttribute('aria-expanded', 'true');
      position(); $('[data-update-close]').focus({ preventScroll: true });
    }
    const onPanelClick = (event) => {
      if (event.target.closest('[data-update-close]')) close(true);
      else if (event.target.closest('.sidebar-update-primary')) store.run(primary.dataset.action);
    };
    const onOutside = (event) => { if (open && !panel.contains(event.target) && !button.contains(event.target)) close(false); };
    const onKey = (event) => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } };
    button.addEventListener('click', toggle);
    panel.addEventListener('click', onPanelClick);
    doc.addEventListener('pointerdown', onOutside, true);
    doc.addEventListener('click', onOutside, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('scroll', position, true);
    win.addEventListener('resize', position);
    const resizeObserver = win.ResizeObserver ? new win.ResizeObserver(position) : null;
    if (resizeObserver) { resizeObserver.observe(button); const sidebar = button.closest('.sidebar'); if (sidebar) resizeObserver.observe(sidebar); }
    return {
      ...store, close,
      destroy() {
        store.destroy(); close(); resizeObserver?.disconnect();
        button.removeEventListener('click', toggle); panel.removeEventListener('click', onPanelClick);
        doc.removeEventListener('pointerdown', onOutside, true); doc.removeEventListener('click', onOutside, true); doc.removeEventListener('keydown', onKey, true);
        doc.removeEventListener('scroll', position, true); win.removeEventListener('resize', position);
      },
    };
  }
  return { normalize, describe, createStore, create };
});
