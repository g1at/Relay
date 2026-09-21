'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveTurnRouter } = require('../live-turn-router');
const { dispatchLiveInput } = require('../live-mcp-dispatch');
const { normalizeSupplement, supplementPrompt, sameSupplement, submitLiveSupplement,
  observeSupplement, flushSupplementUpdates, mergeSupplementHistory } = require('../live-supplement-input');

// All files, messages and APIs are synthetic. No Query, model, disk history or
// external service is started by these tests.
const JOB = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const copy = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const input = (overrides = {}) => normalizeSupplement({ messageId: A, prompt: '增加离线验收说明', ...overrides });
function harness() {
  const router = new LiveTurnRouter(); router.begin(JOB);
  const pushes = [], saved = [], events = [];
  const session = { jobId: JOB, convId: 'fixture-conversation', busy: true, dead: false, turnRouter: router,
    child: { push: (prompt, metadata) => { pushes.push({ prompt, metadata }); return true; },
      interrupt() { throw Error('supplement must not interrupt'); }, kill() { throw Error('supplement must not restart'); } },
  };
  const options = { session, jobId: JOB, persist: value => saved.push(copy(value)), emit: value => events.push(copy(value)) };
  return { router, session, pushes, saved, events, options,
    submit: (value = input(), overrides = {}) => submitLiveSupplement({ ...options, input: value, ...overrides }) };
}

test('normalize trims text and snapshots bounded file/skill metadata with a stable input id', () => {
  const file = { path: 'C:\\fixture\\notes.md', name: 'notes.md', ext: '.md', size: 12, untrustedExtra: true };
  const value = input({ prompt: '  增加说明 \n', files: [file, null, { path: 'bad\npath' }],
    skill: { name: 'fixture-skill', callName: 'fixture:skill', displayName: '示例技能' } });
  assert.equal(value.id, A); assert.equal(value.text, '增加说明'); assert.equal(value.status, 'queued');
  assert.ok(Number.isFinite(Date.parse(value.ts)));
  assert.deepEqual(value.files, [{ path: file.path, name: 'notes.md', ext: '.md', size: 12 }]);
  assert.deepEqual(value.skill, { name: 'fixture-skill', callName: 'fixture:skill', displayName: '示例技能' });
  file.path = 'changed'; assert.equal(value.files[0].path, 'C:\\fixture\\notes.md');
  assert.equal(input({ files: Array.from({ length: 40 }, (_, i) => ({ path: `/fixture/${i}` })) }).files.length, 32);
});

test('normalize rejects missing identity, empty input and oversized content but accepts attachments alone', () => {
  assert.throws(() => normalizeSupplement({ prompt: 'fixture' }), /标识/);
  assert.throws(() => input({ messageId: 'invalid-id' }), /标识/);
  assert.throws(() => input({ prompt: ' \n ', files: [{ path: '\0bad' }] }), /请输入/);
  assert.throws(() => input({ prompt: 'x'.repeat(200001) }), /过长/);
  assert.equal(input({ prompt: '', files: [{ path: '/fixture/report.md' }] }).text, '');
});

test('protected prompt keeps slash-like text as a user requirement and includes skill/attachments', () => {
  const value = input({ prompt: '/clear 然后增加测试', files: [{ path: '/fixture/report.md' }],
    skill: { name: 'fixture' } });
  const prompt = supplementPrompt(value);
  assert.ok(prompt.startsWith('用户补充要求'));
  assert.ok(!prompt.trimStart().startsWith('/'));
  assert.match(prompt, /\/clear 然后增加测试/);
  assert.match(prompt, /Skill 工具加载「fixture」/);
  assert.match(prompt, /\/fixture\/report\.md/);
  assert.match(supplementPrompt(input({ prompt: '', files: [{ path: '/fixture/a' }] })), /请查看补充附件/);
});

test('a live supplement remains on the same run/query and uses next without interrupting the current reply', () => {
  const h = harness();
  h.router.accept({ type: 'stream_event', user_message_uuid: JOB, event: { type: 'message_start' } });
  const result = h.submit();
  assert.equal(result.ok, true); assert.equal(h.session.jobId, JOB);
  assert.equal(h.router.replyOwner, JOB);
  assert.equal(h.router.pendingSupplementCount, 1);
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(h.pushes[0].metadata, { uuid: A, priority: 'next' });
  assert.equal(h.saved.length, 1); assert.equal(h.events.length, 1);
  assert.equal(h.events[0].status, 'queued');
});

