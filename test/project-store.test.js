'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProjectStore } = require('../project-store');
const { workspaceKey } = require('../conversation-workspaces');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-project-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folders = ['alpha', 'beta'].map(name => { const folder = path.join(root, name); fs.mkdirSync(folder); return folder; });
  const busy = new Set(), filePath = path.join(root, 'isolated-data/projects.json');
  return { root, folders, filePath, busy, store: createProjectStore({ filePath, isBusy: id => busy.has(id) }) };
}
test('project folders deduplicate normalized paths and persist across reopen', t => {
  const h = fixture(t), first = h.store.add(h.folders[0], 'First project');
  assert.equal(h.store.add(path.join(h.folders[0], '.'), 'Ignored duplicate').id, first.id);
  assert.equal(h.store.list().length, 1);
  const restored = createProjectStore({ filePath: h.filePath });
  assert.deepEqual(restored.list(), [first]);assert.equal(restored.resolve('new-conv', first.id).path, h.folders[0]);
});
test('new projects require existing absolute directories and never create user project folders', t => {
  const h = fixture(t), file = path.join(h.root, 'file.txt');fs.writeFileSync(file, 'keep');
  assert.throws(() => h.store.add('relative-folder'));
  assert.throws(() => h.store.add(file));
  const missing = path.join(h.root, 'missing');assert.throws(() => h.store.add(missing));
  assert.equal(fs.existsSync(missing), false);assert.equal(h.store.list().length, 0);
});
test('legacy directory adoption preserves source history and deduplicates by actual directory key', t => {
  const h = fixture(t), conv = { id: 'legacy-one', title: 'Original', updatedAt: '2021-01-01', pinned: true, workingDir: { path: h.folders[0], name: 'Legacy label' }, turns: [{ user: 'u', assistant: 'a' }] };
  const before = clone(conv), id = h.store.adopt(conv);
  h.store.adopt({ ...conv, id: 'legacy-two', workingDir: h.folders[0] });
  assert.deepEqual(conv, before);assert.equal(h.store.list().length, 1);
  assert.equal(h.store.binding('legacy-two'), id);
  const decorated = h.store.decorate(conv);assert.equal(workspaceKey(decorated.workingDir.path), workspaceKey(before.workingDir.path));
  assert.equal(decorated.updatedAt, before.updatedAt);assert.deepEqual(decorated.turns, before.turns);assert.equal(decorated.pinned, true);
});
test('missing legacy directories are indexed without recreation and fail only when opened for execution', t => {
  const h = fixture(t), missing = path.join(h.root, 'offline-project');
  const id = h.store.adopt({ id: 'offline-conv', workingDir: missing });
  assert.equal(h.store.get(id).path, missing);assert.equal(fs.existsSync(missing), false);
  assert.throws(() => h.store.resolve('offline-conv'));assert.equal(h.store.binding('offline-conv'), id);
});
test('existing project membership wins over stale project IDs and legacy workingDir snapshots', t => {
  const h = fixture(t), a = h.store.add(h.folders[0]), b = h.store.add(h.folders[1]);
  h.store.bind('conversation', b.id);
  assert.equal(h.store.adopt({ id: 'conversation', projectId: a.id, workingDir: a.path }), b.id);
  const shown = h.store.decorate({ id: 'conversation', projectId: a.id, workingDir: a.path });
  assert.equal(shown.projectId, b.id);assert.equal(shown.workingDir.path, b.path);
  assert.equal(h.store.resolve('conversation', a.id).id, b.id);
});
test('explicit unassignment remains authoritative across stale saves and process restart', t => {
  const h = fixture(t), a = h.store.add(h.folders[0]);h.store.bind('conversation', a.id);h.store.bind('conversation', null);
  const next = createProjectStore({ filePath: h.filePath });
  next.adopt({ id: 'conversation', projectId: a.id, workingDir: a.path });
  assert.equal(next.binding('conversation'), null);assert.equal(next.resolve('conversation', a.id), null);
  assert.equal(next.decorate({ id: 'conversation', workingDir: a.path }).workingDir, null);
});
test('unbound draft may resolve its selected project without creating history or membership', t => {
  const h = fixture(t), a = h.store.add(h.folders[0]);
  assert.equal(h.store.resolve('draft', a.id).id, a.id);assert.equal(h.store.binding('draft'), undefined);
  assert.equal(h.store.resolve('another-draft'), null);
});
test('running conversations block reassignment and project removal but allow same-project no-op', t => {
  const h = fixture(t), a = h.store.add(h.folders[0]), b = h.store.add(h.folders[1]);h.store.bind('busy-conv', a.id);h.busy.add('busy-conv');
  assert.equal(h.store.bind('busy-conv', a.id), a.id);
  assert.throws(() => h.store.bind('busy-conv', b.id), /正在运行/);
  assert.throws(() => h.store.remove(a.id), /运行/);
  assert.equal(h.store.binding('busy-conv'), a.id);assert.equal(h.store.list().length, 2);
});
test('project removal only detaches membership and preserves every project file', t => {
  const h = fixture(t), a = h.store.add(h.folders[0]);const file = path.join(a.path, 'report.md');fs.writeFileSync(file, 'user-owned report');
  h.store.bind('one', a.id);h.store.bind('two', a.id);
  assert.deepEqual(h.store.remove(a.id).sort(), ['one', 'two']);
  assert.equal(h.store.binding('one'), null);assert.equal(h.store.binding('two'), null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'user-owned report');assert.equal(fs.existsSync(a.path), true);
  h.store.adopt({ id: 'one', projectId: a.id, workingDir: a.path });assert.equal(h.store.list().length, 0);
});
test('renaming changes display names while retaining directories and conversation timestamps', t => {
  const h = fixture(t), a = h.store.add(h.folders[0]);h.store.bind('one', a.id);
  const renamed = h.store.rename(a.id, '新名称');
  assert.equal(renamed.path, a.path);assert.equal(renamed.createdAt, a.createdAt);
  const shown = h.store.decorate({ id: 'one', updatedAt: '2020-01-01' });
  assert.equal(shown.workingDir.name, '新名称');assert.equal(shown.updatedAt, '2020-01-01');
  assert.throws(() => h.store.rename(a.id, '   '));assert.throws(() => h.store.rename(a.id, 'x'.repeat(81)));
});
test('invalid identifiers or unknown project references cannot alter membership', t => {
  const h = fixture(t);assert.throws(() => h.store.bind('../outside', null));
  assert.throws(() => h.store.bind('valid', 'missing'));assert.equal(h.store.binding('valid'), undefined);
  assert.throws(() => h.store.adopt({ id: 'valid', projectId: 'missing' }));
  assert.equal(h.store.adopt({ id: '../invalid', workingDir: h.folders[0] }), null);
});
test('returned project lists and resolutions cannot mutate the durable registry', t => {
  const h = fixture(t), a = h.store.add(h.folders[0]);h.store.bind('one', a.id);
  const list = h.store.list();list[0].path = h.folders[1];
  const resolved = h.store.resolve('one');resolved.path = h.folders[1];
  assert.equal(h.store.resolve('one').path, a.path);
});
test('malformed project registry is rejected without silently overwriting it', t => {
  const h = fixture(t);fs.mkdirSync(path.dirname(h.filePath), { recursive: true });
  const body = '{"version":99,"projects":[],"bindings":{}}';fs.writeFileSync(h.filePath, body);
  assert.throws(() => createProjectStore({ filePath: h.filePath }).list(), /无法读取/);
  assert.equal(fs.readFileSync(h.filePath, 'utf8'), body);
});
test('binding precommit runs only after validation and before membership becomes authoritative', t => {
  const h = fixture(t), a = h.store.add(h.folders[0]), b = h.store.add(h.folders[1]);h.store.bind('one', a.id);
  const seen = [], beforeCommit = () => seen.push(h.store.binding('one'));
  h.store.bind('one', a.id, { beforeCommit });assert.equal(seen.length, 0);
  assert.throws(() => h.store.bind('one', 'missing', { beforeCommit }));assert.equal(seen.length, 0);
  h.busy.add('one');assert.throws(() => h.store.bind('one', b.id, { beforeCommit }));assert.equal(seen.length, 0);h.busy.clear();
  assert.throws(() => h.store.bind('one', b.id, { beforeCommit: () => { throw Error('registry unavailable'); } }));assert.equal(h.store.binding('one'), a.id);
  h.store.bind('one', b.id, { beforeCommit });assert.deepEqual(seen, [a.id]);assert.equal(h.store.binding('one'), b.id);
});
test('removal precommit covers all members, cannot mutate affected membership, and aborts on registry failure', t => {
  const h = fixture(t), a = h.store.add(h.folders[0]);h.store.bind('one', a.id);h.store.bind('two', a.id);let calls = 0;
  h.busy.add('two');assert.throws(() => h.store.remove(a.id, { beforeCommit: () => calls++ }));assert.equal(calls, 0);h.busy.clear();
  assert.throws(() => h.store.remove(a.id, { beforeCommit: () => { throw Error('registry unavailable'); } }));assert.equal(h.store.binding('one'), a.id);assert.equal(h.store.list().length, 1);
  const affected = h.store.remove(a.id, { beforeCommit: members => { assert.deepEqual(members.sort(), ['one', 'two']);assert.equal(h.store.binding('one'), a.id);members.length = 0; } });
  assert.deepEqual(affected.sort(), ['one', 'two']);assert.equal(h.store.binding('one'), null);assert.equal(h.store.binding('two'), null);
});

