'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createWorkspaceReview, cleanPath, parseNumstat, commandEnvironment, OUTPUT_LIMIT, FILE_SIZE_LIMIT } = require('../workspace-review');

function fixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-review-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const env = commandEnvironment(process.env);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : os.devNull), '-c', 'user.name=Relay Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet'); git('config', 'core.autocrlf', 'false');
  const service = createWorkspaceReview(options);
  t.after(() => { service.dispose(); fs.rmSync(temp, { recursive: true, force: true }); });
  const write = (file, value) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); };
  const commit = () => { git('add', '--all'); git('commit', '-qm', 'fixture'); };
  return { temp, root, git, write, commit, service, overview: scope => service.overview({ root: scope || root }), diff: (file, stage, scope) => service.readFileDiff({ root: scope || root }, { path: file, stage }) };
}

test('non-Git and unborn repositories have useful states without requiring an initial commit', async t => {
  const h = fixture(t), outside = path.join(h.temp, 'plain'); fs.mkdirSync(outside);
  assert.equal((await h.overview(outside)).kind, 'not-repository');
  const empty = await h.overview(); assert.equal(empty.kind, 'ready'); assert.equal(empty.files.length, 0); assert.ok(empty.branch);
  h.write('新文件 空格.md', '# 标题\n正文\n');
  const untracked = await h.overview(); assert.equal(untracked.files[0].stage, 'untracked'); assert.equal(untracked.files[0].added, 2);
  h.git('add', '--all');
  const staged = await h.overview(); assert.equal(staged.files[0].stage, 'staged'); assert.equal(staged.files[0].status, 'A');
  assert.match((await h.diff('新文件 空格.md', 'staged')).diff, /\+正文/);
});

test('staged and unstaged versions of one file remain separate and accurately counted', async t => {
  const h = fixture(t); h.write('中文 name.txt', 'alpha\nbeta\n'); h.commit();
  h.write('中文 name.txt', 'alpha\nstaged\n'); h.git('add', '--all'); h.write('中文 name.txt', 'alpha\nunstaged\nextra\n');
  const state = await h.overview();
  assert.deepEqual(state.files.map(file => [file.stage, file.path, file.added, file.deleted]), [['staged', '中文 name.txt', 1, 1], ['unstaged', '中文 name.txt', 2, 1]]);
  const staged = await h.diff('中文 name.txt', 'staged'), unstaged = await h.diff('中文 name.txt', 'unstaged');
  assert.match(staged.diff, /\+staged/); assert.doesNotMatch(staged.diff, /\+unstaged/);
  assert.match(unstaged.diff, /-staged/); assert.match(unstaged.diff, /\+unstaged/);
  assert.deepEqual(state.totals, { files: 2, added: 3, deleted: 2 });
});

test('clean file counts never hide later changes and hunk content beginning with signs is counted', async t => {
  const h = fixture(t);
  for (let index = 0; index < 650; index++) h.write('clean-' + String(index).padStart(4, '0') + '.txt', 'unchanged\n');
  h.write('z-last.txt', '--old\n'); h.commit(); h.write('z-last.txt', '++new\n');
  const result = await h.overview(); assert.equal(result.truncated, false);
  assert.deepEqual(result.files.map(file => file.path), ['z-last.txt']);
  const diff = await h.diff('z-last.txt', 'unstaged'); assert.equal(diff.added, 1); assert.equal(diff.deleted, 1);
});

