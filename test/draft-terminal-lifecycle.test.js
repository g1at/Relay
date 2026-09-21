'use strict';

// Real workspace IPC -> real main resolver/history -> real registries, with a
// synthetic PTY and temporary files. No application, shell or model is launched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createProjectStore } = require('../project-store');
const workspaces = require('../conversation-workspaces');
const { registerWorkspaceTools } = require('../workspace-tools');
const { mergeSupplementHistory } = require('../live-supplement-input');
const { createAgentEnvironment } = require('../agent-environment');
const { createGeneralPreferences, registerGeneralPreferencesIpc, normalizePreferences } = require('../general-preferences');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const ID = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const clone = value => JSON.parse(JSON.stringify(value));
function declaration(name) {
  const start = source.indexOf('function ' + name + '('); assert.ok(start >= 0, name);
  const tail = source.slice(start), next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-draft-terminal-'));
  const records = new Map(), writes = [], handlers = new Map(), ptys = [];
  const convFilePath = id => path.join(root, 'history', id + '.json');
  const persist = conv => {
    fs.mkdirSync(path.dirname(convFilePath(conv.id)), { recursive: true });
    fs.writeFileSync(convFilePath(conv.id), JSON.stringify(conv));
    records.set(conv.id, clone(conv)); writes.push(clone(conv));
  };
  const context = { fs, path, createProjectStore, ...workspaces, WORKSPACE_UUID: workspaces.UUID,
    createAgentEnvironment, registerGeneralPreferencesIpc, normalizePreferences, dialog: {}, mainWindow: null,
    createGeneralPreferences: options => createGeneralPreferences({ ...options, homeDir: root }), claudeSdk: { configureRuntimeEnvironment() {} },
    createConversationWorkspaces: options => workspaces.createConversationWorkspaces({ ...options, homeDir: root }),
    app: { getPath: () => root }, convFilePath, loadConversation: id => records.has(id) ? clone(records.get(id)) : null,
    persistConversationRecord: persist, readHistoryIndex: () => [...records.values()].map(clone), readAppSettings: () => ({}),
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, shell: { openPath: async () => '' },
    liveSessions: new Map(), liveTombstones: new Map(), taskLedger: { list: () => [] }, RUN_STATES: { QUEUED: 'queued' },
    killLiveSession() { throw Error('No live model session should be touched'); },
    mergeSupplementHistory, TITLE_MAX_W: 64, truncateByWidth: text => text, genId: () => ID,
  };
  require('./helpers/conversation-permissions-fixture')(context);
  vm.createContext(context);
  vm.runInContext(declaration('sdkProjectContext'), context);
  const start = source.indexOf('let projectStore = null;'), end = source.indexOf('const workspaceTools =', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(declaration('saveConversation'), context);
  const sender = new EventEmitter(); sender.isDestroyed = () => false; sender.send = () => {};
  sender.mainFrame = { url: pathToFileURL(path.join(__dirname, '../renderer/index.html')).href };
  const event = { sender, senderFrame: sender.mainFrame };
  const bridge = registerWorkspaceTools({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getWindow: () => ({ webContents: sender, isDestroyed: () => false }),
    resolveWorkspace: context.resolveWorkspaceForTools, shell: context.shell,
    env: { SHELL: '/bin/bash', SystemRoot: 'C:\\Windows', PATH: '/fixture/bin' },
    ptyModule: { spawn(file, args, options) {
      const item = { file, args, options, writes: [], killed: false,
        onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; },
        write(value) { this.writes.push(value); }, resize() {}, kill() { this.killed = true; } };
      ptys.push(item); return item;
    } },
  });
  t.after(() => { bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, context, records, writes, ptys, store: context.getProjectStore(),
    call: (name, input) => handlers.get('workspace:' + name)(event, input),
    save: value => context.saveConversation(clone(value)) };
}

for (const selectedProject of [false, true]) {
  test(`opening a ${selectedProject ? 'project' : 'default'} draft terminal creates no history; first send retains its UUID, directory and PTY`, async t => {
    const h = fixture(t); let project = null;
    if (selectedProject) {
      const folder = path.join(h.root, 'chosen-project'); fs.mkdirSync(folder);
      project = h.store.add(folder, 'Fixture project');
    }
    const draft = { conversationId: ID, workingDir: null, projectId: project && project.id, mode: 'plain' };
    const terminal = await h.call('terminalStart', { context: draft, cols: 90, rows: 28 });
    assert.equal(terminal.ok, true); assert.equal(terminal.conversationId, ID);
    assert.equal(h.records.size, 0); assert.equal(h.writes.length, 0);
    assert.equal(fs.existsSync(path.join(h.root, 'history')), false);
    assert.equal(h.store.binding(ID), undefined, 'terminal preparation must not bind a fake history conversation');
    const expectedRoot = fs.realpathSync(project ? project.path : path.join(h.root, 'RelayProjects', ID));
    assert.equal(terminal.root, expectedRoot); assert.equal(h.ptys[0].options.cwd, expectedRoot);
    fs.writeFileSync(path.join(terminal.root, 'draft-output.txt'), 'synthetic output created before sending');
    h.save({ id: ID, title: 'First actual prompt', mode: 'plain', workingDir: null, projectId: project && project.id,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      turns: [{ user: 'First actual prompt', assistant: '', runId: 'fixture-run' }] });
    assert.equal(h.records.size, 1); assert.equal(h.writes.length, 1);
    assert.equal(h.records.get(ID).title, 'First actual prompt');
    assert.equal(h.records.get(ID).terminalWorkspaceOnly, undefined);
    const run = h.context.resolveExecutionWorkspace({ conversationId: ID });
    assert.equal(fs.realpathSync(run.cwd), terminal.root);
    assert.equal(fs.readFileSync(path.join(run.cwd, 'draft-output.txt'), 'utf8'), 'synthetic output created before sending');
    assert.equal((await h.call('terminalInput', { id: terminal.id, data: 'synthetic input\r' })).ok, true);
    assert.deepEqual(h.ptys[0].writes, ['synthetic input\r']);
    assert.equal(h.ptys.length, 1); assert.equal(h.ptys[0].killed, false);
  });
}

test('separate draft terminals keep independent roots and saving one does not create or bind the other', async t => {
  const h = fixture(t);
  const first = await h.call('terminalStart', { context: { conversationId: ID } });
  const second = await h.call('terminalStart', { context: { conversationId: OTHER } });
  assert.notEqual(first.root, second.root); assert.notEqual(first.id, second.id);
  assert.equal(h.records.size, 0);
  h.save({ id: ID, title: 'Only submitted draft', workingDir: null, turns: [{ user: 'submitted', assistant: '' }] });
  assert.equal(h.records.has(OTHER), false); assert.equal(h.store.binding(OTHER), undefined);
  assert.equal((await h.call('terminalInput', { id: second.id, data: 'other draft still active' })).ok, true);
  assert.deepEqual(h.ptys[0].writes, []); assert.deepEqual(h.ptys[1].writes, ['other draft still active']);
});
