'use strict';
// Production renderer only: in-memory settings/memory/context, isolated profile,
// blocked network. No real Relay main process, provider or user data is used.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/personalization-settings-smoke');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, errors = [];
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ scope: 'sandboxed actual renderer; synthetic persistence, memory and context; network blocked', step, checks, errors }, null, 2));
const deadline = setTimeout(() => { errors.push('Timeout: ' + step); save(); app.exit(1); }, 100000);
const ev = source => win.webContents.executeJavaScript(source), act = source => ev(`(()=>{${source}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(source) { await ev(`new Promise((resolve,reject)=>{const end=Date.now()+6500;function poll(){if(${source})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(source)}));setTimeout(poll,20)}poll()})`); }
async function check(name, source) { step = name; checks[name] = !!await ev(source); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function click(selector) { await act(`const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click();`); }
async function edit(value) { await act(`$('relayInstructions').value=${JSON.stringify(value)};$('relayInstructions').dispatchEvent(new Event('input',{bubbles:true}));`); }
async function capture(name) { await ev('document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(100); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function bottomSave() { await ev("openSettings('general')"); await click('#btnSettingsSave'); await waitFor('!settingsSaveBusy'); }

function seed() {
  localStorage.clear(); const base = window.api, clone = value => structuredClone(value);
  const state = window.personalizationFixture = { writes: [], mode: 'ok', release: null, contextCalls: [], holdContext: false, contextPending: [],
    saved: { app: { theme: 'light', quickChatEnabled: true, conversationIndex: true, allowCommandTasks: false, showContextUsage: true,
      relayInstructions: '默认用中文回答。', untouchedPreference: 'preserved' }, claude: { defaultModel: 'opus', routes: clone(uiFixture.routes) } } };
  const settings = {
    read: async () => { const original = await base.settings.read(); return { ...original, app: { ...original.app, ...clone(state.saved.app) }, claude: { ...original.claude, ...clone(state.saved.claude) } }; },
    write: async input => {
      const payload = clone(input); state.writes.push(payload);
      if (state.mode === 'fail') return { ok: false, message: '合成保存失败，请重试' };
      const commit = () => { state.saved.app = { ...state.saved.app, ...payload.app }; state.saved.claude = { ...state.saved.claude, ...payload.claude }; return { ok: true, routes: clone(state.saved.claude.routes) }; };
      return state.mode === 'hold' ? new Promise(resolve => { state.release = () => { state.release = null; state.mode = 'ok'; resolve(commit()); }; }) : commit();
    },
  };
  const memory = new Proxy(base.memory, { get(target, key) {
    if (key === 'list') return async () => ({ ok: true, items: [{ file: 'fixture-note.md', name: '合成项目偏好', type: 'reference', scope: 'global', status: 'active', description: '仅用于验证设置详情的布局。' }] });
    if (key === 'read') return async file => ({ ok: true, content: file === 'MEMORY.md' ? '# 记忆索引\n\n- 合成项目偏好：fixture-note.md' : '# 合成项目偏好\n\n先列出可验证的结论，再说明依据。\n\n' + '这是隔离测试的记忆正文。\n\n'.repeat(30), revision: 'a'.repeat(64) });
    return target[key];
  } });
  window.api = new Proxy(base, { get(target, key) {
    if (key === 'settings') return settings;
    if (key === 'memory') return memory;
    if (key === 'generalPreferences') return { ...target.generalPreferences, get: async () => ({ ok: true, preferences: clone(state.saved.app), capabilities: {} }) };
    if (key === 'claudeRuntimeInfo') return async (id, options = {}) => {
      const route = configuredChatRoute(currentModel); state.contextCalls.push({ id, options });
      const result = { ok: true, connected: true, busy: runs.has(id), providerId: route.providerId, providerRevision: route.providerRevision, routeTier: currentModel, model: route.modelId,
        context: { totalTokens: 31000, maxTokens: 100000, rawMaxTokens: 128000, percentage: 31 + state.contextCalls.length, estimated: true, sampledAt: new Date().toISOString() } };
      return state.holdContext ? new Promise(resolve => state.contextPending.push(() => resolve(result))) : result;
    };
    return target[key];
  } });
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n') + '\n(' + seed.toString() + ')();';
  const page = path.join(out, 'fixture.html'); fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive(); await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  await ev("openSettings('personalization')"); await waitFor('settingsFormLoaded&&document.querySelector("#memorySection .dp-item")');
  await check('personalizationMenuShowsGuidanceBeforeMemoryWithOneSaveSurface', "document.querySelector('.set-nav-item[data-cat=memory]').textContent.trim()==='个性化'&&$('relayInstructionsSection').parentElement.firstElementChild===$('relayInstructionsSection')&&$('relayInstructionsSection').nextElementSibling.textContent==='Relay 记忆'&&getComputedStyle($('btnSettingsSave').closest('.modal-footer')).display==='none'");
  await check('savedGuidanceHasAccessibleEditorLimitAndNoUnsavedAction', "$('relayInstructions').value==='默认用中文回答。'&&$('relayInstructions').maxLength===10000&&$('relayInstructions').getAttribute('aria-describedby').includes('relayInstructionsStatus')&&$('relayInstructionsSave').disabled&&personalizationFixture.writes.length===0");
  await edit('请先给结论，再说明依据。'); await act('personalizationFixture.editor=$("relayInstructions");');
  await ev("openSettings('general')"); await click('#set-theme [data-value=dark]'); await ev("openSettings('conversation');openSettings('memory')");
  await check('categoryChangesPreserveGuidanceAndUnrelatedThemeDraft', "$('relayInstructions')===personalizationFixture.editor&&$('relayInstructions').value==='请先给结论，再说明依据。'&&$('set-theme').dataset.value==='dark'&&personalizationFixture.saved.app.theme==='light'&&personalizationFixture.writes.length===0");
  await click('#relayInstructionsSave'); await waitFor("$('relayInstructionsStatus').textContent==='已保存'");
  await check('independentSaveWritesOnlyGuidanceAndKeepsOtherDraftDirty', "JSON.stringify(Object.keys(personalizationFixture.writes.at(-1)))==='[\"app\"]'&&JSON.stringify(Object.keys(personalizationFixture.writes.at(-1).app))==='[\"relayInstructions\"]'&&personalizationFixture.saved.app.theme==='light'&&$('set-theme').dataset.value==='dark'&&$('settingsHint').textContent.includes('未保存')&&personalizationFixture.saved.app.untouchedPreference==='preserved'");
  await bottomSave();
  await check('bottomSaveCommitsOtherFieldsWithoutOverwritingIndependentlySavedGuidance', "personalizationFixture.saved.app.theme==='dark'&&personalizationFixture.saved.app.relayInstructions==='请先给结论，再说明依据。'&&!Object.hasOwn(personalizationFixture.writes.at(-1).app,'relayInstructions')&&personalizationFixture.saved.app.untouchedPreference==='preserved'");
  await ev("openSettings('memory')"); await edit('失败后应保留的说明'); await act("personalizationFixture.mode='fail'"); await click('#relayInstructionsSave'); await waitFor("$('relayInstructionsStatus').dataset.error==='true'");
  await check('independentSaveFailureKeepsDraftAndPreviousConfirmedValue', "$('relayInstructions').value==='失败后应保留的说明'&&!$('relayInstructionsSave').disabled&&personalizationFixture.saved.app.relayInstructions==='请先给结论，再说明依据。'&&$('relayInstructionsStatus').textContent.includes('保存失败')");
  await act("personalizationFixture.mode='ok'"); await click('#relayInstructionsSave'); await waitFor("$('relayInstructionsStatus').textContent==='已保存'");
  await check('retryPersistsTheDraftAndClearsFalseGlobalDirtyState', "personalizationFixture.saved.app.relayInstructions==='失败后应保留的说明'&&!$('settingsHint').textContent.includes('未保存')");
  await edit(''); await click('#relayInstructionsSave'); await waitFor("personalizationFixture.saved.app.relayInstructions===''"); await ev("loadSettingsForm('memory')"); await waitFor('settingsFormLoaded');
  await check('clearingGuidancePersistsAnEmptyValueAcrossSettingsReload', "$('relayInstructions').value===''&&$('relayInstructionsSave').disabled&&Object.hasOwn(personalizationFixture.saved.app,'relayInstructions')&&personalizationFixture.saved.app.relayInstructions===''");

  await edit('慢保存快照 A'); await act("personalizationFixture.mode='hold';personalizationFixture.before=personalizationFixture.writes.length"); await click('#relayInstructionsSave'); await waitFor('!!personalizationFixture.release'); await edit('保存期间新增草稿 B');
  await bottomSave();
  await check('bottomSaveCannotRaceAnIndependentSaveAlreadyInFlight', "personalizationFixture.writes.length===personalizationFixture.before+1&&$('settingsHint').textContent.includes('正在保存')&&$('relayInstructions').value==='保存期间新增草稿 B'");
  await act('personalizationFixture.release()'); await waitFor("$('relayInstructionsStatus').textContent.includes('未保存')");
  await check('slowIndependentAcknowledgementPreservesNewerTyping', "personalizationFixture.saved.app.relayInstructions==='慢保存快照 A'&&$('relayInstructions').value==='保存期间新增草稿 B'&&!$('relayInstructionsSave').disabled&&$('settingsHint').textContent.includes('未保存')");
  await bottomSave();
  await check('bottomSaveCanCommitAGuidanceDraftFromAnotherCategory', "personalizationFixture.saved.app.relayInstructions==='保存期间新增草稿 B'&&personalizationFixture.saved.app.untouchedPreference==='preserved'&&$('relayInstructionsSave').disabled");
  await edit('底部慢保存快照 C'); await act("personalizationFixture.mode='hold'"); await click('#btnSettingsSave'); await waitFor('!!personalizationFixture.release&&settingsSaveBusy'); await edit('底部保存期间新草稿 D');
  await ev("openSettings('memory')"); await click('#relayInstructionsSave'); await act('personalizationFixture.release()'); await waitFor('!settingsSaveBusy');
  await check('slowBottomSaveKeepsNewGuidanceAndBlocksDuplicateIndependentSave', "personalizationFixture.saved.app.relayInstructions==='底部慢保存快照 C'&&$('relayInstructions').value==='底部保存期间新草稿 D'&&!$('relayInstructionsSave').disabled&&$('settingsHint').textContent.includes('未保存')");
  await act("personalizationFixture.mode='fail'"); await bottomSave();
  await check('bottomSaveFailurePreservesGuidanceAndReportsBothSaveSurfaces', "personalizationFixture.saved.app.relayInstructions==='底部慢保存快照 C'&&$('relayInstructions').value==='底部保存期间新草稿 D'&&$('relayInstructionsStatus').dataset.error==='true'&&$('settingsHint').dataset.error==='true'");
  await act("personalizationFixture.mode='ok'"); await bottomSave();
  await check('bottomRetryConfirmsOnlyTheLatestDraftWithoutLosingUnrelatedSettings', "personalizationFixture.saved.app.relayInstructions==='底部保存期间新草稿 D'&&personalizationFixture.saved.app.untouchedPreference==='preserved'&&$('relayInstructionsSave').disabled");

  for (const [name, theme, width, height] of [['personalization-light','light',1200,850],['personalization-dark','dark',1200,850],['personalization-narrow','dark',780,720]]) {
    win.setSize(width, height); await ev(`openSettings('memory');document.documentElement.dataset.theme=${JSON.stringify(theme)};$('setContent').scrollTop=0`); await delay(100);
    await check(name + 'FitsTheSettingsColumn', "(()=>{const content=$('setContent'),field=$('relayInstructions').getBoundingClientRect(),button=$('relayInstructionsSave').getBoundingClientRect(),header=$('relayInstructionsSection').getBoundingClientRect();return content.scrollWidth<=content.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1&&field.width>100&&field.left>=content.getBoundingClientRect().left&&field.right<=content.getBoundingClientRect().right+1&&button.left>=header.left&&button.right<=header.right+1})()");
    await capture(name);
  }
  await act("void renderMemoryEditor('fixture-note.md','合成项目偏好')"); await waitFor("$('dpMemoryPreview')?.textContent.includes('合成项目偏好')"); await capture('personalization-memory-detail-narrow');
  await check('memoryDetailUsesOnlyTheContentColumnAndHidesGuidance', "(()=>{const detail=document.querySelector('.memory-detail:not([hidden])'),r=detail.getBoundingClientRect(),content=$('setContent').getBoundingClientRect();return getComputedStyle($('relayInstructionsSection')).display==='none'&&getComputedStyle(document.querySelector('.relay-memory-heading')).display==='none'&&r.left>=content.left&&r.right<=content.right+1&&r.bottom<=content.bottom+2&&document.querySelector('.set-nav').getClientRects().length>0})()");
  await click('[data-memory-back]'); await check('returningFromMemoryDetailRestoresTheSameGuidance', "getComputedStyle($('relayInstructionsSection')).display!=='none'&&$('relayInstructions').value==='底部保存期间新草稿 D'");

  win.setSize(1100, 760); await act("closeSettings();currentConv={id:'context-guidance-fixture',model:currentModel,turns:[]};runs.set(currentConv.id,{convId:currentConv.id,jobId:'synthetic-context-job'});setRunning(true);");
  await waitFor('personalizationFixture.contextCalls.length>=2&&!contextUsageEl.classList.contains("hidden")'); await act('showContextUsagePopover();');
  await check('enabledContextPollsWhileRunningAndShowsItsPopover', "contextUsageEnabled&&contextUsagePopover.classList.contains('visible')&&personalizationFixture.contextCalls.every(call=>call.options.contextOnly)");
  await act("personalizationFixture.holdContext=true;personalizationFixture.oldContext=refreshClaudeRuntimeInfo(currentConv.id,{contextOnly:true});"); await waitFor('personalizationFixture.contextPending.length>=1');
  await ev("openSettings('general')"); await click('#sw-showContextUsage');
  await check('contextSwitchIsAccessibleAndChangesRemainDraftUntilSaved', "$('sw-showContextUsage').getAttribute('role')==='switch'&&$('sw-showContextUsage').getAttribute('aria-checked')==='false'&&!$('sw-showContextUsage').classList.contains('on')&&personalizationFixture.saved.app.showContextUsage===true&&contextUsageEnabled===true");
  await click('#btnSettingsSave'); await waitFor('!settingsSaveBusy&&personalizationFixture.saved.app.showContextUsage===false'); await capture('general-context-display-disabled');
  await act('personalizationFixture.stopped=personalizationFixture.contextCalls.length;closeSettings();for(const release of personalizationFixture.contextPending.splice(0))release();personalizationFixture.holdContext=false;'); await ev('personalizationFixture.oldContext'); await delay(2200);
  await check('savedOffHidesPopoverRejectsLateVisibilityAndStopsPolling', "contextUsageEnabled===false&&contextUsageEl.classList.contains('hidden')&&!contextUsagePopover.classList.contains('visible')&&contextUsagePopover.getAttribute('aria-hidden')==='true'&&personalizationFixture.contextCalls.length===personalizationFixture.stopped&&!contextUsagePollTimer");
  await ev("loadSettingsForm('general');openSettings('general')"); await waitFor('settingsFormLoaded');
  await check('contextSwitchReloadsItsSavedDisabledState', "!$('sw-showContextUsage').classList.contains('on')&&$('sw-showContextUsage').getAttribute('aria-checked')==='false'&&personalizationFixture.saved.app.showContextUsage===false");
  await click('#sw-showContextUsage'); await click('#btnSettingsSave'); await waitFor('!settingsSaveBusy&&personalizationFixture.saved.app.showContextUsage===true'); await act('closeSettings();personalizationFixture.enabledAt=personalizationFixture.contextCalls.length;'); await waitFor('personalizationFixture.contextCalls.length>=personalizationFixture.enabledAt+2');
  await check('savedOnRestoresContextDisplayAndPeriodicPollingWithoutModelCalls', "contextUsageEnabled&&!contextUsageEl.classList.contains('hidden')&&!!contextUsagePollTimer&&personalizationFixture.contextCalls.length>=personalizationFixture.enabledAt+2&&uiFixture.errors.length===0&&!uiFixture.calls.includes('runClaude')&&typeof require==='undefined'&&typeof process==='undefined'");
  await act('runs.delete(currentConv.id);setRunning(false);'); step = 'complete'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => { errors.push(String(error.stack || error)); save(); console.error(error); if (win && !win.isDestroyed()) try { console.error(await ev('JSON.stringify({ui:uiFixture.errors,status:$("relayInstructionsStatus")?.textContent,hint:$("settingsHint")?.textContent})')); await capture('failure'); } catch (_) {} clearTimeout(deadline); app.exit(1); });
