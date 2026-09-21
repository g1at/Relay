'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUnifiedDiff, tokenizeLine, groupFiles, createController } = require('../renderer/workspace-review');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const file = (path = 'src/app.js', stage = 'unstaged') => ({ path, stage, status: 'M', added: 1, deleted: 1, binary: false });
const snapshot = (files = [file()]) => ({ ok: true, kind: 'ready', root: '/synthetic/project', branch: 'main', files, totals: { files: files.length, added: files.length, deleted: files.length }, truncated: false });
const diff = (selected = file(), text = '@@ -1 +1 @@\n-old\n+new\n') => ({ ok: true, ...selected, diff: text, truncated: false });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('unified hunks assign old/new numbers separately and preserve file header metadata', () => {
  const result = parseUnifiedDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -10,3 +12,3 @@ section\n before\n-removed\n+added\n after\n\\ No newline at end of file\n@@ -90,0 +94,2 @@\n+one\n+two\n');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.lines.slice(0, 3).map(row => row.kind), ['meta', 'meta', 'meta']);
  assert.deepEqual(result.lines.filter(row => ['add', 'delete', 'context'].includes(row.kind)).map(row => [row.kind, row.oldLine, row.newLine, row.text]), [
    ['context', 10, 12, 'before'], ['delete', 11, null, 'removed'], ['add', null, 13, 'added'], ['context', 12, 14, 'after'], ['add', null, 94, 'one'], ['add', null, 95, 'two'],
  ]);
  assert.equal(result.lines.find(row => row.text.startsWith('\\')).kind, 'meta');
});
test('new-file line zero, CRLF and header-looking content inside hunks remain accurate', () => {
  const result = parseUnifiedDiff('--- /dev/null\r\n+++ b/new.txt\r\n@@ -0,0 +1,3 @@\r\n+++ a string\r\n+\r\n+<script>bad()</script>\r\n');
  assert.deepEqual(result.lines.filter(row => row.kind === 'add').map(row => [row.oldLine, row.newLine, row.text]), [[null, 1, '++ a string'], [null, 2, ''], [null, 3, '<script>bad()</script>']]);
  assert.deepEqual(parseUnifiedDiff(null), { lines: [], truncated: false });
});
test('render bounds expose truncation without allocating unbounded line nodes', () => {
  const result = parseUnifiedDiff('@@ -0,0 +1,4 @@\n+123456789\n+second\n+third\n+fourth\n', { maxLines: 3, maxLineLength: 8 });
  assert.equal(result.truncated, true); assert.equal(result.lines.length, 3); assert.ok(result.lines.every(row => row.text.length <= 8));
  assert.equal(parseUnifiedDiff('x'.repeat(2100000)).truncated, true);
});
test('minimal syntax tokens preserve exact source including hostile HTML and long lines', () => {
  for (const input of ['const x = "<img src=x onerror=bad()>"; // 123', 'def run(): # comment', '  # name\tvalue', 'a'.repeat(9000), '', 'return null;']) {
    const tokens = tokenizeLine(input); assert.equal(tokens.map(token => token.text).join(''), input);
    assert.ok(tokens.every(token => ['', 'string', 'comment', 'keyword', 'number'].includes(token.kind)));
  }
  const tokens = tokenizeLine('const text = "return 42"; // const 9');
  assert.equal(tokens.find(token => token.text === 'const').kind, 'keyword');
  assert.equal(tokens.find(token => token.text === '"return 42"').kind, 'string');
  assert.equal(tokens.at(-1).kind, 'comment');
});
test('groups preserve a file in both staged and unstaged sections and skip malformed records', () => {
  const groups = groupFiles([file('same.js', 'staged'), file('same.js'), file('new.js', 'untracked'), { path: 1, stage: 'staged' }, null, file('other', 'unexpected')]);
  assert.deepEqual(groups.map(group => [group.id, group.files.map(item => item.path)]), [['unstaged', ['same.js']], ['staged', ['same.js']], ['untracked', ['new.js']]]);
});
test('controller reads only on activation/explicit refresh and preserves the selected stage', async () => {
  const calls = [], data = snapshot([file('same.js'), file('same.js', 'staged')]);
  const c = createController({ api: { async review(context) { calls.push(['list', context]); return data; }, async reviewDiff(request) { calls.push(['diff', request]); return diff(request); } } });
  c.setContext({ conversationId: 'conversation-a', workingDir: '/synthetic/a' }); assert.equal(calls.length, 0);
  c.setActive(true); await tick(); assert.equal(c.getState().diff.stage, 'unstaged');
  c.setActive(true); assert.equal(calls.filter(([kind]) => kind === 'list').length, 1);
  await c.select(data.files[1]); await c.refresh(); assert.equal(c.getState().diff.stage, 'staged');
  assert.deepEqual(calls.at(-1)[1], { context: { conversationId: 'conversation-a', workingDir: '/synthetic/a' }, path: 'same.js', stage: 'staged' });
  c.setActive(false); c.setContext({ conversationId: 'conversation-b' }); assert.equal(c.getState().snapshot, null); assert.equal(c.getState().diff, null); c.destroy();
});
test('switching project clears the old result immediately and ignores late lists', async () => {
  const a = deferred(), b = deferred();
  const c = createController({ api: { review(context) { return context.workingDir === '/a' ? a.promise : b.promise; }, async reviewDiff(request) { return diff(request); } } });
  c.setContext({ conversationId: 'same', workingDir: '/a' }); c.setActive(true);
  c.setContext({ conversationId: 'same', workingDir: '/b' }); assert.equal(c.getState().snapshot, null);
  b.resolve(snapshot([file('b.js')])); await tick(); a.resolve(snapshot([file('a.js')])); await tick();
  assert.equal(c.getState().snapshot.files[0].path, 'b.js'); assert.equal(c.getState().diff.path, 'b.js'); c.destroy();
});
test('switching files or projects ignores late diffs, and close releases all future updates', async () => {
  const old = deferred(), late = deferred(), files = [file('old.js'), file('new.js')]; let frames = 0;
  const c = createController({ api: { async review() { return snapshot(files); }, reviewDiff(request) { return request.path === 'old.js' ? old.promise : late.promise; } }, onChange() { frames++; } });
  c.setContext({ conversationId: 'one' }); c.setActive(true); await tick();
  const next = c.select(files[1]); old.resolve(diff(files[0])); await tick(); assert.equal(c.getState().diff, null);
  late.resolve(diff(files[1])); await next; assert.equal(c.getState().diff.path, 'new.js');
  const pending = deferred(); const c2 = createController({ api: { review: () => pending.promise }, onChange() { frames++; } });
  c2.setActive(true); c2.destroy(); const before = frames; pending.resolve(snapshot()); await tick(); assert.equal(frames, before); c.destroy();
});
test('same-directory project changes also prevent an outstanding old diff from being shown', async () => {
  const old = deferred(); let calls = 0;
  const c = createController({ api: { async review() { return snapshot(); }, reviewDiff(request) { return ++calls === 1 ? old.promise : Promise.resolve(diff(request, '@@ -1 +1 @@\n-before\n+current\n')); } } });
  c.setContext({ conversationId: 'old', workingDir: '/shared' }); c.setActive(true); await tick();
  c.setContext({ conversationId: 'new', workingDir: '/shared' }); assert.equal(c.getState().diff, null); await tick();
  old.resolve(diff(file(), 'old-data')); await tick(); assert.match(c.getState().diff.diff, /current/); c.destroy();
});
test('non-repository, clean and unavailable states do not request a fabricated diff', async () => {
  let reply = { ok: true, kind: 'not-repository', files: [] }, calls = 0;
  const c = createController({ api: { async review() { return reply; }, async reviewDiff() { calls++; } } });
  await c.refresh(); assert.equal(c.getState().snapshot.kind, 'not-repository');
  reply = snapshot([]); await c.refresh(); assert.equal(c.getState().snapshot.files.length, 0);
  reply = { ok: true, kind: 'unavailable', message: 'Git 未安装' }; await c.refresh(); assert.equal(c.getState().snapshot.kind, 'unavailable'); assert.equal(calls, 0); c.destroy();
});
test('project identity changes invalidate a pending result even with the same conversation and directory', async () => {
  const old = deferred(); let calls = 0;
  const c = createController({ api: {
    async review(context) { return snapshot([file(context.projectId + '.js')]); },
    reviewDiff(request) { return ++calls === 1 ? old.promise : Promise.resolve(diff(request)); },
  } });
  c.setContext({ conversationId: 'same', workingDir: '/same', projectId: 'old-project' }); c.setActive(true); await tick();
  c.setContext({ conversationId: 'same', workingDir: '/same', projectId: 'new-project' });
  assert.equal(c.getState().snapshot, null); assert.equal(c.getState().diff, null); await tick();
  old.resolve(diff(file('old-project.js'))); await tick();
  assert.equal(c.getState().snapshot.files[0].path, 'new-project.js'); assert.equal(c.getState().diff.path, 'new-project.js'); c.destroy();
});
test('hiding while a list is in flight prevents a follow-up diff and reopening refreshes once', async () => {
  const first = deferred(); let lists = 0, diffs = 0;
  const c = createController({ api: {
    review() { return ++lists === 1 ? first.promise : Promise.resolve(snapshot()); },
    async reviewDiff(request) { diffs++; return diff(request); },
  } });
  c.setActive(true); assert.equal(c.getState().loading, true); c.setActive(false);
  first.resolve(snapshot([file('old.js')])); await tick();
  assert.equal(diffs, 0); assert.equal(c.getState().snapshot, null); assert.equal(c.getState().loading, false);
  c.setActive(true); await tick(); assert.equal(lists, 2); assert.equal(diffs, 1); assert.equal(c.getState().diff.path, 'src/app.js'); c.destroy();
});
test('read failures remain retryable and mismatched diff identities cannot replace the chosen file', async () => {
  let fail = true, badDiff = false;
  const c = createController({ api: { async review() { return fail ? { ok: false, error: '无法读取目录' } : snapshot(); }, async reviewDiff(request) { return badDiff ? diff(file('wrong.js')) : diff(request); } } });
  await c.refresh(); assert.equal(c.getState().error, '无法读取目录'); assert.equal(c.getState().loading, false);
  fail = false; await c.refresh(); assert.equal(c.getState().error, null); assert.equal(c.getState().diff.path, 'src/app.js');
  badDiff = true; await c.select(file()); assert.equal(c.getState().diff, null); assert.match(c.getState().diffError, /文件已发生变化/);
  badDiff = false; await c.select(file()); assert.equal(c.getState().diffError, null); assert.ok(c.getState().diff); c.destroy();
});