test('batch adoption streams 200 histories into one atomic registry write', t => {
  const h = fixture(t), writes = [], renames = [];
  const write = fs.writeFileSync, rename = fs.renameSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    if (file === h.filePath + '.tmp') writes.push(file);
    return write.call(fs, file, ...args);
  });
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (to === h.filePath) renames.push(to);
    return rename.call(fs, from, to);
  });
  function* history() {
    for (let i = 0; i < 200; i++) {
      assert.equal(fs.existsSync(h.filePath), false, 'no partial batch is written during iteration');
      assert.equal(h.store.binding('history-0'), undefined, 'staged bindings cannot leak into the live cache');
      const { proxy, revoke } = Proxy.revocable({ id: `history-${i}`, workingDir: h.folders[i % 2] }, {});
      yield proxy;
      revoke(); // A consumer that collects histories before processing would fail.
    }
  }
  assert.equal(h.store.adoptMany(history()), 200);
  assert.equal(writes.length, 1); assert.equal(renames.length, 1);
  assert.equal(h.store.list().length, 2);
  const reopened = createProjectStore({ filePath: h.filePath });
  for (let i = 0; i < 200; i++) assert.equal(reopened.resolve(`history-${i}`).path, h.folders[i % 2]);
});

test('batch adoption preserves authoritative bindings, missing legacy folders and fork workspaces', t => {
  const h = fixture(t), existing = h.store.add(h.folders[0]);
  h.store.bind('assigned', existing.id); h.store.bind('unassigned', null); h.busy.add('busy-legacy');
  const missing = path.join(h.root, 'offline-project');
  const batch = [
    { id: 'assigned', projectId: 'removed-project', workingDir: h.folders[1] },
    { id: 'unassigned', projectId: existing.id, workingDir: existing.path },
    { id: 'same-project', workingDir: path.join(existing.path, '.') },
    { id: 'offline', workingDir: { path: missing, name: 'Old label' } },
    { id: 'offline-duplicate', workingDir: missing },
    { id: 'busy-legacy', workingDir: missing },
    { id: 'fork', workingDir: h.folders[1], sdkForkWorkspace: { path: h.folders[1] } },
    { id: 'fork-project', projectId: existing.id, sdkForkWorkspace: { path: h.folders[1] } },
    { id: 'plain' }, null, { id: '../invalid' },
    { id: 'offline', projectId: 'removed-project' },
  ];
  const original = clone(batch);
  assert.equal(h.store.adoptMany(batch), 7); assert.deepEqual(batch, original);
  assert.equal(h.store.binding('assigned'), existing.id); assert.equal(h.store.binding('unassigned'), null);
  assert.equal(h.store.binding('same-project'), existing.id);
  const offlineId = h.store.binding('offline');
  assert.equal(h.store.binding('offline-duplicate'), offlineId); assert.equal(h.store.binding('busy-legacy'), offlineId);
  assert.equal(h.store.get(offlineId).path, missing); assert.equal(fs.existsSync(missing), false);
  assert.equal(h.store.binding('fork'), null); assert.equal(h.store.binding('fork-project'), existing.id);
  assert.equal(h.store.binding('plain'), null); assert.equal(h.store.list().length, 2);
  assert.equal(h.store.decorate(batch[6]).workingDir.path, h.folders[1]);
});

