'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { registerWorkspaceTools, TEXT_LIMIT, IMAGE_LIMIT, TERMINAL_LIMIT, relativePath, dimensions } = require('../workspace-tools');

function fixture(t, extra = {}) {
  // Match the native realpath used by workspace IPC, including Windows 8.3 TEMP aliases.
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspace-test-')));
  const root = path.join(temp, 'workspace'); fs.mkdirSync(root);
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'readme.md'), '# Local fixture\nNo real conversation.');
  fs.mkdirSync(path.join(root, 'nested')); fs.writeFileSync(path.join(root, 'nested', 'file.txt'), 'nested');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside marker');
  const handlers = new Map(), ptys = [], sent = [], opened = [], revealed = [], contexts = [];
  const sender = new EventEmitter(); sender.isDestroyed = () => false; sender.send = (channel, payload) => sent.push({ channel, payload });
  const rendererURL = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
  sender.mainFrame = { url: rendererURL };
  const window = { webContents: sender, isDestroyed: () => false };
  const event = { sender, senderFrame: sender.mainFrame };
  const ptyModule = { spawn(file, args, options) {
    const item = { file, args, options, writes: [], sizes: [], killed: false, paused: false,
      onData(fn) { this.data = fn; return { dispose() {} }; }, onExit(fn) { this.exit = fn; return { dispose() {} }; },
      write(value) { this.writes.push(value); }, resize(cols, rows) { this.sizes.push([cols, rows]); }, kill() { this.killed = true; }, pause() { this.paused = true; }, resume() { this.paused = false; } };
    ptys.push(item); return item;
  } };
  const instance = registerWorkspaceTools({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
    getWindow: () => window, resolveWorkspace: async (context) => { contexts.push(context); return { root, conversationId: 'fixture-conversation', managed: true }; },
    shell: { openPath: async (file) => { opened.push(file); return ''; }, showItemInFolder: file => revealed.push(file) }, ptyModule,
    env: { SHELL: '/bin/bash', SystemRoot: 'C:\\Windows', PATH: '/fixture/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' }, ...extra,
  });
  t.after(() => { instance.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const call = (name, input, source = event) => handlers.get(`workspace:${name}`)(source, input);
  return { root, outside, handlers, ptys, sent, opened, revealed, contexts, sender, event, call, instance };
}

test('file hyperlinks preview verified Windows/WSL/relative destinations without invoking a system opener', async t => {
  const h = fixture(t);
  const file = path.join(h.root, 'report final.md'); fs.writeFileSync(file, '# Final report');
  const hrefs = [file + ':3', pathToFileURL(file).href + ':3', 'report%20final.md:3'];
  const html = require('../renderer/vendor/marked.umd').parse(`[文件](<${file}:3>)`);
  hrefs.push(/href="([^"]+)"/.exec(html)[1]);
  if (process.platform === 'win32') hrefs.push('/mnt/' + file[0].toLowerCase() + file.slice(2).replace(/\\/g, '/') + ':3');
  for (const href of hrefs) {
    const result = await h.call('readLink', { context: { conversationId: 'fixture' }, href });
    assert.equal(result.ok, true, href); assert.equal(result.content, '# Final report');
    assert.equal(result.line, 3); assert.equal(result.absolutePath, fs.realpathSync(file));
    assert.equal(result.kind, 'file'); assert.equal(result.relativePath, 'report final.md');
  }
  assert.equal(h.opened.length, 0); assert.equal(h.ptys.length, 0);
});

test('directory hyperlinks return canonical tree locations for project root, nested and encoded paths', async t => {
  const h = fixture(t);
  const directory = path.join(h.root, '交付 文件', '安卓报告');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'result.md'), '# Synthetic report');
  const html = require('../renderer/vendor/marked.umd').parse(`[交付目录](<${directory}>)`);
  const hrefs = [directory, pathToFileURL(directory).href, '交付%20文件/安卓报告/', /href="([^"]+)"/.exec(html)[1]];
  if (process.platform === 'win32') hrefs.push('/mnt/' + directory[0].toLowerCase() + directory.slice(2).replace(/\\/g, '/'));
  for (const href of hrefs) {
    const result = await h.call('readLink', { context: { conversationId: 'fixture' }, href });
    assert.equal(result.ok, true, href); assert.equal(result.kind, 'directory');
    assert.equal(result.root, fs.realpathSync(h.root)); assert.equal(result.relativePath, '交付 文件/安卓报告');
    assert.equal(result.path, fs.realpathSync(directory)); assert.equal(result.absolutePath, result.path);
    assert.equal(result.name, '安卓报告'); assert.equal(result.line, null);
    assert.equal(result.entries, undefined); assert.equal(result.content, undefined); assert.equal(result.dataUrl, undefined);
  }
  const resolved = await h.call('resolveLink', { href: directory + ':7' });
  assert.equal(resolved.kind, 'directory'); assert.equal(resolved.relativePath, '交付 文件/安卓报告'); assert.equal(resolved.line, null);
  const project = await h.call('readLink', { href: h.root });
  assert.equal(project.kind, 'directory'); assert.equal(project.relativePath, ''); assert.equal(project.root, project.absolutePath);
  const relative = await h.call('readLink', { href: '../交付 文件/安卓报告', basePath: path.join(h.root, 'nested', 'file.txt') });
  assert.equal(relative.relativePath, '交付 文件/安卓报告');
  assert.equal(h.opened.length, 0); assert.equal(h.revealed.length, 0); assert.equal(h.ptys.length, 0);
});

