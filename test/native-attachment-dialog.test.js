'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerNativeAttachmentDialog, CHANNEL } = require('../native-attachment-dialog');

function fixture(t, options = {}) {
  const sender = new EventEmitter(), window = new EventEmitter(), requests = [], stats = [], reads = [], removed = [];
  sender.mainFrame = { url: 'file:///D:/synthetic/renderer/index.html' }; sender.isDestroyed = () => !!sender.destroyed;
  window.webContents = sender; window.isDestroyed = () => !!window.destroyed;
  // Electron owns modality, enabled state and focus. Any manual manipulation fails this fixture.
  for (const method of ['getNativeWindowHandle', 'isEnabled', 'setEnabled', 'focus']) window[method] = () => { throw Error('Unexpected manual owner manipulation: ' + method); };
  let handler, currentWindow = window;
  const ipcMain = { handle(name, fn) { assert.equal(name, CHANNEL); handler = fn; }, removeHandler(name) { removed.push(name); } };
  const dialog = options.unavailable ? {} : { showOpenDialog(owner, input) {
    if (options.showDialog) return options.showDialog(owner, input);
    return new Promise((resolve, reject) => requests.push({ owner, input, resolve, reject }));
  } };
  const filesystem = { promises: {
    realpath: async input => { reads.push(input); return options.realpath ? options.realpath(input) : input; },
    stat: async input => { stats.push(input); return options.stat ? options.stat(input) : { isDirectory: () => /folder$/i.test(input), isFile: () => !/special$/i.test(input), size: 42 }; },
  } };
  const service = registerNativeAttachmentDialog({ ipcMain, getWindow: () => currentWindow, rendererURL: sender.mainFrame.url,
    platform: options.platform || 'win32', fs: filesystem, dialog });
  t.after(() => service.dispose());
  const event = { sender, senderFrame: sender.mainFrame };
  return { service, sender, window, event, requests, stats, reads, removed, dialog,
    replaceWindow(value) { currentWindow = value; }, call: (input, alternateEvent = event) => handler(alternateEvent, input) };
}
const complete = (h, paths = [], index = 0) => h.requests[index].resolve({ canceled: false, filePaths: paths });

test('files call Electron directly with the real owner and untouched system controls', async t => {
  const h = fixture(t), initialPath = 'D:\\资料\\$(literal);`name🙂', result = h.call({ defaultPath: initialPath });
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].owner, h.window);
  assert.deepEqual(h.requests[0].input, { title: '选择文件', properties: ['openFile', 'multiSelections'], defaultPath: initialPath });
  complete(h, ['D:\\Synthetic\\报告🙂.MD', 'D:\\Synthetic\\second.txt']);
  assert.deepEqual(await result, [
    { path: 'D:\\Synthetic\\报告🙂.MD', name: '报告🙂.MD', ext: 'md', isDirectory: false, size: 42 },
    { path: 'D:\\Synthetic\\second.txt', name: 'second.txt', ext: 'txt', isDirectory: false, size: 42 },
  ]);
  assert.equal(h.sender.listenerCount('destroyed'), 0); assert.equal(h.window.listenerCount('closed'), 0);
});

