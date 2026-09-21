'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
function declaration(name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index);
  const body = tail.indexOf('{', tail.search(/\)\s*\{/));
  const firstLine = tail.indexOf('\n');
  if (tail.slice(body, firstLine).includes('}')) return tail.slice(0, firstLine);
  const end = tail.indexOf('\n}', body);
  assert.ok(end > body, `closing body for ${name}`);
  return tail.slice(0, end + 2);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function element() {
  const classes = new Set();
  return {
    dataset: {}, children: [], scrollTop: 0, scrollHeight: 200,
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
    querySelectorAll() { return []; }, querySelector() { return null; },
    append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
    setAttribute() {}, removeAttribute() {}, addEventListener() {},
  };
}
function harness() {
  const requests = [], frames = [], handlers = {}, calls = { prespawn: [], saved: [], sent: [], dropped: [], skills: [], drafts: [], toast: [], projectMenuClosed: 0 };
  const nodes = Object.fromEntries(['libraryPage', 'scheduleModal', 'settingsModal', 'app', 'messages', 'cvMessages'].map(id => [id, element()]));
  const history = { load(id) { const request = { id, ...deferred() }; requests.push(request); return request.promise; }, save: async conv => { calls.saved.push(conv); return { updatedAt: 'saved' }; } };
  const context = {
    console, Map, Set, WeakMap, Date, setTimeout, clearTimeout,
    pageNavigationVersion: 0, pendingConversationViewReloads: new Set(), pageScrollPositions: new WeakMap(),
    activeView: 'chat', lastConversationView: 'chat', chatWasFollowingOutput: true, stickToBottom: true,
    currentConv: null, currentCreateConv: null, currentSessionId: null, currentMode: 'plain', currentAgent: null,
    currentAgentLabel: null, currentOrchestrateAgents: null, currentWorkingDir: null, currentModel: 'haiku', currentEffort: null,
    currentProjectId: null, currentExecutionMode: { kind: 'default' },
    projectComposer: { open: true, close() { this.open = false; calls.projectMenuClosed++; } },
    pmBrandCache: {}, contextUsageByConv: new Map(), providerRoutingLoaded: false, runs: new Map(),
    imageConfigLoaded: true, imageConfigLoading: null, cvRefImages: [], selectedQuickSkill: null,
    chatViewEl: element(), createViewEl: element(), messagesEl: nodes.messages, cvMessagesEl: nodes.cvMessages, chatTitle: {},
    currentAssistantBubble: null, pendingPmBubble: null, requestAnimationFrame: callback => frames.push(callback),
    document: { querySelector: () => nodes.app, querySelectorAll: () => [], createElement: element },
    $: id => nodes[id] || null,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    window: { dispatchEvent() {}, addEventListener(type, fn) { handlers[type] = fn; }, api: { history,
      prespawnClaude: async (...args) => { calls.prespawn.push(args); },
      dropClaudeSession: async id => { calls.dropped.push(id); },
    } },
    configuredChatRoute: () => null, sessionRouteSnapshot: () => null, conversationSessionMatchesRoute: () => true,
    invalidateConversationSessionForProvider: async () => {}, ensureOrchLabels: async () => {},
    effortForTier: () => null, currentTier: () => null, runtimeModelForValue: value => value,
    syncRunningUI() {}, refreshComposerPermission: async () => true, hideModelPopup() {}, hideSkillQuickPopup() {}, emitConversationChanged() {},
    setSelectedQuickSkill: value => calls.skills.push(value), renderContextUsage() {}, applyWorkdirUI() {},
    activateComposerDraft: value => calls.drafts.push(value),
    updateModelSwitchUI() {}, updateComposerForMode() {}, clearConversationMessages() { nodes.messages.innerHTML = ''; }, clearConversationIndex() {},
    refreshConversationIndex() {}, removeThinking() {}, scrollToBottom() {}, scheduleConversationIndexUpdate() {},
    refreshHistoryList: async () => {}, refreshClaudeRuntimeInfo: async () => {}, cvRenderRef() {}, cvIsRunning: () => false,
    cvSyncGenerateBtn() {}, buildImageGrid: () => element(), loadImageModels: async () => {},
    newCreateConv() { context.currentCreateConv = { id: null, turns: [] }; },
    showToast: value => calls.toast.push(value), send: async value => { calls.sent.push(value); return { ok: true }; },
  };
  vm.createContext(context);
  for (const name of ['appViewElements', 'syncPageNavigation', 'showAppView', 'showChatView', 'returnToConversationView', 'showCreateView', 'loadConversation', 'loadCreateConv']) vm.runInContext(declaration(name), context);
  for (const name of ['relay:open-conversation']) {
    const start = source.indexOf(`window.addEventListener('${name}'`);
    const end = source.indexOf('\n});', start) + 4;
    assert.ok(start >= 0 && end > start); vm.runInContext(source.slice(start, end), context);
  }
  return { context, requests, frames, handlers, calls, nodes,
    resolve(id, conv, occurrence = 0) { const matches = requests.filter(request => request.id === id); assert.ok(matches[occurrence], `missing request ${id}#${occurrence}`); matches[occurrence].resolve(conv); },
    event(name, detail) { handlers[name]({ detail, preventDefault() {} }); },
  };
}
const conversation = (id, extra = {}) => ({ id, title: id, turns: [], ...extra });

