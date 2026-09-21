'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createGeneralPreferences, normalizePreferences, normalizeParallelLimit, PARALLEL_LIMITS, registerGeneralPreferencesIpc } = require('../general-preferences');

function fixture(t, extra = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-preferences-'));
  t.after(() => fs.rmSync(homeDir, { force: true, recursive: true }));
  const state = {}, launched = [], opened = [];
  const files = new Set(['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\System32\\wsl.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\Microsoft VS Code\\Code.exe']);
  const service = createGeneralPreferences({ homeDir, platform: 'win32', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    getSettings: () => state, isFile: file => files.has(file), shell: { openPath: async file => { opened.push(file); return ''; } },
    probeWsl: async () => ({ available: true, terminalAvailable: true }),
    spawn(file, args, options) { const child = new EventEmitter(); child.unref = () => {}; launched.push({ file, args, options }); process.nextTick(() => child.emit('spawn')); return child; }, ...extra });
  return { service, state, launched, opened, files, homeDir };
}
test('legacy settings preserve existing values and default follow-up mode remains steer', () => {
  assert.equal(normalizePreferences({ theme: 'dark' }).followUpMode, 'steer');
  assert.equal(normalizePreferences({ followUpMode: 'queue', fileOpenTarget: 'vscode' }).followUpMode, 'queue');
  assert.equal(normalizePreferences({ fileOpenTarget: '../run', terminalShell: '/untrusted.exe' }).terminalShell, 'auto');
});
test('parallel tiers migrate legacy finite settings without silently enabling unlimited', () => {
  assert.equal(normalizePreferences().maxParallelTasks, 2);
  assert.deepEqual(PARALLEL_LIMITS, [2, 6, 9, 0]);
  for (const [before, after] of [[0, 0], [1, 2], [2, 2], [3, 6], [5, 6], [6, 6], [8, 9], [9, 9], [13, 9], [Number.MAX_SAFE_INTEGER, 9]]) {
    assert.equal(normalizePreferences({ maxParallelTasks: before }).maxParallelTasks, after);
  }
  for (const maxParallelTasks of [-1, 1.5, '5', null, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizePreferences({ maxParallelTasks }).maxParallelTasks, 2);
  }
});
test('renderer and host map every former limit to the same visible tier', () => {
  const context = { window: {} };
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/general-preferences-page.js'), 'utf8'), context);
  const rendererNormalize = context.window.RelayGeneralPreferencesPage.normalizeParallelLimit;
  for (const value of [undefined, null, NaN, Infinity, '3', -2, 1.5, ...Array.from({ length: 40 }, (_, value) => value)]) {
    assert.equal(rendererNormalize(value), normalizeParallelLimit(value), String(value));
  }
});
test('editing only concurrency leaves WSL and unrelated saved preferences untouched without capability probes', async t => {
  let probes = 0;
  const { service, state } = fixture(t, { probeWsl: async () => { probes++; throw Error('WSL temporarily offline'); } });
  Object.assign(state, { agentEnvironment: 'wsl', terminalShell: 'wsl', theme: 'dark', maxParallelTasks: 3 });
  const patch = await service.validatePatch({ maxParallelTasks: 0 });
  assert.deepEqual(patch, { maxParallelTasks: 0 });
  Object.assign(state, patch);
  assert.deepEqual(state, { agentEnvironment: 'wsl', terminalShell: 'wsl', theme: 'dark', maxParallelTasks: 0 });
  for (const maxParallelTasks of PARALLEL_LIMITS) assert.deepEqual(await service.validatePatch({ maxParallelTasks }), { maxParallelTasks });
  assert.equal(probes, 0);
  assert.equal(JSON.parse(JSON.stringify(service.preferences())).maxParallelTasks, 0);
  for (const maxParallelTasks of [1, 3, 5, 8, 13, -1, 2.5, '8', null, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(service.validatePatch({ maxParallelTasks }), error => error.code === 'INVALID_PARALLEL_LIMIT');
  }
});
test('capabilities show only detected editors and accurately separate WSL shell from agent runtime readiness', async t => {
  const { service } = fixture(t, { probeWsl: async () => ({ available: false, terminalAvailable: true, reason: 'MCP 需要 Linux 依赖' }) });
  const result = await service.get();
  assert.deepEqual(result.capabilities.fileOpenTargets.map(item => item.id), ['relay', 'system', 'vscode']);
  assert.equal(result.capabilities.agentEnvironments.find(item => item.id === 'wsl').available, false);
  assert.equal(result.capabilities.terminalShells.find(item => item.id === 'wsl').available, true);
  assert.equal(JSON.stringify(result).includes('executables'), false);
  await assert.rejects(service.validatePatch({ agentEnvironment: 'wsl' }), /MCP/);
});
test('invalid/removed choices cannot be saved and validation never mutates persisted preferences', async t => {
  const { service, state, files } = fixture(t);
  await assert.rejects(service.validatePatch({ followUpMode: 'interrupt' }), /无效/);
  await assert.rejects(service.validatePatch({ fileOpenTarget: 'cursor' }), /不可用/);
  files.delete('C:\\Program Files\\Microsoft VS Code\\Code.exe');
  await assert.rejects(service.validatePatch({ fileOpenTarget: 'vscode' }), /不可用/);
  assert.deepEqual(await service.validatePatch({ followUpMode: 'queue', unrelated: 'kept elsewhere' }), { followUpMode: 'queue' });
  assert.deepEqual(state, {});
});
test('workspace root validates a writable existing folder without creating or moving folders', async t => {
  const f = fixture(t, { platform: process.platform });
  assert.deepEqual(await f.service.validatePatch({ workspaceRoot: f.homeDir }), { workspaceRoot: path.resolve(f.homeDir) });
  await assert.rejects(f.service.validatePatch({ workspaceRoot: 'relative' }), /绝对路径/);
  const missing = path.join(f.homeDir, 'missing');
  await assert.rejects(f.service.validatePatch({ workspaceRoot: missing }), /不存在/);
  assert.equal(fs.existsSync(missing), false);
  const file = path.join(f.homeDir, 'file'); fs.writeFileSync(file, 'fixture');
  await assert.rejects(f.service.validatePatch({ workspaceRoot: file }), /文件夹/);
  assert.deepEqual(await f.service.validatePatch({ workspaceRoot: '' }), { workspaceRoot: '' });
});
test('new terminal launch uses current selected shell and passes cwd as data to WSL', async t => {
  const { service, state } = fixture(t);
  const old = await service.resolveTerminal({ cwd: 'D:\\Project name\\x' });
  state.terminalShell = 'cmd';
  assert.deepEqual((await service.resolveTerminal({ cwd: 'D:\\Project name\\x' })).args, ['/D']);
  state.terminalShell = 'wsl';
  const next = await service.resolveTerminal({ cwd: 'D:\\a & b\\x' });
  assert.deepEqual(next.args, ['--cd', 'D:\\a & b\\x']);
  assert.equal(old.label, 'Windows PowerShell');
});
test('default file opener is real, explicit system action remains available, and editors launch without shell interpolation', async t => {
  const { service, state, launched, opened } = fixture(t);
  assert.deepEqual(await service.openFile('D:\\a & b\\read.md', 'default'), { ok: true, target: 'relay' });
  assert.equal(opened.length, 0);
  state.fileOpenTarget = 'vscode';
  await service.openFile('D:\\a & b\\read.md');
  assert.deepEqual(launched[0].args, ['--reuse-window', '--', 'D:\\a & b\\read.md']);
  assert.equal(launched[0].options.shell, false);
  await service.openFile('D:\\x.md', 'system'); assert.deepEqual(opened, ['D:\\x.md']);
});
test('general preferences IPC is main-frame only; folder picking previews without persisting', async t => {
  const f = fixture(t), handlers = new Map();
  const sender = { isDestroyed: () => false, mainFrame: { url: pathToFileURL(path.join(__dirname, '../renderer/index.html')).href } };
  const win = { isDestroyed: () => false, webContents: sender }, event = { sender, senderFrame: sender.mainFrame };
  let picks = 0;
  registerGeneralPreferencesIpc({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, getWindow: () => win, service: f.service,
    dialog: { showOpenDialog: async () => { picks++; return { filePaths: ['D:\\Tasks'], canceled: false }; } } });
  const pick = handlers.get('generalPreferences:pickWorkspaceRoot');
  assert.equal((await pick({ sender, senderFrame: { ...sender.mainFrame } })).code, 'FORBIDDEN');
  assert.equal(picks, 0);
  assert.deepEqual(await pick(event), { ok: true, path: 'D:\\Tasks' });
  assert.deepEqual(f.state, {});
  sender.mainFrame.url = 'https://example.invalid/';
  assert.equal((await handlers.get('generalPreferences:get')(event)).ok, false);
});

test('SDK preferences validate independent of environment probes and restrict new trust to known projects', async t => {
  const { service, state } = fixture(t, {
    getProjectContext: input => input.projectId === 'project-1' ? { id: 'project-1', name: 'Fixture' } : null,
    probeWsl: async () => { throw Error('SDK policy must not probe'); },
  });
  const patch = { sdkSettingSources: 'local', sdkTrustedProjectIds: ['project-1'], sdkMemoryMode: 'isolated-sdk', sdkAutoDreamEnabled: true, sdkCleanupPeriodDays: 90 };
  assert.deepEqual(await service.validatePatch(patch), { ...patch, sdkMemoryMode: 'relay', sdkAutoDreamEnabled: false, sdkCleanupPeriodDays: null });
  assert.deepEqual(state, {});
  await assert.rejects(service.validatePatch({ sdkTrustedProjectIds: ['not-added-project'] }), /已加入/);
  await assert.rejects(service.validatePatch({ sdkTrustedProjectIds: ['project-1', 'project-1'] }), /无效/);
  assert.deepEqual(await service.validatePatch({ sdkCleanupPeriodDays: 0 }), { sdkCleanupPeriodDays: null });
  assert.deepEqual(await service.validatePatch({ sdkCleanupPeriodDays: 365 }), { sdkCleanupPeriodDays: null });
  assert.deepEqual(await service.validatePatch({ sdkAutoDreamEnabled: 'true' }), { sdkAutoDreamEnabled: false });
  assert.deepEqual(await service.validatePatch({ sdkTrustedProjectIds: [] }), { sdkTrustedProjectIds: [] });
});

test('legacy native memory values normalize on read and save without blocking unrelated preferences', async t => {
  const { service, state } = fixture(t, { probeWsl: async () => { throw Error('Legacy memory must not probe WSL'); } });
  for (const value of ['isolated-sdk', 'enabled', true, 'true', 'unknown', null, 1, {}, []]) {
    Object.assign(state, { sdkMemoryMode: value, sdkAutoDreamEnabled: value, theme: 'dark' });
    const snapshot = JSON.stringify(state);
    assert.equal(service.preferences().sdkMemoryMode, 'relay');
    assert.equal(service.preferences().sdkAutoDreamEnabled, false);
    assert.equal(JSON.stringify(state), snapshot);
    const patch = await service.validatePatch({ sdkMemoryMode: value, sdkAutoDreamEnabled: value, maxParallelTasks: 6 });
    assert.deepEqual(patch, { sdkMemoryMode: 'relay', sdkAutoDreamEnabled: false, maxParallelTasks: 6 });
    assert.equal(JSON.stringify(state), snapshot);
    Object.assign(state, patch);
    assert.equal(state.theme, 'dark');
    assert.equal(state.sdkMemoryMode, 'relay');
    assert.equal(state.sdkAutoDreamEnabled, false);
  }
});

test('SDK diagnostics and project context flow through preview inputs without saving settings', async t => {
  const { service } = fixture(t, {
    getProjectContext: input => input.projectId === 'project-1' ? { id: 'project-1', name: 'Fixture', secretRoot: '/private/path' } : null,
    getSdkDiagnostics: async input => ({ ok: true, context: input.conversationId }),
  });
  const result = await service.get({ projectId: 'project-1' });
  assert.deepEqual(result.projectContext, { id: 'project-1', name: 'Fixture' });
  assert.equal(JSON.stringify(result).includes('/private/path'), false);
  assert.deepEqual(await service.diagnostics({ conversationId: 'c1' }), { ok: true, context: 'c1' });
});