test('explicit local directory links work outside the project while workspace symlink escapes stay blocked', async t => {
  const h = fixture(t);
  fs.symlinkSync(h.outside, path.join(h.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(path.join(h.root, 'nested'), path.join(h.root, 'nested-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const inside = await h.call('readLink', { href: 'nested-alias' });
  assert.equal(inside.ok, true); assert.equal(inside.kind, 'directory'); assert.equal(inside.relativePath, 'nested');
  for (const href of [h.outside, '../outside']) {
    assert.equal((await h.call('readLink', { href })).kind, 'directory');
  }
  for (const href of ['escape']) {
    for (const method of ['resolveLink', 'readLink', 'openLink']) {
      const result = await h.call(method, { href, roots: [h.outside], target: 'system' });
      assert.equal(result.code, 'OUTSIDE_WORKSPACE', `${method}: ${href}`);
    }
  }
  assert.equal(h.opened.length, 0); assert.equal(h.revealed.length, 0);
});

test('host-authorized scratch directory metadata does not authorize new file-tree roots', async t => {
  let h;
  h = fixture(t, { resolveLinkWorkspace: async () => ({ root: h.root, roots: [h.root, h.outside] }) });
  const directory = await h.call('readLink', { href: h.outside });
  assert.equal(directory.ok, true); assert.equal(directory.kind, 'directory');
  assert.equal(directory.root, fs.realpathSync(h.outside)); assert.equal(directory.relativePath, '');
  assert.equal(directory.entries, undefined);
  const listed = await h.call('list', { path: '', root: directory.root, context: { root: directory.root } });
  assert.equal(listed.root, fs.realpathSync(h.root));
  assert.equal(listed.entries.some(entry => entry.name === 'private.txt'), false);
});

test('directory-link listing browses host-authorized scratch without changing the conversation workspace', async t => {
  let h;
  const contexts = [];
  h = fixture(t, { resolveLinkWorkspace: async context => { contexts.push(context); return { root: h.root, roots: [h.root, h.outside] }; } });
  const delivery = path.join(h.outside, '过程输出');
  fs.mkdirSync(path.join(delivery, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(delivery, 'report.md'), '# Scratch report');
  fs.writeFileSync(path.join(delivery, 'nested', 'details.txt'), 'Details');
  const context = { conversationId: 'fixture-conversation' };
  const directoryLink = { href: delivery, context: { conversationId: 'untrusted-nested' }, root: h.outside };
  const result = await h.call('list', { context, directoryLink });
  assert.equal(result.ok, true); assert.equal(result.root, fs.realpathSync(delivery)); assert.equal(result.path, '');
  assert.deepEqual(result.entries.map(entry => entry.path), ['nested', 'report.md']);
  assert.deepEqual(contexts.at(-1), context);
  const child = await h.call('list', { context, directoryLink, path: 'nested' });
  assert.equal(child.root, fs.realpathSync(delivery)); assert.equal(child.path, 'nested');
  assert.equal(child.entries[0].path, 'nested/details.txt');
  const relative = await h.call('list', { context, directoryLink: { href: '../过程输出', basePath: path.join(h.outside, 'docs', 'README.md') } });
  assert.equal(relative.root, fs.realpathSync(delivery));
  assert.equal((await h.call('resolve', context)).root, fs.realpathSync(h.root));
  assert.equal((await h.call('list', { context })).root, fs.realpathSync(h.root));
  assert.equal(h.opened.length, 0); assert.equal(h.ptys.length, 0);
});

test('directory-link listing rejects traversal and symlinks outside the selected folder even inside an allowed root', async t => {
  let h;
  h = fixture(t, { resolveLinkWorkspace: async () => ({ root: h.root, roots: [h.root, h.outside] }) });
  const selected = path.join(h.outside, 'selected'); fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, 'inside.txt'), 'Inside');
  fs.symlinkSync(h.outside, path.join(selected, 'parent-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const directoryLink = { href: selected };
  const listed = await h.call('list', { directoryLink });
  assert.deepEqual(listed.entries.map(entry => entry.name), ['inside.txt']);
  for (const requested of ['..', '../selected', '../', h.outside, 'C:relative']) {
    assert.equal((await h.call('list', { directoryLink, path: requested })).code, 'INVALID_PATH', requested);
  }
  assert.equal((await h.call('list', { directoryLink, path: 'parent-link' })).code, 'OUTSIDE_WORKSPACE');
  assert.equal((await h.call('list', { directoryLink: { href: path.join(h.outside, 'private.txt') } })).code, 'NOT_DIRECTORY');
  assert.equal((await h.call('list', { directoryLink: 'unsafe' })).code, 'INVALID_FILE_LINK');
});

test('directory-link listing resolves explicit local targets without depending on scratch membership', async t => {
  let h, allowScratch = true;
  h = fixture(t, { resolveLinkWorkspace: async () => ({ root: h.root, roots: allowScratch ? [h.root, h.outside] : [h.root] }) });
  const directoryLink = { href: h.outside };
  assert.equal((await h.call('list', { directoryLink })).ok, true);
  const unallowed = path.join(path.dirname(h.root), 'unallowed'); fs.mkdirSync(unallowed);
  assert.equal((await h.call('list', { directoryLink: { href: unallowed, roots: [unallowed] } })).root, fs.realpathSync(unallowed));
  const shortcut = path.join(h.root, 'changing-link');
  fs.symlinkSync(path.join(h.root, 'nested'), shortcut, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.call('list', { directoryLink: { href: shortcut } })).ok, true);
  fs.unlinkSync(shortcut); fs.symlinkSync(unallowed, shortcut, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.call('list', { directoryLink: { href: shortcut } })).code, 'OUTSIDE_WORKSPACE');
  allowScratch = false;
  assert.equal((await h.call('list', { directoryLink, root: h.outside })).root, fs.realpathSync(h.outside));
  assert.equal((await h.call('resolve', {})).root, fs.realpathSync(h.root));
});

test('directory context actions open or reveal authorized folders without treating file-like names as executables', async t => {
  const h = fixture(t);
  const directory = path.join(h.root, 'reports.py'); fs.mkdirSync(directory);
  assert.equal((await h.call('openLink', { href: directory, target: 'system' })).ok, true);
  assert.equal((await h.call('openLink', { href: directory, target: 'reveal' })).ok, true);
  assert.deepEqual(h.opened, [fs.realpathSync(directory)]); assert.deepEqual(h.revealed, [fs.realpathSync(directory)]);
  assert.equal(h.ptys.length, 0);
});

test('host mini-image helper accepts bounded bitmaps only and keeps workspace path isolation', async t => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.root, 'preview.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'));
  const result = await h.instance.readLocalImage({ href: 'preview.png' });
  assert.equal(result.ok, true); assert.equal(result.mimeType, 'image/png'); assert.equal(result.content, undefined);
  await assert.rejects(h.instance.readLocalImage({ href: 'readme.md' }), { code: 'NOT_IMAGE' });
  await assert.rejects(h.instance.readLocalImage({ href: path.join(h.outside, 'private.txt') }), { code: 'OUTSIDE_WORKSPACE' });
});