test('late chat history cannot steal navigation from a workspace page', async () => {
  const h = harness(); const pending = h.context.loadConversation('old');
  h.context.showAppView('library'); h.resolve('old', conversation('old'));
  assert.equal(await pending, false); assert.equal(h.context.activeView, 'library'); assert.equal(h.context.currentConv, null);
  assert.deepEqual(h.calls.drafts, [], 'stale history must not activate its composer draft');
  assert.equal(h.context.projectComposer.open, false); assert.ok(h.calls.projectMenuClosed > 0, 'navigation closes an open project menu before stale history completes');
});

test('the latest chat request wins when history reads finish out of order', async () => {
  const h = harness(); const old = h.context.loadConversation('old'); const recent = h.context.loadConversation('new');
  h.resolve('new', conversation('new', { model: 'opus' })); assert.equal(await recent, true);
  h.resolve('old', conversation('old', { model: 'haiku' })); assert.equal(await old, false);
  assert.equal(h.context.currentConv.id, 'new'); assert.equal(h.context.currentModel, 'opus');
  assert.deepEqual(h.calls.drafts, ['new'], 'only the winning history request activates its draft');
});

test('collaboration history restores its model without reading or waiting for removed PM branding', { timeout: 2000 }, async () => {
  const h = harness(); let brandingCalls = 0;
  h.context.pmBrandCache = null;
  h.context.ensureOrchLabels = () => { brandingCalls++; return new Promise(() => {}); };
  const restored = h.context.loadConversation('collaboration');
  h.resolve('collaboration', conversation('collaboration', { mode: 'orchestrate', model: 'haiku', workingDir: { path: '/synthetic/collaboration' } }));
  assert.equal(await restored, true);
  assert.equal(brandingCalls, 0);
  assert.equal(h.context.currentConv.id, 'collaboration');
  assert.equal(h.context.currentMode, 'orchestrate');
  assert.equal(h.context.currentModel, 'haiku');
  assert.equal(h.context.currentWorkingDir.path, '/synthetic/collaboration');
  const recent = h.context.loadConversation('new');
  h.resolve('new', conversation('new', { model: 'opus', workingDir: { path: '/synthetic/new' } }));
  assert.equal(await recent, true);
  assert.equal(h.context.currentConv.id, 'new');
  assert.equal(h.context.currentModel, 'opus');
  assert.equal(h.context.currentWorkingDir.path, '/synthetic/new');
});

