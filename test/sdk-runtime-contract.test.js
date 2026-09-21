'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { instructionFingerprint, requiresFreshContract, contractFingerprints, migrateLegacyRuntimeContract } = require('../sdk-runtime-contract');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-instruction-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), configDir = path.join(root, '.claude');
  fs.mkdirSync(cwd); fs.mkdirSync(configDir);
  return { root, cwd, configDir, homeDir: root, settingSources: ['user', 'project', 'local'] };
}
test('nested rules added, changed, removed all invalidate the runtime without changing history metadata', t => {
  const f = fixture(t), rules = path.join(f.cwd, '.claude', 'rules', 'nested');
  const before = instructionFingerprint(f);
  fs.mkdirSync(rules, { recursive: true }); fs.writeFileSync(path.join(rules, 'coding.md'), 'Use strict mode.');
  const added = instructionFingerprint(f); assert.notEqual(added, before);
  fs.writeFileSync(path.join(rules, 'coding.md'), 'Use typed errors.');
  const changed = instructionFingerprint(f); assert.notEqual(changed, added);
  fs.unlinkSync(path.join(rules, 'coding.md')); assert.notEqual(instructionFingerprint(f), changed);
  const saved = { sessionId: 'native-session', sdkRuntimeFingerprint: before, updatedAt: 'fixed', title: 'Manual', turns: [] };
  const snapshot = JSON.stringify(saved); assert.equal(requiresFreshContract(saved, changed), true); assert.equal(JSON.stringify(saved), snapshot);
});
test('recursive @imports are fingerprinted relative to each file, support home paths, and stop cycles', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.cwd, 'docs'));
  fs.writeFileSync(path.join(f.cwd, 'CLAUDE.md'), 'Instructions @docs/one.md\n@~/shared.md');
  fs.writeFileSync(path.join(f.cwd, 'docs', 'one.md'), '@two.md');
  fs.writeFileSync(path.join(f.cwd, 'docs', 'two.md'), '@../CLAUDE.md\nOld reference');
  fs.writeFileSync(path.join(f.root, 'shared.md'), 'Shared rule');
  const initial = instructionFingerprint(f);
  fs.writeFileSync(path.join(f.cwd, 'docs', 'two.md'), '@../CLAUDE.md\nNew reference');
  const nested = instructionFingerprint(f); assert.notEqual(nested, initial);
  fs.writeFileSync(path.join(f.root, 'shared.md'), 'Changed shared rule'); assert.notEqual(instructionFingerprint(f), nested);
});
test('disabled project sources and code examples do not import unrelated files', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, 'CLAUDE.md'), 'Project rule');
  const userOnly = { ...f, settingSources: ['user'] }, before = instructionFingerprint(userOnly);
  fs.writeFileSync(path.join(f.cwd, 'CLAUDE.md'), 'Changed project rule'); assert.equal(instructionFingerprint(userOnly), before);
  const doc = path.join(f.configDir, 'CLAUDE.md'), example = path.join(f.configDir, 'example.md');
  fs.writeFileSync(doc, 'Example `@example.md`\n```txt\n@example.md\n```'); fs.writeFileSync(example, 'not active');
  const first = instructionFingerprint(userOnly); fs.writeFileSync(example, 'still not active'); assert.equal(instructionFingerprint(userOnly), first);
});