test('relative markdown hyperlinks resolve from the preview file parent while symlinks retain their boundary', async t => {
  const h = fixture(t);
  const result = await h.call('readLink', { href: '../readme.md', basePath: path.join(h.root, 'nested', 'file.txt') });
  assert.equal(result.ok, true); assert.match(result.content, /Local fixture/);
  for (const input of [
    { href: '../../outside/private.txt', basePath: path.join(h.root, 'nested', 'file.txt') },
    { href: path.join(h.outside, 'private.txt') },
    { href: '../workspace/readme.md', basePath: path.join(h.outside, 'private.txt') },
  ]) assert.equal((await h.call('readLink', input)).ok, true);
  fs.symlinkSync(h.outside, path.join(h.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await h.call('readLink', { href: 'escape/private.txt' })).code, 'OUTSIDE_WORKSPACE');
});

test('explicit file hyperlinks need no scratch registration and ordinary web links never enter file IPC', async t => {
  let h;
  h = fixture(t, { resolveLinkWorkspace: async () => ({ root: h.root, roots: [h.root, h.outside] }) });
  assert.equal((await h.call('readLink', { href: path.join(h.outside, 'private.txt') })).ok, true);
  assert.equal((await h.call('readLink', { href: 'https://example.com/report.md', roots: [h.outside] })).code, 'INVALID_FILE_LINK');
  const plain = fixture(t);
  const external = await plain.call('readLink', { href: path.join(plain.outside, 'private.txt'), roots: [plain.outside] });
  assert.equal(external.ok, true); assert.equal(external.root, fs.realpathSync(plain.outside));
});

