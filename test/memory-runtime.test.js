'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MemoryStore } = require('../src/main/memory/memory-store');
const { createMemoryRuntime, MEMORY_CONSOLIDATION_PROMPT } = require('../src/main/memory/memory-runtime');
const { serializeMemoryFrontmatter } = require('../src/main/memory/memory-schema');
function setup(t, initial = {}, runtimeOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-runtime-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const store = new MemoryStore({ dir }); let context = { mode: 'full', projectId: 'a', sourceRef: 'conversation:a/run:1', cwd: dir, ...initial };
  const reads = [], changes = [], core = new Set();
  const runtime = createMemoryRuntime({ store, context: () => context, onRead: file => reads.push(file), onChanged: item => changes.push(item), isCore: file => core.has(file), ...runtimeOptions });
  return { store, runtime, reads, changes, core, setContext: next => { context = { ...context, ...next }; } };
}
const doc = (meta, body = 'known fact') => serializeMemoryFrontmatter(meta) + '\n' + body;
test('model tool schema requires an explicit supported type and revision and returns failures as tool errors', async t => {
  const { runtime } = setup(t), tools = [];
  const servers = runtime.factory({ tool: (name, description, schema, handler) => { const tool = { name, schema, handler }; tools.push(tool); return tool; }, createSdkMcpServer: value => value });
  assert.equal(servers['relay-memory'].name, 'relay-memory');
  assert.deepEqual(tools.map(tool => tool.name), ['list', 'read', 'propose']);
  const propose = tools.find(tool => tool.name === 'propose');
  const list = tools.find(tool => tool.name === 'list');
  assert.equal(list.schema.offset.safeParse(0).success, true);
  assert.equal(list.schema.offset.safeParse(-1).success, false);
  assert.equal(list.schema.offset.safeParse(1.5).success, false);
  assert.equal(propose.schema.expectedRevision.safeParse(undefined).success, false);
  assert.equal(propose.schema.expectedRevision.safeParse(null).success, true);
  assert.equal(propose.schema.expectedRevision.safeParse('null').success, true);
  assert.equal(propose.schema.expectedRevision.safeParse(42).success, false);
  assert.equal(propose.schema.type.safeParse(undefined).success, false);
  assert.equal(propose.schema.type.safeParse('unsupported').success, false);
  for (const type of ['user', 'feedback', 'project', 'reference']) assert.equal(propose.schema.type.safeParse(type).success, true);
  assert.equal((await propose.handler({ file: 'new.md', content: 'new fact' })).isError, true);
  assert.equal((await propose.handler({ file: 'new.md', content: 'new fact', expectedRevision: null })).isError, true);
  assert.equal((await propose.handler({ type: 'reference', file: 'new.md', content: 'new fact', expectedRevision: null })).isError, undefined);
});

test('direct runtime calls enforce type before writing and persist the selected type independently of file names', t => {
  const { store, runtime, changes } = setup(t);
  for (const type of [undefined, null, '', 'unknown', ['feedback']]) {
    assert.throws(() => runtime.propose({ file: 'new.md', content: 'A fact.', expectedRevision: null, type }), /type/);
  }
  assert.deepEqual(store.list(), []);
  assert.deepEqual(changes, []);
  const saved = runtime.propose({ file: 'reference-misleading.md', content: 'Verify the result before reporting completion.', expectedRevision: null, type: 'feedback' });
  assert.equal(saved.meta.type, 'feedback');
  assert.match(saved.content, /^type: feedback$/m);
  assert.equal(changes.length, 1);
  assert.throws(() => runtime.propose({ file: 'conflict.md', content: doc({ type: 'project' }), expectedRevision: null, type: 'user' }), /不一致/);
  assert.equal(changes.length, 1);
});

