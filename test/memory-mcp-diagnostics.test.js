'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../src/main/memory/memory-store');
const { createMemoryRuntime } = require('../src/main/memory/memory-runtime');
const { serializeMemoryFrontmatter } = require('../src/main/memory/memory-schema');

const sdk = import('@anthropic-ai/claude-agent-sdk');
const modules = Promise.all([
  import('@modelcontextprotocol/sdk/client/index.js'),
  import('@modelcontextprotocol/sdk/inMemory.js'),
]);

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-mcp-'));
  const store = new MemoryStore({ dir });
  const records = [];
  let loggerThrows = false;
  const log = message => {
    if (loggerThrows) throw new Error('Synthetic logger failure');
    assert.ok(message.startsWith('[memory:tool] '));
    records.push(JSON.parse(message.slice('[memory:tool] '.length)));
  };
  const context = { mode: 'full', projectId: 'project-a', conversationId: 'conversation-a',
    runId: 'run-a', sourceRef: 'conversation:conversation-a/run:run-a' };
  const runtime = createMemoryRuntime({ store, context: () => context, logger: { info: log, warn: log } });
  const config = runtime.factory(await sdk)['relay-memory'];
  const [{ Client }, { InMemoryTransport }] = await modules;
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await config.instance.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function connect() {
    const client = new Client({ name: 'relay-memory-diagnostics-test', version: '1.0.0' });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const priorMessages = [];
    serverTransport.onmessage = (message, extra) => priorMessages.push({ message, extra });
    // Initialization queues before the server starts, as it can in SDK startup.
    const connecting = client.connect(clientTransport);
    await config.instance.connect(serverTransport);
    await connecting;
    return { client, priorMessages };
  }
  return { store, context, records, connect, setLoggerThrows: value => { loggerThrows = value; } };
}

function textResult(result) {
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}

function diagnosticPair(records, offset, kind) {
  const pair = records.slice(offset);
  assert.equal(pair.length, 2);
  assert.deepEqual(pair.map(record => record.phase), ['attempt', 'result']);
  assert.equal(pair[0].requestId, pair[1].requestId);
  assert.equal(typeof pair[0].requestId, 'number');
  if (kind) assert.ok(pair.every(record => record.expectedRevisionKind === kind));
  if (kind === 'string-null') {
    assert.ok(pair.every(record => record.normalizedExpectedRevisionKind === 'null'
      && record.revisionCompatibility === 'string-null'));
  } else {
    assert.ok(pair.every(record => !Object.hasOwn(record, 'normalizedExpectedRevisionKind')
      && !Object.hasOwn(record, 'revisionCompatibility')));
  }
  return pair;
}