test('a desktop delivery previews and opens directly without copying files or changing the selected project', async t => {
  const h = fixture(t);
  const desktop = path.join(h.outside, 'Desktop', '安卓_SRC挖洞');
  fs.mkdirSync(desktop, { recursive: true });
  const source = path.join(desktop, '分析报告 final.md');
  const content = '# Synthetic delivery\n\nReport and source must remain intact.\n';
  fs.writeFileSync(source, content);
  const context = { conversationId: 'fixture-conversation', workingDir: h.root };
  const hrefFor = file => {
    const html = require('../renderer/vendor/marked.umd').parse(`[分析报告](<${file}>)`);
    return /href="([^"]+)"/.exec(html)[1];
  };
  const external = { context, href: hrefFor(source) };
  const hrefs = [external.href, pathToFileURL(source).href];
  if (process.platform === 'win32') hrefs.push('/mnt/' + source[0].toLowerCase() + source.slice(2).replace(/\\/g, '/'));
  for (const href of hrefs) {
    const preview = await h.call('readLink', { context, href });
    assert.equal(preview.ok, true); assert.equal(preview.content, content);
    assert.equal(preview.absolutePath, fs.realpathSync(source));
    assert.equal(preview.root, fs.realpathSync(desktop)); assert.equal(preview.kind, 'file');
  }
  assert.equal((await h.call('resolveLink', external)).absolutePath, fs.realpathSync(source));
  assert.equal((await h.call('openLink', { ...external, target: 'system' })).ok, true);
  assert.equal((await h.call('openLink', { ...external, target: 'reveal' })).ok, true);
  assert.deepEqual(h.opened, [fs.realpathSync(source)]); assert.deepEqual(h.revealed, [fs.realpathSync(source)]);
  assert.equal(fs.readFileSync(source, 'utf8'), content);
  assert.equal(fs.existsSync(path.join(h.root, '安卓_SRC挖洞')), false);
  assert.equal((await h.call('resolve', context)).root, fs.realpathSync(h.root));
  for (const method of ['read', 'list', 'open']) {
    assert.equal((await h.call(method, { context, path: source, root: desktop })).code, 'INVALID_PATH');
  }
  assert.equal((await h.call('list', { context, path: '', root: desktop })).root, fs.realpathSync(h.root));
  assert.equal(h.opened.length, 1);
});

test('external Markdown relative links and images resolve from their real source document', async t => {
  const h = fixture(t);
  const document = path.join(h.outside, '报告.md'); fs.writeFileSync(document, '# Report');
  fs.writeFileSync(path.join(h.outside, '详情.md'), 'External details');
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  fs.writeFileSync(path.join(h.outside, '图 1.png'), imageBytes);
  const source = await h.call('readLink', { href: document });
  const details = await h.call('readLink', { href: '详情.md:2', basePath: source.absolutePath });
  assert.equal(details.content, 'External details'); assert.equal(details.line, 2);
  const image = await h.call('readLink', { href: '图%201.png', basePath: source.absolutePath });
  assert.equal(image.mimeType, 'image/png'); assert.equal(image.dataUrl, 'data:image/png;base64,' + imageBytes.toString('base64'));
  assert.equal((await h.call('readLink', { href: 'missing.md', basePath: source.absolutePath })).code, 'ENOENT');
  assert.equal((await h.call('resolve', {})).root, fs.realpathSync(h.root));
});

test('raw external source paths preserve literal hashes and percent escapes for relative links and images', async t => {
  const h = fixture(t), folder = path.join(h.outside, '资料#2%20原样'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, '详情.md'), 'Literal path details');
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  fs.writeFileSync(path.join(folder, '图 1.png'), imageBytes);
  for (const name of ['报告#2.md', '报告%20原样.md']) {
    const document = path.join(folder, name); fs.writeFileSync(document, '# Literal source path');
    const source = await h.call('readLink', { href: pathToFileURL(document).href });
    assert.equal(source.ok, true); assert.equal(source.absolutePath, fs.realpathSync(document));
    for (const basePath of [source.absolutePath, pathToFileURL(document).href]) {
      const details = await h.call('readLink', { href: '详情.md:4', basePath });
      assert.equal(details.ok, true, basePath); assert.equal(details.content, 'Literal path details'); assert.equal(details.line, 4);
      const image = await h.call('readLink', { href: '图%201.png', basePath });
      assert.equal(image.ok, true, basePath); assert.equal(image.mimeType, 'image/png');
      assert.equal(image.dataUrl, 'data:image/png;base64,' + imageBytes.toString('base64'));
    }
  }
});

