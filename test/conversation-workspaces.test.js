'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConversationWorkspaces, conversationContext } = require('../conversation-workspaces');
const ID = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspaces-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const conversations = new Map(), writes = [];
  const registryPath = path.join(home, 'app-data', 'conversation-workspaces.json');
  const options = { homeDir: home, registryPath,
    loadConversation: (id) => conversations.get(id) || null,
    persistConversationRecord: (conv) => { writes.push(conv); conversations.set(conv.id, conv); },
    getAgentProjectRoot: () => path.join(home, 'agent-install'),
  };
  return { home, registryPath, conversations, writes, options, service: createConversationWorkspaces(options) };
}

test('draft, execution and restarted resolver use one stable per-conversation default directory', (t) => {
  const f = fixture(t);
  const draft = f.service.resolveWorkspace({ conversationId: ID });
  fs.writeFileSync(path.join(draft.root, 'process.txt'), 'synthetic process file');
  f.conversations.set(ID, { id: ID, turns: [{ user: 'synthetic' }] });
  const run = f.service.resolveWorkspace({ conversationId: ID, workingDir: null });
  const resumed = createConversationWorkspaces(f.options).resolveWorkspace({ conversationId: ID });
  assert.equal(draft.root, path.join(f.home, 'RelayProjects', ID));
  assert.equal(run.root, draft.root); assert.equal(resumed.root, draft.root);
  assert.equal(run.validWorkingDir, draft.root); assert.equal(run.managed, true);
  assert.equal(fs.readFileSync(path.join(resumed.root, 'process.txt'), 'utf8'), 'synthetic process file');
  assert.notEqual(f.service.resolveWorkspace({ conversationId: OTHER }).root, draft.root);
});

test('changing the default archive root affects new conversations only, including after restart and history cwd saves', t => {
  const f = fixture(t), first = path.join(f.home, 'first-root'), second = path.join(f.home, 'second-root');
  let root = first;
  const options = { ...f.options, getBaseDir: () => root };
  const service = createConversationWorkspaces(options);
  const original = service.resolveWorkspace({ conversationId: ID });
  fs.writeFileSync(path.join(original.cwd, 'delivery.txt'), 'keep original location');
  f.conversations.set(ID, { id: ID, sessionId: 'working-session', workingDir: original.cwd, title: 'pinned history', pinned: true, updatedAt: 'old-date' });
  service.resolveWorkspace({ conversationId: ID, workingDir: original.cwd });
  root = second;
  const reopened = createConversationWorkspaces(options).resolveWorkspace({ conversationId: ID, workingDir: null });
  assert.equal(reopened.cwd, original.cwd); assert.equal(reopened.sessionInvalidated, false);
  assert.equal(fs.readFileSync(path.join(reopened.cwd, 'delivery.txt'), 'utf8'), 'keep original location');
  assert.equal(service.resolveWorkspace({ conversationId: OTHER }).cwd, path.join(second, OTHER));
  assert.equal(service.base, second); assert.equal(f.writes.length, 0);
  assert.equal(f.conversations.get(ID).updatedAt, 'old-date');
});

test('project removal uses current archive root and does not retain a previous explicit project directory', t => {
  const f = fixture(t), project = path.join(f.home, 'project'), root = path.join(f.home, 'new-root'); fs.mkdirSync(project);
  const service = createConversationWorkspaces({ ...f.options, getBaseDir: () => root });
  service.resolveWorkspace({ conversationId: ID, workingDir: project });
  assert.equal(service.resolveWorkspace({ conversationId: ID, workingDir: null }).cwd, path.join(root, ID));
});

test('explicit directories stay effective and invalid explicit paths fail without falling back', (t) => {
  const f = fixture(t), explicit = path.join(f.home, 'chosen'); fs.mkdirSync(explicit);
  const workspace = f.service.resolveWorkspace({ conversationId: ID, workingDir: explicit });
  assert.equal(workspace.root, explicit); assert.equal(workspace.managed, false);
  assert.throws(() => f.service.resolveWorkspace({ conversationId: ID, workingDir: path.join(f.home, 'missing') }), /不存在/);
  assert.throws(() => f.service.resolveWorkspace({ conversationId: ID, workingDir: 'relative' }), /绝对路径/);
  const file = path.join(f.home, 'file.txt'); fs.writeFileSync(file, 'x');
  assert.throws(() => f.service.resolveWorkspace({ conversationId: ID, workingDir: file }), /不是文件夹/);
});

test('installed Agent resources remain authorized while its default outputs go to the conversation archive', (t) => {
  const f = fixture(t), project = path.join(f.home, 'agent-install'); fs.mkdirSync(project);
  const workspace = f.service.resolveWorkspace({ conversationId: ID, mode: 'agent', agentName: 'writer' });
  assert.equal(workspace.agentProjectRoot, project);
  assert.equal(workspace.cwd, path.join(f.home, 'RelayProjects', ID));
  assert.equal(workspace.validWorkingDir, workspace.cwd);
  assert.notEqual(workspace.cwd, project);
});

