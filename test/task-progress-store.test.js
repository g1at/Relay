'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { TaskProgressStore, activityEventsForClaudeEvent } = require('../task-progress-store');
const { TaskEventJournal } = require('../task-event-journal');
const Activity = require('../renderer/activity-stream');
const Output = require('../renderer/assistant-output');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const stream = (type, data = {}, parent = null) => ({ type: 'stream_event', event: { type, ...data }, ...(parent ? { parent_tool_use_id: parent } : {}) });
const assistant = (id, text, extra = {}) => ({ type: 'assistant', uuid: `frame-${id}`, message: { id, content: [{ type: 'text', text }] }, ...extra });
const envelope = (seq, event, runId = 'run_fixture-1', epoch = 'epoch-one') => ({ schemaVersion: 1, type: 'run.event', runId, epoch, seq,
  emittedAt: '2026-09-21T00:00:00.000Z', payload: { event } });
async function until(check) {
  const end = Date.now() + 5000;
  while (!await check()) { if (Date.now() > end) throw new Error('Timed out awaiting progress persistence'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-progress-store-')), stores = [];
  const rootDir = path.join(root, 'progress');
  t.after(async () => { for (const store of stores) { try { await store.close(); } catch (_) {} } fs.rmSync(root, { recursive: true, force: true }); });
  const store = options => { const value = new TaskProgressStore({ rootDir, flushIntervalMs: 60000, logger: { warn() {} }, ...options }); stores.push(value); return value; };
  const disk = async (id = 'run_fixture-1') => JSON.parse(await fs.promises.readFile(path.join(rootDir, `${id}.json`), 'utf8'));
  return { root, rootDir, store, disk };
}

test('load includes observed unsaved progress, is detached, and never turns model prose into a final answer', async t => {
  const h = fixture(t), store = h.store();
  assert.equal(await store.load('never_seen'), null);
  store.observe([envelope(1, assistant('working', 'Work in progress'))]);
  const saved = await store.load('run_fixture-1');
  assert.equal(saved.seq, 1); assert.equal(saved.displayOnly, true); assert.equal(saved.output.final, '');
  assert.equal(Output.textFor(saved.output.messages[0]), 'Work in progress');
  assert.equal(fs.existsSync(h.rootDir), false, 'reads do not force an early disk write');
  saved.output.messages[0].blocks[0].text = 'caller mutation';
  assert.equal(Output.textFor((await store.load('run_fixture-1')).output.messages[0]), 'Work in progress');
  await store.close(); assert.equal((await h.disk()).seq, 1);
  assert.equal(store.observe([envelope(2, assistant('too-late', 'ignored'))]), false);
  assert.equal(store.close(), store.close());
});

test('a restart between thinking and text deltas preserves the accumulated stream and its original order', async t => {
  const h = fixture(t), first = h.store();
  first.observe([
    envelope(1, stream('message_start', { message: { id: 'root-stream' } })),
    envelope(2, stream('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })),
    envelope(3, stream('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Before restart. ' } })),
    envelope(4, stream('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })),
    envelope(5, stream('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Before ' } })),
  ]);
  await first.close();
  const second = h.store(); second.observe([
    envelope(5, stream('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'MUST NOT DUPLICATE' } })),
    envelope(6, stream('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'After restart.' } })),
    envelope(7, stream('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'after' } })),
  ]);
  const restored = await second.load('run_fixture-1');
  const thinking = restored.activity.items.filter(item => item.type === 'thinking');
  assert.equal(thinking.length, 1); assert.equal(thinking[0].title, 'Before restart. After restart.');
  assert.equal(thinking[0].order, 2); assert.equal(thinking[0].status, 'running');
  assert.equal(Output.textFor(restored.output.messages[0]), 'Before after');
  assert.equal(restored.output.messages[0].blocks.find(block => block.type === 'text').order, 4);
});

test('unfinished tool input remains unconfirmed across restart and later deltas/result complete the same row', async t => {
  const h = fixture(t), first = h.store();
  first.observe([
    envelope(1, stream('message_start', { message: { id: 'tool-stream' } })),
    envelope(2, stream('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'read-one', name: 'Read', input: {} } })),
    envelope(3, stream('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"' } })),
  ]);
  await first.close();
  const second = h.store(); const pending = await second.load('run_fixture-1');
  assert.equal(pending.activity.items[0].status, 'preparing'); assert.notEqual(pending.activity.items[0].resultConfirmed, true);
  second.observe([
    envelope(4, stream('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'note.txt"}' } })),
    envelope(5, stream('content_block_stop', { index: 0 })),
    envelope(6, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-one', content: '' }] } }),
  ]);
  const saved = await second.load('run_fixture-1');
  assert.equal(saved.activity.items.length, 1); assert.equal(saved.activity.items[0].input.file_path, 'note.txt');
  assert.equal(saved.activity.items[0].resultConfirmed, true); assert.equal(saved.activity.items[0].status, 'success');
});

test('rolled journal retention cannot remove earlier cumulative progress or truncate it to 1000 items', async t => {
  const h = fixture(t), store = h.store();
  const journal = new TaskEventJournal({ rootDir: path.join(h.root, 'journal'), epoch: 'long-epoch', maxEvents: 128 });
  const frames = Array.from({ length: 1105 }, (_, index) => ({ type: 'run.event', runId: 'long_non_uuid', payload: { event: {
    type: 'assistant', uuid: `long-frame-${index}`, message: { id: `long-message-${index}`, content: [
      { type: 'thinking', thinking: `Reasoning ${index}` }, { type: 'text', text: `Step ${index}` },
      { type: 'tool_use', id: `tool-${index}`, name: 'Read', input: { file_path: `file-${index}.md` } },
    ] },
  } } }));
  store.observe(journal.appendMany(frames)); await store.close();
  assert.ok(journal.eventCount < frames.length);
  const restarted = h.store(), saved = await restarted.load('long_non_uuid');
  assert.equal(saved.output.messages.length, 1105); assert.equal(saved.activity.items.length, 2210);
  assert.equal(saved.output.messages[0].id, 'long-message-0'); assert.equal(saved.activity.items.at(-1).toolUseId, 'tool-1104');
  restarted.observe(journal.appendMany([{ type: 'run.event', runId: 'long_non_uuid', payload: { event: assistant('new-tail', 'Tail') } }]));
  await restarted.flush(); assert.equal((await h.disk('long_non_uuid')).output.messages.length, 1106);
});

test('child streams and terminal events never replace the root stream or finish the root', async t => {
  const h = fixture(t), store = h.store();
  store.observe([
    envelope(1, stream('message_start', { message: { id: 'root' } })),
    envelope(2, stream('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: 'Root reasoning' } })),
    envelope(3, stream('message_start', { message: { id: 'child' } }, 'agent-tool')),
    envelope(4, assistant('child', 'Child evidence', { parent_tool_use_id: 'agent-tool' })),
    envelope(5, { type: 'result', subtype: 'success', result: 'Child final', parent_tool_use_id: 'agent-tool' }),
    envelope(6, { type: 'job-done', exitCode: 0, parent_tool_use_id: 'agent-tool' }),
    envelope(7, stream('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: ' continues' } })),
  ]);
  const snapshot = await store.load('run_fixture-1');
  assert.equal(snapshot.terminal, false); assert.equal(snapshot.activity.phase, 'running'); assert.equal(snapshot.output.lastResult, null);
  assert.equal(snapshot.activity.items.find(item => item.type === 'thinking').title, 'Root reasoning continues');
  assert.equal(snapshot.output.messages.find(item => item.parent === 'agent-tool').blocks[0].text, 'Child evidence');
  assert.equal(snapshot.output.final, ''); assert.equal(fs.existsSync(h.rootDir), false);
});

test('root job-done persists immediately, evicts completed state, and cannot be reopened by a late child', async t => {
  const h = fixture(t), store = h.store();
  store.observe([
    envelope(1, { type: 'assistant', message: { id: 'tool', content: [{ type: 'tool_use', id: 'unconfirmed', name: 'Read', input: {} }] } }),
    envelope(2, { type: 'job-done', exitCode: 0, finalResult: { type: 'result', subtype: 'success', result: 'Actual final belongs to history' } }),
  ]);
  await until(() => fs.existsSync(path.join(h.rootDir, 'run_fixture-1.json')));
  await until(() => !store.entries.has('run_fixture-1'));
  let snapshot = await store.load('run_fixture-1');
  assert.equal(snapshot.terminal, true); assert.equal(snapshot.activity.phase, 'complete'); assert.equal(snapshot.output.final, '');
  assert.equal(snapshot.activity.items[0].status, 'unconfirmed');
  store.observe([envelope(3, assistant('late-child', 'Late child', { parent_tool_use_id: 'agent' }))]);
  snapshot = await store.load('run_fixture-1');
  assert.equal(snapshot.activity.phase, 'complete'); assert.equal(snapshot.output.messages.length, 1);
});

test('rapid updates use one throttled write instead of one write per event', async t => {
  const h = fixture(t); let writes = 0;
  const store = h.store({ flushIntervalMs: 30, fs: { ...fs.promises, rename: async (...args) => { writes++; return fs.promises.rename(...args); } } });
  for (let seq = 1; seq <= 25; seq++) store.observe([envelope(seq, assistant(`rapid-${seq}`, `Step ${seq}`))]);
  await until(() => writes === 1); await until(async () => (await h.disk()).seq === 25);
  await store.flush(); assert.equal(writes, 1);
});

test('a delayed old write cannot overwrite newer progress and concurrent flushes serialize per run', async t => {
  const h = fixture(t), entered = deferred(), release = deferred(); let writes = 0, active = 0, maxActive = 0;
  const store = h.store({ fs: { ...fs.promises, rename: async (...args) => {
    active++; maxActive = Math.max(maxActive, active); writes++;
    if (writes === 1) { entered.resolve(); await release.promise; }
    try { await fs.promises.rename(...args); } finally { active--; }
  } } });
  store.observe([envelope(1, assistant('one', 'One'))]); const firstFlush = store.flush(); await entered.promise;
  store.observe([envelope(2, assistant('two', 'Two'))]); assert.equal((await store.load('run_fixture-1')).seq, 2);
  const secondFlush = store.flush(); release.resolve(); await Promise.all([firstFlush, secondFlush]);
  assert.equal(maxActive, 1); assert.equal(writes, 2); assert.equal((await h.disk()).seq, 2);
  assert.equal((await h.disk()).output.messages.length, 2);
});

test('a failed atomic rename retains the previous file and dirty state, cleans temporary files, and retries', async t => {
  const h = fixture(t); let fail = false;
  const store = h.store({ fs: { ...fs.promises, rename: async (...args) => {
    if (fail) { fail = false; throw Object.assign(new Error('Synthetic rename denied'), { code: 'EPERM' }); }
    return fs.promises.rename(...args);
  } } });
  store.observe([envelope(1, assistant('one', 'One'))]); await store.flush();
  fail = true; store.observe([envelope(2, assistant('two', 'Two'))]); await assert.rejects(store.flush(), /flush failed/);
  assert.equal((await h.disk()).seq, 1); assert.equal((await store.load('run_fixture-1')).seq, 2);
  assert.deepEqual(fs.readdirSync(h.rootDir), ['run_fixture-1.json']);
  await store.flush(); assert.equal((await h.disk()).seq, 2);
});

test('automatic retry persists failed writes without requiring a new event', async t => {
  const h = fixture(t); let writes = 0;
  const store = h.store({ flushIntervalMs: 20, fs: { ...fs.promises, rename: async (...args) => {
    if (++writes === 1) throw new Error('Transient storage failure'); return fs.promises.rename(...args);
  } } });
  store.observe([envelope(1, assistant('retry', 'Retained until saved'))]);
  await until(() => fs.existsSync(path.join(h.rootDir, 'run_fixture-1.json')));
  assert.equal(writes, 2); assert.equal((await h.disk()).seq, 1);
});

test('parallel runs remain separate and one storage error does not prevent saving another run', async t => {
  const h = fixture(t); let fail = true;
  const store = h.store({ fs: { ...fs.promises, rename: async (from, to) => {
    if (fail && to.endsWith('first.json')) { fail = false; throw new Error('One failed run'); }
    return fs.promises.rename(from, to);
  } } });
  store.observe([envelope(1, assistant('a', 'First'), 'first'), envelope(2, assistant('b', 'Second'), 'second')]);
  await assert.rejects(store.flush()); assert.equal((await h.disk('second')).output.messages[0].id, 'b');
  await store.flush(); assert.equal((await h.disk('first')).output.messages[0].id, 'a');
  assert.equal((await h.disk('second')).output.messages.length, 1);
});

test('old reducer snapshots hydrate without inventing tool receipts and accept a real subsequent result', async t => {
  const h = fixture(t); fs.mkdirSync(h.rootDir);
  fs.writeFileSync(path.join(h.rootDir, 'legacy-run.json'), JSON.stringify({ version: 1, runId: 'legacy-run', epoch: 'old', seq: 8,
    activity: { version: 8, phase: 'running', items: [{ id: 'unfinished', toolUseId: 'unfinished', type: 'tool', status: 'running', toolName: 'Read' }] },
    output: { version: 3, messages: [] } }));
  const store = h.store(), snapshot = await store.load('legacy-run');
  assert.equal(snapshot.activity.version, Activity.VERSION); assert.equal(snapshot.activity.items[0].status, 'running');
  store.observe([envelope(9, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unfinished', content: 'Read complete' }] } }, 'legacy-run', 'old')]);
  const updated = await store.load('legacy-run'); assert.equal(updated.activity.items.length, 1);
  assert.equal(updated.activity.items[0].resultConfirmed, true); assert.equal(updated.activity.items[0].status, 'success');
});

test('epoch-local sequence resets are allowed while old epoch delivery cannot roll the snapshot backward', async t => {
  const h = fixture(t), first = h.store();
  first.observe([envelope(99, assistant('old', 'Previous epoch'), 'epoch-run', 'old')]); await first.close();
  const next = h.store(); next.observe([
    envelope(1, assistant('new', 'New epoch'), 'epoch-run', 'new'),
    envelope(100, assistant('late', 'Late old epoch'), 'epoch-run', 'old'),
    envelope(1, assistant('duplicate', 'Duplicate sequence'), 'epoch-run', 'new'),
    envelope(2, assistant('tail', 'New tail'), 'epoch-run', 'new'),
  ]);
  const snapshot = await next.load('epoch-run');
  assert.equal(snapshot.epoch, 'new'); assert.equal(snapshot.seq, 2);
  assert.deepEqual(snapshot.output.messages.map(item => item.id), ['old', 'new', 'tail']);
});

test('protocol-valid non-UUID run IDs work while malformed IDs cannot reach paths outside the store', async t => {
  const h = fixture(t), store = h.store();
  for (const id of ['named_run-123', 'constructor']) store.observe([envelope(1, assistant(id, id), id)]);
  for (const id of ['../outside', 'a/b', '', 'a.json']) {
    await assert.rejects(store.load(id), /Invalid progress runId/);
    store.observe([envelope(1, assistant('invalid', 'invalid'), id)]);
  }
  await store.flush(); assert.deepEqual(fs.readdirSync(h.rootDir).sort(), ['constructor.json', 'named_run-123.json']);
});

test('legacy task-notification mapping stays equivalent to the actual renderer function', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const start = source.indexOf('function activityEventsForClaudeEvent('), end = source.indexOf('\nfunction permissionDenialMessage(', start);
  const context = {}; vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const state = { items: [{ taskId: 'task-a', toolUseId: 'tool-a' }] };
  for (const content of ['ordinary input', '<task-notification><task-id>task-a</task-id><status>completed</status><result>Evidence</result></task-notification>',
    '<task-notification><tool-use-id>tool-b</tool-use-id><status>failed</status><summary>Stopped</summary><result>Error detail</result></task-notification>']) {
    const event = { type: 'user', message: { content } };
    assert.deepEqual(activityEventsForClaudeEvent(event, state), JSON.parse(JSON.stringify(context.activityEventsForClaudeEvent(event, state))));
  }
});

test('progress item presentation order matches renderer output-first reduction including child and notification events', async t => {
  const h = fixture(t), store = h.store();
  const events = [
    assistant('intro', 'Starting'),
    { type: 'assistant', message: { id: 'mixed', content: [{ type: 'thinking', thinking: 'Reason' }, { type: 'tool_use', id: 'agent-one', name: 'Agent', input: {} }] } },
    assistant('child', 'Child detail', { parent_tool_use_id: 'agent-one' }),
    { type: 'user', message: { content: '<task-notification><task-id>task-one</task-id><tool-use-id>agent-one</tool-use-id><status>completed</status><result>Child result</result></task-notification>' } },
    assistant('tail', 'Continuing'),
  ];
  const activity = Activity.createState(), output = Output.createState();
  for (const event of events) {
    Output.ingest(output, event);
    for (const [index, mapped] of activityEventsForClaudeEvent(event, activity).entries()) Activity.ingest(activity, { ...mapped, presentation_order: output.eventOrder + index / 1000 });
  }
  store.observe(events.map((event, index) => envelope(index + 1, event)));
  const snapshot = await store.load('run_fixture-1');
  assert.deepEqual(snapshot.activity.items.map(item => [item.id, item.type, item.order]), activity.items.map(item => [item.id, item.type, item.order]));
  assert.deepEqual(snapshot.output.messages.map(item => [item.id, item.order]), output.messages.map(item => [item.id, item.order]));
});

test('remove waits for an in-flight atomic write and tombstones late events without affecting other runs', async t => {
  const h = fixture(t), entered = deferred(), release = deferred();
  const store = h.store({ fs: { ...fs.promises, rename: async (from, to) => {
    if (to.endsWith('removed.json')) { entered.resolve(); await release.promise; }
    return fs.promises.rename(from, to);
  } } });
  store.observe([envelope(1, assistant('remove', 'Temporary progress'), 'removed')]);
  const flushing = store.flush(); await entered.promise;
  let removed = false; const removal = store.remove('removed').then(() => { removed = true; });
  store.observe([envelope(2, assistant('late', 'Must not revive'), 'removed'), envelope(3, assistant('kept', 'Retained'), 'kept')]);
  assert.equal(await store.load('removed'), null); assert.equal(removed, false);
  release.resolve(); await Promise.all([flushing, removal]); await store.flush();
  assert.equal(fs.existsSync(path.join(h.rootDir, 'removed.json')), false);
  assert.equal((await h.disk('kept')).output.messages[0].id, 'kept');
  store.observe([envelope(4, assistant('later', 'Still deleted'), 'removed')]); await store.flush();
  assert.equal(await store.load('removed'), null); assert.equal(fs.existsSync(path.join(h.rootDir, 'removed.json')), false);
});

test('remove while the initial snapshot read is pending never recreates the deleted file', async t => {
  const h = fixture(t), initial = h.store();
  initial.observe([envelope(1, assistant('saved', 'Saved'), 'removed')]); await initial.close();
  const entered = deferred(), release = deferred();
  const store = h.store({ fs: { ...fs.promises, readFile: async (...args) => { entered.resolve(); await release.promise; return fs.promises.readFile(...args); } } });
  store.observe([envelope(2, assistant('pending', 'Pending'), 'removed')]); await entered.promise;
  const removal = store.remove('removed'); release.resolve(); await removal; await store.flush();
  assert.equal(fs.existsSync(path.join(h.rootDir, 'removed.json')), false); assert.equal(await store.load('removed'), null);
});

test('a lone root job-done preserves its complete terminal receipt without independently promoting a final answer', async t => {
  const h = fixture(t), store = h.store();
  const done = { type: 'job-done', exitCode: 0, jobId: 'root-final', durationMs: 1234,
    finalResult: { type: 'result', subtype: 'success', result: 'Only present in terminal receipt', num_turns: 3, user_message_uuids: ['synthetic-input'] } };
  store.observe([envelope(1, done, 'root-final')]); await store.flush();
  const restarted = h.store(), snapshot = await restarted.load('root-final');
  assert.deepEqual(snapshot.terminalEvent, done); assert.equal(snapshot.output.final, '');
  assert.equal(snapshot.output.messages.length, 0); assert.equal(snapshot.output.lastResult, null);
  restarted.observe([envelope(2, { ...done, parent_tool_use_id: 'child', finalResult: { ...done.finalResult, result: 'Late child' } }, 'root-final')]);
  assert.deepEqual((await restarted.load('root-final')).terminalEvent, done);
});

test('delivery sequence survives hydration independently of the journal sequence and supports old snapshots', async t => {
  const h = fixture(t), store = h.store();
  store.observe([envelope(1, { ...assistant('first', 'First'), relay_stream_seq: 104, relay_stream_epoch: 'epoch-one' })]);
  let saved = await store.load('run_fixture-1'); assert.equal(saved.seq, 1); assert.equal(saved.deliverySeq, 104);
  await store.close(); const restarted = h.store();
  saved = await restarted.load('run_fixture-1'); assert.equal(saved.seq, 1); assert.equal(saved.deliverySeq, 104);
  restarted.observe([envelope(2, { ...assistant('next', 'Next'), relay_stream_seq: 109, relay_stream_epoch: 'epoch-one' })]);
  saved = await restarted.load('run_fixture-1'); assert.equal(saved.seq, 2); assert.equal(saved.deliverySeq, 109);
  restarted.observe([envelope(7, assistant('legacy', 'Legacy event'), 'legacy-delivery')]);
  assert.equal((await restarted.load('legacy-delivery')).deliverySeq, 7);
});

test('a historical load already in flight cannot return progress after that run is removed', async t => {
  const h = fixture(t), initial = h.store();
  initial.observe([envelope(1, assistant('saved', 'Saved'), 'removed')]); await initial.close();
  const entered = deferred(), release = deferred();
  const store = h.store({ fs: { ...fs.promises, readFile: async (...args) => {
    const text = await fs.promises.readFile(...args); entered.resolve(); await release.promise; return text;
  } } });
  const loaded = store.load('removed'); await entered.promise;
  await store.remove('removed'); release.resolve(); assert.equal(await loaded, null);
});
