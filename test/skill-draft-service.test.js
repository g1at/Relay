'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  SkillDraftService,
  parseSkillFrontmatter,
  validateSkillPackage,
  scanPackage,
} = require('../skill-draft-service');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-skill-drafts-'));
  const skillsDir = path.join(root, 'live');
  const draftsDir = path.join(root, 'state');
  const stagingDir = path.join(root, 'staging');
  fs.mkdirSync(stagingDir, { recursive: true });
  let sequence = 0;
  const service = new SkillDraftService({
    skillsDir,
    draftsDir,
    idFactory: () => String(++sequence),
    now: () => new Date('2026-08-25T12:00:00.000Z'),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, skillsDir, draftsDir, stagingDir, service };
}

function writePackage(root, input = {}) {
  fs.mkdirSync(root, { recursive: true });
  const name = input.name || path.basename(root);
  const description = input.description || 'Use this skill for Relay package tests.';
  const body = input.body || '# Instructions\n\nFollow the referenced guide.';
  fs.writeFileSync(path.join(root, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    body,
    '',
  ].join('\n'), 'utf8');
  for (const [relative, content] of Object.entries(input.files || {})) {
    const file = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  for (const relative of input.directories || []) {
    fs.mkdirSync(path.join(root, ...relative.split('/')), { recursive: true });
  }
  return root;
}

function freezeLibrary(skillsDir, root) {
  const baseline = fs.mkdtempSync(path.join(root, 'baseline-'));
  if (fs.existsSync(skillsDir)) fs.cpSync(skillsDir, baseline, { recursive: true });
  return baseline;
}

test('从 staging 创建完整包草稿，提供清单、校验和 SKILL.md 文本 diff', (t) => {
  const { skillsDir, stagingDir, service } = fixture(t);
  writePackage(path.join(skillsDir, 'relay-guide'), {
    body: '# Instructions\n\nRead [old notes](references/old.md).',
    files: {
      'references/old.md': 'old reference',
      'scripts/old.js': 'module.exports = 1;',
      'assets/old.txt': 'old asset',
    },
  });
  writePackage(path.join(stagingDir, 'relay-guide'), {
    body: '# Instructions\n\nRead [new notes](references/new.md) and run `scripts/check.js`.',
    files: {
      'references/new.md': 'new reference',
      'scripts/check.js': 'module.exports = 2;',
      'templates/report.md': '# Report',
      'assets/icon.txt': 'new asset',
      'manifest.json': JSON.stringify({ files: ['references/new.md', 'scripts/check.js', 'templates/report.md', 'assets/icon.txt'] }),
    },
    directories: ['templates/empty'],
  });

  const draft = service.createDraft({
    skillName: 'relay-guide',
    stagingDir,
    sourceRef: { runId: 'run-1' },
  });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.operation, 'update');
  assert.equal(draft.validation.ok, true, JSON.stringify(draft.validation.errors));
  assert.deepEqual(draft.changes.removed.sort(), ['assets/old.txt', 'references/old.md', 'scripts/old.js']);
  assert.ok(draft.changes.added.includes('templates/report.md'));
  assert.equal(service.list({ status: 'draft' }).length, 1);
  assert.equal(service.get(draft.id).sourceRef.runId, 'run-1');

  const diff = service.diff(draft.id);
  assert.equal(diff.changed, true);
  assert.match(diff.text, /^--- relay-guide\/SKILL\.md/m);
  assert.match(diff.text, /^-Read \[old notes\]/m);
  assert.match(diff.text, /^\+Read \[new notes\]/m);
  assert.match(diff.text, /^\+new reference/m);
  assert.ok(diff.files.some((file) => file.path === 'references/new.md'));
  const validation = service.validate(draft.id);
  assert.equal(validation.ok, true);
  assert.equal(validation.manifest.treeHash, draft.proposed.treeHash);
});

