'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MemoryStore, guardMemoryToolInput } = require('../src/main/memory/memory-store');
const { parseMemoryDocument, memoryEligibility, serializeMemoryFrontmatter } = require('../src/main/memory/memory-schema');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-memory-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemoryStore({ dir });
}
function document(meta, body = 'fixture memory') { return `${serializeMemoryFrontmatter(meta)}\n${body}`; }
function code(expected) { return (error) => error.code === expected; }

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

test('model writes receive host scope and provenance and cannot forge confirmation, core or replacement links', (t) => {
  const store = fixture(t);
  const saved = store.write('candidate.md', document({ status: 'active', confidence: 'user_confirmed', core: true, scope: 'global', sourceRef: 'forged', supersedes: 'other.md' }), {
    actor: 'model', context: { projectId: 'project-a', sourceRef: 'conv:trusted' }, expectedRevision: null,
  });
  assert.equal(saved.meta.status, 'draft');
  assert.equal(saved.meta.confidence, 'inferred');
  assert.equal(saved.meta.core, false);
  assert.equal(saved.meta.scope, 'project');
  assert.equal(saved.meta.projectId, 'project-a');
  assert.equal(saved.meta.sourceRef, 'conv:trusted');
  assert.equal(saved.meta.supersedes, null);
  assert.equal(store.list({ projectId: 'project-a' }, { actor: 'model' }).length, 0);
  const confirmed = store.write('explicit.md', 'Explicit remember request', { actor: 'model', userConfirmed: true, context: { projectId: 'project-a' } });
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
  assert.throws(() => store.write('b.md', 'changed', { actor: 'model', context: { projectId: 'a' } }), code('MEMORY_SCOPE'));
});

test('confirmed model updates become proposals and approval retires the exact original revision', (t) => {
  const store = fixture(t);
  const original = store.write('preference.md', 'original confirmed preference');
  const proposal = store.write('preference.md', 'proposed replacement', { actor: 'model', expectedRevision: original.revision });
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
  const proposal = store.propose('item.md', 'proposed', { actor: 'model', expectedRevision: initial.revision });
  const updated = store.write('item.md', 'v2', { expectedRevision: initial.revision });
  assert.throws(() => store.write('item.md', 'stale', { expectedRevision: initial.revision }), code('MEMORY_CONFLICT'));
  assert.throws(() => store.setStatus(proposal.file, 'active'), code('MEMORY_CONFLICT'));
  assert.equal(store.read('item.md').revision, updated.revision);
  assert.equal(store.read(proposal.file).meta.status, 'draft');
});

test('edits and deletions retain recoverable snapshots; permanent deletion purges just that file', (t) => {
  const store = fixture(t);
  store.write('item.md', 'v1');
  const changed = store.write('item.md', 'v2');
  assert.equal(store.restore('item.md', changed.versionId).content, 'v1');
  const archived = store.archive('item.md');
  assert.throws(() => store.read('item.md'), code('MEMORY_NOT_FOUND'));
  assert.equal(store.restore('item.md', archived.versionId).content, 'v1');
  store.write('retained.md', 'keep');
  store.remove('item.md', { permanent: true });
  assert.deepEqual(store.history('item.md'), []);
  assert.throws(() => store.restore('item.md', archived.versionId), code('MEMORY_NOT_FOUND'));
  assert.equal(store.read('retained.md').content, 'keep');
});

test('model cannot approve, archive, restore or read the historical library', (t) => {
  const store = fixture(t);
  store.write('item.md', 'confirmed');
  for (const operation of [() => store.setStatus('item.md', 'active', { actor: 'model' }),
    () => store.archive('item.md', { actor: 'model' }), () => store.remove('item.md', { actor: 'model', permanent: true }),
    () => store.history('item.md', { actor: 'model' }), () => store.restore('item.md', 'x', { actor: 'model' })]) {
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

test('interrupted approval transactions recover all files together on the next store operation', (t) => {
  const store = fixture(t);
  store.write('original.md', 'before');
  store.write('proposal.md', 'draft');
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(store.historyDir, `${id}.json`), JSON.stringify({ id, state: 'pending', changes: [
    { file: 'original.md', before: 'before', after: 'retired' }, { file: 'proposal.md', before: 'draft', after: 'approved' },
  ] }));
  fs.writeFileSync(path.join(store.dir, 'original.md'), 'retired');
  const restarted = new MemoryStore({ dir: store.dir });
  assert.equal(restarted.read('original.md').content, 'before');
  assert.equal(restarted.read('proposal.md').content, 'draft');
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.historyDir, `${id}.json`))).state, 'rolled_back');
});

