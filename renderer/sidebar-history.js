(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RelaySidebarHistory = api;
}(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const GROUPS = [
    ['pinned', '置顶'], ['today', '今天'], ['yesterday', '昨天'],
    ['week', '最近 7 天'], ['month', '最近 30 天'], ['earlier', '更早'],
  ];
  function groupItems(items, now = new Date(), projects = []) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const daysAgo = (days) => { const date = new Date(today); date.setDate(date.getDate() - days); return date.getTime(); };
    const groups = new Map(GROUPS.map(([id, label]) => [id, { id, label, items: [] }]));
    const projectGroups = new Map(projects.map(project => [project.id, { id: 'project-' + project.id, label: project.name, project, items: [] }]));
    const seen = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      if (item.projectId && projectGroups.has(item.projectId)) { projectGroups.get(item.projectId).items.push(item); continue; }
      const updated = Date.parse(item.updatedAt || item.createdAt || '');
      const key = item.pinned ? 'pinned' : updated >= today.getTime() ? 'today'
        : updated >= daysAgo(1) ? 'yesterday' : updated >= daysAgo(6) ? 'week'
          : updated >= daysAgo(29) ? 'month' : 'earlier';
      groups.get(key).items.push(item);
    }
    const pinnedProjects = [], regularProjects = [];
    for (const group of projectGroups.values()) {
      group.pinned = group.items.some(item => item.pinned);
      // Pinning changes presentation only; keep the supplied activity order
      // within each partition and never modify the conversation or project.
      group.items = [...group.items.filter(item => item.pinned), ...group.items.filter(item => !item.pinned)];
      (group.pinned ? pinnedProjects : regularProjects).push(group);
    }
    const pinRank = new Map([...seen].map((id, index) => [id, index]));
    pinnedProjects.sort((a, b) => pinRank.get(a.items[0].id) - pinRank.get(b.items[0].id));
    const pinned = groups.get('pinned');
    return [
      ...(pinned.items.length || pinnedProjects.length ? [pinned] : []),
      ...pinnedProjects, ...regularProjects,
      ...[...groups.values()].filter(group => group.id !== 'pinned' && group.items.length),
    ];
  }

  const PREVIEW_LIMIT = 5;
  const views = new WeakMap();
  function viewFor(container) {
    let view = views.get(container);
    if (view) return view;
    const doc = container.ownerDocument;
    view = { expanded: new Set(), buttons: new Map(), zones: {} };
    for (const [id, label] of [['pinned', '置顶'], ['projects', '项目'], ['recents', '历史对话']]) {
      const zone = doc.createElement('div');
      zone.className = 'history-zone'; zone.dataset.historyZone = id;
      zone.setAttribute('role', 'group'); zone.setAttribute('aria-label', label);
      view.zones[id] = zone; container.append(zone);
    }
    const heading = doc.getElementById('btnAddProject')?.closest('.projects-heading');
    if (heading) view.zones.projects.append(heading);
    for (const [zone, key] of [['pinned', 'pinned-projects'], ['projects', 'projects']]) {
      const list = doc.createElement('div');
      list.className = 'history-project-list'; list.dataset.projectList = key;
      list.id = `history-project-list-${key}`;
      view.zones[zone].append(list); view[key] = list;
    }
    views.set(container, view);
    return view;
  }
  function preview(view, host, nodes, key, label) {
    let button = view.buttons.get(key);
    if (!button) {
      button = host.ownerDocument.createElement('button');
      button.type = 'button'; button.className = 'history-show-more';
      button.dataset.expandKey = key;
      button.innerHTML = '<svg class="history-more-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg><span class="history-more-label"></span><span class="history-more-count" aria-hidden="true"></span><svg class="history-more-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
      view.buttons.set(key, button);
    }
    // Retain the same rows and controls when a project is promoted, expanded,
    // or refreshed. Running indicators and delegated actions stay attached.
    host.append(button);
    const apply = () => {
      const expanded = view.expanded.has(key);
      const active = host.ownerDocument.activeElement;
      nodes.forEach((node, index) => { node.hidden = !expanded && index >= PREVIEW_LIMIT; });
      button.hidden = nodes.length <= PREVIEW_LIMIT;
      if (!button.hidden && nodes.some(node => node.hidden && node.contains(active))) button.focus({ preventScroll: true });
      button.querySelector('.history-more-label').textContent = expanded ? '收起显示' : '展开显示';
      const remaining = Math.max(0, nodes.length - PREVIEW_LIMIT), count = button.querySelector('.history-more-count');
      count.hidden = expanded || !remaining;
      count.textContent = `+${remaining}`;
      button.title = expanded ? `收起${label}，显示前五项` : `查看其余 ${remaining} 项`;
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-controls', host.id);
      button.setAttribute('aria-label', expanded ? `收起${label}，显示前五项` : `展开显示全部 ${nodes.length} 个${label}`);
    };
    button.onclick = () => {
      if (view.expanded.has(key)) view.expanded.delete(key); else view.expanded.add(key);
      apply();
    };
    apply();
  }

  // Reuse existing rows, including running indicators and focused controls.
  // Grouping and expansion never save or retimestamp history records.
  function reconcile(container, items, { buildRow, updateRow, now, projects = [], projectHeader } = {}) {
    const doc = container.ownerDocument;
    const scrollTop = container.parentElement.scrollTop;
    const active = doc.activeElement;
    const restoreFocus = active && container.contains(active);
    const rows = new Map([...container.querySelectorAll('.history-item')].map(row => [row.dataset.id, row]));
    const sections = new Map([...container.querySelectorAll('.history-group')].map(section => [section.dataset.historyGroup, section]));
    const groups = groupItems(items, now, projects), view = viewFor(container);
    const keepRows = new Set(), keepSections = new Set();
    const pinnedProjects = [], regularProjects = [];
    const anchors = new Map();
    const place = (host, node) => {
      const anchor = anchors.has(host) ? anchors.get(host) : host.firstChild;
      if (node !== anchor) host.insertBefore(node, anchor);
      anchors.set(host, node.nextSibling);
    };
    const empty = container.querySelector('.history-empty');
    if (groups.length && empty) empty.remove();
    for (const group of groups) {
      keepSections.add(group.id);
      let section = sections.get(group.id);
      if (!section) {
        section = doc.createElement('section');
        section.className = 'history-group'; section.dataset.historyGroup = group.id;
        const heading = doc.createElement('h3');
        heading.className = 'history-group-heading'; heading.id = `history-group-${group.id}`;
        heading.textContent = group.label; section.setAttribute('aria-labelledby', heading.id);
        const body = doc.createElement('div'); body.className = 'history-group-items';
        body.id = `history-items-${group.id}`; section.append(heading, body);
      }
      const host = group.project ? view[group.pinned ? 'pinned-projects' : 'projects']
        : view.zones[group.id === 'pinned' ? 'pinned' : 'recents'];
      place(host, section);
      section.hidden = false;
      if (group.project) {
        section.dataset.projectPinned = String(group.pinned);
        (group.pinned ? pinnedProjects : regularProjects).push(section);
        if (projectHeader) projectHeader(section, group.project);
      }
      const body = section.querySelector('.history-group-items'), groupRows = [];
      for (const item of group.items) {
        keepRows.add(item.id);
        let row = rows.get(item.id);
        if (row) updateRow(row, item); else row = buildRow(item);
        row.hidden = false; place(body, row); groupRows.push(row);
      }
      if (group.project) preview(view, body, groupRows, group.id, group.label + '中的对话');
    }
    for (const [id, row] of rows) if (!keepRows.has(id)) row.remove();
    for (const [id, section] of sections) if (!keepSections.has(id)) section.remove();
    for (const [key, button] of view.buttons) {
      if (key.startsWith('project-') && !keepSections.has(key)) {
        button.remove(); view.buttons.delete(key); view.expanded.delete(key);
      }
    }
    preview(view, view['pinned-projects'], pinnedProjects, 'pinned-projects', '置顶项目');
    preview(view, view.projects, regularProjects, 'projects', '项目');
    view['pinned-projects'].hidden = !pinnedProjects.length;
    view.zones.pinned.hidden = !groups.some(group => group.id === 'pinned');
    view.zones.recents.hidden = !groups.some(group => !group.project && group.id !== 'pinned');
    if (!groups.length && !empty) {
      const node = doc.createElement('div'); node.className = 'history-empty';
      node.textContent = '还没有对话，从新对话开始吧'; container.append(node);
    }
    if (restoreFocus && active.isConnected && !active.closest('[hidden]') && doc.activeElement !== active) active.focus({ preventScroll: true });
    container.parentElement.scrollTop = scrollTop;
  }
  return { groupItems, reconcile };
}));
