'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { MemoryLearningService, redactMemoryText, visibleText, evidenceFor } = require('../src/main/memory/memory-learning');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const data = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
const turn = (user, id = 'turn-1') => ({ user, assistant: 'Understood; this preference is recorded in the current conversation.', runId: id, ts: '2026-10-20T10:00:00.000Z' });
const conversation = (id, user, projectId = null) => ({ id, title: `Chat ${id}`, projectId, updatedAt: '2026-10-20T11:00:00.000Z', turns: [turn(user)] });
const candidate = (evidence, body = 'Use concise summaries for this project.') => ({ name: 'Summary preference', description: 'Preferred response format', type: 'feedback', body,
  evidence: [{ id: evidence[0].id, quote: evidence[0].text.slice(0, 500) }] });

function setup(t, initial = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-learning-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const records = new Map(), writes = [], calls = [], conversations = initial.conversations || [conversation('c1', 'Please use concise summaries for this project.')];
  const active = new Set();
  const store = {
    list: () => [...records.values()].map(({ content, ...rest }) => rest),
    read: file => { if (!records.has(file)) throw Object.assign(new Error('missing'), { code: 'MEMORY_NOT_FOUND' }); return records.get(file); },
    proposeLearning: (proposal, options) => {
      assert.equal(records.has(proposal.file), false);
      const content = proposal.body, projectId = options.context.projectId || null;
      const entry = { file: proposal.file, content, revision: hash(content), meta: { ...proposal, scope: projectId ? 'project' : 'global', projectId,
        status: 'draft', confidence: 'inferred', core: false, schemaErrors: [] } };
      records.set(proposal.file, entry); writes.push(entry); return entry;
    },
  };
  const options = { store, stateDir, listConversations: () => conversations,
    loadConversation: id => conversations.find(item => item.id === id), isConversationActive: id => active.has(id),
    getProjects: () => [{ id: 'p1' }, { id: 'p2' }], now: () => NOW,
    generate: async input => { calls.push(input); return initial.generate ? initial.generate(input, { calls, records, writes })
      : { candidates: input.phase === 'extract' ? [candidate(data(input.prompt).evidence)] : [] }; },
    ...(initial.options || {}),
  };
  const service = new MemoryLearningService(options);
  return { service, store, stateDir, records, writes, calls, conversations, active, options };
}

test('history extraction persists explicit drafts with host evidence and hash-only resumable state', async t => {
  const { service, calls, writes, stateDir } = setup(t);
  const first = await service.run({ model: 'test-model' });
  assert.equal(first.ok, true); assert.equal(first.candidates, 1); assert.equal(first.processed, 1);
  assert.equal(writes[0].meta.type, 'feedback'); assert.equal(writes[0].meta.status, 'draft');
  assert.equal(writes[0].meta.sources[0].conversationId, 'c1'); assert.equal(writes[0].meta.sources[0].turnId, 'turn-1');
  assert.equal(writes[0].meta.sources[0].role, 'user'); assert.match(writes[0].meta.sources[0].revision, /^[a-f0-9]{64}$/);
  assert.equal(calls[0].model, 'test-model');
  const state = fs.readFileSync(path.join(stateDir, 'learning-state.json'), 'utf8');
  assert.ok(!state.includes('Please use concise')); assert.ok(!state.includes('Chat c1')); assert.ok(!state.includes('"c1"'));
  const second = await service.run(); assert.equal(second.processed, 0); assert.equal(calls.length, 1);
  assert.equal(service.status().lastRun.ok, true);
});

test('renaming or touching a chat does not re-extract old messages; appended turns are incremental', async t => {
  const { service, conversations, calls } = setup(t, { generate: () => ({ candidates: [] }) });
  await service.run();
  conversations[0].title = 'Renamed'; conversations[0].updatedAt = '2026-10-21T10:00:00.000Z';
  await service.run(); assert.equal(calls.length, 1);
  conversations[0].turns.push(turn('Also include a short verification result.', 'turn-2'));
  const next = await service.run(); assert.equal(next.processed, 1); assert.equal(calls.length, 2);
  const sent = data(calls[1].prompt).evidence.map(item => item.text).join('\n');
  assert.match(sent, /verification/); assert.ok(!sent.includes('Please use concise'));
});