test('source paths reject remote, device, non-local schemes and invalid values before filesystem lookup', async t => {
  const h = fixture(t), originalRealpath = fs.promises.realpath;
  let lookups = 0;
  fs.promises.realpath = async (...args) => { lookups++; return originalRealpath(...args); };
  t.after(() => { fs.promises.realpath = originalRealpath; });
  for (const basePath of ['\\\\server\\share\\report.md', 'file://server/share/report.md', '\\\\?\\C:\\report.md', '\\\\.\\pipe\\service',
    'https://example.test/report.md', 'javascript:alert(1)', 'data:text/plain,source', 'C:ambiguous.md', {}, '', 'bad\0path', 'a'.repeat(16385)]) {
    const result = await h.call('readLink', { href: 'picture.png', basePath });
    assert.equal(result.ok, false, String(basePath).slice(0, 100));
    assert.ok(['INVALID_PATH', 'INVALID_FILE_LINK', 'REMOTE_FILE_LINK'].includes(result.code), result.code);
  }
  assert.equal(lookups, 0); assert.equal(h.opened.length, 0);
});

test('external executable files remain preview-only unless revealed in the file manager', async t => {
  const h = fixture(t), file = path.join(h.outside, 'code.py'); fs.writeFileSync(file, 'synthetic source');
  assert.equal((await h.call('readLink', { href: file })).content, 'synthetic source');
  assert.equal((await h.call('openLink', { href: file, target: 'system' })).code, 'EXECUTABLE_FILE');
  assert.equal((await h.call('openLink', { href: file, target: 'reveal' })).ok, true);
  assert.equal(h.opened.length, 0); assert.deepEqual(h.revealed, [fs.realpathSync(file)]);
});

test('remote UNC and device hyperlinks are rejected without attempting filesystem lookup', async t => {
  const h = fixture(t), originalRealpath = fs.promises.realpath;
  let lookups = 0;
  fs.promises.realpath = async (...args) => { lookups++; return originalRealpath(...args); };
  t.after(() => { fs.promises.realpath = originalRealpath; });
  for (const href of ['\\\\server\\share\\report.md', 'file://server/share/report.md', '%5C%5Cserver%5Cshare%5Creport.md', '\\\\?\\C:\\Windows\\system.ini', '\\\\.\\pipe\\service']) {
    for (const method of ['readLink', 'resolveLink', 'openLink']) {
      const result = await h.call(method, { href, target: 'system' });
      assert.equal(result.ok, false, `${method}: ${href}`);
      assert.ok(['REMOTE_FILE_LINK', 'INVALID_FILE_LINK'].includes(result.code), result.code);
    }
  }
  assert.equal(lookups, 0); assert.equal(h.opened.length, 0); assert.equal(h.revealed.length, 0);
});

test('external previews reject a file replaced between validation and opening', async t => {
  const h = fixture(t), file = path.join(h.outside, 'changing.md'), originalOpen = fs.promises.open;
  fs.writeFileSync(file, 'original');
  const canonical = fs.realpathSync(file);
  fs.promises.open = async (name, ...args) => {
    if (name === canonical) { fs.renameSync(file, file + '.before'); fs.writeFileSync(file, 'replacement'); }
    return originalOpen(name, ...args);
  };
  t.after(() => { fs.promises.open = originalOpen; });
  const result = await h.call('readLink', { href: file });
  assert.equal(result.code, 'FILE_CHANGED'); assert.equal(result.content, undefined);
});