test('queued follow-up waits for the current turn with later priority and never interrupts', () => {
  const h = harness();
  const value = input({ followUpMode: 'queue' });
  assert.equal(h.submit(value).ok, true);
  assert.deepEqual(h.pushes[0].metadata, { uuid: A, priority: 'later' });
  assert.equal(h.saved[0].followUpMode, 'queue');
  assert.match(h.pushes[0].prompt, /^用户后续要求/);
  assert.equal(h.router.pendingSupplementCount, 1);
  assert.equal(h.submit(input()).code, 'INPUT_CONFLICT');
});

test('follow-up mode validation and legacy receipt comparison retain steer as the default', () => {
  assert.equal(input().followUpMode, 'steer');
  assert.throws(() => input({ followUpMode: 'now' }), /处理方式/);
  const current = input(), legacy = { ...current }; delete legacy.followUpMode;
  assert.equal(sameSupplement(current, legacy), true);
  assert.equal(sameSupplement(input({ followUpMode: 'queue' }), legacy), false);
});

test('steering a revised target explicitly replaces conflicting old requirements without scheduling another task', () => {
  const prompt = supplementPrompt(input({ prompt: '改成一天的日程吧' }));
  assert.match(prompt, /最新要求/);
  assert.match(prompt, /改成一天的日程吧/);
  assert.match(prompt, /覆盖之前冲突的用户要求/);
  assert.match(prompt, /保留其余仍适用的任务上下文/);
  assert.match(prompt, /后续计划、执行和最终回复/);
  assert.match(prompt, /结束前核对/);
  assert.doesNotMatch(prompt, /当前工作已完成后/);
  const queued = supplementPrompt(input({ prompt: '下一项工作', followUpMode: 'queue' }));
  assert.match(queued, /当前工作已完成后/);
  assert.doesNotMatch(queued, /覆盖之前冲突|立即纳入/);
});

test('an unrelated question is additive while conflicts alone replace earlier requirements', () => {
  const prompt = supplementPrompt(input({ prompt: '明天上海天气怎么样？' }));
  assert.match(prompt, /新增问题或要求是补充，不代表取消原任务/);
  assert.match(prompt, /原任务尚未完成的要求也需要继续完成/);
  assert.match(prompt, /只有用户明确替换原目标，或新旧要求确实冲突时/);
  assert.match(prompt, /原任务与全部补充要求是否都已完成/);
});

test('failed receipt writes retry at consumption boundaries, without redundant delta writes or false cancellation', () => {
  const h = harness(); h.submit(); let writes = 0;
  const publish = () => ++writes > 1;
  observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: A, state: 'started' }, publish);
  assert.equal(h.session.supplementInputs.get(A).status, 'applied');
  observeSupplement(h.session, { type: 'stream_event', user_message_uuid: A, event: { type: 'content_block_delta' } }, publish);
  assert.equal(writes, 1);
  observeSupplement(h.session, { type: 'result', subtype: 'success', user_message_uuids: [A] }, publish);
  assert.equal(writes, 2);
  flushSupplementUpdates(h.session, publish); assert.equal(writes, 2);
});

test('final receipt flushing retries failures and cannot write a superseded run input map', () => {
  const h = harness(); h.submit();
  observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: A, state: 'started' }, () => false);
  const persisted = [];
  flushSupplementUpdates(h.session, input => { persisted.push(copy(input)); return true; });
  assert.equal(persisted[0].status, 'applied');
  h.submit(input({ messageId: B }));
  observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: B, state: 'started' }, () => false);
  h.session.supplementInputs = new Map();
  flushSupplementUpdates(h.session, input => persisted.push(copy(input)));
  assert.equal(persisted.length, 1);
});

