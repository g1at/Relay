'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTurnDeliveryService, protectTurnDeliverables } = require('../src/main/app/turn-delivery-service');
const { createDeliveryProgressStore } = require('../src/main/app/turn-delivery-progress');
const { completeConversationTurn } = require('../src/main/app/conversation-mutations');
const { listOutputLibrary } = require('../src/main/app/output-library');
const clone = value => JSON.parse(JSON.stringify(value));
async function fixture(t, { durable = false, terminalStatus = () => null } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-delivery-service-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const outputDir = path.join(cwd, 'outputs'), scratchDir = path.join(cwd, 'scratch');
  await fs.mkdir(outputDir); await fs.mkdir(scratchDir);
  const turnTs = '2026-10-15T06:00:00.000Z', runId = 'run-a', conversationId = 'conv-a';
  let record = { id: conversationId, title: 'original', updatedAt: turnTs, turns: [{ runId, ts: turnTs, user: 'create report' }] };
  let deleted = false; const events = [], errors = [];
  const load = id => id === record.id && !deleted ? clone(record) : null;
  const persist = value => { record = clone(value); };
  const progress = durable ? createDeliveryProgressStore({ rootDir: path.join(cwd, 'delivery-progress'), canWrite: () => !deleted }) : null;
  const serviceOptions = { load, persist, canWrite: () => !deleted, emit: value => events.push(value), onError: error => errors.push(error), progress, terminalStatus };
  const service = createTurnDeliveryService(serviceOptions);
  const input = { conversationId, runId, turnTs, cwd, outputDir, scratchDir };
  return { service, serviceOptions, progress, input, load, persist, events, errors, read: () => clone(record), change: fn => { record = fn(record); },
    delete: () => { deleted = true; }, write: async (name = 'report.md') => {
      const file = path.join(outputDir, name); await fs.writeFile(file, 'verified report'); return file;
    } };
}
test('real bounded output changes are persisted on the exact turn without final prose', async t => {
  const f = await fixture(t); await f.service.begin(f.input); const file = await f.write();
  f.service.observe(f.input.runId, { type: 'job-done', jobId: f.input.runId, exitCode: 0 });
  const result = await f.service.get(f.input);
  assert.equal(result.snapshot.items[0].path, await fs.realpath(file));
  assert.equal(result.snapshot.items[0].source, 'output-delta');
  assert.equal(f.events.length, 1); assert.equal(f.read().updatedAt, f.input.turnTs);
});
async function recordRunningWrite(f) {
  const file = await f.write();
  f.service.observe(f.input.runId, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'write-live', name: 'Write', input: { file_path: file } }] } });
  f.service.observe(f.input.runId, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-live', content: 'ok' }] } });
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const snapshots = await f.progress.read(f.input.conversationId);
    if (snapshots[0]?.items.length) return snapshots[0];
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('verified write was not durably recorded');
}
test('running files survive a new service without rewriting large history on each receipt', async t => {
  const f = await fixture(t, { durable: true }); await f.service.begin(f.input);
  const value = await recordRunningWrite(f);
  assert.equal(f.read().turns[0].deliverables, undefined);
  const reopened = createTurnDeliveryService(f.serviceOptions);
  assert.deepEqual((await reopened.get(f.input)).snapshot, value);
  assert.equal(f.read().turns[0].deliverables, undefined, 'no executor-state guess on reopen');
  await f.service.finish(f.input.runId);
  assert.equal(f.read().turns[0].deliverables.status, 'complete');
  assert.deepEqual(await f.progress.read(f.input.conversationId), []);
  assert.deepEqual(f.errors, []);
});
test('ledger-confirmed recovered files archive to exact turns and release progress capacity', async t => {
  const f = await fixture(t, { durable: true }); await f.service.begin(f.input);
  const value = await recordRunningWrite(f);
  for (let index = 1; index < 8; index++) {
    const runId = 'crashed-' + index;
    f.change(record => ({ ...record, turns: [...record.turns, { runId, ts: f.input.turnTs }] }));
    await f.progress.save({ ...value, runId });
  }
  const reopened = createTurnDeliveryService({ ...f.serviceOptions, terminalStatus: () => 'interrupted' });
  const latest = f.read(); latest.title = 'renamed after crash'; f.persist(latest);
  const hydrated = await reopened.hydrate(f.read());
  assert.equal(hydrated.turns.length, 8);
  assert.ok(hydrated.turns.every(turn => turn.deliverables.status === 'interrupted' && !turn.deliverables.complete));
  assert.equal(f.read().title, latest.title); assert.equal(f.read().updatedAt, latest.updatedAt);
  assert.deepEqual(await f.progress.read(f.input.conversationId), []);
  const runId = 'next-run'; f.change(record => ({ ...record, turns: [...record.turns, { runId, ts: f.input.turnTs }] }));
  await reopened.begin({ ...f.input, runId });
  await f.progress.save({ ...value, runId });
  assert.equal((await f.progress.read(f.input.conversationId))[0].runId, runId);
  assert.deepEqual(f.errors, []);
});
test('failed recovery persistence retains sidecar and keeps history readable', async t => {
  const f = await fixture(t, { durable: true }); await f.service.begin(f.input); await recordRunningWrite(f);
  const reopened = createTurnDeliveryService({ ...f.serviceOptions, terminalStatus: () => 'interrupted', persist: () => { throw Error('simulated full disk'); } });
  const reply = await reopened.get(f.input);
  assert.equal(reply.snapshot.items.length, 1); assert.equal((await f.progress.read(f.input.conversationId)).length, 1);
  assert.equal(f.read().turns[0].deliverables, undefined);
  assert.equal(f.errors[0].message, 'simulated full disk');
});
test('concurrent recovery writes once and never recreates missing history', async t => {
  const f = await fixture(t, { durable: true }); await f.service.begin(f.input); await recordRunningWrite(f);
  let writes = 0;
  const reopened = createTurnDeliveryService({ ...f.serviceOptions, terminalStatus: () => 'interrupted',
    persist: record => { writes++; f.persist(record); } });
  await Promise.all([reopened.hydrate(f.read()), reopened.hydrate(f.read())]);
  assert.equal(writes, 1); assert.equal(f.read().turns[0].deliverables.status, 'interrupted');
  const next = await fixture(t, { durable: true }); await next.service.begin(next.input); await recordRunningWrite(next);
  const missing = createTurnDeliveryService({ ...next.serviceOptions, terminalStatus: () => 'interrupted', load: () => null,
    persist: () => { throw Error('must not recreate history'); } });
  assert.equal(await missing.hydrate(next.read()), null);
  assert.equal((await next.progress.read(next.input.conversationId)).length, 1);
  const rejected = createTurnDeliveryService({ ...next.serviceOptions, terminalStatus: () => 'interrupted', persist: () => false });
  assert.equal((await rejected.hydrate(next.read())).turns[0].deliverables.items.length, 1);
  assert.equal(next.read().turns[0].deliverables, undefined);
  assert.equal((await next.progress.read(next.input.conversationId)).length, 1);
});
test('completion re-reads latest history and preserves newer turns, title and metadata', async t => {
  const f = await fixture(t); await f.service.begin(f.input); await f.write();
  const next = { runId: 'run-b', ts: '2026-10-15T06:01:00.000Z', user: 'newer', assistant: 'keep' };
  f.change(record => ({ ...record, title: 'renamed', updatedAt: next.ts, turns: [...record.turns, next] }));
  await f.service.finish(f.input.runId);
  assert.deepEqual(f.read().turns[1], next); assert.equal(f.read().title, 'renamed'); assert.equal(f.read().updatedAt, next.ts);
});
test('completion IPC cannot overwrite host delivery metadata and stale full save retains it', async t => {
  const f = await fixture(t); await f.service.begin(f.input); const old = f.read(); await f.write(); await f.service.finish(f.input.runId);
  const expected = f.read().turns[0].deliverables;
  completeConversationTurn({ load: f.load, persist: f.persist }, f.input.conversationId, f.input.runId, f.input.turnTs,
    { turn: { assistant: 'done', deliverables: { forged: true } } });
  assert.deepEqual(f.read().turns[0].deliverables, expected);
  old.turns[0].deliverables = { forged: true }; protectTurnDeliverables(old, f.read());
  assert.deepEqual(old.turns[0].deliverables, expected);
  const fresh = { ...old, id: 'new-conv' }; protectTurnDeliverables(fresh, null); assert.equal(fresh.turns[0].deliverables, undefined);
});
test('deleted, replaced and duplicate turn identities reject late writes', async t => {
  for (const action of ['delete', 'timestamp', 'duplicate']) {
    const f = await fixture(t); await f.service.begin(f.input); await f.write();
    if (action === 'delete') f.delete();
    else f.change(record => ({ ...record, turns: action === 'duplicate' ? [...record.turns, clone(record.turns[0])]
      : [{ ...record.turns[0], ts: '2026-10-15T07:00:00.000Z' }] }));
    assert.equal(await f.service.finish(f.input.runId), null); assert.equal(f.events.length, 0);
    assert.equal(f.read().turns[0].deliverables, undefined);
  }
});
test('wrong conversation and path-shaped identifiers cannot retrieve another turn', async t => {
  const f = await fixture(t); await f.service.begin(f.input); await f.write(); await f.service.finish(f.input.runId);
  for (const conversationId of ['conv-b', '../conv-a', '']) assert.equal((await f.service.get({ ...f.input, conversationId })).snapshot, null);
  const reopened = createTurnDeliveryService({ load: f.load, persist: f.persist });
  assert.equal((await reopened.get(f.input)).snapshot.items.length, 1);
});
test('child/intermediate results do not finish or replace root final selection', async t => {
  const f = await fixture(t); await f.service.begin({ ...f.input, outputDir: f.input.cwd });
  const file = path.join(f.input.cwd, 'report.md'); await fs.writeFile(file, 'root report');
  f.service.observe(f.input.runId, { type: 'result', result: `[report](${file})` });
  f.service.observe(f.input.runId, { type: 'result', agent_id: 'child', result: 'child text' });
  assert.equal(f.events.length, 0);
  await f.service.finish(f.input.runId); assert.equal(f.read().turns[0].deliverables.items[0].path, await fs.realpath(file));
});
test('a failed task keeps verified files without claiming task success', async t => {
  const f = await fixture(t); await f.service.begin(f.input); await f.write();
  f.service.observe(f.input.runId, { type: 'job-done', exitCode: 1, error: 'failure' });
  const result = await f.service.get(f.input); assert.equal(result.snapshot.status, 'failed'); assert.equal(result.snapshot.items.length, 1);
});
test('native terminal results, aborts and successful retries determine delivery status', async t => {
  for (const [result, expected] of [
    [{ type: 'result', subtype: 'error_during_execution', is_error: true }, 'failed'],
    [{ type: 'result', subtype: 'success', terminal_reason: 'aborted_streaming' }, 'canceled'],
    [{ type: 'result', subtype: 'success', permission_denials: [{ tool_name: 'Write' }] }, 'failed'],
    [{ type: 'result', subtype: 'success', is_error: false }, 'complete'],
  ]) {
    const f = await fixture(t); await f.service.begin(f.input); await f.write();
    f.service.observe(f.input.runId, { type: 'result', subtype: 'error_during_execution', is_error: true });
    f.service.observe(f.input.runId, { type: 'job-done', exitCode: 0, finalResult: result });
    const reply = await f.service.get(f.input);
    assert.equal(reply.snapshot.status, expected); assert.equal(reply.snapshot.items.length, 1);
  }
});
test('child result cannot turn a successful root completion into failure', async t => {
  const f = await fixture(t); await f.service.begin(f.input);
  f.service.observe(f.input.runId, { type: 'result', subtype: 'success' });
  f.service.observe(f.input.runId, { type: 'result', subagent_type: 'writer', subtype: 'error_during_execution', is_error: true });
  await f.service.finish(f.input.runId);
  assert.equal(f.read().turns[0].deliverables.status, 'complete');
});
test('forget during finalization cannot resurrect a deleted conversation', async t => {
  const f = await fixture(t); await f.service.begin(f.input); await f.write();
  const pending = f.service.finish(f.input.runId); f.service.forgetConversation(f.input.conversationId);
  assert.equal(await pending, null); assert.equal(f.events.length, 0);
});
test('registered output enters library with turn identity; source citations stay out', async t => {
  const f = await fixture(t); await f.service.begin(f.input); const report = await f.write(); await f.service.finish(f.input.runId);
  const source = path.join(f.input.cwd, 'source.js'); await fs.writeFile(source, 'const x=1');
  const record = f.read(); record.turns[0].assistant = `[source](${source}:3)`;
  const historyDir = path.join(f.input.cwd, 'history'); await fs.mkdir(historyDir);
  await fs.writeFile(path.join(historyDir, record.id + '.json'), JSON.stringify(record));
  const result = await listOutputLibrary({ historyDir, locations: [{ ...f.input, outputDir: f.input.cwd }] });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].path, await fs.realpath(report));
  assert.deepEqual(result.items[0].deliveries, [{ conversationId: record.id, runId: f.input.runId, turnTs: f.input.turnTs }]);
});
