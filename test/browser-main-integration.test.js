'use strict';

// Host SDK integration with synthetic tool transports. No browser, account,
// model request or remote debugger is used by this fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createBrowserToolFactory } = require('../src/main/browser/browser-tools');
const { mapMcpServers } = require('../src/main/sdk/agent-environment');
const { _buildOptions } = require('../src/main/sdk/claude-sdk');

const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');
function declaration(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const tail = source.slice(start), end = tail.indexOf('\n}\n');
  return tail.slice(0, end + 2);
}
const mockSdk = {
  tool: (name, description, inputSchema, handler, options) => ({ name, description, inputSchema, handler, options }),
  createSdkMcpServer: instance => ({ type: 'sdk', instance }),
};
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-browser-main-'));
  t.after(() => fs.rmSync(cwd, { force: true, recursive: true }));
  const calls = [], pauses = [];
  const context = vm.createContext({
    fs, os, AbortController, console, MEMORY_DIR: path.join(cwd, 'memory'), relayMemoryStore: {}, memoryRetriever: {}, isMemoryPinned: () => false,
    createMemoryRuntime: () => ({ hook: async () => ({}), factory: () => ({}) }),
    createBrowserToolFactory,
    browserPanelTools: {
      automationInvoke: async (scope, input) => { calls.push({ scope, input }); return { ok: true, tabs: [] }; },
      automationPauseConversation: (conversationId, reason) => pauses.push({ conversationId, reason }),
    },
    getSdkRuntimeStorage: () => ({ apply: value => value }),
    readMemoryUsage: () => ({}), flushMemoryUsage() {}, rebuildMemoryIndex() {}, notifySkillUsageUpdated() {},
    activeRelayProviderRuntime: () => ({ modelId: 'fixture', env: {} }),
    resolveUnattendedPermissionMode: () => 'default', isConversationPermissionMode: () => true,
    buildRuntimePolicy: () => ({}), readAppSettings: () => ({}), toWslPath: value => value,
    getConversationWorkspaces: () => ({ resolveScratch: () => cwd }),
    readClaudeMcpRegistry: () => ({ enabled: { unrelated: { type: 'http', url: 'https://example.invalid/mcp' } } }),
    cronMcpFactory: () => () => ({ 'relay-cron': { type: 'sdk', instance: {} } }),
    liveSessions: new Map(), liveTurnControls: { isStopping: () => false, interrupt: async () => ({ aborted: true }) },
  });
  for (const name of ['createBrowserRunScope', 'liveBrowserContext', 'buildSdkParams', 'interruptLiveTurn']) {
    vm.runInContext(declaration(name), context);
  }
  return { context, cwd, calls, pauses, build: input => context.buildSdkParams({ cwd, includeMemoryDirectory: false, ...input }) };
}

test('main SDK factory keeps browser in process with user MCP and cron, including WSL mapping', async t => {
  const h = fixture(t);
  let runId = 'first-run';
  const params = h.build({ conversationId: 'host-conversation', attachCronMcp: true,
    browserContext: () => ({ conversationId: 'host-conversation', runId, isCurrent: () => true, readOnly: false }) });
  const options = _buildOptions({ ...params, cwd: h.cwd }, mockSdk);
  assert.equal(options.mcpServers.unrelated.url, 'https://example.invalid/mcp');
  assert.equal(options.mcpServers['relay-cron'].type, 'sdk');
  const browser = options.mcpServers['relay-browser'];
  assert.equal(browser.type, 'sdk');
  assert.equal(mapMcpServers(options.mcpServers)['relay-browser'], browser);
  assert.match(options.systemPrompt.append, /先 tabs\/open，再 observe/);
  assert.match(options.systemPrompt.append, /不把动作执行成功当作任务完成/);
  const tools = browser.instance.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['act', 'close', 'diagnostics', 'download', 'downloads', 'evidence', 'focus', 'frames', 'locate', 'navigate', 'observe', 'open', 'screenshot', 'tabs', 'upload', 'verify', 'wait']);
  const tabs = tools.find(tool => tool.name === 'tabs');
  await tabs.handler({}); runId = 'next-run'; await tabs.handler({});
  assert.deepEqual(h.calls.map(call => call.scope.runId), ['first-run', 'next-run']);
  assert.equal(h.calls.every(call => call.scope.conversationId === 'host-conversation'), true);
});

