'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { SkillDraftClient } = require('../src/main/skills/skill-draft-client');
const loadCommonJs = require('./helpers/load-commonjs.cjs');

const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
function handlerSource(name) {
  const first = source.indexOf(`ipcMain.handle('${name}'`);
  const last = source.indexOf('\n});', first);
  assert.ok(first >= 0 && last > first, name);
  return source.slice(first, last + 5);
}

function fixture(t) {
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.sent = []; }
    postMessage(message) { this.sent.push(message); }
    ref() {}
    unref() {}
    reply(value) {
      const request = this.sent.at(-1);
      this.emit('message', { requestId: request.requestId, ok: true, value });
    }
  }
  // FakeWorker never reads or writes these paths. All lifecycle storage is in memory.
  const root = path.join(os.tmpdir(), 'relay-skill-completion-memory-fixture');
  const client = new SkillDraftClient({
    skillsDir: path.join(root, 'skills'), draftsDir: path.join(root, 'drafts'), WorkerClass: FakeWorker,
  });
  const handlers = new Map(), order = [], pending = [], warnings = [];
  let state = { guide: { state: 'active', firstSeenAt: 'synthetic-existing-skill' } };
  let live = true;
  const host = {
    archive() {
      assert.equal(live, true);
      live = false;
      order.push('archive-files');
      return { archivedAt: 'synthetic-archive-time', backupId: 'synthetic-backup' };
    },
    recordPublished() { order.push(live ? 'publication-recorded' : 'publication-after-archive'); },
    forget() { order.push('forgotten'); },
  };
  const context = vm.createContext({
    path, skillDraftService: client,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    console: { warn: (...args) => warnings.push(args) },
    readSkillUsage: () => structuredClone(state),
    writeSkillUsage: value => { state = structuredClone(value); order.push(`state:${state.guide?.state || 'absent'}`); },
    getSkillMaintenanceHost: () => host,
    recordSkillActivity: () => order.push('restore-activity'),
    notifySkillUsageUpdated() {},
    broadcastSkillDraftEvent: type => order.push(type),
    reloadSkillsInLiveSessions: async reason => { order.push(`reload:${reason}`); return { ok: true }; },
  });
  const { registerSkillDraftIpc } = loadCommonJs('src/main/skills/skill-draft-ipc.js', {
    globals: { console: context.console },
  });
  registerSkillDraftIpc({ ...context, getSkillDraftService: () => client });
  const libraryWrite = source.match(/^function withSkillLibraryWrite\([^]*?^}/m);
  assert.ok(libraryWrite, 'bootstrap retains the live library transaction boundary');
  vm.runInContext(libraryWrite[0], context);
  vm.runInContext(handlerSource('skills:archive'), context);
  const invoke = (name, args) => {
    const result = handlers.get(name)({}, args);
    pending.push(result);
    return result;
  };
  t.after(async () => {
    if (client.worker) client.worker.emit('exit', 1);
    await client.close();
    await Promise.allSettled(pending);
  });
  return { client, invoke, order, warnings, state: () => state, isLive: () => live };
}

for (const operation of ['publish', 'rollback']) {
  test(`${operation} IPC commits lifecycle state before a queued archive changes the same skill`, async t => {
    const h = fixture(t);
    const args = operation === 'publish' ? 'synthetic-draft' : { skillName: 'guide', versionId: 'synthetic-version', options: {} };
    const committed = h.invoke(`skillDrafts:${operation}`, args);
    const worker = h.client.worker;
    const archived = h.invoke('skills:archive', { name: 'guide' });
    assert.equal(worker.sent.length, 1);
    assert.equal(h.isLive(), true, 'The host mutation waits for the worker transaction');
    worker.reply(operation === 'publish'
      ? { draft: { id: 'synthetic-draft', skillName: 'guide', sourceRef: { type: 'conversation-review' } }, history: {} }
      : { restored: { exists: true } });

    const [commitResult, archiveResult] = await Promise.all([committed, archived]);
    assert.equal(commitResult.ok, true);
    assert.equal(archiveResult.ok, true);
    assert.equal(h.isLive(), false);
    assert.equal(h.state().guide.state, 'archived', 'Late completion must not reactivate an archived package');
    assert.deepEqual(h.order.filter(item => item.startsWith('state:')), ['state:active', 'state:archived']);
    const event = operation === 'publish' ? 'skillDraft.published' : 'skillDraft.rolledBack';
    assert.ok(h.order.indexOf(event) < h.order.indexOf('archive-files'), 'The completion event belongs before the next library mutation');
    assert.equal(h.warnings.length, 0);

    const closing = h.client.close();
    assert.deepEqual(worker.sent.at(-1), { type: 'close' });
    worker.emit('exit', 0);
    await closing;
  });
}
