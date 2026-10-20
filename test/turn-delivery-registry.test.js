'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDeliveryRegistry, finalReferences } = require('../src/main/tasks/turn-deliverables');
async function fixture(t, options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'relay-turn-delivery-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), scratch = path.join(root, 'scratch');
  await fs.promises.mkdir(cwd); await fs.promises.mkdir(scratch);
  const registry = createDeliveryRegistry(options);
  const input = { conversationId: 'conversation-a', runId: 'run-a', turnTs: '2026-10-15T00:00:00Z', cwd, outputDir: cwd, scratchDir: scratch };
  const write = async (name, text = name) => { const file = path.join(root, name); await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, text); return file; };
  const success = (file, { runId = 'run-a', id = 'write-1', name = 'Write', child = {}, failed = false } = {}) => {
    registry.observe({ runId, event: { type: 'assistant', jobId: runId, ...child, message: { content: [{ type: 'tool_use', id, name, input: { file_path: file } }] } } });
    registry.observe({ runId, event: { type: 'user', jobId: runId, ...child, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: 'fixture result' }] } } });
  };
  return { root, cwd, scratch, input, registry, write, success };
}
const names = snapshot => snapshot.items.map(item => item.name).sort();
const code = text => String.fromCharCode(96) + text + String.fromCharCode(96);
const link = file => '[file](<' + file + '>)';