test('only an exact owning live run can reconcile failed receipt persistence during a renderer save', () => {
  const h = harness(); h.submit();
  const queued = copy(h.saved[0]);
  observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: A, state: 'started' }, () => false);
  const saved = { id: h.session.convId, turns: [{ runId: JOB, supplements: [queued] }] };
  for (const session of [undefined, { ...h.session, convId: 'other' }, { ...h.session, supplementJobId: B }]) {
    const incoming = copy(saved); mergeSupplementHistory(incoming, saved, session);
    assert.equal(incoming.turns[0].supplements[0].status, 'queued');
  }
  const incoming = copy(saved); mergeSupplementHistory(incoming, saved, h.session);
  assert.equal(incoming.turns[0].supplements[0].status, 'applied');
  const canceled = copy(saved); canceled.turns[0].supplements[0].status = 'canceled';
  const stale = copy(saved); mergeSupplementHistory(stale, canceled, h.session);
  assert.equal(stale.turns[0].supplements[0].status, 'applied', 'the exact live record has native consumption proof');
  const unproven = { ...h.session, supplementInputs: new Map([[A, copy(h.session.supplementInputs.get(A))]]) };
  const fabricated = copy(saved); mergeSupplementHistory(fabricated, canceled, unproven);
  assert.equal(fabricated.turns[0].supplements[0].status, 'canceled', 'copied status alone cannot mint native proof');
  const conflict = copy(saved); conflict.turns[0].supplements[0].text = 'different accepted content';
  mergeSupplementHistory(copy(saved), conflict, h.session);
  assert.equal(conflict.turns[0].supplements[0].status, 'queued');
});

test('presentation anchors retain safe ordering metadata without trusting additional renderer fields', () => {
  const presentation = { version: 1, order: 17, messageId: 'msg-streaming', textLength: 231, text: 'not accepted' };
  const value = input({ presentation });
  assert.deepEqual(value.presentation, { version: 1, order: 17, messageId: 'msg-streaming', textLength: 231 });
  presentation.order = 99;
  assert.equal(value.presentation.order, 17);
  assert.deepEqual(input({ presentation: { version: 1, order: 0, messageId: null, textLength: 0 } }).presentation,
    { version: 1, order: 0, messageId: null, textLength: 0 });
  for (const invalid of [null, {}, { ...presentation, version: 2 }, { ...presentation, order: -1 },
    { ...presentation, order: 1.5 }, { ...presentation, textLength: Number.MAX_SAFE_INTEGER + 1 },
    { ...presentation, textLength: -1 }, { ...presentation, messageId: {} },
    { ...presentation, messageId: '' }, { ...presentation, messageId: 'x'.repeat(201) }]) {
    assert.equal(input({ presentation: invalid }).presentation, undefined);
  }
});

test('persisted delivery updates and stale snapshots preserve the first accepted presentation anchor', () => {
  const h = harness(), presentation = { version: 1, order: 7, messageId: 'streaming-answer', textLength: 42 };
  const value = input({ presentation });
  h.submit(value);
  observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: A, state: 'started' }, h.options.persist);
  assert.deepEqual(h.saved.map(record => record.presentation), [presentation, presentation]);
  const changed = input({ presentation: { ...presentation, order: 99 } });
  assert.equal(h.submit(changed).duplicate, true, 'a transport retry must not move an already accepted message');
  const saved = { turns: [{ runId: JOB, supplements: [copy(value)] }] };
  const incoming = { turns: [{ runId: JOB, supplements: [changed] }] };
  mergeSupplementHistory(incoming, saved);
  assert.deepEqual(incoming.turns[0].supplements[0].presentation, presentation);
  assert.equal(incoming.turns[0].supplements[0].status, 'applied');
});

test('SDK batched user UUIDs mark only the consumed supplements, once, across both delivery modes', () => {
  const h = harness(), observed = [];
  h.submit(); h.submit(input({ messageId: B, followUpMode: 'queue' }));
  const event = { type: 'assistant', user_message_uuid: A, user_message_uuids: [A, B, A, 'foreign'] };
  observeSupplement(h.session, { ...event, parent_tool_use_id: 'child' }, value => observed.push(value.id));
  assert.deepEqual(observed, []);
  observeSupplement(h.session, event, value => observed.push(value.id));
  assert.deepEqual(observed, [A, B]);
  observeSupplement(h.session, event, value => observed.push(value.id));
  assert.deepEqual(observed, [A, B]);
  assert.equal(h.session.supplementInputs.get(B).status, 'applied');
});

