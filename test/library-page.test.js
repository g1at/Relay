'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const text = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const start = text.indexOf('// ── 资料库主页面：');
const end = text.indexOf('// 创作页顶部栏按钮:', start);
assert.ok(start >= 0 && end > start);
const source = text.slice(start, end);
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const requests = { images: [], files: [] };
  const calls = { opened: [], deleted: [], deletedImages: [], toasts: [] };
  const context = {
    $: () => null, console, setTimeout, clearTimeout,
    showToast: message => calls.toasts.push(message),
    customConfirm: async () => true,
    window: { api: { library: {
      listImages: () => new Promise((resolve, reject) => requests.images.push({ resolve, reject })),
      listFiles: () => new Promise((resolve, reject) => requests.files.push({ resolve, reject })),
      openFile: async path => { calls.opened.push(path); return { ok: true }; },
      deleteFile: async path => { calls.deleted.push(path); return { ok: true }; },
    }, image: { deleteSaved: async path => { calls.deletedImages.push(path); return { ok: true }; } } } },
  };
  vm.createContext(context); vm.runInContext(source, context);
  return {
    context, requests, calls,
    read: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
    set: code => vm.runInContext(code, context),
    async load(kind, items) {
      const pending = context.loadLibrarySource(kind, true); await tick();
      requests[kind].at(-1).resolve({ ok: true, items }); await pending;
    },
  };
}
const file = (path, type = 'document', extra = {}) => ({ path, name: path.split(/[\\/]/).pop(), type, mtime: 123, size: 1024, ...extra });

test('parallel sources preserve the newest local filter and deduplicate Windows paths', async () => {
  const h = harness();
  const all = h.context.refreshLibrary(); await tick();
  h.set("libState.fileType = 'pdf'; libState.query = 'report'");
  h.requests.images[0].resolve({ ok: true, items: [file('C:\\images\\photo.png')] });
  h.requests.files[0].resolve({ ok: true, items: [file('c:/images/photo.png', 'image'), file('C:/docs/report.pdf', 'pdf')] });
  await all;
  assert.deepEqual(h.read('filteredLibraryItems().map(item => item.name)'), ['report.pdf']);
  assert.equal(h.read('libraryItems().length'), 2);
  assert.equal(h.read("libraryItems().find(item => item.type === 'image').generatedImage"), true);
  assert.equal(h.read('libState.fileType'), 'pdf');
});

test('a late older refresh cannot overwrite a newer result', async () => {
  const h = harness();
  const old = h.context.loadLibrarySource('files', true); await tick();
  const latest = h.context.loadLibrarySource('files', true); await tick();
  h.requests.files[1].resolve({ ok: true, items: [file('/synthetic/new.md')] }); await latest;
  h.requests.files[0].resolve({ ok: true, items: [file('/synthetic/old.md')] }); await old;
  assert.deepEqual(h.read('libraryItems().map(item => item.name)'), ['new.md']);
  assert.equal(h.read('libSources.files.loading'), false);
});

test('failures retain the last successful data and a retry clears the error', async () => {
  const h = harness(); await h.load('files', [file('/synthetic/keep.md')]);
  const failing = h.context.loadLibrarySource('files', true); await tick();
  h.requests.files.at(-1).resolve({ ok: false, error: 'synthetic failure' }); await failing;
  assert.equal(h.read('libSources.files.error'), 'synthetic failure');
  assert.equal(h.read('libraryItems()[0].name'), 'keep.md');
  await h.load('files', [file('/synthetic/retried.md')]);
  assert.equal(h.read('libSources.files.error'), '');
  assert.equal(h.read('libraryItems()[0].name'), 'retried.md');
});

test('network-style IPC rejection is handled without publishing an empty success', async () => {
  const h = harness();
  const pending = h.context.loadLibrarySource('images'); await tick();
  h.requests.images[0].reject(new Error('synthetic unavailable')); await pending;
  assert.equal(h.read('libSources.images.items'), null);
  assert.equal(h.read('libSources.images.loading'), false);
  assert.equal(h.read('libSources.images.error'), 'synthetic unavailable');
});

test('fresh cached data is reused and a stale cache is refreshed', async () => {
  const h = harness(); await h.load('images', []);
  await h.context.loadLibrarySource('images'); assert.equal(h.requests.images.length, 1);
  h.set('libSources.images.loadedAt = 0');
  const pending = h.context.loadLibrarySource('images'); await tick();
  assert.equal(h.requests.images.length, 2);
  h.requests.images[1].resolve({ ok: true, items: [] }); await pending;
});

test('delete invalidates an in-flight snapshot and restarts interrupted loading', async () => {
  const h = harness(); await h.load('files', [file('/synthetic/delete.md')]);
  const old = h.context.loadLibrarySource('files', true); await tick();
  const oldRequest = h.requests.files.at(-1);
  await h.context.deleteLibraryItem(h.context.libraryItems()[0]); await tick();
  assert.deepEqual(h.calls.deleted, ['/synthetic/delete.md']);
  assert.equal(h.requests.files.length, 3);
  oldRequest.resolve({ ok: true, items: [file('/synthetic/delete.md')] }); await old;
  assert.equal(h.read('libraryItems().length'), 0);
  h.requests.files.at(-1).resolve({ ok: true, items: [] }); await tick();
  assert.equal(h.read('libSources.files.loading'), false);
  assert.equal(h.read('libraryItems().length'), 0);
});

test('generated image deletion keeps the existing image API and file deletion uses the library API', async () => {
  const h = harness(); await h.load('images', [file('/synthetic/photo.png')]);
  await h.context.deleteLibraryItem(h.context.libraryItems()[0]);
  assert.deepEqual(h.calls.deletedImages, ['/synthetic/photo.png']);
  assert.deepEqual(h.calls.deleted, []);
  assert.equal(h.read('libraryItems().length'), 0);
});

test('cancelled or failed deletion preserves the cached file', async () => {
  const h = harness(); await h.load('files', [file('/synthetic/keep.md')]);
  h.context.customConfirm = async () => false;
  await h.context.deleteLibraryItem(h.context.libraryItems()[0]);
  assert.equal(h.calls.deleted.length, 0); assert.equal(h.read('libraryItems().length'), 1);
  h.context.customConfirm = async () => true;
  h.context.window.api.library.deleteFile = async () => ({ ok: false, error: 'synthetic denied' });
  await h.context.deleteLibraryItem(h.context.libraryItems()[0]);
  assert.equal(h.read('libraryItems().length'), 1); assert.match(h.calls.toasts.at(-1), /synthetic denied/);
});

test('file open errors are surfaced and do not claim an open succeeded', async () => {
  const h = harness();
  h.context.window.api.library.openFile = async () => ({ ok: false, error: 'synthetic missing' });
  await h.context.openLibraryFile(file('/synthetic/missing.md'));
  assert.match(h.calls.toasts.at(-1), /synthetic missing/);
});

test('normalization ignores malformed paths and does not invent conversation provenance', () => {
  const h = harness();
  const normalized = h.context.normalizeLibraryItems([null, { path: 123 }, { path: '' }, { path: '/synthetic/note.md', type: 'document' }], 'files');
  assert.equal(normalized.length, 1); assert.equal(normalized[0].name, 'note.md');
  assert.equal(Object.hasOwn(normalized[0], 'conversationId'), false);
});
