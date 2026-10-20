'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshot, applySnapshot, canRenderSnapshot, createController } = require('../renderer/turn-deliverables');
const snapshot = (overrides = {}) => ({ version: 1, conversationId: 'a', runId: 'run-1', turnTs: '2026-10-15T01:00:00Z',
  status: 'complete', complete: true, warnings: [], items: [{ id: 'file-1', path: 'D:\\output\\report.md', name: '核对报告', size: 17, mtimeMs: 1, source: 'output-directory' }], ...overrides });
const turn = (overrides = {}) => ({ runId: 'run-1', ts: '2026-10-15T01:00:00Z', assistant: '', ...overrides });

test('structured snapshot is independent of answer text and preserves file metadata', () => {
  const conv = { id: 'a', turns: [turn()] }, value = snapshot();
  const accepted = applySnapshot(value, { conversation: conv });
  assert.equal(accepted.stored.index, 0); assert.equal(conv.turns[0].assistant, '');
  assert.deepEqual(conv.turns[0].deliverables.items[0], value.items[0]);
});
test('only exact conversation run and original send time own the result', () => {
  for (const value of [snapshot({ conversationId: 'b' }), snapshot({ runId: 'unknown' }), snapshot({ turnTs: 'later' })]) {
    const conv = { id: 'a', turns: [turn()] }; assert.equal(applySnapshot(value, { conversation: conv }), null);
    assert.equal(conv.turns[0].deliverables, undefined);
  }
});
test('reused send timestamps still match by run rather than the last turn', () => {
  const first = turn(), second = turn({ runId: 'run-2' }), conv = { id: 'a', turns: [first, second] };
  applySnapshot(snapshot(), { conversation: conv });
  assert.ok(first.deliverables); assert.equal(second.deliverables, undefined);
});
test('duplicate run ids use original send time and ambiguous identical identities are refused', () => {
  const first = turn(), second = turn({ ts: 'other-time' });
  const accepted = applySnapshot(snapshot(), { conversation: { id: 'a', turns: [first, second] } });
  assert.equal(accepted.stored.turn, first); assert.equal(second.deliverables, undefined);
  assert.equal(applySnapshot(snapshot(), { conversation: { id: 'a', turns: [turn(), turn()] } }), null);
});
test('background completion updates only its own live task', () => {
  const current = { id: 'b', turns: [turn()] }, run = { convId: 'a', jobId: 'run-1', turn: turn() };
  assert.ok(applySnapshot(snapshot(), { conversation: current, run }));
  assert.ok(run.turn.deliverables); assert.equal(current.turns[0].deliverables, undefined);
  assert.equal(applySnapshot(snapshot(), { run: { ...run, convId: 'b' } }), null);
});
test('malformed or remote items cannot become local result actions', () => {
  assert.equal(normalizeSnapshot(snapshot({ version: 2 })), null);
  assert.equal(normalizeSnapshot(snapshot({ turnTs: '' })), null);
  const value = normalizeSnapshot(snapshot({ items: [
    { id: 'javascript', path: 'javascript:alert(1)' }, { id: 'remote', path: 'https://fixture.invalid/file' },
    { id: 'relative', path: '../other/report.md' }, { id: 'nul', path: '/tmp/a\0b' },
    { id: 'one', path: '/tmp/report.md', name: '<script>literal</script>', size: -1 },
    { id: 'one', path: '/tmp/duplicate.md' }, { id: 'unc', path: '\\\\server\\share\\file.pdf' },
  ] }));
  assert.deepEqual(value.items.map(item => item.id), ['one', 'unc']); assert.equal(value.items[0].size, undefined);
  assert.equal(value.items[0].name, '<script>literal</script>');
});
test('later refresh is not allowed to overwrite a changed event', async () => {
  let release, changed;
  const conv = { id: 'a', turns: [turn()] };
  const controller = createController({ getConversation: () => conv, bridge: {
    get: () => new Promise(resolve => { release = resolve; }), onChanged: callback => { changed = callback; },
  } });
  const waiting = controller.refresh('a', 'run-1');
  changed({ conversationId: 'a', runId: 'run-1', snapshot: snapshot({ items: [{ id: 'new', path: '/tmp/new.txt' }] }) });
  release({ ok: true, snapshot: snapshot() });
  assert.equal(await waiting, false); assert.equal(conv.turns[0].deliverables.items[0].id, 'new'); controller.destroy();
});
test('a slow refresh cannot attach its result to the currently selected unrelated conversation', async () => {
  let release;
  let conv = { id: 'a', turns: [turn()] };
  const original = conv;
  const controller = createController({ getConversation: () => conv, bridge: { get: () => new Promise(resolve => { release = resolve; }) } });
  const waiting = controller.refresh('a', 'run-1'); conv = { id: 'b', turns: [turn()] };
  release({ ok: true, snapshot: snapshot() });
  assert.equal(await waiting, false); assert.equal(conv.turns[0].deliverables, undefined);
  assert.equal(original.turns[0].deliverables, undefined); controller.destroy();
});
test('missing files or failed lookup never reject the terminal refresh', async () => {
  for (const get of [async () => { throw Error('disk unavailable'); }, async () => ({ ok: false, code: 'NOT_FOUND' }), async () => ({ ok: true, snapshot: null })]) {
    const controller = createController({ getConversation: () => ({ id: 'a', turns: [turn()] }), bridge: { get } });
    assert.equal(await controller.refresh('a', 'run-1'), false); controller.destroy();
  }
});
test('destroy removes listener and late responses cannot mutate history', async () => {
  let release, removed = 0;
  const conv = { id: 'a', turns: [turn()] };
  const controller = createController({ getConversation: () => conv, bridge: {
    get: () => new Promise(resolve => { release = resolve; }), onChanged: () => () => removed++,
  } });
  const waiting = controller.refresh('a', 'run-1'); controller.destroy(); release({ ok: true, snapshot: snapshot() });
  assert.equal(await waiting, false); assert.equal(removed, 1); assert.equal(conv.turns[0].deliverables, undefined);
});