test('rename, deletion, binary and empty changes retain their correct representation', async t => {
  const h = fixture(t); h.write('old name.txt', 'same\n'); h.write('delete.txt', 'removed\n'); h.write('binary.dat', Buffer.from([0, 1, 2])); h.commit();
  h.git('mv', 'old name.txt', '新 名称.txt'); fs.unlinkSync(path.join(h.root, 'delete.txt')); h.write('binary.dat', Buffer.from([0, 3, 4]));
  const before = fs.readFileSync(path.join(h.root, '.git', 'index')), config = fs.readFileSync(path.join(h.root, '.git', 'config'));
  const state = await h.overview(), rename = state.files.find(file => file.status === 'R');
  assert.equal(rename.path, '新 名称.txt'); assert.equal(rename.oldPath, 'old name.txt');
  assert.equal(state.files.find(file => file.path === 'delete.txt').deleted, 1);
  assert.equal(state.files.find(file => file.path === 'binary.dat').binary, true);
  assert.match((await h.diff(rename.path, 'staged')).diff, /rename from/);
  assert.match((await h.diff('delete.txt', 'unstaged')).diff, /-removed/);
  assert.equal((await h.diff('binary.dat', 'unstaged')).binary, true);
  assert.deepEqual(fs.readFileSync(path.join(h.root, '.git', 'index')), before);
  assert.deepEqual(fs.readFileSync(path.join(h.root, '.git', 'config')), config);
  h.git('reset', '--hard', 'HEAD'); assert.equal((await h.overview()).files.length, 0);
  await assert.rejects(h.diff('delete.txt', 'unstaged'), error => error.code === 'CHANGE_NOT_FOUND');
});

test('workspace subdirectories never return sibling changes or cross-boundary rename contents', async t => {
  const h = fixture(t); h.write('scope/keep.txt', 'before\n'); h.write('outside.txt', 'outside text\n'); h.write('scope/move.txt', 'moving\n'); h.commit();
  h.write('scope/keep.txt', 'after\n'); h.write('outside.txt', 'private sibling content\n'); h.git('mv', 'scope/move.txt', 'moved-out.txt');
  const scope = path.join(h.root, 'scope'), state = await h.overview(scope);
  assert.ok(state.files.some(file => file.path === 'keep.txt')); assert.ok(state.files.every(file => !file.path.includes('outside') && !file.path.includes('moved-out')));
  assert.match((await h.diff('keep.txt', 'unstaged', scope)).diff, /\+after/);
  await assert.rejects(h.diff('../outside.txt', 'unstaged', scope), error => error.code === 'INVALID_PATH');
});

