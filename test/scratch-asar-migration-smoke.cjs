'use strict';
// Real Electron archive semantics, production migration, isolated fixture data only.
// Run: electron test/scratch-asar-migration-smoke.cjs [--expect-regression]
const { app } = require('electron');
const fs = require('node:fs');
const physicalFs = require('original-fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const { createConversationScratch } = require('../src/main/projects/conversation-scratch');
const root = path.resolve(__dirname, '..');
const expectRegression = process.argv.includes('--expect-regression');
const label = expectRegression ? 'before' : 'after';
const output = path.join(root, '.codex-tmp', 'scratch-migration-fix-2026-10-16');
physicalFs.mkdirSync(output, { recursive: true });
const fixture = physicalFs.mkdtempSync(path.join(output, 'asar-' + label + '-'));
app.setPath('userData', path.join(fixture, 'electron-profile'));
app.disableHardwareAcceleration();
const resultFile = path.join(output, 'asar-migration-' + label + '.json');
const hash = file => crypto.createHash('sha256').update(physicalFs.readFileSync(file)).digest('hex');
const result = {
  startedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, node: process.versions.node },
  fixture, expectRegression, sourceHashes: Object.fromEntries(['scratch-copy.js', 'conversation-scratch.js', 'scratch-protection.js'].map(file => [file, hash(path.join(root, 'src/main/projects', file))])),
  checks: {}, cases: [], failures: [],
};
const save = () => physicalFs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
function check(name, operation) { operation(); result.checks[name] = true; save(); }
const deadline = setTimeout(() => { result.failures.push('Timed out'); save(); app.exit(1); }, 60000);
// ASAR inspection opens Electron's archive cache on Windows. Inspect in a short-
// lived process so this observation does not itself lock the source during cleanup.
function inspectArchive(archive) {
  const script = path.join(fixture, 'inspect-archive.cjs');
  physicalFs.writeFileSync(script, [
    "'use strict';",
    "const { app } = require('electron'), fs = require('node:fs'), path = require('node:path');",
    "app.setPath('userData', path.join(__dirname, 'inspection-profile')); app.disableHardwareAcceleration();",
    "app.whenReady().then(() => { const archive = process.argv[2], stat = fs.lstatSync(archive);",
    "console.log(JSON.stringify({ isFile: stat.isFile(), isDirectory: stat.isDirectory(),",
    "entry: fs.readFileSync(path.join(archive, 'index.js'), 'utf8'),",
    "unpackedBytes: fs.readFileSync(path.join(archive, 'native', 'external.bin')).length })); app.exit(0); });",
  ].join('\n'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const stdout = execFileSync(process.execPath, [script, archive], { env, encoding: 'utf8', timeout: 15000 });
  return JSON.parse(stdout.trim());
}
async function scenario(name, interrupted) {
  const home = path.join(fixture, name);
  physicalFs.mkdirSync(home);
  const recordsFile = path.join(home, 'registry.json');
  let records = {};
  const legacyRoot = path.join(home, 'source'), targetRoot = path.join(home, 'target');
  const options = { legacyRoot, getRoot: () => legacyRoot, folderFor: id => id,
    readRecords: () => records,
    saveRecords: () => physicalFs.writeFileSync(recordsFile, JSON.stringify(records)),
    loadConversation: () => ({ turns: [] }) };
  let service = createConversationScratch(options);
  const id = '00000000-0000-4000-8000-000000000001';
  const source = service.resolve(id);
  const packedInput = path.join(home, 'package-input');
  physicalFs.mkdirSync(path.join(packedInput, 'native'), { recursive: true });
  physicalFs.writeFileSync(path.join(packedInput, 'package.json'), JSON.stringify({ name: 'synthetic-scratch-fixture', version: '1.0.0', main: 'index.js' }));
  physicalFs.writeFileSync(path.join(packedInput, 'index.js'), 'module.exports = "real ASAR fixture";\n');
  physicalFs.writeFileSync(path.join(packedInput, 'native', 'external.bin'), Buffer.alloc(32768, 0x5a));
  const archive = path.join(source, 'app.asar');
  await asar.createPackageWithOptions(packedInput, archive, { unpackDir: 'native' });
  physicalFs.writeFileSync(path.join(source, 'ordinary.txt'), 'ordinary scratch file\n');
  const unpacked = path.join(source, 'app.asar.unpacked', 'native', 'external.bin');
  const expected = { archive: { hash: hash(archive), bytes: physicalFs.statSync(archive).size },
    unpacked: { hash: hash(unpacked), bytes: physicalFs.statSync(unpacked).size } };
  const probe = { name, interrupted, expected,
    electronLstat: inspectArchive(archive),
    physicalLstat: { isFile: physicalFs.lstatSync(archive).isFile(), isDirectory: physicalFs.lstatSync(archive).isDirectory() } };
  result.cases.push(probe);
  check(name + ': real archive is interpreted as a directory by Electron', () => {
    assert.equal(probe.electronLstat.isDirectory, true);
    assert.equal(probe.physicalLstat.isFile, true);
    assert.equal(probe.electronLstat.entry, 'module.exports = "real ASAR fixture";\n');
    assert.equal(probe.electronLstat.unpackedBytes, 32768);
  });
  let oldStaging = null;
  if (interrupted) {
    physicalFs.mkdirSync(targetRoot);
    const token = 'a'.repeat(32), targetDir = path.join(targetRoot, id);
    oldStaging = path.join(targetRoot, '.relay-migrate-' + id + '-' + token);
    physicalFs.mkdirSync(path.join(oldStaging, 'app.asar'), { recursive: true });
    physicalFs.writeFileSync(path.join(oldStaging, 'app.asar', 'partial.txt'), 'unfinished old copy');
    physicalFs.writeFileSync(path.join(oldStaging, '.relay-migration-' + token + '.json'), JSON.stringify({
      version: 1, conversationId: id, token, source, target: targetDir,
    }));
    records[id].scratchMigration = { token, root: targetRoot, realRoot: physicalFs.realpathSync(targetRoot), sourceDir: source, stagingDir: oldStaging, targetDir };
    options.saveRecords();
    records = JSON.parse(physicalFs.readFileSync(recordsFile, 'utf8'));
    service = createConversationScratch(options);
  }
  let migrated, caught;
  const migrationStarted = process.hrtime.bigint();
  try { migrated = await service.migrate(id, targetRoot); } catch (error) { caught = error; }
  probe.migrationMs = Number(process.hrtime.bigint() - migrationStarted) / 1e6;
  probe.migration = migrated || null;
  probe.error = caught ? { name: caught.name, code: caught.code || null, message: caught.message.slice(0, 1200) } : null;
  probe.pendingTransaction = records[id].scratchMigration || null;
  save();
  if (expectRegression) {
    check(name + ': old implementation fails on the real ASAR archive', () => {
      assert.ok(caught, 'The old implementation unexpectedly succeeded');
      assert.match(caught.message, /app\.asar/);
    });
    check(name + ': failed migration retains the original archive exactly', () => {
      assert.equal(hash(archive), expected.archive.hash);
      assert.equal(physicalFs.statSync(archive).size, expected.archive.bytes);
      assert.equal(hash(unpacked), expected.unpacked.hash);
      assert.equal(records[id].scratchDir, source);
    });
    return;
  }
  if (caught) throw caught;
  const target = path.join(targetRoot, id), copiedArchive = path.join(target, 'app.asar');
  check(name + ': migration commits the target and cleans the original', () => {
    assert.equal(migrated.migrated, true); assert.equal(migrated.cleanupPending, undefined);
    assert.equal(records[id].scratchDir, target);
    assert.equal(physicalFs.existsSync(source), false);
    assert.equal(records[id].scratchMigration, undefined);
    assert.equal(records[id].scratchPrevious, undefined);
  });
  check(name + ': archive remains one physical file with identical bytes and hash', () => {
    const stat = physicalFs.lstatSync(copiedArchive);
    assert.equal(stat.isFile(), true); assert.equal(stat.isDirectory(), false);
    assert.equal(stat.size, expected.archive.bytes); assert.equal(hash(copiedArchive), expected.archive.hash);
    assert.equal(fs.readFileSync(path.join(copiedArchive, 'index.js'), 'utf8'), 'module.exports = "real ASAR fixture";\n');
  });
  check(name + ': unpacked companion and ordinary files survive', () => {
    const copiedUnpacked = path.join(target, 'app.asar.unpacked', 'native', 'external.bin');
    assert.equal(hash(copiedUnpacked), expected.unpacked.hash);
    assert.equal(physicalFs.statSync(copiedUnpacked).size, expected.unpacked.bytes);
    assert.equal(physicalFs.readFileSync(path.join(target, 'ordinary.txt'), 'utf8'), 'ordinary scratch file\n');
    assert.equal(fs.readFileSync(path.join(copiedArchive, 'native', 'external.bin')).length, 32768);
  });
  if (oldStaging) check(name + ': restart removes the token-owned incomplete staging copy', () => {
    assert.equal(physicalFs.existsSync(oldStaging), false);
    assert.deepEqual(physicalFs.readdirSync(targetRoot), [id]);
    assert.equal(physicalFs.existsSync(path.join(target, 'partial.txt')), false);
  });
  probe.actualArchive = { hash: hash(copiedArchive), bytes: physicalFs.statSync(copiedArchive).size };
}
app.whenReady().then(async () => {
  try {
    assert.ok(process.versions.electron, 'Requires the real Electron runtime');
    await scenario('fresh', false);
    if (!expectRegression) await scenario('interrupted-retry', true);
    result.ok = true;
  } catch (error) {
    result.ok = false; result.failures.push({ name: error.name, message: error.message, stack: error.stack });
  } finally {
    clearTimeout(deadline); result.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ resultFile, ok: result.ok, checks: Object.keys(result.checks).length, failures: result.failures.map(error => error.message || error) }));
    app.exit(result.ok ? 0 : 1);
  }
});
