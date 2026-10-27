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
  h.requests.files[0].resolve({ ok: true, items: [file('c:/images/photo.png', 'image'), file('C:/docs/report.pdf', 'pdf', { kind: 'output' })] });
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
  assert.equal(normalized[0].kind, 'legacy');
});

test('default results show registered outputs while process and old files remain separately discoverable', async () => {
  const h = harness();
  await h.load('files', [file('/workspace/outputs/report.pdf', 'pdf', { kind: 'output', conversationId: 'task-1' }),
    file('/scratch/check.py', 'code', { kind: 'process' }), file('/project/old-report.md'),
    file('/project/unknown-kind.md', 'document', { kind: 'unexpected' })]);
  assert.deepEqual(h.read('filteredLibraryItems().map(item => item.name)'), ['report.pdf']);
  assert.equal(h.read('filteredLibraryItems()[0].conversationId'), 'task-1');
  h.set("libState.kind = 'process'");
  assert.deepEqual(h.read('filteredLibraryItems().map(item => item.name)'), ['check.py']);
  h.set("libState.kind = 'legacy'");
  assert.deepEqual(h.read('filteredLibraryItems().map(item => item.name)'), ['old-report.md', 'unknown-kind.md']);
});

test('type and search filters remain scoped to the selected purpose', async () => {
  const h = harness();
  await h.load('files', [file('/workspace/outputs/report.pdf', 'pdf', { kind: 'output' }),
    file('/scratch/report.pdf', 'pdf', { kind: 'process' }), file('/project/report.pdf', 'pdf')]);
  h.set("libState.fileType = 'pdf'; libState.query = 'report'; libState.kind = 'process'");
  assert.deepEqual(h.read('filteredLibraryItems().map(item => item.path)'), ['/scratch/report.pdf']);
  h.set("libState.query = 'project'");
  assert.deepEqual(h.read('filteredLibraryItems()'), []);
});

test('generated image deduplication does not promote a known scratch file into outputs', async () => {
  const h = harness();
  await h.load('files', [file('C:/scratch/draft.png', 'image', { kind: 'process', conversationId: 'task-2' })]);
  await h.load('images', [file('c:\\scratch\\draft.png'), file('/images/delivered.png')]);
  assert.deepEqual(h.read('filteredLibraryItems().map(item => item.name)'), ['delivered.png']);
  h.set("libState.kind = 'process'");
  assert.equal(h.read('filteredLibraryItems()[0].generatedImage'), true);
  assert.equal(h.read('filteredLibraryItems()[0].conversationId'), 'task-2');
});

test('partial scans retain their status until a complete successful refresh replaces it', async () => {
  const h = harness();
  const pending = h.context.loadLibrarySource('files', true); await tick();
  h.requests.files.at(-1).resolve({ ok: true, items: [file('/outputs/report.pdf', 'pdf', { kind: 'output' })], truncated: true, warnings: ['unreadable-directory'] });
  await pending;
  assert.equal(h.read('libSources.files.truncated'), true);
  assert.equal(h.read('libSources.files.warnings.length'), 1);
  await h.load('files', []);
  assert.equal(h.read('libSources.files.truncated'), false);
  assert.deepEqual(h.read('libSources.files.warnings'), []);
});

test('explicit delivered directories open normally but cannot invoke file deletion', async () => {
  const h = harness();
  await h.load('files', [file('/workspace/outputs/site', 'other', { kind: 'output', isDirectory: true })]);
  const directory = h.context.filteredLibraryItems()[0];
  assert.equal(directory.isDirectory, true);
  await h.context.openLibraryFile(directory); assert.deepEqual(h.calls.opened, ['/workspace/outputs/site']);
  await h.context.deleteLibraryItem(directory); assert.deepEqual(h.calls.deleted, []);
  assert.match(h.calls.toasts.at(-1), /文件夹/); assert.equal(h.read('libraryItems().length'), 1);
});


test('generated videos and AVIF images retain their type, output filter and generated-file deletion', async () => {
  const h = harness();
  await h.load('images', [file('/generated/clip.mp4'), file('/generated/clip.webm'), file('/generated/still.avif')]);
  assert.equal(h.read("LIB_TYPES.some(([type])=>type==='video')"), true);
  h.set("libState.fileType='video'");
  assert.deepEqual(h.read('filteredLibraryItems().map(item=>item.name)'), ['clip.mp4', 'clip.webm']);
  await h.context.openLibraryItem(h.context.filteredLibraryItems()[0], h.context.libraryItems());
  assert.deepEqual(h.calls.opened, ['/generated/clip.mp4']);
  await h.context.deleteLibraryItem(h.context.filteredLibraryItems()[0]);
  assert.deepEqual(h.calls.deletedImages, ['/generated/clip.mp4']);
  assert.deepEqual(h.calls.deleted, []);
  h.set("libState.fileType='image'");
  assert.deepEqual(h.read('filteredLibraryItems().map(item=>item.name)'), ['still.avif']);
});
