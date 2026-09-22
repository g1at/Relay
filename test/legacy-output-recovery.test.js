'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Output = require('../renderer/assistant-output');
const { createLegacyOutputRecovery, recoverSupplementReceipts } = require('../src/main/projects/legacy-output-recovery');
const ids = { conv: '11111111-1111-4111-8111-111111111111', run: '22222222-2222-4222-8222-222222222222', input: '33333333-3333-4333-8333-333333333333', other: '44444444-4444-4444-8444-444444444444' };
const copy = value => JSON.parse(JSON.stringify(value));
const result = (id, text, extra = {}) => ({ type: 'result', subtype: 'success', uuid: `result-${id}`, jobId: ids.run,
  session_id: 'fixture-native', user_message_uuid: id, user_message_uuids: [id], num_turns: 1,
  result: text, terminal_reason: 'completed', queued_turn_count: 0, ...extra });
function fixture(t, configure = () => {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-result-recovery-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const first = result(ids.run, 'Original independent answer'), last = result(ids.input, 'Supplemental weather answer');
  const state = Output.createState();
  for (const [index, event] of [first, last].entries()) {
    Output.ingest(state, { type: 'assistant', uuid: `frame-${index}`, message: {
      id: `message-${index}`, content: [{ type: 'text', text: event.result }], stop_reason: 'end_turn' } });
    Output.ingest(state, event);
  }
  Output.finish(state, { exitCode: 0, finalResult: last });
  const savedOutput = Output.serialize(state); savedOutput.version = 4;
  delete savedOutput.resultCandidates; delete savedOutput.answers;
  const turn = { runId: ids.run, user: 'Original synthetic question', assistant: last.result, status: 'complete',
    supplements: [{ id: ids.input, text: 'Additional synthetic question', status: 'queued', ts: '2026-09-14T05:25:41Z' }], output: savedOutput };
  const conversation = { id: ids.conv, updatedAt: '2026-09-14T05:26:25Z', pinned: true, turns: [turn] };
  const run = { runId: ids.run, state: 'succeeded', source: { conversationId: ids.conv }, execution: { appInstanceId: 'synthetic-epoch' } };
  let events = [first, last, { type: 'job-done', jobId: ids.run, exitCode: 0, finalResult: last }];
  const config = { conversation, turn, run, events, first, last }; configure(config); events = config.events;
  const runFile = path.join(rootDir, 'runs', `${ids.run}.json`), journalFile = path.join(rootDir, 'stream-events', 'epochs', 'synthetic-epoch.jsonl');
  fs.mkdirSync(path.dirname(runFile), { recursive: true }); fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.writeFileSync(runFile, JSON.stringify(run));
  fs.writeFileSync(journalFile, events.map((event, index) => JSON.stringify({ epoch: 'synthetic-epoch', seq: index + 1,
    type: 'claude.event', runId: ids.run, payload: { event } })).join('\n') + '\n');
  let reads = 0;
  const fileSystem = { statSync: fs.statSync, readFileSync(file, encoding) { reads++; return fs.readFileSync(file, encoding); } };
  const recover = createLegacyOutputRecovery({ fileSystem });
  return { ...config, rootDir, runFile, journalFile, recover: value => recover(value || conversation, { rootDir }), reads: () => reads };
}

test('completed v4 output recovers independent answers and consumed status without changing source bytes or ordering', t => {
  const h = fixture(t), original = copy(h.conversation), runBytes = fs.readFileSync(h.runFile), journalBytes = fs.readFileSync(h.journalFile);
  const recovered = h.recover();
  assert.equal(recovered.turns[0].output.version, 5);
  assert.equal(recovered.turns[0].assistant, h.first.result + '\n\n' + h.last.result);
  assert.equal(recovered.turns[0].supplements[0].status, 'applied');
  assert.equal(recovered.updatedAt, original.updatedAt); assert.equal(recovered.pinned, true);
  assert.deepEqual(h.conversation, original); assert.deepEqual(fs.readFileSync(h.runFile), runBytes);
  assert.deepEqual(fs.readFileSync(h.journalFile), journalBytes);
  assert.deepEqual(recovered.turns[0].output.messages, original.turns[0].output.messages);
});

test('normal v5 records make zero filesystem reads and cached old runs ignore newer activity timestamps', t => {
  const h = fixture(t);
  const upgraded = h.recover(), reads = h.reads(); assert.equal(reads, 2);
  assert.equal(h.recover(upgraded), upgraded); assert.equal(h.reads(), reads);
  const next = copy(h.conversation); next.updatedAt = '2099-01-01T00:00:00Z';
  next.turns.push({ runId: ids.other, status: 'running', assistant: '' });
  assert.equal(h.recover(next).turns[0].assistant, upgraded.turns[0].assistant);
  assert.equal(h.reads(), reads);
});

test('same consumed input stages cannot evict an earlier independent answer from a long goal', t => {
  const h = fixture(t, f => { f.events.splice(1, 0, ...Array.from({ length: 250 }, (_, index) => result(ids.input, `stage-${index}`))); });
  assert.equal(h.recover().turns[0].assistant, h.first.result + '\n\n' + h.last.result);
});

test('legacy identical replies with missing ownership are not assigned to a guessed earlier message', t => {
  const h = fixture(t, f => {
    f.first.result = f.last.result;
    f.turn.output.messages[0].blocks[0].text = f.last.result;
  });
  const recovered = h.recover();
  assert.equal(recovered.turns[0].assistant, h.last.result);
  assert.equal(recovered.turns[0].output.answers.length, 1);
});

test('legacy results cannot resurrect text removed by an explicit message retraction', t => {
  const h = fixture(t, f => {
    f.turn.output.messages.shift();
    f.turn.output.retractedMessageUuids = ['frame-0'];
  });
  assert.equal(h.recover().turns[0].assistant, h.last.result);
});

for (const scenario of ['missing', 'truncated', 'malformed', 'foreign-conversation', 'foreign-run', 'failed', 'wrong-final']) {
  test(`${scenario} journal leaves prior output intact`, t => {
    const h = fixture(t, f => {
      if (scenario === 'truncated') f.events.pop();
      if (scenario === 'foreign-conversation') f.run.source.conversationId = ids.other;
      if (scenario === 'foreign-run') f.run.runId = ids.other;
      if (scenario === 'failed') f.events.at(-1).exitCode = 1;
      if (scenario === 'wrong-final') f.events.at(-1).finalResult = { ...f.last, uuid: 'foreign-result' };
    });
    if (scenario === 'missing') fs.rmSync(h.journalFile);
    if (scenario === 'malformed') fs.writeFileSync(h.journalFile, `{"runId":"${ids.run}",\n` + fs.readFileSync(h.journalFile, 'utf8'));
    const recovered = h.recover();
    assert.deepEqual(recovered.turns[0].output, h.turn.output); assert.equal(recovered.turns[0].assistant, h.last.result);
    assert.equal(recovered.updatedAt, h.conversation.updatedAt);
    assert.equal(recovered.turns[0].supplements[0].status, 'applied', 'saved successful result remains independent receipt proof');
  });
}

test('child, zero-turn, foreign-input and stale reset-context results are never promoted', t => {
  const h = fixture(t, f => {
    f.events = [f.first, { type: 'conversation_reset', jobId: ids.run },
      result(ids.run, 'child answer', { parent_tool_use_id: 'child' }),
      result(ids.run, 'notification only', { num_turns: 0 }),
      result(ids.other, 'foreign input'),
      result(ids.run, 'old context answer', { session_id: 'old-native' }), f.last, f.events.at(-1)];
  });
  assert.equal(h.recover().turns[0].assistant, h.last.result);
});

test('receipt restoration respects exact root run and explicit consumed input evidence', () => {
  const make = (status = 'queued') => ({ runId: ids.run, supplements: [{ id: ids.input, status }], output: { lastResult: result(ids.input, 'fixture') } });
  for (const extra of [{ jobId: ids.other }, { parent_tool_use_id: 'child' }, { agent_id: 'child' }, { user_message_uuid: ids.other, user_message_uuids: [ids.other] },
    { is_error: true, user_message_uuids: undefined }, { num_turns: 0 }]) {
    const turn = make(); Object.assign(turn.output.lastResult, extra);
    assert.equal(recoverSupplementReceipts(turn), false); assert.equal(turn.supplements[0].status, 'queued');
  }
  for (const status of ['canceled', 'rejected', 'applied']) {
    const turn = make(status); delete turn.output.lastResult.user_message_uuids;
    assert.equal(recoverSupplementReceipts(turn), false); assert.equal(turn.supplements[0].status, status);
  }
  const turn = make(); assert.equal(recoverSupplementReceipts(turn), true); assert.equal(turn.supplements[0].status, 'applied');
});

test('failed and stopped history restores consumed receipts without promoting answers or changing saved data', () => {
  for (const status of ['error', 'canceled', 'paused']) {
    for (const delivery of ['queued', 'canceled', 'rejected']) {
      const lastResult = result(ids.run, '', { subtype: 'error_during_execution', is_error: true,
        terminal_reason: status === 'error' ? 'api_error' : 'aborted_streaming', user_message_uuids: [ids.run, ids.input] });
      const conversation = { id: ids.conv, updatedAt: 'unchanged', turns: [{ runId: ids.run, status, assistant: '', error: 'Original termination',
        outputNotice: '有补充要求尚未处理，请查看补充消息的状态。\n保留的其他提示',
        supplements: [{ id: ids.input, status: delivery, text: 'Original supplement' }], output: { version: 5, status: 'error', lastResult } }] };
      const original = copy(conversation), recover = withoutJournalReads(), recovered = recover(conversation);
      assert.equal(recovered.turns[0].supplements[0].status, 'applied');
      assert.equal(recovered.turns[0].outputNotice, '保留的其他提示');
      assert.equal(recovered.turns[0].status, status); assert.equal(recovered.turns[0].error, 'Original termination');
      assert.equal(recovered.turns[0].assistant, ''); assert.deepEqual(recovered.turns[0].output, original.turns[0].output);
      assert.equal(recovered.updatedAt, 'unchanged'); assert.deepEqual(conversation, original);
      assert.equal(recover(recovered), recovered);
    }
  }
});

test('partial receipt recovery preserves the undelivered notice and unconsumed inputs', () => {
  const conversation = { turns: [{ runId: ids.run, status: 'canceled',
    supplements: [{ id: ids.input, status: 'canceled' }, { id: ids.other, status: 'canceled' }],
    output: { version: 5, lastResult: result(ids.run, '', { is_error: true, user_message_uuids: [ids.run, ids.input] }) },
    outputNotice: '有补充要求尚未处理，请查看补充消息的状态。' }] };
  const recovered = withoutJournalReads()(conversation);
  assert.deepEqual(recovered.turns[0].supplements.map(input => input.status), ['applied', 'canceled']);
  assert.equal(recovered.turns[0].outputNotice, conversation.turns[0].outputNotice);
});

test('receipt-only recovery preserves missing-final notice and partial prose in a stopped task', () => {
  const conversation = { turns: [{ runId: ids.run, status: 'canceled', assistant: 'Partial legacy prose',
    supplements: [{ id: ids.input, status: 'canceled' }],
    output: { version: 5, status: 'error', lastResult: result(ids.run, '', {
      is_error: true, terminal_reason: 'aborted_streaming', user_message_uuids: [ids.run, ids.input] }) },
    outputNotice: '任务已结束，但未取得最终回复。已保留可恢复的执行过程。\n有补充要求尚未处理，请查看补充消息的状态。' }] };
  const recovered = withoutJournalReads()(conversation);
  assert.equal(recovered.turns[0].supplements[0].status, 'applied');
  assert.equal(recovered.turns[0].status, 'canceled');
  assert.equal(recovered.turns[0].assistant, conversation.turns[0].assistant);
  assert.equal(recovered.turns[0].outputNotice, '任务已结束，但未取得最终回复。已保留可恢复的执行过程。');
});

test('running or unsupplemented records never read a recovery journal', t => {
  const h = fixture(t), running = copy(h.conversation); running.turns[0].status = 'running';
  assert.equal(h.recover(running), running);
  const ordinary = copy(h.conversation); ordinary.turns[0].supplements = [];
  assert.equal(h.recover(ordinary), ordinary); assert.equal(h.reads(), 0);
});

test('main load falls back to the parsed record if optional projection fails and ships the helper', () => {
  const record = { id: ids.conv, turns: [], updatedAt: 'unchanged' };
  const { createHistoryStore } = require('./helpers/load-commonjs.cjs')('src/main/app/history-store.js', {
    modules: { fs: { existsSync: () => true, readFileSync: () => JSON.stringify(record) } },
  });
  const history = createHistoryStore({ getUserDataDir: () => '/synthetic',
    recoverLegacyOutput() { throw Error('synthetic optional recovery failure'); } });
  assert.deepEqual(copy(history.loadConversation(ids.conv)), record);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('src/main/**/*.js') && fs.existsSync(path.join(__dirname, '../src/main/projects/legacy-output-recovery.js')));
});

