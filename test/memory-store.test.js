'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MemoryStore, guardMemoryToolInput } = require('../src/main/memory/memory-store');
const { parseMemoryDocument, memoryEligibility, serializeMemoryFrontmatter } = require('../src/main/memory/memory-schema');

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemoryStore({ dir, ...options });
}
function document(meta, body = 'fixture memory') { return `${serializeMemoryFrontmatter(meta)}\n${body}`; }
function code(expected) { return (error) => error.code === expected; }
function source(overrides = {}) {
  return { kind: 'conversation', conversationId: 'conversation-1', turnId: 'turn-1', turnIndex: 0, role: 'user',
    quote: 'Please verify the result.', at: '2026-10-21T01:00:00Z', revision: 'a'.repeat(64), ...overrides };
}
function learned(store, candidate = {}, options = {}) {
  return store.proposeLearning({ file: 'learned.md', name: 'verification', description: 'Verify outputs', type: 'feedback',
    body: 'Verify the result before reporting success.', sources: [source()], ...candidate }, options);
}

function revision(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function recovery(store) {
  return fs.existsSync(store.recoveryPath) ? JSON.parse(fs.readFileSync(store.recoveryPath, 'utf8'))
    : { format: 1, archives: [], undo: null, pending: null };
}
function recoverySnapshot(store) { return JSON.stringify(recovery(store)); }
function writeRecovery(store, state) {
  fs.writeFileSync(store.recoveryPath, JSON.stringify({ format: 1, archives: [], undo: null, pending: null, ...state }));
}
function legacyRecord(store, record, { mtimeMs } = {}) {
  const dir = path.join(store.dir, '.history');
  fs.mkdirSync(dir, { recursive: true });
  const id = record.id || crypto.randomUUID();
  const abs = path.join(dir, `${id}.json`);
  fs.writeFileSync(abs, JSON.stringify({ id, createdAt: '2026-10-21T00:00:00.000Z', state: 'committed',
    operation: 'write', actor: 'user', ...record }));
  if (mtimeMs !== undefined) fs.utimesSync(abs, new Date(mtimeMs), new Date(mtimeMs));
  return { id, abs };
}
function assertNoLegacyHistory(store) { assert.equal(fs.existsSync(path.join(store.dir, '.history')), false); }

test('new model writes require a valid explicit type and reject conflicting or malformed declarations without mutations', (t) => {
  const store = fixture(t);
  for (const [content, options] of [
    ['Synthetic fact.', {}],
    ['---\nmetadata:\n  type: feedback\n---\nLegacy metadata alone is insufficient for new writes.', {}],
    ['Synthetic fact.', { memoryType: 'unsupported' }],
    ['Synthetic fact.', { memoryType: null }],
    [document({ type: 'feedback' }), { memoryType: 'project' }],
    ['---\nmetadata:\n  type: feedback\n---\nSynthetic fact.', { memoryType: 'project' }],
    ['---\ntype: unsupported\n---\nSynthetic fact.', { memoryType: 'feedback' }],
  ]) {
    assert.throws(() => store.write('candidate.md', content, { actor: 'model', ...options }), code('MEMORY_SCHEMA'));
  }
  assert.deepEqual(store.list(), []);
  assert.deepEqual(recovery(store).archives, []);
  assert.equal(recovery(store).undo, null);
  const structured = store.write('reference-name.md', 'Always verify the result.', { actor: 'model', memoryType: 'feedback' });
  assert.equal(structured.meta.type, 'feedback');
  assert.match(structured.content, /^type: feedback$/m);
  const inContent = store.write('project.md', document({ type: 'project' }), { actor: 'model' });
  assert.equal(inContent.meta.type, 'project');
  assert.equal(inContent.meta.scope, 'global');
  const both = store.write('user.md', document({ type: 'user' }), { actor: 'model', memoryType: 'user' });
  assert.equal(both.meta.type, 'user');
  const nested = store.write('legacy-candidate.md', '---\nmetadata:\n  type: project\n---\nProject relationship.', { actor: 'model', memoryType: 'project' });
  assert.equal(nested.meta.type, 'project');
  assert.doesNotMatch(nested.content, /metadata:/);
});

test('replacements of legacy memories also require explicit type and keep the old fact untouched on failure', (t) => {
  const store = fixture(t);
  const original = store.write('legacy.md', 'Original legacy fact.');
  assert.equal(original.meta.type, null);
  const recordsBefore = recoverySnapshot(store);
  for (const operation of ['write', 'propose']) {
    assert.throws(() => store[operation](original.file, 'New fact.', { actor: 'model', expectedRevision: original.revision }), code('MEMORY_SCHEMA'));
  }
  assert.equal(store.read(original.file).revision, original.revision);
  assert.equal(recoverySnapshot(store), recordsBefore);
  assert.deepEqual(store.list().map(item => item.file), [original.file]);
});

test('legacy prose stays active while malformed or inferred metadata never becomes injectable', (t) => {
  const store = fixture(t);
  store.write('legacy.md', 'A legacy preference without frontmatter.');
  assert.equal(store.list({}, { actor: 'model' }).length, 1);
  assert.equal(memoryEligibility(parseMemoryDocument('---\nstatus: typo\n---\nbody').meta).eligible, false);
  assert.equal(memoryEligibility(parseMemoryDocument('---\nstatus: active\nconfidence: inferred\n---\nbody').meta).eligible, false);
  assert.equal(memoryEligibility(parseMemoryDocument('---\nexpires_at: never\n---\nbody').meta).eligible, false);
  assert.equal(memoryEligibility(parseMemoryDocument('---\nscope: global\nscope: project\n---\nbody').meta).eligible, false);
});

test('YAML metadata survives quoted punctuation, leading markers and camelCase legacy aliases', () => {
  const meta = { name: '[test]', description: 'line one\nline "two": #foo', sourceRef: 'conv: "special"', scope: 'project', projectId: '001', status: 'active' };
  const parsed = parseMemoryDocument(document(meta));
  assert.equal(parsed.meta.description, meta.description);
  assert.equal(parsed.meta.projectId, '001');
  assert.equal(parsed.meta.sourceRef, meta.sourceRef);
  assert.equal(memoryEligibility(parsed.meta, { projectId: '001' }).eligible, true);
  assert.equal(parseMemoryDocument('---\nscope: project\nprojectId: old\n---\nbody').meta.projectId, 'old');
});

test('legacy field diagnostics survive list and archive without rewriting old memories', (t) => {
  const store = fixture(t);
  const content = '---\nname: legacy-note\n---\nunchanged legacy body';
  const written = store.write('legacy-note.md', content);
  assert.deepEqual(written.legacyFields, ['scope', 'status', 'confidence']);
  assert.deepEqual(store.list()[0].legacyFields, written.legacyFields);
  assert.equal(store.read('legacy-note.md').content, content);
  store.archive('legacy-note.md', { expectedRevision: written.revision });
  assert.deepEqual(store.archived()[0].legacyFields, written.legacyFields);
  // A failed YAML parse is an error, not evidence of an old compatible format.
  fs.writeFileSync(path.join(store.dir, 'bad.md'), '---\ndescription: "quoted"unquoted\n---\nbody');
  assert.deepEqual(store.read('bad.md').legacyFields, []);
});

test('read-only inspection reports pending recovery without changing memories or recovery data', (t) => {
  const store = fixture(t);
  store.write('pending.md', 'before');
  writeRecovery(store, { pending: { operation: 'write', changes: [{ file: 'pending.md', before: 'before', afterRevision: revision('partial') }] } });
  const raw = fs.readFileSync(store.recoveryPath, 'utf8');
  fs.writeFileSync(path.join(store.dir, 'pending.md'), 'partial');
  assert.throws(() => store.list({}, { readOnly: true }), code('MEMORY_RECOVERY_REQUIRED'));
  assert.equal(fs.readFileSync(path.join(store.dir, 'pending.md'), 'utf8'), 'partial');
  assert.equal(fs.readFileSync(store.recoveryPath, 'utf8'), raw);
  assert.equal(fs.existsSync(store.lockPath), false);
  assert.equal(store.read('pending.md').content, 'before');
  assert.equal(recovery(store).pending, null);
});

test('model writes receive host scope and provenance and cannot forge confirmation, core or replacement links', (t) => {
  const store = fixture(t);
  const saved = store.write('candidate.md', document({ status: 'active', confidence: 'user_confirmed', core: true, scope: 'global', sourceRef: 'forged', supersedes: 'other.md' }), {
    actor: 'model', memoryType: 'reference', context: { projectId: 'project-a', sourceRef: 'conv:trusted' }, expectedRevision: null,
  });
  assert.equal(saved.meta.status, 'draft');
  assert.equal(saved.meta.confidence, 'inferred');
  assert.equal(saved.meta.core, false);
  assert.equal(saved.meta.scope, 'project');
  assert.equal(saved.meta.projectId, 'project-a');
  assert.equal(saved.meta.sourceRef, 'conv:trusted');
  assert.equal(saved.meta.supersedes, null);
  assert.equal(store.list({ projectId: 'project-a' }, { actor: 'model' }).length, 0);
  const confirmed = store.write('explicit.md', 'Explicit remember request', { actor: 'model', memoryType: 'reference', userConfirmed: true, context: { projectId: 'project-a' } });
  assert.equal(confirmed.meta.status, 'active');
  assert.equal(confirmed.meta.confidence, 'user_confirmed');
});

test('project filtering applies to both lists and file reads without suppressing global legacy memory', (t) => {
  const store = fixture(t);
  store.write('global.md', 'global legacy');
  store.write('a.md', document({ scope: 'project', projectId: 'a' }));
  store.write('b.md', document({ scope: 'project', projectId: 'b' }));
  assert.deepEqual(store.list({ projectId: 'a' }, { actor: 'model' }).map((item) => item.file).sort(), ['a.md', 'global.md']);
  assert.deepEqual(store.list({}, { actor: 'model' }).map((item) => item.file), ['global.md']);
  assert.throws(() => store.read('b.md', { actor: 'model', context: { projectId: 'a' } }), code('MEMORY_SCOPE'));
  assert.throws(() => store.write('b.md', 'changed', { actor: 'model', memoryType: 'reference', context: { projectId: 'a' } }), code('MEMORY_SCOPE'));
});

test('confirmed model updates become proposals and approval retires the exact original revision', (t) => {
  const store = fixture(t);
  const original = store.write('preference.md', 'original confirmed preference');
  const proposal = store.write('preference.md', 'proposed replacement', { actor: 'model', memoryType: 'reference', expectedRevision: original.revision });
  assert.notEqual(proposal.file, original.file);
  assert.equal(proposal.meta.supersedesRevision, original.revision);
  assert.equal(store.read(original.file).revision, original.revision);
  assert.equal(proposal.meta.status, 'draft');
  const approved = store.setStatus(proposal.file, 'active');
  assert.equal(approved.meta.confidence, 'user_confirmed');
  assert.equal(store.read(original.file).meta.status, 'superseded');
  assert.deepEqual(store.list({}, { actor: 'model' }).map((item) => item.file), [proposal.file]);
  assert.equal(store.setStatus(proposal.file, 'active').revision, approved.revision);
});

test('stale writes and approval after an intervening edit cannot silently overwrite newer facts', (t) => {
  const store = fixture(t);
  const initial = store.write('item.md', 'v1');
  const proposal = store.propose('item.md', 'proposed', { actor: 'model', memoryType: 'reference', expectedRevision: initial.revision });
  const updated = store.write('item.md', 'v2', { expectedRevision: initial.revision });
  assert.throws(() => store.write('item.md', 'stale', { expectedRevision: initial.revision }), code('MEMORY_CONFLICT'));
  assert.throws(() => store.setStatus(proposal.file, 'active'), code('MEMORY_CONFLICT'));
  assert.equal(store.read('item.md').revision, updated.revision);
  assert.equal(store.read(proposal.file).meta.status, 'draft');
});

test('ordinary writes retain no versions and only removed memories have restorable recovery data', (t) => {
  const store = fixture(t);
  const first = store.write('item.md', 'v1');
  const changed = store.write('item.md', 'v2');
  assert.equal(first.versionId, undefined);
  assert.equal(changed.versionId, undefined);
  assert.equal(typeof store.history, 'undefined');
  assert.equal(typeof store.restore, 'undefined');
  assert.equal(store.historyDir, undefined);
  assert.equal(recovery(store).undo, null);
  assert.deepEqual(recovery(store).archives, []);
  assert.doesNotMatch(recoverySnapshot(store), /v1/);
  assertNoLegacyHistory(store);
  const archived = store.archive('item.md');
  assert.equal(typeof archived.archiveId, 'string');
  assert.throws(() => store.read('item.md'), code('MEMORY_NOT_FOUND'));
  assert.equal(store.restoreArchived('item.md', archived.archiveId).content, 'v2');
  assert.deepEqual(store.archived(), []);
  store.write('retained.md', 'keep');
  const removed = store.remove('item.md');
  assert.equal(typeof removed.archiveId, 'string');
  store.purgeArchived('item.md', { expectedArchiveId: removed.archiveId });
  assert.deepEqual(recovery(store).archives, []);
  assert.doesNotMatch(recoverySnapshot(store), /v1|v2/);
  assert.equal(store.read('retained.md').content, 'keep');
});

test('model cannot approve, archive, undo, restore or inspect removed memories', (t) => {
  const store = fixture(t);
  store.write('item.md', 'confirmed');
  for (const operation of [() => store.setStatus('item.md', 'active', { actor: 'model' }),
    () => store.archive('item.md', { actor: 'model' }), () => store.remove('item.md', { actor: 'model', permanent: true }),
    () => store.archived({ actor: 'model' }), () => store.restoreArchived('item.md', 'x', { actor: 'model' }),
    () => store.undo('item.md', 'x', { actor: 'model' }),
    () => store.purgeArchived('item.md', { actor: 'model', expectedArchiveId: 'x' })]) {
    assert.throws(operation, code('MEMORY_PERMISSION'));
  }
});

test('memory paths and generated index are protected, including Windows device and ADS spellings', (t) => {
  const store = fixture(t);
  for (const name of ['../escape.md', 'nested/item.md', 'nested\\item.md', 'C:\\escape.md', 'x:stream.md', '.history.md', 'CON.md', 'item .md']) {
    assert.throws(() => store.write(name, 'bad'), code('MEMORY_PATH'));
  }
  assert.throws(() => store.write('MEMORY.md', 'model index'), code('MEMORY_INDEX'));
  assert.throws(() => store.archive('memory.md'), code('MEMORY_INDEX'));
  store.writeIndex('host-generated index');
  assert.equal(fs.readFileSync(path.join(store.dir, 'MEMORY.md'), 'utf8'), 'host-generated index');
  store.writeIndex('');
  assert.equal(fs.existsSync(path.join(store.dir, 'MEMORY.md')), false);
});

test('interrupted approval transactions recover every participant and clear the bounded pending journal', (t) => {
  const store = fixture(t);
  store.write('original.md', 'before');
  store.write('proposal.md', 'draft');
  writeRecovery(store, { pending: { operation: 'write', changes: [
    { file: 'original.md', before: 'before', afterRevision: revision('retired') },
    { file: 'proposal.md', before: 'draft', afterRevision: revision('approved') },
    { file: 'new.md', before: null, afterRevision: revision('new partial') },
  ] } });
  fs.writeFileSync(path.join(store.dir, 'original.md'), 'retired');
  fs.writeFileSync(path.join(store.dir, 'new.md'), 'new partial');
  const restarted = new MemoryStore({ dir: store.dir });
  assert.equal(restarted.read('original.md').content, 'before');
  assert.equal(restarted.read('proposal.md').content, 'draft');
  assert.equal(fs.existsSync(path.join(store.dir, 'new.md')), false);
  assert.equal(recovery(store).pending, null);
  assert.deepEqual(recovery(store).archives, []);
  assertNoLegacyHistory(store);
});

test('failed approval leaves both memories unchanged without retaining a partial undo token', (t) => {
  const store = fixture(t);
  const original = store.write('original.md', 'confirmed');
  const proposed = store.propose('original.md', 'candidate', { actor: 'model', memoryType: 'reference' });
  const atomic = store._atomic.bind(store);
  let failed = false;
  store._atomic = (abs, content) => {
    if (!failed && abs === path.join(store.dir, proposed.file) && /status: active/.test(content)) {
      failed = true; throw new Error('simulated disk failure');
    }
    return atomic(abs, content);
  };
  assert.throws(() => store.setStatus(proposed.file, 'active'), /simulated disk failure/);
  assert.equal(store.read('original.md').revision, original.revision);
  assert.equal(store.read(proposed.file).revision, proposed.revision);
  assert.equal(recovery(store).pending, null);
  assert.equal(recovery(store).undo, null);
});

test('a competing live writer is rejected and unique atomic files leave no shared temporary residue', (t) => {
  const store = fixture(t);
  fs.writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid }));
  assert.throws(() => store.write('item.md', 'blocked'), code('MEMORY_BUSY'));
  fs.unlinkSync(store.lockPath);
  store.write('item.md', 'first');
  const other = new MemoryStore({ dir: store.dir });
  const read = other.read('item.md');
  store.write('item.md', 'second', { expectedRevision: read.revision });
  assert.throws(() => other.write('item.md', 'stale third', { expectedRevision: read.revision }), code('MEMORY_CONFLICT'));
  assert.equal(fs.readdirSync(store.dir).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('guard covers direct and recursive access, SDK memory and index writes while allowing unrelated tools', (t) => {
  const store = fixture(t);
  const options = { memoryDir: store.dir, cwd: path.dirname(store.dir) };
  for (const name of ['Read', 'Write', 'Edit', 'MultiEdit']) {
    assert.equal(guardMemoryToolInput(name, { file_path: path.join(store.dir, 'a.md') }, options).behavior, 'deny');
  }
  assert.equal(guardMemoryToolInput('Grep', { path: path.dirname(store.dir) }, options).behavior, 'deny');
  assert.equal(guardMemoryToolInput('Glob', { path: path.join(os.tmpdir(), 'unrelated'), pattern: path.join(store.dir, '*.md') }, options).behavior, 'deny');
  assert.equal(guardMemoryToolInput('Write', { file_path: path.join(os.tmpdir(), '.claude/projects/fixture/memory/fact.md') }, options).behavior, 'deny');
  assert.equal(guardMemoryToolInput('Write', { file_path: path.join(os.tmpdir(), 'MEMORY.md') }, options), null);
  assert.equal(guardMemoryToolInput('Read', { file_path: path.join(os.tmpdir(), 'code.js') }, options), null);
  assert.equal(guardMemoryToolInput('Bash', { command: 'echo hello' }, options), null);
});

test('global replacement proposals keep their original scope even when suggested inside a project', (t) => {
  const store = fixture(t);
  store.write('global.md', 'original global');
  const proposed = store.write('global.md', 'proposed global', { actor: 'model', memoryType: 'reference', context: { projectId: 'a' } });
  assert.equal(proposed.meta.scope, 'global');
  assert.equal(proposed.meta.projectId, null);
  const edited = store.write(proposed.file, 'revised proposed global', { actor: 'model', memoryType: 'reference', context: { projectId: 'a' } });
  assert.equal(edited.meta.scope, 'global');
  assert.equal(edited.meta.supersedesRevision, proposed.meta.supersedesRevision);
  store.setStatus(proposed.file, 'active');
  assert.equal(store.read(proposed.file).meta.scope, 'global');
});

test('Windows guard recognizes WSL drive mounts and case aliases', () => {
  const options = { memoryDir: 'C:\\relay-fixture\\memory', cwd: 'C:\\relay-fixture\\project' };
  assert.equal(guardMemoryToolInput('Write', { file_path: '/mnt/c/relay-fixture/memory/item.md' }, options).behavior, 'deny');
  assert.equal(guardMemoryToolInput('Read', { file_path: 'c:/RELAY-FIXTURE/MEMORY/item.md' }, options).behavior, 'deny');
  assert.equal(guardMemoryToolInput('Write', { file_path: '/mnt/d/relay-fixture/memory/item.md' }, options), null);
});

test('guard resolves directory aliases before allowing access to the memory library', (t) => {
  const store = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-alias-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const alias = path.join(outside, 'alias');
  fs.symlinkSync(store.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(guardMemoryToolInput('Write', { file_path: path.join(alias, 'new.md') }, { memoryDir: store.dir }).behavior, 'deny');
  assert.equal(guardMemoryToolInput('Grep', { path: alias }, { memoryDir: store.dir }).behavior, 'deny');
});

test('Windows case aliases share one current file and one removable recovery entry', { skip: process.platform !== 'win32' }, (t) => {
  const store = fixture(t);
  store.write('MixedCase.md', 'original');
  store.write('mixedcase.md', 'replacement');
  const archived = store.archive('MIXEDCASE.md');
  assert.equal(store.archived().length, 1);
  assert.equal(store.restoreArchived('MixedCase.md', archived.archiveId).content, 'replacement');
  const removed = store.archive('mixedcase.md');
  store.purgeArchived('MIXEDCASE.md', { expectedArchiveId: removed.archiveId });
  assert.deepEqual(store.archived(), []);
  assert.equal(fs.existsSync(path.join(store.dir, 'mixedcase.md')), false);
  assertNoLegacyHistory(store);
});

test('linked memory files cannot read or overwrite an outside target', (t) => {
  const store = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'private.md');
  fs.writeFileSync(target, 'outside');
  fs.linkSync(target, path.join(store.dir, 'linked.md'));
  assert.throws(() => store.read('linked.md'), code('MEMORY_PATH'));
  assert.throws(() => store.write('linked.md', 'changed'), code('MEMORY_PATH'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside');
});

test('archived listing exposes restorable removals and hides restored or recreated live files', (t) => {
  const store = fixture(t);
  store.write('removed.md', document({ name: 'removed-fact', scope: 'project', projectId: 'a' }, 'saved fact'));
  store.write('live.md', 'still present');
  const archived = store.archive('removed.md');
  const rows = store.archived();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'removed.md');
  assert.equal(rows[0].archiveId, archived.archiveId);
  assert.equal(rows[0].meta.name, 'removed-fact');
  assert.equal(rows[0].meta.projectId, 'a');
  assert.equal(typeof rows[0].createdAt, 'string');
  assert.throws(() => store.archived({ actor: 'model' }), code('MEMORY_PERMISSION'));
  store.restoreArchived('removed.md', rows[0].archiveId);
  assert.deepEqual(store.archived(), []);
  const hidden = store.archive('removed.md');
  store.write('removed.md', 'recreated');
  assert.deepEqual(store.archived(), []);
  // A conflicting new file hides the old removal without destroying its recovery data.
  assert.equal(recovery(store).archives[0].id, hidden.archiveId);
  fs.unlinkSync(path.join(store.dir, 'removed.md'));
  assert.equal(store.archived()[0].archiveId, hidden.archiveId);
  assert.match(store.restoreArchived('removed.md', hidden.archiveId).content, /saved fact$/);
});

test('archived listing selects the newest removal without retaining earlier removed content', (t) => {
  const store = fixture(t);
  store.write('item.md', 'v1');
  store.archive('item.md');
  store.write('item.md', 'v2');
  const latest = store.archive('item.md');
  assert.equal(store.archived()[0].archiveId, latest.archiveId);
  store.purgeArchived('item.md', { expectedArchiveId: latest.archiveId });
  assert.deepEqual(store.archived(), []);
});

test('identical model proposals reuse one draft without creating recovery snapshots', (t) => {
  const store = fixture(t);
  const original = store.write('item.md', 'original');
  const options = { actor: 'model', memoryType: 'reference', expectedRevision: original.revision, context: { projectId: 'a', sourceRef: 'conv:fixture' } };
  const first = store.write('item.md', 'same proposed fact', options);
  const historyCount = recoverySnapshot(store);
  const repeated = store.write('item.md', 'same proposed fact', options);
  assert.equal(repeated.file, first.file);
  assert.equal(repeated.versionId, undefined);
  assert.equal(repeated.revision, first.revision);
  assert.equal(repeated.deduplicated, true);
  assert.equal(recoverySnapshot(store), historyCount);
  assert.equal(store.list().filter((item) => item.meta.status === 'draft').length, 1);
  const different = store.write('item.md', 'different proposed fact', options);
  assert.notEqual(different.file, first.file);
  store.archive(first.file);
  const afterArchive = store.write('item.md', 'same proposed fact', options);
  assert.notEqual(afterArchive.file, first.file);
  assert.equal(store.read('item.md').revision, original.revision);
});

test('an identical candidate after the original changes tracks its new revision', (t) => {
  const store = fixture(t);
  store.write('item.md', 'original');
  const first = store.write('item.md', 'proposed', { actor: 'model', memoryType: 'reference' });
  const updated = store.write('item.md', 'user edit');
  const second = store.write('item.md', 'proposed', { actor: 'model', memoryType: 'reference' });
  assert.notEqual(second.file, first.file);
  assert.equal(second.meta.supersedesRevision, updated.revision);
});

test('approval undo restores every linked participant once without creating redo history', (t) => {
  const store = fixture(t);
  const original = store.write('original.md', 'original confirmed fact');
  const candidate = store.write(original.file, 'new proposed fact', { actor: 'model', memoryType: 'reference' });
  const approved = store.setStatus(candidate.file, 'active');
  assert.equal(typeof approved.undoId, 'string');
  assert.ok(Number.isFinite(Date.parse(approved.undoExpiresAt)));
  assert.equal(approved.versionId, undefined);
  const restored = store.undo(candidate.file, approved.undoId, { expectedRevision: approved.revision });
  assert.deepEqual(restored.restoredFiles.sort(), [original.file, candidate.file].sort());
  assert.equal(store.read(original.file).revision, original.revision);
  assert.equal(store.read(candidate.file).revision, candidate.revision);
  assert.deepEqual(store.list({}, { actor: 'model' }).map(item => item.file), [original.file]);
  assert.equal(restored.undoId, undefined);
  assert.equal(recovery(store).undo, null);
  assert.throws(() => store.undo(candidate.file, approved.undoId), code('MEMORY_UNDO_EXPIRED'));
  assertNoLegacyHistory(store);
});

for (const participant of ['candidate', 'original']) {
  test(`approval undo rejects a later edit to the ${participant} without partial changes`, (t) => {
    const store = fixture(t);
    const original = store.write('original.md', 'original');
    const candidate = store.write(original.file, 'candidate', { actor: 'model', memoryType: 'reference' });
    const approved = store.setStatus(candidate.file, 'active');
    store.write(participant === 'candidate' ? candidate.file : original.file, 'later user edit');
    const before = store.list().map(item => ({ file: item.file, revision: item.revision }));
    assert.throws(() => store.undo(candidate.file, approved.undoId,
      { expectedRevision: store.read(candidate.file).revision }), code('MEMORY_UNDO_EXPIRED'));
    assert.deepEqual(store.list().map(item => ({ file: item.file, revision: item.revision })), before);
  });
}

test('undo checks the action file, token, caller revision and every linked participant', (t) => {
  const store = fixture(t);
  const original = store.write('original.md', 'original');
  const candidate = store.write(original.file, 'candidate', { actor: 'model', memoryType: 'reference' });
  const approved = store.setStatus(candidate.file, 'active');
  assert.throws(() => store.undo(candidate.file, 'incorrect-token'), code('MEMORY_CONFLICT'));
  assert.throws(() => store.undo(original.file, approved.undoId), code('MEMORY_CONFLICT'));
  assert.throws(() => store.undo(candidate.file, approved.undoId, { expectedRevision: candidate.revision }), code('MEMORY_CONFLICT'));
  store.archive(original.file);
  assert.throws(() => store.undo(candidate.file, approved.undoId, { expectedRevision: approved.revision }), code('MEMORY_UNDO_EXPIRED'));
  assert.equal(store.read(candidate.file).revision, approved.revision);
  assert.throws(() => store.read(original.file), code('MEMORY_NOT_FOUND'));
});

test('only the latest approval or ignore action can be undone and ordinary edits do not create tokens', (t) => {
  const store = fixture(t);
  const first = learned(store, { file: 'first.md' });
  const second = learned(store, { file: 'second.md', sources: [source({ conversationId: 'second' })] });
  const approved = store.setStatus(first.file, 'active');
  const ignored = store.setStatus(second.file, 'expired');
  assert.notEqual(approved.undoId, ignored.undoId);
  assert.throws(() => store.undo(first.file, approved.undoId), code('MEMORY_CONFLICT'));
  const unrelated = store.write('unrelated.md', 'Unrelated fact.');
  assert.equal(unrelated.undoId, undefined);
  store.undo(second.file, ignored.undoId, { expectedRevision: ignored.revision });
  assert.equal(store.read(second.file).revision, second.revision);
  assert.equal(store.read(first.file).revision, approved.revision);
  assert.equal(store.read(unrelated.file).revision, unrelated.revision);
  assert.equal(recovery(store).undo, null);
});

test('undo is available before the five-minute deadline and expires at the deadline across restart', (t) => {
  let now = Date.parse('2026-10-22T00:00:00Z');
  const store = fixture(t, { now: () => now });
  const candidate = learned(store);
  const approved = store.setStatus(candidate.file, 'active');
  assert.equal(Date.parse(approved.undoExpiresAt), now + 5 * 60 * 1000);
  now += 5 * 60 * 1000 - 1;
  const restarted = new MemoryStore({ dir: store.dir, now: () => now });
  restarted.undo(candidate.file, approved.undoId, { expectedRevision: approved.revision });
  const ignored = restarted.setStatus(candidate.file, 'expired');
  now += 5 * 60 * 1000;
  const expired = new MemoryStore({ dir: store.dir, now: () => now });
  assert.throws(() => expired.undo(candidate.file, ignored.undoId), code('MEMORY_UNDO_EXPIRED'));
  assert.equal(expired.read(candidate.file).revision, ignored.revision);
  assert.equal(recovery(store).undo, null);
});

test('host learning creates scoped evidence-backed drafts and deterministic repeats never overwrite files', (t) => {
  const store = fixture(t);
  const options = { context: { projectId: 'a' } };
  const candidate = learned(store, {}, options);
  assert.equal(candidate.meta.scope, 'project');
  assert.equal(candidate.meta.projectId, 'a');
  assert.equal(candidate.meta.status, 'draft');
  assert.equal(candidate.meta.confidence, 'inferred');
  assert.deepEqual(candidate.meta.sources, [source()]);
  assert.deepEqual(store.list({ projectId: 'a' }, { actor: 'model' }), []);
  const count = recoverySnapshot(store);
  const repeat = learned(store, {}, options);
  assert.equal(repeat.deduplicated, true);
  assert.equal(repeat.versionId, undefined);
  assert.equal(repeat.revision, candidate.revision);
  assert.throws(() => learned(store, { body: 'A different candidate.' }, options), code('MEMORY_CONFLICT'));
  assert.equal(store.read(candidate.file).revision, candidate.revision);
  assert.equal(recoverySnapshot(store), count);
  assert.throws(() => learned(store, { file: 'missing-source.md', sources: [] }), code('MEMORY_SCHEMA'));
});

test('ordinary model writes cannot forge structured sources or replacement links and keep inherited evidence', (t) => {
  const store = fixture(t);
  const original = learned(store);
  store.setStatus(original.file, 'active');
  const host = source({ conversationId: 'conversation-2', turnId: 'turn-2', quote: 'Also check the saved file.' });
  const fake = source({ conversationId: 'forged' });
  const proposed = store.write(original.file, document({ type: 'feedback', sources: [fake],
    replaces: [{ file: 'unrelated.md', revision: 'f'.repeat(64) }] }, 'Updated rule.'),
  { actor: 'model', context: { sources: [host] } });
  assert.equal(proposed.meta.sources.some((item) => item.conversationId === 'forged'), false);
  assert.ok(proposed.meta.sources.some((item) => item.conversationId === source().conversationId));
  assert.ok(proposed.meta.sources.some((item) => item.conversationId === host.conversationId));
  assert.deepEqual(proposed.meta.replaces.map((item) => item.file), [original.file]);
  const updated = store.write(proposed.file, document({ type: 'feedback', sources: [fake] }, 'Another draft edit.'), { actor: 'model' });
  assert.deepEqual(updated.meta.sources, proposed.meta.sources);
  assert.deepEqual(updated.meta.replaces, proposed.meta.replaces);
  const fresh = store.write('fresh.md', document({ type: 'reference', sources: [fake],
    replaces: [{ file: original.file, revision: original.revision }] }, 'Another fact.'), { actor: 'model' });
  assert.deepEqual(fresh.meta.sources, []);
  assert.deepEqual(fresh.meta.replaces, []);
});

test('manual edits preserve host evidence and linked approval metadata through confirmation and undo', (t) => {
  const store = fixture(t);
  const original = store.write('old.md', document({ type: 'feedback' }, 'Old rule.'));
  const candidate = learned(store, { replaces: [{ file: original.file, revision: original.revision }] });
  const edited = store.write(candidate.file, 'Edited body without frontmatter.');
  assert.deepEqual(edited.meta.sources, candidate.meta.sources);
  assert.deepEqual(edited.meta.replaces, candidate.meta.replaces);
  assert.equal(edited.meta.status, 'draft');
  const approved = store.setStatus(candidate.file, 'active');
  assert.deepEqual(approved.meta.sources, candidate.meta.sources);
  assert.equal(store.read(original.file).meta.status, 'superseded');
  store.undo(candidate.file, approved.undoId, { expectedRevision: approved.revision });
  assert.deepEqual(store.read(candidate.file).meta.sources, candidate.meta.sources);
  assert.equal(store.read(original.file).revision, original.revision);
});

test('multi-memory approval and undo are a single linked transaction with all sources preserved', (t) => {
  const store = fixture(t);
  const first = store.write('first.md', document({ type: 'feedback' }, 'Verify before reporting.'));
  const second = store.write('second.md', document({ type: 'feedback' }, 'Check saved artifacts.'));
  const candidate = learned(store, { replaces: [first, second].map(({ file, revision }) => ({ file, revision })),
    sources: [source(), source({ conversationId: 'conversation-2', quote: 'Check saved artifacts.' })] });
  const approved = store.setStatus(candidate.file, 'active');
  assert.equal(store.read(first.file).meta.status, 'superseded');
  assert.equal(store.read(second.file).meta.status, 'superseded');
  assert.equal(approved.meta.sources.length, 4);
  const restored = store.undo(candidate.file, approved.undoId, { expectedRevision: approved.revision });
  assert.deepEqual(restored.restoredFiles.sort(), [first.file, second.file, candidate.file].sort());
  assert.equal(store.read(first.file).revision, first.revision);
  assert.equal(store.read(second.file).revision, second.revision);
  assert.equal(store.read(candidate.file).revision, candidate.revision);
  assert.throws(() => store.undo(candidate.file, approved.undoId), code('MEMORY_UNDO_EXPIRED'));
});

test('learning rejects cross-project, global-to-project and core replacements before writing a candidate', (t) => {
  const store = fixture(t);
  const project = store.write('project.md', document({ type: 'project', scope: 'project', projectId: 'a' }));
  const global = store.write('global.md', document({ type: 'feedback' }));
  const core = store.write('core.md', document({ type: 'user', core: true }));
  const hostCore = store.write('host-core.md', document({ type: 'user' }));
  store.isCore = (file) => file === hostCore.file;
  for (const [entry, options, expected] of [
    [project, { context: { projectId: 'b' } }, 'MEMORY_SCOPE'],
    [global, { context: { projectId: 'a' } }, 'MEMORY_SCOPE'],
    [core, {}, 'MEMORY_CORE'], [hostCore, {}, 'MEMORY_CORE'],
  ]) assert.throws(() => learned(store, { replaces: [{ file: entry.file, revision: entry.revision }] }, options), code(expected));
  assert.equal(store.list().length, 4);
  assert.throws(() => store.write(core.file, 'Model edit.', { actor: 'model', memoryType: 'user' }), code('MEMORY_CORE'));
});

test('approval rechecks every revision and host core flag without retiring earlier participants on conflict', (t) => {
  const store = fixture(t);
  const first = store.write('first.md', 'First fact.');
  const second = store.write('second.md', 'Second fact.');
  const candidate = learned(store, { replaces: [first, second].map(({ file, revision }) => ({ file, revision })) });
  store.isCore = (file) => file === second.file;
  assert.throws(() => store.setStatus(candidate.file, 'active'), code('MEMORY_CORE'));
  assert.equal(store.read(first.file).revision, first.revision);
  assert.equal(store.read(candidate.file).revision, candidate.revision);
  store.isCore = () => false;
  store.write(second.file, 'Later user correction.');
  const records = recoverySnapshot(store);
  assert.throws(() => store.setStatus(candidate.file, 'active'), code('MEMORY_CONFLICT'));
  assert.equal(store.read(first.file).revision, first.revision);
  assert.equal(store.read(candidate.file).revision, candidate.revision);
  assert.equal(recoverySnapshot(store), records);
});

test('cross-conversation merging can replace sourced drafts and expands their unapplied replacement chains', (t) => {
  const store = fixture(t);
  const original = store.write('original.md', document({ type: 'feedback' }, 'Original rule.'));
  const first = learned(store, { file: 'first-draft.md', replaces: [{ file: original.file, revision: original.revision }] });
  const second = learned(store, { file: 'second-draft.md', sources: [source({ conversationId: 'conversation-2' })] });
  const merged = learned(store, { file: 'merged.md', replaces: [first, second].map(({ file, revision }) => ({ file, revision })),
    sources: [{ kind: 'memory', file: first.file, revision: first.revision }, { kind: 'memory', file: second.file, revision: second.revision }] });
  assert.deepEqual(merged.meta.replaces.map((item) => item.file).sort(), [original.file, first.file, second.file].sort());
  assert.ok(merged.meta.sources.some((item) => item.conversationId === 'conversation-1'));
  assert.ok(merged.meta.sources.some((item) => item.conversationId === 'conversation-2'));
  const approved = store.setStatus(merged.file, 'active');
  for (const target of [original, first, second]) assert.equal(store.read(target.file).meta.status, 'superseded');
  assert.deepEqual(store.list({}, { actor: 'model' }).map((item) => item.file), [merged.file]);
  const restored = store.undo(merged.file, approved.undoId, { expectedRevision: approved.revision });
  assert.equal(restored.restoredFiles.length, 4);
  for (const target of [original, first, second, merged]) assert.equal(store.read(target.file).revision, target.revision);
});

test('source overflow and stale nested replacement chains fail without dropping evidence or mutating drafts', (t) => {
  const store = fixture(t);
  const original = store.write('original.md', document({ type: 'feedback' }, 'Original rule.'));
  const draft = learned(store, { file: 'draft.md', replaces: [{ file: original.file, revision: original.revision }] });
  store.write(original.file, 'Changed rule.');
  const records = recoverySnapshot(store);
  assert.throws(() => learned(store, { file: 'merge.md', replaces: [{ file: draft.file, revision: draft.revision }] }), code('MEMORY_CONFLICT'));
  assert.equal(store.read(draft.file).revision, draft.revision);
  assert.equal(recoverySnapshot(store), records);

  const sources = Array.from({ length: 32 }, (_, index) => source({ conversationId: `conversation-${index}` }));
  const full = learned(store, { file: 'full.md', sources });
  const before = recoverySnapshot(store);
  assert.throws(() => learned(store, { file: 'overflow.md', sources: [source({ conversationId: 'new-conversation' })],
    replaces: [{ file: full.file, revision: full.revision }] }), code('MEMORY_SCHEMA'));
  assert.equal(store.read(full.file).revision, full.revision);
  assert.deepEqual(store.read(full.file).meta.sources, sources);
  assert.equal(recoverySnapshot(store), before);
});

test('Windows filename aliases cannot bypass host-owned core pinning', { skip: process.platform !== 'win32' }, (t) => {
  const store = fixture(t);
  const original = store.write('Pinned.md', document({ type: 'user' }, 'Pinned fact.'));
  store.isCore = file => file === 'Pinned.md';
  assert.throws(() => store.write('pinned.md', document({ type: 'user' }, 'Changed fact.'), { actor: 'model' }), code('MEMORY_CORE'));
  assert.throws(() => learned(store, { replaces: [{ file: 'pinned.md', revision: original.revision }] }), code('MEMORY_CORE'));
  assert.equal(store.read('Pinned.md').revision, original.revision);
});


test('restoreArchived requires the exact current archive and never overwrites an existing file', (t) => {
  const store = fixture(t);
  const original = store.write('removed.md', 'Original fact.');
  const first = store.archive(original.file);
  assert.throws(() => store.restoreArchived(original.file, 'wrong-id'), code('MEMORY_CONFLICT'));
  assert.throws(() => store.restoreArchived('other.md', first.archiveId), code('MEMORY_CONFLICT'));
  store.restoreArchived(original.file, first.archiveId);
  assert.throws(() => store.restoreArchived(original.file, first.archiveId), code('MEMORY_CONFLICT'));
  const second = store.archive(original.file);
  assert.notEqual(second.archiveId, first.archiveId);
  assert.throws(() => store.restoreArchived(original.file, first.archiveId), code('MEMORY_CONFLICT'));
  fs.writeFileSync(path.join(store.dir, original.file), 'New same-name fact.');
  assert.throws(() => store.restoreArchived(original.file, second.archiveId), code('MEMORY_CONFLICT'));
  assert.equal(store.read(original.file).content, 'New same-name fact.');
  assert.deepEqual(store.archived(), []);
});

test('purgeArchived requires the displayed archive ID and permanently removes only its recovery content', (t) => {
  const store = fixture(t);
  store.write('removed.md', 'Unique removed fact one.');
  store.write('removed.md', 'Unique removed fact two.');
  const retained = store.write('retained.md', 'Keep this other memory.');
  const archived = store.archive('removed.md');
  const before = recoverySnapshot(store);
  for (const options of [{}, { expectedArchiveId: 'stale-archive' }]) {
    assert.throws(() => store.purgeArchived('removed.md', options), code('MEMORY_CONFLICT'));
    assert.equal(recoverySnapshot(store), before);
  }
  const result = store.purgeArchived('removed.md', { actor: 'user', expectedArchiveId: archived.archiveId });
  assert.equal(result.permanent, true);
  assert.deepEqual(store.archived(), []);
  assert.doesNotMatch(recoverySnapshot(store), /Unique removed fact/);
  assert.throws(() => store.restoreArchived('removed.md', archived.archiveId), code('MEMORY_CONFLICT'));
  assert.equal(store.read(retained.file).revision, retained.revision);
  assertNoLegacyHistory(store);
});

test('purgeArchived rejects active, restored, rearchived, conflicting and model requests', (t) => {
  const store = fixture(t);
  const original = store.write('item.md', 'Fact.');
  assert.throws(() => store.purgeArchived(original.file, { expectedArchiveId: 'not-archived' }), code('MEMORY_CONFLICT'));
  const first = store.archive(original.file);
  assert.throws(() => store.purgeArchived(original.file, { actor: 'model', expectedArchiveId: first.archiveId }), code('MEMORY_PERMISSION'));
  store.restoreArchived(original.file, first.archiveId);
  assert.throws(() => store.purgeArchived(original.file, { expectedArchiveId: first.archiveId }), code('MEMORY_CONFLICT'));
  const second = store.archive(original.file);
  assert.throws(() => store.purgeArchived(original.file, { expectedArchiveId: first.archiveId }), code('MEMORY_CONFLICT'));
  store.write(original.file, 'New same-name memory.');
  assert.throws(() => store.purgeArchived(original.file, { expectedArchiveId: second.archiveId }), code('MEMORY_CONFLICT'));
  fs.unlinkSync(path.join(store.dir, original.file));
  assert.equal(store.archived()[0].archiveId, second.archiveId);
  for (const file of ['../outside.md', 'nested/item.md', '.history.md', 'item:stream.md']) {
    assert.throws(() => store.purgeArchived(file, { expectedArchiveId: second.archiveId }), code('MEMORY_PATH'));
    assert.throws(() => store.restoreArchived(file, second.archiveId), code('MEMORY_PATH'));
  }
  assert.throws(() => store.purgeArchived('MEMORY.md', { expectedArchiveId: second.archiveId }), code('MEMORY_INDEX'));
});

test('purging a removed merge participant cannot undo its deletion or resurrect it from another memory', (t) => {
  const store = fixture(t);
  const original = store.write('original.md', 'Original fact.');
  const candidate = store.write(original.file, 'Replacement fact.', { actor: 'model', memoryType: 'reference' });
  const approval = store.setStatus(candidate.file, 'active');
  const archived = store.archive(original.file);
  store.purgeArchived(original.file, { expectedArchiveId: archived.archiveId });
  assert.equal(store.read(candidate.file).revision, approval.revision);
  assert.equal(recovery(store).undo, null);
  assert.throws(() => store.undo(candidate.file, approval.undoId), code('MEMORY_UNDO_EXPIRED'));
  assert.equal(fs.existsSync(path.join(store.dir, original.file)), false);
  assert.deepEqual(store.archived(), []);
  assert.doesNotMatch(recoverySnapshot(store), /Original fact/);
});

test('failed recovery-state persistence leaves the archive available for a later purge', (t) => {
  const store = fixture(t);
  store.write('removed.md', 'Retain until durable purge intent.');
  const archived = store.archive('removed.md');
  const before = recoverySnapshot(store);
  const atomic = store._atomic.bind(store);
  store._atomic = (abs, content) => {
    if (abs === store.recoveryPath) throw new Error('Simulated recovery write failure');
    return atomic(abs, content);
  };
  assert.throws(() => store.purgeArchived('removed.md', { expectedArchiveId: archived.archiveId }), /Simulated recovery write failure/);
  assert.equal(recoverySnapshot(store), before);
  store._atomic = atomic;
  assert.equal(store.archived()[0].archiveId, archived.archiveId);
  store.purgeArchived('removed.md', { expectedArchiveId: archived.archiveId });
  assert.deepEqual(store.archived(), []);
});

test('interrupted permanent deletion completes once on restart without reviving recovery content', (t) => {
  const store = fixture(t);
  store.write('removed.md', 'To permanently remove.');
  const archived = store.archive('removed.md');
  const retained = store.write('retained.md', 'Retained fact.');
  const atomic = store._atomic.bind(store);
  store._atomic = (abs, content) => {
    if (abs === store.recoveryPath && !JSON.parse(content).pending) throw new Error('Simulated final purge write failure');
    return atomic(abs, content);
  };
  assert.throws(() => store.purgeArchived('removed.md', { expectedArchiveId: archived.archiveId }), code('MEMORY_PURGE_PENDING'));
  assert.equal(recovery(store).pending.operation, 'purge');
  assert.throws(() => store.archived({ readOnly: true }), code('MEMORY_RECOVERY_REQUIRED'));
  for (let count = 0; count < 2; count++) {
    const restarted = new MemoryStore({ dir: store.dir });
    assert.deepEqual(restarted.archived(), []);
    assert.equal(restarted.read(retained.file).revision, retained.revision);
    assert.equal(recovery(restarted).pending, null);
    assert.doesNotMatch(recoverySnapshot(restarted), /To permanently remove/);
  }
});

test('recovery refuses external edits before rolling back any participant', (t) => {
  const store = fixture(t);
  store.write('first.md', 'first before');
  store.write('second.md', 'second before');
  writeRecovery(store, { pending: { operation: 'write', changes: [
    { file: 'first.md', before: 'first before', afterRevision: revision('first partial') },
    { file: 'second.md', before: 'second before', afterRevision: revision('second partial') },
  ] } });
  fs.writeFileSync(path.join(store.dir, 'first.md'), 'first partial');
  fs.writeFileSync(path.join(store.dir, 'second.md'), 'external user correction');
  const before = recoverySnapshot(store);
  assert.throws(() => store.list(), code('MEMORY_RECOVERY_CONFLICT'));
  assert.equal(fs.readFileSync(path.join(store.dir, 'first.md'), 'utf8'), 'first partial');
  assert.equal(fs.readFileSync(path.join(store.dir, 'second.md'), 'utf8'), 'external user correction');
  assert.equal(recoverySnapshot(store), before);
});

test('purge recovery never deletes a new same-name file', (t) => {
  const store = fixture(t);
  store.write('item.md', 'Original fact.');
  store.archive('item.md');
  writeRecovery(store, { ...recovery(store), pending: { operation: 'purge', file: 'item.md', previousRevision: null } });
  fs.writeFileSync(path.join(store.dir, 'item.md'), 'New same-name data.');
  const before = recoverySnapshot(store);
  assert.throws(() => store.list(), code('MEMORY_PURGE_CONFLICT'));
  assert.equal(fs.readFileSync(path.join(store.dir, 'item.md'), 'utf8'), 'New same-name data.');
  assert.equal(recoverySnapshot(store), before);
});

test('legacy migration keeps the latest removed content including hidden conflicts and removes arbitrary history', (t) => {
  const store = fixture(t);
  legacyRecord(store, { createdAt: '2026-10-20T00:00:00Z', changes: [{ file: 'removed.md', before: null, after: 'Discard old revision.' }] });
  legacyRecord(store, { createdAt: '2026-10-20T01:00:00Z', operation: 'archive', changes: [{ file: 'removed.md', before: 'Discard old revision.', after: null }] });
  legacyRecord(store, { createdAt: '2026-10-20T02:00:00Z', changes: [{ file: 'removed.md', before: null, after: 'Keep removed latest.' }] });
  legacyRecord(store, { createdAt: '2026-10-20T03:00:00Z', operation: 'archive', changes: [{ file: 'removed.md', before: 'Keep removed latest.', after: null }] });
  legacyRecord(store, { operation: 'archive', changes: [{ file: 'live.md', before: 'Protected archive of live fact.', after: null }] });
  legacyRecord(store, { state: 'rolled_back', changes: [{ file: 'rolled-back.md', before: 'Discard failed edit.', after: null }] });
  fs.writeFileSync(path.join(store.dir, 'live.md'), 'Current live fact.');
  const before = fs.readdirSync(path.join(store.dir, '.history')).sort();
  assert.deepEqual(store.archived({ readOnly: true }).map(item => item.file), ['removed.md']);
  assert.deepEqual(fs.readdirSync(path.join(store.dir, '.history')).sort(), before);
  assert.equal(fs.existsSync(store.recoveryPath), false);
  const migrated = store.archived();
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].file, 'removed.md');
  assert.equal(recovery(store).archives[0].content, 'Keep removed latest.');
  assert.equal(recovery(store).undo, null);
  assert.doesNotMatch(recoverySnapshot(store), /Discard/);
  assert.equal(recovery(store).archives.length, 2);
  assert.equal(recovery(store).archives.find(item => item.file === 'live.md').content, 'Protected archive of live fact.');
  assertNoLegacyHistory(store);
  const restarted = new MemoryStore({ dir: store.dir });
  assert.equal(restarted.archived()[0].archiveId, migrated[0].archiveId);
  assert.equal(restarted.restoreArchived('removed.md', migrated[0].archiveId).content, 'Keep removed latest.');
  assert.deepEqual(restarted.archived(), []);
  assert.equal(restarted.read('live.md').content, 'Current live fact.');
  fs.unlinkSync(path.join(store.dir, 'live.md'));
  const protectedArchive = restarted.archived()[0];
  assert.equal(protectedArchive.file, 'live.md');
  assert.equal(restarted.restoreArchived('live.md', protectedArchive.archiveId).content, 'Protected archive of live fact.');
});

