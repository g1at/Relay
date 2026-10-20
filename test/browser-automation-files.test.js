'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { resolveUploadFiles, resolveDownloadDirectory, MAX_UPLOAD_BYTES } = require('../src/main/browser/browser-automation-files');
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-browser-files-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'task'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'report.csv'), 'name,value\nfixture,42\n');
  await fs.writeFile(path.join(base, 'outside.txt'), 'not authorized');
  return { base, root, context: { workspaceRoot: root } };
}
test('upload paths resolve from the trusted workspace and never from model-provided roots', async t => {
  const f = await fixture(t), file = path.join(f.root, 'report.csv');
  assert.deepEqual((await resolveUploadFiles(f.context, ['report.csv'])).files, [file]);
  assert.deepEqual((await resolveUploadFiles(f.context, [file])).files, [file]);
  await assert.rejects(resolveUploadFiles({}, [file]), { code: 'BROWSER_WORKSPACE_REQUIRED' });
  for (const outside of ['../outside.txt', path.join(f.base, 'outside.txt'), '.']) {
    await assert.rejects(resolveUploadFiles(f.context, [outside]), { code: 'BROWSER_UPLOAD_OUTSIDE_WORKSPACE' });
  }
});
test('upload rejects directories, duplicates, missing files and aggregate size overflow', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'folder'));
  for (const requested of [[], ['folder'], ['report.csv', './report.csv'], new Array(17).fill('report.csv')]) {
    await assert.rejects(resolveUploadFiles(f.context, requested), { code: 'BROWSER_UPLOAD_FILES_INVALID' });
  }
  await assert.rejects(resolveUploadFiles(f.context, ['missing']), { code: 'BROWSER_UPLOAD_FILE_UNAVAILABLE' });
  const large = await fs.open(path.join(f.root, 'large.bin'), 'w');
  await large.truncate(MAX_UPLOAD_BYTES); await large.close();
  await assert.rejects(resolveUploadFiles(f.context, ['large.bin', 'report.csv']), { code: 'BROWSER_UPLOAD_TOO_LARGE' });
});
test('resolved directory links cannot escape upload or download roots', async t => {
  const f = await fixture(t);
  try { await fs.symlink(f.base, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('host disallows creating test links'); return; } throw error; }
  await assert.rejects(resolveUploadFiles(f.context, ['linked/outside.txt']), { code: 'BROWSER_UPLOAD_OUTSIDE_WORKSPACE' });
  await fs.symlink(f.base, path.join(f.root, 'browser-downloads'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveDownloadDirectory(f.context), { code: 'BROWSER_DOWNLOAD_OUTSIDE_WORKSPACE' });
});
test('downloads are allocated below the task root and existing files are preserved', async t => {
  const f = await fixture(t), directory = await resolveDownloadDirectory(f.context);
  assert.equal(directory, path.join(f.root, 'browser-downloads'));
  await fs.writeFile(path.join(directory, 'previous.csv'), 'keep');
  assert.equal(await resolveDownloadDirectory(f.context), directory);
  assert.equal(await fs.readFile(path.join(directory, 'previous.csv'), 'utf8'), 'keep');
});