test('long messages continue across bounded calls without losing their tail', async t => {
  const { service, calls } = setup(t, { conversations: [conversation('long', 'A'.repeat(100) + 'TAIL')],
    generate: () => ({ candidates: [] }), options: { limits: { historyCalls: 1, calls: 1, evidenceChars: 20, chunkChars: 20 } } });
  for (let n = 0; n < 12; n++) await service.run();
  const sent = calls.flatMap(call => data(call.prompt).evidence.map(item => item.text)).join('');
  assert.ok(sent.includes('TAIL')); assert.equal(sent.split('TAIL').length - 1, 1);
  assert.ok(calls.every(call => data(call.prompt).evidence.reduce((sum, item) => sum + item.text.length, 0) <= 20));
});

test('failed output evidence does not advance a chunk, and retry persists only once', async t => {
  let fail = true;
  const { service, writes } = setup(t, { generate: input => {
    const value = candidate(data(input.prompt).evidence); if (fail) value.evidence[0].quote = 'invented quote';
    return { candidates: [value] };
  } });
  const result = await service.run(); assert.equal(result.ok, false); assert.equal(result.code, 'MEMORY_LEARNING_EVIDENCE'); assert.equal(writes.length, 0);
  fail = false; assert.equal((await service.run()).candidates, 1);
  await service.run(); assert.equal(writes.length, 1);
});

test('partial writes retry idempotently even when a later candidate fails', async t => {
  let fail = true;
  const { service, writes } = setup(t, { generate: input => ({ candidates: input.phase === 'merge' ? [] : [candidate(data(input.prompt).evidence),
    candidate(data(input.prompt).evidence, fail ? 'password: newsecret' : 'Show test results alongside summaries.')] }) });
  assert.equal((await service.run()).ok, false); assert.equal(writes.length, 1);
  fail = false; assert.equal((await service.run()).ok, true); assert.equal(writes.length, 2);
});

test('retry may reorder candidates after a partial write without dropping or duplicating a fact', async t => {
  let retry = false;
  const { service, writes } = setup(t, { generate: input => {
    if (input.phase === 'merge') return { candidates: [] };
    const evidence = data(input.prompt).evidence;
    const first = candidate(evidence, 'Keep summaries short.');
    const second = candidate(evidence, retry ? 'Include validation results.' : 'password: rejected-secret');
    return { candidates: retry ? [second, first] : [first, second] };
  } });
  assert.equal((await service.run()).ok, false); assert.equal(writes.length, 1);
  retry = true; const result = await service.run();
  assert.equal(result.ok, true); assert.equal(result.candidates, 1); assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(item => item.content).sort(), ['Include validation results.', 'Keep summaries short.']);
});

test('redaction strips secrets and hidden/tool content before input, sources and persisted output', async t => {
  const text = 'Use concise summaries.\npassword: do-not-copy\nAuthorization: Bearer secrethere\n-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----';
  assert.ok(!redactMemoryText(text).includes('do-not-copy'));
  assert.ok(!redactMemoryText(text).includes('secret-key'));
  assert.equal(visibleText([{ type: 'tool_result', content: 'hidden' }, { type: 'thinking', text: 'hidden' }, { type: 'text', text: 'visible' }]), 'visible');
  assert.equal(visibleText('shown<thinking>reasoning</thinking><tool_result>private</tool_result>'), 'shown');
  const chat = conversation('secret', text); chat.turns[0].tools = [{ output: 'tool-secret' }];
  const { service, calls, writes } = setup(t, { conversations: [chat], generate: input => {
    const value = candidate(data(input.prompt).evidence); value.evidence[0].quote = 'Use concise summaries.'; return { candidates: [value] };
  } });
  assert.equal((await service.run()).ok, true);
  const serial = JSON.stringify([calls, writes]);
  for (const secret of ['do-not-copy', 'secrethere', 'secret-key', 'tool-secret']) assert.ok(!serial.includes(secret));
});