test('real MCP dispatch preserves original-input-first order followed by supplements in submission order', async () => {
  const h = harness(), ready = deferred();
  h.session.child.prepareMcp = () => ready.promise;
  const pending = dispatchLiveInput({ session: h.session, jobId: JOB, prompt: 'original fixture',
    loadServers: () => ({}), isSessionCurrent: () => true, onStatus() {},
    onFailure: message => { throw Error(message); } });
  h.submit(); h.submit(input({ messageId: B, prompt: '第二条补充' }));
  assert.deepEqual(h.pushes, []);
  ready.resolve({ ok: true, items: [] });
  await pending.done; await tick();
  assert.deepEqual(h.pushes.map(item => item.metadata.uuid), [JOB, A, B]);
  assert.deepEqual(h.pushes.map(item => item.metadata.priority), [undefined, 'next', 'next']);
});

test('same id/content is idempotent while conflicting content or an original-turn UUID is rejected', () => {
  const h = harness(), first = input();
  const result = h.submit(first);
  assert.equal(sameSupplement(first, { ...first, ts: 'changed', status: 'applied' }), true);
  assert.equal(h.submit({ ...first, ts: 'later' }).duplicate, true);
  assert.equal(h.submit(input({ prompt: 'changed requirement' })).code, 'INPUT_CONFLICT');
  assert.equal(h.submit(input({ messageId: JOB })).code, 'INPUT_CONFLICT');
  assert.equal(h.pushes.length, 1); assert.equal(h.saved.length, 1); assert.equal(h.events.length, 1);
  assert.equal(result.input, first);
});

for (const state of ['missing', 'dead', 'idle', 'changed-job', 'interrupting']) {
  test(`${state} run cannot receive a supplement`, () => {
    const h = harness();
    if (state === 'dead') h.session.dead = true;
    if (state === 'idle') h.session.busy = false;
    if (state === 'changed-job') h.session.jobId = B;
    if (state === 'interrupting') h.router.interrupt();
    assert.equal(h.submit(input(), state === 'missing' ? { session: null } : {}).code, 'NOT_RUNNING');
    assert.deepEqual(h.pushes, []); assert.deepEqual(h.saved, []);
  });
}

test('failed initial persistence retracts the pending registration and can be retried without duplication', () => {
  const h = harness();
  const failed = h.submit(input(), { persist() { throw Error('synthetic disk failure'); } });
  assert.equal(failed.ok, false); assert.equal(h.router.pendingSupplementCount, 0);
  assert.equal(h.router.sentIds.has(A), false); assert.equal(h.session.supplementInputs.has(A), false);
  assert.deepEqual(h.pushes, []);
  assert.equal(h.submit().ok, true); assert.equal(h.pushes.length, 1);
});

for (const failure of ['false', 'throw']) {
  test(`push ${failure} persists a rejected state and retracts only unconsumed input`, () => {
    const h = harness();
    h.session.child.push = () => { if (failure === 'throw') throw Error('synthetic push failure'); return false; };
    const result = h.submit();
    assert.equal(result.input.status, 'rejected'); assert.equal(h.router.pendingSupplementCount, 0);
    assert.equal(h.router.sentIds.has(A), false);
    assert.deepEqual(h.events.map(event => event.status), ['queued', 'rejected']);
    assert.deepEqual(h.saved.map(event => event.status), ['queued', 'rejected']);
    assert.equal(h.submit().duplicate, true, 'retrying the accepted id never replays a failed input invisibly');
  });
}

test('paused preparation cancels delayed supplements instead of delivering them after the old turn', async () => {
  const h = harness(), prepared = deferred();
  h.session.pendingInput = { done: prepared.promise };
  h.submit(); h.router.interrupt();
  prepared.resolve(); await tick();
  assert.deepEqual(h.pushes, []);
  assert.equal(h.events.at(-1).status, 'canceled');
  assert.equal(h.router.pendingSupplementCount, 0);
});

test('main terminal settlement cannot be overwritten or emitted twice by a delayed preparation callback', async () => {
  for (const status of ['canceled', 'rejected']) {
    const h = harness(), prepared = deferred(), value = input();
    h.session.pendingInput = { done: prepared.promise };
    h.submit(value);
    value.status = status; h.options.persist(value); h.options.emit(value);
    h.session.busy = false; h.router.end();
    prepared.resolve(); await tick();
    assert.deepEqual(h.pushes, []);
    assert.equal(value.status, status);
    assert.deepEqual(h.events.map(event => event.status), ['queued', status]);
    assert.equal(h.saved.length, 2);
  }
});

