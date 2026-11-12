'use strict';
const fs = require('node:fs'), vm = require('node:vm'), os = require('node:os'), path = require('node:path');
const test = require('node:test'), assert = require('node:assert/strict');
const { MemoryStore } = require('../src/main/memory/memory-store');
const { createMemoryRuntime } = require('../src/main/memory/memory-runtime');
const { createMemoryRetriever } = require('../src/main/memory/memory-retrieval');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
const start = source.indexOf('function buildSdkParams('), end = source.indexOf('function runRelayText(', start);
function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-params-'));
  const dir = path.join(cwd, '.claude', 'relay-memory');
  const store = new MemoryStore({ dir });
  t.after(() => fs.rmSync(cwd, { force: true, recursive: true }));
  let currentContext, memoryOptions;
  const logs = [];
  const logger = { info: line => logs.push(line), warn: line => logs.push(line) };
  const context = vm.createContext({
    fs, os, console: logger, MEMORY_DIR: dir, relayMemoryStore: store,
    memoryRetriever: createMemoryRetriever({ store }), isMemoryPinned: () => false,
    getSdkRuntimeStorage: () => require('../src/main/sdk/sdk-runtime-storage').createSdkRuntimeStorage({ dataDir: cwd }),
    createMemoryRuntime: options => { memoryOptions = options; currentContext = options.context; return createMemoryRuntime(options); },
    readMemoryUsage: () => ({}), flushMemoryUsage() {}, rebuildMemoryIndex() {}, notifySkillUsageUpdated() {},
    getConversationWorkspaces: () => ({ resolveScratch: () => cwd, fileLocations: () => ({ outputDir: cwd }) }),
    activeRelayProviderRuntime: () => ({ modelId: 'test-model', env: {} }),
    resolveUnattendedPermissionMode: () => 'default', isConversationPermissionMode: () => true,
    buildRuntimePolicy: () => ({}), readAppSettings: () => ({}), toWslPath: value => value,
    readClaudeMcpRegistry: () => ({ enabled: {} }), cronMcpFactory: () => () => ({}),
  });
  vm.runInContext(source.slice(start, end), context);
  return { cwd, dir, build: context.buildSdkParams, currentContext: () => currentContext(),
    memoryOptions: () => memoryOptions, logger, logs };
}
test('background task without an authorized extra directory still guards relative paths in the actual cwd', async t => {
  const { build, currentContext, cwd } = setup(t);
  const params = build({ cwd, validWorkingDir: null, background: true });
  assert.equal(currentContext().cwd, cwd);
  assert.equal(currentContext().mode, 'read');
  assert.equal(params.memoryDir, null);
  const result = await params.onMemoryTool({ tool_name: 'Write', tool_input: { file_path: '.claude/relay-memory/fixture.md' } });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
});
test('live memory context re-evaluates host project/plan flags and disabled tasks do not mount memory server', async t => {
  const { build, cwd, currentContext } = setup(t);
  let host = { projectId: 'a', plan: false };
  const params = build({ cwd, memoryContext: () => host });
  assert.equal(currentContext().projectId, 'a');
  host = { projectId: 'b', plan: true };
  assert.equal(currentContext().projectId, 'b');
  assert.equal((await params.onMemoryTool({ tool_name: 'mcp__relay-memory__propose' })).hookSpecificOutput.permissionDecision, 'deny');
  const disabled = build({ cwd, background: true, includeMemoryDirectory: false });
  const sdk = { tool: (...args) => args, createSdkMcpServer: value => value };
  assert.equal(Object.hasOwn(disabled.mcpServersFactory(sdk), 'relay-memory'), false);
  assert.equal((await disabled.onMemoryTool({ tool_name: 'mcp__relay-memory__read' })).hookSpecificOutput.permissionDecision, 'deny');
});

test('production memory setup wires diagnostics to the main logger with current conversation identity', t => {
  const harness = setup(t);
  harness.build({ cwd: harness.cwd, conversationId: 'conversation-a',
    memoryContext: { sourceRef: 'conversation:conversation-a/run:run-b' } });
  assert.equal(harness.memoryOptions().logger, harness.logger);
  assert.equal(harness.currentContext().conversationId, 'conversation-a');
  assert.equal(harness.currentContext().sourceRef, 'conversation:conversation-a/run:run-b');
  const runtime = createMemoryRuntime(harness.memoryOptions());
  runtime.propose({ file: 'diagnostic.md', content: 'Private memory body.',
    type: 'reference', expectedRevision: null });
  assert.ok(harness.logs.some(line => line.includes('[memory:tool]') && line.includes('conversation-a')));
  assert.ok(harness.logs.every(line => !line.includes('Private memory body.')));
});