const missingFinalNotice = '任务已结束，但未取得最终回复。已保留可恢复的执行过程。';
function emptyFinalFixture() {
  const state = Output.createState();
  Output.ingest(state, { type: 'assistant', uuid: 'final-frame', message: { id: 'final-message',
    content: [{ type: 'thinking', thinking: 'Private reasoning' }, { type: 'text', text: 'Goal not met. Here is the final summary.' }], stop_reason: 'end_turn' } });
  Output.ingest(state, result(ids.run, '', { origin: { kind: 'task-notification' } }));
  const output = Output.serialize(state);
  // Reproduce the pre-fix saved state, not a new run already using the repair.
  Object.assign(output, { status: 'complete', final: '', finalMessageId: null, answers: [], notice: missingFinalNotice });
  return { id: ids.conv, updatedAt: '2026-09-18T09:31:47Z', turns: [{ runId: ids.run, status: 'complete',
    assistant: '', output, outputNotice: missingFinalNotice }, { runId: ids.other, status: 'running', assistant: '' }] };
}
function withoutJournalReads() {
  return createLegacyOutputRecovery({ fileSystem: { readFileSync() { assert.fail('snapshot recovery must not read a journal'); },
    statSync() { assert.fail('snapshot recovery must not stat a journal'); } } });
}

