'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { readEvidence, appendEvidence, saveScreenshot } = require('../src/main/browser/browser-evidence-store');
async function workspace(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-evidence-')); t.after(() => fs.rm(root, {recursive:true,force:true})); return root; }
test('concurrent evidence writes survive a fresh reader and stay scoped to their conversation', async t => {
  const workspaceRoot = await workspace(t), a = { workspaceRoot, conversationId:'a' }, b = { workspaceRoot, conversationId:'b' };
  await Promise.all(Array.from({length:10}, (_,i) => appendEvidence(a, {id:String(i),kind:'download'})));
  assert.equal((await readEvidence(a)).length, 10); assert.deepEqual(await readEvidence(b), []);
  const capture = await saveScreenshot(b, {data:Buffer.from('fixture PNG bytes').toString('base64'),url:'https://example.test'});
  assert.equal((await fs.readFile(capture.path)).length, capture.bytes); assert.equal(capture.sha256.length,64);
  assert.equal((await readEvidence(b))[0].path,capture.path);
});
test('evidence refuses symlink escapes before creating files outside workspace', async t => {
  const root = await workspace(t), outside = await workspace(t);
  try { await fs.symlink(outside,path.join(root,'.relay'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if(e.code==='EPERM') return t.skip('Host lacks symlink permission'); throw e; }
  await assert.rejects(saveScreenshot({workspaceRoot:root,conversationId:'a'}, {data:'cG5n'}));
  assert.deepEqual(await fs.readdir(outside), []);
});
test('a saved screenshot keeps its usable artifact path if only indexing fails', async t => {
  const workspaceRoot=await workspace(t), context={workspaceRoot,conversationId:'index-failure'};
  await appendEvidence(context,{id:'before'});
  const folder=path.join(workspaceRoot,'.relay','browser-evidence');
  const manifest=(await fs.readdir(folder)).find(x=>x.endsWith('.json'));
  await fs.unlink(path.join(folder,manifest));await fs.mkdir(path.join(folder,manifest));
  const artifact=await saveScreenshot(context,{data:Buffer.from('fixture').toString('base64')});
  assert.ok(artifact.evidenceWarning);assert.equal((await fs.readFile(artifact.path)).toString(),'fixture');
});