test('发布前保存完整 live 版本，发布采用整包替换，rollback 恢复整包', (t) => {
  const { skillsDir, stagingDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), {
    body: '# Old\n\nRead [old](references/old.md).',
    files: {
      'references/old.md': 'old reference',
      'scripts/old.js': 'old script',
      'assets/stale.bin': 'stale',
    },
  });
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), {
    body: '# New\n\nRead [new](references/new.md).',
    files: {
      'references/new.md': 'new reference',
      'scripts/new.js': 'new script',
      'templates/new.md': 'new template',
    },
    directories: ['assets/empty'],
  });
  const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  const result = service.publish(draft.id);

  assert.equal(result.draft.status, 'published');
  assert.equal(fs.readFileSync(path.join(live, 'references', 'new.md'), 'utf8'), 'new reference');
  assert.equal(fs.existsSync(path.join(live, 'references', 'old.md')), false);
  assert.equal(fs.existsSync(path.join(live, 'assets', 'stale.bin')), false);
  assert.equal(fs.statSync(path.join(live, 'assets', 'empty')).isDirectory(), true);
  const history = service.getHistory('relay-guide', result.history.id);
  assert.equal(history.reason, 'publish-preimage');
  assert.equal(history.snapshot.treeHash, draft.base.treeHash);
  assert.equal(service.listHistory('relay-guide').length, 1);

  const rollback = service.rollback('relay-guide', result.history.id);
  assert.equal(rollback.ok, true);
  assert.equal(fs.readFileSync(path.join(live, 'references', 'old.md'), 'utf8'), 'old reference');
  assert.equal(fs.existsSync(path.join(live, 'references', 'new.md')), false);
  assert.equal(fs.readFileSync(path.join(live, 'assets', 'stale.bin'), 'utf8'), 'stale');
  assert.ok(service.getHistory('relay-guide', rollback.backupVersionId));
});

test('publish 用 base tree hash 阻止覆盖 draft 创建后的 live 修改', (t) => {
  const { skillsDir, stagingDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Old\n\nKeep this.' });
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# New\n\nReplace this.' });
  const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  fs.appendFileSync(path.join(live, 'SKILL.md'), '\nexternal edit\n', 'utf8');

  assert.throws(
    () => service.publish(draft.id),
    (error) => error.code === 'BASE_CONFLICT',
  );
  assert.match(fs.readFileSync(path.join(live, 'SKILL.md'), 'utf8'), /external edit/);
  assert.equal(service.get(draft.id).status, 'draft');
});

test('history 快照之后发生的并发修改也会在原子替换前再次被阻止', (t) => {
  const { skillsDir, stagingDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Old\n\nKeep this.' });
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# New\n\nReplace this.' });
  const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  const captureHistory = service._captureHistory.bind(service);
  service._captureHistory = (...args) => {
    const history = captureHistory(...args);
    fs.appendFileSync(path.join(live, 'SKILL.md'), '\nracing edit\n', 'utf8');
    return history;
  };

  assert.throws(() => service.publishDraft(draft.id), (error) => error.code === 'BASE_CONFLICT');
  assert.match(fs.readFileSync(path.join(live, 'SKILL.md'), 'utf8'), /racing edit/);
  assert.equal(service.getDraft(draft.id).status, 'draft');
});

test('无效 frontmatter、manifest 和死链接进入可审阅草稿，但不能发布', (t) => {
  const { skillsDir, stagingDir, service } = fixture(t);
  writePackage(path.join(skillsDir, 'broken-skill'), { body: '# Old\n\nValid.' });
  const staging = path.join(stagingDir, 'broken-skill');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'SKILL.md'), [
    '---',
    'name broken-skill',
    'description: invalid',
    '---',
    'Read [missing](references/missing.md).',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(staging, 'manifest.json'), '{not json', 'utf8');

  const draft = service.createDraft({ skillName: 'broken-skill', stagingDir: staging });
  assert.equal(draft.validation.ok, false);
  const validation = service.validateDraft(draft.id);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((issue) => issue.code === 'INVALID_FRONTMATTER'));
  assert.ok(validation.errors.some((issue) => issue.code === 'INVALID_MANIFEST'));
  assert.ok(validation.errors.some((issue) => issue.code === 'BROKEN_REFERENCE'));
  assert.throws(() => service.publishDraft(draft.id), (error) => error.code === 'DRAFT_INVALID');
});

