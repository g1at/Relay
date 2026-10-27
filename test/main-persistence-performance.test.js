'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TaskLedger } = require('../src/main/tasks/task-ledger');
const { RUN_STATES } = require('../src/main/tasks/task-protocol');
const { createHistoryStore } = require('../src/main/app/history-store');
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-main-persistence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function ledgerFixture(t) {
  const rootDir = temporary(t), ledger = new TaskLedger({ rootDir, logger: { warn() {} } });
  t.after(() => ledger.flush()); return { rootDir, ledger };
}
function historyFixture(t) {
  const rootDir = temporary(t);
  const history = createHistoryStore({ getUserDataDir: () => rootDir, recoverLegacyOutput: value => value });
  history.writeHistoryIndex([]);
  const record = { id: 'conversation-one', title: 'Original', kind: 'create', updatedAt: '2026-01-01T00:00:00Z',
    turns: [{ prompt: 'fixture', resultPaths: [] }], mediaComposer: { model: 'arbitrary::media::route', parameters: { audio: false } } };
  history.persistConversationRecord(record);
  return { rootDir, history, record };
}

test('state-filtered ledger views follow every transition and retain filters, ordering and detached snapshots', t => {
  const { ledger } = ledgerFixture(t);
  ledger.create({ runId: 'queued', source: { conversationId: 'conversation-one' }, kind: 'video' });
  ledger.create({ runId: 'active', state: RUN_STATES.RUNNING, kind: 'image' });
  ledger.create({ runId: 'historical', state: RUN_STATES.STARTING });
  ledger.terminal('historical', RUN_STATES.SUCCEEDED);
  assert.deepEqual(ledger.list({ state: RUN_STATES.QUEUED }).map(r => r.runId), ['queued']);
  assert.deepEqual(new Set(ledger.list({ terminal: false }).map(r => r.runId)), new Set(['queued', 'active']));
  ledger.update('queued', { state: RUN_STATES.STARTING });
  ledger.update('queued', { state: RUN_STATES.RUNNING });
  ledger.update('active', { state: RUN_STATES.WAITING_USER });
  assert.equal(ledger.list({ state: RUN_STATES.QUEUED }).length, 0);
  assert.equal(ledger.list({ states: [RUN_STATES.RUNNING, RUN_STATES.RUNNING], kind: 'video', conversationId: 'conversation-one' }).length, 1);
  assert.equal(ledger.list({ state: RUN_STATES.RUNNING, terminal: true }).length, 0);
  assert.equal(ledger.list({ states: [], terminal: false }).length, 0);
  const result = ledger.list({ terminal: false, limit: 1 });
  result[0].progress.label = 'tampered';
  assert.notEqual(ledger.get(result[0].runId).progress.label, 'tampered');
  ledger.terminal('queued', RUN_STATES.SUCCEEDED);
  assert.deepEqual(ledger.list({ terminal: false }).map(r => r.runId), ['active']);
  assert.equal(ledger.list({ terminal: true }).length, 2);
  assert.equal(ledger.list({ terminal: true, limit: 0 }).length, 0);
});

test('ledger state views refresh after external rebuild, cold file reads and retention', t => {
  const { rootDir, ledger } = ledgerFixture(t);
  const first = ledger.create({ runId: 'external', state: RUN_STATES.RUNNING });
  ledger.flush();
  first.state = RUN_STATES.WAITING_USER; first.revision++;
  fs.writeFileSync(path.join(rootDir, 'runs/external.json'), JSON.stringify(first));
  fs.writeFileSync(path.join(rootDir, 'index.json'), '{"fixture":"external change"}');
  assert.equal(ledger.list({ state: RUN_STATES.RUNNING }).length, 0);
  assert.equal(ledger.list({ state: RUN_STATES.WAITING_USER })[0].runId, 'external');
  const extra = { ...first, runId: 'cold-run' };
  fs.writeFileSync(path.join(rootDir, 'runs/cold-run.json'), JSON.stringify(extra));
  assert.equal(ledger.get('cold-run').state, RUN_STATES.WAITING_USER);
  assert.equal(ledger.list({ state: RUN_STATES.WAITING_USER }).length, 2);
  ledger.update('external', { state: RUN_STATES.RUNNING });
  ledger.terminal('external', RUN_STATES.SUCCEEDED);
  ledger.prune({ maxTerminalRuns: 0 });
  assert.equal(ledger.list({ terminal: true }).length, 0);
  ledger.rebuildIndex();
  assert.deepEqual(ledger.list({ terminal: false }).map(r => r.runId), ['cold-run']);
  const fresh = new TaskLedger({ rootDir, logger: { warn() {} } });
  assert.deepEqual(fresh.list({ terminal: false }), ledger.list({ terminal: false }));
});