test('an old delayed dispatch cannot unregister an input in a later run even if its UUID is reused', async () => {
  const h = harness(), prepared = deferred();
  h.session.pendingInput = { done: prepared.promise };
  h.submit();
  h.session.jobId = B; h.router.begin(B); h.router.registerSupplement(A);
  prepared.resolve(); await tick();
  assert.deepEqual(h.pushes, []);
  assert.equal(h.events.at(-1).status, 'canceled');
  assert.deepEqual(h.router.pendingSupplementIds(), [A]);
});

test('observer failures cannot prevent delivery bookkeeping or tear down the run', () => {
  const h = harness();
  const result = h.submit(input(), { emit() { throw Error('synthetic renderer failure'); } });
  assert.equal(result.ok, true); assert.equal(h.pushes.length, 1);
  assert.doesNotThrow(() => observeSupplement(h.session,
    { type: 'command_lifecycle', command_uuid: A, state: 'started' }, () => { throw Error('synthetic observer failure'); }));
  assert.equal(result.input.status, 'applied');
});

test('queued, replay echo, completed alone and child/foreign events never claim the requirement was applied', () => {
  const h = harness(), value = input(), updates = [];
  h.submit(value);
  for (const event of [
    { type: 'command_lifecycle', command_uuid: A, state: 'queued' },
    { type: 'command_lifecycle', command_uuid: A, state: 'completed' },
    { type: 'user', uuid: A, isReplay: true },
    { type: 'assistant', user_message_uuid: A, parent_tool_use_id: 'child-tool' },
    { type: 'assistant', user_message_uuid: A, parentToolUseId: 'child-tool' },
    { type: 'assistant', user_message_uuid: A, agent_id: 'child-agent' },
    { type: 'stream_event', user_message_uuid: A, subagent_type: 'fixture' },
    { type: 'command_lifecycle', command_uuid: B, state: 'started' },
  ]) observeSupplement(h.session, event, update => updates.push(copy(update)));
  assert.equal(value.status, 'queued'); assert.deepEqual(updates, []);
});

test('error, aborted and permission-denied results do not turn an unconsumed supplement into applied', () => {
  const h = harness(), value = input(), updates = [];
  h.submit(value);
  for (const extra of [
    { is_error: true }, { subtype: 'error_during_execution' },
    { terminal_reason: 'aborted_streaming' }, { terminal_reason: 'aborted_tools' },
    { permission_denials: [{ tool_name: 'fixture' }] },
  ]) observeSupplement(h.session, { type: 'result', subtype: 'success', user_message_uuid: A, ...extra }, value => updates.push(value));
  assert.equal(value.status, 'queued'); assert.deepEqual(updates, []);
});

test('explicit root consumed lists acknowledge folded input even when that turn later fails', () => {
  for (const extra of [{ is_error: true }, { subtype: 'error_during_execution', is_error: true },
    { terminal_reason: 'aborted_streaming', is_error: true }, { terminal_reason: 'aborted_tools' },
    { permission_denials: [{ tool_name: 'fixture' }] }]) {
    const h = harness(), value = input(), updates = [];
    h.submit(value); h.submit(input({ messageId: B, followUpMode: 'queue' }));
    // Missing started/first-reply receipts are normal when the SDK folds input
    // into an already-running reply whose singular stamp still names the original.
    const event = { type: 'result', subtype: 'success', user_message_uuid: B,
      user_message_uuids: [JOB, A, A, 'foreign'], num_turns: 3, ...extra };
    const before = copy(event);
    observeSupplement(h.session, event, update => updates.push(copy(update)));
    observeSupplement(h.session, event, update => updates.push(copy(update)));
    assert.equal(value.status, 'applied');
    assert.equal(h.session.supplementInputs.get(B).status, 'queued', 'only explicitly listed prompts were consumed');
    assert.deepEqual(updates.map(update => update.id), [A]);
    assert.deepEqual(event, before, 'the overall failed turn stays failed');
  }
});