test('ordinary project greeting does not scan project files or create output directories', async t => {
  let scans = 0; const h = await fixture(t, { fileSystem: { ...fs.promises, opendir: async (...args) => { scans++; return fs.promises.opendir(...args); } } });
  await h.write('project/source.js'); await h.registry.begin(h.input);
  const result = await h.registry.finish({ runId: 'run-a', finalText: '你好。' });
  assert.deepEqual(result.items, []); assert.equal(result.complete, true); assert.equal(scans, 0); assert.equal(fs.existsSync(path.join(h.cwd, 'outputs')), false);
});
test('bounded outputs delta finds shell-created delivery without attributing old outputs or unrelated cwd', async t => {
  const h = await fixture(t); await h.write('project/outputs/old.md'); await h.write('project/unrelated.md');
  await h.registry.begin(h.input); await h.write('project/outputs/report.pdf');
  const result = await h.registry.finish({ runId: 'run-a' }); assert.deepEqual(names(result), ['report.pdf']); assert.equal(result.items[0].source, 'output-delta');
});
test('outputs created after begin are discovered', async t => {
  const h = await fixture(t); await h.registry.begin(h.input); await h.write('project/outputs/report.md');
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a' })), ['report.md']);
});
test('source edits are not delivered by default', async t => {
  const h = await fixture(t); const file = await h.write('project/app.js'); await h.registry.begin(h.input); h.success(file);
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a' })), []);
});
test('inline basename resolves only one verified candidate in the current run', async t => {
  const h = await fixture(t); const file = await h.write('project/scripts/report.py'); await h.registry.begin(h.input); h.success(file);
  const result = await h.registry.finish({ runId: 'run-a', finalText: '交付：' + code('report.py') });
  assert.deepEqual(names(result), ['report.py']); assert.equal(result.items[0].source, 'write-tool'); assert.equal(result.items[0].toolUseId, 'write-1');
});
test('inline basename never searches the project or guesses an ambiguous write', async t => {
  const h = await fixture(t); const a = await h.write('project/a/report.py'), b = await h.write('project/b/report.py'); await h.registry.begin(h.input);
  h.success(a); h.success(b, { id: 'write-2' }); assert.deepEqual(names(await h.registry.finish({ runId: 'run-a', finalText: code('report.py') })), []);
});
test('exact inline document path is a selected reference rather than proof of new creation', async t => {
  const h = await fixture(t); const file = await h.write('project/reports/report.md'); await h.registry.begin(h.input);
  const result = await h.registry.finish({ runId: 'run-a', finalText: code(file) });
  assert.deepEqual(names(result), ['report.md']); assert.equal(result.items[0].source, 'final-reference'); assert.equal(result.items[0].toolUseId, null);
});
test('Markdown document links qualify while source/config/line links do not', async t => {
  const h = await fixture(t); const doc = await h.write('project/report.md'), source = await h.write('project/app.js'), config = await h.write('project/config.json'); await h.registry.begin(h.input);
  const result = await h.registry.finish({ runId: 'run-a', finalText: link(doc) + link(source) + link(config) + link(doc + ':2') });
  assert.deepEqual(names(result), ['report.md']); assert.equal(result.items[0].source, 'final-reference');
});
test('script handoff needs successful write evidence or outputs delta', async t => {
  const h = await fixture(t); const script = await h.write('project/solve.py'), old = await h.write('project/old.py'); await h.registry.begin(h.input); h.success(script);
  const result = await h.registry.finish({ runId: 'run-a', finalText: link(script) + link(old) }); assert.deepEqual(names(result), ['solve.py']); assert.equal(result.items[0].source, 'write-tool');
});
test('failed unmatched and wrong-run receipts never certify a script', async t => {
  const h = await fixture(t); const script = await h.write('project/solve.py'); await h.registry.begin(h.input); h.success(script, { failed: true });
  h.registry.observe({ runId: 'run-a', event: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'unknown' }] } } });
  h.registry.observe({ runId: 'run-a', event: { type: 'assistant', jobId: 'other', message: { content: [{ type: 'tool_use', id: 'foreign', name: 'Write', input: { file_path: script } }] } } });
  h.registry.observe({ runId: 'run-a', event: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'foreign' }] } } });
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a', finalText: link(script) })), []);
});
test('child receipt owner must match the captured write', async t => {
  const h = await fixture(t); const script = await h.write('project/child.py'); await h.registry.begin(h.input);
  h.registry.observe({ runId: 'run-a', event: { type: 'assistant', parent_tool_use_id: 'agent-a', message: { content: [{ type: 'tool_use', id: 'child-write', name: 'Write', input: { file_path: script } }] } } });
  h.registry.observe({ runId: 'run-a', event: { type: 'user', parent_tool_use_id: 'agent-b', message: { content: [{ type: 'tool_result', tool_use_id: 'child-write' }] } } });
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a', finalText: link(script) })), []);
});
test('scratch is excluded from writes final links and outputs scans', async t => {
  const h = await fixture(t); const scratch = path.join(h.cwd, 'outputs', 'scratch'); await fs.promises.mkdir(scratch, { recursive: true });
  await h.registry.begin({ ...h.input, scratchDir: scratch }); const file = path.join(scratch, 'draft.md'); await fs.promises.writeFile(file, 'draft'); h.success(file);
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a', finalText: link(file) })), []);
});
test('parallel shared output roots disable delta attribution but preserve per-run receipts', async t => {
  const h = await fixture(t); await h.write('project/outputs/old.md'); await h.registry.begin(h.input);
  await h.registry.begin({ ...h.input, conversationId: 'conversation-b', runId: 'run-b' });
  const a = await h.write('project/outputs/a.md'), b = await h.write('project/outputs/b.md'); h.success(a); h.success(b, { runId: 'run-b', id: 'write-b' });
  const first = await h.registry.finish({ runId: 'run-a' }), second = await h.registry.finish({ runId: 'run-b' });
  assert.deepEqual(names(first), ['a.md']); assert.deepEqual(names(second), ['b.md']); assert.ok(first.warnings.includes('SHARED_OUTPUT_CONCURRENT_RUN')); assert.ok(second.warnings.includes('SHARED_OUTPUT_CONCURRENT_RUN'));
});
test('run identity isolates matching tool IDs and shared cwd', async t => {
  const h = await fixture(t); await h.registry.begin(h.input); await h.registry.begin({ ...h.input, runId: 'run-b', conversationId: 'b' });
  const a = await h.write('project/a.md'), b = await h.write('project/b.md'); h.success(a); h.success(b, { runId: 'run-b' });
  const first = await h.registry.finish({ runId: 'run-a' }), second = await h.registry.finish({ runId: 'run-b' });
  assert.deepEqual(names(first), ['a.md']); assert.deepEqual(names(second), ['b.md']); assert.notEqual(first.items[0].id, second.items[0].id);
});
test('begin timeout is bounded and incomplete', async t => {
  const h = await fixture(t, { limits: { beginBudgetMs: 15 }, fileSystem: { ...fs.promises, realpath: (...args) => new Promise(resolve => setTimeout(() => resolve(fs.promises.realpath(...args)), 100)) } });
  await h.write('project/outputs/old.md'); const at = Date.now(); const result = await h.registry.begin(h.input); assert.ok(Date.now() - at < 90);
  assert.equal(result.complete, false); assert.ok(result.warnings.includes('BASELINE_TIME_BUDGET')); await new Promise(resolve => setTimeout(resolve, 120));
});
test('truncated baseline does not attribute old outputs', async t => {
  const h = await fixture(t, { limits: { maxEntries: 1 } }); await h.write('project/outputs/old-a.md'); await h.write('project/outputs/old-b.md');
  await h.registry.begin(h.input); const result = await h.registry.finish({ runId: 'run-a' }); assert.equal(result.complete, false); assert.deepEqual(result.items, []); assert.ok(result.warnings.includes('BASELINE_ENTRY_LIMIT'));
});
test('linked output directories are not scanned', async t => {
  const h = await fixture(t); const external = path.join(h.root, 'external'); await fs.promises.mkdir(external); await h.write('external/secret.md');
  try { await fs.promises.symlink(external, path.join(h.cwd, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host cannot create fixture links'); throw error; }
  await h.registry.begin(h.input); const result = await h.registry.finish({ runId: 'run-a' }); assert.deepEqual(result.items, []); assert.equal(result.complete, false);
});
test('missing files and code fence examples do not make ghost cards', async t => {
  const h = await fixture(t); const file = await h.write('project/example.md'); await h.registry.begin(h.input); const fence = String.fromCharCode(96).repeat(3);
  assert.deepEqual((await h.registry.finish({ runId: 'run-a', finalText: link(h.cwd + '/missing.pdf') + '\n' + fence + '\n' + link(file) + '\n' + fence })).items, []);
});
test('snapshots and finish are immutable and idempotent with durable identity', async t => {
  const updates = []; const h = await fixture(t, { onUpdate: value => updates.push(value) }); const file = await h.write('project/report.md'); await h.registry.begin(h.input);
  const result = await h.registry.finish({ runId: 'run-a', finalText: link(file) }); result.items.length = 0;
  const next = h.registry.snapshot('run-a'); assert.deepEqual(names(next), ['report.md']); assert.equal(next.conversationId, 'conversation-a'); assert.equal(next.turnTs, h.input.turnTs);
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a' })), ['report.md']); await Promise.resolve(); assert.equal(updates.at(-1).status, 'complete');
});
test('duplicate run conflicts fail closed and forgetting prevents late events', async t => {
  const h = await fixture(t); await h.registry.begin(h.input); await assert.rejects(h.registry.begin({ ...h.input, conversationId: 'other' }), { code: 'DELIVERY_IDENTITY_MISMATCH' });
  h.registry.forget('run-a'); assert.equal(h.registry.snapshot('run-a'), null); assert.equal(await h.registry.finish({ runId: 'run-a' }), null);
});
test('reference parser bounds input and excludes line and fenced references', () => {
  const prefix = os.tmpdir().replace(/\\/g, '/'), fence = String.fromCharCode(96).repeat(3);
  const text = link(prefix + '/a.md:2') + link(prefix + '/a.md') + code(prefix + '/b.pdf') + '\n' + fence + '\n' + link(prefix + '/example.md') + '\n' + fence;
  assert.equal(finalReferences(text, os.tmpdir(), 1).entries.length, 1); assert.equal(finalReferences(text, os.tmpdir(), 1).truncated, true); assert.equal(finalReferences('x'.repeat(256 * 1024 + 1), os.tmpdir(), 1).truncated, true);
});

test('successful dedicated-output write publishes a verified card before finish', async t => {
  const updates = []; const h = await fixture(t, { onUpdate: value => updates.push(value) }); await h.write('project/outputs/old.md'); await h.registry.begin(h.input);
  const file = await h.write('project/outputs/report.md'); h.success(file);
  for (let i = 0; i < 50 && !updates.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(updates.at(-1)?.status, 'running'); assert.deepEqual(names(updates.at(-1)), ['report.md']);
  assert.equal(updates.at(-1).items[0].source, 'write-tool'); await h.registry.finish({ runId: 'run-a' });
});
test('successful edits to source and config still need delivery eligibility', async t => {
  const h = await fixture(t); const config = await h.write('project/config.json'), source = await h.write('project/component.tsx'); await h.registry.begin(h.input);
  h.success(config, { name: 'Edit' }); h.success(source, { name: 'Edit', id: 'source-write' });
  const result = await h.registry.finish({ runId: 'run-a', finalText: '[config](' + config + ') [source](' + source + ')' });
  assert.deepEqual(result.items, []);
});
test('finish timeout seals the snapshot against delayed file checks', async t => {
  let delayChecks = false; const updates = [];
  const h = await fixture(t, { limits: { finishBudgetMs: 15 }, onUpdate: value => updates.push(value), fileSystem: { ...fs.promises,
    lstat: (...args) => delayChecks ? new Promise(resolve => setTimeout(() => resolve(fs.promises.lstat(...args)), 80)) : fs.promises.lstat(...args) } });
  const file = await h.write('project/report.md'); await h.registry.begin({ ...h.input, allowOutputScan: false }); delayChecks = true; h.success(file);
  const result = await h.registry.finish({ runId: 'run-a', finalText: '[report](' + file + ')' });
  assert.equal(result.complete, false); const saved = JSON.stringify(h.registry.snapshot('run-a'));
  await new Promise(resolve => setTimeout(resolve, 110)); assert.equal(JSON.stringify(h.registry.snapshot('run-a')), saved);
  assert.ok(updates.every(update => update.status === 'complete'));
});
test('parallel begin during a pending delta check prevents file attribution', async t => {
  let pauseFile = null, release, entered;
  const pause = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { entered = resolve; });
  const h = await fixture(t, { fileSystem: { ...fs.promises, lstat: async file => { if (file === pauseFile) { entered(); await pause; } return fs.promises.lstat(file); } } });
  await h.write('project/outputs/old.md'); await h.registry.begin(h.input);
  pauseFile = await h.write('project/outputs/report.md'); const finishing = h.registry.finish({ runId: 'run-a' }); await arrived;
  await h.registry.begin({ ...h.input, runId: 'run-b', conversationId: 'conversation-b' }); release();
  assert.deepEqual(names(await finishing), []); assert.deepEqual(names(await h.registry.finish({ runId: 'run-b' })), []);
});

test('project report with outputDir equal to cwd publishes before final text without scanning the project', async t => {
  const updates = [], scanned = [];
  const h = await fixture(t, { onUpdate: value => updates.push(value), fileSystem: { ...fs.promises,
    opendir: async directory => { scanned.push(directory); return fs.promises.opendir(directory); } } });
  await h.registry.begin(h.input);
  const file = await h.write('project/reports/report.md'); h.success(file);
  for (let i = 0; i < 100 && !updates.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(updates.at(-1)?.status, 'running'); assert.deepEqual(names(updates.at(-1)), ['report.md']);
  assert.equal(updates.at(-1).items[0].source, 'write-tool'); assert.equal(updates.at(-1).items[0].toolUseId, 'write-1');
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a' })), ['report.md']);
  assert.deepEqual(scanned, []); assert.equal(fs.existsSync(path.join(h.cwd, 'outputs')), false);
});
test('successful project documents media and archives qualify without making source config or guidance files implicit handoffs', async t => {
  const h = await fixture(t); await h.registry.begin(h.input);
  const deliver = ['report.pdf', 'security.pdf', 'slides.pptx', 'table.xlsx', 'data.csv', 'report.html', 'diagram.png', 'recording.mp4', 'bundle.zip'];
  const internal = ['app.js', 'component.tsx', 'script.py', 'settings.json', 'config.yaml', 'AGENTS.md', 'CLAUDE.local.md', 'SKILL.md',
    'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'LICENSE.md', 'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md'];
  for (const [index, name] of [...deliver, ...internal].entries()) h.success(await h.write('project/reports/' + name), { id: 'write-' + index });
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a' })), deliver.sort());
});
test('document files without a successful owned receipt do not become automatic project deliveries', async t => {
  const h = await fixture(t); await h.registry.begin(h.input); const existing = await h.write('project/reports/existing.md');
  h.success(await h.write('project/reports/failed.pdf'), { id: 'failed', failed: true });
  h.registry.observe({ runId: 'run-a', event: { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'unfinished', name: 'Write', input: { file_path: existing } },
  ] } } });
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a' })), []);
});
test('disabling directory scans does not disable receipt-backed document registration', async t => {
  const h = await fixture(t); await h.registry.begin({ ...h.input, allowOutputScan: false });
  h.success(await h.write('project/reports/report.md'));
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a' })), ['report.md']);
});
test('successful documents outside the declared output root remain candidates until explicitly selected', async t => {
  const h = await fixture(t); const outputDir = path.join(h.cwd, 'deliveries'); await fs.promises.mkdir(outputDir);
  await h.registry.begin({ ...h.input, outputDir }); h.success(await h.write('project/reports/report.md'));
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a' })), []);
});
test('linked project subdirectories cannot turn external successful files into automatic project handoffs', async t => {
  const h = await fixture(t); const external = path.join(h.root, 'external'); await fs.promises.mkdir(external);
  await h.write('external/report.md'); const linked = path.join(h.cwd, 'reports');
  try { await fs.promises.symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host cannot create fixture links'); throw error; }
  await h.registry.begin(h.input); h.success(path.join(linked, 'report.md'));
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a' })), []);
});
test('guidance files are excluded from automatic outputs receipt and delta paths but explicit references remain possible', async t => {
  const h = await fixture(t); await h.registry.begin(h.input);
  const guide = await h.write('project/outputs/README.md'); h.success(guide);
  await h.write('project/outputs/CLAUDE.md'); await h.write('project/outputs/report.pdf');
  assert.deepEqual(names(await h.registry.finish({ runId: 'run-a', finalText: link(guide) })), ['README.md', 'report.pdf']);
});

for (const allowOutputScan of [true, false]) test('scratch directory aliases remain excluded with ' + (allowOutputScan ? 'missing outputs' : 'directory scans disabled'), async t => {
  const updates = [], resolutions = [];
  const h = await fixture(t, { onUpdate: value => updates.push(value), fileSystem: { ...fs.promises,
    realpath: async file => { resolutions.push(file); return fs.promises.realpath(file); } } });
  const temporary = path.join(h.cwd, 'temporary'), alias = path.join(h.root, 'scratch-alias');
  await fs.promises.mkdir(temporary);
  try { await fs.promises.symlink(temporary, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host cannot create fixture links'); throw error; }
  await h.registry.begin({ ...h.input, previousScratchDirs: [alias], allowOutputScan });
  assert.equal(resolutions.includes(alias), false, 'no extra scratch lookup on a greeting startup');
  const temporaryFile = await h.write('project/temporary/process.md'); h.success(temporaryFile);
  const report = await h.write('project/reports/report.md'); h.success(report, { id: 'report' });
  const result = await h.registry.finish({ runId: 'run-a', finalText: link(temporaryFile) });
  assert.deepEqual(names(result), ['report.md']); assert.ok(updates.every(update => names(update).every(name => name === 'report.md')));
  assert.equal(resolutions.filter(file => file === alias).length, 1, 'resolved scratch aliases are cached across file checks');
  assert.equal(fs.existsSync(path.join(h.cwd, 'outputs')), false);
});