test('file context actions reveal or open exact files, reject executable associations and never evaluate strings', async t => {
  const h = fixture(t);
  const file = path.join(h.root, 'readme.md');
  const resolved = await h.call('resolveLink', { href: file + ':4' });
  assert.equal(resolved.absolutePath, fs.realpathSync(file)); assert.equal(resolved.line, 4);
  assert.equal((await h.call('openLink', { href: file, target: 'system' })).ok, true);
  assert.equal((await h.call('openLink', { href: file, target: 'reveal' })).ok, true);
  assert.deepEqual(h.opened, [fs.realpathSync(file)]); assert.deepEqual(h.revealed, [fs.realpathSync(file)]);
  for (const name of ['danger.cmd', 'danger.exe', 'shortcut.url', 'code.py', 'code.js']) {
    fs.writeFileSync(path.join(h.root, name), 'not executed');
    assert.equal((await h.call('readLink', { href: name })).ok, true);
    assert.equal((await h.call('openLink', { href: name, target: 'system' })).code, 'EXECUTABLE_FILE');
    assert.equal((await h.call('openLink', { href: name, target: 'reveal' })).ok, true);
  }
  assert.equal(h.opened.length, 1); assert.equal(h.ptys.length, 0);
  assert.equal((await h.call('openLink', { href: file, target: 'javascript:alert(1)' })).code, 'INVALID_TARGET');
});

test('preferred opener executes only after workspace authorization and explicit system opening is preserved', async t => {
  const calls = [];
  const h = fixture(t, { openFile: async (file, target) => { calls.push({ file, target }); return { ok: true, target: target === 'default' ? 'relay' : target }; } });
  const result = await h.call('open', { path: 'readme.md', target: 'default' });
  assert.equal(result.target, 'relay');
  await h.call('open', { path: 'readme.md' }); assert.equal(calls.at(-1).target, 'system');
  assert.equal((await h.call('open', { path: '../outside/private.txt', target: 'default' })).ok, false);
  assert.equal(calls.length, 2);
});

test('shell preference changes apply only to new PTYs and late shell probes cannot outlive their authorized document', async t => {
  let selected = 'first-shell', release;
  const h = fixture(t, { resolveTerminal: async () => { if (selected === 'wait') await new Promise(resolve => { release = resolve; }); return { file: selected, args: ['synthetic'], label: selected }; } });
  await h.call('terminalStart', {}); selected = 'second-shell'; await h.call('terminalStart', {});
  assert.deepEqual(h.ptys.map(item => item.file), ['first-shell', 'second-shell']);
  assert.equal(h.ptys[0].killed, false);
  selected = 'wait'; const pending = h.call('terminalStart', {});
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.sender.mainFrame.url = 'https://example.invalid/'; release();
  assert.equal((await pending).ok, false); assert.equal(h.ptys.length, 2);
});

test('workspace metadata and file listing use the authoritative resolver and relative paths', async (t) => {
  const h = fixture(t);
  const resolved = await h.call('resolve', { conversationId: 'fixture', workingDir: '/ignored' });
  assert.equal(resolved.ok, true); assert.equal(resolved.root, fs.realpathSync(h.root)); assert.equal(resolved.managed, true);
  assert.equal(h.contexts[0].conversationId, 'fixture');
  const listed = await h.call('list', { context: { conversationId: 'fixture' }, path: '' });
  assert.deepEqual(listed.entries.map((item) => [item.path, item.type]), [['nested', 'directory'], ['readme.md', 'file']]);
  assert.equal((await h.call('list', { path: 'nested' })).entries[0].path, 'nested/file.txt');
});
test('all IPC endpoints reject foreign windows, child frames and remote navigation before resolution', async (t) => {
  const h = fixture(t);
  for (const channel of h.handlers.keys()) {
    const fn = h.handlers.get(channel);
    await assert.rejects(fn({ sender: {}, senderFrame: {} }, {}), /此窗口不能/);
    await assert.rejects(fn({ sender: h.sender, senderFrame: { url: h.sender.mainFrame.url } }, {}), /此窗口不能/);
  }
  h.sender.mainFrame.url = 'https://example.invalid/';
  await assert.rejects(h.call('resolve', {}), /此窗口不能/);
  assert.equal(h.contexts.length, 0); assert.equal(h.ptys.length, 0);
});