test('background, anonymous and tool-free calls cannot mount the interactive browser', t => {
  const h = fixture(t);
  for (const override of [{ background: true }, { tools: [] }, { conversationId: null }, { browserContext: undefined }]) {
    const params = h.build({ conversationId: 'conversation', browserContext: () => ({ runId: 'run' }), ...override });
    assert.equal(Object.hasOwn(params.mcpServersFactory(mockSdk), 'relay-browser'), false);
    assert.equal(params.appendSystemPrompt, undefined);
  }
});

test('live browser authority snapshots each run and revokes old scopes on idle, replacement and interrupts', async t => {
  const h = fixture(t);
  const sess = { convId: 'conversation', jobId: null, busy: false, dead: false, turnRouter: {}, launchSpec: { cwd: h.cwd }, executionMode: { kind: 'default' } };
  h.context.liveSessions.set(sess.convId, sess);
  assert.equal(h.context.liveBrowserContext(sess).isCurrent(), false);
  assert.equal(sess.browserAutomation, undefined);
  sess.jobId = 'first'; sess.busy = true;
  const first = h.context.liveBrowserContext(sess);
  assert.equal(first.isCurrent(), true); assert.equal(first.readOnly, false); assert.equal(first.workspaceRoot, h.cwd);
  sess.executionMode = { kind: 'plan' };
  assert.equal(h.context.liveBrowserContext(sess).readOnly, true);
  sess.busy = false;
  assert.equal(first.isCurrent(), false);
  sess.busy = true; sess.jobId = 'next';
  const next = h.context.liveBrowserContext(sess);
  assert.equal(first.signal.aborted, true); assert.equal(first.isCurrent(), false);
  assert.equal(next.runId, 'next'); assert.equal(next.signal.aborted, false);
  assert.equal(h.pauses.length, 0, 'an old run cannot pause its replacement');
  h.context.liveTurnControls.interrupt = async () => {
    assert.equal(next.signal.aborted, true, 'input is revoked before asynchronous SDK interrupt');
    return { aborted: true };
  };
  await h.context.interruptLiveTurn(sess);
  assert.equal(next.isCurrent(), false);
  assert.deepEqual(h.pauses, [{ conversationId: 'conversation', reason: 'run-stopped' }]);
});

test('late session shutdown cannot pause a new owner and pause failures do not restore input authority', t => {
  const h = fixture(t);
  let current = true;
  const old = h.context.createBrowserRunScope({ conversationId: 'conversation', runId: 'old',
    isCurrent: () => current, getReadOnly: () => false });
  const captured = old.getContext(); current = false;
  old.stop('session-closed');
  assert.equal(captured.signal.aborted, true); assert.equal(h.pauses.length, 0);
  current = true;
  const active = h.context.createBrowserRunScope({ conversationId: 'conversation', runId: 'active',
    isCurrent: () => current, getReadOnly: () => true });
  h.context.browserPanelTools.automationPauseConversation = () => { throw new Error('synthetic host shutdown'); };
  assert.doesNotThrow(() => active.stop('run-finished'));
  assert.equal(active.getContext().isCurrent(), false);
});

test('all normal live shutdown paths synchronously revoke browser input before changing task identity', () => {
  for (const [name, boundary] of [['finishTurn', 'sess.busy = false'], ['settleUnsentLiveTurn', 'sess.busy = false'], ['killLiveSession', 'sess.dead = true']]) {
    const text = declaration(name);
    assert.ok(text.indexOf('sess.browserAutomation?.stop(') >= 0, name);
    assert.ok(text.indexOf('sess.browserAutomation?.stop(') < text.indexOf(boundary), name);
  }
  const spawn = declaration('spawnLiveSession');
  const exit = spawn.slice(spawn.indexOf('const onExit ='));
  assert.ok(exit.indexOf('sess.browserAutomation?.stop(') < exit.indexOf('sess.dead = true'));
  assert.match(source, /browserPanelTools\.automationPauseAll\('all-runs-stopped'\)/);
});