test('legacy equal timestamps honor stored ordering before file mtime', (t) => {
  const store = fixture(t);
  const timestamp = '2026-10-21T00:00:00Z';
  const epoch = Date.parse('2020-01-01T00:00:00Z');
  legacyRecord(store, { createdAt: timestamp, operation: 'archive', historyOrderMtimeMs: epoch,
    changes: [{ file: 'removed.md', before: 'Older content.', after: null }] }, { mtimeMs: epoch + 9000 });
  legacyRecord(store, { createdAt: timestamp, operation: 'archive',
    changes: [{ file: 'removed.md', before: 'Newer content.', after: null }] }, { mtimeMs: epoch + 1000 });
  const archived = store.archived()[0];
  assert.equal(store.restoreArchived(archived.file, archived.archiveId).content, 'Newer content.');
  assertNoLegacyHistory(store);
});

test('legacy pending transactions roll back before migration chooses removed memories', (t) => {
  const store = fixture(t);
  legacyRecord(store, { operation: 'archive', changes: [{ file: 'kept-archive.md', before: 'Existing removal.', after: null }] });
  legacyRecord(store, { state: 'pending', operation: 'status', changes: [
    { file: 'original.md', before: 'Original fact.', after: 'Superseded partial.' },
    { file: 'candidate.md', before: 'Candidate draft.', after: 'Approved partial.' },
    { file: 'new.md', before: null, after: 'New partial.' },
  ] });
  fs.writeFileSync(path.join(store.dir, 'original.md'), 'Superseded partial.');
  fs.writeFileSync(path.join(store.dir, 'candidate.md'), 'Candidate draft.');
  fs.writeFileSync(path.join(store.dir, 'new.md'), 'New partial.');
  assert.throws(() => store.list({}, { readOnly: true }), code('MEMORY_RECOVERY_REQUIRED'));
  assert.equal(store.read('original.md').content, 'Original fact.');
  assert.equal(store.read('candidate.md').content, 'Candidate draft.');
  assert.equal(fs.existsSync(path.join(store.dir, 'new.md')), false);
  assert.deepEqual(store.archived().map(item => item.file), ['kept-archive.md']);
  assertNoLegacyHistory(store);
});

