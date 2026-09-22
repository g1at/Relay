'use strict';
// Execute the actual main-process write handlers against private temporary files.
// The controlled admission gate represents a worker transaction already in flight.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { SkillMaintenanceHost } = require('../src/main/skills/skill-maintenance-host');
const source = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');

function declaration(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n}', match.index);
  assert.ok(end > match.index, `${name} has a complete declaration`);
  return source.slice(match.index, end + 2);
}
function handler(name) {
  const start = source.indexOf(`ipcMain.handle('${name}',`), end = source.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, `${name} exists`);
  return source.slice(start, end + 4);
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const body = text => `---\nname: guide\ndescription: Synthetic fixture only\n---\n# ${text}\n`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-library-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillsDir = path.join(root, 'skills'), agentsDir = path.join(root, 'agents');
  fs.mkdirSync(skillsDir); fs.mkdirSync(agentsDir);
  const host = new SkillMaintenanceHost({ skillsDir, stateDir: path.join(root, 'maintenance'),
    schedulesFile: path.join(root, 'schedules.json'), draftsDir: path.join(root, 'drafts') });
  const handlers = new Map(), gates = [], reloads = [], models = [];
  let inGate = false;
  const context = {
    fs, path, Buffer, console: { log() {}, warn() {}, error() {} },
    SKILLS_DIR: skillsDir, AGENTS_DIR: agentsDir,
    SKILL_USAGE_FILE: () => path.join(skillsDir, '.usage.json'),
    SKILL_ARCHIVE_DIR: () => path.join(skillsDir, '.archive'),
    skillDraftService: { runExclusive(write) { return new Promise((resolve, reject) => gates.push({ write, resolve, reject })); } },
    ipcMain: { handle(name, callback) { handlers.set(name, callback); } },
    getSkillMaintenanceHost: () => host,
    skillMaintenanceOwnership: () => ({ verified: false }),
    recordSkillActivity: (...args) => host.recordActivity(...args),
    reloadSkillsInLiveSessions(reason) {
      assert.equal(inGate, false, 'live-session reload must run outside the filesystem transaction');
      return new Promise(resolve => reloads.push({ reason, resolve }));
    },
    generateSkillPresentationWithClaude(...args) {
      assert.equal(inGate, false, 'model generation must not reserve the filesystem transaction');
      return new Promise(resolve => models.push({ args, resolve }));
    },
  };
  vm.createContext(context);
  for (const name of ['withSkillLibraryWrite', 'managedDataItem', 'parseFrontmatter', 'parseSkillPresentationYaml',
    'skillBodyPresentation', 'listSkillNames', 'readSkillUsage', 'writeSkillUsage',
    'writeRelaySkillPresentation', 'generateRelaySkillPresentation']) vm.runInContext(declaration(name), context);
  for (const name of ['data:writeItem', 'data:removeSkill', 'skills:archive', 'skills:restore', 'skills:deleteArchived']) {
    vm.runInContext(handler(name), context);
  }
  const skill = (name = 'guide', text = 'Original') => {
    const directory = path.join(skillsDir, name);
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'SKILL.md'), body(text));
    return directory;
  };
  const release = async () => {
    assert.ok(gates.length, 'a library transaction is queued');
    const entry = gates.shift();
    inGate = true;
    try {
      const result = entry.write();
      assert.ok(!result || typeof result.then !== 'function', 'the lock may contain only a synchronous filesystem transaction');
      entry.resolve(result);
    } catch (error) { entry.reject(error); }
    finally { inGate = false; }
    await turn();
  };
  return { root, skillsDir, agentsDir, host, context, gates, reloads, models, skill, release,
    call: (name, args) => handlers.get(name)({}, args),
    generated: directory => context.generateRelaySkillPresentation(directory),
    yaml: directory => path.join(directory, 'agents', 'relay.yaml'),
  };
}

test('actual skill editing waits for library admission while agent editing remains independent', async t => {
  const h = fixture(t), directory = h.skill(), file = path.join(directory, 'SKILL.md');
  fs.writeFileSync(path.join(h.agentsDir, 'helper.md'), 'Original agent');
  let settled = false;
  const pending = h.call('data:writeItem', { kind: 'skill', key: 'guide', content: body('Edited') }).then(result => { settled = true; return result; });
  await turn(); assert.equal(settled, false); assert.equal(h.gates.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), body('Original')); assert.equal(fs.existsSync(file + '.tmp'), false);
  assert.equal((await h.call('data:writeItem', { kind: 'agent', key: 'helper.md', content: 'Edited agent' })).ok, true);
  assert.equal(fs.readFileSync(path.join(h.agentsDir, 'helper.md'), 'utf8'), 'Edited agent'); assert.equal(h.gates.length, 1);
  await h.release(); assert.equal((await pending).ok, true); assert.equal(fs.readFileSync(file, 'utf8'), body('Edited'));
  assert.ok(h.host.activity('guide').lastEditedAt);
});

test('actual removeSkill waits before deleting the package and its maintenance record', async t => {
  const h = fixture(t), directory = h.skill(); h.host.recordActivity('guide', 'edited');
  const pending = h.call('data:removeSkill', { name: 'guide' }); await turn();
  assert.equal(h.gates.length, 1); assert.equal(fs.existsSync(directory), true); assert.ok(h.host.activity('guide').lastEditedAt);
  await h.release(); const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.items.length, 0); assert.equal(fs.existsSync(directory), false);
  assert.equal(h.host.activity('guide').lastEditedAt, undefined);
});

