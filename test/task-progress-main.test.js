'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');

function fixture() {
  const handlers = new Map(), calls = [], records = new Map([
    ['old-run', { execution: { appInstanceId: 'old-instance' } }],
    ['new-run', { execution: { appInstanceId: 'new-instance' } }],
  ]);
  const context = vm.createContext({
    TASK_EVENT_EPOCH: 'new-instance', taskLedger: { get: id => records.get(id) },
    flushStreamJournalEvents: () => calls.push('flush'),
    streamEventJournal: { replayEpoch: input => { calls.push(JSON.parse(JSON.stringify(input))); return { events: [], epoch: input.epoch }; } },
    taskProgressStore: { load: async runId => ({ runId, epoch: records.get(runId)?.execution.appInstanceId, seq: 5 }) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  });
  const start = source.indexOf("ipcMain.handle('tasks:replayStream'");
  vm.runInContext(source.slice(start, source.indexOf("ipcMain.handle('tasks:ack'", start)), context);
  return { context, calls, records, invoke: (name, value) => handlers.get(name)({}, value) };
}

test('old stream IPC requires the owning run and epoch before reading any archive', () => {
  const h = fixture();
  for (const input of [{ epoch: 'old-instance' }, { epoch: 'old-instance', runId: 'new-run' },
    { epoch: '../outside', runId: 'old-run' }, { epoch: 'old-instance', runId: 'unknown-run' }]) {
    assert.equal(h.invoke('tasks:replayStream', input).ok, false);
  }
  assert.deepEqual(h.calls.filter(call => typeof call === 'object'), []);
  assert.equal(h.invoke('tasks:replayStream', { epoch: 'old-instance', runId: 'old-run', sinceSeq: 4, limit: 10 }).ok, true);
  assert.deepEqual(h.calls.at(-1), { epoch: 'old-instance', runId: 'old-run', sinceSeq: 4, limit: 10 });
});

test('progress IPC flushes buffered deltas and rejects a snapshot from a different execution', async () => {
  const h = fixture();
  assert.equal((await h.invoke('tasks:progress', 'old-run')).progress.seq, 5);
  assert.equal(h.calls[0], 'flush');
  h.context.taskProgressStore.load = async () => ({ epoch: 'foreign-instance', seq: 900 });
  assert.equal((await h.invoke('tasks:progress', 'old-run')).progress, null);
  assert.equal((await h.invoke('tasks:progress', 'unknown-run')).ok, false);
});

test('journal cursor sent live matches the durable envelope and snapshot observer', () => {
  const observed = [], persisted = [];
  const context = vm.createContext({
    TASK_EVENT_EPOCH: 'instance', streamEventSeq: 7, streamDeliverySeq: 7, streamJournalBuffer: [], streamJournalFlushTimer: null,
    console: { warn() {} }, setTimeout: () => ({ unref() {} }), clearTimeout() {},
    taskProgressStore: { observe: envelopes => observed.push(...envelopes) },
    streamEventJournal: { lastSeq: 7, appendMany(batch) {
      const envelopes = batch.map(item => ({ ...item, epoch: 'instance', seq: ++this.lastSeq }));
      persisted.push(...envelopes); return envelopes;
    } },
  });
  const start = source.indexOf('function journalClaudeEvent(');
  vm.runInContext(source.slice(start, source.indexOf('let taskLedger = null;', start)), context);
  const first = { type: 'stream_event' }, last = { type: 'job-done' };
  context.journalClaudeEvent('run', first);
  context.journalClaudeEvent('run', last);
  assert.equal(first.relay_stream_seq, 8);
  assert.equal(last.relay_stream_seq, 9);
  assert.equal(first.relay_stream_epoch, 'instance');
  assert.equal(observed.length, 2);
  assert.deepEqual(observed.map(row => row.seq), [8, 9]);
  assert.equal(observed[1], persisted[1]);
  const appendMany = context.streamEventJournal.appendMany;
  context.streamEventJournal.appendMany = () => { throw new Error('synthetic disk failure'); };
  const failed = { type: 'result' };
  context.journalClaudeEvent('run', failed);
  context.streamEventJournal.appendMany = appendMany;
  const recovered = { type: 'job-done' };
  context.journalClaudeEvent('run', recovered);
  assert.equal(failed.relay_stream_seq, 10);
  assert.equal(recovered.relay_stream_seq, 11, 'disk failure cannot reuse an already-delivered cursor and hide job-done');
  assert.equal(observed.at(-1).seq, 10, 'journal and live-delivery cursors can differ after IO failure');
});