test('legacy durable purge takes precedence over pending rollback and migration remains idempotent', (t) => {
  const store = fixture(t);
  legacyRecord(store, { operation: 'archive', changes: [{ file: 'purged.md', before: 'Do not resurrect.', after: null }] });
  legacyRecord(store, { state: 'pending', operation: 'status', changes: [
    { file: 'purged.md', before: 'Do not resurrect.', after: null },
    { file: 'unrelated.md', before: 'Unrelated before.', after: 'Unrelated partial.' },
  ] });
  fs.writeFileSync(path.join(store.dir, 'unrelated.md'), 'Unrelated partial.');
  fs.writeFileSync(path.join(store.dir, '.history', `.purge-${crypto.randomUUID()}.json`),
    JSON.stringify({ version: 1, operation: 'purge', file: 'purged.md', previousRevision: null }));
  for (let count = 0; count < 2; count++) {
    const restarted = new MemoryStore({ dir: store.dir });
    assert.equal(restarted.read('unrelated.md').content, 'Unrelated before.');
    assert.equal(fs.existsSync(path.join(store.dir, 'purged.md')), false);
    assert.deepEqual(restarted.archived(), []);
    assert.doesNotMatch(recoverySnapshot(restarted), /Do not resurrect/);
    assertNoLegacyHistory(restarted);
  }
});