test('frontmatter 调用名必须与包名一致', (t) => {
  const { stagingDir } = fixture(t);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { name: 'another-name' });
  const validation = validateSkillPackage(staging, { skillName: 'relay-guide' });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((issue) => issue.code === 'NAME_MISMATCH'));
});

test('发布时阻止与既有 Skill 调用名大小写冲突', (t) => {
  const { skillsDir, stagingDir, service } = fixture(t);
  writePackage(path.join(skillsDir, 'legacy-wrapper'), { name: 'NEW-SKILL' });
  const staging = writePackage(path.join(stagingDir, 'new-skill'), { name: 'new-skill' });
  const draft = service.createDraft({ skillName: 'new-skill', stagingDir: staging });
  assert.throws(() => service.publishDraft(draft.id), (error) => error.code === 'SKILL_NAME_CONFLICT');
});

test('reject 保留审计记录且不改 live，拒绝后的 draft 不能发布', (t) => {
  const { skillsDir, stagingDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Old\n\nKeep.' });
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# New\n\nDiscard.' });
  const before = fs.readFileSync(path.join(live, 'SKILL.md'), 'utf8');
  const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  const rejected = service.reject(draft.id, '内容太宽泛');

  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejection.reason, '内容太宽泛');
  assert.equal(fs.readFileSync(path.join(live, 'SKILL.md'), 'utf8'), before);
  assert.equal(service.listDrafts({ status: 'rejected' }).length, 1);
  assert.throws(() => service.publishDraft(draft.id), (error) => error.code === 'INVALID_DRAFT_STATE');
});

test('draft 存储被外部篡改后静态校验和 publish 都会阻止', (t) => {
  const { skillsDir, stagingDir, draftsDir, service } = fixture(t);
  writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Old\n\nKeep.' });
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# New\n\nPublish.' });
  const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  fs.appendFileSync(path.join(draftsDir, 'drafts', draft.id, 'proposed', 'SKILL.md'), '\ntampered\n', 'utf8');

  const validation = service.validateDraft(draft.id);
  assert.equal(validation.ok, false);
  assert.equal(validation.errors[0].code, 'DRAFT_PACKAGE_CHANGED');
  assert.throws(() => service.publishDraft(draft.id), (error) => error.code === 'DRAFT_INVALID');
});

test('新建 skill 的历史版本表示“不存在”，rollback 会安全撤销整个新包', (t) => {
  const { skillsDir, stagingDir, service } = fixture(t);
  const staging = writePackage(path.join(stagingDir, 'new-skill'), {
    body: '# New skill\n\nUse `scripts/run.js`.',
    files: { 'scripts/run.js': 'module.exports = true;' },
  });
  const draft = service.createDraft({ skillName: 'new-skill', stagingDir: staging });
  assert.equal(draft.operation, 'create');
  assert.equal(draft.base.exists, false);
  const published = service.publishDraft(draft.id);
  assert.equal(fs.existsSync(path.join(skillsDir, 'new-skill', 'SKILL.md')), true);
  const restored = service.rollback('new-skill', published.history.id);
  assert.equal(restored.restored.exists, false);
  assert.equal(fs.existsSync(path.join(skillsDir, 'new-skill')), false);
});

test('路径安全与 frontmatter block scalar 校验', (t) => {
  const { stagingDir, service } = fixture(t);
  assert.throws(
    () => service.createDraft({ skillName: '../escape', stagingDir }),
    (error) => error.code === 'INVALID_SKILL_NAME',
  );
  const parsed = parseSkillFrontmatter([
    '---',
    'name: safe-skill',
    'description: >',
    '  Use this skill when a package needs',
    '  safe publication.',
    'metadata:',
    '  owner: relay',
    '---',
    '# Body',
    '',
  ].join('\n'));
  assert.equal(parsed.fields.name, 'safe-skill');
  assert.equal(parsed.fields.description, 'Use this skill when a package needs safe publication.');

  const unsafe = path.join(stagingDir, 'unsafe');
  writePackage(unsafe, { name: 'unsafe', files: { 'scripts/run.js': 'ok' } });
  try {
    fs.symlinkSync(path.join(unsafe, 'scripts', 'run.js'), path.join(unsafe, 'scripts', 'link.js'));
  } catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.diagnostic('当前 Windows 权限不允许创建测试用 symlink，已保留其他路径安全断言');
      return;
    }
    throw error;
  }
  const result = validateSkillPackage(unsafe, { skillName: 'unsafe' });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'SYMLINK_NOT_ALLOWED');
});