for (const action of ['archive', 'restore']) {
  test(`actual ${action} waits for admission and releases the lock before a delayed live reload`, async t => {
    const h = fixture(t), directory = h.skill(), archive = path.join(h.skillsDir, '.archive', 'guide');
    if (action === 'restore') h.host.archive('guide');
    const from = action === 'archive' ? directory : archive, to = action === 'archive' ? archive : directory;
    let settled = false;
    const pending = h.call(`skills:${action}`, { name: 'guide' }).then(result => { settled = true; return result; });
    await turn(); assert.equal(h.gates.length, 1); assert.equal(fs.existsSync(from), true); assert.equal(fs.existsSync(to), false);
    assert.equal(h.reloads.length, 0); assert.equal(settled, false);
    await h.release(); assert.equal(fs.existsSync(from), false); assert.equal(fs.readFileSync(path.join(to, 'SKILL.md'), 'utf8'), body('Original'));
    assert.equal(h.reloads.length, 1); assert.equal(settled, false);
    assert.equal(h.context.readSkillUsage().guide.state, action === 'archive' ? 'archived' : 'active');
    // A second edit can finish while the first action still awaits a runtime reload.
    const other = h.skill('other');
    const edit = h.call('data:writeItem', { kind: 'skill', key: 'other', content: body('Concurrent edit') });
    await h.release(); assert.equal((await edit).ok, true); assert.equal(fs.readFileSync(path.join(other, 'SKILL.md'), 'utf8'), body('Concurrent edit'));
    assert.equal(settled, false); h.reloads[0].resolve({ applied: true }); assert.equal((await pending).ok, true);
  });
}

test('actual deleteArchived waits before deleting its package and persisted sidecar', async t => {
  const h = fixture(t); h.skill(); h.host.archive('guide');
  const archive = path.join(h.skillsDir, '.archive', 'guide'); h.context.writeSkillUsage({ guide: { state: 'archived' } });
  const pending = h.call('skills:deleteArchived', { name: 'guide' }); await turn();
  assert.equal(h.gates.length, 1); assert.equal(fs.existsSync(archive), true); assert.ok(h.context.readSkillUsage().guide);
  await h.release(); assert.equal((await pending).ok, true);
  assert.equal(fs.existsSync(archive), false); assert.equal(h.context.readSkillUsage().guide, undefined);
  assert.equal(h.host.readState().records.guide, undefined);
});

test('a restore blocked by an existing live skill preserves both packages and skips reload', async t => {
  const h = fixture(t); h.skill(); h.host.archive('guide'); const live = h.skill('guide', 'Current live');
  const pending = h.call('skills:restore', { name: 'guide' }); await h.release();
  assert.equal((await pending).ok, false); assert.equal(h.reloads.length, 0);
  assert.equal(fs.readFileSync(path.join(live, 'SKILL.md'), 'utf8'), body('Current live'));
  assert.equal(fs.readFileSync(path.join(h.skillsDir, '.archive', 'guide', 'SKILL.md'), 'utf8'), body('Original'));
});

test('metadata model work does not hold the library gate and the eventual file commit does', async t => {
  const h = fixture(t), directory = h.skill();
  const pending = h.generated(directory); assert.equal(h.models.length, 1); assert.equal(h.gates.length, 0);
  const other = h.skill('other'); const edit = h.call('data:writeItem', { kind: 'skill', key: 'other', content: body('Edited during model') });
  await h.release(); assert.equal((await edit).ok, true); assert.equal(fs.readFileSync(path.join(other, 'SKILL.md'), 'utf8'), body('Edited during model'));
  assert.equal(fs.existsSync(h.yaml(directory)), false);
  h.models[0].resolve({ displayName: '合成标题', summary: '合成说明' }); await turn();
  assert.equal(h.gates.length, 1); assert.equal(fs.existsSync(h.yaml(directory)), false);
  await h.release(); const result = await pending;
  assert.equal(result.generatedBy, 'llm'); assert.match(fs.readFileSync(h.yaml(directory), 'utf8'), /合成标题/);
});

for (const change of ['edit', 'delete']) {
  test(`late metadata after a ${change} during model generation cannot overwrite or recreate the skill`, async t => {
    const h = fixture(t), directory = h.skill();
    h.context.writeRelaySkillPresentation(directory, { displayName: 'Existing title', summary: 'Existing summary' });
    const prior = fs.readFileSync(h.yaml(directory), 'utf8');
    const pending = h.generated(directory), rejected = assert.rejects(pending, /技能内容已变化/);
    const mutation = change === 'edit'
      ? h.call('data:writeItem', { kind: 'skill', key: 'guide', content: body('User edit') })
      : h.call('data:removeSkill', { name: 'guide' });
    await h.release(); assert.equal((await mutation).ok, true);
    h.models[0].resolve({ displayName: 'Outdated generated title', summary: 'Outdated summary' }); await turn();
    assert.equal(h.gates.length, 1); await h.release(); await rejected;
    if (change === 'delete') assert.equal(fs.existsSync(directory), false);
    else {
      assert.equal(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'), body('User edit'));
      assert.equal(fs.readFileSync(h.yaml(directory), 'utf8'), prior);
    }
  });
}

test('metadata rechecks its original source only after admission, covering changes while queued', async t => {
  const h = fixture(t), directory = h.skill();
  const pending = h.generated(directory), rejected = assert.rejects(pending, /技能内容已变化/);
  h.models[0].resolve({ displayName: 'Generated', summary: 'Generated summary' }); await turn();
  assert.equal(h.gates.length, 1);
  fs.writeFileSync(path.join(directory, 'SKILL.md'), body('External edit while queued'));
  await h.release(); await rejected;
  assert.equal(fs.existsSync(h.yaml(directory)), false);
  assert.equal(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'), body('External edit while queued'));
});