for (const afterSave of [false, true]) {
  test(`legacy migration survives failure ${afterSave ? 'after' : 'before'} persisting recovery data`, (t) => {
    const store = fixture(t);
    const legacy = legacyRecord(store, { operation: 'archive', changes: [{ file: 'removed.md', before: 'Recoverable after failure.', after: null }] });
    const atomic = store._atomic.bind(store);
    store._atomic = (abs, content) => {
      if (abs === store.recoveryPath) {
        if (afterSave) atomic(abs, content);
        throw new Error('Simulated migration persistence failure');
      }
      return atomic(abs, content);
    };
    assert.throws(() => store.archived(), /Simulated migration persistence failure/);
    assert.equal(fs.existsSync(legacy.abs), true);
    for (let count = 0; count < 2; count++) {
      const restarted = new MemoryStore({ dir: store.dir });
      assert.deepEqual(restarted.archived().map(item => item.file), ['removed.md']);
      assert.equal(recovery(restarted).archives[0].content, 'Recoverable after failure.');
      assert.equal(recovery(restarted).archives.length, 1);
      assertNoLegacyHistory(restarted);
    }
  });
}

test('legacy cleanup resumes after removing some records without losing migrated archives', (t) => {
  const store = fixture(t);
  const first = legacyRecord(store, { operation: 'archive', changes: [{ file: 'first.md', before: 'First removed fact.', after: null }] });
  legacyRecord(store, { operation: 'archive', changes: [{ file: 'second.md', before: 'Second removed fact.', after: null }] });
  const originalUnlink = fs.unlinkSync;
  const unlink = t.mock.method(fs, 'unlinkSync', abs => {
    originalUnlink(abs);
    if (abs === first.abs) throw new Error('Simulated crash during legacy cleanup');
  });
  assert.throws(() => store.archived(), /Simulated crash during legacy cleanup/);
  unlink.mock.restore();
  assert.equal(recovery(store).legacyCleanup, true);
  const restarted = new MemoryStore({ dir: store.dir });
  assert.deepEqual(restarted.archived().map(item => item.file).sort(), ['first.md', 'second.md']);
  assert.equal(recovery(restarted).archives.length, 2);
  assertNoLegacyHistory(restarted);
});

