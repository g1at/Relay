'use strict';
// Production renderer lifecycle and loader code with in-memory host objects.
// No provider requests, user settings, or Electron instance are required.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = path.join(__dirname, '../renderer');
const source = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8');
const panelSource = fs.readFileSync(path.join(renderer, 'workspace-panel.js'), 'utf8');
function between(text, start, end) {
  const from = text.indexOf(start), to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return text.slice(from, to);
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('first paint work does not wait for settings and one settings snapshot initializes theme and routing', async () => {
  let readCount = 0, resolveSettings;
  const calls = [];
  const settings = new Promise(resolve => { resolveSettings = resolve; });
  const context = vm.createContext({
    window: { api: { settings: { read: () => { readCount++; return settings; } }, probeEnv() { throw Error('unused startup probe'); } } },
    _themeSetting: 'light', _systemDarkMq: { addEventListener() {} },
    defaultModel: 'opus', currentModel: 'opus', currentEffort: null, followUpMode: 'steer', agentEnvironment: 'native',
    providerRouting: { chatRoutes: [] },
    setConversationIndexEnabled: value => calls.push(['index', value]),
    setContextUsageEnabled: value => calls.push(['context', value]),
    applyThemeToDOM: value => calls.push(['theme', value]),
    refreshComposerPermission: async () => calls.push(['permission']),
    applyBrand: () => calls.push(['brand']), applyWorkdirUI: () => calls.push(['workdir']),
    refreshHistoryList: () => calls.push(['history']),
    applyProviderRouting: routes => calls.push(['routes', routes]), configuredChatRoute: () => true,
    initProviderRoutingEvents() {}, currentTier: () => 'haiku', effortForTier: () => 'low',
    updateModelSwitchUI() {}, updateComposerForMode() {}, initRelayUpdate() {},
  });
  vm.runInContext(between(source, 'async function initTheme(', '// ─────────────────────────────────────────\n// 启动:'), context);
  vm.runInContext(between(source, 'let brandRenderRevision = 0;', '// Projects choose execution directories'), context);
  assert.equal(readCount, 1);
  assert.ok(calls.some(([name]) => name === 'history'));
  assert.ok(calls.some(([name]) => name === 'brand'));
  assert.ok(!calls.some(([name]) => name === 'theme'));
  resolveSettings({ app: { theme: 'dark', followUpMode: 'queue', agentEnvironment: 'wsl', showContextUsage: false }, claude: { defaultModel: 'haiku', routes: {} } });
  await flush();
  assert.equal(context._themeSetting, 'dark');
  assert.equal(context.currentModel, 'haiku');
  assert.equal(context.followUpMode, 'queue');
  assert.equal(context.agentEnvironment, 'wsl');
  assert.ok(calls.some(([name, value]) => name === 'context' && value === false));
});

test('switching conversation releases old transcript views without deleting live task data', () => {
  const maps = [];
  class TrackedWeakMap extends WeakMap { constructor() { super(); maps.push(this); } }
  const state = { items: [{ text: 'background work retained' }] };
  const turn = { user: 'original request', assistant: 'retained answer', activityEl: {} };
  const run = { turn, activityState: state, activityEl: {}, outputBubble: {}, errorEl: {}, supplementTimeline: { segments: new Map([['start', {}]]) } };
  let clears = 0, timerCleared = false;
  const host = { replaceChildren() { clears++; } };
  const context = vm.createContext({
    window: {}, WeakMap: TrackedWeakMap, messagesEl: host, runs: new Map([['active', run]]),
    streamRenderTimer: 12, streamRenderBubble: {}, currentAssistantBubble: {},
    clearTimeout(id) { timerCleared = id === 12; },
  });
  vm.runInContext(fs.readFileSync(path.join(renderer, 'activity-stream.js'), 'utf8'), context);
  maps[0].set(host, new Map([['old-task', { elements: new Set([run.activityEl]) }]]));
  vm.runInContext(between(source, 'function clearConversationMessages()', '// 渲染流式中的气泡:'), context);
  context.clearConversationMessages();
  assert.equal(maps[0].has(host), false, 'permanent transcript host no longer retains detached groups');
  assert.equal(clears, 1); assert.equal(timerCleared, true);
  assert.equal(context.runs.get('active'), run);
  assert.equal(run.activityState, state);
  assert.equal(run.turn, turn); assert.equal(turn.assistant, 'retained answer');
  for (const key of ['activityEl', 'outputBubble', 'errorEl', 'supplementTimeline']) assert.equal(run[key], null, key);
  assert.equal(turn.activityEl, null);
  assert.equal(context.currentAssistantBubble, null);
});

function terminalHarness() {
  const scripts = [], window = {};
  const context = vm.createContext({ window, document: {
    createElement: () => ({ remove() { this.removed = true; } }),
    head: { appendChild(node) { scripts.push(node); } },
  } });
  vm.runInContext(between(panelSource, 'let terminalComponentsPromise = null;', 'async function startTerminalSession('), context);
  const complete = async script => {
    if (script.src.endsWith('/xterm.js')) window.Terminal = function Terminal() {};
    else window.FitAddon = { FitAddon: function FitAddon() {} };
    script.onload(); await flush();
  };
  return { context, scripts, window, complete };
}

test('terminal libraries load only on demand, once for simultaneous tabs, in dependency order', async () => {
  const h = terminalHarness();
  assert.equal(h.scripts.length, 0);
  const first = h.context.ensureTerminalComponents(), second = h.context.ensureTerminalComponents();
  assert.equal(first, second);
  assert.equal(h.scripts.length, 1); assert.equal(h.scripts[0].src, 'vendor/xterm.js');
  await h.complete(h.scripts[0]);
  assert.equal(h.scripts.length, 2); assert.equal(h.scripts[1].src, 'vendor/xterm-addon-fit.js');
  await h.complete(h.scripts[1]); await Promise.all([first, second]);
  await h.context.ensureTerminalComponents();
  assert.equal(h.scripts.length, 2);
  assert.ok(h.scripts.every(script => script.removed));
});

test('terminal library failure is retryable and already loaded dependencies are retained', async () => {
  const h = terminalHarness();
  const first = h.context.ensureTerminalComponents();
  const rejected = assert.rejects(first, /终端组件/);
  await h.complete(h.scripts[0]);
  h.scripts[1].onerror(); await rejected;
  assert.equal(h.scripts[1].removed, true);
  const retry = h.context.ensureTerminalComponents(); await flush();
  assert.equal(h.scripts.length, 3);
  assert.equal(h.scripts[2].src, 'vendor/xterm-addon-fit.js');
  await h.complete(h.scripts[2]); await retry;
});

test('closing a terminal while its components load never starts a background process', async () => {
  let resolveComponents, starts = 0;
  const components = new Promise(resolve => { resolveComponents = resolve; });
  const target = { kind: 'terminal', terminalContext: { conversationId: 'draft' } };
  const context = vm.createContext({
    disposed: false, tabs: [target], pendingTerminals: new Set(), earlyEvents: new Map(),
    renderTerminals() {}, ensureTerminalComponents: () => components,
    bridge: { terminalStart() { starts++; throw Error('must not start closed tab'); } },
  });
  vm.runInContext(between(panelSource, 'async function startTerminalSession(', 'async function closeTerminal('), context);
  const opening = context.startTerminalSession(target);
  context.tabs.length = 0;
  resolveComponents(); await opening;
  assert.equal(starts, 0);
  assert.equal(context.pendingTerminals.size, 0);
  assert.equal(target.terminalLaunch, null);
});