test('foreign, child, empty and zero-turn consumed lists cannot promote queued input', () => {
  const h = harness(), value = input(), updates = [];
  h.submit(value);
  for (const extra of [{ user_message_uuids: [] }, { user_message_uuids: ['foreign'] },
    { parent_tool_use_id: 'child' }, { parentToolUseId: 'child' }, { agent_id: 'child' },
    { subagent_type: 'fixture' }, { num_turns: 0 }]) {
    observeSupplement(h.session, { type: 'result', subtype: 'error_during_execution', is_error: true,
      user_message_uuid: A, user_message_uuids: [A], ...extra }, update => updates.push(copy(update)));
  }
  assert.equal(value.status, 'queued'); assert.deepEqual(updates, []);
});

for (const event of [
  { type: 'command_lifecycle', command_uuid: A, state: 'started' },
  { type: 'assistant', user_message_uuid: A },
  { type: 'stream_event', user_message_uuid: A },
  { type: 'result', user_message_uuid: A, subtype: 'success' },
]) {
  test(`${event.type} actual-consumption evidence updates the input exactly once`, () => {
    const h = harness(), value = input(), updates = [];
    h.submit(value);
    observeSupplement(h.session, event, update => updates.push(copy(update)));
    observeSupplement(h.session, event, update => updates.push(copy(update)));
    assert.equal(value.status, 'applied'); assert.equal(updates.length, 1);
  });
}

test('authoritative consumption corrects a canceled/refused receipt without resending', () => {
  for (const [state, status] of [['cancelled', 'canceled'], ['discarded', 'canceled'], ['refused', 'rejected']]) {
    for (const receipt of [
      { type: 'command_lifecycle', command_uuid: A, state: 'started' },
      { type: 'assistant', user_message_uuid: A },
      { type: 'result', subtype: 'error_during_execution', is_error: true,
        terminal_reason: 'aborted_streaming', user_message_uuid: JOB, user_message_uuids: [JOB, A] },
    ]) {
      const h = harness(), value = input(), updates = [];
      h.submit(value);
      observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: A, state }, update => updates.push(copy(update)));
      assert.equal(value.status, status);
      observeSupplement(h.session, receipt, update => updates.push(copy(update)));
      assert.equal(value.status, 'applied'); assert.equal(updates.length, 2);
      assert.equal(h.pushes.length, 1, 'correcting bookkeeping must not replay the input');
    }
  }
});

test('late cancellation and rejection cannot downgrade an already consumed supplement', () => {
  const h = harness(), value = input(), updates = [];
  h.submit(value);
  observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: A, state: 'started' }, update => updates.push(copy(update)));
  for (const state of ['cancelled', 'discarded', 'refused', 'completed', 'queued']) {
    observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: A, state }, update => updates.push(copy(update)));
  }
  assert.equal(value.status, 'applied'); assert.equal(updates.length, 1);
});

test('an unconsumed cancellation stays terminal without authoritative consumption evidence', () => {
  const h = harness(), value = input(), updates = [];
  h.submit(value);
  observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: A, state: 'cancelled' }, update => updates.push(copy(update)));
  for (const event of [
    { type: 'command_lifecycle', command_uuid: A, state: 'queued' },
    { type: 'user', uuid: A, isReplay: true },
    { type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuid: A },
    { type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuids: [B] },
    { type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuids: [A], num_turns: 0 },
    { type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuids: [A], parent_tool_use_id: 'child' },
  ]) observeSupplement(h.session, event, update => updates.push(copy(update)));
  assert.equal(value.status, 'canceled'); assert.equal(updates.length, 1);
});