test('review IPC resolves only authoritative conversation/project context and ignores arbitrary directory overrides', async t => {
  const h = fixture(t);
  const result = await h.call('review', { conversationId: 'fixture', projectId: 'saved-project', cwd: h.outside, workingDir: h.outside });
  assert.equal(result.ok, true); assert.equal(result.root, fs.realpathSync(h.root));
  assert.deepEqual(h.contexts.at(-1), { conversationId: 'fixture', projectId: 'saved-project' });
  await h.call('reviewDiff', { context: { conversationId: 'fixture', projectId: 'saved-project', workingDir: h.outside }, path: '../outside/private.txt', stage: 'unstaged', cwd: h.outside });
  assert.deepEqual(h.contexts.at(-1), { conversationId: 'fixture', projectId: 'saved-project' });
});
test('traversal, absolute paths and Windows drive-relative paths cannot leave the workspace', async (t) => {
  const h = fixture(t);
  for (const requested of ['../outside/private.txt', '..\\outside\\private.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'C:private.txt', 'nested/../../private.txt', '\\server\\share', 'bad\0name']) {
    for (const method of ['list', 'read', 'open']) assert.equal((await h.call(method, { path: requested })).ok, false, `${method}: ${requested}`);
  }
  assert.equal(h.opened.length, 0);
});
test('canonical checks reject symlink escapes for listing, preview and system open', async (t) => {
  const h = fixture(t);
  fs.symlinkSync(h.outside, path.join(h.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const method of ['list', 'read', 'open']) {
    const result = await h.call(method, { path: method === 'list' ? 'escape' : 'escape/private.txt' });
    assert.equal(result.ok, false); assert.equal(result.code, 'OUTSIDE_WORKSPACE');
  }
  assert.equal((await h.call('list', {})).entries.some((entry) => entry.name === 'escape'), false);
});
test('text preview preserves source, identifies language and bounds long reads without partial UTF-8', async (t) => {
  const h = fixture(t);
  const text = await h.call('read', { path: 'readme.md' });
  assert.equal(text.language, 'markdown'); assert.equal(text.content, '# Local fixture\nNo real conversation.');
  fs.writeFileSync(path.join(h.root, 'large.txt'), 'a'.repeat(TEXT_LIMIT - 1) + '汉'.repeat(100));
  const large = await h.call('read', { path: 'large.txt' });
  assert.equal(large.truncated, true); assert.ok(large.content.length <= TEXT_LIMIT); assert.ok(!large.content.endsWith('�'));
});
test('UTF-16, binary and SVG previews use text or binary metadata without executable embeds', async (t) => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.root, 'utf16.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('内容', 'utf16le')]));
  fs.writeFileSync(path.join(h.root, 'raw.bin'), Buffer.from([0, 1, 2, 3, 4]));
  fs.writeFileSync(path.join(h.root, 'icon.svg'), '<svg onload="alert(1)"></svg>');
  assert.equal((await h.call('read', { path: 'utf16.txt' })).content, '内容');
  assert.equal((await h.call('read', { path: 'raw.bin' })).binary, true);
  const svg = await h.call('read', { path: 'icon.svg' }); assert.equal(svg.language, 'xml'); assert.equal(svg.dataUrl, undefined); assert.match(svg.content, /onload/);
});
test('bitmap previews are detected from bytes and oversized images require system open', async (t) => {
  const h = fixture(t);
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  fs.writeFileSync(path.join(h.root, 'image.txt'), bytes);
  const image = await h.call('read', { path: 'image.txt' }); assert.equal(image.mimeType, 'image/png'); assert.match(image.dataUrl, /^data:image\/png;base64,/);
  const big = path.join(h.root, 'large.png'); fs.writeFileSync(big, bytes); fs.truncateSync(big, IMAGE_LIMIT + 1);
  const result = await h.call('read', { path: 'large.png' }); assert.equal(result.binary, true); assert.equal(result.truncated, true); assert.equal(result.dataUrl, undefined);
  const link = await h.call('readLink', { href: 'image.txt', context: { conversationId: 'fixture' } });
  assert.equal(link.dataUrl, image.dataUrl);
  const oversized = await h.call('readLink', { href: 'large.png', context: { conversationId: 'fixture' } });
  assert.equal(oversized.dataUrl, undefined); assert.equal(oversized.truncated, true);
  fs.writeFileSync(path.join(h.root, 'pretend.png'), '<svg onload="throw Error(1)"></svg>');
  assert.equal((await h.call('readLink', { href: 'pretend.png' })).dataUrl, undefined);
});
test('system open is confined to the resolved workspace and missing files fail clearly', async (t) => {
  const h = fixture(t);
  assert.equal((await h.call('open', { path: 'readme.md' })).ok, true);
  assert.deepEqual(h.opened, [path.join(fs.realpathSync(h.root), 'readme.md')]);
  assert.equal((await h.call('read', { path: 'missing.txt' })).code, 'ENOENT');
  assert.equal((await h.call('read', { path: 'nested' })).code, 'NOT_FILE');
});
test('real-PTY contract starts only explicitly with canonical cwd and a normal terminal environment', async (t) => {
  const h = fixture(t);
  await h.call('resolve', {}); await h.call('list', {}); assert.equal(h.ptys.length, 0);
  const started = await h.call('terminalStart', { cols: 112, rows: 36 });
  assert.equal(started.ok, true); assert.match(started.id, /^[a-f0-9-]{36}$/);
  assert.equal(h.ptys[0].options.cwd, fs.realpathSync(h.root)); assert.equal(h.ptys[0].options.cols, 112);
  assert.equal(h.ptys[0].options.env.TERM, 'xterm-256color'); assert.equal(h.ptys[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(h.ptys[0].options.env.NODE_OPTIONS, undefined);
});
test('terminal input and resize forward control bytes and dimensions to the PTY', async (t) => {
  const h = fixture(t), started = await h.call('terminalStart', {});
  assert.equal((await h.call('terminalInput', { id: started.id, data: 'echo fixture\r\x03' })).ok, true);
  assert.deepEqual(h.ptys[0].writes, ['echo fixture\r\x03']);
  await h.call('terminalResize', { id: started.id, cols: 101, rows: 31 }); assert.deepEqual(h.ptys[0].sizes, [[101, 31]]);
  assert.equal((await h.call('terminalInput', { id: started.id, data: 'a'.repeat(65537) })).code, 'INVALID_INPUT');
  assert.equal((await h.call('terminalResize', { id: started.id, cols: NaN, rows: 24 })).code, 'INVALID_SIZE');
  assert.equal((await h.call('terminalInput', { id: 'not-owned', data: 'pwd\r' })).code, 'TERMINAL_NOT_FOUND');
});
test('PTY output flushes before exit, exits once and cannot be written afterward', async (t) => {
  const h = fixture(t), started = await h.call('terminalStart', {});
  h.ptys[0].data('\x1b[32mfixture\x1b[0m\r\n'); h.ptys[0].exit({ exitCode: 0 }); h.ptys[0].exit({ exitCode: 0 });
  assert.deepEqual(h.sent.map((event) => event.payload.type), ['data', 'exit']);
  assert.equal(h.sent[0].payload.data, '\x1b[32mfixture\x1b[0m\r\n'); assert.equal(h.sent[1].payload.exitCode, 0);
  assert.equal((await h.call('terminalInput', { id: started.id, data: 'x' })).ok, false);
});
test('terminal creation enforces the per-window limit even across simultaneous requests', async (t) => {
  const h = fixture(t);
  const results = await Promise.all(Array.from({ length: TERMINAL_LIMIT + 3 }, () => h.call('terminalStart', {})));
  assert.equal(results.filter((result) => result.ok).length, TERMINAL_LIMIT);
  assert.equal(h.ptys.length, TERMINAL_LIMIT);
  const first = results.find((result) => result.ok);
  await h.call('terminalClose', { id: first.id }); assert.equal(h.ptys.filter((pty) => pty.killed).length, 1);
  assert.equal((await h.call('terminalStart', {})).ok, true);
});
test('document reload and renderer destruction terminate shells; in-page navigation preserves them', async (t) => {
  const h = fixture(t); await h.call('terminalStart', {});
  h.sender.emit('did-start-navigation', {}, 'file:///new', true, true); assert.equal(h.ptys[0].killed, false);
  h.sender.emit('did-start-navigation', {}, 'file:///new', false, true); assert.equal(h.ptys[0].killed, true);
  await h.call('terminalStart', {}); h.sender.emit('destroyed'); assert.equal(h.ptys[1].killed, true);
});
test('disposal removes IPC and closes every remaining terminal without orphaned timers', async (t) => {
  const h = fixture(t); await h.call('terminalStart', {}); h.ptys[0].data('pending');
  h.instance.dispose(); assert.equal(h.handlers.size, 0); assert.equal(h.ptys[0].killed, true);
  assert.equal(h.sender.listenerCount('destroyed'), 0); assert.equal(h.sender.listenerCount('did-start-navigation'), 0);
  h.instance.dispose(); assert.equal(h.sent.filter((event) => event.payload.type === 'exit').length, 1);
});

test('renderer crashes close their terminals and late delivery cannot throw into the main loop', async (t) => {
  const h = fixture(t); await h.call('terminalStart', {}); h.ptys[0].data('pending');
  h.sender.send = () => { throw new Error('renderer gone'); };
  assert.doesNotThrow(() => h.sender.emit('render-process-gone', {}, { reason: 'crashed' }));
  assert.equal(h.ptys[0].killed, true);
});
test('input helpers reject invalid paths and dimensions while preserving harmless relative names', () => {
  assert.equal(relativePath('nested/file.txt'), path.join('nested', 'file.txt'));
  assert.throws(() => relativePath({}), /工作目录/); assert.throws(() => dimensions(0, 24), /尺寸/);
  assert.deepEqual(dimensions(), { cols: 80, rows: 24 });
});