test('directory symlinks cannot reveal an external file and untracked links are not followed', async t => {
  const h = fixture(t), outside = path.join(h.temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'synthetic external marker');
  h.write('tracked.txt', 'base\n'); h.commit();
  fs.symlinkSync(outside, path.join(h.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const state = await h.overview(); assert.ok(!state.files.some(file => file.path.startsWith('escape')));
  await assert.rejects(h.diff('escape/secret.txt', 'untracked'), error => error.code === 'OUTSIDE_WORKSPACE');
});

test('repository external diff, textconv, fsmonitor and content filters cannot execute', async t => {
  const h = fixture(t); h.write('tracked.txt', 'base\n'); h.write('.gitattributes', '*.txt diff=fixture filter=fixture\n'); h.commit();
  const marker = path.join(h.temp, 'must-not-run'), script = path.join(h.temp, 'tool.cjs');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
  const command = JSON.stringify(process.execPath) + ' ' + JSON.stringify(script);
  for (const key of ['diff.external', 'diff.fixture.command', 'diff.fixture.textconv', 'core.fsmonitor', 'filter.fixture.clean', 'filter.fixture.process', 'filter.fixture.smudge']) h.git('config', key, command);
  h.git('config', 'filter.fixture.required', 'true'); h.write('tracked.txt', 'changed\n');
  assert.equal((await h.overview()).files.find(file => file.path === 'tracked.txt').status, 'M');
  assert.match((await h.diff('tracked.txt', 'unstaged')).diff, /\+changed/);
  assert.equal(fs.existsSync(marker), false);
});

test('normal user autocrlf and ignore preferences survive without enabling user content filters', async t => {
  const h = fixture(t); h.write('tracked.txt', 'base\n'); h.write('.gitattributes', '*.txt filter=fixture\n'); h.commit();
  h.git('config', '--unset', 'core.autocrlf');
  const home = path.join(h.temp, 'git-home'); fs.mkdirSync(home);
  const ignore = path.join(home, 'ignore'), config = path.join(home, '.gitconfig'), marker = path.join(h.temp, 'user-filter-must-not-run'), script = path.join(h.temp, 'user-filter.cjs');
  fs.writeFileSync(ignore, '*.scratch\n'); fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');`);
  h.git('config', '--file', config, 'core.autocrlf', 'true');
  h.git('config', '--file', config, 'core.excludesFile', ignore.replace(/\\/g, '/'));
  h.git('config', '--file', config, 'filter.fixture.clean', JSON.stringify(process.execPath) + ' ' + JSON.stringify(script));
  const service = createWorkspaceReview({ env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') } });
  t.after(() => service.dispose()); h.write('tracked.txt', 'base\r\n'); h.write('ignored.scratch', 'not a change');
  const state = await service.overview({ root: h.root }); assert.deepEqual(state.files, []); assert.equal(fs.existsSync(marker), false);
  h.write('tracked.txt', 'new\r\n'); const diff = await service.readFileDiff({ root: h.root }, { path: 'tracked.txt', stage: 'unstaged' });
  assert.equal(diff.added, 1); assert.equal(diff.deleted, 1); assert.equal(fs.existsSync(marker), false);
});

test('untracked diffs preserve Unicode, missing newlines, empty files and bounded text', async t => {
  const h = fixture(t, { outputLimit: 4096 }); h.write('空 白.txt', '中文\n最后'); h.write('empty.txt', ''); h.write('large.txt', '汉字\n'.repeat(3000));
  const text = await h.diff('空 白.txt', 'untracked'); assert.equal(text.added, 2); assert.match(text.diff, /\+最后/); assert.match(text.diff, /No newline at end of file/);
  assert.equal((await h.diff('empty.txt', 'untracked')).added, 0);
  const large = await h.diff('large.txt', 'untracked'); assert.equal(large.truncated, true); assert.ok(Buffer.byteLength(large.diff) <= 4096); assert.ok(!large.diff.endsWith('�'));
});

test('oversized tracked files are explicitly limited rather than returned without bounds', async t => {
  const h = fixture(t); h.write('large.txt', 'base\n'); h.commit(); h.write('large.txt', 'x'.repeat(FILE_SIZE_LIMIT + 1));
  const diff = await h.diff('large.txt', 'unstaged'); assert.equal(diff.truncated, true); assert.equal(diff.diff, ''); assert.match(diff.reason, /较大/);
});

test('missing Git returns an unavailable overview and timeouts terminate the process', async t => {
  const missing = createWorkspaceReview({ spawn() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  assert.equal((await missing.overview({ root: os.tmpdir() })).kind, 'unavailable'); missing.dispose();
  let killed = false;
  const hanging = createWorkspaceReview({ timeoutMs: 10, spawn() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { killed = true; setImmediate(() => child.emit('close', null)); }; return child; } });
  await assert.rejects(hanging.overview({ root: os.tmpdir() }), error => error.code === 'REVIEW_TIMEOUT'); assert.equal(killed, true); hanging.dispose();
});

test('path validation and inherited Git overrides cannot escape the trusted workspace', () => {
  for (const file of ['../outside', '/etc/passwd', 'C:\\Windows\\win.ini', 'C:file', ':/', '.git/config', 'nested/../file', 'bad\0file']) assert.throws(() => cleanPath(file));
  const env = commandEnvironment({ PATH: '/safe/bin', GIT_DIR: '/other', git_work_tree: '/other', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'bad', NODE_OPTIONS: '--inspect' });
  assert.equal(env.GIT_DIR, undefined); assert.equal(env.git_work_tree, undefined); assert.equal(env.GIT_CONFIG_COUNT, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.PATH, '/safe/bin');
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(env.GIT_NO_LAZY_FETCH, '1'); assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.deepEqual(parseNumstat({ stdout: Buffer.from('1\t2\t\0old name\0中文 new\0-\t-\timage.bin\0'), truncated: false }).get('中文 new'), { added: 1, deleted: 2, binary: false, oldPath: 'old name' });
});