test('failed persistence of a corrected receipt is recoverable only by the same owning live record', () => {
  const h = harness(); h.submit();
  observeSupplement(h.session, { type: 'command_lifecycle', command_uuid: A, state: 'cancelled' }, h.options.persist);
  const saved = { id: h.session.convId, turns: [{ runId: JOB, supplements: [copy(h.saved.at(-1))] }] };
  observeSupplement(h.session, { type: 'result', subtype: 'error_during_execution', is_error: true,
    terminal_reason: 'aborted_streaming', user_message_uuids: [JOB, A] }, () => false);
  for (const session of [undefined, { ...h.session, convId: 'other' }, { ...h.session, supplementJobId: B }]) {
    const incoming = copy(saved); mergeSupplementHistory(incoming, saved, session);
    assert.equal(incoming.turns[0].supplements[0].status, 'canceled');
  }
  const incoming = copy(saved); mergeSupplementHistory(incoming, saved, h.session);
  assert.equal(incoming.turns[0].supplements[0].status, 'applied');
  assert.equal(saved.turns[0].supplements[0].status, 'canceled', 'merging does not mutate the saved snapshot');
  flushSupplementUpdates(h.session, h.options.persist);
  assert.equal(h.saved.at(-1).status, 'applied'); assert.equal(h.pushes.length, 1);
});

test('stale history saves preserve canonical supplemental text/status without changing activity timestamps', () => {
  const canonical = { ...input(), status: 'applied', ts: '2026-01-01T00:00:01Z' };
  const saved = { updatedAt: 'old-saved-order', turns: [{ runId: JOB, supplements: [canonical] }] };
  const incoming = { updatedAt: 'incoming-order', title: 'current title', turns: [{ runId: JOB, assistant: 'final',
    supplements: [{ ...canonical, status: 'queued', text: 'stale rewritten text', files: [] },
      { ...input({ messageId: B }), ts: '2026-01-01T00:00:02Z' }] }] };
  const before = copy(saved);
  assert.equal(mergeSupplementHistory(incoming, saved), incoming);
  assert.deepEqual(saved, before);
  assert.equal(incoming.updatedAt, 'incoming-order'); assert.equal(incoming.title, 'current title');
  assert.equal(incoming.turns[0].assistant, 'final');
  assert.deepEqual(incoming.turns[0].supplements.map(item => item.id), [A, B]);
  assert.equal(incoming.turns[0].supplements[0].text, canonical.text);
  assert.equal(incoming.turns[0].supplements[0].status, 'applied');
});

test('renderer cannot rewrite an accepted queued input by claiming it was applied', () => {
  const queued = input();
  const saved = { turns: [{ runId: JOB, supplements: [queued] }] };
  const incoming = { turns: [{ runId: JOB, supplements: [{ ...queued, text: 'replacement', status: 'applied' }] }] };
  mergeSupplementHistory(incoming, saved);
  assert.equal(incoming.turns[0].supplements[0].text, queued.text);
  assert.equal(incoming.turns[0].supplements[0].status, 'queued');
});

test('history merge restores omitted supplement arrays but never crosses run boundaries or crashes on damaged rows', () => {
  const saved = { turns: [{ runId: JOB, supplements: [null, input()] }] };
  const incoming = { turns: [null, { runId: JOB }, { runId: B, supplements: [] }] };
  mergeSupplementHistory(incoming, saved);
  assert.deepEqual(incoming.turns[1].supplements.map(item => item.id), [A]);
  assert.deepEqual(incoming.turns[2].supplements, []);
  assert.doesNotThrow(() => mergeSupplementHistory({ turns: [{ runId: JOB, supplements: [null] }] }, saved));
  assert.doesNotThrow(() => mergeSupplementHistory({ turns: [{ runId: JOB }] }, { turns: {} }));
  assert.equal(mergeSupplementHistory(null, saved), null);
});


test('folder supplements preserve their type and retry identity without changing the active run', async () => {
  const h = harness();
  const folder = { path: '/fixture/reference', name: 'reference', ext: 'folder', size: 0, isDirectory: true };
  const value = input({ prompt: '', files: [folder] });
  assert.equal(h.submit(value).ok, true);
  assert.deepEqual(h.saved[0].files, [folder]);
  assert.equal(h.submit(input({ prompt: '', files: [folder] })).duplicate, true);
  assert.equal(h.pushes.length, 1);
  assert.equal(h.session.jobId, JOB);
  assert.equal(h.pushes[0].metadata.priority, 'next');
  assert.deepEqual(h.pushes[0].metadata.files, [folder]);
  const { prepareAttachmentContent } = require('../attachment-input');
  const content = await prepareAttachmentContent(h.pushes[0].prompt, h.pushes[0].metadata.files);
  assert.match(content[0].text, /Glob\/Grep/);
  assert.match(content[0].text, /不改变当前工作目录/);
});