test('folders use a separate native multi-directory mode and preserve metadata', async t => {
  const h = fixture(t), result = h.call({ kind: 'folders' });
  assert.deepEqual(h.requests[0].input, { title: '选择文件夹', properties: ['openDirectory', 'multiSelections'] });
  assert.equal(h.requests[0].owner, h.window); complete(h, ['D:\\Synthetic\\Folder', 'D:\\Other\\Folder']);
  assert.deepEqual(await result, [
    { path: 'D:\\Synthetic\\Folder', name: 'Folder', ext: 'folder', isDirectory: true, size: 0 },
    { path: 'D:\\Other\\Folder', name: 'Folder', ext: 'folder', isDirectory: true, size: 0 },
  ]);
});

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} never combines openFile and openDirectory flags`, async t => {
    const h = fixture(t, { platform });
    for (const [index, kind] of ['files', 'folders'].entries()) {
      const result = h.call({ kind });
      assert.deepEqual(h.requests[index].input.properties, [kind === 'files' ? 'openFile' : 'openDirectory', 'multiSelections']);
      assert.deepEqual(Object.keys(h.requests[index].input).sort(), ['properties', 'title']);
      complete(h, [], index); assert.deepEqual(await result, []);
    }
  });
}

test('cancellation returns no attachments or filesystem reads and releases the invocation', async t => {
  const h = fixture(t), result = h.call(); h.requests[0].resolve({ canceled: true, filePaths: ['D:\\discarded.txt'] });
  assert.deepEqual(await result, []); assert.deepEqual(h.reads, []); assert.deepEqual(h.stats, []);
  const next = h.call(); complete(h, [], 1); await next;
});

test('canonical aliases and case variations produce one attachment', async t => {
  const h = fixture(t, { realpath: async () => 'D:\\Canonical\\same.TXT' }), result = h.call();
  complete(h, ['D:\\alias.txt', 'D:\\ALIAS.TXT', 'D:\\Canonical\\same.TXT']);
  const items = await result; assert.equal(items.length, 1); assert.equal(items[0].path, 'D:\\Canonical\\same.TXT'); assert.equal(h.stats.length, 1);
});

test('iframe, remote document and another renderer cannot open a dialog', async t => {
  const h = fixture(t);
  await assert.rejects(h.call({}, { sender: h.sender, senderFrame: { url: h.sender.mainFrame.url } }), { code: 'UNTRUSTED_SENDER' });
  const other = new EventEmitter(); other.isDestroyed = () => false; other.mainFrame = { url: h.sender.mainFrame.url };
  await assert.rejects(h.call({}, { sender: other, senderFrame: other.mainFrame }), { code: 'UNTRUSTED_SENDER' });
  h.sender.mainFrame.url = 'https://invalid.example/'; await assert.rejects(h.call(), { code: 'UNTRUSTED_SENDER' }); assert.equal(h.requests.length, 0);
});

test('invalid kind and initial paths never reach the native API', async t => {
  const h = fixture(t);
  for (const kind of ['mixed', 'directory', true, [], {}]) await assert.rejects(h.call({ kind }), { code: 'INVALID_KIND' });
  for (const defaultPath of ['relative', 'D:\\bad\0name', 3, ['D:\\Folder']]) await assert.rejects(h.call({ defaultPath }), { code: 'INVALID_PATH' });
  assert.equal(h.requests.length, 0);
});

test('only one native dialog may remain pending for a renderer', async t => {
  const h = fixture(t), first = h.call(); await assert.rejects(h.call({ kind: 'folders' }), { code: 'DIALOG_BUSY' });
  assert.equal(h.requests.length, 1); complete(h); await first;
  const next = h.call({ kind: 'folders' }); assert.equal(h.requests.length, 2); complete(h, [], 1); await next;
});

for (const event of ['destroyed', 'render-process-gone', 'navigation', 'window-closed', 'dispose']) {
  test(`${event} invalidates the selection until the native promise settles`, async t => {
    const h = fixture(t), promise = h.call(), rejected = assert.rejects(promise, { code: 'DIALOG_ABORTED' });
    if (event === 'navigation') h.sender.emit('did-start-navigation', {}, h.sender.mainFrame.url, false, true);
    else if (event === 'window-closed') { h.window.destroyed = true; h.window.emit('closed'); }
    else if (event === 'dispose') h.service.dispose();
    else { if (event === 'destroyed') h.sender.destroyed = true; h.sender.emit(event); }
    if (event === 'navigation' || event === 'render-process-gone') await assert.rejects(h.call(), { code: 'DIALOG_BUSY' });
    if (event === 'dispose') await assert.rejects(h.call(), { code: 'UNTRUSTED_SENDER' });
    assert.equal(h.requests.length, 1); complete(h, ['D:\\late.txt']); await rejected;
    assert.equal(h.stats.length, 0); assert.equal(h.reads.length, 0);
    assert.equal(h.sender.listenerCount('destroyed'), 0); assert.equal(h.window.listenerCount('closed'), 0);
  });
}

test('subframe navigation leaves the main-frame native dialog valid', async t => {
  const h = fixture(t), result = h.call(); h.sender.emit('did-start-navigation', {}, 'https://sub.invalid/', false, false);
  complete(h, ['D:\\selected.txt']); assert.equal((await result)[0].name, 'selected.txt');
});

test('navigation during metadata stat prevents delivery and keeps the invocation guarded', async t => {
  let release;
  const h = fixture(t, { stat: () => new Promise(resolve => { release = resolve; }) }), result = h.call();
  const rejected = assert.rejects(result, { code: 'DIALOG_ABORTED' }); complete(h, ['D:\\picked.txt']);
  await new Promise(resolve => setImmediate(resolve)); assert.ok(release);
  h.sender.emit('did-start-navigation', {}, h.sender.mainFrame.url, false, true); await assert.rejects(h.call(), { code: 'DIALOG_BUSY' });
  release({ isDirectory: () => false, isFile: () => true, size: 8 }); await rejected;
  const next = h.call(); complete(h, [], 1); await next;
});

test('owner replacement and unannounced URL changes are rechecked after completion', async t => {
  const h = fixture(t), first = h.call(); h.replaceWindow({ ...h.window, isDestroyed: () => false, webContents: h.sender });
  complete(h); await assert.rejects(first, { code: 'UNTRUSTED_SENDER' });
  const changed = fixture(t), second = changed.call(); changed.sender.mainFrame.url = 'file:///D:/other.html';
  complete(changed); await assert.rejects(second, { code: 'UNTRUSTED_SENDER' });
});

test('native rejection and synchronous errors release listeners and permit retry', async t => {
  const h = fixture(t), result = h.call(); h.requests[0].reject(Error('synthetic native failure'));
  await assert.rejects(result, /synthetic native failure/); assert.equal(h.sender.listenerCount('destroyed'), 0);
  const retry = h.call(); complete(h, [], 1); await retry;
  const thrown = fixture(t, { showDialog: () => { throw Error('synthetic sync failure'); } });
  await assert.rejects(thrown.call(), /synthetic sync failure/); assert.equal(thrown.window.listenerCount('closed'), 0);
});

test('unavailable native API fails clearly without leaving the invocation pending', async t => {
  const h = fixture(t, { unavailable: true }); await assert.rejects(h.call(), { code: 'NATIVE_DIALOG_UNAVAILABLE' });
  h.dialog.showOpenDialog = async () => ({ canceled: true }); assert.deepEqual(await h.call(), []);
});

test('malformed results and invalid paths cannot return partial attachments', async t => {
  const h = fixture(t);
  for (const response of [null, {}, { canceled: false }, { canceled: false, filePaths: ['relative'] }, { canceled: false, filePaths: ['D:\\null\0file'] }, { canceled: false, filePaths: Array(2049).fill('D:\\a.txt') }]) {
    const result = h.call(); h.requests.at(-1).resolve(response); await assert.rejects(result, { code: 'INVALID_RESULT' });
  }
});

test('one missing file or non-file object fails the complete selection', async t => {
  const h = fixture(t, { stat: async input => { if (input.includes('missing')) throw Error('synthetic removed file'); return { isDirectory: () => false, isFile: () => true, size: 2 }; } }), result = h.call();
  complete(h, ['D:\\valid.txt', 'D:\\missing.txt']); await assert.rejects(result, /synthetic removed file/);
  const special = fixture(t), other = special.call(); complete(special, ['D:\\special']); await assert.rejects(other, { code: 'INVALID_RESULT' });
});

test('dispose is idempotent and removes only the registered channel', t => {
  const h = fixture(t); h.service.dispose(); h.service.dispose(); assert.deepEqual(h.removed, [CHANNEL]);
});