test('Windows archive aliases purge one recovery entry using the guarded archive API', { skip: process.platform !== 'win32' }, (t) => {
  const store = fixture(t);
  store.write('MixedCase.md', 'First fact.');
  store.write('mixedcase.md', 'Second fact.');
  const archived = store.archive('MixedCase.md');
  store.purgeArchived('MIXEDCASE.md', { expectedArchiveId: archived.archiveId });
  assert.deepEqual(store.archived(), []);
  assert.doesNotMatch(recoverySnapshot(store), /First fact|Second fact/);
});


test('an external same-name file hides but never destroys an archived snapshot across restart', (t) => {
  const store = fixture(t);
  const original = store.write('removed.md', 'Preserved removed memory.');
  const archived = store.archive(original.file);
  fs.writeFileSync(path.join(store.dir, original.file), 'External new memory.');
  const restarted = new MemoryStore({ dir: store.dir });
  assert.deepEqual(restarted.archived(), []);
  assert.equal(recovery(restarted).archives[0].content, original.content);
  assert.throws(() => restarted.restoreArchived(original.file, archived.archiveId), code('MEMORY_CONFLICT'));
  assert.throws(() => restarted.purgeArchived(original.file, { expectedArchiveId: archived.archiveId }), code('MEMORY_CONFLICT'));
  assert.equal(restarted.read(original.file).content, 'External new memory.');
  fs.unlinkSync(path.join(store.dir, original.file));
  assert.equal(restarted.archived()[0].archiveId, archived.archiveId);
  assert.equal(restarted.restoreArchived(original.file, archived.archiveId).content, original.content);
});

