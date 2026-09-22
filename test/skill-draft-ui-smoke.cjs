'use strict';
// Real renderer + real draft service; only synthetic packages in a private temp directory.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { SkillDraftService } = require('../src/main/skills/skill-draft-service');
const { SkillDraftClient } = require('../src/main/skills/skill-draft-client');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/skill-draft-ui-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-draft-ui-'));
const service = new SkillDraftService({ skillsDir: path.join(fixtureRoot, 'skills'), draftsDir: path.join(fixtureRoot, 'records') });
const client = new SkillDraftClient({ skillsDir: service.skillsDir, draftsDir: service.draftsDir });
const checks = {}, failures = [], calls = [], ids = {};
let win, step = 'starting';
let holdMutation = null, releaseMutation = null;
let holdList = false, releaseList = null;
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, step, calls }, null, 2));
const deadline = setTimeout(() => { failures.push(`Timeout: ${step}`); save(); app.exit(1); }, 180000);
const content = (name, text) => `---\nname: ${name}\ndescription: Synthetic local UI fixture.\n---\n${text}\n`;
const liveDir = name => path.join(service.skillsDir, name);
function writePackage(directory, name, text, files = {}) {
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'SKILL.md'), content(name, text));
  for (const [file, value] of Object.entries(files)) { const dest = path.join(directory, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, value); }
  return directory;
}
function candidate(name, text, files = {}, source = {}) {
  const staging = path.join(fixtureRoot, `staging-${name}-${Object.keys(ids).length}-${Date.now()}`);
  writePackage(staging, name, text, files);
  return service.createDraft({ skillName: name, stagingDir: staging, sourceRef: { type: 'manual', ...source } });
}
function prepare() {
  writePackage(liveDir('grouped-skill'), 'grouped-skill', '# Original');
  const first = candidate('grouped-skill', '# Candidate A'); ids.grouped = first.id;
  service.createDraft({ skillName: 'grouped-skill', stagingDir: path.join(service.draftRecordsDir, first.id, 'proposed'), sourceRef: { type: 'conversation-review', triggerReason: 'Synthetic correction' } });
  ids.alternative = candidate('grouped-skill', '# Candidate B').id;
  // A persisted legacy duplicate predates service-level candidate deduplication.
  const duplicate = 'draft-legacy-copy'; fs.cpSync(path.join(service.draftRecordsDir, first.id), path.join(service.draftRecordsDir, duplicate), { recursive: true });
  const recordFile = path.join(service.draftRecordsDir, duplicate, 'record.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8')); record.id = duplicate; record.createdAt = record.updatedAt = '2026-01-01T00:00:00Z'; record.sourceCount = 2;
  fs.writeFileSync(recordFile, JSON.stringify(record)); ids.duplicate = duplicate;
  writePackage(liveDir('clean-skill'), 'clean-skill', '# Original', { 'references/note.md': 'original note' });
  ids.clean = candidate('clean-skill', '# New instructions', { 'references/note.md': 'original note' }).id;
  fs.writeFileSync(path.join(liveDir('clean-skill'), 'references/note.md'), 'new independent note');
  const originals = { 'references/keep.md': 'base keep', 'references/take.md': 'base take', 'references/switch': 'base file', 'references/removed.md': 'base removed', 'assets/icon.bin': Buffer.from([0, 1, 2]) };
  writePackage(liveDir('conflict-skill'), 'conflict-skill', '# Base', originals);
  ids.conflict = candidate('conflict-skill', '# Proposed\n<script>window.__draftUiXss=1</script>', { 'references/keep.md': 'proposed keep', 'references/take.md': 'proposed take', 'references/switch/note.md': 'proposed directory', 'assets/icon.bin': Buffer.from([0, 3, 4]) }).id;
  writePackage(liveDir('conflict-skill'), 'conflict-skill', '# Current', { 'references/keep.md': 'current keep', 'references/take.md': 'current take', 'references/switch': 'current file', 'references/removed.md': 'current removed', 'assets/icon.bin': Buffer.from([0, 5, 6]) });
  writePackage(liveDir('invalid-skill'), 'invalid-skill', '# Valid');
  const invalid = path.join(fixtureRoot, 'invalid'); fs.mkdirSync(invalid); fs.writeFileSync(path.join(invalid, 'SKILL.md'), '# Missing frontmatter');
  ids.invalid = service.createDraft({ skillName: 'invalid-skill', stagingDir: invalid }).id;
  writePackage(liveDir('published-skill'), 'published-skill', '# Original');
  ids.published = candidate('published-skill', '# Published').id;
  service.createDraft({ skillName: 'published-skill', stagingDir: path.join(service.draftRecordsDir, ids.published, 'proposed'), sourceRef: { type: 'conversation-review', triggerReason: 'Synthetic archive source' } });
  service.publish(ids.published);
  writePackage(liveDir('applied-skill'), 'applied-skill', '# Original');
  ids.applied = candidate('applied-skill', '# Already included').id;
  writePackage(liveDir('applied-skill'), 'applied-skill', '# Already included');
}
prepare();
const emitDraft = (type, fields = {}) => win.webContents.send('skill-draft-ui-event', { channel: 'draft', event: { type, ...fields } });
const emitUsage = () => win.webContents.send('skill-draft-ui-event', { channel: 'usage', event: { reason: 'draft-published' } });
ipcMain.handle('skill-draft-ui-fixture', async (_event, method, args) => {
  calls.push({ method, args });
  try {
    if (method === 'list') {
      const items = await client.list(args[0]);
      if (holdList) await new Promise(resolve => { releaseList = () => { releaseList = null; holdList = false; resolve(); }; });
      return { ok: true, items };
    }
    if (method === 'diff') return { ok: true, diff: await client.diff(args[0]) };
    if (method === 'validate') return { ok: true, validation: await client.validate(args[0]) };
    if (method === 'publish' || method === 'reject') {
      const value = method === 'publish' ? await client.publish(args[0]) : await client.reject(...args);
      // Match main: usage and draft events precede the mutation IPC response.
      if (method === 'publish') emitUsage();
      emitDraft(method === 'publish' ? 'skillDraft.published' : 'skillDraft.rejected', { draftId: args[0] });
      if (holdMutation === method) await new Promise(resolve => { releaseMutation = () => { releaseMutation = null; holdMutation = null; resolve(); }; });
      return { ok: true, [method === 'publish' ? 'result' : 'draft']: value };
    }
    if (method === 'history') return { ok: true, items: await client.listHistory(args[0]) };
    if (method === 'rollback' || method === 'rebase') {
      const result = await client[method === 'rebase' ? 'rebaseDraft' : method](...args);
      if (method === 'rollback') emitUsage();
      emitDraft(method === 'rollback' ? 'skillDraft.rolledBack' : 'skillDraft.rebased');
      return { ok: true, result };
    }
    throw Error('Unexpected fixture operation');
  } catch (error) { return { ok: false, code: error.code, error: error.message, details: error.details }; }
});
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function next(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify('Timeout: ' + code)}));setTimeout(next,25);}next();})`); }
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function waitForMutation(isReady = () => !!releaseMutation) {
  const deadline = Date.now() + 7000;
  while (!isReady()) { if (Date.now() > deadline) throw Error('Fixture response was not held'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function eventTurn() { await evaluate('new Promise(resolve=>setTimeout(resolve,120))'); await settle(); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); if (!checks[name]) throw Error(name); }
function localCheck(name, value) { step = name; checks[name] = !!value; save(); if (!value) throw Error(name); }
async function click(selector) { await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});e.click();})()`); await settle(); }
async function screenshot(name) { await settle(); fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG()); }
const row = id => `[data-draft-id="${id}"]`;
const conflict = (file, choice) => `[data-conflict-path="${file}"] [data-resolution="${choice}"]`;
const mergedText = content('conflict-skill', '# Manually combined instructions');
async function chooseConflicts() {
  await click(conflict('SKILL.md', 'edit'));
  await act(`const e=document.querySelector('[data-conflict-path="SKILL.md"] textarea');e.value=${JSON.stringify(mergedText)};e.dispatchEvent(new Event('input',{bubbles:true}));`);
  await click(conflict('references/keep.md', 'current'));
  await click(conflict('references/take.md', 'proposed'));
  await click(conflict('assets/icon.bin', 'current'));
  await click(conflict('references/switch', 'current'));
  await click(conflict('references/removed.md', 'current'));
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const preload = path.join(output, 'fixture-preload.cjs');
  fs.writeFileSync(preload, "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('draftFixtureBridge',{call:(method,args)=>ipcRenderer.invoke('skill-draft-ui-fixture',method,args),onEvent:(channel,callback)=>{const handler=(_event,payload)=>{if(payload.channel===channel)callback(payload.event);};ipcRenderer.on('skill-draft-ui-event',handler);return()=>ipcRenderer.removeListener('skill-draft-ui-event',handler);}});");
  const bridgeFixture = `(()=>{const base=window.api;window.draftUiFixture={ids:${JSON.stringify(ids)},heartbeats:0};setInterval(()=>draftUiFixture.heartbeats++,16);const drafts={onEvent:callback=>draftFixtureBridge.onEvent('draft',callback)};for(const method of ['list','diff','validate','publish','rebase','reject','history','rollback'])drafts[method]=(...args)=>draftFixtureBridge.call(method,args);const skills=new Proxy(base.skills,{get(target,key){return key==='onUsageUpdated'?callback=>draftFixtureBridge.onEvent('usage',callback):target[key];}});window.api=new Proxy(base,{get(target,key){return key==='skillDrafts'?drafts:key==='skills'?skills:target[key];}});})();`;
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js', 'plugins-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n') + bridgeFixture;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}\nlocalStorage.clear();</script>`);
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1320, height: 920, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive();
  await waitFor('!!window.relayPluginsPage&&providerRoutingLoaded&&!restoringActiveRuns');
  await act("inputEl.value='技能更新期间保留的对话草稿';relayPluginsPage.open('skill');");
  await waitFor("document.querySelectorAll('[data-skill-group]').length===4&&!pluginsRefresh.disabled");
  await click('[data-skill-view=updates]');
  await check('onePendingGroupPerSkillAndAppliedRecordsAreExcluded', "document.querySelector('[data-draft-count]').textContent==='4 个技能 · 5 份候选'&&!document.querySelector('[data-skill-group="+'"applied-skill"'+"]')&&!document.querySelector('[data-draft-processed]').open");
  await check('readyStaleAndInvalidCandidatesHaveDistinctStates', `document.querySelector(${JSON.stringify(row(ids.clean))}).dataset.readiness==='stale'&&document.querySelector(${JSON.stringify(row(ids.invalid))}).dataset.readiness==='invalid'&&document.querySelector(${JSON.stringify(row(ids.grouped))}).dataset.readiness==='ready'`);
  await check('staleAndInvalidCannotPublishAndStaleOffersRebase', `document.querySelector(${JSON.stringify(row(ids.clean) + ' [data-action=publish]')}).disabled&&document.querySelector(${JSON.stringify(row(ids.invalid) + ' [data-action=publish]')}).disabled&&!document.querySelector(${JSON.stringify(row(ids.clean) + ' [data-action=rebase]')}).hidden`);
  await act("document.querySelector('[data-skill-group="+'"grouped-skill"'+"] .skill-update-alternatives').open=true;");
  await click(row(ids.grouped) + ' .skill-update-sources > summary');
  await check('duplicateContentsKeepOriginalRecordsAndMultipleSourcesAccessible', `document.querySelector('[data-skill-group="grouped-skill"]').querySelector('.skill-update-group-head span').textContent==='2 份候选'&&!!document.querySelector(${JSON.stringify(row(ids.duplicate))})?.getClientRects().length&&document.querySelector(${JSON.stringify(row(ids.grouped) + ' .skill-update-sources')}).textContent.includes('Synthetic correction')`);
  await click(row(ids.duplicate) + ' .skill-update-sources > summary');
  await check('legacyDuplicateRetainsItsOwnExpandableSources', `document.querySelector(${JSON.stringify(row(ids.duplicate) + ' .skill-update-sources')}).open&&document.querySelector(${JSON.stringify(row(ids.duplicate) + ' .skill-update-sources')}).textContent.includes('Synthetic correction')`);
  await check('staleActionsStayCompactWithFullRebaseDescription', `(()=>{const row=document.querySelector(${JSON.stringify(row(ids.clean))}),actions=row.querySelector('.dp-item-actions'),button=row.querySelector('[data-action=rebase]');return button.textContent==='重新整理'&&button.title==='基于当前版本重新整理'&&actions.getBoundingClientRect().height<=66&&button.getBoundingClientRect().width<110;})()`);
  await screenshot('updates-grouped-light');
  await click(row(ids.clean) + ' [data-action=rebase]');
  await waitFor(`!document.querySelector('[data-draft-list] ${row(ids.clean)}')`);
  const cleanNext = service.list({ skillName: 'clean-skill', status: 'draft' })[0];
  localCheck('cleanRebaseCreatesReviewableCandidateWithoutPublishing', cleanNext?.readiness === 'ready' && service.get(ids.clean).status === 'superseded' && fs.readFileSync(path.join(liveDir('clean-skill'), 'SKILL.md'), 'utf8').includes('# Original') && !calls.some(call => call.method === 'publish'));
  await click(row(ids.conflict) + ' [data-action=rebase]');
  await waitFor("document.querySelectorAll('[data-conflict-path]').length===6");
  await check('conflictDialogShowsThreeVersionsAsTextAndRequiresChoices', "document.querySelectorAll('.skill-rebase-versions').length===6&&document.querySelector('[data-rebase-save]').disabled&&!document.querySelector('.skill-rebase-body script')&&window.__draftUiXss===undefined&&document.querySelector('.skill-rebase-body').textContent.includes('<script>window.__draftUiXss=1</script>')");
  await check('binaryConflictsOnlyOfferSideChoices', "!document.querySelector('[data-conflict-path="+'"assets/icon.bin"'+"] [data-resolution=edit]')&&document.querySelectorAll('[data-conflict-path="+'"assets/icon.bin"'+"] [data-resolution]').length===2");
  await check('binaryDirectoryMissingAndTextVersionsHaveDistinctPreviews', `(()=>{const preview=(file,version)=>document.querySelector('[data-conflict-path="'+file+'"] [data-version="'+version+'"]').textContent;return ['base','current','proposed'].every(version=>preview('assets/icon.bin',version).includes('二进制文件')&&!preview('assets/icon.bin',version).includes('不存在'))&&preview('references/switch','proposed').includes('文件夹')&&preview('references/switch','current')==='current file'&&preview('references/removed.md','proposed')==='此版本中不存在'&&preview('references/removed.md','current')==='current removed';})()`);
  await check('shortVersionPreviewsFitTheirContentsAtEqualHeight', `(()=>{const heights=[...document.querySelectorAll('[data-conflict-path="references/keep.md"] pre')].map(node=>node.getBoundingClientRect().height);return heights.length===3&&Math.max(...heights)<=80&&Math.max(...heights)-Math.min(...heights)<1;})()`);
  await act(`const preview=document.querySelector('[data-conflict-path="references/keep.md"] [data-version="proposed"]');window.draftUiFixture.originalPreview=preview.textContent;preview.textContent=Array.from({length:40},(_,i)=>'Preview line '+i).join('\\n');`);
  await settle();
  await check('longVersionPreviewScrollsWithinAnEqualHeightComparison', `(()=>{const nodes=[...document.querySelectorAll('[data-conflict-path="references/keep.md"] pre')],heights=nodes.map(node=>node.getBoundingClientRect().height),long=nodes[2];return Math.max(...heights)<=240&&Math.max(...heights)-Math.min(...heights)<1&&long.scrollHeight>long.clientHeight;})()`);
  await act(`document.querySelector('[data-conflict-path="references/keep.md"] [data-version="proposed"]').textContent=window.draftUiFixture.originalPreview;`);
  await chooseConflicts();
  await check('allConflictChoicesEnableOneExplicitCandidateSubmission', "!document.querySelector('[data-rebase-save]').disabled&&document.querySelectorAll('[data-resolution][aria-pressed=true]').length===6");
  fs.appendFileSync(path.join(liveDir('conflict-skill'), 'SKILL.md'), '\nLater concurrent edit\n');
  await click('[data-rebase-save]'); await waitFor("!document.querySelector('[data-rebase-reload]').hidden&&document.querySelector('[data-rebase-save]').disabled");
  await check('concurrentEditBlocksStaleResolutionsAndPreservesManualText', `!!document.querySelector('.skill-rebase-overlay')&&document.querySelector('[data-conflict-path="SKILL.md"] textarea').value===${JSON.stringify(mergedText)}&&document.querySelector('[data-rebase-status]').textContent.includes('当前技能又有变化')`);
  const oldHash = calls.filter(call => call.method === 'rebase' && call.args[1]?.resolutions).at(-1).args[1].expectedCurrentTreeHash;
  await click('[data-rebase-reload]'); await waitFor("document.querySelectorAll('[data-resolution][aria-pressed=true]').length===0&&!document.querySelector('.skill-rebase-overlay[aria-busy=true]')");
  await check('freshComparisonRequiresReconfirmationAndRetainsEditedText', `document.querySelector('[data-rebase-save]').disabled&&document.querySelector('[data-conflict-path="SKILL.md"] textarea').value===${JSON.stringify(mergedText)}&&document.querySelector('.skill-rebase-body').textContent.includes('Later concurrent edit')`);
  await chooseConflicts(); await screenshot('updates-conflict-comparison'); await click('[data-rebase-save]');
  await waitFor("!document.querySelector('.skill-rebase-overlay')");
  const next = service.list({ skillName: 'conflict-skill', status: 'draft' })[0];
  const proposed = path.join(service.draftRecordsDir, next.id, 'proposed');
  localCheck('reorganizedDraftCombinesUserChoicesAndRetainsLiveUntilPublish', next.readiness === 'ready' && fs.readFileSync(path.join(proposed, 'SKILL.md'), 'utf8') === mergedText && fs.readFileSync(path.join(proposed, 'references/keep.md'), 'utf8') === 'current keep' && fs.readFileSync(path.join(proposed, 'references/take.md'), 'utf8') === 'proposed take' && fs.readFileSync(path.join(liveDir('conflict-skill'), 'SKILL.md'), 'utf8').includes('Later concurrent edit'));
  localCheck('resolutionSubmissionUsesTheLatestReviewedTreeHash', calls.filter(call => call.method === 'rebase' && call.args[1]?.resolutions).at(-1).args[1].expectedCurrentTreeHash !== oldHash);
  await waitFor(`!!document.querySelector('[data-draft-list] ${row(next.id)}')`);
  await click(row(next.id) + ' [data-action=publish]'); await waitFor("!!document.querySelector('.confirm-overlay')");
  localCheck('generatedCandidateStillRequiresPublishConfirmation', !calls.some(call => call.method === 'publish'));
  await act(`draftUiFixture.busyRow=document.querySelector(${JSON.stringify(row(next.id))});draftUiFixture.heartbeatBefore=draftUiFixture.heartbeats;`);
  const publishLists = calls.filter(call => call.method === 'list').length;
  const publishOverviews = await evaluate('pluginsFixture.overviewCount');
  holdMutation = 'publish';
  await click('.confirm-btn.primary'); await waitForMutation(); await eventTurn();
  await check('publishEventsKeepTheOriginalBusyRowWhileItsResponseIsPending', `draftUiFixture.busyRow===document.querySelector(${JSON.stringify(row(next.id))})&&draftUiFixture.busyRow.dataset.busy==='1'&&draftUiFixture.busyRow.querySelector('[data-action=publish]').disabled`);
  localCheck('publishEventsDoNotStartRedundantDraftReadsMidOperation', calls.filter(call => call.method === 'list').length === publishLists);
  await click('[data-skill-view=library]'); await click('[data-skill-view=updates]');
  await check('pendingPublishKeepsPluginNavigationAndRendererTimersResponsive', "document.querySelector('[data-skill-view=updates]').getAttribute('aria-selected')==='true'&&draftUiFixture.heartbeats>draftUiFixture.heartbeatBefore+2");
  holdList = true; releaseMutation(); await waitForMutation(() => !!releaseList); await eventTurn();
  await check('completedPublishRemainsDisabledUntilItsReplacementListArrives', `draftUiFixture.busyRow===document.querySelector(${JSON.stringify(row(next.id))})&&draftUiFixture.busyRow.dataset.busy==='1'&&draftUiFixture.busyRow.querySelector('[data-action=publish]').disabled`);
  releaseList(); await waitFor(`!document.querySelector('[data-draft-list] ${row(next.id)}')`); await eventTurn();
  localCheck('publishEventAndActionPerformExactlyOneDraftReload', calls.filter(call => call.method === 'list').length - publishLists === 1);
  localCheck('publishUsageEventDraftEventAndActionPerformExactlyOneOverviewReload', await evaluate('pluginsFixture.overviewCount') - publishOverviews === 1);
  localCheck('confirmedPublishWritesMergedContentAndKeepsRollbackVersion', fs.readFileSync(path.join(liveDir('conflict-skill'), 'SKILL.md'), 'utf8') === mergedText && service.listHistory('conflict-skill').length === 1);
  await click('[data-draft-processed] > summary');
  await click(row(ids.published) + ' .skill-update-sources > summary');
  await check('processedRecordsRetainExpandableSourceHistory', `document.querySelector(${JSON.stringify(row(ids.published) + ' .skill-update-sources')}).open&&document.querySelector(${JSON.stringify(row(ids.published) + ' .skill-update-sources')}).textContent.includes('Synthetic archive source')`);
  await click(row(next.id) + ' [data-action=history]');
  await waitFor("!!document.querySelector('[data-rollback]')"); await click('[data-rollback]'); await waitFor("!!document.querySelector('.confirm-overlay')"); await click('.confirm-btn.primary'); await waitFor("!document.querySelector('.preview-overlay')");
  localCheck('archivedCandidateStillProvidesWorkingRollback', fs.readFileSync(path.join(liveDir('conflict-skill'), 'SKILL.md'), 'utf8').includes('Later concurrent edit'));
  await click(row(ids.invalid) + ' .dp-more'); await click(row(ids.invalid) + ' [data-action=reject]'); await waitFor("!!document.querySelector('.confirm-overlay')");
  const rejectsBeforeCancel = calls.filter(call => call.method === 'reject').length;
  emitDraft('skillDraft.updated'); await eventTurn();
  await click('.confirm-btn.cancel'); await waitFor(`!document.querySelector('.confirm-overlay')&&document.querySelector(${JSON.stringify(row(ids.invalid))}).dataset.busy!=='1'`); await eventTurn();
  localCheck('cancelRejectMakesNoMutationAndReleasesDeferredRefresh', calls.filter(call => call.method === 'reject').length === rejectsBeforeCancel && service.get(ids.invalid).status === 'draft');
  await check('canceledRejectLeavesTheCandidateActionsUsable', `!document.querySelector(${JSON.stringify(row(ids.invalid) + ' [data-action=reject]')}).disabled`);
  await click(row(ids.invalid) + ' .dp-more'); await click(row(ids.invalid) + ' [data-action=reject]'); await waitFor("!!document.querySelector('.confirm-overlay')");
  await act(`draftUiFixture.busyRow=document.querySelector(${JSON.stringify(row(ids.invalid))});`);
  const rejectLists = calls.filter(call => call.method === 'list').length;
  emitDraft('skillDraft.updated'); await eventTurn();
  await check('rejectLocksTheRowBeforeConfirmationAndIgnoresRefreshUntilTheDecision', `draftUiFixture.busyRow===document.querySelector(${JSON.stringify(row(ids.invalid))})&&draftUiFixture.busyRow.dataset.busy==='1'&&draftUiFixture.busyRow.querySelector('[data-action=reject]').disabled&&document.querySelectorAll('.confirm-overlay').length===1`);
  localCheck('notificationDuringRejectConfirmationDoesNotReadDrafts', calls.filter(call => call.method === 'list').length === rejectLists);
  holdMutation = 'reject'; await click('.confirm-btn.danger'); await waitForMutation(); await eventTurn();
  localCheck('rejectEventDoesNotReadDraftsBeforeTheMutationResponse', calls.filter(call => call.method === 'list').length === rejectLists);
  releaseMutation(); await waitFor(`!document.querySelector('[data-draft-list] ${row(ids.invalid)}')`); await eventTurn();
  localCheck('rejectEventAndActionPerformExactlyOneDraftReload', calls.filter(call => call.method === 'list').length - rejectLists === 1);
  localCheck('ignoreArchivesRecordWithoutDeletingItsPackage', service.get(ids.invalid).status === 'rejected' && fs.existsSync(path.join(service.draftRecordsDir, ids.invalid, 'proposed/SKILL.md')));
  fs.appendFileSync(path.join(liveDir('grouped-skill'), 'SKILL.md'), '\nConcurrent change before publish\n');
  const beforePublish = calls.filter(call => call.method === 'publish').length;
  await click(row(ids.grouped) + ' [data-action=publish]');
  await waitFor(`document.querySelector(${JSON.stringify(row(ids.grouped))}).dataset.readiness==='stale'`);
  await check('prePublishValidationRefreshesStaleStateWithoutMisleadingConfirmation', `document.querySelector(${JSON.stringify(row(ids.grouped) + ' [data-action=publish]')}).disabled&&!document.querySelector('.confirm-overlay')`);
  localCheck('stalePreflightNeverCallsPublish', calls.filter(call => call.method === 'publish').length === beforePublish);
  await click(row(ids.grouped) + ' [data-action=rebase]'); await waitFor("!!document.querySelector('.skill-rebase-overlay')");
  await act("document.documentElement.dataset.theme='dark';"); win.setSize(680, 660); await waitFor('innerWidth<=680'); await settle();
  await check('narrowDarkComparisonAndActionsFitWithoutPageOverflow', "(()=>{const d=document.querySelector('.skill-rebase-box').getBoundingClientRect(),s=document.querySelector('[data-rebase-save]').getBoundingClientRect();return d.top>=36&&d.left>=0&&d.right<=innerWidth&&d.bottom<=innerHeight&&s.bottom<=d.bottom&&document.documentElement.scrollWidth<=innerWidth&&getComputedStyle(document.querySelector('.skill-rebase-versions')).gridTemplateColumns.split(' ').length===1;})()");
  await screenshot('updates-conflict-dark-narrow');
  await act("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));");
  await check('cancelComparisonPreservesCandidatesAndChatDraft', "!document.querySelector('.skill-rebase-overlay')&&inputEl.value==='技能更新期间保留的对话草稿'");
  await check('rendererHasNoErrorsOrNodeAccess', "uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'");
  await client.close();
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); fs.rmSync(fixtureRoot, { recursive: true, force: true }); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack || error)); save(); console.error(error.stack);
  try { if (win && !win.isDestroyed()) { console.error(await evaluate('JSON.stringify(uiFixture.errors)')); await screenshot('failure'); } } catch (_) {}
  if (releaseMutation) releaseMutation();
  if (releaseList) releaseList();
  await client.close(); clearTimeout(deadline); app.exit(1);
});
