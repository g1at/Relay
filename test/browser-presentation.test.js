'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/workspace-panel.js'), 'utf8');
const controls = source.slice(source.indexOf('  function renderBrowserAutomation()'), source.indexOf('  async function browserAutomationControl('));
const geometry = source.slice(source.indexOf('  function visibleElement('), source.indexOf('  function nativeDesired('));
function fixture() {
  const nodes = new Map(), shown = [], registered = [], states = new Map(), closed = new Set(), tabs = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { hidden: false, dataset: {}, textContent: '', title: '' }); return nodes.get(id); };
  const box = { left: 700, right: 1200, top: 100, bottom: 700, width: 500, height: 600 };
  const sandbox = { browserAutomationStates: states, browserAutomationRequested: new Set(['a']), closedBrowserIds: closed,
    browserTabStatus: { get: () => ({ label: '批注已加入草稿', detail: '旧反馈说明', kind: 'feedback' }) },
    app: { dataset: { view: 'chat' } }, context: { conversationId: 'task-a' }, activeTab: () => ({ kind: 'browser', browserId: 'a', browser: { url: 'https://example.test/' } }),
    $: node, scheduleNative() {}, renderTabs() {}, activeId: null,
    browserTab: id => tabs.get(id), showBrowserTab: value => shown.push(value),
    applyBrowserState: value => { registered.push(value); if (!tabs.has(value.id)) tabs.set(value.id, {}); return tabs.get(value.id); },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), document: { querySelectorAll: () => [] },
    disposed: false, opened: true, contextLoading: false, browserPresentationDismissed: new Set() };
  vm.createContext(sandbox);
  vm.runInContext(controls + '\n' + geometry + '\nglobalThis.api={mergeBrowserAutomationState,presentAutomationTab,renderBrowserAutomation,overlayObscuresBrowser};', sandbox);
  const overlay = ({ rect = box, modal = false, hidden = false, ancestorModal = false, connected = true } = {}) => ({
    isConnected: connected, hidden,
    matches: selector => selector.includes('dialog:modal') ? modal : true,
    closest: selector => selector.startsWith('[hidden]') ? null : ancestorModal ? {} : null,
    getBoundingClientRect: () => rect,
  });
  return { ...sandbox.api, states, closed, shown, registered, nodes, sandbox, overlay, box };
}

