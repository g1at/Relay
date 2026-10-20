'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../src/main/browser/browser-panel-ipc');
function fixture() {
  const entryFile = path.resolve(__dirname, '../renderer/index.html'), url = pathToFileURL(entryFile).href;
  const handlers = new Map(), sent = [];
  const contents = { mainFrame: { url }, getURL: () => url, isDestroyed: () => false,
    send(_channel, payload) { sent.push(payload); } };
  const owner = { webContents: contents, isDestroyed: () => false };
  let host, sequence = 0;
  const registry = registerBrowserPanelIpc({ entryFile, getWindow: () => owner,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getElectron: () => ({}), getConversationContext: async () => ({ cwd: '/trusted/task' }),
    createHost(options) {
      const tab = { id: 'tab', presented: true, webContents: { isDestroyed: () => false, getURL: () => 'https://example.test/' } };
      host = { isDestroyed: () => false, destroy() {}, getAutomationTarget: id => id === 'tab' ? tab : null,
        setTaskBinding() {}, cancelAnnotation: () => ({ ok: true }), captureAnnotationTarget: () => () => true,
        invoke: async () => ({ ok: true }), emit: payload => options.onEvent(payload),
        startAnnotation(id, input) {
          const requestId = 'selection-' + ++sequence;
          options.onEvent({ type: 'manual-action', id, action: 'annotation' });
          input.onPaused({ requestId });
          return Promise.resolve({ ok: true, id, requestId });
        },
      }; return host;
    },
  });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const invoke = input => handlers.get('browser:invoke')(event, input);
  const control = command => invoke({ action: 'automation', id: 'tab', conversationId: 'task-a', command });
  const start = async (complete = true) => {
    const started = await invoke({ action: 'annotation.start', id: 'tab', conversationId: 'task-a' });
    assert.equal(started.ok, true);
    if (complete) host.emit({ type: 'annotation', id: 'tab', conversationId: 'task-a', requestId: started.requestId });
    return { started, resume: sent.findLast(item => item.type === 'annotation' && item.requestId === started.requestId)?.browserResume };
  };
  return { registry, invoke, control, start, sent, event, handlers, host: () => host };
}
test('completed feedback from AI control resumes exactly once and only through trusted UI', async t => {
  const f = fixture(); t.after(() => f.registry.dispose()); await f.control('claim');
  const { resume } = await f.start(); assert.ok(resume); assert.equal((await f.control('state')).state, 'paused');
  const input = { action: 'resumeFeedback', ...resume };
  assert.equal((await f.handlers.get('browser:invoke')({ sender: {}, senderFrame: {} }, input)).code, 'FORBIDDEN');
  assert.equal((await f.invoke(input)).state, 'controlled');
  assert.equal((await f.invoke(input)).code, 'STALE_LEASE');
});
test('previously paused pages and unsuccessful selections never create feedback authority', async t => {
  const f = fixture(); t.after(() => f.registry.dispose()); await f.control('claim'); await f.control('pause');
  assert.equal((await f.start()).resume, undefined);
  await f.control('resume'); const { started } = await f.start(false);
  const current = await f.control('state');
  const guessed = { action: 'resumeFeedback', id: 'tab', conversationId: 'task-a', requestId: started.requestId, controlRevision: current.controlRevision };
  assert.equal((await f.invoke(guessed)).code, 'STALE_LEASE', 'selection must have completed');
  f.host().emit({ type: 'annotation-error', id: 'tab', requestId: started.requestId });
  f.host().emit({ type: 'annotation', id: 'tab', conversationId: 'task-a', requestId: started.requestId });
  assert.equal(f.sent.at(-1).browserResume, undefined);
  assert.equal((await f.invoke(guessed)).code, 'STALE_LEASE');
});
for (const interruption of ['manual-pointer', 'manual-keyboard', 'pause', 'cancel', 'discard-dialog', 'new-selection', 'task-switch', 'navigation']) {
  test(`feedback authority expires after ${interruption}`, async t => {
    const f = fixture(); t.after(() => f.registry.dispose()); await f.control('claim'); const { resume } = await f.start(); assert.ok(resume);
    if (interruption.startsWith('manual-')) f.host().emit({ type: 'manual-action', id: 'tab', action: interruption.slice(7) });
    if (interruption === 'pause') await f.control('pause');
    if (interruption === 'cancel') await f.invoke({ action: 'annotation.cancel', id: 'tab' });
    if (interruption === 'discard-dialog') await f.invoke({ action: 'cancelFeedback', ...resume });
    if (interruption === 'new-selection') await f.start();
    if (interruption === 'task-switch') await f.invoke({ action: 'automationPauseConversation', conversationId: 'task-a' });
    if (interruption === 'navigation') f.host().emit({ type: 'navigation-start', id: 'tab' });
    assert.equal((await f.invoke({ action: 'resumeFeedback', ...resume })).code, 'STALE_LEASE');
    assert.equal((await f.control('state')).state, 'paused');
  });
}
test('a completed old run does not invalidate the next user feedback send, but forged fields do', async t => {
  const f = fixture(); t.after(() => f.registry.dispose()); await f.control('claim'); const { resume } = await f.start();
  f.registry.automationPauseConversation('task-a', 'run-finished');
  for (const change of [{ conversationId: 'other' }, { id: 'other' }, { controlRevision: resume.controlRevision + 1 }, { requestId: 'other' }]) {
    assert.equal((await f.invoke({ action: 'resumeFeedback', ...resume, ...change })).code, 'STALE_LEASE');
  }
  assert.equal((await f.invoke({ action: 'resumeFeedback', ...resume })).state, 'controlled');
});

test('consecutive completed annotations renew the same AI-owned page permission and invalidate the older note', async t => {
  const f = fixture(); t.after(() => f.registry.dispose()); await f.control('claim');
  const first = (await f.start()).resume, second = (await f.start()).resume;
  assert.ok(first); assert.ok(second); assert.notEqual(first.requestId, second.requestId);
  assert.equal((await f.invoke({ action: 'resumeFeedback', ...first })).code, 'STALE_LEASE');
  assert.equal((await f.invoke({ action: 'resumeFeedback', ...second })).state, 'controlled');
});

test('only the first manual input after feedback invalidates authority; repeated paused typing is state-free', async t => {
  const f = fixture(); t.after(() => f.registry.dispose()); await f.control('claim'); const { resume } = await f.start();
  const manual = { type: 'manual-action', id: 'tab', action: 'keyboard', tab: { recovery: { state: 'paused' } } };
  f.host().emit(manual); const afterFirst = await f.control('state');
  assert.ok(afterFirst.controlRevision > resume.controlRevision);
  const stateEvents = f.sent.filter(item => item.type === 'automation-state').length;
  for (let i = 0; i < 25; i++) f.host().emit(manual);
  assert.equal((await f.control('state')).controlRevision, afterFirst.controlRevision);
  assert.equal(f.sent.filter(item => item.type === 'automation-state').length, stateEvents);
});