test('linked rule folders track their targets and stop cycles without writing through the links', t => {
  const f = fixture(t), shared = path.join(f.root, 'shared-rules'), rules = path.join(f.configDir, 'rules');
  fs.mkdirSync(shared); fs.mkdirSync(rules);
  try { fs.symlinkSync(shared, path.join(rules, 'shared'), 'junction'); fs.symlinkSync(rules, path.join(shared, 'cycle'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit creating fixture directory links'); return; } throw error; }
  fs.writeFileSync(path.join(shared, 'rule.md'), 'First rule'); const a = instructionFingerprint(f);
  fs.writeFileSync(path.join(shared, 'rule.md'), 'Second rule'); assert.notEqual(instructionFingerprint(f), a);
});

test('touch and identical atomic saves preserve the effective instruction/configuration fingerprint', t => {
  const f = fixture(t), rules = path.join(f.configDir, 'rules'); fs.mkdirSync(rules);
  const files = [path.join(f.configDir, 'settings.json'), path.join(f.cwd, 'CLAUDE.md'), path.join(rules, 'guide.md')];
  for (const file of files) fs.writeFileSync(file, file.endsWith('.json') ? '{"permissions":{"defaultMode":"default"}}' : 'Stable instructions.');
  const before = instructionFingerprint(f);
  for (const file of [...files, rules]) {
    const stat = fs.statSync(file); fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000));
    assert.equal(instructionFingerprint(f), before, 'a timestamp is not a change of instructions');
  }
  for (const file of files) {
    const temporary = file + '.tmp'; fs.writeFileSync(temporary, fs.readFileSync(file));
    fs.renameSync(temporary, file);
    assert.equal(instructionFingerprint(f), before, 'an identical atomic save is not a new SDK context');
  }
});

test('same-size changes invalidate even when the editor restores mtime', t => {
  const f = fixture(t), file = path.join(f.configDir, 'settings.json');
  fs.writeFileSync(file, '{"env":{"FIXTURE":"before"}}');
  const before = instructionFingerprint(f), stat = fs.statSync(file);
  fs.writeFileSync(file, '{"env":{"FIXTURE":"change"}}');
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.notEqual(instructionFingerprint(f), before);
});

test('JSON formatting and object key order are stable while effective values and array order invalidate', t => {
  const f = fixture(t), file = path.join(f.configDir, 'settings.json');
  fs.writeFileSync(file, '{"env":{"FIXTURE":"same"},"permissions":{"allow":["Read","Write"]}}');
  const before = instructionFingerprint(f);
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Read', 'Write'] }, env: { FIXTURE: 'same' } }, null, 2));
  assert.equal(instructionFingerprint(f), before);
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Write', 'Read'] }, env: { FIXTURE: 'same' } }));
  assert.notEqual(instructionFingerprint(f), before);
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['Read', 'Write'] }, env: { FIXTURE: 'changed' } }));
  assert.notEqual(instructionFingerprint(f), before);
});

test('unchanged files reuse cached digests while imported content is still rechecked on every call', async t => {
  const f = fixture(t), parent = path.join(f.configDir, 'CLAUDE.md'), child = path.join(f.configDir, 'include.md');
  fs.writeFileSync(parent, '@include.md'); fs.writeFileSync(child, 'Original imported instruction.');
  await new Promise(resolve => setTimeout(resolve, 2100));
  const original = fs.readFileSync, reads = [];
  fs.readFileSync = function(file, ...args) { if (String(file).startsWith(f.root)) reads.push(String(file)); return original.call(this, file, ...args); };
  try {
    const initial = instructionFingerprint(f); assert.deepEqual(reads.sort(), [parent, child].sort()); reads.length = 0;
    assert.equal(instructionFingerprint(f), initial); assert.equal(reads.length, 0);
    fs.writeFileSync(child, 'Changed imported instruction.');
    assert.notEqual(instructionFingerprint(f), initial); assert.deepEqual(reads, [child]);
  } finally { fs.readFileSync = original; }
});

test('rapid same-size imported rewrites are never hidden by filesystem timestamp granularity', t => {
  const f = fixture(t), child = path.join(f.configDir, 'rapid.md');
  fs.writeFileSync(path.join(f.configDir, 'CLAUDE.md'), '@rapid.md');
  fs.writeFileSync(child, '0000'); let before = instructionFingerprint(f);
  for (let i = 1; i <= 40; i++) {
    fs.writeFileSync(child, String(i).padStart(4, '0'));
    const after = instructionFingerprint(f); assert.notEqual(after, before, `rapid save ${i}`); before = after;
  }
});

test('adding and removing an imported file invalidate a cached parent without editing it', t => {
  const f = fixture(t), child = path.join(f.configDir, 'late.md');
  fs.writeFileSync(path.join(f.configDir, 'CLAUDE.md'), '@late.md');
  const missing = instructionFingerprint(f);
  fs.writeFileSync(child, 'New imported instruction.'); const added = instructionFingerprint(f);
  assert.notEqual(added, missing);
  fs.unlinkSync(child); assert.equal(instructionFingerprint(f), missing);
});

test('switching a linked rule directory invalidates even when both targets have identical contents', t => {
  const f = fixture(t), one = path.join(f.root, 'one'), two = path.join(f.root, 'two'), link = path.join(f.configDir, 'rules');
  for (const directory of [one, two]) { fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'rule.md'), 'Same contents.'); }
  try { fs.symlinkSync(one, link, 'junction'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit creating fixture directory links'); return; } throw error; }
  const before = instructionFingerprint(f);
  fs.unlinkSync(link); fs.symlinkSync(two, link, 'junction');
  assert.notEqual(instructionFingerprint(f), before);
});