test('exact string-null creates a candidate without changing caller input and cannot overwrite existing memory', t => {
  const { store, runtime, changes } = setup(t);
  const input = Object.freeze({ file: 'string-null.md', content: 'A new fact.', type: 'feedback', expectedRevision: 'null' });
  const created = runtime.propose(input);
  assert.equal(created.file, input.file);
  assert.equal(created.meta.status, 'draft');
  assert.equal(created.meta.type, 'feedback');
  assert.equal(input.expectedRevision, 'null');
  assert.equal(changes.length, 1);
  const active = store.write('active.md', 'A confirmed fact.');
  for (const previous of [created, active]) {
    for (const expectedRevision of [null, 'null']) {
      assert.throws(() => runtime.propose({ ...input, file: previous.file, content: 'A colliding fact.', expectedRevision }),
        error => error.code === 'MEMORY_CONFLICT' && error.actualRevision === previous.revision);
      assert.equal(store.read(previous.file).revision, previous.revision);
      assert.equal(store.read(previous.file).content, previous.content);
    }
  }
  assert.equal(changes.length, 1);
  assert.deepEqual(store.list().map(entry => entry.file).sort(), ['active.md', 'string-null.md']);
});

test('missing and malformed revisions are rejected before persistence without broad sentinel coercion', t => {
  const { store, runtime, changes } = setup(t);
  const originalWrite = store.write.bind(store);
  let writes = 0;
  store.write = (...args) => { writes++; return originalWrite(...args); };
  const input = { file: 'new.md', content: 'A new fact.', type: 'feedback' };
  assert.throws(() => runtime.propose(input), error => error.code === 'MEMORY_REVISION_REQUIRED');
  for (const expectedRevision of ['', ' null', 'null ', 'null\n', 'Null', 'NULL', '"null"', 'undefined',
    'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 0, false, {}, []]) {
    assert.throws(() => runtime.propose({ ...input, expectedRevision }),
      error => error.code === 'MEMORY_INVALID_REVISION', JSON.stringify(expectedRevision));
  }
  assert.equal(writes, 0);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(changes, []);
});

test('memory diagnostics distinguish revision inputs and redact memory text and arbitrary revision strings', t => {
  const records = [];
  const capture = text => records.push(JSON.parse(text.slice('[memory:tool] '.length)));
  const { runtime } = setup(t, { conversationId: 'conversation-a', runId: 'run-a',
    sources: [{ kind: 'conversation', conversationId: 'conversation-a', turnIndex: 0, role: 'user',
      quote: 'private source quote', at: '2026-11-11T00:00:00.000Z', revision: 'a'.repeat(64) }] },
  { logger: { info: capture, warn: capture } });
  const content = 'Private memory text that must stay out of diagnostics.';
  const created = runtime.propose({ file: 'new.md', content, type: 'feedback', expectedRevision: null });
  assert.equal(created.meta.status, 'draft');
  assert.equal(records.at(-1).expectedRevisionKind, 'null');
  assert.equal(records.at(-1).status, 'draft');
  assert.equal(records.at(-1).file, 'new.md');
  assert.equal(records.at(-1).conversationId, 'conversation-a');
  assert.equal(records.at(-1).runId, 'run-a');
  assert.equal(records.at(-1).sourceRef, 'conversation:a/run:1');
  assert.equal(records.at(-1).phase, 'result');
  assert.ok(records.at(-1).elapsedMs >= 0);
  assert.equal(records.at(-1).revisionCompatibility, undefined);
  runtime.propose({ file: 'compatible.md', content, type: 'feedback', expectedRevision: 'null' });
  assert.equal(records.at(-1).expectedRevisionKind, 'string-null');
  assert.equal(records.at(-1).normalizedExpectedRevisionKind, 'null');
  assert.equal(records.at(-1).revisionCompatibility, 'string-null');
  assert.equal(records.at(-1).status, 'draft');
  for (const [revision, kind, code] of [[null, 'null', 'MEMORY_CONFLICT'], ['null', 'string-null', 'MEMORY_CONFLICT'],
    ['', 'empty-string', 'MEMORY_INVALID_REVISION'], [undefined, 'missing', 'MEMORY_REVISION_REQUIRED'],
    ['private-token-value', 'string', 'MEMORY_INVALID_REVISION']]) {
    assert.throws(() => runtime.propose({ file: 'new.md', content, type: 'feedback', expectedRevision: revision }));
    assert.equal(records.at(-1).expectedRevisionKind, kind);
    assert.equal(records.at(-1).expectedRevision, null);
    assert.equal(records.at(-1).code, code);
    assert.equal(records.at(-1).normalizedExpectedRevisionKind, revision === 'null' ? 'null' : undefined);
    assert.equal(records.at(-1).revisionCompatibility, revision === 'null' ? 'string-null' : undefined);
  }
  assert.throws(() => runtime.read({ file: 'missing.md' }));
  assert.equal(records.at(-1).operation, 'read');
  assert.equal(records.at(-1).code, 'MEMORY_NOT_FOUND');
  const serialized = JSON.stringify(records);
  for (const secret of [content, 'private source quote', 'private-token-value']) assert.equal(serialized.includes(secret), false);
  assert.ok(records.every(record => !Object.hasOwn(record, 'content') && !Object.hasOwn(record, 'sources')));
});

test('memory diagnostics cannot fail successful operations or replace their original errors', t => {
  const logger = { info() { throw new Error('logger unavailable'); }, warn() { throw new Error('logger unavailable'); } };
  const { runtime } = setup(t, { userConfirmed: true }, { logger });
  const saved = runtime.propose({ file: 'logged.md', content: 'A confirmed fact.', type: 'reference', expectedRevision: 'null' });
  assert.equal(runtime.read({ file: saved.file }).revision, saved.revision);
  assert.throws(() => runtime.propose({ file: saved.file, content: 'Stale write.', type: 'reference', expectedRevision: null }),
    error => error.code === 'MEMORY_CONFLICT');
});

test('tool errors expose supported recovery hints without exposing diagnostic-only fields', async t => {
  const { runtime, store } = setup(t);
  const tools = [];
  runtime.factory({ tool: (name, description, schema, handler) => { const tool = { name, handler }; tools.push(tool); return tool; },
    createSdkMcpServer: value => value });
  const error = Object.assign(new Error('Use the active replacement.'), { code: 'MEMORY_SUPERSEDED',
    file: 'old.md', replacementFiles: ['current.md'], targetExists: true, actualRevision: 'hidden-revision', content: 'private memory' });
  store.read = () => { throw error; };
  const result = await tools.find(tool => tool.name === 'read').handler({ file: 'old.md' });
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), { code: 'MEMORY_SUPERSEDED', message: error.message,
    file: 'old.md', replacementFiles: ['current.md'] });
  error.code = 'MEMORY_CONFLICT';
  const conflict = await tools.find(tool => tool.name === 'read').handler({ file: 'old.md' });
  assert.deepEqual(JSON.parse(conflict.content[0].text), { code: 'MEMORY_CONFLICT', message: error.message });
});
test('runtime reads and queries filter other projects and unconfirmed candidates, and record actual reads', t => {
  const { store, runtime, reads, setContext } = setup(t);
  store.write('global.md', 'global fact');
  store.write('a.md', doc({ scope: 'project', projectId: 'a', name: 'current Alpha' }));
  store.write('b.md', doc({ scope: 'project', projectId: 'b', name: 'secret Beta' }));
  store.write('draft.md', doc({ status: 'draft' }));
  assert.deepEqual(runtime.list().map(x => x.file).sort(), ['a.md', 'global.md']);
  assert.deepEqual(runtime.list({ query: 'Alpha' }).map(x => x.file), ['a.md']);
  assert.throws(() => runtime.read({ file: 'b.md' }), /不可访问/);
  assert.throws(() => runtime.read({ file: 'draft.md' }), /不可访问/);
  assert.throws(() => runtime.read({ file: 'MEMORY.md' }));
  assert.equal(runtime.read({ file: 'a.md' }).file, 'a.md');
  assert.deepEqual(reads, ['a.md']);
  setContext({ projectId: 'b' });
  assert.deepEqual(runtime.list().map(x => x.file).sort(), ['b.md', 'global.md']);
});
test('host alone controls confirmation and source; candidates cannot forge global or core status', t => {
  const { runtime, setContext } = setup(t);
  const saved = runtime.propose({ type: 'reference', file: 'new.md', expectedRevision: null, content: doc({ status: 'active', confidence: 'user_confirmed', scope: 'global', core: true, sourceRef: 'fake' }), userConfirmed: true });
  assert.equal(saved.meta.status, 'draft');
  assert.equal(saved.meta.core, false);
  assert.equal(saved.meta.projectId, 'a');
  assert.equal(saved.meta.sourceRef, 'conversation:a/run:1');
  setContext({ userConfirmed: true });
  assert.equal(runtime.propose({ type: 'reference', file: 'remember.md', content: 'requested fact', expectedRevision: null }).meta.status, 'active');
});
test('list searches body content and exposes stable offset pagination while full reads remain explicit', t => {
  const { store, runtime, reads } = setup(t);
  for (const file of ['one.md', 'two.md', 'three.md']) store.write(file, doc({ name: '普通标题' }, 'reportneedle 的项目列必须存在。'));
  const all = runtime.list({ query: 'reportneedle' });
  assert.equal(all.length, 3);
  assert.deepEqual(runtime.list({ query: 'reportneedle', limit: 1, offset: 1 }), all.slice(1, 2));
  assert.equal(runtime.list({ offset: 3 }).length, 0);
  assert.ok(all.every(entry => !Object.hasOwn(entry, 'content') && entry.snippet.includes('项目列')));
  assert.deepEqual(reads, [], 'indexing bodies is not a model read or usefulness signal');
});
test('read mode, plan, disabled memory and changed live context enforce the same mutation boundary', async t => {
  const { runtime, setContext } = setup(t);
  for (const context of [{ mode: 'read' }, { mode: 'full', plan: true }, { mode: 'off', plan: false }]) {
    setContext(context);
    for (const expectedRevision of [null, 'null']) {
      assert.throws(() => runtime.propose({ type: 'reference', file: 'new.md', content: 'fact', expectedRevision }),
        error => error.code === 'MEMORY_PERMISSION');
    }
    const result = await runtime.hook({ tool_name: 'mcp__relay-memory__propose', tool_input: {} });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.throws(() => runtime.list(), /未启用/);
  setContext({ mode: 'full', plan: false });
  assert.deepEqual(await runtime.hook({ tool_name: 'mcp__relay-memory__propose' }), {});
});
test('confirmed corrections are deduplicated candidates and conflicts never clobber a newer fact', t => {
  const { store, runtime } = setup(t);
  const before = store.write('global.md', 'original');
  const candidate = runtime.propose({ type: 'reference', file: before.file, content: 'corrected', expectedRevision: before.revision });
  const repeated = runtime.propose({ type: 'reference', file: before.file, content: 'corrected', expectedRevision: before.revision });
  assert.equal(candidate.file, repeated.file);
  assert.equal(repeated.deduplicated, true);
  assert.equal(store.read(before.file).content, 'original');
  store.write(before.file, 'user changed it');
  assert.throws(() => runtime.propose({ type: 'reference', file: before.file, content: 'stale', expectedRevision: before.revision }), /发生变化/);
  assert.throws(() => store.setStatus(candidate.file, 'active'), /原记忆已变化/);
  assert.equal(store.read(before.file).content, 'user changed it');
});
test('maintenance cannot promote new facts or propose edits to core entries', t => {
  const { store, runtime, core } = setup(t, { mode: 'maintenance', userConfirmed: true });
  assert.equal(runtime.propose({ type: 'reference', file: 'candidate.md', content: 'inference', expectedRevision: null }).meta.status, 'draft');
  assert.equal(runtime.propose({ type: 'reference', file: 'compatible.md', content: 'inference', expectedRevision: 'null' }).meta.status, 'draft');
  const original = store.write('core.md', doc({ core: true }, 'core fact'));
  assert.throws(() => runtime.propose({ type: 'reference', file: original.file, content: 'changed', expectedRevision: original.revision }), /核心/);
  const pinned = store.write('pinned.md', 'pinned by UI'); core.add(pinned.file);
  assert.throws(() => runtime.propose({ type: 'reference', file: pinned.file, content: 'changed', expectedRevision: pinned.revision }), /核心/);
  for (const previous of [original, pinned]) {
    assert.throws(() => runtime.propose({ type: 'reference', file: previous.file, content: 'changed', expectedRevision: 'null' }),
      error => error.code === 'MEMORY_CONFLICT');
    assert.equal(store.read(previous.file).revision, previous.revision);
  }
  assert.equal(store.read(original.file).revision, original.revision);
  assert.match(MEMORY_CONSOLIDATION_PROMPT, /只.*报告问题/);
});
test('raw file tools cannot bypass memory governance but unrelated project files stay available', async t => {
  const { store, runtime } = setup(t);
  for (const name of ['Read', 'Write', 'Edit', 'Grep', 'Glob']) {
    const result = await runtime.hook({ tool_name: name, tool_input: { file_path: path.join(store.dir, 'x.md'), path: store.dir } });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny', name);
  }
  const projectFile = path.join(path.dirname(store.dir), 'another-project', 'MEMORY.md');
  assert.deepEqual(await runtime.hook({ tool_name: 'Read', tool_input: { file_path: projectFile } }), {});
  assert.deepEqual(await runtime.hook({ tool_name: 'Write', tool_input: { file_path: projectFile, content: 'project doc' } }), {});
});

test('hook uses SDK reported cwd after child-agent or worktree changes', async t => {
  const { store, runtime } = setup(t, { cwd: path.dirname(os.tmpdir()) });
  const guarded = await runtime.hook({ tool_name: 'Write', cwd: store.dir, tool_input: { file_path: 'relative.md', content: 'must not bypass' } });
  assert.equal(guarded.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(fs.existsSync(path.join(store.dir, 'relative.md')), false);
  const allowed = await runtime.hook({ tool_name: 'Write', cwd: path.join(path.dirname(store.dir), 'ordinary-project'), tool_input: { file_path: 'MEMORY.md', content: 'project document' } });
  assert.deepEqual(allowed, {});
});

test('literal PowerShell source searches do not mistake a memory search term for memory access', async t => {
  const { store, runtime } = setup(t);
  const file = path.join(path.dirname(store.dir), 'ordinary-project', 'source.js');
  const commands = [
    `Select-String -Path '${file}' -Pattern 'relay-memory'`,
    `Select-String -LiteralPath "${file}" -Pattern "relay-sdk-memory" -AllMatches | Select-Object -First 20`,
    `Select-String -Path '${file}' -Pattern 'relay-memory|another-pattern' -SimpleMatch | Select-Object -Last 1000`,
  ];
  for (const command of commands) {
    assert.deepEqual(await runtime.hook({ tool_name: 'PowerShell', tool_input: { command } }), {});
  }
  assert.equal(fs.existsSync(file), false, 'classification must never run the command or create a file');
});

test('the source-search exception rejects protected memory files, normalized aliases and ancestor globs', async t => {
  const { store, runtime } = setup(t);
  const files = [
    path.join(store.dir, 'source.js'),
    path.join(store.dir, 'child', '..', 'source.js'),
    path.join(path.dirname(store.dir), '*', 'source.js'),
    path.join(path.dirname(store.dir), '.claude', 'memory', 'source.js'),
    path.join(path.dirname(store.dir), '.claude', 'projects', 'sample', 'memory', 'source.js'),
    path.join(path.dirname(store.dir), '.claude', 'projects', 'sample', 'other', '..', 'memory', 'source.js'),
    path.dirname(store.dir),
  ];
  for (const file of files) {
    const result = await runtime.hook({ tool_name: 'PowerShell', tool_input: {
      command: `Select-String -Path '${file}' -Pattern 'relay-memory'`,
    } });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', file);
  }
});

test('memory source aliases remain denied by real path validation', async t => {
  const { store, runtime } = setup(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-source-alias-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const alias = path.join(parent, 'ordinary-source');
  fs.symlinkSync(store.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(store.dir, 'source.js'), 'synthetic fixture');
  const before = fs.readFileSync(path.join(store.dir, 'source.js'), 'utf8');
  const result = await runtime.hook({ tool_name: 'PowerShell', tool_input: {
    command: `Select-String -LiteralPath '${path.join(alias, 'source.js')}' -Pattern 'relay-memory'`,
  } });
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(fs.readFileSync(path.join(store.dir, 'source.js'), 'utf8'), before);
});

test('write, redirect, expansion and extra shell grammar cannot use the source-search exception', async t => {
  const { store, runtime } = setup(t);
  const file = path.join(path.dirname(store.dir), 'ordinary-project', 'source.js');
  const plain = `Select-String -Path '${file}' -Pattern 'relay-memory'`;
  const commands = [
    `${plain} > 'output.txt'`, `${plain} 2>&1`, `${plain} | Out-File 'output.txt'`,
    `${plain}; Set-Content 'output.txt' 'changed'`, `${plain}\nRemove-Item 'output.txt'`,
    `${plain} | ForEach-Object { $_.Line }`,
    `${plain} | ForEach-Object { "$($_.LineNumber): $($_.Line)" }`,
    `Write-Output 'heading'; ${plain}`,
    `& ${plain}`, `. ${plain}`, `${plain} | Invoke-Expression`,
    `Select-String -Path '${file}' -Pattern "relay-memory$(Set-Content 'output.txt' 'changed')"`,
    `Select-String -Path '${file}' -Pattern 'relay-memory' -Encoding $(Get-Item 'config')`,
    `Select-String -Path '${file}' -Pattern 'relay-memory' | Select-Object -Property @{Name='x';Expression={Set-Content 'output.txt' 'changed'}}`,
    `Select-String -Path '${file}' -Pattern 'relay-memory' | Select-Object -First 1001`,
    `Select-String -Path $env:SOURCE_FILE -Pattern 'relay-memory'`,
    `Select-String -Path '${file}' -Pattern 'relay-memory' # comment`,
    `Select-String -Path '${file}' -Pattern "relay-memory\`n"`,
    `Select-String -Path '${file}' -Pattern 'relay-memory’ | Set-Content “output.txt” ‘changed'`,
    `Select-String -Path '${file}' -Pattern 'relay-memory\u2028extra'`,
    `Set-Content '${path.join(store.dir, 'source.js')}' 'relay-memory'`,
  ];
  for (const command of commands) {
    const result = await runtime.hook({ tool_name: 'PowerShell', tool_input: { command } });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
});

test('only a quoted absolute single source path in PowerShell can receive the exception', async t => {
  const { runtime } = setup(t);
  for (const file of ['source.js', '../source.js', '*.js', 'C:\\project\\[ab].js',
    '\\\\server\\share\\source.js', '\\\\?\\C:\\project\\source.js',
    'C:\\project\\source.js:extra.js', 'C:\\project\\MEMORY.md', 'env:source.js',
    process.platform === 'win32' ? '/mnt/c/project/source.js' : 'C:\\project\\source.js']) {
    const result = await runtime.hook({ tool_name: 'PowerShell', tool_input: {
      command: `Select-String -LiteralPath '${file}' -Pattern 'relay-memory'`,
    } });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', file);
  }
  for (const name of ['Bash', 'Shell', 'mcp__terminal__execute', 'mcp__other__PowerShell']) {
    const result = await runtime.hook({ tool_name: name, tool_input: {
      command: "Select-String -Path 'C:\\project\\source.js' -Pattern 'relay-memory'",
    } });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny', name);
  }
});