test('生成时冻结的整库快照作为基线，生成期间修改会预先显示 stale', (t) => {
  const { root, skillsDir, stagingDir, draftsDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Original' });
  const baseline = freezeLibrary(skillsDir, root);
  const originalHash = scanPackage(live).treeHash;
  writePackage(live, { body: '# Changed during generation' });
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# Generated change' });
  const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, baseDir: baseline });
  assert.equal(draft.base.treeHash, originalHash);
  assert.equal(draft.readiness, 'stale');
  assert.equal(draft.canPublish, false);
  assert.equal(draft.validation.ok, true);
  assert.equal(service.validate(draft.id).readiness, 'stale');
  assert.match(fs.readFileSync(path.join(draftsDir, 'drafts', draft.id, 'base', 'SKILL.md'), 'utf8'), /# Original/);
  assert.throws(() => service.publish(draft.id), (error) => error.code === 'BASE_CONFLICT');
});

test('冻结基线中不存在的新技能不会错误地使用整库或当前同名包', (t) => {
  const { root, skillsDir, stagingDir, service } = fixture(t);
  writePackage(path.join(skillsDir, 'other-skill'));
  const baseline = freezeLibrary(skillsDir, root);
  writePackage(path.join(skillsDir, 'new-skill'), { body: '# Independently created' });
  const staging = writePackage(path.join(stagingDir, 'new-skill'), { body: '# Generated' });
  const draft = service.createDraft({ skillName: 'new-skill', stagingDir: staging, baseDir: baseline });
  assert.equal(draft.operation, 'create');
  assert.equal(draft.base.exists, false);
  assert.equal(draft.readiness, 'stale');
});

test('相同 skill/base/proposed 复用候选并汇总来源，忽略后保留文件且不复用历史', (t) => {
  const { skillsDir, stagingDir, draftsDir, service } = fixture(t);
  writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Base' });
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# Proposed' });
  const first = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, sourceRef: { runId: 'one' } });
  const second = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, sourceRef: { runId: 'two' } });
  const third = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, sourceRef: { runId: 'two' } });
  assert.equal(second.id, first.id);
  assert.equal(second.deduplicated, true);
  assert.equal(third.sourceCount, 3);
  assert.equal(third.sources.length, 2);
  assert.equal(third.sources.find((source) => source.sourceRef.runId === 'two').count, 2);
  assert.equal(third.fingerprint, first.fingerprint);
  assert.equal(service.list().length, 1);
  service.reject(first.id, '暂不采用');
  const next = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  assert.notEqual(next.id, first.id);
  assert.equal(service.list().length, 2);
  assert.equal(fs.existsSync(path.join(draftsDir, 'drafts', first.id, 'proposed', 'SKILL.md')), true);
});

test('相同内容但基线不同不去重，已在正式版本中的内容不再可发布', (t) => {
  const { root, skillsDir, stagingDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Base' });
  const baseline = freezeLibrary(skillsDir, root);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# Proposed' });
  const first = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, baseDir: baseline });
  fs.writeFileSync(path.join(live, 'metadata.json'), '{}');
  const second = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  assert.notEqual(first.id, second.id);
  service.publish(second.id);
  assert.equal(service.get(first.id).readiness, 'already_applied');
  assert.equal(service.get(first.id).canPublish, false);
  assert.equal(service.get(second.id).status, 'published');
  assert.equal(service.get(second.id).canPublish, false);
  const archived = service.rebase(first.id);
  assert.equal(archived.alreadyApplied, true);
  assert.equal(archived.draft.status, 'merged');
  assert.equal(archived.draft.merged.reason, 'already-applied');
  assert.equal(service.listHistory('relay-guide').length, 1);
});

