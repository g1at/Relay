'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerMiniLocalImages } = require('../src/main/app/mini-local-images');

function fixture(readImage = async () => ({ ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })) {
  const sender = { mainFrame: { url: 'file:///mini.html' } }, event = { sender }; event.senderFrame = sender.mainFrame;
  const state = { id: 'one', calls: [] }; let handler;
  registerMiniLocalImages({ ipcMain: { handle: (_, fn) => { handler = fn; } },
    isCaller: e => e?.sender === sender && e.senderFrame === sender.mainFrame,
    getConversationId: () => state.id,
    readImage: async input => { state.calls.push(input); return readImage(input); },
  });
  return { state, sender, event, call: (input, e = event) => handler(e, input) };
}
test('mini image reads are bound to the host conversation and exclude arbitrary root overrides', async () => {
  const h = fixture();
  assert.equal((await h.call({ href: 'preview.png', context: { conversationId: 'one', workingDir: 'secret' }, roots: ['secret'] })).ok, true);
  assert.deepEqual(h.state.calls[0], { href: 'preview.png', basePath: undefined, context: { conversationId: 'one' } });
  assert.equal((await h.call({ href: 'x.png', context: { conversationId: 'two' } })).ok, false);
  assert.equal((await h.call({ href: 'x.png' }, { sender: h.sender, senderFrame: {} })).ok, false);
  assert.equal((await h.call({ href: 'x.png' }, { sender: {}, senderFrame: {} })).ok, false);
  h.state.id = null; assert.equal((await h.call({ href: 'x.png' })).ok, false);
  assert.equal(h.state.calls.length, 1);
});
test('a pending mini bitmap cannot be delivered to another conversation or document', async () => {
  for (const change of [h => { h.state.id = 'two'; }, h => { h.sender.mainFrame = {}; }]) {
    let release; const h = fixture(() => new Promise(resolve => { release = resolve; }));
    const pending = h.call({ href: 'preview.png' }); change(h); release({ ok: true, dataUrl: 'sensitive' });
    assert.equal((await pending).ok, false);
  }
});
test('filesystem failures are reduced to a safe unavailable-image response', async () => {
  const h = fixture(async () => { throw Error('private path'); });
  const result = await h.call({ href: 'unknown.png' });
  assert.equal(result.code, 'IMAGE_UNAVAILABLE'); assert.equal(JSON.stringify(result).includes('private path'), false);
});
