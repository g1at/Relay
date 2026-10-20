'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const feedback = require('../renderer/browser-feedback');

test('a delayed browser recovery notification remains assigned to its original conversation', async () => {
  const nodes = [], notices = [], restored = [];
  let conversationId = 'task-a', finish;
  const document = { body: { append() {} }, createElement(tag) {
    const node = { tag, textContent: '', children: [], handlers: new Map(),
      setAttribute() {}, append(...items) { this.children.push(...items); },
      addEventListener(name, callback) { this.handlers.set(name, callback); },
      showModal() {}, close() {}, remove() {} };
    nodes.push(node); return node;
  } };
  const controller = feedback.create({ document, getContext: () => ({ conversationId }),
    api: { invoke: async request => {
      if (request.action === 'taskTabs.list') return { ok: true, tabs: [{ title: 'A page', url: 'https://a.test/' }] };
      assert.equal(request.action, 'restoreTaskTabs'); assert.equal(request.conversationId, 'task-a');
      return new Promise(resolve => { finish = resolve; });
    } },
    notify: (message, source) => notices.push({ message, source }),
    onRestored: (tabs, owner) => restored.push({ tabs, owner }) });
  await controller.recovery();
  const button = nodes.find(node => node.tag === 'button' && node.textContent === '恢复网页并保持暂停');
  assert.ok(button);
  const pending = button.handlers.get('click')();
  conversationId = 'task-b'; controller.contextChanged();
  finish({ ok: true, tabs: [{ id: 'restored-a', ownerConversationId: 'task-a', url: 'https://a.test/' }] });
  await pending;
  assert.equal(restored[0].owner, 'task-a');
  assert.equal(notices[0].source?.conversationId, 'task-a', 'notification must not fall back to whichever task is visible after restoration');
  assert.equal(notices[0].source?.id, 'restored-a');
  controller.dispose();
});