test('failed approval leaves both memories unchanged and committed history available', (t) => {
  const store = fixture(t);
  const original = store.write('original.md', 'confirmed');
  const proposed = store.propose('original.md', 'candidate', { actor: 'model' });
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
  assert.ok(store.history('original.md').length);
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
  const proposed = store.write('global.md', 'proposed global', { actor: 'model', context: { projectId: 'a' } });
  assert.equal(proposed.meta.scope, 'global');
  assert.equal(proposed.meta.projectId, null);
  const edited = store.write(proposed.file, 'revised proposed global', { actor: 'model', context: { projectId: 'a' } });
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

test('Windows case aliases share history and permanent deletion removes every alias snapshot', { skip: process.platform !== 'win32' }, (t) => {
  const store = fixture(t);
  store.write('MixedCase.md', 'original');
  store.write('mixedcase.md', 'replacement');
  assert.equal(store.history('MIXEDCASE.md').length, 2);
  store.remove('MIXEDCASE.md', { permanent: true });
  assert.deepEqual(store.history('MixedCase.md'), []);
  assert.equal(fs.existsSync(path.join(store.dir, 'mixedcase.md')), false);
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
  assert.equal(rows[0].versionId, archived.versionId);
  assert.equal(rows[0].meta.name, 'removed-fact');
  assert.equal(rows[0].meta.projectId, 'a');
  assert.equal(typeof rows[0].createdAt, 'string');
  assert.throws(() => store.archived({ actor: 'model' }), code('MEMORY_PERMISSION'));
  store.restore('removed.md', rows[0].versionId);
  assert.deepEqual(store.archived(), []);
  store.archive('removed.md');
  store.write('removed.md', 'recreated');
  assert.deepEqual(store.archived(), []);
  // A file removed outside the store does not revive an older, already superseded archive action.
  fs.unlinkSync(path.join(store.dir, 'removed.md'));
  assert.deepEqual(store.archived(), []);
});

test('archived listing selects the newest removal and does not surface permanently purged history', (t) => {
  const store = fixture(t);
  store.write('item.md', 'v1');
  store.archive('item.md');
  store.write('item.md', 'v2');
  const latest = store.archive('item.md');
  assert.equal(store.archived()[0].versionId, latest.versionId);
  store.remove('item.md', { permanent: true });
  assert.deepEqual(store.archived(), []);
});

test('identical model proposals reuse one draft without creating another file or history version', (t) => {
  const store = fixture(t);
  const original = store.write('item.md', 'original');
  const options = { actor: 'model', expectedRevision: original.revision, context: { projectId: 'a', sourceRef: 'conv:fixture' } };
  const first = store.write('item.md', 'same proposed fact', options);
  const historyCount = fs.readdirSync(store.historyDir).length;
  const repeated = store.write('item.md', 'same proposed fact', options);
  assert.equal(repeated.file, first.file);
  assert.equal(repeated.versionId, first.versionId);
  assert.equal(repeated.deduplicated, true);
  assert.equal(fs.readdirSync(store.historyDir).length, historyCount);
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
  const first = store.write('item.md', 'proposed', { actor: 'model' });
  const updated = store.write('item.md', 'user edit');
  const second = store.write('item.md', 'proposed', { actor: 'model' });
  assert.notEqual(second.file, first.file);
  assert.equal(second.meta.supersedesRevision, updated.revision);
});

for (const entryPoint of ['candidate', 'original']) {
  test(`restoring approval through the ${entryPoint} restores both facts and can itself be undone consistently`, (t) => {
    const store = fixture(t);
    const original = store.write('original.md', 'original confirmed fact');
    const candidate = store.write(original.file, 'new proposed fact', { actor: 'model' });
    const approved = store.setStatus(candidate.file, 'active');
    const retired = store.read(original.file);
    const target = entryPoint === 'candidate' ? candidate.file : original.file;
    const linked = entryPoint === 'candidate' ? original.file : candidate.file;
    const restored = store.restore(target, approved.versionId, { expectedRevision: store.read(target).revision });
    assert.deepEqual(restored.restoredFiles.sort(), [original.file, candidate.file].sort());
    assert.equal(store.read(original.file).revision, original.revision);
    assert.equal(store.read(candidate.file).revision, candidate.revision);
    assert.deepEqual(store.list({}, { actor: 'model' }).map((item) => item.file), [original.file]);
    assert.ok(store.history(linked).some((item) => item.versionId === restored.versionId && item.operation === 'restore'));
    const record = JSON.parse(fs.readFileSync(path.join(store.historyDir, `${restored.versionId}.json`), 'utf8'));
    assert.equal(record.changes.length, 2);

    const redone = store.restore(linked, restored.versionId, { expectedRevision: store.read(linked).revision });
    assert.equal(store.read(original.file).revision, retired.revision);
    assert.equal(store.read(candidate.file).revision, approved.revision);
    assert.deepEqual(store.list({}, { actor: 'model' }).map((item) => item.file), [candidate.file]);
    store.restore(target, redone.versionId, { expectedRevision: store.read(target).revision });
    assert.equal(store.read(original.file).revision, original.revision);
    assert.equal(store.read(candidate.file).revision, candidate.revision);
    assert.deepEqual(store.list({}, { actor: 'model' }).map((item) => item.file), [original.file]);
  });

  test(`restoring approval through the ${entryPoint} rejects a later edit to its linked memory without partial changes`, (t) => {
    const store = fixture(t);
    const original = store.write('original.md', 'original');
    const candidate = store.write(original.file, 'candidate', { actor: 'model' });
    const approved = store.setStatus(candidate.file, 'active');
    const target = entryPoint === 'candidate' ? candidate.file : original.file;
    const linked = entryPoint === 'candidate' ? original.file : candidate.file;
    store.write(linked, 'later user edit');
    const beforeTarget = store.read(target), beforeLinked = store.read(linked);
    const recordsBefore = fs.readdirSync(store.historyDir).length;
    assert.throws(() => store.restore(target, approved.versionId, { expectedRevision: beforeTarget.revision }), code('MEMORY_CONFLICT'));
    assert.equal(store.read(target).revision, beforeTarget.revision);
    assert.equal(store.read(linked).revision, beforeLinked.revision);
    assert.equal(fs.readdirSync(store.historyDir).length, recordsBefore);
  });
}

test('group restoration still honors the caller revision and rejects a missing linked participant', (t) => {
  const store = fixture(t);
  store.write('original.md', 'original');
  const candidate = store.write('original.md', 'candidate', { actor: 'model' });
  const approved = store.setStatus(candidate.file, 'active');
  assert.throws(() => store.restore(candidate.file, approved.versionId, { expectedRevision: candidate.revision }), code('MEMORY_CONFLICT'));
  store.archive('original.md');
  assert.throws(() => store.restore(candidate.file, approved.versionId, { expectedRevision: approved.revision }), code('MEMORY_CONFLICT'));
  assert.equal(store.read(candidate.file).revision, approved.revision);
  assert.throws(() => store.read('original.md'), code('MEMORY_NOT_FOUND'));
});

for (const entryPoint of ['candidate', 'original']) {
  test(`an earlier single-file ${entryPoint} snapshot cannot bypass an applied approval transaction`, (t) => {
    const store = fixture(t);
    const original = store.write('original.md', 'original');
    const candidate = store.write(original.file, 'candidate', { actor: 'model' });
    const approved = store.setStatus(candidate.file, 'active');
    const target = entryPoint === 'candidate' ? candidate : original;
    const before = store.list().map((item) => ({ file: item.file, revision: item.revision }));
    const history = store.history(target.file);
    const single = history.find((item) => item.versionId === target.versionId);
    assert.equal(single.requiresRelatedRestore, true);
    assert.equal(single.relatedVersionId, approved.versionId);
    assert.equal(history.find((item) => item.versionId === approved.versionId).requiresRelatedRestore, false);
    assert.throws(() => store.restore(target.file, target.versionId, { expectedRevision: store.read(target.file).revision }),
      (error) => error.code === 'MEMORY_CONFLICT' && error.message.includes('关联审批'));
    assert.deepEqual(store.list().map((item) => ({ file: item.file, revision: item.revision })), before);
    assert.deepEqual(store.list({}, { actor: 'model' }).map((item) => item.file), [candidate.file]);
    store.restore(target.file, approved.versionId, { expectedRevision: store.read(target.file).revision });
    assert.deepEqual(store.list({}, { actor: 'model' }).map((item) => item.file), [original.file]);
  });
}

test('ordinary same-name single-file versions and edits after approval remain restorable', (t) => {
  const store = fixture(t);
  store.write('ordinary.md', 'v1');
  const changed = store.write('ordinary.md', 'v2');
  assert.equal(store.history('ordinary.md').every((item) => !item.requiresRelatedRestore), true);
  assert.equal(store.restore('ordinary.md', changed.versionId).content, 'v1');

  store.write('original.md', 'original');
  const candidate = store.write('original.md', 'candidate', { actor: 'model' });
  const approved = store.setStatus(candidate.file, 'active');
  const edited = store.write(candidate.file, `${approved.content}\nLater user edit`);
  assert.equal(store.history(candidate.file).find((item) => item.versionId === edited.versionId).requiresRelatedRestore, false);
  store.restore(candidate.file, edited.versionId, { expectedRevision: edited.revision });
  assert.equal(store.read(candidate.file).revision, approved.revision);
  assert.deepEqual(store.list({}, { actor: 'model' }).map((item) => item.file).sort(), ['ordinary.md', candidate.file].sort());
});