test('a failed linked undo preserves the approved state and allows retrying the unconsumed token', (t) => {
  const store = fixture(t);
  const original = store.write('original.md', 'Original fact.');
  const candidate = learned(store, { replaces: [{ file: original.file, revision: original.revision }] });
  const approved = store.setStatus(candidate.file, 'active');
  const retired = store.read(original.file);
  const atomic = store._atomic.bind(store);
  let failed = false;
  store._atomic = (abs, content) => {
    if (!failed && abs === path.join(store.dir, candidate.file) && content === candidate.content) {
      failed = true;
      throw new Error('Simulated undo write failure');
    }
    return atomic(abs, content);
  };
  assert.throws(() => store.undo(candidate.file, approved.undoId, { expectedRevision: approved.revision }), /Simulated undo write failure/);
  assert.equal(store.read(original.file).revision, retired.revision);
  assert.equal(store.read(candidate.file).revision, approved.revision);
  assert.equal(recovery(store).undo.id, approved.undoId);
  assert.equal(recovery(store).pending, null);
  store.undo(candidate.file, approved.undoId, { expectedRevision: approved.revision });
  assert.equal(store.read(original.file).revision, original.revision);
  assert.equal(store.read(candidate.file).revision, candidate.revision);
  assert.equal(recovery(store).undo, null);
});

