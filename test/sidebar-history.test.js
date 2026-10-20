'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { groupItems } = require('../renderer/sidebar-history');
const freeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

test('history hierarchy separates pinned items and local calendar periods without changing records', () => {
  const items = Object.freeze([
    Object.freeze({ id: 'pinned-old', title: 'keep full title', pinned: true, updatedAt: '2026-01-01' }),
    Object.freeze({ id: 'today', updatedAt: new Date(2026, 8, 7, 0, 0).toISOString() }),
    Object.freeze({ id: 'yesterday', updatedAt: new Date(2026, 8, 6, 23, 59).toISOString() }),
    Object.freeze({ id: 'week', updatedAt: new Date(2026, 8, 2, 12).toISOString() }),
    Object.freeze({ id: 'month', updatedAt: new Date(2026, 7, 25, 12).toISOString() }),
    Object.freeze({ id: 'earlier', updatedAt: '2026-01-01' }),
  ]);
  const before = JSON.stringify(items);
  const groups = groupItems(items, new Date(2026, 8, 7, 17));
  assert.deepEqual(groups.map(group => group.id), ['pinned', 'today', 'yesterday', 'week', 'month', 'earlier']);
  assert.equal(groups[0].items[0], items[0]);
  assert.equal(JSON.stringify(items), before);
});

test('group decoration preserves within-group server order and does not split long titles', () => {
  const title = '审阅项目资料和历史会话上下文的完整标题'.repeat(3);
  const items = freeze([{ id: 'b', title, pinned: true }, { id: 'a', pinned: true }]);
  const [group] = groupItems(items);
  assert.deepEqual(group.items.map(item => item.id), ['b', 'a']);
  assert.equal(group.items[0].title, title);
});

