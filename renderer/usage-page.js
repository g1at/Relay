(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.relayUsagePage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const RANGES = [7, 30, 90];
  const memories = new WeakMap();
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const range = value => RANGES.includes(Number(value)) ? Number(value) : 30;
  const TOKEN_PARTS = [
    { key: 'inputTokens', label: '未缓存输入', tone: 'blue' }, { key: 'outputTokens', label: '输出', tone: 'purple' },
    { key: 'cacheCreationTokens', label: '缓存创建', tone: 'amber' }, { key: 'cacheReadTokens', label: '缓存读取', tone: 'green' },
  ];
  const TOKEN_CARDS = TOKEN_PARTS.map(part => part.key === 'inputTokens'
    ? { ...part, key: 'inputTotalTokens', label: '输入（含缓存）' }
    : part.key === 'cacheCreationTokens' ? { ...part, key: 'cacheHitRate', label: '缓存命中率' } : part);
  function formatPercent(value) {
    return number(value) === null || value > 1 ? '—' : (value * 100).toFixed(1).replace(/\.0$/, '') + '%';
  }
  function formatNumber(value) {
    if (number(value) === null) return '—';
    if (value < 1000) return value.toLocaleString('zh-CN');
    const scale = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : 1e3;
    return (value / scale).toFixed(value / scale < 10 ? 1 : 0).replace(/\.0$/, '') + (scale === 1e9 ? 'B' : scale === 1e6 ? 'M' : 'K');
  }
  function formatFullNumber(value) {
    return number(value) === null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 20 });
  }
  function normalizeSnapshot(raw, days) {
    if (!raw || raw.ok === false || raw.available === false || raw.hasSnapshot === false || raw.ready === false || Number(raw.days) !== days || !raw.totals) return null;
    const daily = Array.isArray(raw.daily) ? raw.daily.filter(item => item && /^\d{4}-\d{2}-\d{2}$/.test(item.date)).map(item => ({ date: item.date, count: number(item.count) })) : [];
    const tokens = raw.tokens || {}, knownTokens = tokens.available === true;
    const components = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'].map(key => number(tokens[key]));
    const inputParts = [components[0], components[2], components[3]];
    const inputTotal = knownTokens && inputParts.every(value => value !== null) ? inputParts.reduce((a, b) => a + b, 0) : null;
    const cacheHitRate = inputTotal > 0 && Number.isFinite(inputTotal) ? components[2] / inputTotal : null;
    const tokenTotal = knownTokens ? number(tokens.totalTokens) ?? (components.every(value => value !== null) ? components.reduce((a, b) => a + b, 0) : null) : null;
    const models = knownTokens && Array.isArray(tokens.byModel) ? tokens.byModel.filter(item => item && typeof item.key === 'string' && number(item.count) !== null && item.count > 0).map(item => ({ name: item.key, count: item.count,
      ...(TOKEN_PARTS.every(part => number(item[part.key]) !== null) ? { components: TOKEN_PARTS.map(part => number(item[part.key])) } : {}),
    })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) : [];
    const tokenDaily = knownTokens && Array.isArray(tokens.daily) ? tokens.daily.filter(item => item && typeof item.date === 'string').map(item => ({ date: item.date, totalTokens: number(item.totalTokens),
      ...Object.fromEntries(TOKEN_PARTS.map(part => [part.key, number(item[part.key])])),
    })) : [];
    return {
      days, generatedAt: typeof raw.generatedAt === 'string' && Number.isFinite(Date.parse(raw.generatedAt)) ? raw.generatedAt : null,
      tokenCoverage: tokens.coverage || 'unknown', historyCoverage: raw.coverage?.history || 'unknown',
      messages: number(raw.totals.messages),
      activeDays: daily.length === days && daily.every(item => item.count !== null) ? daily.filter(item => item.count > 0).length : null,
      daily, tokenTotal, models, tokenDaily, cacheHitRate, inputTotalTokens: inputTotal,
      inputTokens: knownTokens ? components[0] : null, outputTokens: knownTokens ? components[1] : null,
      cacheReadTokens: knownTokens ? components[2] : null, cacheCreationTokens: knownTokens ? components[3] : null,
      cacheTokens: knownTokens && components[2] !== null && components[3] !== null ? components[2] + components[3] : null,
    };
  }
  function buildActivityHeatmap(snapshot, mode = 'messages') {
    const days = range(snapshot?.days), daily = snapshot?.daily || [];
    const records = new Map();
    for (const item of daily) {
      if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) continue;
      const time = Date.parse(item.date + 'T00:00:00Z');
      if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== item.date) continue;
      // Missing or duplicate dates are unknown; neither is evidence of zero activity.
      records.set(item.date, records.has(item.date) ? null : number(item.count));
    }
    const dates = [...records.keys()].sort(), end = dates.at(-1);
    if (!end) return { days, state: snapshot ? 'unknown' : 'pending', cells: [], columns: 0, leading: 0, peak: 0 };
    const start = Date.parse(end + 'T00:00:00Z') - (days - 1) * 86400000;
    const tokenRecords = new Map();
    if (mode === 'tokens') for (const item of snapshot?.tokenDaily || []) tokenRecords.set(item.date, tokenRecords.has(item.date) ? null : number(item.totalTokens));
    const values = mode === 'tokens' ? tokenRecords : records;
    const cells = Array.from({ length: days }, (_, index) => {
      const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
      return { date, count: values.get(date) ?? null };
    });
    const peak = Math.max(0, ...cells.map(item => item.count ?? 0));
    for (const item of cells) item.level = item.count === null ? null : item.count === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(item.count / peak * 4)));
    const leading = (new Date(start).getUTCDay() + 6) % 7;
    return { days, state: cells.some(item => item.count === null) ? 'unknown' : peak ? 'ready' : 'empty', cells, leading, columns: Math.ceil((leading + days) / 7), peak };
  }
  function buildTrendSeries(snapshot, mode = 'tokens') {
    const days = buildActivityHeatmap(snapshot).cells;
    if (mode === 'messages') return days.map(day => ({ date: day.date, value: day.count }));
    const records = new Map();
    for (const item of snapshot?.tokenDaily || []) records.set(item.date, records.has(item.date) ? null : item);
    return days.map(day => ({ date: day.date, value: number(records.get(day.date)?.totalTokens), ...Object.fromEntries(TOKEN_PARTS.map(part => [part.key, number(records.get(day.date)?.[part.key])])) }));
  }
  function getRecordedTokenPeak(snapshot) {
    // Use the same dated records as the Token trend; totals cannot establish a daily peak.
    const series = buildTrendSeries(snapshot, 'tokens'), recorded = series.filter(day => day.value !== null);
    const peak = recorded.reduce((best, day) => !best || day.value >= best.value ? day : best, null);
    return { value: peak?.value ?? null, date: peak?.date ?? null, recordedDays: recorded.length, days: range(snapshot?.days) };
  }
  function buildTrendGeometry(points, width = 640, height = 138) {
    const known = points.filter(point => number(point.value) !== null), peak = Math.max(0, ...known.map(point => point.value)), max = peak || 1;
    const positioned = points.map((point, index) => ({ ...point, x: points.length > 1 ? index / (points.length - 1) * width : width / 2, y: number(point.value) === null ? null : height - point.value / max * height }));
    const segments = []; let current = [];
    const flush = () => { if (current.length) { const path = current.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' '); segments.push({ path, area: path + ` L${current.at(-1).x.toFixed(2)},${height} L${current[0].x.toFixed(2)},${height} Z` }); current = []; } };
    for (const point of positioned) { if (point.y === null) flush(); else current.push(point); } flush();
    return { points: positioned, segments, max, known: known.length };
  }
  function createController({ api, onChange = () => {}, days, schedule = root.setTimeout.bind(root), cancel = root.clearTimeout.bind(root) }) {
    if (!api || typeof api.overview !== 'function') throw new Error('用量统计接口尚未就绪');
    let memory = memories.get(api);
    if (!memory) { memory = { days: 30, snapshots: new Map() }; memories.set(api, memory); }
    const selected = range(days == null ? memory.days : days);
    let state = { days: selected, snapshot: memory.snapshots.get(selected) || null, pending: false, slow: false, stale: false, error: null };
    let disposed = false, revision = 0, timer = null;
    const emit = () => { if (!disposed) onChange({ ...state }); };
    async function refresh(force = false) {
      if (disposed) return;
      const own = ++revision, requested = state.days;
      cancel(timer); state = { ...state, pending: true, slow: false, error: null }; emit();
      timer = schedule(() => { if (own === revision && !disposed) { state = { ...state, slow: true }; emit(); } }, 1500);
      try {
        const result = await api.overview(requested, { refresh: force });
        if (disposed || own !== revision) return;
        const snapshot = normalizeSnapshot(result, requested);
        if (snapshot) memory.snapshots.set(requested, snapshot);
        const error = result?.error || (result?.ok === false ? '暂时无法更新统计' : null);
        state = { ...state, snapshot: snapshot || state.snapshot, pending: !!result?.refreshing, stale: !!result?.stale, error: error ? String(error.message || error) : null, slow: false };
        if (!snapshot && !state.pending && !state.error) state.error = '暂时无法读取统计';
      } catch (_) {
        if (disposed || own !== revision) return;
        state = { ...state, pending: false, slow: false, error: '暂时无法更新统计' };
      } finally { if (!disposed && own === revision) { if (!state.pending) { cancel(timer); timer = null; } emit(); } }
    }
    function setRange(value) {
      const next = range(value);
      if (next === state.days || disposed) return;
      memory.days = next;
      state = { ...state, days: next, snapshot: memory.snapshots.get(next) || state.snapshot, error: null, stale: false };
      refresh();
    }
    const unsubscribe = typeof api.onUpdated === 'function' ? api.onUpdated(() => refresh()) : null;
    emit();
    return { refresh, setRange, getState: () => ({ ...state }), destroy() { disposed = true; revision++; cancel(timer); if (typeof unsubscribe === 'function') unsubscribe(); } };
  }
  function create({ mount, api, days, profile = false } = {}) {
    if (!mount) throw new Error('用量页面缺少容器');
    if (mount._relayUsage) return mount._relayUsage;
    const doc = mount.ownerDocument;
    const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const page = element('section', 'relay-usage-page' + (profile ? ' is-profile' : '')); page.setAttribute('aria-label', profile ? '对话活动与模型用量' : '用量');
    page.innerHTML = `<header class="rup-heading"><div><h2>使用统计</h2><p>了解你与 Relay 的日常协作。</p></div><div class="rup-ranges" role="group" aria-label="统计时间范围">${RANGES.map(value => `<button type="button" data-usage-days="${value}" aria-pressed="false">${value} 天</button>`).join('')}</div></header>
      <div class="rup-meta"><span data-usage-range>近 30 天</span><div class="rup-refresh-state"><span data-usage-status role="status" aria-live="polite">后台统计中</span><button type="button" class="rup-refresh" data-usage-refresh title="刷新用量统计" aria-label="刷新用量统计"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.34 5.66"/></svg><span>刷新</span></button></div></div>
      <section class="rup-overview" aria-label="用量概览"><div class="rup-metrics"><article class="rup-metric rup-metric-primary"><h3><span class="rup-token-symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m13 2-9 12h7l-1 8 10-13h-7z"/></svg></span>已记录 Token</h3><strong data-usage-metric="tokens">—</strong><p>输入（含缓存）与输出总量</p></article><article class="rup-metric"><h3><i class="rup-dot is-purple" aria-hidden="true"></i>对话轮次</h3><strong data-usage-metric="messages">—</strong><p>每次发送计为一轮</p></article><article class="rup-metric"><h3><i class="rup-dot is-green" aria-hidden="true"></i>活跃天数</h3><strong data-usage-metric="active">—</strong><p>有对话的日子</p></article><article class="rup-metric"><h3><i class="rup-dot is-amber" aria-hidden="true"></i>单日峰值 Token</h3><strong data-usage-metric="peak">—</strong><p data-usage-peak-detail>尚无每日记录</p></article></div>
      <div class="rup-token-breakdown">${TOKEN_CARDS.map(part => `<article class="rup-token-part is-${part.tone}"><h4><i class="rup-dot is-${part.tone}" aria-hidden="true"></i>${part.label}</h4><strong data-usage-part="${part.key}">—</strong></article>`).join('')}</div><div class="rup-token-composition" data-usage-composition aria-hidden="true"></div></section>
      <section class="rup-section rup-flow"${profile ? '' : ' hidden'}><header><div><h3>使用趋势</h3><span class="rup-flow-caption" data-usage-flow-caption>每日已记录 Token</span></div><div class="rup-trend-modes" role="group" aria-label="趋势统计类型"><button type="button" data-usage-trend-mode="tokens" aria-pressed="true">Token</button><button type="button" data-usage-trend-mode="messages" aria-pressed="false">对话</button></div></header><div class="rup-flow-body"><div class="rup-flow-scale" data-usage-flow-scale aria-hidden="true"></div><div class="rup-flow-plot" data-usage-trend-chart tabindex="0" aria-label="每日用量趋势"><p class="rup-chart-empty">统计完成后显示趋势</p></div></div><div class="rup-axis rup-flow-axis" data-usage-flow-axis aria-hidden="true"></div><div class="rup-flow-detail" data-usage-flow-detail role="status" aria-live="polite"></div></section>
      <section class="rup-section rup-trend"><header><h3>每日对话</h3><span data-usage-trend-caption>对话轮次</span></header><div class="rup-chart" data-usage-chart><p class="rup-chart-empty">正在整理本地记录</p></div><div class="rup-axis" data-usage-axis aria-hidden="true"><span>—</span><span>—</span><span>—</span></div></section>
      <section class="rup-section rup-models"><header><h3>模型用量</h3><span>已记录 Token</span></header><div class="rup-model-list" data-usage-models tabindex="0" role="region" aria-label="全部模型用量"><p class="rup-empty">统计完成后显示模型明细</p></div><p class="rup-token-detail" data-usage-token-detail hidden></p></section>
      `;
    mount.replaceChildren(page);
    const q = selector => page.querySelector(selector), buttons = [...page.querySelectorAll('[data-usage-days]')];
    const status = q('[data-usage-status]'), refreshButton = q('[data-usage-refresh]'), chart = q('[data-usage-chart]'), axis = q('[data-usage-axis]'), models = q('[data-usage-models]');
    if (profile) {
      const heading = q('.rup-heading'), meta = q('.rup-meta');
      heading.firstElementChild.remove(); heading.prepend(meta);
      const panels = element('div', 'rup-profile-panels');
      panels.append(q('.rup-trend'), q('.rup-models')); page.append(panels);
      chart.classList.add('rup-heatmap');
      const calendar = element('div', 'rup-calendar'), weekdays = element('div', 'rup-calendar-weekdays'), body = element('div', 'rup-calendar-body');
      weekdays.setAttribute('aria-hidden', 'true');
      for (const day of ['一', '', '三', '', '五', '', '日']) weekdays.append(element('span', '', day));
      body.append(chart, axis); calendar.append(weekdays, body); q('.rup-trend').append(calendar);
      const legend = element('div', 'rup-heatmap-legend'); legend.setAttribute('aria-hidden', 'true'); legend.append(element('span', '', '少'));
      for (let level = 0; level <= 4; level++) { const swatch = element('i', 'rup-heatmap-cell'); swatch.dataset.level = String(level); legend.append(swatch); }
      legend.append(element('span', '', '多')); q('.rup-trend').append(legend);
      const note = element('p', 'rup-heatmap-note'); note.dataset.usageActivityNote = ''; note.hidden = true; q('.rup-trend').append(note);
      q('[data-usage-trend-caption]').textContent = '每格一天 · 对话轮次';
    }
    let lastSnapshot = undefined, controller, trendMode = 'auto', trendPoints = [], trendIndex = -1;
    const metric = (id, value) => { const node = q(`[data-usage-metric="${id}"]`), full = formatFullNumber(value); node.textContent = full; node.title = value === null ? '尚无可用记录' : full; node.style.setProperty('--rup-value-length', String(full.length)); };
    const date = value => value ? value.slice(5).replace(/^0/, '').replace(/-0?/, '/') : '—';
    function renderTokenParts(snapshot) {
      const composition = q('[data-usage-composition]'); composition.replaceChildren();
      const values = TOKEN_PARTS.map(part => number(snapshot?.[part.key])), complete = values.every(value => value !== null), total = complete ? values.reduce((sum, value) => sum + value, 0) : 0;
      composition.dataset.state = !complete ? 'unknown' : total ? 'ready' : 'empty';
      for (const part of TOKEN_CARDS) {
        const output = q(`[data-usage-part="${part.key}"]`), value = number(snapshot?.[part.key]);
        if (part.key === 'cacheHitRate') {
          output.textContent = formatPercent(value);
          output.title = value === null ? '尚无可用的输入 Token 记录' : `缓存命中率 ${formatPercent(value)}\n缓存读取 Token ÷ 输入（含缓存）Token，不包含输出；按所选时间范围已记录用量计算。`;
        } else {
          output.textContent = formatNumber(value); output.title = value === null ? '尚未记录' : value.toLocaleString('zh-CN') + ' Token';
          if (value !== null && part.key === 'inputTotalTokens') output.title +=
            '\n未缓存输入 ' + formatFullNumber(snapshot.inputTokens) + ' + 缓存创建 ' + formatFullNumber(snapshot.cacheCreationTokens)
            + ' + 缓存读取 ' + formatFullNumber(snapshot.cacheReadTokens) + '；缓存已包含在输入和总量中。';
          else if (value !== null && part.key === 'outputTokens') output.title +=
            '\n多次模型调用累计的输出 Token，不等于最终回答字数；以服务商返回的用量为准。';
          else if (value !== null && part.key === 'cacheReadTokens') output.title +=
            '\n输入（含缓存）中的缓存读取部分，已包含在输入和总量中。';
        }
        output.closest('.rup-token-part').title = output.title;
      }
      // The rate is a derived metric, never a Token component. Keep the actual
      // cache-write counters in totals, daily trends and model composition.
      TOKEN_PARTS.forEach((part, index) => {
        const value = values[index];
        if (complete && total > 0 && value > 0) { const fill = element('span', 'rup-component is-' + part.tone); fill.style.width = value / total * 100 + '%'; composition.append(fill); }
      });
    }
    function svgElement(tag, attributes) {
      const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, String(value));
      return node;
    }
    function showTrendPoint(index) {
      if (!profile || !trendPoints.length) return;
      const next = Math.max(0, Math.min(trendPoints.length - 1, index)); if (next === trendIndex) return;
      trendIndex = next;
      const point = trendPoints[trendIndex], plot = q('[data-usage-trend-chart]'), detail = q('[data-usage-flow-detail]'), cursor = plot.querySelector('.rup-flow-cursor'), dot = plot.querySelector('.rup-flow-dot');
      plot.dataset.selectedDate = point.date;
      if (cursor) { cursor.setAttribute('x1', point.x); cursor.setAttribute('x2', point.x); cursor.style.opacity = '1'; }
      if (dot) { dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y ?? 0); dot.style.opacity = point.y === null ? '0' : '1'; }
      const mode = plot.dataset.mode;
      detail.replaceChildren(element('strong', '', date(point.date)), element('span', '', point.value === null ? '未记录' : formatNumber(point.value) + (mode === 'tokens' ? ' Token' : ' 轮对话')));
      if (mode === 'tokens' && point.value !== null) for (const part of TOKEN_PARTS) {
        if (point[part.key] === null) continue;
        const item = element('span', 'rup-flow-value'); item.append(element('i', 'rup-dot is-' + part.tone), doc.createTextNode(part.label + ' ' + formatNumber(point[part.key]))); detail.append(item);
      }
    }
    function renderFlow(snapshot) {
      if (!profile) return;
      const plot = q('[data-usage-trend-chart]'), scale = q('[data-usage-flow-scale]'), labels = q('[data-usage-flow-axis]'), detail = q('[data-usage-flow-detail]');
      const hasTokens = snapshot?.tokenDaily?.some(item => number(item.totalTokens) !== null);
      const mode = trendMode === 'auto' ? snapshot && !hasTokens ? 'messages' : 'tokens' : trendMode;
      page.dataset.usageMode = mode; renderActivity(snapshot, mode);
      const points = buildTrendSeries(snapshot, mode), geometry = buildTrendGeometry(points);
      trendPoints = geometry.points; trendIndex = -1;
      plot.dataset.mode = mode; plot.dataset.state = !snapshot ? 'pending' : geometry.known ? 'ready' : 'unknown'; delete plot.dataset.selectedDate;
      plot.setAttribute('aria-label', `近 ${snapshot?.days || 30} 天${mode === 'tokens' ? '已记录 Token' : '对话轮次'}趋势，使用左右方向键查看日期`);
      q('[data-usage-flow-caption]').textContent = mode === 'tokens' ? '每日已记录 Token' : '每日对话轮次';
      page.querySelectorAll('[data-usage-trend-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.usageTrendMode === mode)));
      plot.replaceChildren(); scale.replaceChildren(); labels.replaceChildren(); detail.replaceChildren();
      for (const index of [0, Math.floor(points.length / 2), points.length - 1]) labels.append(element('span', '', date(points[index]?.date)));
      if (!geometry.known) { plot.append(element('p', 'rup-chart-empty', !snapshot ? '统计完成后显示趋势' : mode === 'tokens' ? '尚未记录每日 Token 用量' : '尚无可用的每日记录')); return; }
      for (const value of [geometry.max, geometry.max / 2, 0]) scale.append(element('span', '', formatNumber(mode === 'messages' ? Math.round(value) : value)));
      const svg = svgElement('svg', { viewBox: '0 0 640 144', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      for (const y of [3, 72, 141]) svg.append(svgElement('line', { x1: 0, y1: y, x2: 640, y2: y, class: 'rup-flow-grid' }));
      const group = svgElement('g', { transform: 'translate(0 3)' });
      for (const segment of geometry.segments) group.append(svgElement('path', { d: segment.area, class: 'rup-flow-area' }));
      for (const segment of geometry.segments) group.append(svgElement('path', { d: segment.path, class: 'rup-flow-line' }));
      for (const point of geometry.points) if (point.y !== null) group.append(svgElement('circle', { cx: point.x, cy: point.y, r: points.length < 10 ? 2.6 : 1.5, class: 'rup-flow-point', 'data-usage-trend-point': point.date, 'data-usage-count': point.value }));
      group.append(svgElement('line', { x1: 0, x2: 0, y1: 0, y2: 138, class: 'rup-flow-cursor' }), svgElement('circle', { cx: 0, cy: 0, r: 3.5, class: 'rup-flow-dot' }));
      svg.append(group); plot.append(svg);
      const peak = geometry.points.reduce((current, point) => (point.value ?? -1) > (current?.value ?? -1) ? point : current, null);
      detail.append(element('span', '', peak ? `单日最高 ${formatNumber(peak.value)}${mode === 'tokens' ? ' Token' : ' 轮'} · ${date(peak.date)}` : ''));
      if (geometry.known < points.length) detail.append(element('span', 'rup-flow-unknown', '空白日期未记录'));
    }
    function renderModels(snapshot) {
      const scroll = models.scrollTop; models.replaceChildren();
      const rows = snapshot?.models || [];
      if (!rows.length) { models.append(element('p', 'rup-empty', snapshot?.tokenTotal === 0 ? '这段时间尚无 Token 记录' : snapshot ? '尚未记录模型用量' : '统计完成后显示模型明细')); return; }
      const max = rows[0].count;
      for (const row of rows) {
        const item = element('div', 'rup-model-row'); item.dataset.usageModel = row.name;
        const label = element('span', 'rup-model-name', row.name.split('/').filter(Boolean).at(-1) || row.name); label.title = row.name;
        const total = element('span', 'rup-model-total', formatNumber(row.count)); total.title = row.count.toLocaleString('zh-CN') + ' Token';
        if (snapshot.tokenTotal > 0 && row.count <= snapshot.tokenTotal) total.append(element('span', 'rup-model-share', (row.count / snapshot.tokenTotal * 100).toFixed(1).replace(/\.0$/, '') + '%'));
        const bar = element('span', 'rup-model-track'), fill = element('span', 'rup-model-fill'); bar.setAttribute('aria-hidden', 'true'); fill.style.width = (row.count / max * 100) + '%'; bar.append(fill);
        if (row.components && row.components.reduce((sum, value) => sum + value, 0) === row.count) for (let index = 0; index < TOKEN_PARTS.length; index++) {
          const part = element('span', 'rup-component is-' + TOKEN_PARTS[index].tone); part.style.width = row.components[index] / row.count * 100 + '%'; fill.append(part);
        }
        item.append(label, total, bar); models.append(item);
      }
      models.scrollTop = scroll;
    }
    function renderActivity(snapshot, mode = 'messages') {
      chart.replaceChildren(); axis.replaceChildren();
      const daily = snapshot?.daily || [], countsKnown = daily.length > 0 && daily.every(item => item.count !== null), peak = countsKnown ? Math.max(...daily.map(item => item.count)) : 0;
      const isTokens = mode === 'tokens';
      chart.dataset.usageMode = mode; q('.rup-trend').dataset.usageHeatmapMode = mode;
      q('.rup-trend h3').textContent = isTokens ? '每日 Token' : '每日对话';
      chart.setAttribute('role', 'img'); chart.setAttribute('aria-label', snapshot ? `近 ${snapshot.days} 天${isTokens ? '每日已记录 Token' : '每日对话轮次'}` : '每日记录正在统计');
      if (profile) {
        const activity = buildActivityHeatmap(snapshot, mode);
        q('[data-usage-trend-caption]').textContent = isTokens ? '每格一天 · 已记录 Token' : '每格一天 · 对话轮次';
        chart.dataset.usageChartState = activity.state;
        chart.style.setProperty('--rup-heatmap-weeks', String(Math.max(1, activity.columns)));
        q('.rup-calendar').classList.toggle('is-empty', !activity.cells.length);
        if (!activity.cells.length) chart.append(element('p', 'rup-chart-empty', snapshot ? '尚无可用的每日记录' : '正在整理本地记录'));
        else {
          for (let index = 0; index < activity.leading; index++) { const blank = element('span', 'rup-heatmap-blank'); blank.setAttribute('aria-hidden', 'true'); chart.append(blank); }
          for (const item of activity.cells) {
            const cell = element('span', 'rup-heatmap-cell'); cell.dataset.usageDate = item.date; cell.dataset.usageCount = item.count === null ? '' : String(item.count); cell.dataset.level = item.level === null ? 'unknown' : String(item.level);
            cell.title = `${item.date} · ${item.count === null ? '未记录' : item.count.toLocaleString('zh-CN') + (isTokens ? ' Token' : ' 轮对话')}`; cell.setAttribute('aria-hidden', 'true'); chart.append(cell);
          }
        }
        const note = q('[data-usage-activity-note]');
        note.hidden = !activity.cells.length || !['unknown', 'empty'].includes(activity.state);
        note.textContent = activity.state === 'empty' ? isTokens ? '这段时间已记录 Token 为 0' : '这段时间还没有对话' : '虚线方格表示该日期没有可用记录';
        for (const index of [0, activity.cells.length - 1]) axis.append(element('span', '', date(activity.cells[index]?.date)));
      } else {
        chart.dataset.usageChartState = !snapshot ? 'pending' : !countsKnown ? 'unknown' : peak ? 'ready' : 'empty';
        if (!countsKnown || !peak) chart.append(element('p', 'rup-chart-empty', !snapshot ? '正在整理本地记录' : !countsKnown ? '尚无可用的每日记录' : '这段时间还没有对话'));
        else for (const item of daily) {
          const column = element('div', 'rup-bar-column'); column.title = `${item.date} · ${item.count} 轮`; column.setAttribute('aria-hidden', 'true');
          const bar = element('span', 'rup-bar'); bar.style.height = (item.count / peak * 100) + '%'; column.append(bar); chart.append(column);
        }
        for (const index of [0, Math.floor(daily.length / 2), daily.length - 1]) axis.append(element('span', '', date(daily[index]?.date)));
      }
    }
    function renderSnapshot(snapshot) {
      metric('messages', snapshot?.messages ?? null); metric('tokens', snapshot?.tokenTotal ?? null); metric('active', snapshot?.activeDays ?? null);
      const peak = getRecordedTokenPeak(snapshot); metric('peak', peak.value);
      const peakValue = q('[data-usage-metric=peak]'), peakDetail = q('[data-usage-peak-detail]');
      peakValue.dataset.usagePeakDate = peak.date || '';
      peakDetail.textContent = peak.date ? `${date(peak.date)} · ${peak.recordedDays < peak.days ? '已记录峰值' : '单日最高'}` : '尚无每日记录';
      peakValue.title = peak.date ? `${peak.date} · ${formatFullNumber(peak.value)} Token${peak.recordedDays < peak.days ? `（近 ${peak.days} 天中有 ${peak.recordedDays} 天记录）` : ''}` : '尚无可用的每日 Token 记录';
      renderTokenParts(snapshot);
      if (profile) renderFlow(snapshot); else renderActivity(snapshot);
      const details = q('[data-usage-token-detail]');
      details.hidden = !(snapshot?.models || []).some(model => model.components); details.replaceChildren();
      for (const part of TOKEN_PARTS) { const item = element('span', 'rup-model-legend'); item.append(element('i', 'rup-dot is-' + part.tone), doc.createTextNode(part.label)); details.append(item); }
      renderModels(snapshot);
    }
    function render(state) {
      const { snapshot } = state, displayedDays = snapshot?.days || state.days;
      page.dataset.usageState = state.error ? 'error' : state.pending ? 'refreshing' : snapshot ? 'ready' : 'pending';
      page.dataset.usageDays = String(state.days); page.dataset.usageDisplayedDays = String(displayedDays);
      buttons.forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.usageDays) === state.days)));
      q('[data-usage-range]').textContent = `近 ${displayedDays} 天`;
      const mismatch = snapshot && displayedDays !== state.days;
      status.textContent = state.error ? (snapshot ? '更新失败，保留已有统计' : '暂时无法读取统计') : mismatch ? `正在获取近 ${state.days} 天` : state.slow ? '仍在后台统计，可继续使用 Relay' : state.pending ? (snapshot ? '正在更新' : '后台统计中') : state.stale ? '显示最近一次统计' : snapshot?.historyCoverage === 'partial' ? '部分记录暂不可用' : '已更新';
      status.title = snapshot?.generatedAt ? `最近统计：${new Date(snapshot.generatedAt).toLocaleString('zh-CN')}` : '';
      refreshButton.querySelector('span').textContent = state.error || state.slow ? '重试' : '刷新';
      if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; renderSnapshot(snapshot); }
    }
    controller = createController({ api, days, onChange: render });
    buttons.forEach(button => button.addEventListener('click', () => controller.setRange(button.dataset.usageDays)));
    q('.rup-ranges').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const position = buttons.indexOf(doc.activeElement); if (position < 0) return;
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (position + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus(); buttons[next].click();
    });
    refreshButton.addEventListener('click', () => controller.refresh(true));
    page.querySelectorAll('[data-usage-trend-mode]').forEach(button => button.addEventListener('click', () => { trendMode = button.dataset.usageTrendMode; renderFlow(controller.getState().snapshot); }));
    const trendPlot = q('[data-usage-trend-chart]');
    trendPlot.addEventListener('pointermove', event => { if (!trendPoints.length) return; const bounds = trendPlot.getBoundingClientRect(); showTrendPoint(Math.round((event.clientX - bounds.left) / Math.max(1, bounds.width) * (trendPoints.length - 1))); });
    trendPlot.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !trendPoints.length) return;
      event.preventDefault(); showTrendPoint(event.key === 'Home' ? 0 : event.key === 'End' ? trendPoints.length - 1 : trendIndex < 0 ? trendPoints.length - 1 : trendIndex + (event.key === 'ArrowLeft' ? -1 : 1));
    });
    const manager = { refresh: () => controller.refresh(), setRange: controller.setRange, destroy() { controller.destroy(); if (mount._relayUsage === manager) delete mount._relayUsage; } };
    mount._relayUsage = manager; controller.refresh(); return manager;
  }
  return { create, createController, normalizeSnapshot, formatNumber, formatFullNumber, formatPercent, buildActivityHeatmap, buildTrendSeries, buildTrendGeometry, getRecordedTokenPeak };
});