test('cancellation and a chat resumed during generation do not commit or advance progress', async t => {
  const controller = new AbortController();
  const first = setup(t, { generate: input => { controller.abort(); return { candidates: [candidate(data(input.prompt).evidence)] }; } });
  const cancelled = await first.service.run({ signal: controller.signal }); assert.equal(cancelled.cancelled, true); assert.equal(first.writes.length, 0);
  assert.equal(first.service.status().processed, 0);
  const second = setup(t); second.options.generate = async input => { second.active.add('c1'); return { candidates: [candidate(data(input.prompt).evidence)] }; };
  const resumed = new MemoryLearningService(second.options); const result = await resumed.run();
  assert.equal(result.skipped, 1); assert.equal(second.writes.length, 0); assert.equal(resumed.status().processed, 0);
});

test('active, recent, plan, failed, unknown-project and unfinished conversations are skipped', async t => {
  const conversations = ['active', 'recent', 'plan', 'failed', 'unknown', 'unfinished'].map(id => conversation(id, 'remember this'));
  conversations[1].updatedAt = new Date(NOW - 1000).toISOString(); conversations[2].executionMode = { kind: 'plan' };
  conversations[3].status = 'failed'; conversations[4].projectId = 'deleted'; conversations[5].turns[0].assistant = '';
  const { service, active, calls } = setup(t, { conversations }); active.add('active');
  const result = await service.run(); assert.equal(result.ok, true); assert.equal(calls.length, 0);
});

test('modern persisted final text takes precedence; incomplete finals and chat-only output are excluded', () => {
  const chat = conversation('modern', 'Please retain only completed visible replies.');
  chat.turns[0].assistant = 'stale assistant field';
  chat.turns[0].output = { final: 'Canonical final reply.', status: 'complete' };
  assert.ok(evidenceFor(chat).some(item => item.text === 'Canonical final reply.'));
  assert.ok(!evidenceFor(chat).some(item => item.text.includes('stale')));
  chat.turns[0].output.status = 'failed'; assert.equal(evidenceFor(chat).length, 0);
  delete chat.turns[0].output; chat.turns[0].chat = [{ type: 'text', text: 'streamed partial' }];
  assert.equal(evidenceFor(chat).length, 0);
});

test('project scope is supplied by host and filtered on explicit project runs', async t => {
  const { service, writes, calls } = setup(t, { conversations: [conversation('p1c', 'Project one rule.', 'p1'), conversation('p2c', 'Project two rule.', 'p2'), conversation('gc', 'Global rule.')] });
  await service.run({ projectId: 'p1' }); assert.equal(writes.length, 1); assert.equal(writes[0].meta.projectId, 'p1');
  assert.ok(calls.every(call => !call.prompt.includes('Project two') && !call.prompt.includes('Global rule')));
});

test('project filtering resolves legacy index rows without a projectId from the loaded document', async t => {
  const { options, calls, writes, conversations } = setup(t, { conversations: [conversation('p1c', 'Project one rule.', 'p1'), conversation('p2c', 'Project two rule.', 'p2')] });
  const service = new MemoryLearningService({ ...options, listConversations: () => conversations.map(({ projectId, ...meta }) => meta) });
  const result = await service.run({ projectId: 'p1' }); assert.equal(result.ok, true); assert.equal(writes.length, 1);
  assert.equal(writes[0].meta.projectId, 'p1'); assert.ok(calls.every(call => !call.prompt.includes('Project two')));
});

test('a run respects its total call budget and eventually visits later conversations', async t => {
  const chats = Array.from({ length: 12 }, (_, i) => conversation(`c${i}`, `Preference ${i}`));
  const { service, calls } = setup(t, { conversations: chats, generate: () => ({ candidates: [] }), options: { limits: { calls: 2, historyCalls: 2, conversations: 2 } } });
  for (let i = 0; i < 6; i++) { const result = await service.run(); assert.equal(result.calls, 2); }
  assert.equal(calls.length, 12); assert.ok(calls.some(call => call.prompt.includes('Preference 11')));
});

