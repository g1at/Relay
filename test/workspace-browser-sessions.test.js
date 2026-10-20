'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/workspace-panel.js'), 'utf8');
const between = (start, end) => {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, `production section ${start} exists`);
  return source.slice(begin, finish);
};

// Use the actual renderer ownership, context transition and async creation
// paths. Native view attachment and page input have separate Electron coverage.
function fixture({ holdFiles = false } = {}) {
  const calls = [], nodes = new Map(), fileRequests = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, dataset: {}, textContent: '', value: '',
      removeAttribute() {}, replaceChildren() {}, querySelector() { return null; } });
    return nodes.get(id);
  };
  const sandbox = { $, app: { dataset: { view: 'chat' } }, document: { hidden: false },
    window: { RelayBrowserInternalPages: { parse: () => null }, relayWorkspacePanel: {} },
    panel: { contains: () => false, querySelectorAll: () => [] }, toggle: { focus() {} },
    clearSnapAnimation() {}, savePreviewScroll() {}, syncFileLayout() {}, renderPreview() {}, ensureReview() {},
    clearTimeout, requestAnimationFrame() {}, currentTerminal: () => null,
    browserBridge: { async invoke(payload) { calls.push(payload); return { ok: true }; } },
    bridge: {
      resolve: async ctx => ({ ok: true, root: 'C:/Workspace/' + ctx.conversationId }),
      list: request => holdFiles ? new Promise(resolve => fileRequests.push({ request, resolve })) : Promise.resolve({ ok: true, entries: [] }),
    },
    assertResult(value) { if (!value || value.ok === false) throw Error(value?.error || 'failed'); return value; },
    browserTabStatus: { update() {} }, renderTabs() {}, disposeHtmlPreview() {}, closeMenus() {},
    syncInternalPages() {}, layout() {}, dispatchTab() {}, syncNative() {}, renderBrowser() {},
    renderBrowserAutomation() {}, renderTerminals() {}, renderFiles() {}, showTree() {}, notice() {},
    syncNativeWorkspaceShortcuts: async () => {}, focusBrowserAddress() {},
  };
  function $(id) { return node(id); }
  vm.createContext(sandbox);
  vm.runInContext(`
    let context = { conversationId: 'a' }, nextContext = context, contextKey = 'a', revision = 0,
      filesRevision = 0, previewRevision = 0, activeId = null, tab = null, opened = true,
      navigationRevision = 0, tabNumber = 0, disposed = false, workspace = null,
      directoryLink = null, selectedDirectory = null, preview = null, sourceMode = false,
      expanded = new Set(), entries = new Map(), loadingFiles = false, fileFingerprint = '',
      browserFeedback = null, reviewView = null, findTimer = null, contextLoading = false,
      preferredWidth = 380, defaultPreferredWidth = 380, restoreWidth = 380,
      maximized = false, automaticMaximized = false, dragRestore = null;
    const tabs = [], browserAutomationStates = new Map(), closedBrowserIds = new Set(),
      pendingNativeBrowsers = new Map(), creatingBrowsers = new Set(), pendingCreates = new Map(),
      browserPresentationDismissed = new Set();
    const readContext = () => nextContext;
    const keyFor = ctx => ctx ? JSON.stringify([ctx.conversationId, ctx.workingDir || null]) : '';
    contextKey = keyFor(context);
    function endDrag() {
      if (!dragRestore) return;
      ({ opened, preferredWidth, maximized, automaticMaximized, restoreWidth } = dragRestore);
      dragRestore = null;
    }
    function setMaximized(value) { maximized = opened && !!value; automaticMaximized = false; }
    ${between('  const activeTab =', '  const fileLayout =')}
    ${between('  function activate(', '  function dispatchTab(')}
    ${between('  function open(', '  function close(')}
    ${between('  function browserRoutes(', '  function nativeCanGo(')}
    ${between('  function syncContext()', '  async function resolveRoot(')}
    ${between('  async function resolveRoot(', '  function emptyState(')}
    ${between('  async function refreshFiles()', '  function disposeHtmlPreview(')}
    ${between('  async function createBrowser(', '  function showBrowserTab(')}
    ${between('  function showBrowserTab(', '  window.relayWorkspacePanel.showBrowserTab')}
    ${between('  function presentAutomationTab(', '  async function browserAutomationControl(')}
    ${between('  function close()', '  async function closeTab(')}
    const closedPages = new Map();
    ${between('  function closedBrowserPages(', '  let browserPreferences')}
    function browserCall(payload) { globalThis.calls.push(payload); return new Promise(resolve => { pendingCreates.set(payload.conversationId, resolve); }); }
    globalThis.control = {
      add: applyBrowserState, activate, createBrowser, open, present: presentAutomationTab, refreshFiles,
      state: () => ({ activeId, tab, opened, navigationRevision, revision, filesRevision, previewRevision,
        preferredWidth, restoreWidth, maximized, automaticMaximized, contextLoading,
        loadingFiles, fileEntries: [...entries.entries()],
        tabs: visibleTabs(), all: tabs, dismissed: [...browserPresentationDismissed] }),
      switchTo(id, workingDir = null) { nextContext = id ? { conversationId: id, workingDir } : null; onConversationChanged(); },
      beginLoading() { onConversationChanged({ detail: { loading: true } }); },
      finishLoading() { onConversationChanged(); },
      changeReadContext(id) { nextContext = { conversationId: id }; },
      resize(value) { preferredWidth = defaultPreferredWidth = restoreWidth = value; },
      maximize({ automatic = false } = {}) { maximized = true; automaticMaximized = automatic; },
      startDrag() { dragRestore = { opened, preferredWidth, maximized, automaticMaximized, restoreWidth };
        opened = false; preferredWidth = 900; maximized = false; restoreWidth = 900; },
      addGlobal(kind) { const item = { id: kind, kind }; tabs.push(item); return item; },
      hide() { opened = false; navigationRevision++; },
      close,
      completeCreate(state, conversationId = 'a') { pendingCreates.get(conversationId)({ ok: true, id: state.id, tab: state }); },
      closed: closedBrowserPages,
    };
  `, Object.assign(sandbox, { calls }));
  return { c: sandbox.control, calls, fileRequests, flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('switching conversations filters pages and restores each last page without pausing its task', () => {
  const { c, calls } = fixture();
  const a1 = c.add({ id: 'a1', ownerConversationId: 'a', url: 'https://a.test/' });
  const a2 = c.add({ id: 'a2', ownerConversationId: 'a', url: 'https://a.test/2' });
  const b = c.add({ id: 'b', ownerConversationId: 'b', url: 'https://b.test/' });
  c.activate(a2.id); c.switchTo('b');
  assert.deepEqual(Array.from(c.state().tabs, item => item.browserId), ['b']);
  assert.equal(c.state().activeId, null);
  assert.equal(c.state().opened, false, 'a new conversation does not inherit an expanded panel');
  c.activate(b.id);
  c.switchTo('a');
  assert.deepEqual(Array.from(c.state().tabs, item => item.browserId), ['a1', 'a2']);
  assert.equal(c.state().activeId, a2.id);
  assert.equal(c.state().opened, true);
  assert.ok(c.state().all.includes(a1));
  assert.deepEqual(calls, [], 'presentation changes must not revoke automation');
});

test('an empty conversation stays closed without disposing background pages or closing the source panel', () => {
  const { c } = fixture();
  const a = c.add({ id: 'a', ownerConversationId: 'a', url: 'https://a.test/' });
  c.activate(a.id); c.switchTo('empty');
  assert.equal(c.state().activeId, null); assert.equal(c.state().tab, null);
  assert.equal(c.state().tabs.length, 0); assert.equal(c.state().all.length, 1);
  assert.equal(c.state().opened, false);
  c.open(); c.close(); c.switchTo('a');
  assert.equal(c.state().activeId, a.id); assert.equal(c.state().opened, true);
  c.switchTo('empty'); assert.equal(c.state().opened, false);
});

test('only deliberate sidebar close suppresses automatic presentation, not conversation switching', () => {
  const { c } = fixture();
  const a = c.add({ id: 'a', ownerConversationId: 'a', url: 'https://a.test/' });
  c.activate(a.id); c.switchTo('b'); c.switchTo('a');
  assert.deepEqual(Array.from(c.state().dismissed), []);
  c.close(); assert.deepEqual(Array.from(c.state().dismissed), ['a']);
  c.switchTo('b'); assert.deepEqual(Array.from(c.state().dismissed), ['a']);
});

test('shared tools keep each conversation selection and expanded state independently', () => {
  for (const kind of ['files', 'terminal', 'review']) {
    const { c } = fixture();
    c.add({ id: 'a', ownerConversationId: 'a', url: 'https://a.test/' });
    c.addGlobal(kind); c.activate(kind); c.switchTo('b');
    assert.equal(c.state().activeId, null); assert.equal(c.state().opened, false);
    assert.deepEqual(Array.from(c.state().tabs, item => item.kind), [kind]);
    c.switchTo('a'); assert.equal(c.state().activeId, kind); assert.equal(c.state().opened, true);
  }
});

test('opening a new conversation panel reuses its available shared file tab without creating a duplicate', () => {
  const { c } = fixture();
  c.open('files'); c.switchTo('b');
  assert.equal(c.state().opened, false); assert.equal(c.state().activeId, null);
  assert.equal(c.state().tabs.length, 1);
  c.open();
  assert.equal(c.state().opened, true); assert.equal(c.state().activeId, 'files');
  assert.equal(c.state().tabs.length, 1);
  assert.equal(c.state().all.filter(item => item.id === 'files').length, 1);
});

test('explicit selection of a shared tool never overwrites another conversation page', () => {
  const { c } = fixture();
  const a = c.add({ id: 'a', ownerConversationId: 'a', url: 'https://a.test/' });
  c.addGlobal('files'); c.activate(a.id); c.switchTo('b');
  assert.equal(c.state().activeId, null); assert.equal(c.state().opened, false);
  c.switchTo('a'); assert.equal(c.state().activeId, a.id);
  c.switchTo('b'); c.activate('files'); c.switchTo('a');
  assert.equal(c.state().activeId, a.id, 'another conversation keeps its own selection');
  c.switchTo('b'); assert.equal(c.state().activeId, 'files'); assert.equal(c.state().opened, true);
});

test('a late native create is assigned to its initiating conversation and cannot steal focus', async () => {
  const { c, calls, flush } = fixture();
  const pending = c.createBrowser('https://a.test/'); await flush();
  assert.equal(calls[0].conversationId, 'a');
  c.switchTo('b'); c.completeCreate({ id: 'late-a', url: 'https://a.test/' });
  await pending;
  assert.equal(c.state().tabs.length, 0); assert.equal(c.state().activeId, null);
  assert.equal(c.state().opened, false);
  c.switchTo('a');
  assert.equal(c.state().tabs[0].browserId, 'late-a');
});

test('a pending browser open in one conversation does not block opening another conversation page', async () => {
  const { c, calls, flush } = fixture();
  const a = c.createBrowser('https://a.test/'); await flush();
  c.switchTo('b'); c.open(); const b = c.createBrowser('https://b.test/'); await flush();
  assert.deepEqual(calls.map(call => call.conversationId), ['a', 'b']);
  c.completeCreate({ id: 'b', url: 'https://b.test/' }, 'b'); await b;
  c.completeCreate({ id: 'a', url: 'https://a.test/' }); await a;
  assert.equal(c.state().tabs.length, 1); assert.equal(c.state().tabs[0].browserId, 'b');
  assert.equal(c.state().activeId, c.state().tabs[0].id);
});

test('unknown owner events stay hidden and releasing AI does not make an owned page global', () => {
  const { c } = fixture();
  c.add({ id: 'unknown', url: 'https://unknown.test/' });
  const a = c.add({ id: 'a', ownerConversationId: 'a', url: 'https://a.test/' });
  c.add({ id: 'a', conversationId: null, title: 'released' });
  assert.equal(a.browserConversationId, 'a');
  c.switchTo('b'); assert.equal(c.state().tabs.length, 0);
  c.add({ id: 'unknown', ownerConversationId: 'a', title: 'known' });
  c.switchTo('a'); assert.equal(c.state().tabs.length, 2);
});

test('closed-page history is scoped, including manually opened pages without a conversation', () => {
  const { c } = fixture();
  c.closed().push('https://a.test/'); c.switchTo('b');
  assert.equal(c.closed().length, 0); c.closed().push('https://b.test/');
  c.switchTo('a'); assert.equal(c.closed()[0], 'https://a.test/');
  c.switchTo(null);
  c.add({ id: 'manual', ownerConversationId: null, url: 'https://manual.test/' });
  assert.equal(c.state().tabs.length, 1); assert.equal(c.closed().length, 0);
  c.switchTo('a'); assert.equal(c.state().tabs.length, 0);
});

test('manual maximization is per conversation while the saved width preference is shared', () => {
  const { c } = fixture();
  c.addGlobal('files'); c.activate('files'); c.resize(560); c.maximize();
  c.switchTo('b');
  assert.equal(c.state().opened, false); assert.equal(c.state().maximized, false);
  assert.equal(c.state().preferredWidth, 560);
  c.open('files'); c.resize(460);
  c.switchTo('a');
  assert.equal(c.state().opened, true); assert.equal(c.state().maximized, true);
  assert.equal(c.state().preferredWidth, 460, 'the latest application width preference applies to restored panels');
  assert.equal(c.state().restoreWidth, 460);
  c.switchTo('b');
  assert.equal(c.state().opened, true); assert.equal(c.state().maximized, false);
  assert.equal(c.state().preferredWidth, 460);
});

test('automatic maximization is recalculated instead of being remembered as a manual choice', () => {
  const { c } = fixture();
  c.addGlobal('files'); c.activate('files'); c.maximize({ automatic: true });
  c.switchTo('b'); c.switchTo('a');
  assert.equal(c.state().opened, true);
  assert.equal(c.state().maximized, false);
  assert.equal(c.state().automaticMaximized, false);
});

test('changing the working directory within one conversation preserves its panel presentation', () => {
  const { c } = fixture();
  const a = c.add({ id: 'a', ownerConversationId: 'a', url: 'https://a.test/' });
  c.activate(a.id); c.maximize();
  c.switchTo('a', 'C:/Changed project');
  assert.equal(c.state().activeId, a.id); assert.equal(c.state().opened, true);
  assert.equal(c.state().maximized, true);
  assert.deepEqual(Array.from(c.state().dismissed), []);
});

test('switching cancels a pending drag before storing the old conversation presentation', () => {
  const { c } = fixture();
  c.addGlobal('files'); c.activate('files'); c.resize(460); c.maximize();
  c.startDrag(); c.switchTo('b');
  assert.equal(c.state().opened, false); assert.equal(c.state().maximized, false);
  c.switchTo('a');
  assert.equal(c.state().opened, true); assert.equal(c.state().maximized, true);
  assert.equal(c.state().restoreWidth, 460);
});

test('an explicit open synchronizes ownership before updating a conversation expanded state', () => {
  const { c } = fixture();
  c.close(); c.changeReadContext('b'); c.open('files');
  assert.equal(c.state().opened, true); assert.equal(c.state().activeId, 'files');
  c.switchTo('a'); assert.equal(c.state().opened, false);
  c.switchTo('b'); assert.equal(c.state().opened, true); assert.equal(c.state().activeId, 'files');
});

test('history loading invalidates delayed creates and temporarily blocks automatic presentation', async () => {
  const { c, flush } = fixture();
  const a = c.add({ id: 'selected-a', ownerConversationId: 'a', url: 'https://a.test/' });
  c.activate(a.id);
  const pending = c.createBrowser('https://a.test/late'); await flush();
  const revision = c.state().navigationRevision;
  c.beginLoading();
  assert.equal(c.state().contextLoading, true);
  assert.ok(c.state().navigationRevision > revision);
  c.close();
  assert.equal(c.state().opened, true, 'loading cannot overwrite the source conversation expanded preference');
  assert.deepEqual(Array.from(c.state().dismissed), [], 'loading cannot mark the source conversation deliberately closed');
  c.present({ conversationId: 'a', reveal: true, tab: { id: 'auto-a', ownerConversationId: 'a', revision: 1 } });
  c.completeCreate({ id: 'late-a', ownerConversationId: 'a', url: 'https://a.test/late' });
  await pending;
  assert.equal(c.state().activeId, a.id, 'in-flight work cannot change the pending history presentation');
  c.open('files'); assert.equal(c.state().activeId, a.id);
  c.switchTo('b');
  assert.equal(c.state().contextLoading, false); assert.equal(c.state().opened, false);
  assert.equal(c.state().activeId, null);
  c.switchTo('a');
  assert.equal(c.state().opened, true); assert.equal(c.state().activeId, a.id);
  assert.deepEqual(Array.from(c.state().dismissed), []);
  c.close();
  assert.equal(c.state().opened, false);
  assert.deepEqual(Array.from(c.state().dismissed), ['a'], 'the close action is available again after loading finishes');
});

test('failed history loading restores the same conversation without marking it dismissed', () => {
  const { c } = fixture();
  const a = c.add({ id: 'a', ownerConversationId: 'a', url: 'https://a.test/' });
  c.activate(a.id); c.beginLoading(); c.finishLoading();
  assert.equal(c.state().contextLoading, false); assert.equal(c.state().opened, true);
  assert.equal(c.state().activeId, a.id);
  assert.deepEqual(Array.from(c.state().dismissed), []);
});

test('an interrupted file refresh retries after history loading fails and ignores its stale result', async () => {
  const { c, fileRequests, flush } = fixture({ holdFiles: true });
  c.open('files'); await flush();
  assert.equal(fileRequests.length, 1); assert.equal(c.state().loadingFiles, true);
  c.beginLoading();
  assert.equal(c.state().loadingFiles, false);
  await c.refreshFiles(); assert.equal(fileRequests.length, 1, 'hidden loading state must not start another read');
  c.finishLoading(); await flush();
  assert.equal(fileRequests.length, 2, 'failed history loading restarts the interrupted file listing');
  assert.equal(c.state().loadingFiles, true);
  fileRequests[0].resolve({ ok: true, entries: [{ path: 'stale.txt' }] }); await flush();
  assert.equal(c.state().loadingFiles, true, 'the obsolete read cannot clear the current read lock');
  assert.equal(c.state().fileEntries.length, 0);
  fileRequests[1].resolve({ ok: true, entries: [{ path: 'current.txt' }] }); await flush();
  assert.equal(c.state().loadingFiles, false);
  assert.equal(c.state().fileEntries[0][1][0].path, 'current.txt');
});

test('automatic browser presentation opens only its owner conversation panel', () => {
  const { c } = fixture(); c.hide();
  c.present({ conversationId: 'a', tab: { id: 'auto-a', ownerConversationId: 'a', revision: 1 } });
  assert.equal(c.state().opened, true);
  const active = c.state().activeId;
  c.switchTo('b'); assert.equal(c.state().opened, false);
  c.present({ conversationId: 'a', reveal: true, tab: { id: 'background-a', ownerConversationId: 'a', revision: 2 } });
  assert.equal(c.state().opened, false); assert.equal(c.state().activeId, null);
  c.switchTo('a'); assert.equal(c.state().opened, true); assert.equal(c.state().activeId, active);
});