test('empty successful history restores only its terminal root answer without changing the source or later turns', () => {
  const conversation = emptyFinalFixture(), original = copy(conversation), recover = withoutJournalReads();
  const recovered = recover(conversation, { rootDir: '/unused' });
  assert.notEqual(recovered, conversation);
  assert.equal(recovered.turns[0].assistant, 'Goal not met. Here is the final summary.');
  assert.equal(recovered.turns[0].output.final, recovered.turns[0].assistant);
  assert.equal(recovered.turns[0].output.finalMessageId, 'final-message');
  assert.equal(recovered.turns[0].outputNotice, '');
  assert.equal(recovered.turns[0].output.notice, '');
  assert.equal(recovered.updatedAt, original.updatedAt);
  assert.equal(recovered.turns[1], conversation.turns[1]);
  assert.deepEqual(conversation, original);
  assert.equal(recover(recovered), recovered, 'repeated loads are stable');
  assert.equal(Output.processItems(Output.createState(recovered.turns[0].output)).some(item => item.result === recovered.turns[0].assistant), false);
});

test('history recovery accepts empty variants and retains independent notices', () => {
  for (const value of ['', ' \n ', undefined]) {
    const conversation = emptyFinalFixture();
    conversation.turns[0].output.lastResult.result = value;
    conversation.turns[0].outputNotice = missingFinalNotice + '\n有补充要求未处理。\n部分较早事件已截断。';
    const recovered = withoutJournalReads()(conversation);
    assert.ok(recovered.turns[0].assistant);
    assert.equal(recovered.turns[0].outputNotice, '有补充要求未处理。\n部分较早事件已截断。');
  }
});