test('cross-chat merge validates historical evidence and preserves both original targets', async t => {
  const chats = [conversation('first', 'Use concise summaries for the Alpha project.', 'p1'), conversation('second', 'Include validation with Alpha summaries.', 'p1'), conversation('other', 'Other project summaries.', 'p2')];
  let index = 0;
  const { service, writes, records, calls } = setup(t, { conversations: chats, generate: input => {
    const supplied = data(input.prompt);
    if (input.phase === 'extract') return { candidates: [candidate(supplied.evidence, `Alpha summary rule ${index++}`)] };
    assert.ok(supplied.records.every(record => !record.body.includes('rule 2')));
    return { candidates: [{ ...candidate(supplied.evidence, 'Use concise Alpha summaries and include validation.'), action: 'merge', targets: supplied.records.map(record => record.file) }] };
  } });
  const result = await service.run(); assert.equal(result.ok, true); assert.equal(result.merged, 1);
  const merged = writes.at(-1); assert.equal(merged.meta.projectId, 'p1'); assert.equal(merged.meta.replaces.length, 2);
  for (const replaced of merged.meta.replaces) assert.ok(records.has(replaced.file));
  assert.ok(merged.meta.sources.some(source => source.kind === 'memory'));
  const before = calls.length; await service.run(); assert.equal(calls.length, before);
});

test('merge rejects forged targets, excludes core and does not trust stale conversation quotes', async t => {
  const { service, records, conversations, calls } = setup(t, { generate: () => ({ candidates: [] }) });
  const source = evidenceFor(conversations[0])[0];
  const entry = (file, core, quote = source.text) => ({ file, content: 'summary format', revision: hash(file),
    meta: { type: 'feedback', name: 'summary', description: 'format', scope: 'global', status: 'active', confidence: 'user_confirmed', core,
      sources: [{ ...source.source, quote }], replaces: [] } });
  records.set('a.md', entry('a.md', false, 'forged quote')); records.set('b.md', entry('b.md', true));
  const result = await service.run(); assert.equal(result.ok, true); assert.equal(calls.filter(call => call.phase === 'merge').length, 0);
});

test('live lock rejects parallel work; dead process lock is recovered', async t => {
  const { service, stateDir } = setup(t);
  const lock = path.join(stateDir, 'learning.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other' }));
  assert.equal((await service.run()).code, 'MEMORY_LEARNING_BUSY'); assert.equal(JSON.parse(fs.readFileSync(lock)).token, 'other');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: 'dead' }));
  assert.equal((await service.run()).ok, true); assert.equal(fs.existsSync(lock), false);
});

test('discarded proposals are remembered across service restarts and cannot be regenerated by a timestamp change', async t => {
  const { service, records, options, conversations, writes } = setup(t);
  await service.run(); records.clear(); conversations[0].updatedAt = '2026-10-21T10:00:00.000Z';
  const restarted = new MemoryLearningService(options); await restarted.run(); assert.equal(writes.length, 1);
});

test('invalid state fails closed and provider error text is never exposed', async t => {
  const { service, stateDir } = setup(t);
  fs.writeFileSync(path.join(stateDir, 'learning-state.json'), '{bad'); assert.equal((await service.run()).ok, false);
  fs.unlinkSync(path.join(stateDir, 'learning-state.json'));
  const failed = setup(t, { generate: () => { throw new Error('secret prompt password: private'); } });
  const result = await failed.service.run(); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('private'));
});

test('real store retains equal facts from different chats and approves their merge atomically', async t => {
  const { MemoryStore } = require('../src/main/memory/memory-store');
  const setupResult = setup(t, { conversations: [conversation('one', 'Use concise project summaries.', 'p1'), conversation('two', 'Use concise project summaries.', 'p1')],
    generate: input => {
      const supplied = data(input.prompt), proposal = candidate(supplied.evidence, 'Use concise project summaries.');
      return { candidates: input.phase === 'extract' ? [proposal] : [{ ...proposal, action: 'merge', targets: supplied.records.map(record => record.file) }] };
    } });
  const store = new MemoryStore({ dir: path.join(setupResult.stateDir, 'library') });
  const service = new MemoryLearningService({ ...setupResult.options, store });
  const result = await service.run(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.candidates, 2); assert.equal(result.merged, 1);
  const records = store.list(), merged = records.find(item => item.meta.replaces.length);
  assert.equal(records.length, 3); assert.equal(merged.meta.replaces.length, 2);
  assert.deepEqual([...new Set(merged.meta.sources.filter(item => item.kind === 'conversation').map(item => item.conversationId))].sort(), ['one', 'two']);
  assert.ok(records.every(item => item.meta.status === 'draft'));
  store.setStatus(merged.file, 'active', { expectedRevision: merged.revision });
  assert.equal(store.list().filter(item => item.meta.status === 'active').length, 1);
  assert.equal(store.list().filter(item => item.meta.status === 'superseded').length, 2);
});