test('actual SDK schema rejections retain raw revision diagnostics and strict proposal semantics', async t => {
  const { store, records, connect } = await fixture(t);
  const { client } = await connect();
  const tools = await client.listTools();
  const schema = tools.tools.find(tool => tool.name === 'propose').inputSchema;
  assert.ok(schema.required.includes('expectedRevision'));
  assert.ok(schema.required.includes('type'));
  const content = 'Synthetic private body that must never appear in diagnostics.';
  const cases = [
    { file: 'missing.md', args: {}, kind: 'missing', code: 'MCP_INVALID_PARAMS' },
    { file: 'created.md', args: { expectedRevision: null }, kind: 'null' },
    { file: 'string-null.md', args: { expectedRevision: 'null' }, kind: 'string-null' },
    { file: 'number.md', args: { expectedRevision: 42 }, kind: 'number', code: 'MCP_INVALID_PARAMS' },
    { file: 'empty.md', args: { expectedRevision: '' }, kind: 'empty-string', code: 'MEMORY_INVALID_REVISION' },
    { file: 'whitespace.md', args: { expectedRevision: ' null ' }, kind: 'string', code: 'MEMORY_INVALID_REVISION' },
    { file: 'case.md', args: { expectedRevision: 'Null' }, kind: 'string', code: 'MEMORY_INVALID_REVISION' },
    { file: 'malformed.md', args: { expectedRevision: 'invalid-revision' }, kind: 'string', code: 'MEMORY_INVALID_REVISION' },
  ];
  for (const entry of cases) {
    const offset = records.length;
    const result = await client.callTool({ name: 'propose', arguments: {
      file: entry.file, type: 'feedback', content, ...entry.args,
    } });
    assert.equal(result.isError === true, !!entry.code);
    const pair = diagnosticPair(records, offset, entry.kind);
    assert.equal(pair[1].code, entry.code);
    assert.ok(pair.every(record => record.expectedRevision === null));
    if (entry.code === 'MCP_INVALID_PARAMS') {
      assert.deepEqual(pair[1].invalidFields, ['expectedRevision']);
      assert.match(result.content[0].text, /expectedRevision/);
    } else if (entry.code) {
      assert.equal(textResult(result).code, entry.code);
      assert.equal(pair[1].targetExists, undefined);
      assert.equal(pair[1].actualRevision, undefined);
    } else {
      assert.equal(textResult(result).file, entry.file);
      assert.equal(pair[1].status, 'draft');
      assert.equal(pair[1].resultFile, entry.file);
      assert.match(pair[1].revision, /^[a-f0-9]{64}$/);
    }
  }
  assert.deepEqual(store.list().map(entry => entry.file).sort(), ['created.md', 'string-null.md']);
  const previous = store.read('created.md');
  for (const expectedRevision of [null, 'null']) {
    const offset = records.length;
    const collision = await client.callTool({ name: 'propose', arguments: {
      file: previous.file, type: 'feedback', content: 'A colliding new proposal.', expectedRevision,
    } });
    assert.equal(collision.isError, true);
    const conflict = diagnosticPair(records, offset, expectedRevision === null ? 'null' : 'string-null')[1];
    assert.equal(conflict.code, 'MEMORY_CONFLICT');
    assert.equal(conflict.targetExists, true);
    assert.equal(conflict.targetStatus, 'draft');
    assert.equal(conflict.actualRevision, previous.revision);
    assert.equal(textResult(collision).actualRevision, undefined);
    assert.equal(textResult(collision).targetExists, undefined);
    assert.equal(store.read(previous.file).revision, previous.revision);
  }

  let offset = records.length;
  const updated = await client.callTool({ name: 'propose', arguments: {
    file: previous.file, type: 'feedback', content: 'Updated synthetic body.', expectedRevision: previous.revision,
  } });
  assert.equal(updated.isError, undefined);
  const pair = diagnosticPair(records, offset, 'string');
  assert.ok(pair.every(record => record.expectedRevision === previous.revision));
  assert.notEqual(pair[1].revision, previous.revision);
  const current = store.read(previous.file);
  offset = records.length;
  const stale = await client.callTool({ name: 'propose', arguments: {
    file: previous.file, type: 'feedback', content: 'A stale update.', expectedRevision: previous.revision,
  } });
  assert.equal(stale.isError, true);
  assert.equal(textResult(stale).code, 'MEMORY_CONFLICT');
  const stalePair = diagnosticPair(records, offset, 'string');
  assert.ok(stalePair.every(record => record.expectedRevision === previous.revision));
  assert.equal(stalePair[1].actualRevision, current.revision);
  assert.equal(stalePair[1].targetExists, true);
  assert.equal(store.read(previous.file).revision, current.revision);
  assert.equal(store.read(previous.file).content, current.content);
  assert.ok(records.every(record => record.conversationId === 'conversation-a' && record.runId === 'run-a'));
  assert.ok(!JSON.stringify(records).includes(content));
});

test('actual SDK string-null compatibility preserves maintenance confirmation and core protections', async t => {
  const { store, records, context, connect } = await fixture(t);
  context.mode = 'maintenance';
  context.userConfirmed = true;
  const { client } = await connect();
  const offset = records.length;
  const saved = await client.callTool({ name: 'propose', arguments: {
    file: 'maintenance.md', type: 'feedback', content: 'An unconfirmed inference.', expectedRevision: 'null',
  } });
  assert.equal(saved.isError, undefined);
  assert.equal(textResult(saved).meta.status, 'draft');
  assert.equal(store.read('maintenance.md').meta.status, 'draft');
  assert.equal(diagnosticPair(records, offset, 'string-null')[1].status, 'draft');

  const core = store.write('core.md', `${serializeMemoryFrontmatter({ core: true })}\nA protected fact.`);
  for (const [expectedRevision, code, kind] of [[core.revision, 'MEMORY_CORE', 'string'], ['null', 'MEMORY_CONFLICT', 'string-null']]) {
    const before = records.length;
    const denied = await client.callTool({ name: 'propose', arguments: {
      file: core.file, type: 'feedback', content: 'A replacement fact.', expectedRevision,
    } });
    assert.equal(denied.isError, true);
    assert.equal(textResult(denied).code, code);
    assert.equal(diagnosticPair(records, before, kind)[1].code, code);
    assert.equal(store.read(core.file).revision, core.revision);
  }
});