for (const [label, state] of [
  ['null', null], ['false', false], ['zero', 0], ['empty string', ''],
  ['false undo', { format: 1, archives: [], undo: false, pending: null }],
  ['false pending', { format: 1, archives: [], undo: null, pending: false }],
]) {
  test(`existing recovery JSON ${label} is rejected without overwriting data`, (t) => {
    const store = fixture(t);
    const protectedEntry = store.write('protected.md', 'Keep the current memory intact.');
    const raw = JSON.stringify(state);
    fs.writeFileSync(store.recoveryPath, raw);
    assert.throws(() => store.list({}, { readOnly: true }), code('MEMORY_RECOVERY'));
    assert.throws(() => store.write('new.md', 'Must not be created.'), code('MEMORY_RECOVERY'));
    assert.equal(fs.readFileSync(store.recoveryPath, 'utf8'), raw);
    assert.equal(fs.readFileSync(path.join(store.dir, protectedEntry.file), 'utf8'), protectedEntry.content);
    assert.equal(fs.existsSync(path.join(store.dir, 'new.md')), false);
    assert.equal(fs.existsSync(store.lockPath), false);
  });
}

test('a purge intent renamed before an exception remains accepted and completes after restart', (t) => {
  const store = fixture(t);
  store.write('removed.md', 'Durably accepted removal.');
  const archived = store.archive('removed.md');
  const atomic = store._atomic.bind(store);
  store._atomic = (abs, content) => {
    atomic(abs, content);
    if (abs === store.recoveryPath && JSON.parse(content).pending?.operation === 'purge') {
      throw new Error('Simulated exception after purge intent rename');
    }
  };
  assert.throws(() => store.purgeArchived('removed.md', { expectedArchiveId: archived.archiveId }),
    error => error.code === 'MEMORY_PURGE_PENDING' && /after purge intent rename/.test(error.cause?.message));
  assert.equal(recovery(store).pending.operation, 'purge');
  assert.equal(recovery(store).archives[0].id, archived.archiveId);
  assert.throws(() => store.archived({ readOnly: true }), code('MEMORY_RECOVERY_REQUIRED'));
  const restarted = new MemoryStore({ dir: store.dir });
  assert.deepEqual(restarted.archived(), []);
  assert.equal(recovery(restarted).pending, null);
  assert.doesNotMatch(recoverySnapshot(restarted), /Durably accepted removal/);
});