test('failed durable ledger writes cannot move a task to another scheduling state', t => {
  const { ledger } = ledgerFixture(t);
  ledger.create({ runId: 'preserve-state' }); ledger.flush();
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (path.basename(target) === 'preserve-state.json') throw Object.assign(new Error('fixture locked'), { code: 'EPERM' }); return rename(source, target); };
  try { assert.throws(() => ledger.update('preserve-state', { state: RUN_STATES.STARTING }), /fixture locked/); }
  finally { fs.renameSync = rename; }
  assert.equal(ledger.list({ state: RUN_STATES.STARTING }).length, 0);
  assert.equal(ledger.list({ state: RUN_STATES.QUEUED })[0].revision, 1);
});

test('metadata-only history saves commit the body without repeatedly reading or rewriting its unchanged sidebar index', t => {
  const { history, record } = historyFixture(t);
  const indexPath = history.historyIndexPath(), original = fs.readFileSync(indexPath, 'utf8');
  const read = fs.readFileSync, rename = fs.renameSync;
  let indexReads = 0, indexWrites = 0;
  fs.readFileSync = (file, ...args) => { if (file === indexPath) indexReads++; return read(file, ...args); };
  fs.renameSync = (source, target) => { if (target === indexPath) indexWrites++; return rename(source, target); };
  try {
    for (let i = 0; i < 25; i++) {
      record.mediaComposer.parameters.duration = i;
      record.turns[0].resultPaths = ['result-' + i + '.png'];
      history.persistConversationRecord(record);
      assert.equal(history.readHistoryIndex()[0].id, record.id);
    }
    assert.equal(indexReads, 0); assert.equal(indexWrites, 0);
    record.updatedAt = '2026-02-01T00:00:00Z';
    history.persistConversationRecord(record);
    assert.equal(indexWrites, 1, 'sidebar-visible changes remain immediately committed');
  } finally { fs.readFileSync = read; fs.renameSync = rename; }
  const restored = history.loadConversation(record.id);
  assert.equal(restored.mediaComposer.parameters.duration, 24);
  assert.deepEqual(restored.turns[0].resultPaths, ['result-24.png']);
  assert.notEqual(fs.readFileSync(indexPath, 'utf8'), original);
  const another = createHistoryStore({ getUserDataDir: () => path.dirname(history.getHistoryDir()), recoverLegacyOutput: value => value });
  assert.equal(another.readHistoryIndex()[0].updatedAt, record.updatedAt);
});

test('history index snapshots stay detached and notice external writes, corruption and removal', t => {
  const { history, record } = historyFixture(t);
  const metadata = history.convMeta(record); metadata.fromScheduled = { id: 'schedule', nested: { value: 1 } };
  history.writeHistoryIndex([metadata]);
  metadata.fromScheduled.nested.value = 9;
  const first = history.readHistoryIndex(); first[0].fromScheduled.nested.value = 7; first.push({ id: 'fake' });
  assert.equal(history.readHistoryIndex()[0].fromScheduled.nested.value, 1);
  fs.writeFileSync(history.historyIndexPath(), JSON.stringify({ version: 2, items: [{ ...history.convMeta(record), title: 'Externally renamed' }] }));
  assert.equal(history.readHistoryIndex()[0].title, 'Externally renamed');
  fs.writeFileSync(history.historyIndexPath(), '{broken');
  assert.equal(history.readHistoryIndex()[0].title, record.title);
  fs.unlinkSync(history.historyIndexPath());
  assert.equal(history.readHistoryIndex()[0].id, record.id);
});

test('history deletion rollback and failed index writes do not expose uncommitted cached metadata', t => {
  const { history, record } = historyFixture(t);
  const rm = fs.rmSync;
  fs.rmSync = (file, ...args) => { if (file === history.convFilePath(record.id)) throw new Error('fixture body locked'); return rm(file, ...args); };
  try { assert.throws(() => history.removeConversationRecord(record.id, { loadRecord: false }), /fixture body locked/); }
  finally { fs.rmSync = rm; }
  assert.equal(history.readHistoryIndex()[0].id, record.id);
  assert.ok(history.loadConversation(record.id));
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => { if (target === history.historyIndexPath()) throw new Error('fixture index locked'); return rename(source, target); };
  try { history.writeHistoryIndex([{ id: 'not-committed' }]); }
  finally { fs.renameSync = rename; }
  assert.equal(history.readHistoryIndex()[0].id, record.id);
  history.removeConversationRecord(record.id, { loadRecord: false });
  assert.deepEqual(history.readHistoryIndex(), []);
  assert.equal(history.loadConversation(record.id), null);
});