test('readiness 不写时间，校验失败和损坏单包不会让整个列表失败', (t) => {
  const { stagingDir, draftsDir, service } = fixture(t);
  const one = service.createDraft({ skillName: 'one', stagingDir: writePackage(path.join(stagingDir, 'one')) });
  const two = service.createDraft({ skillName: 'two', stagingDir: writePackage(path.join(stagingDir, 'two')) });
  const recordFile = path.join(draftsDir, 'drafts', one.id, 'record.json');
  const before = fs.readFileSync(recordFile, 'utf8');
  assert.equal(service.get(one.id).readiness, 'ready');
  assert.equal(service.get(one.id).canPublish, true);
  service.list(); service.validate(one.id);
  assert.equal(fs.readFileSync(recordFile, 'utf8'), before);
  fs.rmSync(path.join(draftsDir, 'drafts', one.id, 'proposed'), { recursive: true });
  const listed = service.list();
  assert.equal(listed.find((item) => item.id === one.id).readiness, 'invalid');
  assert.equal(listed.find((item) => item.id === one.id).canPublish, false);
  assert.equal(listed.find((item) => item.id === two.id).canPublish, true);
});

test('schema1 老草稿保持可读，去重保留原始来源且损坏的候选不复用', (t) => {
  const { stagingDir, draftsDir, service } = fixture(t);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'));
  const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, sourceRef: { runId: 'legacy' } });
  const recordFile = path.join(draftsDir, 'drafts', draft.id, 'record.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  delete record.sources; delete record.sourceCount; delete record.fingerprint;
  fs.writeFileSync(recordFile, JSON.stringify(record));
  assert.equal(service.get(draft.id).sourceCount, 1);
  assert.equal(service.get(draft.id).schemaVersion, 1);
  const duplicate = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, sourceRef: { runId: 'new' } });
  assert.equal(duplicate.sourceCount, 2);
  assert.equal(duplicate.sources[0].sourceRef.runId, 'legacy');
  fs.appendFileSync(path.join(draftsDir, 'drafts', draft.id, 'proposed', 'SKILL.md'), '\ntampered');
  assert.equal(service.get(draft.id).readiness, 'invalid');
  const replacement = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  assert.notEqual(replacement.id, draft.id);
});

test('内容无效的相同候选也只保留一份待审记录', (t) => {
  const { stagingDir, service } = fixture(t);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: 'Read [missing](references/missing.md).' });
  const first = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  const second = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  assert.equal(second.id, first.id);
  assert.equal(second.readiness, 'invalid');
  assert.equal(second.sourceCount, 2);
});

test('重新整理保留当前元数据与草稿的独立文件修改，生成待审新包并保留旧草稿', (t) => {
  const { root, skillsDir, stagingDir, draftsDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Base', files: { 'references/remove.txt': 'obsolete', 'scripts/check.js': 'old code' } });
  const baseline = freezeLibrary(skillsDir, root);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# Improved', files: { 'scripts/check.js': 'new code' } });
  const original = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, baseDir: baseline });
  fs.mkdirSync(path.join(live, 'agents'));
  fs.writeFileSync(path.join(live, 'agents', 'relay.yaml'), 'display_name: Relay Guide');
  fs.writeFileSync(path.join(live, 'references', 'current.txt'), 'current notes');
  const currentHash = scanPackage(live).treeHash;
  const rebased = service.rebase(original.id);
  assert.equal(rebased.alreadyApplied, false);
  assert.notEqual(rebased.draft.id, original.id);
  assert.equal(rebased.draft.status, 'draft');
  assert.equal(rebased.draft.readiness, 'ready');
  assert.equal(rebased.draft.base.treeHash, currentHash);
  assert.equal(rebased.previous.status, 'superseded');
  assert.equal(rebased.previous.supersededBy, rebased.draft.id);
  assert.deepEqual(rebased.draft.rebasedFrom, [original.id]);
  assert.equal(scanPackage(live).treeHash, currentHash, 'rebase must not publish');
  const proposedRoot = path.join(draftsDir, 'drafts', rebased.draft.id, 'proposed');
  assert.equal(fs.readFileSync(path.join(proposedRoot, 'agents', 'relay.yaml'), 'utf8'), 'display_name: Relay Guide');
  assert.equal(fs.readFileSync(path.join(proposedRoot, 'references', 'current.txt'), 'utf8'), 'current notes');
  assert.equal(fs.existsSync(path.join(proposedRoot, 'references', 'remove.txt')), false);
  assert.equal(fs.readFileSync(path.join(proposedRoot, 'scripts', 'check.js'), 'utf8'), 'new code');
  assert.equal(fs.existsSync(path.join(draftsDir, 'drafts', original.id, 'base', 'SKILL.md')), true);
  const published = service.publish(rebased.draft.id);
  service.rollback('relay-guide', published.history.id);
  assert.equal(scanPackage(live).treeHash, currentHash, 'rollback restores the exact current preimage, including metadata');
});