test('changes beyond the import parsing limit still invalidate the file content digest', t => {
  const f = fixture(t), file = path.join(f.configDir, 'CLAUDE.md');
  fs.writeFileSync(file, 'x'.repeat(300 * 1024));
  const before = instructionFingerprint(f), stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000));
  assert.equal(instructionFingerprint(f), before);
  fs.writeFileSync(file, 'x'.repeat(300 * 1024 - 1) + 'y');
  assert.notEqual(instructionFingerprint(f), before);
});

test('legacy calculation exactly preserves the pre-upgrade metadata/hash representation', t => {
  const f = fixture(t); f.settingSources = ['user'];
  const settings = path.join(f.configDir, 'settings.json'), instructions = path.join(f.configDir, 'CLAUDE.md');
  fs.writeFileSync(settings, '{"env":{"FIXTURE":"value"}}'); fs.writeFileSync(instructions, 'Fixed instruction.');
  const metadata = [];
  for (const file of [settings, instructions]) {
    const stat = fs.statSync(file); metadata.push([file, stat.size, stat.mtimeMs, stat.ctimeMs, null]);
    if (file === instructions) metadata.push([file, require('node:crypto').createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex')]);
  }
  metadata.push([path.join(f.configDir, 'rules'), null]);
  const expected = require('node:crypto').createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
  assert.equal(instructionFingerprint({ ...f, legacy: true }), expected);
  assert.notEqual(instructionFingerprint(f), expected);
});

test('exact legacy proof migrates only internal matching hashes and preserves all conversation content', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.configDir, 'CLAUDE.md'), 'Legacy instruction fixture.');
  const contract = contractFingerprints({ fingerprint: 'fixture-policy' }, null, f);
  const record = { id: 'legacy-fixture', sessionId: 'same-native-id', sdkRuntimeFingerprint: contract.legacyFingerprint(),
    updatedAt: 'unchanged', pinned: true, sdkContextBoundary: { afterRunId: 'cleared', turnIndex: 2 },
    sdkSessionContext: { sessionId: 'same-native-id', routing: { runtimeFingerprint: contract.legacyFingerprint() } },
    turns: [{ runId: 'one', assistant: 'native reply', sdkSessionContext: { routing: { runtimeFingerprint: contract.legacyFingerprint() } } },
      { runId: 'different-policy', sdkSessionContext: { routing: { runtimeFingerprint: 'another-context' } } }] };
  const before = JSON.stringify(record), upgraded = migrateLegacyRuntimeContract(record, contract);
  assert.equal(JSON.stringify(record), before); assert.equal(upgraded.sessionId, record.sessionId);
  assert.equal(upgraded.updatedAt, record.updatedAt); assert.deepEqual(upgraded.sdkContextBoundary, record.sdkContextBoundary);
  assert.equal(upgraded.sdkRuntimeFingerprint, contract.fingerprint); assert.equal(upgraded.sdkRuntimeFingerprintVersion, 2);
  assert.equal(upgraded.turns[0].assistant, 'native reply');
  assert.equal(upgraded.turns[1].sdkSessionContext.routing.runtimeFingerprint, 'another-context');
  assert.equal(requiresFreshContract(upgraded, contract.fingerprint), false);
});

test('nonmatching legacy metadata and v2 records never gain a resume exemption or repeat the old scan', () => {
  let checks = 0;
  const contract = { fingerprint: 'migration-new-fixture', legacyFingerprint: () => { checks++; return 'different-legacy'; } };
  const record = { id: 'fixture', sessionId: 'native', sdkRuntimeFingerprint: 'saved-old-fixture' };
  assert.equal(migrateLegacyRuntimeContract(record, contract), null);
  assert.equal(migrateLegacyRuntimeContract(record, contract), null); assert.equal(checks, 1);
  assert.equal(requiresFreshContract(record, contract.fingerprint), true);
  assert.equal(migrateLegacyRuntimeContract({ ...record, sdkRuntimeFingerprintVersion: 2 }, contract), null); assert.equal(checks, 1);
});

test('inputs changed after the semantic snapshot cannot be approved by a later legacy read', t => {
  const f = fixture(t), file = path.join(f.configDir, 'CLAUDE.md'); fs.writeFileSync(file, 'before');
  const contract = contractFingerprints({ fingerprint: 'fixture-policy-race' }, null, f);
  fs.writeFileSync(file, 'after');
  assert.equal(contract.legacyFingerprint(), null);
});