test('unknown dates remain visible, empty sections stay absent, repeated ids are not rendered twice', () => {
  assert.deepEqual(groupItems(null), []);
  const groups = groupItems([null, {}, { id: 'x', updatedAt: 'not-a-date' }, { id: 'x', updatedAt: '2026-09-07' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'earlier');
  assert.deepEqual(groups[0].items.map(item => item.id), ['x']);
});

test('a late history read cannot restore older grouping or remove a new running conversation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const start = source.indexOf('async function refreshHistoryList() {');
  const end = source.indexOf('// jumpTo(可选)', start);
  assert.ok(start > 0 && end > start);
  const readers = [], rendered = [];
  const context = vm.createContext({
    window: { api: { history: { list: () => new Promise(resolve => readers.push(resolve)) } },
      RelaySidebarHistory: { reconcile: (_container, items) => rendered.push(items) } },
    getProjectComposer: () => null, isConvRunning: () => false,
    historyEl: {}, ensureHistoryDelegation() {}, buildHistoryRow() {}, updateHistoryRow() {},
  });
  vm.runInContext('let historyRefreshRevision = 0;\n' + source.slice(start, end), context);
  const first = context.refreshHistoryList(), second = context.refreshHistoryList();
  const latest = [{ id: 'running-new', title: 'Latest title' }];
  readers[1](latest); await second;
  readers[0]([{ id: 'old-only' }]); await first;
  assert.deepEqual(rendered, [latest]);
});

test('project headings own their conversations while unassigned history keeps calendar hierarchy', () => {
  const projects = Object.freeze([
    Object.freeze({ id: 'alpha', name: '项目 Alpha', path: '/synthetic/alpha' }),
    Object.freeze({ id: 'beta', name: '项目 Beta', path: '/synthetic/beta' }),
  ]);
  const items = Object.freeze([
    Object.freeze({ id: 'alpha-pin', projectId: 'alpha', pinned: true, updatedAt: '2020-01-01' }),
    Object.freeze({ id: 'global-pin', pinned: true, updatedAt: '2020-01-01' }),
    Object.freeze({ id: 'beta-today', projectId: 'beta', updatedAt: '2026-09-07T12:00:00' }),
    Object.freeze({ id: 'alpha-today', projectId: 'alpha', updatedAt: '2026-09-07T11:00:00' }),
    Object.freeze({ id: 'global-today', updatedAt: '2026-09-07T10:00:00' }),
    Object.freeze({ id: 'global-earlier', updatedAt: '2020-01-01' }),
  ]);
  const before = JSON.stringify({ projects, items });
  const groups = groupItems(items, new Date(2026, 8, 7, 17), projects);
  assert.deepEqual(groups.map(group => group.id), ['pinned', 'project-alpha', 'project-beta', 'today', 'earlier']);
  assert.deepEqual(groups[0].items.map(item => item.id), ['global-pin']);
  assert.deepEqual(groups[1].items.map(item => item.id), ['alpha-pin', 'alpha-today']);
  assert.deepEqual(groups[2].items.map(item => item.id), ['beta-today']);
  assert.equal(groups[1].project, projects[0]);assert.equal(groups[1].label, '项目 Alpha');
  assert.equal(groups[1].pinned, true);assert.equal(groups[2].pinned, false);
  assert.equal(groups.flatMap(group => group.items).length, items.length);
  assert.equal(JSON.stringify({ projects, items }), before);
});

test('project members preserve server pinned-first and recency ordering without entering global pinned section', () => {
  // This is the order delivered by history:list: pinned first, then updatedAt.
  const items = freeze([
    { id: 'beta-pin-newer', projectId: 'beta', pinned: true, updatedAt: '2026-09-06' },
    { id: 'alpha-pin-newer', projectId: 'alpha', pinned: true, updatedAt: '2026-09-05' },
    { id: 'alpha-pin-older', projectId: 'alpha', pinned: true, updatedAt: '2020-01-01' },
    { id: 'alpha-newer', projectId: 'alpha', updatedAt: '2026-09-07T15:00:00' },
    { id: 'beta-newer', projectId: 'beta', updatedAt: '2026-09-07T14:00:00' },
    { id: 'alpha-older', projectId: 'alpha', updatedAt: '2026-09-06' },
  ]);
  const groups = groupItems(items, new Date(2026, 8, 7, 17), freeze([{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]));
  assert.deepEqual(groups.map(group => group.id), ['pinned', 'project-beta', 'project-alpha']);
  assert.deepEqual(groups[0].items, []);
  assert.deepEqual(groups[1].items.map(item => item.id), ['beta-pin-newer', 'beta-newer']);
  assert.deepEqual(groups[2].items.map(item => item.id), ['alpha-pin-newer', 'alpha-pin-older', 'alpha-newer', 'alpha-older']);
});

test('unknown or temporarily unavailable projects never hide history and recover membership without duplicates', () => {
  const items = freeze([
    { id: 'pinned-unknown', projectId: 'missing', pinned: true, updatedAt: '2020-01-01' },
    { id: 'recent-unknown', projectId: 'missing', updatedAt: '2026-09-07T12:00:00' },
    { id: 'undated-unknown', projectId: 'missing', updatedAt: 'invalid' },
  ]);
  const now = new Date(2026, 8, 7, 17), unavailable = groupItems(items, now, []);
  assert.deepEqual(unavailable.map(group => group.id), ['pinned', 'today', 'earlier']);
  assert.deepEqual(unavailable.flatMap(group => group.items).map(item => item.id), items.map(item => item.id));
  const before=JSON.stringify(items);
  const restored = groupItems(freeze([...items, items[0]]), now, freeze([{ id: 'missing', name: 'Recovered project' }]));
  assert.deepEqual(restored.map(group=>group.id), ['pinned', 'project-missing']);
  assert.deepEqual(restored[0].items, []);
  assert.deepEqual(restored[1].items.map(item => item.id), items.map(item => item.id));
  assert.ok(restored[1].items.every((item,index)=>item===items[index]));
  const unavailableAgain=groupItems(freeze([...items,items[1]]),now,freeze([]));
  assert.deepEqual(unavailableAgain.map(group=>group.id),unavailable.map(group=>group.id));
  assert.deepEqual(unavailableAgain.flatMap(group=>group.items).map(item=>item.id),items.map(item=>item.id));
  assert.equal(JSON.stringify(items),before);
});

test('empty projects remain navigable and retain registry order and full labels', () => {
  const name = '完整项目名称'.repeat(12);
  const projects = freeze([{ id: 'second', name }, { id: 'first', name: 'First' }]);
  const groups = groupItems([], new Date(), projects);
  assert.deepEqual(groups.map(group => group.id), ['project-second', 'project-first']);
  assert.equal(groups[0].label, name);assert.equal(groups[0].items.length, 0);
  assert.equal(groups[1].items.length, 0);
});

test('flat groups order global pins, projects ranked by first pin, registry projects, then calendar periods', () => {
  const projects=freeze([
    {id:'alpha',name:'Alpha'},{id:'beta',name:'Beta'},
    {id:'empty',name:'Empty'},{id:'gamma',name:'Gamma'},{id:'delta',name:'Delta'},
  ]);
  const items=freeze([
    {id:'alpha-recent',projectId:'alpha',updatedAt:'2026-09-07T16:00:00'},
    {id:'gamma-pin-first',projectId:'gamma',pinned:true,updatedAt:'1990-01-01'},
    {id:'global-pin',pinned:true,updatedAt:'2026-09-07T14:00:00'},
    {id:'beta-pin-second',projectId:'beta',pinned:true,updatedAt:'2026-09-07T15:00:00'},
    {id:'gamma-pin-later',projectId:'gamma',pinned:true,updatedAt:'2026-09-07T17:00:00'},
    {id:'delta-recent',projectId:'delta',updatedAt:'2026-09-07T18:00:00'},
    {id:'global-old',updatedAt:'2020-01-01'},
    {id:'global-today',updatedAt:'2026-09-07T12:00:00'},
  ]);
  const now=new Date(2026,8,7,20),stamp=now.getTime(),before=JSON.stringify({projects,items});
  const groups=groupItems(items,now,projects);
  assert.deepEqual(groups.map(group=>group.id),['pinned','project-gamma','project-beta','project-alpha','project-empty','project-delta','today','earlier']);
  assert.deepEqual(groups[0].items.map(item=>item.id),['global-pin']);
  assert.deepEqual(groups[1].items.map(item=>item.id),['gamma-pin-first','gamma-pin-later']);
  assert.deepEqual(groups.filter(group=>group.project).map(group=>group.pinned),[true,true,false,false,false]);
  const flattened=groups.flatMap(group=>group.items);
  assert.equal(new Set(flattened.map(item=>item.id)).size,items.length);
  assert.ok(flattened.every(item=>items.includes(item)));
  assert.equal(JSON.stringify({projects,items}),before);
  assert.equal(now.getTime(),stamp);
});

test('project pin state is derived only from members and never written into frozen registry records', () => {
  const projects=freeze([
    {id:'stale-pin',name:'Stale',pinned:true,updatedAt:'2001-01-01',metadata:{source:'registry'}},
    {id:'member-pin',name:'Member',pinned:false,updatedAt:'2002-01-01'},
  ]);
  const items=freeze([
    {id:'normal',projectId:'stale-pin',updatedAt:'2026-09-07T15:00:00'},
    {id:'pinned',projectId:'member-pin',pinned:true,updatedAt:'2003-01-01'},
  ]);
  const before=JSON.stringify({projects,items}),groups=groupItems(items,new Date(2026,8,7,20),projects);
  assert.deepEqual(groups.map(group=>group.id),['pinned','project-member-pin','project-stale-pin']);
  assert.deepEqual(groups[0].items,[]);
  assert.equal(groups[1].pinned,true);assert.equal(groups[1].project,projects[1]);
  assert.equal(groups[1].project.pinned,false);
  assert.equal(groups[2].pinned,false);assert.equal(groups[2].project,projects[0]);
  assert.equal(groups[2].project.pinned,true);
  assert.equal(JSON.stringify({projects,items}),before);
});

test('project pin partition is stable for interleaved input and does not resort activity timestamps', () => {
  const projects=freeze([{id:'project',name:'Project'}]);
  const items=freeze([
    {id:'ordinary-first',projectId:'project',updatedAt:'2000-01-01'},
    {id:'pin-first',projectId:'project',pinned:true,updatedAt:'2001-01-01'},
    {id:'ordinary-second',projectId:'project',updatedAt:'2026-09-07'},
    {id:'pin-second',projectId:'project',pinned:true,updatedAt:'2026-09-08'},
    {id:'ordinary-third',projectId:'project',createdAt:'2010-01-01'},
  ]);
  const before=JSON.stringify(items),groups=groupItems(items,new Date(2026,8,8),projects);
  assert.deepEqual(groups.map(group=>group.id),['pinned','project-project']);
  assert.deepEqual(groups[0].items,[]);
  assert.deepEqual(groups[1].items,[items[1],items[3],items[0],items[2],items[4]]);
  assert.equal(JSON.stringify(items),before);
});

for (const action of ['unpin','delete','move']) {
  test(`a project returns to registry order after its only pinned conversation is ${({unpin:'unpinned',delete:'deleted',move:'moved'})[action]}`,()=>{
    const projects=freeze([{id:'alpha',name:'Alpha'},{id:'beta',name:'Beta'},{id:'gamma',name:'Gamma'}]);
    const items=freeze([
      {id:'beta-pin',projectId:'beta',pinned:true,updatedAt:'2000-01-01',createdAt:'1999-01-01'},
      {id:'alpha-normal',projectId:'alpha',updatedAt:'2026-09-07T16:00:00'},
      {id:'beta-normal',projectId:'beta',updatedAt:'2026-09-07T14:00:00'},
      {id:'gamma-normal',projectId:'gamma',updatedAt:'2026-09-07T15:00:00'},
    ]);
    const now=new Date(2026,8,7,20),before=JSON.stringify({projects,items});
    assert.deepEqual(groupItems(items,now,projects).map(group=>group.id),['pinned','project-beta','project-alpha','project-gamma']);
    const changed=freeze(action==='delete'?items.slice(1):[
      {...items[0],...(action==='unpin'?{pinned:false}:{projectId:'gamma'})},...items.slice(1),
    ]);
    const changedBefore=JSON.stringify(changed),groups=groupItems(changed,now,projects);
    assert.deepEqual(groups.map(group=>group.id),action==='move'
      ?['pinned','project-gamma','project-alpha','project-beta']
      :['project-alpha','project-beta','project-gamma']);
    const beta=groups.find(group=>group.id==='project-beta');
    assert.equal(beta.pinned,false);
    assert.deepEqual(beta.items.map(item=>item.id),action==='unpin'?['beta-pin','beta-normal']:['beta-normal']);
    assert.equal(JSON.stringify({projects,items}),before);
    assert.equal(JSON.stringify(changed),changedBefore);
    assert.ok(changed.every(item=>item.updatedAt===items.find(original=>original.id===item.id).updatedAt));
  });
}

test('removing the sole project pin preserves its now-empty project at the original registry position',()=>{
  const projects=freeze([{id:'alpha',name:'Alpha'},{id:'empty-after-delete',name:'Keep folder'},{id:'gamma',name:'Gamma'}]);
  const item=freeze({id:'sole',projectId:'empty-after-delete',pinned:true,updatedAt:'2001-01-01'});
  assert.deepEqual(groupItems(freeze([item]),undefined,projects).map(group=>group.id),['pinned','project-empty-after-delete','project-alpha','project-gamma']);
  const groups=groupItems(freeze([]),undefined,projects);
  assert.deepEqual(groups.map(group=>group.id),['project-alpha','project-empty-after-delete','project-gamma']);
  assert.equal(groups[1].project,projects[1]);assert.deepEqual(groups[1].items,[]);assert.equal(groups[1].pinned,false);
});

test('duplicate history ids cannot promote a project using a discarded later pin or duplicate its membership',()=>{
  const projects=freeze([{id:'alpha',name:'Alpha'},{id:'beta',name:'Beta'}]);
  const items=freeze([
    {id:'same',projectId:'alpha',pinned:false,updatedAt:'2026-09-07'},
    {id:'same',projectId:'beta',pinned:true,updatedAt:'2026-09-08'},
    {id:'beta-normal',projectId:'beta',updatedAt:'2026-09-07'},
  ]);
  const before=JSON.stringify(items),groups=groupItems(items,new Date(2026,8,8),projects);
  assert.deepEqual(groups.map(group=>group.id),['project-alpha','project-beta']);
  assert.equal(groups[0].items[0],items[0]);assert.deepEqual(groups[1].items,[items[2]]);
  assert.equal(groups.flatMap(group=>group.items).length,2);assert.equal(JSON.stringify(items),before);
});

test('a history refresh waits for its project catalog and stale paired responses cannot replace latest groups', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const start = source.indexOf('async function refreshHistoryList() {'), end = source.indexOf('// jumpTo(可选)', start);
  assert.ok(start > 0 && end > start);
  const historyReads = [], projectReads = [], rendered = [], header = () => {};
  const composer = { refresh: () => new Promise(resolve => projectReads.push(resolve)), header };
  const context = vm.createContext({
    window: { api: { history: { list: () => new Promise(resolve => historyReads.push(resolve)) } },
      RelaySidebarHistory: { reconcile: (_container, items, options) => rendered.push({ items, projects: options.projects, header: options.projectHeader }) } },
    getProjectComposer: () => composer, isConvRunning: () => false, historyEl: {}, ensureHistoryDelegation() {}, buildHistoryRow() {}, updateHistoryRow() {},
  });
  vm.runInContext('let historyRefreshRevision = 0;\n' + source.slice(start, end), context);
  const first = context.refreshHistoryList(), second = context.refreshHistoryList();
  const latestItems = [{ id: 'new-run', projectId: 'new-project' }], latestProjects = [{ id: 'new-project', name: 'Current project' }];
  historyReads[1](latestItems);await Promise.resolve();assert.equal(rendered.length, 0);
  projectReads[1](latestProjects);await second;
  assert.equal(rendered.length, 1);assert.equal(rendered[0].items, latestItems);assert.equal(rendered[0].projects, latestProjects);assert.equal(rendered[0].header, header);
  projectReads[0]([{ id: 'old-project', name: 'Old project' }]);historyReads[0]([{ id: 'old-run', projectId: 'old-project' }]);await first;
  assert.equal(rendered.length, 1);assert.equal(rendered[0].items[0].id, 'new-run');
});


test('running project conversations precede idle pins and preserve server order within each priority', () => {
  const projects = freeze([{ id: 'project', name: 'Project' }]);
  const items = freeze([
    { id: 'idle-pin-first', projectId: 'project', pinned: true, updatedAt: '2026-09-25' },
    { id: 'running-first', projectId: 'project', updatedAt: '2020-01-01' },
    { id: 'idle-first', projectId: 'project', updatedAt: '2026-09-24' },
    { id: 'running-pin-first', projectId: 'project', pinned: true, updatedAt: '2010-01-01' },
    { id: 'idle-pin-second', projectId: 'project', pinned: true, updatedAt: '2026-09-23' },
    { id: 'running-second', projectId: 'project', updatedAt: '2026-09-25' },
    { id: 'running-pin-second', projectId: 'project', pinned: true, updatedAt: '2026-09-25' },
    { id: 'idle-second', projectId: 'project', updatedAt: '2026-09-25' },
  ]);
  const running = new Set(['running-first', 'running-pin-first', 'running-second', 'running-pin-second']);
  const now = new Date(2026, 8, 25, 17), stamp = now.getTime();
  const before = JSON.stringify({ projects, items });
  const groups = groupItems(items, now, projects, { isRunning: id => running.has(id) });
  assert.deepEqual(groups.find(group => group.project).items.map(item => item.id), [
    'running-pin-first', 'running-pin-second', 'running-first', 'running-second',
    'idle-pin-first', 'idle-pin-second', 'idle-first', 'idle-second',
  ]);
  assert.equal(groups.find(group => group.project).pinned, true);
  assert.ok(groups.flatMap(group => group.items).every(item => items.includes(item)));
  assert.equal(JSON.stringify({ projects, items }), before);
  assert.equal(now.getTime(), stamp);
});

test('stopping one or all project runs restores the original pinned and server ordering without retimestamping', () => {
  const projects = freeze([{ id: 'project', name: 'Project' }]);
  const items = freeze([
    { id: 'pin', projectId: 'project', pinned: true, updatedAt: '2026-09-25' },
    { id: 'recent', projectId: 'project', updatedAt: '2026-09-24' },
    { id: 'running-first', projectId: 'project', updatedAt: '2026-09-23' },
    { id: 'running-second', projectId: 'project', updatedAt: '2000-01-01' },
  ]);
  const running = new Set(['running-first', 'running-second']);
  const before = JSON.stringify(items), now = new Date(2026, 8, 25, 17), stamp = now.getTime();
  const order = () => groupItems(items, now, projects, { isRunning: id => running.has(id) })
    .find(group => group.project).items.map(item => item.id);
  assert.deepEqual(order(), ['running-first', 'running-second', 'pin', 'recent']);
  running.delete('running-first');
  assert.deepEqual(order(), ['running-second', 'pin', 'recent', 'running-first']);
  running.clear();
  assert.deepEqual(order(), items.map(item => item.id));
  assert.equal(JSON.stringify(items), before);
  assert.equal(now.getTime(), stamp);
});

test('promoting running project members does not change pin-ranked projects or regular registry order', () => {
  const projects = freeze([
    { id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' },
    { id: 'gamma', name: 'Gamma' }, { id: 'delta', name: 'Delta' },
  ]);
  const items = freeze([
    { id: 'beta-running', projectId: 'beta', updatedAt: '2000-01-01' },
    { id: 'delta-running', projectId: 'delta', updatedAt: '2000-01-01' },
    { id: 'gamma-pin-first', projectId: 'gamma', pinned: true, updatedAt: '2020-01-01' },
    { id: 'beta-pin-second', projectId: 'beta', pinned: true, updatedAt: '2026-09-25' },
    { id: 'gamma-running', projectId: 'gamma', updatedAt: '2000-01-01' },
    { id: 'alpha-idle', projectId: 'alpha', updatedAt: '2026-09-25' },
  ]);
  const running = new Set(['beta-running', 'delta-running', 'gamma-running']);
  const baseline = groupItems(items, new Date(2026, 8, 25), projects);
  const groups = groupItems(items, new Date(2026, 8, 25), projects, { isRunning: id => running.has(id) });
  assert.deepEqual(groups.map(group => group.id), ['pinned', 'project-gamma', 'project-beta', 'project-alpha', 'project-delta']);
  assert.deepEqual(groups.map(group => group.id), baseline.map(group => group.id));
  assert.deepEqual(groups[1].items.map(item => item.id), ['gamma-running', 'gamma-pin-first']);
  assert.deepEqual(groups[2].items.map(item => item.id), ['beta-running', 'beta-pin-second']);
  assert.equal(groups[4].pinned, false);
});

test('running state leaves global pins, calendar buckets and their supplied order unchanged', () => {
  const projects = freeze([{ id: 'project', name: 'Project' }]);
  const items = freeze([
    { id: 'global-pin-idle', pinned: true, updatedAt: '2000-01-01' },
    { id: 'global-pin-running', pinned: true, updatedAt: '2001-01-01' },
    { id: 'global-today-idle', updatedAt: new Date(2026, 8, 25, 16).toISOString() },
    { id: 'global-today-running', updatedAt: new Date(2026, 8, 25, 15).toISOString() },
    { id: 'global-yesterday-running', updatedAt: new Date(2026, 8, 24, 23).toISOString() },
    { id: 'global-old-running', updatedAt: '2000-01-01' },
    { id: 'project-idle', projectId: 'project', updatedAt: '2026-09-25' },
    { id: 'project-running', projectId: 'project', updatedAt: '2000-01-01' },
  ]);
  const now = new Date(2026, 8, 25, 17), stamp = now.getTime(), before = JSON.stringify({ projects, items });
  const baseline = groupItems(items, now, projects);
  const groups = groupItems(items, now, projects, { isRunning: id => id.endsWith('-running') });
  assert.deepEqual(groups.filter(group => !group.project), baseline.filter(group => !group.project));
  assert.deepEqual(groups.find(group => group.project).items.map(item => item.id), ['project-running', 'project-idle']);
  assert.equal(JSON.stringify({ projects, items }), before);
  assert.equal(now.getTime(), stamp);
});

test('history refresh passes the live running predicate after asynchronous history and project reads', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const start = source.indexOf('async function refreshHistoryList() {'), end = source.indexOf('// jumpTo(可选)', start);
  assert.ok(start > 0 && end > start);
  const historyReads = [], projectReads = [], rendered = [], running = new Set();
  const isConvRunning = id => running.has(id);
  const now = new Date(2026, 8, 25, 17);
  const composer = { refresh: () => new Promise(resolve => projectReads.push(resolve)), header() {} };
  const context = vm.createContext({
    window: { api: { history: { list: () => new Promise(resolve => historyReads.push(resolve)) } },
      RelaySidebarHistory: { reconcile: (_container, items, options) => {
        assert.equal(options.isRunning, isConvRunning);
        rendered.push(groupItems(items, now, options.projects, { isRunning: options.isRunning })
          .find(group => group.project).items.map(item => item.id));
      } } },
    getProjectComposer: () => composer, isConvRunning,
    historyEl: {}, ensureHistoryDelegation() {}, buildHistoryRow() {}, updateHistoryRow() {},
  });
  vm.runInContext('let historyRefreshRevision = 0;\n' + source.slice(start, end), context);
  const items = freeze([
    { id: 'idle-pin', projectId: 'project', pinned: true, updatedAt: '2026-09-25' },
    { id: 'late-run', projectId: 'project', updatedAt: '2000-01-01' },
  ]);
  const projects = freeze([{ id: 'project', name: 'Project' }]);
  const started = context.refreshHistoryList();
  historyReads[0](items); await Promise.resolve();
  assert.equal(rendered.length, 0);
  running.add('late-run');
  projectReads[0](projects); await started;
  assert.deepEqual(rendered, [['late-run', 'idle-pin']]);

  const stopped = context.refreshHistoryList();
  projectReads[1](projects); await Promise.resolve();
  running.clear();
  historyReads[1](items); await stopped;
  assert.deepEqual(rendered, [['late-run', 'idle-pin'], ['idle-pin', 'late-run']]);
});
