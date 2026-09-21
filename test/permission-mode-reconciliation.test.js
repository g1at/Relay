'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { InteractionBroker } = require('../interaction-broker');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-permission-mode-'));
  const cwd = path.join(base, 'workspace'), additional = path.join(base, 'additional'); fs.mkdirSync(cwd); fs.mkdirSync(additional);
  const broker = new InteractionBroker({ logger: { warn() {} } }); t.after(() => { broker.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const answers = [];
  const add = (name = 'Write', input = { file_path: path.join(cwd, 'fixture.txt') }, options = {}, context = {}) => {
    let answer; const promise = broker.registerToolUse({ toolName: name, input, sdkOptions: options,
      context: { conversationId: 'a', runId: 'run-a', ...context } }).then(value => { answer = value; return value; });
    answers.push(promise); return { promise, get answer() { return answer; } };
  };
  return { base, cwd, additional, broker, add, settle: permissionMode => broker.reconcilePermissionMode({ conversationId: 'a', runId: 'run-a', permissionMode, cwd, additionalDirectories: [additional] }) };
}
test('acceptEdits resolves ordinary edits inside granted real paths, keeping MCP, Bash and other conversations pending', async t => {
  const h = fixture(t);
  const permitted = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].map(name => h.add(name, name === 'NotebookEdit' ? { notebook_path: path.join(h.additional, 'sample.ipynb') } : { file_path: 'nested/file.txt' }));
  const protectedCalls = [h.add('Bash', { command: 'fixture' }), h.add('mcp__fixture__write'), h.add('Write', undefined, {}, { conversationId: 'b' }), h.add('Write', undefined, {}, { runId: 'old-a' })];
  assert.equal(h.settle('acceptEdits'), 4); assert.equal(h.broker.size, 4);
  for (const item of permitted) assert.equal((await item.promise).behavior, 'allow');
  for (const item of protectedCalls) assert.equal(item.answer, undefined);
});
test('permission change never answers questions, plan transitions, explicit ask rules or safety requests', async t => {
  const h = fixture(t);
  h.add('AskUserQuestion', { questions: [{ header: 'Choice', multiSelect: false, question: 'choose', options: [{ label: 'one', description: '' }, { label: 'two', description: '' }] }] });
  h.add('ExitPlanMode'); h.add('EnterPlanMode'); h.add('Write', undefined, { matchedAskRule: { source: 'policySettings', toolName: 'Write' } });
  h.add('Write', undefined, { decisionReason: 'safetyCheck' });
  assert.equal(h.settle('bypassPermissions'), 0); assert.equal(h.broker.size, 5);
});
test('acceptEdits does not authorize path escapes, sensitive configuration or symlink escapes', async t => {
  const h = fixture(t);
  h.add('Write', { file_path: path.join(h.base, 'outside.txt') }); h.add('Write', { file_path: '../outside.txt' });
  h.add('Write', { file_path: path.join(h.cwd, '.claude', 'settings.json') }); h.add('Write', { file_path: path.join(h.cwd, '.git', 'config') });
  fs.symlinkSync(h.additional, path.join(h.cwd, 'allowed-link'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(h.base, path.join(h.cwd, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  h.add('Write', { file_path: path.join(h.cwd, 'outside-link', 'escape.txt') });
  const allowed = h.add('Write', { file_path: path.join(h.cwd, 'allowed-link', 'allowed.txt') });
  assert.equal(h.settle('acceptEdits'), 1); assert.equal((await allowed.promise).behavior, 'allow'); assert.equal(h.broker.size, 5);
});
test('fully approved mode releases normal waiting MCP/Bash once; default and plan keep all prompts', async t => {
  const h = fixture(t);
  const mcp = h.add('mcp__fixture__write'), bash = h.add('Bash', { command: 'fixture' });
  assert.equal(h.settle('default'), 0); assert.equal(h.settle('plan'), 0);
  assert.equal(h.settle('bypassPermissions'), 2); assert.equal(h.settle('bypassPermissions'), 0);
  for (const item of [mcp, bash]) { const result = await item.promise; assert.equal(result.behavior, 'allow'); assert.equal(Object.hasOwn(result, 'updatedPermissions'), false); }
});
test('canceled requests and invalid context never get resurrected or cross-approved', async t => {
  const h = fixture(t), abort = new AbortController(); const item = h.add('Write', undefined, { signal: abort.signal }); abort.abort();
  assert.equal((await item.promise).behavior, 'deny'); assert.equal(h.settle('bypassPermissions'), 0);
  h.add('Write'); assert.equal(h.broker.reconcilePermissionMode({ permissionMode: 'bypassPermissions', conversationId: 'a' }), 0);
});

test('a late old callback sees committed same-run mode without flashing a pending card; special prompts remain', async t => {
  const h = fixture(t); let current = null; const events = []; h.broker.onChange = event => events.push(event);
  const canUseTool = h.broker.createCanUseTool(() => ({conversationId:'a',runId:'run-a',permissionReconciliation:current}));
  current = {conversationId:'a',runId:'run-a',revision:2,permissionMode:'bypassPermissions',cwd:h.cwd};
  const answer = await canUseTool('Bash', {command:'fixture'}, {});
  assert.equal(answer.behavior, 'allow'); assert.equal(h.broker.size, 0);
  assert.deepEqual(events.map(e => e.type), ['interaction.resolved']);
  const special = canUseTool('Bash', {command:'fixture'}, {decisionReason:'safetyCheck'});
  assert.equal(h.broker.size, 1); h.broker.close(); assert.equal((await special).behavior, 'deny');
});
test('transition gates and run boundaries prevent stale broader-mode callbacks from auto-approving', async t => {
  const h = fixture(t); let current = null;
  const canUseTool = h.broker.createCanUseTool(() => ({conversationId:'a',runId:'run-a',permissionReconciliation:current}));
  const during = canUseTool('Bash', {command:'fixture'}, {}); assert.equal(h.broker.size, 1);
  current = {conversationId:'a',runId:'older-run',revision:2,permissionMode:'bypassPermissions',cwd:h.cwd};
  const next = canUseTool('Bash', {command:'fixture'}, {}); assert.equal(h.broker.size, 2);
  current = {conversationId:'a',runId:'run-a',revision:3,permissionMode:'default',cwd:h.cwd};
  const narrowed = canUseTool('Bash', {command:'fixture'}, {}); assert.equal(h.broker.size, 3);
  h.broker.close(); for (const answer of await Promise.all([during,next,narrowed])) assert.equal(answer.behavior, 'deny');
});

test('full access releases ordinary parked path prompts; edit mode keeps out-of-scope paths pending', async t => {
  const h = fixture(t);
  const bash = h.add('Bash', { command: 'printf fixture > file.txt' }, { blockedPath: path.join(h.cwd, 'file.txt') });
  const outside = h.add('Write', undefined, { blockedPath: path.join(h.base, 'other.txt') });
  const edit = h.add('Write', undefined, { blockedPath: path.join(h.cwd, 'fixture.txt') });
  assert.equal(h.settle('acceptEdits'), 1); assert.equal((await edit.promise).behavior, 'allow');
  assert.equal(h.broker.size, 2);
  assert.equal(h.settle('bypassPermissions'), 2);
  for (const item of [bash, outside]) assert.equal((await item.promise).behavior, 'allow');
});