test('a source conversation edited during merge prevents the proposed replacement', async t => {
  const chats = [conversation('one', 'Use concise summaries.', 'p1'), conversation('two', 'Include validation in summaries.', 'p1')];
  const { service, writes } = setup(t, { conversations: chats, generate: input => {
    const supplied = data(input.prompt), proposal = candidate(supplied.evidence, 'Summary guidance.');
    if (input.phase === 'extract') return { candidates: [proposal] };
    chats[0].turns[0].user = 'Changed after model input.'; chats[1].turns[0].user = 'Also changed.';
    return { candidates: [{ ...proposal, action: 'merge', targets: supplied.records.map(item => item.file) }] };
  } });
  const result = await service.run(); assert.equal(result.ok, false); assert.equal(result.code, 'MEMORY_LEARNING_EVIDENCE');
  assert.equal(writes.length, 2);
});

test('merge rejects target files that were not supplied by the host', async t => {
  const { service, writes } = setup(t, { conversations: [conversation('one', 'Use concise summaries.'), conversation('two', 'Include validation in summaries.')],
    generate: input => {
      const supplied = data(input.prompt), proposal = candidate(supplied.evidence);
      return { candidates: input.phase === 'extract' ? [proposal]
        : [{ ...proposal, action: 'replace', targets: ['not-provided.md'] }] };
    } });
  const result = await service.run(); assert.equal(result.ok, false); assert.equal(result.code, 'MEMORY_LEARNING_TARGET'); assert.equal(writes.length, 2);
});

test('message count as well as characters is bounded within a model call', async t => {
  const chat = conversation('tiny', 'x'); chat.turns = Array.from({ length: 100 }, (_, i) => ({ ...turn('x', `t${i}`), assistant: 'y' }));
  const { service, calls } = setup(t, { conversations: [chat], generate: () => ({ candidates: [] }), options: { limits: { calls: 1 } } });
  await service.run(); const input = data(calls[0].prompt); assert.equal(input.evidence.length, 32);
  assert.ok(input.evidence.every(item => ['user', 'assistant'].includes(item.role)));
});

test('turn insertion during generation saves the current index while retaining a stable turn identity', async t => {
  const chat = conversation('shifted', 'Keep summaries short.'); let inserted = false;
  const { service, writes, calls } = setup(t, { conversations: [chat], generate: input => {
    if (inserted || input.phase === 'merge') return { candidates: [] };
    inserted = true; chat.turns.unshift(turn('Earlier recovered message.', 'recovered'));
    return { candidates: [candidate(data(input.prompt).evidence)] };
  } });
  assert.equal((await service.run()).ok, true); assert.equal(writes[0].meta.sources[0].turnId, 'turn-1');
  assert.equal(writes[0].meta.sources[0].turnIndex, 1);
  await service.run(); assert.equal(calls.length, 2);
  const next = data(calls[1].prompt).evidence.map(item => item.text).join('\n');
  assert.ok(next.includes('Earlier recovered')); assert.ok(!next.includes('Keep summaries short'));
});

test('source verification follows unique turn ids after index changes and fails closed for rewritten or ambiguous turns', async t => {
  const { service, conversations, writes } = setup(t); await service.run();
  const chat = conversations[0]; chat.turns.unshift(turn('Recovered earlier turn.', 'recovered'));
  const refreshed = await service._verifiedSources(writes, 10000, new Set());
  assert.equal(refreshed.length, 1); assert.equal(refreshed[0].source.turnIndex, 1);
  chat.turns[1].user = 'Different content now.';
  assert.equal((await service._verifiedSources(writes, 10000, new Set())).length, 0);
  chat.turns.push({ ...chat.turns[1] }); assert.equal(evidenceFor(chat).filter(item => item.source.turnId === 'turn-1').length, 0);
});
