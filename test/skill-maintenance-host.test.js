'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillMaintenanceHost } = require('../skill-maintenance-host');
const { SkillDraftService, scanPackage } = require('../skill-draft-service');
const DAY = 86400000;
const START = Date.parse('2026-01-01T12:00:00Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-maintenance-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = START;
  const skillsDir = path.join(root, 'skills'), draftsRoot = path.join(root, 'draft-records');
  const service = new SkillDraftService({ skillsDir, draftsDir: draftsRoot, now: () => new Date(now) });
  const options = { skillsDir, draftsDir: path.join(draftsRoot, 'drafts'), stateDir: path.join(root, 'maintenance'), schedulesFile: path.join(root, 'schedules.json'), now: () => now };
  const host = new SkillMaintenanceHost(options);
  const body = (name, content = 'Reusable task instructions.') => `---\nname: ${name}\ndescription: Run a reusable workflow\n---\n# Workflow\n${content}\n`;
  const packageAt = (dir, name, content) => {
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body(name, content));
    fs.writeFileSync(path.join(dir, 'references', 'guide.md'), 'A complete support file.');
    fs.writeFileSync(path.join(dir, 'assets', 'sample.bin'), Buffer.from([0, 1, 2, 250]));
  };
  const publish = (name, { source = 'conversation-review', existing = false } = {}) => {
    if (existing) packageAt(path.join(skillsDir, name), name, 'Original user content.');
    const staging = path.join(root, `staging-${name}`); packageAt(staging, name, 'Improved reusable instructions.');
    const draft = service.createDraft({ skillName: name, stagingDir: staging, sourceRef: { type: source } });
    const result = service.publish(draft.id); host.recordPublished(result); return result;
  };
  const advance = days => { now = START + days * DAY; };
  const run = extra => host.run({ policy: { autoArchive: true }, usageReady: true, usage: new Map(), busy: false, lastActivityAt: new Date(now - DAY).toISOString(), ...extra });
  const seed = () => run();
  return { root, host, options, service, publish, advance, run, seed, packageAt, skillsDir };
}

test('only new Relay publications establish ownership; old agent markers, imports and user updates do not', t => {
  const f = fixture(t); f.publish('new-owned'); f.publish('old-updated', { existing: true }); f.publish('user-created', { source: 'manual' });
  f.packageAt(path.join(f.skillsDir, 'legacy'), 'legacy');
  fs.writeFileSync(path.join(f.skillsDir, '.usage.json'), JSON.stringify({ legacy: { createdBy: 'agent' } }));
  assert.equal(f.host.ownership('new-owned').verified, true);
  for (const name of ['old-updated', 'user-created', 'legacy']) assert.equal(f.host.ownership(name), null);
  assert.equal(fs.readFileSync(path.join(f.skillsDir, 'old-updated', 'SKILL.md'), 'utf8').includes('Improved'), true);
});

test('external package changes invalidate ownership; explicit known-owner edits can renew its hash', t => {
  const f = fixture(t); f.publish('owned');
  fs.appendFileSync(path.join(f.skillsDir, 'owned', 'SKILL.md'), '\nExternal change');
  assert.equal(f.host.ownership('owned'), null);
  f.host.recordActivity('owned', 'viewed'); assert.equal(f.host.ownership('owned'), null);
  f.host.recordActivity('owned', 'edited', { updateOwnedHash: true });
  assert.equal(f.host.ownership('owned').verified, true);
  f.host.forget('owned'); assert.equal(f.host.ownership('owned'), null);
});

test('first run waits one week; default does not archive; due run preserves complete package and supports restore', t => {
  const f = fixture(t); f.publish('owned');
  assert.equal(f.seed().reason, 'first-observation'); f.advance(100);
  assert.equal(f.run({ policy: {} }).archived.length, 0); f.advance(108);
  const before = scanPackage(path.join(f.skillsDir, 'owned'));
  const result = f.run(); assert.equal(result.archived.length, 1);
  assert.equal(fs.existsSync(path.join(f.skillsDir, 'owned')), false);
  assert.equal(scanPackage(path.join(f.skillsDir, '.archive', 'owned')).treeHash, before.treeHash);
  assert.equal(scanPackage(path.join(f.options.stateDir, 'backups', result.archived[0].backupId, 'package')).treeHash, before.treeHash);
  f.host.restore('owned'); f.advance(116);
  assert.equal(f.run().archived.length, 0);
  assert.equal(f.host.activity('owned').restoredAt, new Date(START + 108 * DAY).toISOString());
});

test('disabled task aliases and direct draft references prevent automatic archive', t => {
  const f = fixture(t); f.publish('scheduled'); f.publish('drafted'); f.seed(); f.advance(100);
  fs.writeFileSync(f.options.schedulesFile, JSON.stringify({ tasks: [{ id: 'paused-job', enabled: false, action: { prompt: 'Use /scheduled for the report.' }, schedule: { kind: 'weekly' } }] }));
  const staging = path.join(f.root, 'pending'); f.packageAt(staging, 'drafted', 'Candidate depends on its base.');
  f.service.createDraft({ skillName: 'drafted', stagingDir: staging, sourceRef: { type: 'conversation-review' } });
  assert.equal(f.run().archived.length, 0);
});