test('provider migration completing after navigation does not mount or prespawn the old chat', async () => {
  const h = harness(); const migration = deferred();
  h.context.sessionRouteSnapshot = () => ({ routeTier: 'haiku' }); h.context.conversationSessionMatchesRoute = () => false;
  h.context.invalidateConversationSessionForProvider = () => migration.promise;
  const pending = h.context.loadConversation('old'); h.resolve('old', conversation('old', { sessionId: 'synthetic' })); await tick();
  h.context.showAppView('settings'); migration.resolve();
  assert.equal(await pending, false); assert.equal(h.context.activeView, 'settings'); assert.equal(h.calls.prespawn.length, 0);
});

test('same-chat navigation preserves its DOM while explicit recovery rereads and renders', async () => {
  const h = harness(); h.context.currentConv = conversation('same'); h.nodes.messages.innerHTML = 'retained draft and stream';
  assert.equal(await h.context.loadConversation('same'), true); assert.equal(h.requests.length, 0); assert.equal(h.nodes.messages.innerHTML, 'retained draft and stream');
  const recovery = h.context.loadConversation('same', null, { forceReload: true }); h.resolve('same', conversation('same', { title: 'recovered' }));
  assert.equal(await recovery, true); assert.equal(h.context.chatTitle.textContent, 'recovered'); assert.equal(h.nodes.messages.innerHTML, '');
});

test('late creation history and late model setup cannot replace the newer page or create conversation', async () => {
  const h = harness(); const late = h.context.loadCreateConv('old'); h.context.showAppView('library'); h.resolve('old', conversation('old', { kind: 'create' }));
  assert.equal(await late, false); assert.equal(h.context.currentCreateConv, null);
  const config = deferred(); h.context.imageConfigLoaded = false; h.context.loadImageModels = () => config.promise;
  const fresh = h.context.showCreateView(true);
  const recent = h.context.loadCreateConv('new'); h.resolve('new', conversation('new', { kind: 'create' })); await tick();
  config.resolve(); assert.equal(await fresh, false); assert.equal(await recent, true); assert.equal(h.context.currentCreateConv.id, 'new');
});

test('same creation fast path preserves DOM but forced recovery and dirty return reload it', async () => {
  const h = harness(); h.context.currentCreateConv = conversation('same', { kind: 'create' }); h.nodes.cvMessages.innerHTML = 'loading node';
  assert.equal(await h.context.loadCreateConv('same'), true); assert.equal(h.requests.length, 0); assert.equal(h.nodes.cvMessages.innerHTML, 'loading node');
  const recovery = h.context.loadCreateConv('same', null, { forceReload: true }); h.resolve('same', conversation('same', { kind: 'create' })); assert.equal(await recovery, true);
  h.context.showAppView('library'); h.context.pendingConversationViewReloads.add('create:same');
  h.context.returnToConversationView(); assert.equal(h.requests.length, 2); assert.equal(h.context.activeView, 'library');
  h.resolve('same', conversation('same', { kind: 'create' }), 1); await tick();
  assert.equal(h.context.activeView, 'create'); assert.equal(h.context.pendingConversationViewReloads.size, 0);
});

test('interaction conversation prefetch is canceled if the user navigates elsewhere', async () => {
  const h = harness(); h.event('relay:open-conversation', { conversationId: 'old' });
  h.context.showAppView('library'); h.resolve('old', conversation('old')); await tick();
  assert.equal(h.requests.length, 1); assert.equal(h.context.activeView, 'library'); assert.equal(h.context.currentConv, null);
});

test('all explicit recovery call sites request a forced reload', () => {
  for (const name of ['finishRunUnsafe', 'reconcileCreationTask', 'restoreActiveRunsFromLedger', 'cvFinishTurn']) {
    const body = declaration(name);
    assert.match(body, /load(?:Conversation|CreateConv)\([^\n]+forceReload: true/, name);
  }
});