test('双方修改同一文本先报三方冲突，再按明确文本答案生成待审候选', (t) => {
  const { root, skillsDir, stagingDir, draftsDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { files: { 'references/notes.md': 'base text' } });
  const baseline = freezeLibrary(skillsDir, root);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { files: { 'references/notes.md': 'proposed text' } });
  const original = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, baseDir: baseline });
  fs.writeFileSync(path.join(live, 'references', 'notes.md'), 'current text');
  let details;
  assert.throws(() => service.rebase(original.id), (error) => { details = error.details; return error.code === 'REBASE_CONFLICT'; });
  assert.deepEqual(details.conflicts, [{
    path: 'references/notes.md', binary: false, structural: false,
    base: 'base text', current: 'current text', proposed: 'proposed text',
    versions: { base: { exists: true, kind: 'file', size: 9 }, current: { exists: true, kind: 'file', size: 12 }, proposed: { exists: true, kind: 'file', size: 13 } },
  }]);
  assert.equal(details.currentTreeHash, scanPackage(live).treeHash);
  assert.equal(service.list().length, 1);
  assert.equal(service.get(original.id).status, 'draft');
  assert.throws(() => service.rebase(original.id, { resolutions: {} }), (error) => error.code === 'REBASE_EXPECTATION_REQUIRED');
  fs.writeFileSync(path.join(live, 'references', 'notes.md'), 'new current text');
  assert.throws(() => service.rebase(original.id, { expectedCurrentTreeHash: details.currentTreeHash, resolutions: { 'references/notes.md': { text: 'combined' } } }), (error) => error.code === 'REBASE_STALE');
  const result = service.rebase(original.id, { expectedCurrentTreeHash: scanPackage(live).treeHash, resolutions: { 'references/notes.md': { text: 'reviewed combined text' } } });
  assert.equal(result.draft.canPublish, true);
  assert.equal(fs.readFileSync(path.join(draftsDir, 'drafts', result.draft.id, 'proposed', 'references', 'notes.md'), 'utf8'), 'reviewed combined text');
  assert.equal(fs.readFileSync(path.join(live, 'references', 'notes.md'), 'utf8'), 'new current text');
});