test('empty and fully adopted batches never write the registry', t => {
  const h = fixture(t); h.store.adopt({ id: 'existing' });
  const before = fs.readFileSync(h.filePath, 'utf8');
  t.mock.method(fs, 'writeFileSync', () => { throw Error('Unexpected write'); });
  t.mock.method(fs, 'renameSync', () => { throw Error('Unexpected rename'); });
  assert.equal(h.store.adoptMany([]), 0);
  assert.equal(h.store.adoptMany([null, { id: '../bad' }, { id: 'existing', projectId: 'stale-project' }]), 0);
  assert.equal(fs.readFileSync(h.filePath, 'utf8'), before);
});

test('invalid later references and iteration errors roll back every staged binding and project', t => {
  const h = fixture(t), existing = h.store.add(h.folders[0]);
  const before = fs.readFileSync(h.filePath, 'utf8'), projects = h.store.list();
  const first = { id: 'staged', workingDir: h.folders[1] };
  assert.throws(() => h.store.adoptMany([first, { id: 'invalid-project', projectId: 'missing' }]), /项目已移除/);
  assert.throws(() => h.store.adoptMany([first, { id: 'invalid-path', workingDir: 'relative-folder' }]), /请选择项目文件夹/);
  function* interrupted() { yield first; throw Error('Synthetic unreadable history'); }
  assert.throws(() => h.store.adoptMany(interrupted()), /Synthetic unreadable history/);
  assert.equal(h.store.binding('staged'), undefined); assert.equal(h.store.binding('invalid-project'), undefined);
  assert.equal(h.store.binding('invalid-path'), undefined); assert.deepEqual(h.store.list(), projects);
  assert.equal(fs.readFileSync(h.filePath, 'utf8'), before); assert.equal(h.store.get(existing.id).path, h.folders[0]);
});

test('failed batch rename leaves durable data and cached membership unchanged, allowing a later retry', t => {
  const h = fixture(t), existing = h.store.add(h.folders[0]); h.store.bind('original', existing.id);
  const before = fs.readFileSync(h.filePath, 'utf8'), projects = h.store.list();
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', function (from, to) {
    if (to === h.filePath) throw Object.assign(Error('Synthetic rename denied'), { code: 'EPERM' });
    return rename.call(fs, from, to);
  });
  const batch = [{ id: 'first', workingDir: h.folders[1] }, { id: 'second' }];
  assert.throws(() => h.store.adoptMany(batch), { code: 'EPERM' });
  assert.deepEqual(h.store.list(), projects); assert.equal(h.store.binding('first'), undefined);
  assert.equal(h.store.binding('second'), undefined); assert.equal(h.store.binding('original'), existing.id);
  assert.equal(fs.readFileSync(h.filePath, 'utf8'), before);
  mocked.mock.restore(); assert.equal(h.store.adoptMany(batch), 2);
  assert.equal(h.store.list().length, 2); assert.equal(h.store.binding('second'), null);
});