test('a completed purge renamed before an exception is reported as successful', (t) => {
  const store = fixture(t);
  store.write('removed.md', 'Completed removal content.');
  const archived = store.archive('removed.md');
  const atomic = store._atomic.bind(store);
  let threwAfterCommit = false;
  store._atomic = (abs, content) => {
    atomic(abs, content);
    if (abs === store.recoveryPath && JSON.parse(content).pending === null) {
      threwAfterCommit = true;
      throw new Error('Simulated exception after completed purge rename');
    }
  };
  const purged = store.purgeArchived('removed.md', { expectedArchiveId: archived.archiveId });
  assert.equal(threwAfterCommit, true);
  assert.equal(purged.permanent, true);
  assert.equal(purged.purgedArchiveId, archived.archiveId);
  assert.equal(recovery(store).pending, null);
  assert.deepEqual(recovery(store).archives, []);
  assert.doesNotMatch(recoverySnapshot(store), /Completed removal content/);
  const restarted = new MemoryStore({ dir: store.dir });
  assert.deepEqual(restarted.archived(), []);
});

test('an accepted purge stays pending when completion and the subsequent durable reread both fail', (t) => {
  const store = fixture(t);
  store.write('removed.md', 'Accepted removal awaiting recovery.');
  const archived = store.archive('removed.md');
  const atomic = store._atomic.bind(store);
  const readJson = store.recovery._json.bind(store.recovery);
  let completionFailed = false;
  store._atomic = (abs, content) => {
    if (abs === store.recoveryPath && JSON.parse(content).pending === null) {
      completionFailed = true;
      throw new Error('Simulated purge completion write failure');
    }
    return atomic(abs, content);
  };
  store.recovery._json = abs => {
    if (completionFailed && abs === store.recoveryPath) throw new Error('Simulated durable reread failure');
    return readJson(abs);
  };
  assert.throws(() => store.purgeArchived('removed.md', { expectedArchiveId: archived.archiveId }),
    error => error.code === 'MEMORY_PURGE_PENDING' && /completion write failure/.test(error.cause?.message));
  assert.equal(completionFailed, true);
  assert.equal(recovery(store).pending.operation, 'purge');
  const restarted = new MemoryStore({ dir: store.dir });
  assert.deepEqual(restarted.archived(), []);
  assert.equal(recovery(restarted).pending, null);
  assert.doesNotMatch(recoverySnapshot(restarted), /Accepted removal awaiting recovery/);
});

for (const [action, status] of [['confirm', 'active'], ['ignore', 'expired']]) {
  test(`${action} of an active inferred legacy candidate creates undo that restores its exact original content`, (t) => {
    const store = fixture(t);
    const raw = document({ name: 'Legacy candidate', type: 'feedback', status: 'active', confidence: 'inferred',
      sources: [source()] }, 'An inferred legacy preference awaiting confirmation.');
    fs.writeFileSync(path.join(store.dir, 'legacy-candidate.md'), raw);
    const before = store.read('legacy-candidate.md');
    assert.equal(before.meta.status, 'active');
    assert.equal(before.meta.confidence, 'inferred');
    assert.deepEqual(store.list({}, { actor: 'model' }), []);
    const result = store.setStatus(before.file, status, { expectedRevision: before.revision });
    assert.equal(typeof result.undoId, 'string');
    assert.ok(Number.isFinite(Date.parse(result.undoExpiresAt)));
    assert.equal(result.meta.status, status);
    assert.equal(result.meta.confidence, action === 'confirm' ? 'user_confirmed' : 'inferred');
    store.undo(before.file, result.undoId, { expectedRevision: result.revision });
    assert.equal(store.read(before.file).content, raw);
    assert.deepEqual(store.read(before.file).meta.sources, [source()]);
    assert.deepEqual(store.list({}, { actor: 'model' }), []);
    assert.equal(recovery(store).undo, null);
  });
}