test('删除与修改及二进制冲突必须明确选择，未知路径和文本覆盖二进制被拒绝', (t) => {
  const { root, skillsDir, stagingDir, draftsDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { files: { 'assets/icon.bin': Buffer.from([0, 1, 2]) } });
  const baseline = freezeLibrary(skillsDir, root);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'));
  const original = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, baseDir: baseline });
  fs.writeFileSync(path.join(live, 'assets', 'icon.bin'), Buffer.from([0, 3, 4]));
  let details;
  assert.throws(() => service.rebase(original.id), (error) => { details = error.details; return error.code === 'REBASE_CONFLICT'; });
  assert.equal(details.conflicts[0].binary, true);
  assert.deepEqual(details.conflicts[0].versions, {
    base: { exists: true, kind: 'file', size: 3 },
    current: { exists: true, kind: 'file', size: 3 },
    proposed: { exists: false, kind: null },
  });
  assert.equal(details.conflicts[0].current, null, 'binary payload is omitted without implying a missing file');
  const expectedCurrentTreeHash = details.currentTreeHash;
  const conflictPath = details.conflicts[0].path;
  assert.throws(() => service.rebase(original.id, { expectedCurrentTreeHash, resolutions: { [conflictPath]: { text: 'unsafe replacement' } } }), (error) => error.code === 'INVALID_RESOLUTION');
  assert.throws(() => service.rebase(original.id, { expectedCurrentTreeHash, resolutions: { '../escape': { choice: 'proposed' } } }), (error) => error.code === 'INVALID_RESOLUTION');
  const archived = service.rebase(original.id, { expectedCurrentTreeHash, resolutions: { [conflictPath]: { choice: 'current' } } });
  assert.equal(archived.alreadyApplied, true);
  assert.equal(archived.draft.status, 'merged');
  assert.equal(fs.existsSync(path.join(draftsDir, 'drafts', original.id, 'proposed', 'SKILL.md')), true);
  assert.deepEqual(fs.readFileSync(path.join(live, 'assets', 'icon.bin')), Buffer.from([0, 3, 4]));
});

test('文件与文件夹冲突按整条分支处理，不混出不可发布的树', (t) => {
  const { root, skillsDir, stagingDir, draftsDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { files: { 'assets/item': 'base file' } });
  const baseline = freezeLibrary(skillsDir, root);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { files: { 'assets/item/child.txt': 'new subtree' } });
  const original = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, baseDir: baseline });
  fs.writeFileSync(path.join(live, 'assets', 'item'), 'current file');
  let details;
  assert.throws(() => service.rebase(original.id), (error) => { details = error.details; return error.code === 'REBASE_CONFLICT'; });
  assert.equal(details.conflicts[0].path, 'assets/item');
  assert.equal(details.conflicts[0].structural, true);
  assert.deepEqual(details.conflicts[0].versions.proposed, { exists: true, kind: 'directory' });
  const result = service.rebase(original.id, { expectedCurrentTreeHash: details.currentTreeHash, resolutions: { 'assets/item': { choice: 'proposed' } } });
  assert.equal(result.draft.canPublish, true);
  assert.equal(fs.readFileSync(path.join(draftsDir, 'drafts', result.draft.id, 'proposed', 'assets', 'item', 'child.txt'), 'utf8'), 'new subtree');
  const diff = service.diff(result.draft.id);
  assert.ok(diff.files.some((file) => file.path === 'assets/item' && file.deletions === 1));
  assert.ok(diff.files.some((file) => file.path === 'assets/item/child.txt' && file.additions === 1));
});

test('冻结草稿基线被篡改后校验和重新整理均拒绝使用', (t) => {
  const { skillsDir, stagingDir, draftsDir, service } = fixture(t);
  writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Base' });
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# Proposed' });
  const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  fs.appendFileSync(path.join(draftsDir, 'drafts', draft.id, 'base', 'SKILL.md'), '\ntampered');
  assert.equal(service.get(draft.id).readiness, 'invalid');
  assert.throws(() => service.rebase(draft.id), (error) => error.code === 'DRAFT_INVALID');
  assert.throws(() => service.publish(draft.id), (error) => error.code === 'DRAFT_INVALID');
});

test('显式快照根必须存在，不能把无效快照路径当作新建技能基线', (t) => {
  const { root, stagingDir, service } = fixture(t);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'));
  assert.throws(() => service.createDraft({ skillName: 'relay-guide', stagingDir: staging, baseDir: path.join(root, 'missing-baseline') }), (error) => error.code === 'BASE_REQUIRED');
  assert.equal(service.list().length, 0);
});