test('a menu confined to chat leaves the native page visible; an overlapping menu obscures it', () => {
  const f = fixture();
  assert.equal(f.overlayObscuresBrowser(f.overlay({ rect: { left: 10, right: 350, top: 100, bottom: 300, width: 340, height: 200 } }), f.box), false);
  assert.equal(f.overlayObscuresBrowser(f.overlay({ rect: { left: 650, right: 800, top: 100, bottom: 300, width: 150, height: 200 } }), f.box), true);
  assert.equal(f.overlayObscuresBrowser(f.overlay({ rect: { left: 500, right: 700, top: 100, bottom: 300, width: 200, height: 200 } }), f.box), false);
});
test('a real modal blocks input even beside the browser; hidden and detached modals do not', () => {
  const f = fixture(), rect = { left: 20, right: 300, top: 100, bottom: 300, width: 280, height: 200 };
  assert.equal(f.overlayObscuresBrowser(f.overlay({ rect, modal: true }), f.box), true);
  assert.equal(f.overlayObscuresBrowser(f.overlay({ rect, ancestorModal: true }), f.box), true);
  assert.equal(f.overlayObscuresBrowser(f.overlay({ rect, modal: true, hidden: true }), f.box), false);
  assert.equal(f.overlayObscuresBrowser(f.overlay({ rect, modal: true, connected: false }), f.box), false);
});
test('a late resume reply cannot override a later takeover event or the visible pause status', () => {
  const f = fixture();
  assert.equal(f.mergeBrowserAutomationState({ id: 'a', conversationId: 'task-a', state: 'controlled', revision: 20 }), true);
  assert.equal(f.mergeBrowserAutomationState({ id: 'a', conversationId: 'task-a', state: 'paused', reason: '你已操作浏览器', revision: 22 }), true);
  assert.equal(f.mergeBrowserAutomationState({ id: 'a', conversationId: 'task-a', state: 'controlled', revision: 21 }), false);
  assert.equal(f.mergeBrowserAutomationState({ id: 'a', conversationId: 'task-a', state: 'controlled' }), false);
  f.renderBrowserAutomation();
  assert.equal(f.nodes.get('workspaceBrowserAutomationStatus').textContent, '已暂停 · 由你控制');
  assert.equal(f.nodes.get('workspaceBrowserAutomationStatus').title, '你已操作浏览器');
  assert.equal(f.nodes.get('workspaceBrowserAutomationControl').textContent, '允许继续');
  assert.equal(f.mergeBrowserAutomationState({ id: 'a', conversationId: 'task-a', state: 'controlled', revision: 23 }), true);
  f.renderBrowserAutomation();
  assert.equal(f.nodes.get('workspaceBrowserAutomationControl').textContent, '接管');
});
test('initial state reads, duplicate events and unversioned restoration do not roll state back', () => {
  const f = fixture();
  f.mergeBrowserAutomationState({ id: 'a', state: 'working', revision: 4 });
  assert.equal(f.mergeBrowserAutomationState({ id: 'a', state: 'controlled', revision: 2 }), false);
  assert.equal(f.mergeBrowserAutomationState({ id: 'a', state: 'paused', revision: 4 }), false);
  assert.equal(f.mergeBrowserAutomationState({ id: 'a', state: 'paused' }), false);
  assert.equal(f.states.get('a').state, 'working');
});
test('closed pages reject delayed control responses and presentation requests', () => {
  const f = fixture(); f.closed.add('a');
  assert.equal(f.mergeBrowserAutomationState({ id: 'a', state: 'controlled', revision: 10 }), false);
  assert.equal(f.presentAutomationTab({ conversationId: 'task-a', tab: { id: 'a', revision: 10 } }), false);
  assert.equal(f.shown.length + f.registered.length, 0);
});
test('a current request reveals its task page but background tasks do not switch the visible page', () => {
  const f = fixture(); f.mergeBrowserAutomationState({ id: 'a', state: 'working', revision: 5 });
  assert.equal(f.presentAutomationTab({ conversationId: 'task-a', tab: { id: 'a', revision: 5 } }), true);
  assert.equal(f.shown.length, 1, 'same revision working event must not block showing');
  f.presentAutomationTab({ conversationId: 'task-b', tab: { id: 'b', revision: 6 } });
  assert.equal(f.shown.length, 1); assert.equal(f.registered.at(-1).id, 'b');
});
test('later automation activity does not reopen a collapsed panel; explicit focus can reveal it', () => {
  const f = fixture();
  const event = { conversationId: 'task-a', tab: { id: 'a', revision: 1 } };
  f.presentAutomationTab(event);
  f.presentAutomationTab(event);
  assert.equal(f.shown.length, 1);
  f.presentAutomationTab({ ...event, reveal: true });
  assert.equal(f.shown.length, 2);
});
test('closing a conversation sidebar also suppresses newly opened AI pages until explicit focus', () => {
  const f = fixture();
  f.sandbox.opened = false;
  f.sandbox.browserPresentationDismissed.add('task-a');
  f.presentAutomationTab({ conversationId: 'task-a', tab: { id: 'new-a', revision: 1 } });
  assert.equal(f.registered.at(-1).id, 'new-a');
  assert.equal(f.shown.length, 0);
  f.presentAutomationTab({ conversationId: 'task-a', reveal: true, tab: { id: 'new-a', revision: 1 } });
  assert.equal(f.shown.length, 1);
});
test('dismissing one conversation does not suppress the first page of another conversation', () => {
  const f = fixture();
  f.sandbox.opened = false;
  f.sandbox.browserPresentationDismissed.add('task-a');
  f.sandbox.context = { conversationId: 'task-b' };
  f.presentAutomationTab({ conversationId: 'task-b', tab: { id: 'new-b', revision: 1 } });
  assert.equal(f.shown.length, 1);
});
test('an old show request cannot reopen a page after later control changes', () => {
  const f = fixture(); f.mergeBrowserAutomationState({ id: 'a', state: 'controlled', revision: 5 });
  assert.equal(f.presentAutomationTab({ conversationId: 'task-a', revision: 4, tab: { id: 'a' } }), false);
  f.mergeBrowserAutomationState({ id: 'a', state: 'paused', revision: 6 });
  assert.equal(f.presentAutomationTab({ conversationId: 'task-a', revision: 6, tab: { id: 'a' } }), false);
  assert.equal(f.shown.length, 0);
});

test('same-task presentation cannot steal the settings view or reopen a hidden window', () => {
  const f = fixture();
  f.sandbox.app.dataset.view = 'settings';
  f.presentAutomationTab({ conversationId: 'task-a', tab: { id: 'a', revision: 1 } });
  assert.equal(f.shown.length, 0); assert.equal(f.registered.length, 1);
  f.sandbox.app.dataset.view = 'chat'; f.sandbox.document.hidden = true;
  f.presentAutomationTab({ conversationId: 'task-a', tab: { id: 'b', revision: 2 } });
  assert.equal(f.shown.length, 0); assert.equal(f.registered.length, 2);
});