test('v4 journal recovery of an empty terminal result also removes only the obsolete missing-answer notice', t => {
  const h = fixture(t, f => {
    f.last.result = '';
    f.turn.assistant = '';
    Object.assign(f.turn.output, { final: '', finalMessageId: null, answers: [], notice: missingFinalNotice });
    f.turn.output.lastResult.result = '';
    f.turn.outputNotice = missingFinalNotice + '\n部分较早事件已截断。';
  });
  const recovered = h.recover();
  assert.equal(recovered.turns[0].assistant, h.first.result + '\n\nSupplemental weather answer');
  assert.equal(recovered.turns[0].output.notice, '');
  assert.equal(recovered.turns[0].outputNotice, '部分较早事件已截断。');
  assert.equal(h.turn.assistant, '');
  assert.ok(h.turn.outputNotice.startsWith(missingFinalNotice));
});

test('v4 journals cannot bypass the partial-retraction guard for old empty-result snapshots', t => {
  const h = fixture(t, f => {
    f.last.result = '';
    f.turn.assistant = '';
    Object.assign(f.turn.output, { final: '', finalMessageId: null, answers: [], notice: missingFinalNotice,
      retractedMessageUuids: ['withdrawn-terminal-frame'] });
    f.turn.output.lastResult.result = '';
    f.turn.output.messages.at(-1).blocks = [{ type: 'text', text: 'Only a retained fragment.' }];
    delete f.turn.output.messages.at(-1).hasRetractedFrames;
    f.turn.outputNotice = missingFinalNotice;
  });
  const recovered = h.recover();
  assert.equal(recovered.turns[0].assistant, '');
  assert.equal(recovered.turns[0].output.final, '');
  assert.equal(recovered.turns[0].outputNotice, missingFinalNotice);
  assert.equal(recovered.turns[0].supplements[0].status, 'applied', 'valid input receipts still recover separately');
});