test('home-session migration clears only runtime metadata and leaves original files, title, history and updatedAt untouched', (t) => {
  const f = fixture(t);
  const original = { id: ID, sessionId: 'old-home-session', updatedAt: '2020-01-01', title: 'historic title', pinned: true,
    turns: [{ user: 'old question', assistant: 'old answer' }] };
  f.conversations.set(ID, original);
  fs.writeFileSync(path.join(f.home, 'old.txt'), 'do not move');
  const migrated = f.service.resolveWorkspace({ conversationId: ID });
  assert.equal(migrated.sessionInvalidated, true); assert.equal(migrated.needsContext, true);
  assert.deepEqual(f.writes[0], { ...original, sessionId: null, carryContextOnNextTurn: 'workspace' });
  assert.equal(original.sessionId, 'old-home-session', 'input history object is not mutated');
  assert.equal(fs.readFileSync(path.join(f.home, 'old.txt'), 'utf8'), 'do not move');
  assert.equal(fs.existsSync(path.join(migrated.root, 'old.txt')), false);
  assert.equal(f.service.acceptsSession(ID, 'old-home-session'), false);
  assert.equal(f.service.acceptsSession(ID, 'new-session'), true);
  const restart = createConversationWorkspaces(f.options);
  assert.equal(restart.acceptsSession(ID, 'old-home-session'), false);
  // A late renderer save cannot re-authorize the old runtime handle.
  f.conversations.set(ID, original);
  assert.equal(restart.resolveWorkspace({ conversationId: ID }).sessionInvalidated, true);
  assert.equal(f.writes.at(-1).updatedAt, original.updatedAt);
});

test('existing explicit cwd retains its session; changing to the default invalidates it', (t) => {
  const f = fixture(t), chosen = path.join(f.home, 'chosen'); fs.mkdirSync(chosen);
  f.conversations.set(ID, { id: ID, sessionId: 'explicit-session', workingDir: { path: chosen }, turns: [{ assistant: 'history' }] });
  const current = f.service.resolveWorkspace({ conversationId: ID });
  assert.equal(current.cwd, chosen); assert.equal(current.sessionInvalidated, false); assert.equal(f.writes.length, 0);
  const changed = f.service.resolveWorkspace({ conversationId: ID, workingDir: null });
  assert.equal(changed.managed, true); assert.equal(changed.sessionInvalidated, true);
});

test('legacy Agent installation cwd cannot be resumed in its new output archive', (t) => {
  const f = fixture(t); fs.mkdirSync(path.join(f.home, 'agent-install'));
  f.conversations.set(ID, { id: ID, mode: 'agent', agent: 'writer', sessionId: 'agent-session', turns: [{ assistant: 'history' }] });
  const resolved = f.service.resolveWorkspace({ conversationId: ID, mode: 'agent', agentName: 'writer' });
  assert.equal(resolved.previousCwd, path.join(f.home, 'agent-install'));
  assert.equal(resolved.sessionInvalidated, true);
});

test('missing/traversal identities are rejected, and Windows reserved legacy IDs get safe distinct names', (t) => {
  const f = fixture(t);
  for (const id of [undefined, '', '../escape', 'a/b', 'a\\b', 'a\0b']) assert.throws(() => f.service.resolveWorkspace({ conversationId: id }), /对话标识/);
  const roots = ['CON', 'con', 'legacy'].map((conversationId) => f.service.resolveWorkspace({ conversationId }).root);
  assert.equal(new Set(roots).size, 3);
  for (const root of roots) assert.match(path.basename(root), /^conversation-[a-f0-9]{32}$/);
});

test('a default directory junction pointing outside RelayProjects is rejected', (t) => {
  const f = fixture(t), base = path.join(f.home, 'RelayProjects'), outside = path.join(f.home, 'outside');
  fs.mkdirSync(base); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(base, ID), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.service.resolveWorkspace({ conversationId: ID }), /不能链接/);
});

test('corrupted workspace registry fails consistently instead of silently forgetting rejected sessions', (t) => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.registryPath)); fs.writeFileSync(f.registryPath, '{broken');
  assert.throws(() => f.service.resolveWorkspace({ conversationId: ID }));
  assert.throws(() => f.service.resolveWorkspace({ conversationId: ID }));
});

test('migration context preserves history, omits the active placeholder, and is bounded', () => {
  const conv = { turns: [{ user: 'earlier', assistant: 'exact\nanswer' }, { user: 'new input', assistant: '' }] };
  const before = JSON.stringify(conv);
  const context = conversationContext(conv, { turnIndex: 1 });
  assert.match(context, /用户：earlier\n助手：exact\nanswer/);
  assert.equal(context.includes('new input'), false); assert.equal(JSON.stringify(conv), before);
  const huge = conversationContext({ turns: [{ assistant: 'a'.repeat(100000) }] }, { maxChars: 500 });
  assert.ok(huge.length < 700);
});

