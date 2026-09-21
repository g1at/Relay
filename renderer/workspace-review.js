(function (root, factory) {
  'use strict';
  const exported = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (root) root.RelayWorkspaceReview = exported;
}(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';
  const STAGES = Object.freeze([
    { id: 'unstaged', label: '未暂存' }, { id: 'staged', label: '已暂存' }, { id: 'untracked', label: '新文件' },
  ]);
  const STATUS = Object.freeze({ A: '新增', M: '修改', D: '删除', R: '重命名', C: '复制', U: '冲突', T: '类型变更', '?': '未跟踪' });
  const keyFor = file => JSON.stringify([file.stage, file.path]);
  const contextKey = value => JSON.stringify([value?.conversationId || null, value?.workingDir || null, value?.projectId || null]);
  const count = value => Number.isFinite(value) && value >= 0 ? String(value) : '—';
  const stageLabel = value => STAGES.find(stage => stage.id === value)?.label || '改动';
  function checked(result) {
    if (!result || result.ok === false) throw new Error(result?.error || '暂时无法读取改动，请重试');
    return result;
  }
  function groupFiles(files) {
    return STAGES.map(stage => ({ ...stage, files: (Array.isArray(files) ? files : []).filter(file => file && file.stage === stage.id && typeof file.path === 'string') }));
  }
  // Parse numbers only inside a hunk: file headers may begin with + or - too.
  // Bound DOM work independently of Git's output limit.
  function parseUnifiedDiff(value, { maxLines = 6000, maxLineLength = 16000 } = {}) {
    const source = typeof value === 'string' ? value : '', raw = source.slice(0, 2 * 1024 * 1024).split('\n');
    if (raw.at(-1) === '') raw.pop();
    const lines = []; let oldLine = null, newLine = null, inHunk = false, truncated = source.length > 2 * 1024 * 1024;
    for (const rawLine of raw) {
      if (lines.length >= maxLines) { truncated = true; break; }
      const full = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const text = full.slice(0, maxLineLength); if (text.length < full.length) truncated = true;
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; lines.push({ kind: 'hunk', text, oldLine: null, newLine: null }); continue; }
      if (/^(?:diff --|@@@)/.test(text)) inHunk = false;
      if (inHunk && text.startsWith('+')) lines.push({ kind: 'add', text: text.slice(1), oldLine: null, newLine: newLine++ });
      else if (inHunk && text.startsWith('-')) lines.push({ kind: 'delete', text: text.slice(1), oldLine: oldLine++, newLine: null });
      else if (inHunk && text.startsWith(' ')) lines.push({ kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
      else lines.push({ kind: 'meta', text, oldLine: null, newLine: null });
    }
    return { lines, truncated };
  }
  function tokenizeLine(text) {
    if (text.length > 2000) return [{ text, kind: '' }];
    const expression = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/.*$|^\s*#.*$)|\b(const|let|var|function|return|if|else|for|while|class|extends|import|export|from|async|await|new|throw|try|catch|def|elif|in|None|True|False|true|false|null|undefined|public|private|static|void|int|boolean)\b|\b(\d+(?:\.\d+)?)\b/g;
    const tokens = []; let cursor = 0, match;
    while ((match = expression.exec(text))) {
      if (match.index > cursor) tokens.push({ text: text.slice(cursor, match.index), kind: '' });
      tokens.push({ text: match[0], kind: match[1] ? 'string' : match[2] ? 'comment' : match[3] ? 'keyword' : 'number' });
      cursor = expression.lastIndex;
    }
    if (cursor < text.length || !tokens.length) tokens.push({ text: text.slice(cursor), kind: '' });
    return tokens;
  }
  function createController({ api, onChange = () => {} }) {
    let disposed = false, active = false, revision = 0, diffRevision = 0;
    let state = { context: null, snapshot: null, loading: false, error: null, selectedKey: null, diff: null, diffLoading: false, diffError: null };
    const emit = () => { if (!disposed) onChange({ ...state }); };
    async function select(file) {
      if (disposed || !file || !state.snapshot?.files?.some(item => keyFor(item) === keyFor(file))) return;
      const own = ++diffRevision, scope = revision, context = state.context;
      state = { ...state, selectedKey: keyFor(file), diff: null, diffLoading: true, diffError: null }; emit();
      try {
        if (typeof api?.reviewDiff !== 'function') throw new Error('审查组件未加载，请重启 Relay');
        const result = checked(await api.reviewDiff({ context, path: file.path, stage: file.stage }));
        if (disposed || scope !== revision || own !== diffRevision) return;
        if (result.path !== file.path || result.stage !== file.stage) throw new Error('文件已发生变化，请刷新改动列表');
        state = { ...state, diff: result, diffLoading: false };
      } catch (error) {
        if (disposed || scope !== revision || own !== diffRevision) return;
        state = { ...state, diff: null, diffLoading: false, diffError: error.message || '暂时无法读取差异，请重试' };
      }
      emit();
    }
    async function refresh() {
      if (disposed) return;
      const own = ++revision, context = state.context, selected = state.selectedKey;
      diffRevision++; state = { ...state, loading: true, error: null, diffLoading: false }; emit();
      try {
        if (typeof api?.review !== 'function') throw new Error('审查组件未加载，请重启 Relay');
        const result = checked(await api.review(context));
        if (disposed || own !== revision) return;
        const files = groupFiles(result.files).flatMap(group => group.files);
        state = { ...state, snapshot: { ...result, files }, loading: false, diff: null, diffError: null, selectedKey: null };
        emit();
        if (result.kind === 'ready') {
          const next = files.find(file => keyFor(file) === selected) || files[0];
          if (next) await select(next);
        }
      } catch (error) {
        if (disposed || own !== revision) return;
        state = { ...state, loading: false, snapshot: null, selectedKey: null, diff: null, diffError: null, error: error.message || '暂时无法读取改动，请重试' }; emit();
      }
    }
    emit();
    return {
      getState: () => ({ ...state }), refresh, select,
      setContext(value) {
        const changed = contextKey(value) !== contextKey(state.context);
        state = { ...state, context: value ? { ...value } : null };
        if (!changed || disposed) return;
        revision++; diffRevision++;
        state = { ...state, snapshot: null, selectedKey: null, diff: null, error: null, diffError: null, loading: false, diffLoading: false }; emit();
        if (active) void refresh();
      },
      setActive(value) {
        const next = !!value; if (disposed || next === active) return; active = next;
        if (active) void refresh();
        else {
          // The IPC already in flight may finish, but a hidden review must not
          // start another Git read or publish that now-obsolete response.
          revision++; diffRevision++; state = { ...state, loading: false, diffLoading: false }; emit();
        }
      },
      destroy() { disposed = true; active = false; revision++; diffRevision++; state = { ...state, context: null, snapshot: null, diff: null }; },
    };
  }
  function create({ mount, api }) {
    if (!mount) throw new Error('Missing review mount');
    const doc = mount.ownerDocument;
    function node(tag, className, text) { const el = doc.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; }
    function glyph(name) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = name === 'refresh' ? '<path d="M20 7v5h-5M4 17v-5h5M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8"/>' : '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 12h6M11 9v6M8 18h6"/>';
      return svg;
    }
    const page = node('div', 'wrev-page'), toolbar = node('div', 'wrev-toolbar'), heading = node('div', 'wrev-heading');
    const title = node('strong', '', '工作区改动'), subtitle = node('span', 'wrev-subtitle'); subtitle.dataset.reviewSummary = '';
    heading.append(title, subtitle);
    const refresh = node('button', 'workspace-icon-button wrev-refresh'); refresh.type = 'button'; refresh.title = '刷新改动'; refresh.setAttribute('aria-label', '刷新改动'); refresh.dataset.reviewRefresh = ''; refresh.append(glyph('refresh'));
    toolbar.append(heading, refresh);
    const status = node('div', 'wrev-notice'); status.dataset.reviewNotice = ''; status.setAttribute('role', 'status'); status.hidden = true;
    const body = node('div', 'wrev-body'), list = node('div', 'wrev-files'), detail = node('div', 'wrev-detail');
    list.dataset.reviewFiles = ''; list.setAttribute('aria-label', '改动文件'); list.tabIndex = 0;
    detail.dataset.reviewDetail = ''; body.append(list, detail); page.append(toolbar, status, body); mount.replaceChildren(page);
    const findingsBox = node('details', 'wrev-findings'); findingsBox.hidden = true;
    page.insertBefore(findingsBox, body);
    let controller, listKey = '', detailKey = '', disposed = false, findingsKey = '';
    function empty(host, state, titleText, description, retry) {
      const box = node('div', 'wrev-empty'); box.dataset.reviewState = state; box.append(glyph('file'), node('strong', '', titleText));
      if (description) box.append(node('p', '', description));
      if (retry) { const button = node('button', 'wrev-retry', '重试'); button.type = 'button'; button.addEventListener('click', retry); box.append(button); }
      host.replaceChildren(box);
    }
    function totals(host, file) {
      const added = node('span', 'wrev-added', '+' + count(file.added)), deleted = node('span', 'wrev-deleted', '−' + count(file.deleted));
      host.append(added, deleted);
    }
    function renderList(state) {
      const fingerprint = JSON.stringify([state.snapshot?.files, state.selectedKey, state.loading]); if (fingerprint === listKey) return; listKey = fingerprint;
      const scroll = list.scrollTop, focused = list.contains(doc.activeElement) ? doc.activeElement.dataset.reviewKey : null;
      list.replaceChildren();
      for (const group of groupFiles(state.snapshot?.files)) {
        if (!group.files.length) continue;
        const section = node('section', 'wrev-group'); section.dataset.reviewStage = group.id;
        const label = node('h3', 'wrev-group-title', group.label); label.append(node('span', '', String(group.files.length))); section.append(label);
        for (const file of group.files) {
          const button = node('button', 'wrev-file'); button.type = 'button'; button.dataset.reviewPath = file.path; button.dataset.reviewKey = keyFor(file); button.dataset.reviewStage = file.stage;
          button.classList.toggle('is-selected', keyFor(file) === state.selectedKey); button.setAttribute('aria-pressed', String(keyFor(file) === state.selectedKey));
          button.title = (file.oldPath ? file.oldPath + ' → ' : '') + file.path + ' · ' + (STATUS[file.status] || file.status || '修改');
          button.disabled = state.loading;
          button.append(root?.relayWorkspaceFileTypes?.createIcon(file.path) || glyph('file'));
          const name = node('span', 'wrev-file-name'), slash = file.path.lastIndexOf('/');
          name.append(node('span', 'wrev-file-base', file.path.slice(slash + 1)));
          if (slash >= 0) name.append(node('span', 'wrev-file-directory', file.path.slice(0, slash)));
          const badge = node('span', 'wrev-file-status', file.status === '?' ? 'A' : file.status || 'M'); badge.title = STATUS[file.status] || '修改';
          button.append(name, badge); button.addEventListener('click', () => void controller.select(file)); section.append(button);
        }
        list.append(section);
      }
      list.scrollTop = scroll;
      if (focused) Array.from(list.querySelectorAll('[data-review-key]')).find(el => el.dataset.reviewKey === focused)?.focus({ preventScroll: true });
    }
    function renderDiff(state) {
      const fingerprint = JSON.stringify([state.selectedKey, state.diff, state.diffLoading, state.diffError]); if (fingerprint === detailKey) return; detailKey = fingerprint;
      if (state.diffLoading) { empty(detail, 'loading-diff', '正在读取差异…'); return; }
      if (state.diffError) { empty(detail, 'diff-error', '无法读取这个文件', state.diffError, () => { const file = state.snapshot?.files.find(item => keyFor(item) === state.selectedKey); if (file) void controller.select(file); }); return; }
      const result = state.diff;
      if (!result) { empty(detail, 'select-file', '选择一个文件查看改动'); return; }
      const header = node('div', 'wrev-diff-heading'), filename = node('strong', 'wrev-diff-path', result.path); filename.title = result.path;
      const meta = node('div', 'wrev-diff-meta', stageLabel(result.stage)); totals(meta, result);
      header.append(filename, meta); if (result.oldPath && result.oldPath !== result.path) header.append(node('span', 'wrev-old-path', '原路径：' + result.oldPath));
      detail.replaceChildren(header);
      const output = node('div', 'wrev-diff-output'); output.dataset.reviewDiff = ''; detail.append(output);
      if (result.binary) { empty(output, 'binary', '二进制文件已更改', result.reason || '此文件无法显示逐行差异。'); return; }
      const parsed = parseUnifiedDiff(result.diff);
      if (result.truncated || parsed.truncated) { const warning = node('div', 'wrev-diff-warning', '改动较大，仅显示部分差异。'); warning.dataset.reviewTruncated = ''; detail.insertBefore(warning, output); }
      if (!parsed.lines.length) {
        empty(output, result.reason ? 'preview-unavailable' : 'no-text-diff', result.reason ? '暂未显示文本差异' : '没有文本差异', result.reason || '文件可能只有名称、权限或其他属性变化。'); return;
      }
      const scroll = node('div', 'wrev-diff-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', result.path + ' 的逐行差异');
      const code = node('div', 'wrev-diff-code'); code.dataset.reviewCode = '';
      const hasHunks = parsed.lines.some(line => line.kind === 'hunk');
      for (const line of parsed.lines) {
        if (hasHunks && line.kind === 'meta' && /^(?:diff --git |index |--- |\+\+\+ )/.test(line.text)) continue;
        const row = node('div', 'wrev-line is-' + line.kind); row.dataset.reviewLine = line.kind;
        const oldNumber = node('span', 'wrev-line-number', line.oldLine), newNumber = node('span', 'wrev-line-number', line.newLine);
        oldNumber.setAttribute('aria-hidden', 'true'); newNumber.setAttribute('aria-hidden', 'true');
        row.dataset.oldLine = line.oldLine == null ? '' : String(line.oldLine); row.dataset.newLine = line.newLine == null ? '' : String(line.newLine);
        const content = node('span', 'wrev-line-content'), marker = node('span', 'wrev-line-marker', line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ' '); marker.setAttribute('aria-hidden', 'true'); content.append(marker);
        if (['context', 'add', 'delete'].includes(line.kind)) for (const token of tokenizeLine(line.text)) content.append(node('span', token.kind ? 'wrev-token-' + token.kind : '', token.text));
        else content.append(doc.createTextNode(line.text));
        row.append(oldNumber, newNumber, content); code.append(row);
      }
      scroll.append(code); output.append(scroll);
    }
    function render(state) {
      if (disposed) return;
      const snapshot = state.snapshot, files = snapshot?.files || [];
      const nextFindingsKey = JSON.stringify(snapshot?.findings || null);
      if (nextFindingsKey !== findingsKey) {
        findingsKey = nextFindingsKey; findingsBox.replaceChildren();
        const findings = snapshot?.findings?.findings;
        findingsBox.hidden = !Array.isArray(findings);
        if (Array.isArray(findings)) {
          findingsBox.append(node('summary', '', `AI 审阅结果 · ${findings.length} 项`));
          for (const item of findings) {
            const row = node('article', 'wrev-finding');
            row.append(node('strong', '', item.shortSummary || item.summary), node('small', '', item.file + (item.line ? ':' + item.line : '')),
              node('p', '', item.scenario || item.summary));
            if (item.outcome) row.append(node('small', '', { fixed: '已修复', skipped: '已跳过', no_change_needed: '无需修改' }[item.outcome]));
            findingsBox.append(row);
          }
        }
      }
      refresh.disabled = state.loading; refresh.classList.toggle('is-loading', state.loading);
      page.setAttribute('aria-busy', String(state.loading));
      subtitle.textContent = snapshot?.kind === 'ready' ? [snapshot.branch || '未命名分支', files.length + ' 个改动' + (snapshot.truncated ? '（部分）' : '')].join(' · ') : '当前项目';
      subtitle.title = snapshot?.root || state.context?.workingDir || '';
      status.textContent = snapshot?.truncated ? '文件较多，仅列出部分改动。' : state.loading && snapshot ? '正在刷新…' : ''; status.hidden = !status.textContent;
      const available = snapshot?.kind === 'ready' && files.length > 0;
      body.classList.toggle('has-files', available); list.hidden = !available;
      if (available) { renderList(state); renderDiff(state); return; }
      listKey = ''; detailKey = ''; list.replaceChildren();
      if (state.loading) empty(detail, 'loading', '正在读取改动…');
      else if (state.error) empty(detail, 'error', '无法读取工作区改动', state.error, () => void controller.refresh());
      else if (snapshot?.kind === 'not-repository') empty(detail, 'not-repository', '这个目录还不是 Git 仓库', '在项目目录中使用 Git 后，可在这里查看文件改动。');
      else if (snapshot?.kind === 'unavailable') empty(detail, 'unavailable', '暂时无法审查', snapshot.message || '请先选择一个可用的项目目录。', () => void controller.refresh());
      else if (snapshot?.kind === 'ready') empty(detail, 'clean', '没有待审查的改动', '工作区与暂存区均没有变化。');
      else empty(detail, 'idle', '当前项目的改动会显示在这里');
    }
    controller = createController({ api, onChange: render });
    const onRefresh = () => void controller.refresh(); refresh.addEventListener('click', onRefresh);
    return {
      setContext: controller.setContext, setActive: controller.setActive, refresh: controller.refresh,
      destroy() { disposed = true; controller.destroy(); refresh.removeEventListener('click', onRefresh); mount.replaceChildren(); },
    };
  }
  return { create, createController, parseUnifiedDiff, tokenizeLine, groupFiles };
}));