test('state-filtered ledger ordering uses the existing run-id tie-breaker across states', t => {
  const rootDir = temporary(t);
  const ledger = new TaskLedger({ rootDir, now: () => new Date('2026-01-01T00:00:00Z'), logger: { warn() {} } });
  t.after(() => ledger.flush());
  ledger.create({ runId: 'b-running', state: RUN_STATES.RUNNING });
  ledger.create({ runId: 'c-queued' });
  ledger.create({ runId: 'a-running', state: RUN_STATES.RUNNING });
  const expected = ledger.list().map(run => run.runId);
  assert.deepEqual(expected, ['c-queued', 'b-running', 'a-running']);
  assert.deepEqual(ledger.list({ states: [RUN_STATES.RUNNING, RUN_STATES.QUEUED] }).map(run => run.runId), expected);
  assert.deepEqual(ledger.list({ states: [RUN_STATES.QUEUED, RUN_STATES.RUNNING] }).map(run => run.runId), expected);
});

test('history index cache detects atomic replacement even when size and mtime match', t => {
  const { history, record } = historyFixture(t), indexPath = history.historyIndexPath();
  history.readHistoryIndex();
  const previousStat = fs.statSync(indexPath), text = fs.readFileSync(indexPath, 'utf8');
  const next = text.replace('"Original"', '"Replaced"');
  assert.equal(next.length, text.length);
  fs.writeFileSync(indexPath + '.fixture', next);
  fs.utimesSync(indexPath + '.fixture', previousStat.atime, previousStat.mtime);
  fs.renameSync(indexPath + '.fixture', indexPath);
  assert.equal(history.readHistoryIndex()[0].title, 'Replaced');
  record.fromScheduled = { nested: { value: 1 } };
  history.persistConversationRecord(record);
  record.fromScheduled.nested.value = 10;
  assert.equal(history.readHistoryIndex()[0].fromScheduled.nested.value, 1);
});

test('an index commit failure repairs sidebar metadata from committed bodies without losing other histories', t => {
  const { history, record } = historyFixture(t);
  history.persistConversationRecord({ ...record, id: 'other-conversation', title: 'Preserved' });
  const rename = fs.renameSync;
  let failNextIndex = true, indexWrites = 0;
  fs.renameSync = (source, target) => {
    if (target === history.historyIndexPath()) {
      indexWrites++;
      if (failNextIndex) { failNextIndex = false; throw Object.assign(new Error('fixture transient index lock'), { code: 'EPERM' }); }
    }
    return rename(source, target);
  };
  try {
    record.title = 'Committed body title';
    record.updatedAt = '2026-03-01T00:00:00Z';
    history.persistConversationRecord(record);
    const restored = history.readHistoryIndex();
    assert.equal(restored.find(item => item.id === record.id).title, record.title);
    assert.equal(restored.find(item => item.id === record.id).updatedAt, record.updatedAt);
    assert.equal(restored.find(item => item.id === 'other-conversation').title, 'Preserved');
    assert.equal(indexWrites, 2, 'one failed write plus one repair');
    history.readHistoryIndex();
    assert.equal(indexWrites, 2, 'successful repair clears the dirty flag');
    failNextIndex = true;
    history.persistConversationRecord({ ...record, id: 'new-conversation', title: 'New body retained' });
    assert.equal(history.readHistoryIndex().length, 3);
    assert.equal(history.readHistoryIndex().find(item => item.id === 'new-conversation').title, 'New body retained');
  } finally { fs.renameSync = rename; }
});

test('legacy duplicate index rows preserve first-match update semantics', t => {
  const { history, record } = historyFixture(t);
  history.writeHistoryIndex([history.convMeta(record), { ...history.convMeta(record), title: 'Legacy duplicate' }]);
  record.title = 'Latest first row';
  history.persistConversationRecord(record);
  assert.deepEqual(history.readHistoryIndex().map(item => item.title), ['Latest first row', 'Legacy duplicate']);
});