test('history recovery requires successful exact-run current-context evidence', () => {
  const mutations = [
    turn => { turn.status = 'running'; }, turn => { turn.status = 'canceled'; },
    turn => { turn.error = 'Execution failed'; }, turn => { turn.output.status = 'error'; },
    turn => { turn.assistant = 'Already saved'; }, turn => { turn.output.final = 'Already saved'; },
    turn => { turn.output.lastResult.jobId = ids.other; }, turn => { delete turn.output.lastResult.jobId; },
    turn => { turn.output.lastResult.subtype = 'error_max_turns'; }, turn => { turn.output.lastResult.is_error = true; },
    turn => { turn.output.lastResult.num_turns = 0; }, turn => { turn.output.lastResult.queued_turn_count = 1; },
    turn => { turn.output.lastResult.permission_denials = [{}]; }, turn => { turn.output.lastResult.terminal_reason = 'aborted_tools'; },
    turn => { turn.output.lastResult.parent_tool_use_id = 'child'; }, turn => { turn.output.lastResult.result = 'Different result'; },
    turn => { turn.output.revision++; }, turn => { turn.output.contextEpoch++; },
    turn => { turn.output.messages[0].parent = 'child'; }, turn => { turn.output.messages[0].aborted = true; },
    turn => { turn.output.messages[0].hasRetractedFrames = true; }, turn => { turn.output.messages[0].stopReason = 'tool_use'; },
    turn => { turn.output.retractedMessageUuids = ['removed-frame']; delete turn.output.messages[0].hasRetractedFrames; },
    turn => { turn.output.messages[0].blocks.push({ type: 'tool_use', name: 'fixture' }); },
    turn => { turn.output.messages = []; }, turn => { turn.output.current = {}; },
    turn => { turn.output.current[''] = 'later-retracted-message'; },
  ];
  for (const mutate of mutations) {
    const conversation = emptyFinalFixture(); mutate(conversation.turns[0]);
    const original = copy(conversation);
    assert.equal(withoutJournalReads()(conversation), conversation, mutate.toString());
    assert.deepEqual(conversation, original);
  }
});
