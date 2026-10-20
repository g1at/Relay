'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTurnDeliveryHooks, MAX_TRACKED_TOOLS, TOOL_ID_PREFIX } = require('../src/main/app/turn-delivery-hooks');
const { createDeliveryRegistry } = require('../src/main/tasks/turn-deliverables');
const scope = { runId: 'run-a', conversationId: 'conversation-a' };
const other = { runId: 'run-b', conversationId: 'conversation-b' };
const hook = (kind, extra = {}) => ({ hook_event_name: kind, session_id: 'session-a', cwd: '/workspace',
  tool_use_id: 'write-1', tool_name: 'Write', tool_input: { file_path: 'report.md', content: 'private body' }, ...extra });
function fixture(active = () => true) {
  const events = [];
  const observer = createTurnDeliveryHooks({ observe: (runId, event) => events.push({ runId, event }), isActive: active });
  const pre = extra => observer.observe(hook('PreToolUse', extra), undefined, scope);
  const post = extra => observer.observe(hook('PostToolUse', extra), undefined, scope);
  return { ...observer, events, pre, post };
}
const results = f => f.events.filter(({ event }) => event.type === 'user');

test('matched native write emits a minimal intent and successful receipt', () => {
  const f = fixture();
  assert.equal(f.pre(), undefined); assert.equal(f.post({ tool_response: { content: 'private result' } }), undefined);
  assert.equal(f.events.length, 2);
  assert.equal(f.events[0].runId, scope.runId);
  assert.equal(f.events[0].event.jobId, scope.runId);
  assert.equal(f.events[0].event.message.content[0].id, TOOL_ID_PREFIX + 'write-1');
  assert.deepEqual(f.events[0].event.message.content[0].input, { file_path: 'report.md' });
  assert.equal(f.events[1].event.message.content[0].tool_use_id, TOOL_ID_PREFIX + 'write-1');
  assert.equal(f.events[1].event.message.content[0].is_error, false);
  assert.equal(JSON.stringify(f.events).includes('private'), false);
  assert.equal(JSON.stringify(f.events).includes('permissionDecision'), false);
});
test('each supported write tool records its native path without input contents', () => {
  for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    const f = fixture(); const input = name === 'NotebookEdit' ? { notebook_path: 'result.ipynb' } : { file_path: 'report.md' };
    f.pre({ tool_name: name, tool_input: input }); f.post({ tool_name: name, tool_input: input });
    assert.equal(results(f).length, 1, name); assert.equal(f.events[0].event.message.content[0].name, name);
  }
});
test('read and arbitrary MCP tools are not interpreted as successful writes', () => {
  for (const name of ['Read', 'Bash', 'mcp__files__Write']) {
    const f = fixture(); f.pre({ tool_name: name }); f.post({ tool_name: name }); assert.equal(f.events.length, 0);
  }
});
test('current callback scope cannot reassign a captured write to another turn', () => {
  const seen = []; const f = fixture((runId, conversationId) => { seen.push([runId, conversationId]); return runId === scope.runId; });
  f.pre(); f.observe(hook('PostToolUse'), undefined, other);
  assert.equal(results(f).length, 1); assert.equal(results(f)[0].runId, scope.runId);
  assert.deepEqual(seen, [[scope.runId, scope.conversationId], [scope.runId, scope.conversationId]]);
});
test('inactive pre and paused or finished post events never certify writes', () => {
  let active = false; const f = fixture(() => active);
  f.pre(); f.post(); assert.equal(f.events.length, 0);
  active = true; f.pre(); active = false; f.post(); active = true; f.post();
  assert.equal(f.events.length, 1); assert.equal(results(f).length, 0);
});
test('unknown and repeated success callbacks do not make duplicate evidence', () => {
  const f = fixture(); f.post(); assert.equal(f.events.length, 0);
  f.pre(); f.pre(); f.post(); f.post(); f.pre(); f.post();
  assert.equal(f.events.length, 2);
});
test('native failure closes the intent and cannot be followed by a success', () => {
  const f = fixture(); f.pre(); f.observe(hook('PostToolUseFailure', { error: 'test failure' }), undefined, scope); f.post();
  assert.equal(results(f).length, 0);
});
test('explicit error markers on a post callback cannot certify a write', () => {
  for (const extra of [{ is_error: true }, { tool_response: { is_error: true } }, { tool_response: { isError: true } }]) {
    const f = fixture(); f.pre(); f.post(extra); f.post(); assert.equal(results(f).length, 0);
  }
});
test('child agent must own both sides and its cwd is captured without changing session state', () => {
  const f = fixture(); f.pre({ agent_id: 'child-a', cwd: '/child-worktree' });
  f.post(); f.post({ agent_id: 'child-b' }); assert.equal(results(f).length, 0);
  f.post({ agent_id: 'child-a', cwd: '/changed-cwd' });
  assert.equal(results(f).length, 1);
  for (const { event } of f.events) { assert.equal(event.agent_id, 'child-a'); assert.equal(event.cwd, '/child-worktree'); }
});
test('one instance rejects other SDK sessions before and after a pending write', () => {
  const f = fixture(); f.pre(); f.post({ session_id: 'session-b' });
  f.pre({ session_id: 'session-b', tool_use_id: 'write-2' }); assert.equal(f.events.length, 1);
  f.post(); assert.equal(results(f).length, 1);
});
test('parallel LiveSession instances cannot consume each other\'s receipts', () => {
  const a = fixture(), b = fixture(); a.pre(); b.post(); assert.equal(b.events.length, 0); a.post(); assert.equal(results(a).length, 1);
});
test('post callbacks with a different tool or path do not match a captured write', () => {
  const f = fixture(); f.pre(); f.post({ tool_name: 'Edit' }); f.post({ tool_input: { file_path: 'another.md' } });
  assert.equal(results(f).length, 0); f.post(); assert.equal(results(f).length, 1);
});
test('conflicting reused native tool IDs are retired rather than rebound', () => {
  const f = fixture(); f.pre(); f.observe(hook('PreToolUse'), undefined, other); f.post();
  assert.equal(f.events.length, 1); assert.equal(results(f).length, 0);
});
test('callback tool id must agree with the SDK input tool id', () => {
  const f = fixture(); f.observe(hook('PreToolUse'), 'wrong-id', scope); assert.equal(f.events.length, 0);
  f.observe(hook('PreToolUse'), 'write-1', scope); f.observe(hook('PostToolUse'), 'wrong-id', scope);
  assert.equal(results(f).length, 0); f.observe(hook('PostToolUse'), 'write-1', scope); assert.equal(results(f).length, 1);
});
test('invalid identities paths and scope are ignored', () => {
  const f = fixture();
  for (const extra of [{ session_id: '' }, { tool_use_id: '' }, { agent_id: {} }, { tool_input: {} }, { tool_input: { file_path: 'bad\npath' } }]) f.pre(extra);
  f.observe(hook('PreToolUse'), undefined, {}); assert.equal(f.events.length, 0);
});
test('pending capacity is bounded and settled entries release slots', () => {
  const f = fixture();
  for (let i = 0; i < MAX_TRACKED_TOOLS + 1; i++) f.pre({ tool_use_id: 'write-' + i });
  assert.equal(f.events.length, MAX_TRACKED_TOOLS);
  f.post({ tool_use_id: 'write-' + MAX_TRACKED_TOOLS }); assert.equal(results(f).length, 0);
  f.post({ tool_use_id: 'write-0' }); f.pre({ tool_use_id: 'fresh-write' }); f.post({ tool_use_id: 'fresh-write' });
  assert.equal(results(f).length, 2);
});
test('inactive pending entries release slots without becoming results', () => {
  let active = true; const f = fixture(runId => active || runId === 'new-run');
  for (let i = 0; i < MAX_TRACKED_TOOLS; i++) f.pre({ tool_use_id: 'write-' + i });
  active = false; f.observe(hook('PreToolUse', { tool_use_id: 'fresh-write' }), undefined, { ...scope, runId: 'new-run' });
  f.post({ tool_use_id: 'write-0' }); f.post({ tool_use_id: 'fresh-write' });
  assert.equal(results(f).length, 1); assert.equal(results(f)[0].runId, 'new-run');
});
test('disposed observers ignore late events and cannot restart', () => {
  const f = fixture(); f.pre(); f.dispose(); f.post(); f.pre({ tool_use_id: 'write-2' }); assert.equal(f.events.length, 1);
});
test('observer failures never throw into the SDK hook or produce permission output', async () => {
  const f = createTurnDeliveryHooks({ isActive: () => true, observe: () => { throw Error('fixture failure'); } });
  assert.doesNotThrow(() => { f.observe(hook('PreToolUse'), undefined, scope); f.observe(hook('PostToolUse'), undefined, scope); });
  const asyncFailure = createTurnDeliveryHooks({ isActive: () => true, observe: () => Promise.reject(Error('fixture failure')) });
  asyncFailure.observe(hook('PreToolUse'), undefined, scope); asyncFailure.observe(hook('PostToolUse'), undefined, scope);
  await new Promise(resolve => setImmediate(resolve));
  const unavailable = fixture(() => { throw Error('unavailable'); }); unavailable.pre(); assert.equal(unavailable.events.length, 0);
});
for (const duplicateNative of [false, true]) test('hook child receipt survives native parent owner metadata, duplicate native result: ' + duplicateNative, async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'relay-delivery-hook-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), scratch = path.join(root, 'scratch');
  await fs.promises.mkdir(cwd); await fs.promises.mkdir(scratch);
  const child = path.join(cwd, 'child'); await fs.promises.mkdir(child);
  const file = path.join(child, 'summary.md'); await fs.promises.writeFile(file, 'fixture');
  const registry = createDeliveryRegistry();
  await registry.begin({ ...scope, turnTs: '2026-10-15T00:00:00Z', cwd, outputDir: cwd, scratchDir: scratch });
  const observer = createTurnDeliveryHooks({ isActive: (runId, conversationId) => runId === scope.runId && conversationId === scope.conversationId,
    observe: (runId, event) => registry.observe({ runId, event }) });
  const input = { cwd: child, agent_id: 'child-a', tool_input: { file_path: 'summary.md' } };
  // The native assistant may be routed through its parent Agent tool id while
  // native child tool_result never reaches the root turn router.
  const native = { jobId: scope.runId, parent_tool_use_id: 'parent-agent-tool', cwd: child };
  registry.observe({ runId: scope.runId, event: { ...native, type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: 'summary.md' } },
  ] } } });
  observer.observe(hook('PreToolUse', input), undefined, scope);
  observer.observe(hook('PostToolUse', input), undefined, other);
  // Even when a duplicate native result does arrive, path dedup keeps one card.
  if (duplicateNative) registry.observe({ runId: scope.runId, event: { ...native, type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'write-1', content: '', is_error: false },
  ] } } });
  const result = await registry.finish({ runId: scope.runId, finalText: String.fromCharCode(96) + 'summary.md' + String.fromCharCode(96) });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].path, file);
  assert.equal(result.items[0].source, 'write-tool');
  if (!duplicateNative) assert.equal(result.items[0].toolUseId, TOOL_ID_PREFIX + 'write-1');
});
test('hook success still requires an existing verified file in the registry', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'relay-delivery-hook-missing-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const registry = createDeliveryRegistry();
  await registry.begin({ ...scope, turnTs: '2026-10-15T00:00:00Z', cwd: root, outputDir: root, scratchDir: path.join(root, 'scratch') });
  const observer = createTurnDeliveryHooks({ isActive: () => true, observe: (runId, event) => registry.observe({ runId, event }) });
  observer.observe(hook('PreToolUse', { cwd: root }), undefined, scope);
  observer.observe(hook('PostToolUse', { cwd: root }), undefined, scope);
  assert.deepEqual((await registry.finish({ runId: scope.runId, finalText: '[report](report.md)' })).items, []);
});
