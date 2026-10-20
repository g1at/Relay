'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createDeliveryRegistry } = require('../src/main/tasks/turn-deliverables');

async function receiptFixture(t) {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'relay-delivery-owner-'));
  t.after(() => fs.promises.rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'artifact.py'); await fs.promises.writeFile(file, '# synthetic delivery fixture');
  const registry = createDeliveryRegistry();
  await registry.begin({ conversationId: 'owner-fixture', runId: 'owner-run', turnTs: '2026-10-15T00:00:00Z', cwd, outputDir: cwd, allowOutputScan: false });
  const request = scope => registry.observe({ runId: 'owner-run', event: { type: 'assistant', ...scope, message: { content: [
    { type: 'tool_use', id: 'same-tool-id', name: 'Write', input: { file_path: file } },
  ] } } });
  const receipt = scope => registry.observe({ runId: 'owner-run', event: { type: 'user', ...scope, message: { content: [
    { type: 'tool_result', tool_use_id: 'same-tool-id', content: 'Synthetic success' },
  ] } } });
  // Inline script basenames qualify only after a verified request/receipt pair;
  // neither a final link nor a directory scan can independently add this file.
  const finish = () => registry.finish({ runId: 'owner-run', finalText: String.fromCharCode(96) + 'artifact.py' + String.fromCharCode(96) });
  return { request, receipt, finish };
}

for (const [name, requestScope, receiptScope] of [
  ['root request cannot pair with subtype-only child receipt', {}, { subagent_type: 'worker' }],
  ['subtype-only child request cannot pair with root receipt', { subagent_type: 'worker' }, {}],
  ['equal subtype-only roles do not imply the same child identity', { subagent_type: 'worker' }, { subagent_type: 'worker' }],
  ['different known child identities cannot pair', { agent_id: 'child-a' }, { agent_id: 'child-b' }],
]) test(name, async t => {
  const h = await receiptFixture(t); h.request(requestScope); h.receipt(receiptScope);
  assert.deepEqual((await h.finish()).items, []);
});
for (const [name, requestScope, receiptScope] of [
  ['ordinary root request and receipt remain valid', {}, {}],
  ['parent tool IDs preserve known child ownership', { parent_tool_use_id: 'child-a', subagent_type: 'worker' }, { parentToolUseId: 'child-a', subagent_type: 'worker' }],
  ['agent IDs preserve known child ownership', { agent_id: 'child-a', subagent_type: 'worker' }, { agent_id: 'child-a', subagent_type: 'worker' }],
]) test(name, async t => {
  const h = await receiptFixture(t); h.request(requestScope); h.receipt(receiptScope);
  const value = await h.finish(); assert.equal(value.items.length, 1);
  assert.equal(value.items[0].source, 'write-tool'); assert.equal(value.items[0].toolUseId, 'same-tool-id');
});
test('ignored ambiguous child receipt does not settle a later valid root receipt', async t => {
  const h = await receiptFixture(t); h.request({}); h.receipt({ subagent_type: 'worker' }); h.receipt({});
  assert.equal((await h.finish()).items.length, 1);
});