test('busy workspace validation refuses migration before session/history metadata changes', (t) => {
  const f = fixture(t);
  f.conversations.set(ID, { id: ID, sessionId: 'running-home-session', updatedAt: 'old', turns: [{ assistant: 'old' }] });
  const service = createConversationWorkspaces({ ...f.options, validateWorkspace: () => { throw new Error('当前对话正在运行'); } });
  assert.throws(() => service.resolveWorkspace({ conversationId: ID }), /正在运行/);
  assert.equal(f.writes.length, 0);
  assert.equal(fs.existsSync(f.registryPath), false);
  assert.equal(f.conversations.get(ID).sessionId, 'running-home-session');
});

test('pending migration context survives prewarming and is consumed only after accepted execution', (t) => {
  const f = fixture(t);
  f.conversations.set(ID, { id: ID, sessionId: 'old', updatedAt: 'old-time', turns: [{ assistant: 'history' }] });
  assert.equal(f.service.resolveWorkspace({ conversationId: ID }).needsContext, true);
  assert.equal(f.service.resolveWorkspace({ conversationId: ID }).needsContext, true, 'resolving/prespawning is not a submitted prompt');
  f.service.markContextCarried(ID);
  assert.equal(f.service.resolveWorkspace({ conversationId: ID }).needsContext, false);
  assert.equal(f.conversations.get(ID).carryContextOnNextTurn, undefined);
  assert.equal(f.conversations.get(ID).updatedAt, 'old-time');
  assert.equal(f.service.acceptsSession(ID, 'old'), false, 'consuming history context cannot restore the invalid runtime handle');
});

test('workspace migration retains supplemental text and files alongside original user intent', () => {
  const text = conversationContext({ turns: [{ user: 'inspect project', assistant: 'report', supplements: [
    { text: 'focus module two', status: 'applied', files: [{ path: '/synthetic/requirements.md' }] },
    { text: 'also check limits', status: 'canceled' },
  ] }] });
  assert.match(text, /focus module two/); assert.match(text, /\/synthetic\/requirements\.md/);
  assert.match(text, /尚未处理.*also check limits/);
});

test('project rebinding rejects its old session before any workspace resolve and survives restart', t => {
  const f = fixture(t), old = path.join(f.home, 'offline-old-project');
  const original = { id: ID, workingDir: { path: old }, sessionId: 'previous-project-session', updatedAt: 'original-time', turns: [{ user: 'request', assistant: 'answer' }] };
  f.conversations.set(ID, original);
  assert.equal(f.service.invalidateConversationSession(ID, original.sessionId), true);
  assert.equal(f.service.acceptsSession(ID, original.sessionId), false);
  assert.equal(f.writes.length, 0);assert.equal(fs.existsSync(old), false);assert.equal(fs.existsSync(path.join(f.home, 'RelayProjects')), false);
  assert.equal(f.conversations.get(ID), original);
  const fresh = createConversationWorkspaces(f.options);assert.equal(fresh.acceptsSession(ID, original.sessionId), false);
  const next = path.join(f.home, 'new-project');fs.mkdirSync(next);
  f.conversations.set(ID, { ...original, workingDir: { path: next } });
  const resolved = fresh.resolveWorkspace({ conversationId: ID, workingDir: next });
  assert.equal(resolved.sessionInvalidated, true);assert.equal(resolved.needsContext, true);
  assert.equal(f.conversations.get(ID).sessionId, null);assert.equal(f.conversations.get(ID).updatedAt, 'original-time');
});
test('project session invalidation is idempotent and retains the existing directory registry', t => {
  const f = fixture(t), resolved = f.service.resolveWorkspace({ conversationId: ID });
  assert.equal(f.service.invalidateConversationSession(ID, 'old-session'), true);
  const saved = fs.readFileSync(f.registryPath, 'utf8');
  assert.equal(f.service.invalidateConversationSession(ID, 'old-session'), false);
  assert.equal(fs.readFileSync(f.registryPath, 'utf8'), saved);
  assert.equal(JSON.parse(saved).items[ID].cwd, resolved.cwd);
  assert.equal(f.service.acceptsSession(ID, 'new-session'), true);
  assert.equal(f.service.invalidateConversationSession(ID, null), false);
  assert.throws(() => f.service.invalidateConversationSession('../invalid', 'session'));
});
test('failed project invalidation write rolls back the in-memory session rejection', t => {
  const f = fixture(t);f.service.invalidateConversationSession(ID, 'first');
  const saved = fs.readFileSync(f.registryPath, 'utf8');fs.mkdirSync(f.registryPath + '.tmp');
  assert.throws(() => f.service.invalidateConversationSession(ID, 'second'));
  assert.equal(f.service.acceptsSession(ID, 'first'), false);assert.equal(f.service.acceptsSession(ID, 'second'), true);
  assert.equal(fs.readFileSync(f.registryPath, 'utf8'), saved);
});
test('rebinding a conversation with no session still durably carries its existing history', t => {
  const f = fixture(t), next = path.join(f.home, 'next-project');fs.mkdirSync(next);
  f.conversations.set(ID, { id: ID, sessionId: null, updatedAt: 'original', workingDir: next, turns: [{ user: 'old request', assistant: 'old answer' }] });
  assert.equal(f.service.invalidateConversationSession(ID, null), true);
  assert.equal(f.writes.length, 0);
  const resumed = createConversationWorkspaces(f.options).resolveWorkspace({ conversationId: ID, workingDir: next });
  assert.equal(resumed.needsContext, true);assert.equal(resumed.workspaceChanged, false);
  assert.equal(f.service.acceptsSession(ID, 'future-session'), true);
});