test('重新整理期间正式包再次变化会拒绝完成，不覆盖当前内容也不归档原候选', (t) => {
  const { root, skillsDir, stagingDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Base' });
  const baseline = freezeLibrary(skillsDir, root);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# Proposed' });
  const original = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, baseDir: baseline });
  fs.writeFileSync(path.join(live, 'metadata.json'), '{}');
  const create = service.createDraft.bind(service);
  service.createDraft = (...args) => {
    const result = create(...args);
    fs.writeFileSync(path.join(live, 'metadata.json'), '{"racing":true}');
    return result;
  };
  assert.throws(() => service.rebase(original.id), (error) => error.code === 'REBASE_STALE');
  assert.equal(service.get(original.id).status, 'draft');
  assert.equal(fs.readFileSync(path.join(live, 'metadata.json'), 'utf8'), '{"racing":true}');
  assert.equal(service.listHistory('relay-guide').length, 0);
});

test('两方新文件在 Windows 大小写冲突时拒绝合并，保留原状态', (t) => {
  const { root, skillsDir, stagingDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'));
  const baseline = freezeLibrary(skillsDir, root);
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { files: { 'assets/icon.txt': 'proposed' } });
  const original = service.createDraft({ skillName: 'relay-guide', stagingDir: staging, baseDir: baseline });
  fs.mkdirSync(path.join(live, 'assets'));
  fs.writeFileSync(path.join(live, 'assets', 'Icon.txt'), 'current');
  assert.throws(() => service.rebase(original.id), (error) => error.code === 'CASE_COLLISION');
  assert.equal(service.get(original.id).status, 'draft');
  assert.equal(service.list().length, 1);
});

test('多份同技能候选每次列表只扫描一次 live，下次请求仍检查最新内容', (t) => {
  const { skillsDir, stagingDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Base' });
  for (let i = 0; i < 4; i += 1) {
    const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: `# Proposal ${i}` });
    const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
    if (i < 3) service.reject(draft.id);
  }
  const liveFile = path.join(live, 'SKILL.md');
  const originalRead = fs.readFileSync;
  let liveReads = 0;
  fs.readFileSync = function(file, ...args) {
    if (String(file) === liveFile) liveReads += 1;
    return originalRead.call(this, file, ...args);
  };
  try {
    const first = service.list();
    assert.equal(first.length, 4);
    assert.equal(liveReads, 1);
    assert.equal(first.find((draft) => draft.status === 'draft').canPublish, true);
    fs.appendFileSync(liveFile, '\nchanged between listings');
    const second = service.list();
    assert.equal(liveReads, 2);
    assert.equal(second.find((draft) => draft.status === 'draft').readiness, 'stale');
    assert.equal(second.find((draft) => draft.status === 'draft').canPublish, false);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('重新整理只使用安全扫描的真实路径，不采信旧记录中伪造的清单路径', (t) => {
  const { skillsDir, stagingDir, draftsDir, service } = fixture(t);
  const live = writePackage(path.join(skillsDir, 'relay-guide'), { body: '# Base' });
  const staging = writePackage(path.join(stagingDir, 'relay-guide'), { body: '# Proposed' });
  const draft = service.createDraft({ skillName: 'relay-guide', stagingDir: staging });
  const recordFile = path.join(draftsDir, 'drafts', draft.id, 'record.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  // Keep each real tree hash but forge the untrusted JSON lists independently.
  for (const [index, manifest] of [record.base, record.proposed].entries()) {
    manifest.directories.push({ path: '..', mode: 0o755 });
    manifest.files.push({ path: '../private.txt', mode: 0o644, size: 10, sha256: String(index).repeat(64) });
  }
  record.changes = { added: ['../private.txt'], modified: [], removed: [], modeChanged: [] };
  fs.writeFileSync(recordFile, JSON.stringify(record));
  assert.equal(service.diff(draft.id).files.some((file) => file.path.includes('private')), false);
  fs.writeFileSync(path.join(live, 'metadata.json'), '{}');
  const result = service.rebase(draft.id);
  assert.equal(result.draft.canPublish, true);
  assert.equal(result.draft.proposed.files.some((file) => file.path.includes('private')), false);
  assert.equal(result.draft.proposed.directories.some((directory) => directory.path === '..'), false);
  assert.equal(fs.readFileSync(path.join(live, 'metadata.json'), 'utf8'), '{}');
});
