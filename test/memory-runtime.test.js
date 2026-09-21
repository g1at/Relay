'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MemoryStore } = require('../memory-store');
const { createMemoryRuntime, MEMORY_CONSOLIDATION_PROMPT } = require('../memory-runtime');
const { serializeMemoryFrontmatter } = require('../memory-schema');
function setup(t, initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-runtime-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const store = new MemoryStore({ dir }); let context = { mode: 'full', projectId: 'a', sourceRef: 'conversation:a/run:1', cwd: dir, ...initial };
  const reads = [], changes = [], core = new Set();
  const runtime = createMemoryRuntime({ store, context: () => context, onRead: file => reads.push(file), onChanged: item => changes.push(item), isCore: file => core.has(file) });
  return { store, runtime, reads, changes, core, setContext: next => { context = { ...context, ...next }; } };
}
const doc = (meta, body = 'known fact') => serializeMemoryFrontmatter(meta) + '\n' + body;
test('model tool schema requires revisions and returns failures as tool errors', async t => {
  const { runtime } = setup(t), tools = [];
  const servers = runtime.factory({ tool: (name, description, schema, handler) => { const tool = { name, schema, handler }; tools.push(tool); return tool; }, createSdkMcpServer: value => value });
  assert.equal(servers['relay-memory'].name, 'relay-memory');
  assert.deepEqual(tools.map(tool => tool.name), ['list', 'read', 'propose']);
  const propose = tools.find(tool => tool.name === 'propose');
  assert.equal(propose.schema.expectedRevision.safeParse(undefined).success, false);
  assert.equal(propose.schema.expectedRevision.safeParse(null).success, true);
  assert.equal((await propose.handler({ file: 'new.md', content: 'new fact' })).isError, true);
  assert.equal((await propose.handler({ file: 'new.md', content: 'new fact', expectedRevision: null })).isError, undefined);
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
  const saved = runtime.propose({ file: 'new.md', expectedRevision: null, content: doc({ status: 'active', confidence: 'user_confirmed', scope: 'global', core: true, sourceRef: 'fake' }), userConfirmed: true });
  assert.equal(saved.meta.status, 'draft');
  assert.equal(saved.meta.core, false);
  assert.equal(saved.meta.projectId, 'a');
  assert.equal(saved.meta.sourceRef, 'conversation:a/run:1');
  setContext({ userConfirmed: true });
  assert.equal(runtime.propose({ file: 'remember.md', content: 'requested fact', expectedRevision: null }).meta.status, 'active');
});
test('read mode, plan, disabled memory and changed live context enforce the same mutation boundary', async t => {
  const { runtime, setContext } = setup(t);
  for (const context of [{ mode: 'read' }, { mode: 'full', plan: true }, { mode: 'off', plan: false }]) {
    setContext(context);
    assert.throws(() => runtime.propose({ file: 'new.md', content: 'fact', expectedRevision: null }));
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
  const candidate = runtime.propose({ file: before.file, content: 'corrected', expectedRevision: before.revision });
  const repeated = runtime.propose({ file: before.file, content: 'corrected', expectedRevision: before.revision });
  assert.equal(candidate.file, repeated.file);
  assert.equal(repeated.deduplicated, true);
  assert.equal(store.read(before.file).content, 'original');
  store.write(before.file, 'user changed it');
  assert.throws(() => runtime.propose({ file: before.file, content: 'stale', expectedRevision: before.revision }), /发生变化/);
  assert.throws(() => store.setStatus(candidate.file, 'active'), /原记忆已变化/);
  assert.equal(store.read(before.file).content, 'user changed it');
});
test('maintenance cannot promote new facts or propose edits to core entries', t => {
  const { store, runtime, core } = setup(t, { mode: 'maintenance', userConfirmed: true });
  assert.equal(runtime.propose({ file: 'candidate.md', content: 'inference', expectedRevision: null }).meta.status, 'draft');
  const original = store.write('core.md', doc({ core: true }, 'core fact'));
  assert.throws(() => runtime.propose({ file: original.file, content: 'changed', expectedRevision: original.revision }), /核心/);
  const pinned = store.write('pinned.md', 'pinned by UI'); core.add(pinned.file);
  assert.throws(() => runtime.propose({ file: pinned.file, content: 'changed', expectedRevision: pinned.revision }), /核心/);
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