test('actual SDK read and proposal errors report outcomes without logging bodies or exception text', async t => {
  const { store, records, context, connect } = await fixture(t);
  const { client } = await connect();
  const secret = 'SYNTHETIC_PRIVATE_VALUE_01';
  store.write('readable.md', `${serializeMemoryFrontmatter({ name: secret, description: secret, type: 'feedback' })}\n${secret}`);
  const offset = records.length;
  const readable = await client.callTool({ name: 'read', arguments: { file: 'readable.md' } });
  assert.equal(readable.isError, undefined);
  assert.ok(textResult(readable).content.includes(secret));
  const pair = diagnosticPair(records, offset);
  assert.equal(pair[1].status, 'active');
  assert.equal(pair[1].file, 'readable.md');

  const old = store.write('retired.md', 'Synthetic old fact.');
  const proposal = store.write(old.file, 'Synthetic replacement fact.', {
    actor: 'model', memoryType: 'feedback', expectedRevision: old.revision,
  });
  const approved = store.setStatus(proposal.file, 'active');
  let before = records.length;
  const retired = await client.callTool({ name: 'read', arguments: { file: old.file } });
  assert.equal(retired.isError, true);
  assert.equal(textResult(retired).code, 'MEMORY_SUPERSEDED');
  assert.equal(textResult(retired).file, old.file);
  assert.deepEqual(textResult(retired).replacementFiles, [approved.file]);
  assert.equal(diagnosticPair(records, before)[1].code, 'MEMORY_SUPERSEDED');

  const originalRead = store.read.bind(store);
  store.read = (file, options) => {
    if (file === 'failed.md') throw Object.assign(new Error(secret), { code: 'EIO' });
    return originalRead(file, options);
  };
  before = records.length;
  const failed = await client.callTool({ name: 'read', arguments: { file: 'failed.md' } });
  assert.equal(failed.isError, true);
  assert.equal(textResult(failed).code, 'EIO');
  assert.equal(diagnosticPair(records, before)[1].code, 'EIO');

  before = records.length;
  const malformed = await client.callTool({ name: 'propose', arguments: {
    file: '../private.md', type: secret, expectedRevision: { secret }, content: secret,
  } });
  assert.equal(malformed.isError, true);
  const invalid = diagnosticPair(records, before, 'object');
  assert.ok(invalid.every(record => record.file === null && record.memoryType === null));
  assert.deepEqual(invalid[1].invalidFields.sort(), ['expectedRevision', 'type']);

  context.mode = 'read';
  before = records.length;
  const denied = await client.callTool({ name: 'propose', arguments: {
    file: 'blocked.md', type: 'feedback', expectedRevision: 'null', content: secret,
  } });
  assert.equal(denied.isError, true);
  assert.equal(diagnosticPair(records, before, 'string-null')[1].code, 'MEMORY_PERMISSION');
  assert.ok(!JSON.stringify(records).includes(secret));
  assert.ok(records.every(record => !Object.hasOwn(record, 'content') && !Object.hasOwn(record, 'message')));
});

test('MCP connect observers preserve callbacks across reconnect and logger failures preserve tool results', async t => {
  const { store, records, connect, setLoggerThrows } = await fixture(t);
  store.write('known.md', 'Synthetic known fact.');
  const first = await connect();
  await first.client.callTool({ name: 'read', arguments: { file: 'known.md' } });
  assert.equal(first.priorMessages.filter(item => item.message.method === 'initialize').length, 1);
  assert.equal(first.priorMessages.filter(item => item.message.method === 'tools/call').length, 1);
  diagnosticPair(records, 0);
  await first.client.close();

  const second = await connect();
  let offset = records.length;
  const result = await second.client.callTool({ name: 'read', arguments: { file: 'known.md' } });
  assert.equal(result.isError, undefined);
  diagnosticPair(records, offset);
  assert.equal(second.priorMessages.filter(item => item.message.method === 'tools/call').length, 1);
  assert.equal(first.priorMessages.filter(item => item.message.method === 'tools/call').length, 1);

  setLoggerThrows(true);
  offset = records.length;
  const saved = await second.client.callTool({ name: 'propose', arguments: {
    file: 'logger-down.md', type: 'feedback', content: 'Synthetic new fact.', expectedRevision: 'null',
  } });
  assert.equal(saved.isError, undefined);
  assert.equal(store.read('logger-down.md').meta.status, 'draft');
  const rejected = await second.client.callTool({ name: 'propose', arguments: {
    file: 'invalid.md', type: 'feedback', content: 'Synthetic invalid proposal.',
  } });
  assert.equal(rejected.isError, true);
  assert.equal(records.length, offset);
  setLoggerThrows(false);
  await second.client.callTool({ name: 'read', arguments: { file: 'known.md' } });
  diagnosticPair(records, offset);
  assert.equal(second.priorMessages.filter(item => item.message.method === 'tools/call').length, 4);
});
