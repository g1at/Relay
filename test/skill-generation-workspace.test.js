'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { prepareSkillGenerationWorkspace } = require('../src/main/skills/skill-generation-workspace');
const { SkillDraftService } = require('../src/main/skills/skill-draft-service');
const { SkillDraftClient } = require('../src/main/skills/skill-draft-client');
const { registerSkillDraftIpc } = require('../src/main/skills/skill-draft-ipc');
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/bootstrap.js'), 'utf8');

function segment(start, end) {
  const first = mainSource.indexOf(start), last = mainSource.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return mainSource.slice(first, last);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-skill-generation-'));
  const skillsDir = path.join(root, 'live');
  const service = new SkillDraftService({ skillsDir, draftsDir: path.join(root, 'draft-state') });
  const write = (folder, text) => {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: guide\ndescription: Synthetic test instructions.\n---\n${text}\n`);
  };
  write(path.join(skillsDir, 'guide'), 'Original instructions.');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, skillsDir, service, write, prepare: () => prepareSkillGenerationWorkspace({ skillsDir, workspaceRoot: path.join(root, 'run') }) };
}

test('generation snapshots stay outside editable staging and the tool guard cannot reach them', async t => {
  const h = fixture(t), workspace = h.prepare();
  const read = folder => fs.readFileSync(path.join(folder, 'guide/SKILL.md'), 'utf8');
  assert.equal(read(workspace.baseDir), read(workspace.stagingRoot));
  h.write(path.join(workspace.stagingRoot, 'guide'), 'Candidate instructions.');
  assert.match(read(workspace.baseDir), /Original/);
  assert.match(read(h.skillsDir), /Original/);
  const context = vm.createContext({ fs, path });
  vm.runInContext(segment('function stagingPathAllowed(', '// 后台跑一次技能 review'), context);
  const guard = context.createStagingToolGuard(workspace.stagingRoot);
  assert.equal((await guard('Write', { file_path: path.join(workspace.stagingRoot, 'guide/SKILL.md') })).behavior, 'allow');
  assert.equal((await guard('Write', { file_path: path.join(workspace.baseDir, 'guide/SKILL.md') })).behavior, 'deny');
  assert.equal((await guard('Read', { file_path: '../base/guide/SKILL.md' })).behavior, 'deny');
});

test('copy-time live edits abort capture and remove only the newly created workspace', t => {
  const h = fixture(t), copy = fs.cpSync;
  t.mock.method(fs, 'cpSync', (source, destination, options) => {
    copy(source, destination, options);
    if (source === path.join(h.skillsDir, 'guide')) h.write(source, 'Concurrent live edit.');
  });
  assert.throws(() => h.prepare(), { code: 'BASE_CAPTURE_CONFLICT' });
  assert.equal(fs.existsSync(path.join(h.root, 'run')), false);
  assert.match(fs.readFileSync(path.join(h.skillsDir, 'guide/SKILL.md'), 'utf8'), /Concurrent/);
});

test('a pre-existing workspace is never reused or deleted', t => {
  const h = fixture(t), root = path.join(h.root, 'run');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'keep.txt'), 'existing workspace');
  assert.throws(() => h.prepare(), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'existing workspace');
});

test('draft creation keeps the generation baseline and detects later live edits', t => {
  const h = fixture(t), workspace = h.prepare();
  h.write(path.join(h.skillsDir, 'guide'), 'Concurrent live instructions.');
  h.write(path.join(workspace.stagingRoot, 'guide'), 'Generated candidate.');
  const draft = h.service.createDraft({ skillName: 'guide', stagingDir: workspace.stagingRoot, baseDir: workspace.baseDir });
  assert.equal(draft.readiness, 'stale');
  assert.equal(draft.canPublish, false);
  assert.match(h.service.diff(draft.id).text, /Original instructions/);
  assert.throws(() => h.service.publish(draft.id), { code: 'BASE_CONFLICT' });
});

test('an unchanged generation snapshot cannot become a rollback draft after live metadata changes', t => {
  const h = fixture(t), workspace = h.prepare();
  const metadata = path.join(h.skillsDir, 'guide/agents');
  fs.mkdirSync(metadata); fs.writeFileSync(path.join(metadata, 'relay.yaml'), 'display_name: Guide\n');
  assert.throws(() => h.service.createDraft({ skillName: 'guide', stagingDir: workspace.stagingRoot, baseDir: workspace.baseDir }), { code: 'NO_CHANGES' });
  assert.equal(h.service.list().length, 0);
});

function mainFixture(h) {
  const events = [], context = vm.createContext({ fs, path, crypto, console,
    app: { getPath: () => h.root }, SKILLS_DIR: h.skillsDir, skillDraftService: h.service,
    prepareSkillGenerationWorkspace, refreshSkillUsageInBackground: async () => {},
    buildSkillCuratorPrompt: () => 'Synthetic curator', createStagingToolGuard: () => async () => {},
    Notification: { isSupported: () => false }, APP_ICON: null,
    broadcastSkillDraftEvent: (...args) => events.push(args),
  });
  vm.runInContext(segment('function prepareSkillCurator()', '// 定时任务只保存声明'), context);
  return { context, events };
}

test('scheduled curator freezes its base before generation and cleans both copies after finishing', async t => {
  const h = fixture(t), { context, events } = mainFixture(h);
  const workspace = context.prepareSkillCurator();
  h.write(path.join(workspace.stagingRoot, 'guide'), 'Curated candidate.');
  h.write(path.join(h.skillsDir, 'guide'), 'Independent edit during curator run.');
  const result = await context.finalizeSkillCuratorDrafts({ ok: true }, workspace);
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].readiness, 'stale');
  assert.equal(fs.existsSync(workspace.workspaceRoot), false);
  assert.equal(events[0][0], 'skillDraft.created');
  assert.match(h.service.diff(result.drafts[0].id).text, /Original instructions/);
});

test('cancelled curator only cleans its workspace and emits no draft or live write', async t => {
  const h = fixture(t), { context, events } = mainFixture(h);
  const workspace = context.prepareSkillCurator();
  h.write(path.join(workspace.stagingRoot, 'guide'), 'Incomplete candidate.');
  await context.finalizeSkillCuratorDrafts({ ok: false }, workspace);
  assert.equal(fs.existsSync(workspace.workspaceRoot), false);
  assert.equal(h.service.list().length, 0);
  assert.equal(events.length, 0);
  assert.match(fs.readFileSync(path.join(h.skillsDir, 'guide/SKILL.md'), 'utf8'), /Original/);
});

test('shutdown drains every finalized curator candidate before deleting its workspace', async t => {
  const h = fixture(t), { context, events } = mainFixture(h);
  const workspace = context.prepareSkillCurator();
  h.write(path.join(workspace.stagingRoot, 'guide'), 'First finalized candidate.');
  const second = path.join(workspace.stagingRoot, 'second');
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, 'SKILL.md'), '---\nname: second\ndescription: Synthetic second candidate.\n---\nSecond finalized candidate.\n');

  class FakeWorker extends EventEmitter {
    constructor() { super(); this.sent = []; }
    postMessage(message) { this.sent.push(message); }
    ref() {}
    unref() {}
    reply() {
      const request = this.sent.at(-1);
      assert.equal(request.method, 'createDraft');
      // Persist through the real service when the simulated worker completes.
      const value = h.service.createDraft(...request.args);
      this.emit('message', { requestId: request.requestId, ok: true, value });
    }
  }
  const client = new SkillDraftClient({
    skillsDir: h.skillsDir, draftsDir: path.join(h.root, 'draft-state'), WorkerClass: FakeWorker,
  });
  context.skillDraftService = client;
  const finished = context.finalizeSkillCuratorDrafts({ ok: true }, workspace);
  const worker = client.worker;
  try {
    assert.equal(worker.sent.length, 1);
    const closing = client.close();
    await assert.rejects(client.list(), { code: 'SKILL_DRAFT_CLOSED' });

    worker.reply();
    await Promise.resolve();
    assert.equal(worker.sent.length, 2, 'The second candidate was admitted before shutdown');
    assert.equal(worker.sent[1].method, 'createDraft');
    assert.equal(fs.existsSync(workspace.workspaceRoot), true, 'Queued candidates still need their staging files');

    worker.reply();
    const result = await finished;
    assert.equal(result.drafts.length, 2);
    assert.deepEqual(h.service.list().map(draft => draft.skillName).sort(), ['guide', 'second']);
    assert.equal(events.length, 2);
    assert.equal(fs.existsSync(workspace.workspaceRoot), false);
    assert.match(fs.readFileSync(path.join(h.skillsDir, 'guide/SKILL.md'), 'utf8'), /Original/);
    assert.equal(fs.existsSync(path.join(h.skillsDir, 'second')), false);
    assert.deepEqual(worker.sent.at(-1), { type: 'close' });
    worker.emit('exit', 0);
    await closing;
  } finally {
    if (client.worker) worker.emit('exit', 1);
    await client.close();
    await finished;
  }
});

function reviewFixture(h, generate) {
  const events = [], notices = [], runs = [];
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    show() { notices.push(this.options); }
  }
  const context = vm.createContext({ fs, path, crypto, setImmediate,
    console: { log() {}, warn() {}, error() {} },
    reviewInflight: false, pendingSkillReviews: [], MAX_PENDING_SKILL_REVIEWS: 4,
    app: { getPath: () => h.root }, SKILLS_DIR: h.skillsDir,
    skillDraftService: h.service, prepareSkillGenerationWorkspace,
    buildSkillReviewPrompt: () => 'Synthetic review', createStagingToolGuard: () => async () => {},
    runRelayText: async options => { runs.push(options); await generate(options); },
    Notification, currentAppIcon: () => undefined,
    broadcastSkillDraftEvent: (...args) => events.push(args),
  });
  vm.runInContext(segment('function runSkillReviewJob(', '// 读/写 二期配置'), context);
  return { context, events, notices, runs, async finish() {
    for (let turns = 0; context.reviewInflight && turns < 50; turns++) await new Promise(setImmediate);
    assert.equal(context.reviewInflight, false, 'Review should finish and release its queue');
  } };
}

test('conversation review compares against its initial copy even when live changes during generation', async t => {
  const h = fixture(t), review = reviewFixture(h, options => {
    h.write(path.join(options.cwd, 'guide'), 'Conversation candidate.');
    h.write(path.join(h.skillsDir, 'guide'), 'Live edited during conversation review.');
  });
  assert.equal(review.context.runSkillReviewJob({ conversationText: 'Synthetic correction' }).started, true);
  await review.finish();
  const [draft] = h.service.list();
  assert.equal(draft.readiness, 'stale');
  assert.match(h.service.diff(draft.id).text, /Original instructions/);
  assert.equal(review.events[0][0], 'skillDraft.created');
  assert.equal(fs.existsSync(path.dirname(review.runs[0].cwd)), false);
  assert.throws(() => h.service.publish(draft.id), { code: 'BASE_CONFLICT' });
});

test('repeated conversation review reuses the candidate and suppresses duplicate notifications', async t => {
  const h = fixture(t), review = reviewFixture(h, options => {
    h.write(path.join(options.cwd, 'guide'), 'Same generated candidate.');
  });
  for (let index = 0; index < 2; index++) {
    review.context.runSkillReviewJob({ conversationText: `Synthetic review ${index}` });
    await review.finish();
  }
  const [draft] = h.service.list();
  assert.equal(h.service.list().length, 1);
  assert.equal(draft.sourceCount, 2);
  assert.equal(review.notices.length, 1);
  assert.equal(review.events[1][0], 'skillDraft.updated');
  assert.ok(review.runs.every(run => !fs.existsSync(path.dirname(run.cwd))));
});

test('failed conversation review cleans both snapshots without creating a candidate', async t => {
  const h = fixture(t), review = reviewFixture(h, options => {
    h.write(path.join(options.cwd, 'guide'), 'Partial candidate.');
    throw new Error('Synthetic generation failure');
  });
  review.context.runSkillReviewJob({ conversationText: 'Synthetic failed review' });
  await review.finish();
  assert.equal(h.service.list().length, 0);
  assert.equal(review.events.length, 0);
  assert.equal(review.notices.length, 0);
  assert.equal(fs.existsSync(path.dirname(review.runs[0].cwd)), false);
});

test('draft rebase IPC preserves conflict details and never reloads or publishes live skills', async () => {
  const handlers = new Map(), seen = [], events = [];
  const context = vm.createContext({
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    skillDraftService: { rebaseDraft(id, options) {
      seen.push({ id, options });
      if (!options.expectedCurrentTreeHash) throw Object.assign(new Error('Conflict'), { code: 'REBASE_CONFLICT', details: { currentTreeHash: 'current', conflicts: [{ path: 'SKILL.md' }] } });
      return { draft: { id: 'replacement', status: 'draft' }, previous: { id }, alreadyApplied: false };
    } }, broadcastSkillDraftEvent: (...args) => events.push(args),
  });
  registerSkillDraftIpc({ ...context, getSkillDraftService: () => context.skillDraftService });
  const handler = handlers.get('skillDrafts:rebase');
  const conflict = await handler({}, { id: 'original' });
  assert.equal(conflict.ok, false); assert.equal(conflict.code, 'REBASE_CONFLICT');
  assert.equal(conflict.details.currentTreeHash, 'current');
  const options = { expectedCurrentTreeHash: 'current', resolutions: { 'SKILL.md': { text: 'Resolved content' } } };
  const success = await handler({}, { id: 'original', options });
  assert.equal(success.result.draft.status, 'draft');
  assert.equal(seen[1].options, options);
  assert.equal(events[0][0], 'skillDraft.rebased');
});
