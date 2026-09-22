'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createConversationWorkspaces } = require('../src/main/projects/conversation-workspaces');
const schedulerPath = require.resolve('../src/main/scheduling/scheduler');
const route = { providerId: 'synthetic', providerRevision: 1, routeTier: 'haiku' };
function fixture(t, { command = false, agent = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scheduled-workspaces-'));
  const conversations = new Map(), launches = [], paths = [];
  let completion, fail = false;
  const service = createConversationWorkspaces({ homeDir: home, registryPath: path.join(home, 'workspaces.json'),
    loadConversation: (id) => conversations.get(id) || null,
    persistConversationRecord: (conv) => conversations.set(conv.id, conv),
    getAgentProjectRoot: () => path.join(home, 'installed-agent'),
  });
  const cp = require('node:child_process'), originalSpawn = cp.spawn;
  if (command) cp.spawn = (_command, _args, options) => {
    paths.push(options.cwd);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => child.emit('close', 0)); return child;
  };
  delete require.cache[schedulerPath];
  let scheduler;
  try { scheduler = require('../src/main/scheduling/scheduler'); } finally { cp.spawn = originalSpawn; }
  const agentDir = path.join(home, 'agents'); fs.mkdirSync(agentDir);
  if (agent) {
    fs.mkdirSync(path.join(home, 'installed-agent'));
    fs.writeFileSync(path.join(agentDir, 'writer.md'), '---\nname: writer\ndescription: synthetic writer\n---\n');
  }
  scheduler.init({ userDataDir: home, agentDir,
    resolveWorkspace: (options) => service.resolveWorkspace(options),
    acceptsWorkspaceSession: (id, sid) => service.acceptsSession(id, sid),
    workspaceContextCarried: (id) => service.markContextCarried(id),
    resolveChatRoute: () => route,
    loadConversation: (id) => conversations.get(id) || null,
    saveConversation: (conv) => conversations.set(conv.id, conv),
    readAppSettings: () => ({ allowCommandTasks: true, agentProjects: { writer: path.join(home, 'installed-agent') } }),
    runClaudeJob(options) {
      launches.push(options);
      fs.writeFileSync(path.join(options.cwd, 'process.txt'), 'synthetic process artifact');
      queueMicrotask(() => {
        options.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic answer' }] } });
        options.onEvent({ type: 'system', subtype: 'init', session_id: 'new-session' });
        options.onEvent({ type: 'job-done', exitCode: fail ? 1 : 0, error: fail ? 'synthetic failure' : null });
      });
      return { child: { kill() {} }, sessionRoute: route, resumeAccepted: !!options.sessionId };
    },
    getMainWindow: () => null, refreshTray() {}, notify() {}, buildMemoryHint: () => '',
    taskRunStart: () => 'synthetic-run', taskRunFinish: (_id, value) => completion(value),
  });
  t.after(() => { scheduler.shutdown(); delete require.cache[schedulerPath]; fs.rmSync(home, { recursive: true, force: true }); });
  const created = scheduler.create({ name: 'synthetic schedule', enabled: false, schedule: { kind: 'every', everyMs: 60000 },
    action: { type: command ? 'command' : 'chat', command: 'Write-Output synthetic', prompt: 'synthetic prompt', memory: 'off',
      mode: agent ? 'agent' : 'plain', agentName: agent ? 'writer' : null },
    delivery: { notify: false, saveToHistory: !command },
  });
  assert.equal(created.ok, true);
  return { home, scheduler, service, conversations, launches, paths, id: created.task.id,
    set fail(value) { fail = value; },
    async run() { const done = new Promise((resolve) => { completion = resolve; }); await scheduler.runNow(created.task.id); return done; },
  };
}

test('scheduled chat reserves the eventual history ID before execution and reuses its archive after edits', async (t) => {
  const h = fixture(t);
  assert.equal((await h.run()).ok, true);
  const first = h.launches[0], saved = h.scheduler.get(h.id);
  assert.equal(saved.workspaceConversationId, saved.lastConvId);
  assert.equal(first.conversationId, saved.lastConvId);
  assert.equal(first.cwd, path.join(h.home, 'RelayProjects', saved.lastConvId));
  assert.ok(h.conversations.has(saved.lastConvId));
  assert.equal(h.scheduler.update(h.id, { name: 'renamed schedule' }).ok, true);
  assert.equal((await h.run()).ok, true);
  assert.equal(h.launches[1].cwd, first.cwd);
  assert.equal(h.conversations.get(saved.lastConvId).turns.length, 2);
  assert.equal(fs.readFileSync(path.join(first.cwd, 'process.txt'), 'utf8'), 'synthetic process artifact');
});

test('scheduled Agent uses the archive for outputs and the original installation for resources', async (t) => {
  const h = fixture(t, { agent: true });
  assert.equal((await h.run()).ok, true);
  const launched = h.launches[0];
  assert.equal(launched.cwd, path.join(h.home, 'RelayProjects', launched.conversationId));
  assert.equal(launched.agentProjectRoot, path.join(h.home, 'installed-agent'));
  assert.match(launched.prompt, /配套资源位于/);
});

test('scheduled command uses a stable archive with an inert fake child only', async (t) => {
  const h = fixture(t, { command: true });
  assert.equal((await h.run()).ok, true); assert.equal((await h.run()).ok, true);
  assert.equal(h.paths[0], h.paths[1]);
  assert.equal(h.paths[0], path.join(h.home, 'RelayProjects', h.scheduler.get(h.id).workspaceConversationId));
});

test('deleted scheduled history gets a new archive once and failed retries retain that same directory', async (t) => {
  const h = fixture(t);
  await h.run(); const oldId = h.scheduler.get(h.id).lastConvId, oldRoot = h.launches[0].cwd;
  h.conversations.delete(oldId); h.fail = true;
  await h.run(); const retryRoot = h.launches[1].cwd;
  assert.notEqual(retryRoot, oldRoot);
  await h.run(); assert.equal(h.launches[2].cwd, retryRoot);
  assert.equal(fs.existsSync(path.join(oldRoot, 'process.txt')), true, 'old files are not moved/deleted');
});

test('changing a scheduled persistent cwd rejects its old session and includes Relay history text', async (t) => {
  const h = fixture(t);
  await h.run();
  const existing = h.scheduler.get(h.id);
  const selected = path.join(h.home, 'selected'); fs.mkdirSync(selected);
  assert.equal(h.scheduler.update(h.id, { action: { workingDir: selected, sessionMode: 'session', sessionRef: 'new-session', sessionRoute: route } }).ok, true);
  assert.equal((await h.run()).ok, true);
  const launched = h.launches[1];
  assert.equal(launched.cwd, selected); assert.equal(launched.sessionId, null);
  assert.match(launched.prompt, /synthetic answer/);
  assert.equal(h.scheduler.get(h.id).lastConvId, existing.lastConvId);
});
