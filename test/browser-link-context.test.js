'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const markdown = fs.readFileSync(path.join(__dirname, '../renderer/read-only-markdown.js'), 'utf8');
const interactions = fs.readFileSync(path.join(__dirname, '../renderer/interaction-surface.js'), 'utf8');
const segment = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function markdownFixture({ preferred = false } = {}) {
  let current = 'task-a';
  const calls = [], listeners = new Map();
  const root = { relayConversationWorkspace: () => ({ conversationId: current }),
    api: { openExternal: (...args) => { calls.push(args); return Promise.resolve({ ok: true }); } } };
  if (preferred) root.relayBrowserSettings = { openLink: url => { calls.push(['preferred', url]); return Promise.resolve({ ok: true }); } };
  const sandbox = { root, bound: new WeakSet(), URL };
  vm.runInNewContext(segment(markdown, '  function externalHref(', '  function sanitize(') + '\nglobalThis.bind=bindLinks;', sandbox);
  const container = { contains: () => true, addEventListener: (name, callback) => listeners.set(name, callback) };
  sandbox.bind(container);
  return { calls, context(value) { current = value; }, click() {
    const link = { getAttribute: () => 'https://example.test/' };
    listeners.get('click')({ type: 'click', target: { closest: () => link }, preventDefault() {}, stopPropagation() {} });
  } };
}

test('read-only Markdown fallback passes the conversation that owned the click', () => {
  const f = markdownFixture(); f.click(); f.context('task-b');
  assert.equal(f.calls[0][0], 'https://example.test/');
  assert.equal(f.calls[0][1].conversationId, 'task-a');
});

test('read-only Markdown retains the normal browser preference route', () => {
  const f = markdownFixture({ preferred: true }); f.click();
  assert.deepEqual(f.calls, [['preferred', 'https://example.test/']]);
});

function interactionFixture({ preferred = false } = {}) {
  let current = 'task-a', finish;
  const calls = [], responses = [];
  const window = { relayConversationWorkspace: () => ({ conversationId: current }),
    api: { openExternal: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } } };
  if (preferred) window.relayWorkspacePanel = { openUrl: url => { calls.push(['preferred', url]); return Promise.resolve({ ok: true }); } };
  const element = () => ({ dataset: {}, children: [], listeners: new Map(),
    appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
    addEventListener(name, callback) { this.listeners.set(name, callback); } });
  const sandbox = { window, URL, element, button: element, getDraft: () => ({}),
    isVisibleInteraction: item => current === item.conversationId, isInteractionBusy: () => false,
    state: { busyIds: new Set(), errors: new Map() }, setCurrentBusyState() {},
    respond: async item => { if (current === item.conversationId) responses.push(item.id); } };
  vm.runInNewContext(segment(interactions, '  function renderElicitation(', '  function resizeOtherInput(') + '\nglobalThis.render=renderElicitation;', sandbox);
  const form = sandbox.render({ id: 'request-a', conversationId: 'task-a', elicitation: { mode: 'url', url: 'https://example.test/authorize' } }, false);
  return { calls, responses, submit: () => form.listeners.get('submit')({ preventDefault() {} }),
    context(value) { current = value; }, finish: () => finish({ ok: true }) };
}

test('URL interaction fallback captures the conversation before waiting for browser opening', async () => {
  const f = interactionFixture(), pending = f.submit();
  f.context('task-b'); f.finish(); await pending;
  assert.equal(f.calls[0][0], 'https://example.test/authorize');
  assert.equal(f.calls[0][1].conversationId, 'task-a');
  assert.deepEqual(f.responses, []);
});

test('URL interaction retains the workspace browser route when available', async () => {
  const f = interactionFixture({ preferred: true }); await f.submit();
  assert.deepEqual(f.calls, [['preferred', 'https://example.test/authorize']]);
  assert.deepEqual(f.responses, ['request-a']);
});
