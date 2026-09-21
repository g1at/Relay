'use strict';
// Real renderer, isolated in-memory conversations and synthetic events. No provider calls.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/conversation-drafts-smoke');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, failures = [];
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, failures }, null, 2));
const timeout = setTimeout(() => { failures.push('timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function load(id) { await evaluate(`loadConversation(${JSON.stringify(id)})`); await waitFor(`currentConv?.id===${JSON.stringify(id)}&&currentPermissionState`); }
async function draft(text, filename, skill) {
  await act(`$('input').value=${JSON.stringify(text)};$('input').dispatchEvent(new Event('input',{bubbles:true}));${filename ? `addFiles([{path:'C:/relay-draft-fixture/${filename}',name:'${filename}',ext:'txt',size:24}]);` : ''}${skill ? `selectComposerSkill({name:'${skill}',displayName:'${skill}',callName:'${skill}'});` : ''}`);
}
function seed() {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  const f = window.draftFixture = { saves: 0, launches: [], holdSave: false, releaseSave: null, holdLoad: '', releaseLoad: null,
    holdPaste: false, releasePaste: null, holdSteer: false, releaseSteer: null, holdLaunch: false, releaseLaunch: null,
    holdPicker: false, releasePicker: null, holdPermission: '', releasePermission: null };
  const permissions = new Proxy(base.permissions, { get(target, method) {
    if (method === 'get') return async id => {
      const value = await target.get(id);
      if (id && f.holdPermission === id) {
        f.holdPermission = ''; return new Promise(resolve => { f.releasePermission = () => { f.releasePermission = null; resolve(value); }; });
      }
      return value;
    };
    return target[method];
  } });
  const history = new Proxy(base.history, { get(target, method) {
    if (method === 'save') return async value => {
      f.saves++; const payload = clone(value);
      if (f.holdSave) { f.holdSave = false; return new Promise(resolve => { f.releaseSave = async fail => {
        f.releaseSave = null; resolve(fail ? { error: '合成保存失败' } : await target.save(payload));
      }; }); }
      return target.save(payload);
    };
    if (method === 'load') return async id => {
      if (f.holdLoad === id) { f.holdLoad = ''; return new Promise(resolve => { f.releaseLoad = async () => {
        f.releaseLoad = null; resolve(await target.load(id));
      }; }); }
      return target.load(id);
    };
    return target[method];
  } });
  const image = new Proxy(base.image, { get(target, method) {
    if (method === 'savePaste') return async () => {
      const result = { ok: true, path: 'C:/relay-draft-fixture/slow-paste.png', name: 'slow-paste.png' };
      if (f.holdPaste) { f.holdPaste = false; return new Promise(resolve => { f.releasePaste = () => { f.releasePaste = null; resolve(result); }; }); }
      return result;
    };
    return target[method];
  } });
  window.api = new Proxy(base, { get(target, key) {
    if (key === 'history') return history;
    if (key === 'permissions') return permissions;
    if (key === 'image') return image;
    if (key === 'runClaude') return async (...args) => {
      f.launches.push(clone(args));
      if (f.holdLaunch) { f.holdLaunch = false; return new Promise(resolve => { f.releaseLaunch = async () => {
        f.releaseLaunch = null; resolve(await target.runClaude(...args));
      }; }); }
      return target.runClaude(...args);
    };
    if (key === 'openAttachmentDialog') return async () => {
      if (f.holdPicker) { f.holdPicker = false; return new Promise(resolve => { f.releasePicker = () => {
        f.releasePicker = null; resolve([{ path: 'C:/relay-draft-fixture/picker.txt', name: 'picker.txt', ext: 'txt', size: 5 }]);
      }; }); }
      return [];
    };
    if (key === 'steerClaude') return async request => {
      if (f.holdSteer) { f.holdSteer = false; return new Promise(resolve => { f.releaseSteer = () => {
        f.releaseSteer = null; resolve({ ok: false, code: 'SYNTHETIC_OFFLINE', error: '合成补充发送失败' });
      }; }); }
      return { ok: true, input: { id: request.messageId, text: request.prompt, files: request.files,
        skill: request.skill, status: 'applied', followUpMode: request.followUpMode, ts: new Date().toISOString() } };
    };
    return target[key];
  } });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(root, 'test', name), 'utf8')).join('\n') + `\n(${seed.toString()})();localStorage.clear();`;
  const page = path.join(out, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive(); await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle&&currentPermissionState');
  await evaluate(`Promise.all(['draft-a','draft-b'].map(id=>window.api.history.save({id,title:id,mode:'plain',model:'opus',turns:[{user:'合成会话 '+id,assistant:'历史回答',status:'complete'}]})))`);
  await load('draft-a'); await draft('A 尚未发送的内容', 'a.txt', 'skill-a');
  await act('draftFixture.savedBeforeNavigation=draftFixture.saves;');
  await load('draft-b');
  await check('NewlyOpenedConversationHasIndependentEmptyComposer', '!inputEl.value&&!attachedFiles.length&&!selectedQuickSkill');
  await draft('B 尚未发送的内容', 'b.txt', 'skill-b');
  await load('draft-a');
  await check('ConversationATextAttachmentsAndSkillReturnTogether', 'inputEl.value==="A 尚未发送的内容"&&attachedFiles.length===1&&attachedFiles[0].name==="a.txt"&&selectedQuickSkill?.name==="skill-a"&&!attachmentsEl.classList.contains("hidden")');
  await check('RestoringDraftDoesNotRewriteHistory', 'draftFixture.saves===draftFixture.savedBeforeNavigation');
  await evaluate('loadConversation("draft-a",null,{forceReload:true})');
  await check('ForcedHistoryReloadKeepsOwnedDraft', 'inputEl.value==="A 尚未发送的内容"&&attachedFiles[0]?.name==="a.txt"&&selectedQuickSkill?.name==="skill-a"');
  await load('draft-b');
  await check('ConversationBTextAttachmentsAndSkillReturnTogether', 'inputEl.value==="B 尚未发送的内容"&&attachedFiles.length===1&&attachedFiles[0].name==="b.txt"&&selectedQuickSkill?.name==="skill-b"');
  await act('startNewConv();');
  await check('NewConversationClearsTextFilesAndSkill', '!currentConv&&!inputEl.value&&!attachedFiles.length&&!selectedQuickSkill');
  await draft('新的未发送内容', 'new.txt', 'new-skill');
  await load('draft-a');
  await check('AbandonedNewConversationNeverOverwritesExistingDraft', 'inputEl.value==="A 尚未发送的内容"&&attachedFiles[0]?.name==="a.txt"&&selectedQuickSkill?.name==="skill-a"');

  // A screenshot can finish saving after the user navigated away.
  await act(`draftFixture.holdPaste=true;draftFixture.pastePromise=savePastedDataUrlToChat('data:image/png;base64,aQ==',2);`);
  await waitFor('draftFixture.releasePaste'); await load('draft-b');
  await act('draftFixture.releasePaste();'); await evaluate('draftFixture.pastePromise');
  await check('DelayedPasteDoesNotAttachToTheNewConversation', 'inputEl.value==="B 尚未发送的内容"&&attachedFiles.length===1&&attachedFiles[0].name==="b.txt"');
  await load('draft-a');
  await check('DelayedPasteReturnsToItsOriginatingConversation', 'inputEl.value==="A 尚未发送的内容"&&attachedFiles.length===2&&attachedFiles.some(file=>file.name==="slow-paste.png")&&selectedQuickSkill?.name==="skill-a"');

  // A native file picker may be abandoned during navigation; it cannot contaminate B.
  await act(`draftFixture.holdPicker=true;$('btnAttach').click();`);
  await waitFor('document.querySelector("[data-attachment-kind=files]")');
  await act('document.querySelector("[data-attachment-kind=files]").click();'); await waitFor('draftFixture.releasePicker');
  await load('draft-b'); await act('draftFixture.releasePicker();'); await delay(80);
  await check('DelayedNativePickerNeverWritesIntoAnotherConversation', 'attachedFiles.length===1&&attachedFiles[0].name==="b.txt"&&selectedQuickSkill?.name==="skill-b"');
  await load('draft-a');
  await check('DelayedNativePickerRetainsFilesForItsOriginatingConversation', 'attachedFiles.some(file=>file.name==="picker.txt")&&inputEl.value==="A 尚未发送的内容"&&selectedQuickSkill?.name==="skill-a"');
  await load('draft-b');

  // A stale history read must not put its draft into a newer empty conversation.
  await act('draftFixture.holdLoad="draft-a";draftFixture.navigationPromise=loadConversation("draft-a",null,{forceReload:true});');
  await waitFor('draftFixture.releaseLoad'); await act('startNewConv();'); await draft('新页面输入不能被迟到加载覆盖');
  await act('draftFixture.releaseLoad();'); await evaluate('draftFixture.navigationPromise');
  await check('LateHistoryLoadCannotReplaceNewDraft', '!currentConv&&inputEl.value==="新页面输入不能被迟到加载覆盖"&&!attachedFiles.length&&!selectedQuickSkill');

  // Save failure while offscreen returns the consumed draft to A, never B.
  await load('draft-a');
  await act('draftFixture.holdSave=true;draftFixture.sendPromise=send();'); await waitFor('draftFixture.releaseSave');
  await check('SendConsumesOnlySourceComposer', '!inputEl.value&&!attachedFiles.length&&!selectedQuickSkill');
  await load('draft-b'); await act('draftFixture.releaseSave(true);'); await evaluate('draftFixture.sendPromise');
  await check('BackgroundSaveFailureDoesNotOverwriteVisibleDraft', 'inputEl.value==="B 尚未发送的内容"&&attachedFiles[0]?.name==="b.txt"&&selectedQuickSkill?.name==="skill-b"');
  await load('draft-a');
  await check('BackgroundSaveFailureRestoresItsOriginalDraft', 'inputEl.value==="A 尚未发送的内容"&&attachedFiles.some(file=>file.name==="a.txt")&&selectedQuickSkill?.name==="skill-a"');

  // The launch receipt can lag behind another conversation's fresh draft.
  await act('draftFixture.holdLaunch=true;draftFixture.sendPromise=send();'); await waitFor('draftFixture.releaseLaunch');
  await act('draftFixture.activeJob=runs.get("draft-a").jobId;'); await load('draft-b');
  await act('draftFixture.releaseLaunch();'); await evaluate('draftFixture.sendPromise');
  await check('LateSendReceiptLeavesOtherComposerUntouched', 'inputEl.value==="B 尚未发送的内容"&&attachedFiles[0]?.name==="b.txt"&&selectedQuickSkill?.name==="skill-b"');
  await load('draft-a');
  await check('SentDraftDoesNotReappearOnReturn', '!inputEl.value&&!attachedFiles.length&&!selectedQuickSkill&&runs.has("draft-a")');
  await draft('运行中的补充草稿', 'steer.txt', 'steer-skill');
  await load('draft-b'); await load('draft-a');
  await check('RunningConversationHasItsOwnUnsentFollowUp', 'inputEl.value==="运行中的补充草稿"&&attachedFiles[0]?.name==="steer.txt"&&selectedQuickSkill?.name==="steer-skill"&&runs.has("draft-a")');
  await act('draftFixture.holdSteer=true;draftFixture.steerPromise=steerCurrent();'); await waitFor('draftFixture.releaseSteer');
  await load('draft-b');
  await act('draftFixture.releaseSteer();'); await evaluate('draftFixture.steerPromise');
  await check('RejectedBackgroundFollowUpDoesNotReplaceOtherDraft', 'inputEl.value==="B 尚未发送的内容"&&attachedFiles[0]?.name==="b.txt"&&selectedQuickSkill?.name==="skill-b"');
  await load('draft-a');
  await check('RejectedFollowUpRestoresOnlyItsOwner', 'inputEl.value==="运行中的补充草稿"&&attachedFiles[0]?.name==="steer.txt"&&selectedQuickSkill?.name==="steer-skill"');
  // Identical content in another owner must not be cleared by reconciliation.
  await load('draft-b');
  await act('inputEl.value="运行中的补充草稿";attachedFiles=[];renderAttachments();setSelectedQuickSkill(null);');
  await draft('运行中的补充草稿', 'steer.txt', 'steer-skill');
  await act('syncRunningUI();');
  await check('IdenticalFollowUpTextInAnotherConversationIsStillIndependent', 'inputEl.value==="运行中的补充草稿"&&attachedFiles[0]?.name==="steer.txt"&&selectedQuickSkill?.name==="steer-skill"');
  await load('draft-a'); await act('draftFixture.steerPromise=steerCurrent();'); await evaluate('draftFixture.steerPromise');
  await check('SuccessfulFollowUpClearsOnlyItsOwnDraft', '!inputEl.value&&!attachedFiles.length&&!selectedQuickSkill');
  await load('draft-b');
  await check('SuccessfulFollowUpPreservesIdenticalOtherDraft', 'inputEl.value==="运行中的补充草稿"&&attachedFiles[0]?.name==="steer.txt"&&selectedQuickSkill?.name==="steer-skill"');
  await act(`handleClaudeEvent({jobId:draftFixture.activeJob,type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',result:'合成测试完成'}});`); await waitFor('!runs.size');
  await check('BackgroundCompletionDoesNotChangeComposer', 'currentConv?.id==="draft-b"&&inputEl.value==="运行中的补充草稿"&&selectedQuickSkill?.name==="steer-skill"');

  // Mode, chip, hint and submitted SDK arguments must all belong to the visible
  // conversation; changing a project is not permission to inherit a goal.
  await evaluate(`Promise.all(['goal','plan','default'].map(kind=>window.api.history.save({id:'mode-'+kind,title:kind,mode:'plain',model:'opus',executionMode:{kind},turns:[]})))`);
  await load('mode-goal');
  await check('GoalHistoryRestoresModeChipAndHintTogether', 'currentExecutionMode.kind==="goal"&&!$("btnExecutionMode").hidden&&inputEl.placeholder==="描述目标及完成条件…"');
  await act('startNewConv();');
  await check('NewConversationImmediatelyClearsPreviousGoalModeAndHint', '!currentConv&&currentExecutionMode.kind==="default"&&$("btnExecutionMode").hidden&&inputEl.placeholder==="发消息…"');
  await evaluate('setComposerExecutionMode({kind:"goal"})');
  await check('UnsentGoalDraftHasAnOwnedModeAndHint', 'currentExecutionMode.kind==="goal"&&!$("btnExecutionMode").hidden&&inputEl.placeholder==="描述目标及完成条件…"');
  await act('startNewConv("plain",null,null,null,"fixture-project-other");');
  await check('NewProjectDraftDoesNotInheritUnsentGoal', '!currentConv&&currentProjectId==="fixture-project-other"&&currentExecutionMode.kind==="default"&&$("btnExecutionMode").hidden&&inputEl.placeholder==="发消息…"');
  await load('mode-plan');
  await check('PlanHistoryRestoresItsOwnHintInsteadOfPreviousGoal', 'currentExecutionMode.kind==="plan"&&!$("btnExecutionMode").hidden&&inputEl.placeholder==="描述需要分析和规划的任务…"');
  await load('mode-default');
  await check('OrdinaryHistoryDoesNotInheritGoalOrPlanAffordances', 'currentExecutionMode.kind==="default"&&$("btnExecutionMode").hidden&&inputEl.placeholder==="发消息…"');
  await act('draftFixture.holdPermission="mode-goal";'); await evaluate('loadConversation("mode-goal")'); await waitFor('draftFixture.releasePermission');
  await load('mode-default'); await act('draftFixture.releasePermission();'); await delay(50);
  await check('LateGoalPermissionReadCannotContaminateAnotherConversation', 'currentConv.id==="mode-default"&&currentExecutionMode.kind==="default"&&$("btnExecutionMode").hidden&&inputEl.placeholder==="发消息…"');
  await load('mode-goal'); await act('startNewConv();inputEl.value="普通任务：核对传入模式";'); await evaluate('send()');
  await check('OrdinaryTaskAfterGoalSendsDefaultModeToBackend', 'draftFixture.launches.at(-1)[15].kind==="default"&&currentConv.executionMode.kind==="default"&&inputEl.placeholder==="发消息…"');
  await act('handleClaudeEvent({jobId:draftFixture.launches.at(-1)[11],type:"job-done",exitCode:0,finalResult:{type:"result",subtype:"success",result:"模式核对完成"}});'); await waitFor('!runs.size');
  await check('RendererRemainsIsolatedAndErrorFree', 'uiFixture.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  step = 'completed'; save(); clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(async error => { failures.push(String(error.stack || error)); console.error(error); if (win&&!win.isDestroyed()) { try { console.error(await evaluate('JSON.stringify(uiFixture.errors)')); fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG()); } catch (_) {} } save(); clearTimeout(timeout); app.exit(1); });