test('running and finishing snapshots stay data-only even if files are already verified', () => {
  for (const status of ['running', 'finishing', '', 'unknown']) {
    const value = snapshot({ status }), ownTurn = turn();
    const conv = { id: 'a', turns: [ownTurn] };
    assert.ok(applySnapshot(value, { conversation: conv }));
    assert.equal(canRenderSnapshot(ownTurn, ownTurn.deliverables), false);
  }
});
test('terminal host snapshot waits for its own live answer to finish rendering', () => {
  const ownTurn = turn(), value = snapshot();
  const run = { convId: 'a', jobId: 'run-1', turn: ownTurn, outputState: { status: 'running' } };
  assert.equal(canRenderSnapshot(ownTurn, value, run), false);
  run.outputState.status = 'complete'; assert.equal(canRenderSnapshot(ownTurn, value, run), true);
  assert.equal(canRenderSnapshot(ownTurn, value, { ...run, convId: 'other', outputState: { status: 'running' } }), true);
});
test('history terminal results remain visible after complete failed canceled or interrupted runs', () => {
  for (const status of ['complete', 'failed', 'canceled', 'interrupted']) assert.equal(canRenderSnapshot(turn(), snapshot({ status })), true);
  assert.equal(canRenderSnapshot(turn({ runId: 'other' }), snapshot()), false);
});
test('artifact lookup cannot return targets without a mounted owning result view', () => {
  const controller = createController({ getConversation: () => ({ id: 'a', turns: [turn()] }) });
  assert.equal(controller.getArtifactTarget({ conversationId: 'a', runId: 'run-1', turnTs: turn().ts, itemId: 'file-1' }), null);
  controller.destroy(); assert.equal(controller.getArtifactTarget({ conversationId: 'a', runId: 'run-1', turnTs: turn().ts, itemId: 'file-1' }), null);
});