test('each conversation keeps an independent scratch across project changes, default root changes and restart', t => {
  const f = fixture(t), project = path.join(f.home, 'project'), otherProject = path.join(f.home, 'other-project');
  fs.mkdirSync(project); fs.mkdirSync(otherProject);
  const a = f.service.resolveWorkspace({ conversationId: ID, workingDir: project });
  const b = f.service.resolveWorkspace({ conversationId: OTHER, workingDir: project });
  assert.equal(a.cwd, project); assert.equal(b.cwd, project); assert.notEqual(a.scratchDir, b.scratchDir);
  assert.equal(a.scratchDir, path.join(path.dirname(f.registryPath), 'conversation-scratch', ID));
  fs.writeFileSync(path.join(a.scratchDir, 'intermediate.txt'), 'synthetic intermediate');
  fs.writeFileSync(path.join(project, 'delivery.txt'), 'synthetic delivery');
  const reopened = createConversationWorkspaces({ ...f.options, getBaseDir: () => otherProject });
  const changed = reopened.resolveWorkspace({ conversationId: ID, workingDir: otherProject });
  assert.equal(changed.cwd, otherProject); assert.equal(changed.scratchDir, a.scratchDir);
  assert.equal(reopened.resolveScratch(ID), a.scratchDir);
  assert.equal(fs.readFileSync(path.join(a.scratchDir, 'intermediate.txt'), 'utf8'), 'synthetic intermediate');
  assert.equal(fs.readFileSync(path.join(project, 'delivery.txt'), 'utf8'), 'synthetic delivery');
  assert.equal(f.writes.length, 0, 'scratch allocation does not rewrite user history');
});
test('scratch rejects invalid IDs and junctions escaping the owned data directory', t => {
  const f = fixture(t), base = path.join(path.dirname(f.registryPath), 'conversation-scratch');
  for (const id of ['../escape', '', 'a/b']) assert.throws(() => f.service.resolveScratch(id), /对话标识/);
  fs.mkdirSync(base, { recursive: true }); const outside = path.join(f.home, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(base, ID), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.service.resolveScratch(ID), /不能链接/);
  fs.rmSync(path.join(base, ID)); fs.rmdirSync(base);
  fs.symlinkSync(outside, base, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.service.resolveScratch(ID), /不能链接/);
  assert.equal(fs.existsSync(path.join(outside, ID)), false, 'check base before creating session children');
});


test('native tool process uses session scratch by default while its cwd remains the project', t => {
  const f = fixture(t), project = path.join(f.home, 'project'); fs.mkdirSync(project);
  const resolved = f.service.resolveWorkspace({ conversationId: ID, workingDir: project });
  const options = require('../claude-sdk')._buildOptions({ cwd: resolved.cwd, scratchDir: resolved.scratchDir });
  // A harmless Node subprocess substitutes for a tool, with no SDK/network call.
  const source = "const fs=require('fs'),os=require('os'),path=require('path'); const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-')); fs.writeFileSync(path.join(temp,'sample.txt'),'synthetic'); console.log(JSON.stringify({cwd:process.cwd(),temp}));";
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', source], { cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const info = JSON.parse(child.stdout);
  assert.equal(info.cwd, project);
  assert.equal(path.dirname(info.temp), resolved.scratchDir);
  assert.equal(fs.readFileSync(path.join(info.temp, 'sample.txt'), 'utf8'), 'synthetic');
});

test('scratch cannot alias a sibling conversation even when both remain under the managed base', t => {
  const f = fixture(t), other = f.service.resolveScratch(OTHER);
  const target = path.join(path.dirname(other), ID);
  fs.symlinkSync(other, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.service.resolveScratch(ID), /其他会话/);
});