test('pending curator umbrella preserves all possible source packages', t => {
  const f = fixture(t); f.publish('source-one'); f.publish('source-two'); f.seed(); f.advance(100);
  const staging = path.join(f.root, 'umbrella'); f.packageAt(staging, 'umbrella', 'Combined reusable workflows.');
  f.service.createDraft({ skillName: 'umbrella', stagingDir: staging, sourceRef: { type: 'skill-curator' } });
  assert.equal(f.run().archived.length, 0);
});

test('corrupt task, draft, usage or host metadata fails closed without losing a live skill', t => {
  for (const part of ['tasks', 'drafts', 'usage', 'host']) {
    const f = fixture(t); f.publish(`owned-${part}`); f.seed(); f.advance(100);
    if (part === 'tasks') fs.writeFileSync(f.options.schedulesFile, '{broken');
    if (part === 'drafts') { fs.mkdirSync(path.join(f.options.draftsDir, 'broken')); fs.writeFileSync(path.join(f.options.draftsDir, 'broken', 'record.json'), '{bad'); }
    if (part === 'usage') fs.writeFileSync(path.join(f.skillsDir, '.usage.json'), '[]');
    if (part === 'host') fs.writeFileSync(f.host.stateFile, '[]');
    assert.throws(() => f.run()); assert.equal(fs.existsSync(path.join(f.skillsDir, `owned-${part}`)), true);
  }
});

test('unknown or busy runtime, incomplete usage, and recent viewing/editing prevent archive', t => {
  const f = fixture(t); f.publish('owned'); f.seed(); f.advance(100);
  for (const state of [{ busy: true }, { busy: undefined }, { lastActivityAt: null }, { usageReady: false }]) assert.equal(f.run(state).archived.length, 0);
  f.host.recordActivity('owned', 'viewed'); assert.equal(f.run().archived.length, 0);
  f.advance(108); f.host.recordActivity('owned', 'edited'); assert.equal(f.run().archived.length, 0);
});

test('manual archive collision never overwrites an older archive and does not need ownership', t => {
  const f = fixture(t); f.packageAt(path.join(f.skillsDir, 'manual'), 'manual');
  f.packageAt(path.join(f.skillsDir, '.archive', 'manual'), 'manual', 'Older archive.');
  const beforeLive = scanPackage(path.join(f.skillsDir, 'manual')), beforeOld = scanPackage(path.join(f.skillsDir, '.archive', 'manual'));
  assert.throws(() => f.host.archive('manual'), { code: 'ARCHIVE_EXISTS' });
  assert.equal(scanPackage(path.join(f.skillsDir, 'manual')).treeHash, beforeLive.treeHash);
  assert.equal(scanPackage(path.join(f.skillsDir, '.archive', 'manual')).treeHash, beforeOld.treeHash);
  f.packageAt(path.join(f.skillsDir, 'other'), 'other'); assert.equal(f.host.archive('other').name, 'other');
});

test('backup copy failures and corrupt copied bytes leave the entire live package in place', t => {
  for (const corrupt of [false, true]) {
    const f = fixture(t); f.publish('owned'); const before = scanPackage(path.join(f.skillsDir, 'owned'));
    const io = Object.create(fs);
    io.cpSync = (source, dest, options) => {
      if (!corrupt) throw new Error('simulated disk full');
      fs.cpSync(source, dest, options); fs.appendFileSync(path.join(dest, 'references', 'guide.md'), 'bad bytes');
    };
    const host = new SkillMaintenanceHost({ ...f.options, fs: io });
    assert.throws(() => host.archive('owned'));
    assert.equal(scanPackage(path.join(f.skillsDir, 'owned')).treeHash, before.treeHash);
    assert.equal(fs.existsSync(path.join(f.skillsDir, '.archive', 'owned')), false);
  }
});

test('state write failure before archive stops, and after-move failure restores the live package', t => {
  for (const failAt of [1, 2]) {
    const f = fixture(t); f.publish('owned'); const before = scanPackage(path.join(f.skillsDir, 'owned'));
    const io = Object.create(fs); let commits = 0;
    io.renameSync = (source, dest) => { if (dest === f.host.stateFile && ++commits === failAt) throw new Error('state write failed'); return fs.renameSync(source, dest); };
    const host = new SkillMaintenanceHost({ ...f.options, fs: io });
    assert.throws(() => host.archive('owned'));
    assert.equal(scanPackage(path.join(f.skillsDir, 'owned')).treeHash, before.treeHash);
    assert.equal(fs.existsSync(path.join(f.skillsDir, '.archive', 'owned')), false);
  }
});

test('symbolic links and unsafe names cannot move a package outside the library', t => {
  const f = fixture(t); f.publish('owned');
  for (const name of ['../owned', 'foo/bar', '__proto__', 'CON', '.archive', 'owned\\bad']) assert.throws(() => f.host.archive(name));
  const elsewhere = path.join(f.root, 'outside'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(f.skillsDir, '.archive'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.host.archive('owned'), { code: 'UNSAFE_ARCHIVE_ROOT' });
  assert.equal(fs.existsSync(path.join(f.skillsDir, 'owned')), true);
});
