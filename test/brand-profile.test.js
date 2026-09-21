'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-brand-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const old = path.join(directory, 'brand-logo.png'), selected = path.join(directory, 'selected.png');
  fs.writeFileSync(old, 'old-avatar'); fs.writeFileSync(selected, 'new-avatar');
  const settingsFile = path.join(directory, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ brandName: '原名称', brandLogo: 'brand-logo.png', theme: 'dark' }));
  const state = { writes: 0, dialogs: 0, failSettings: false, failImage: false, canceled: false, selected };
  const sender = {}, frame = { url: pathToFileURL(path.join(root, 'renderer/index.html')).href }; sender.mainFrame = frame;
  const event = { sender, senderFrame: frame }, handlers = new Map();
  const filesystem = Object.create(fs);
  filesystem.writeFileSync = (file, ...args) => {
    if (state.failImage && path.basename(file).startsWith('brand-logo-')) throw Error('synthetic image write failure');
    return fs.writeFileSync(file, ...args);
  };
  const context = vm.createContext({
    fs: filesystem, path, crypto, pathToFileURL, __dirname: root,
    app: { getPath: () => directory }, mainWindow: { isDestroyed: () => false, webContents: sender },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { async showOpenDialog() { state.dialogs++; return { canceled: state.canceled, filePaths: [state.selected] }; } },
    readAppSettings: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
    writeAppSettings(value) {
      if (state.failSettings) throw Error('synthetic settings write failure');
      fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(value)); fs.renameSync(settingsFile + '.tmp', settingsFile); state.writes++;
    },
  });
  for (const name of ['toGraphemes', 'graphemeWidth']) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start);
    vm.runInContext(source.slice(start, end + 2), context);
  }
  const start = source.indexOf('const BRAND_NAME_MAX = '), get = source.indexOf("ipcMain.handle('brand:get'", start), end = source.indexOf('\n});', get);
  vm.runInContext(source.slice(start, end + 4), context);
  const invoke = (name, input, caller = event) => handlers.get('brand:' + name)(caller, input);
  return { state, event, invoke, old, directory, get settings() { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }, set settings(value) { fs.writeFileSync(settingsFile, JSON.stringify(value)); } };
}
test('choosing an avatar only previews; save commits name and avatar together', async t => {
  const h = fixture(t), before = h.invoke('get'), files = fs.readdirSync(h.directory);
  const preview = await h.invoke('pickLogoPreview');
  assert.equal(preview.ok, true); assert.match(preview.logo, /^data:image\/png;base64,/);
  assert.deepEqual(fs.readdirSync(h.directory), files); assert.equal(h.state.writes, 0); assert.equal(h.settings.brandName, '原名称');
  const result = h.invoke('saveProfile', { name: '  新名称  ', logoAction: 'replace', previewId: preview.previewId, expectedRevision: before.revision });
  assert.equal(result.ok, true); assert.equal(result.name, '新名称'); assert.equal(h.state.writes, 1);
  assert.equal(h.settings.theme, 'dark'); assert.notEqual(h.settings.brandLogo, 'brand-logo.png');
  assert.equal(fs.readFileSync(path.join(h.directory, h.settings.brandLogo), 'utf8'), 'new-avatar'); assert.equal(fs.existsSync(h.old), false);
  assert.notEqual(result.revision, before.revision);
});
test('canceling or discarding a preview never modifies existing profile files', async t => {
  const h = fixture(t), before = h.invoke('get'); h.state.canceled = true;
  assert.equal((await h.invoke('pickLogoPreview')).canceled, true);
  h.state.canceled = false; const preview = await h.invoke('pickLogoPreview');
  assert.equal(h.invoke('discardLogoPreview', preview.previewId).ok, true);
  assert.equal(h.invoke('saveProfile', { name: '新名称', logoAction: 'replace', previewId: preview.previewId, expectedRevision: before.revision }).code, 'PREVIEW_EXPIRED');
  assert.equal(h.state.writes, 0); assert.equal(h.settings.brandName, '原名称'); assert.equal(fs.readFileSync(h.old, 'utf8'), 'old-avatar');
});
test('validation and stale revisions fail before any profile mutation', async t => {
  const h = fixture(t), revision = h.invoke('get').revision;
  assert.equal(h.invoke('saveProfile', { name: '助'.repeat(21), logoAction: 'default', expectedRevision: revision }).code, 'NAME_TOO_LONG');
  assert.equal(h.invoke('saveProfile', { name: 'test', logoAction: 'arbitrary-file', expectedRevision: revision }).code, 'INVALID_PROFILE');
  h.settings = { ...h.settings, brandName: '外部更新' };
  assert.equal(h.invoke('saveProfile', { name: '旧视图编辑', logoAction: 'default', expectedRevision: revision }).code, 'PROFILE_CHANGED');
  assert.equal(h.state.writes, 0); assert.equal(h.settings.brandName, '外部更新'); assert.equal(fs.existsSync(h.old), true);
});
test('failed settings commit removes only the unreferenced new avatar and supports retry', async t => {
  const h = fixture(t), before = h.invoke('get'), preview = await h.invoke('pickLogoPreview');
  const input = { name: '新名称', logoAction: 'replace', previewId: preview.previewId, expectedRevision: before.revision };
  h.state.failSettings = true;
  assert.equal(h.invoke('saveProfile', input).code, 'PROFILE_SAVE_FAILED');
  assert.equal(h.settings.brandName, '原名称'); assert.equal(fs.readFileSync(h.old, 'utf8'), 'old-avatar');
  assert.equal(fs.readdirSync(h.directory).filter(name => /^brand-logo-/.test(name)).length, 0);
  h.state.failSettings = false; assert.equal(h.invoke('saveProfile', input).ok, true); assert.equal(h.state.writes, 1);
});
test('avatar write failure and reset failure leave the old identity intact', async t => {
  const h = fixture(t), before = h.invoke('get'), preview = await h.invoke('pickLogoPreview');
  h.state.failImage = true;
  assert.equal(h.invoke('saveProfile', { name: '新名称', logoAction: 'replace', previewId: preview.previewId, expectedRevision: before.revision }).ok, false);
  assert.equal(h.settings.brandName, '原名称'); assert.equal(fs.existsSync(h.old), true);
  h.state.failSettings = true;
  assert.equal(h.invoke('saveProfile', { name: '', logoAction: 'default', expectedRevision: before.revision }).ok, false);
  assert.equal(fs.existsSync(h.old), true);
  h.state.failSettings = false;
  const result = h.invoke('saveProfile', { name: '', logoAction: 'default', expectedRevision: before.revision });
  assert.equal(result.ok, true); assert.equal(result.logo, null); assert.equal(result.name, ''); assert.equal(fs.existsSync(h.old), false);
});
test('remote windows, subframes, and navigated main documents cannot preview or save', async t => {
  const h = fixture(t);
  for (const caller of [{ sender: {}, senderFrame: h.event.senderFrame }, { sender: h.event.sender, senderFrame: {} }]) {
    assert.equal((await h.invoke('pickLogoPreview', undefined, caller)).code, 'FORBIDDEN');
    assert.equal(h.invoke('saveProfile', {}, caller).code, 'FORBIDDEN');
  }
  h.event.senderFrame.url = 'https://example.invalid';
  assert.equal((await h.invoke('pickLogoPreview')).code, 'FORBIDDEN');
  assert.equal(h.state.dialogs, 0); assert.equal(h.state.writes, 0);
});
