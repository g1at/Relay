'use strict';
// Run the production renderer with synthetic identity/statistics APIs. No real IPC,
// user settings, history, native file picker, or provider requests are involved.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/profile-page-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, failures = [], diagnostics = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, failures, diagnostics }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function next(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(next,20)}next()})`);
}
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); if (!checks[name]) throw Error(name); }
async function click(selector) {
  await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click()})()`);
  await settle();
}
async function inputName(value) {
  await evaluate(`(()=>{const node=document.getElementById('set-brandName');node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await settle();
}
async function screenshot(name) {
  await act("document.getAnimations().forEach(animation=>{if(animation.effect?.getComputedTiming().iterations!==Infinity)try{animation.finish()}catch(_){}});");
  await settle(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

function installFixture() {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  const state = window.profileFixture = {
    identity: { name: 'Relay 本地助手', logo: null, nameMax: 40, revision: 'initial' },
    profileWrites: [], legacyWrites: 0, previewPicks: 0, discarded: [], preview: null,
    holdBrand: false, failBrand: false, pendingGets: [], holdPick: false, pendingPicks: [], cancelPick: false,
    holdSave: false, failSave: false, pendingSaves: [], mode: 'hold', calls: [], pending: [], listeners: new Set(), overrides: {},
  };
  state.logo = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="22" fill="#24262b"/><path d="M22 20h17v15H22zm19 25h17v15H41zM22 45h12v15H22zm24-25h12v15H46z" fill="#fafafa"/></svg>');
  state.snapshot = (days, extra = {}) => {
    const daily = Array.from({ length: days }, (_, index) => ({ date: new Date(Date.UTC(2026, 8, 9 - days + 1 + index)).toISOString().slice(0, 10), count: index % 5 === 0 ? 0 : (index * 7) % 13 + 1 }));
    return { ok: true, available: true, days, generatedAt: '2026-09-09T04:12:00Z', refreshing: false, stale: false, totals: { messages: daily.reduce((sum, day) => sum + day.count, 0) }, daily,
      tokens: { available: true, totalTokens: 75000, inputTokens: 45000, outputTokens: 19000, cacheReadTokens: 6400, cacheCreationTokens: 4600, coverage: 'partial', byModel: [{ key: 'provider/deepseek-v4-flash', count: 44000 }, { key: 'provider/claude-sonnet', count: 25000 }, { key: 'provider/claude-haiku', count: 6000 }] }, coverage: { history: 'complete' }, ...extra };
  };
  state.resolve = (days, value) => { const entry = state.pending.findLast(item => item.days === days && !item.done); if (!entry) throw Error('No pending range ' + days); entry.done = true; entry.resolve(value); };
  state.emit = () => [...state.listeners].forEach(listener => listener({}));
  state.releaseBrand = () => { state.holdBrand = false; for (const item of state.pendingGets.splice(0)) item.resolve(item.snapshot); };
  state.releasePick = () => { state.holdPick = false; for (const item of state.pendingPicks.splice(0)) item.resolve(item.commit()); };
  state.releaseSave = () => { state.holdSave = false; for (const item of state.pendingSaves.splice(0)) item.resolve(item.commit()); };
  const brand = {
    async get() { if (state.failBrand) throw Error('合成资料读取失败'); const snapshot = clone(state.identity); if (state.holdBrand) return new Promise(resolve => state.pendingGets.push({ resolve, snapshot })); return snapshot; },
    async pickLogoPreview() {
      state.previewPicks++; if (state.cancelPick) return { ok: false, canceled: true };
      const commit = () => { state.preview = { previewId: 'preview-' + state.previewPicks, logo: state.logo }; return { ok: true, ...state.preview }; };
      if (state.holdPick) return new Promise(resolve => state.pendingPicks.push({ resolve, commit })); return commit();
    },
    async discardLogoPreview(id) { state.discarded.push(id); if (state.preview?.previewId === id) state.preview = null; return { ok: true }; },
    async saveProfile(input) {
      state.profileWrites.push(clone(input));
      if (state.failSave) return { ok: false, error: '合成资料保存失败' };
      const commit = () => {
        if (input.expectedRevision !== state.identity.revision) return { ok: false, code: 'PROFILE_CHANGED', error: '资料已更新' };
        if (input.logoAction === 'replace' && input.previewId !== state.preview?.previewId) return { ok: false, error: '预览过期' };
        state.identity = { name: input.name.trim(), logo: input.logoAction === 'default' ? null : input.logoAction === 'replace' ? state.preview.logo : state.identity.logo, nameMax: 40, revision: 'saved-' + state.profileWrites.length };
        state.preview = null; return { ok: true, ...clone(state.identity) };
      };
      if (state.holdSave) return new Promise(resolve => state.pendingSaves.push({ resolve, commit })); return commit();
    },
    async setName() { state.legacyWrites++; return { ok: true }; }, async pickLogo() { state.legacyWrites++; return { ok: true }; }, async resetLogo() { state.legacyWrites++; return { ok: true }; },
  };
  const stats = {
    overview(days, options) { state.calls.push({ days, options }); if (state.mode === 'hold') return new Promise(resolve => state.pending.push({ days, resolve, done: false })); if (state.mode === 'fail') return Promise.reject(Error('合成统计失败')); return Promise.resolve(state.overrides[days] || state.snapshot(days)); },
    onUpdated(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  };
  state.footerVisible = () => getComputedStyle(document.getElementById('btnSettingsSave').closest('.modal-footer')).display !== 'none';
  state.activityMatches = days => {
    const expected = state.snapshot(days).daily, cells = [...document.querySelectorAll('[data-usage-chart] [data-usage-date]')];
    return cells.length === days && cells.every((cell, index) => cell.dataset.usageDate === expected[index].date && cell.dataset.usageCount === String(expected[index].count));
  };
  window.api = new Proxy(base, { get(target, key) { return key === 'brand' ? brand : key === 'stats' ? stats : target[key]; } });
}
async function key(keyCode, modifiers = []) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await settle(); }
async function openEditor() { await click('#profileEdit'); await waitFor("document.getElementById('profileIdentityEditor').open&&!document.getElementById('profileSave').disabled"); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n') + `\n(${installFixture.toString()})();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}\nlocalStorage.clear();</script>`);
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1200, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.show(); win.focus(); await waitFor('!!window.relayUsagePage&&providerRoutingLoaded&&!restoringActiveRuns');
  await evaluate("openSettings('profile')"); await waitFor("document.getElementById('profileName').textContent==='Relay 本地助手'&&profileFixture.pending.length>0");
  await check('profileOmitsTaglineAndStatisticsFootnote', "!document.querySelector('.rpp-identity p')&&!document.querySelector('.rup-footnote')");
  await check('profileIsTheOnlyFirstNavigationEntryAndReplacesUsage', "document.querySelector('.set-nav-item').dataset.cat==='profile'&&!document.querySelector('.set-nav-item[data-cat=usage]')&&document.querySelectorAll('.set-nav-item[data-cat=profile]').length===1");
  await check('profileStartsCompactWithClosedDialogAndNoGlobalSaveFooter', "!document.getElementById('profileIdentityEditor').open&&!profileFixture.footerVisible()&&document.getElementById('profileEdit').getAttribute('aria-expanded')==='false'");
  await check('statisticsShellDoesNotBlockIdentityEditing', "document.querySelectorAll('[data-usage-metric]').length===4&&[...document.querySelectorAll('[data-usage-metric]')].every(node=>node.textContent==='—')&&!document.getElementById('profileEdit').disabled");
  await act("profileFixture.usageNode=document.querySelector('.relay-usage-page');inputEl.value='个人资料验收保留的对话草稿';");
  await openEditor();
  await check('editorIsAnAccessibleNativeModalWithOnlyLocalIdentityFields', "document.getElementById('profileIdentityEditor').matches(':modal')&&document.getElementById('profileIdentityEditor').getAttribute('role')==='dialog'&&document.getElementById('profileEditorTitle').textContent==='编辑个人资料'&&document.querySelectorAll('#profileIdentityEditor input').length===1&&document.getElementById('profileCancel')&&document.getElementById('profileSave')&&!profileFixture.footerVisible()");
  await inputName('先预览的资料草稿'); await click('#set-brandLogoPick'); await waitFor("document.getElementById('set-brandLogoPreview').src===profileFixture.logo");
  await check('nameAndAvatarRemainPreviewOnlyUntilSave', "profileFixture.identity.name==='Relay 本地助手'&&profileFixture.identity.logo===null&&document.getElementById('profileName').textContent==='Relay 本地助手'&&document.getElementById('profileLogo').classList.contains('relay-default-logo')&&profileFixture.profileWrites.length===0&&profileFixture.legacyWrites===0&&workspaceFixture.settingsWrites.length===0");
  await screenshot('profile-dialog-preview'); await click('#profileCancel'); await waitFor("!document.getElementById('profileIdentityEditor').open");
  await check('cancelDiscardsThePreviewWithoutAnyPersistentMutation', "profileFixture.profileWrites.length===0&&profileFixture.identity.name==='Relay 本地助手'&&profileFixture.identity.logo===null&&profileFixture.preview===null&&document.activeElement.id==='profileEdit'&&document.querySelector('.relay-usage-page')===profileFixture.usageNode");
  await openEditor(); await act('profileFixture.cancelPick=true;'); await click('#set-brandLogoPick');
  await check('cancelingTheNativePickerDoesNotChangeTheDraftAvatar', "document.getElementById('set-brandLogoPreview').classList.contains('relay-default-logo')&&profileFixture.profileWrites.length===0");
  await act('profileFixture.cancelPick=false;'); await inputName('保存后的本地助手'); await click('#set-brandLogoPick'); await act('profileFixture.holdSave=true;'); await click('#profileSave'); await waitFor('profileFixture.pendingSaves.length===1');
  await key('Escape'); await act("document.getElementById('profileSave').click();");
  diagnostics.pendingSave = await evaluate("({open:document.getElementById('profileIdentityEditor').open,saveDisabled:document.getElementById('profileSave').disabled,cancelDisabled:document.getElementById('profileCancel').disabled,writes:profileFixture.profileWrites,identity:profileFixture.identity,active:document.activeElement?.id})");
  await check('pendingSaveBlocksDismissalAndDuplicateSubmissions', "document.getElementById('profileIdentityEditor').open&&document.getElementById('profileSave').disabled&&document.getElementById('profileCancel').disabled&&profileFixture.profileWrites.length===1&&profileFixture.identity.name==='Relay 本地助手'");
  await act("profileFixture.mode='ready';profileFixture.emit();"); await waitFor("document.querySelector('[data-usage-metric=tokens]').textContent==='75,000'");
  await check('backgroundStatisticsContinueWithoutRebuildingTheOpenDialog', "document.getElementById('profileIdentityEditor').open&&document.getElementById('set-brandName').value==='保存后的本地助手'&&document.querySelector('.relay-usage-page')===profileFixture.usageNode&&profileFixture.activityMatches(30)");
  await act('profileFixture.releaseSave();'); await waitFor("!document.getElementById('profileIdentityEditor').open");
  await check('saveCommitsBothFieldsAndUpdatesProfileAndSidebarTogether', "profileFixture.identity.name==='保存后的本地助手'&&profileFixture.identity.logo===profileFixture.logo&&document.getElementById('profileName').textContent==='保存后的本地助手'&&document.getElementById('brandName').textContent==='保存后的本地助手'&&document.getElementById('profileLogo').src===profileFixture.logo&&profileFixture.profileWrites[0].logoAction==='replace'&&workspaceFixture.settingsWrites.length===0");
  await openEditor(); await click('#set-brandLogoReset');
  await check('resetAvatarIsAlsoOnlyAPreview', "document.getElementById('set-brandLogoPreview').classList.contains('relay-default-logo')&&profileFixture.identity.logo===profileFixture.logo&&document.getElementById('profileLogo').src===profileFixture.logo");
  await click('#profileCancel'); await openEditor(); await click('#set-brandLogoReset'); await click('#profileSave'); await waitFor("!document.getElementById('profileIdentityEditor').open");
  await check('savingTheDefaultAvatarUsesTheSameAtomicProfileAction', "profileFixture.identity.logo===null&&profileFixture.profileWrites.at(-1).logoAction==='default'&&profileFixture.legacyWrites===0");
  await openEditor(); await inputName('保存失败后重试'); await click('#set-brandLogoPick'); await act('profileFixture.failSave=true;'); await click('#profileSave');
  await waitFor("document.getElementById('profileEditorStatus').textContent.includes('合成资料保存失败')");
  await check('failedSavePreservesBothDraftFieldsAndThePreviousSavedIdentity', "document.getElementById('profileIdentityEditor').open&&!document.getElementById('profileSave').disabled&&document.getElementById('set-brandName').value==='保存失败后重试'&&document.getElementById('set-brandLogoPreview').src===profileFixture.logo&&profileFixture.identity.name==='保存后的本地助手'&&profileFixture.identity.logo===null");
  await act('profileFixture.failSave=false;'); await click('#profileSave'); await waitFor("!document.getElementById('profileIdentityEditor').open");
  await check('retrySavesTheRetainedNameAndAvatar', "profileFixture.identity.name==='保存失败后重试'&&profileFixture.identity.logo===profileFixture.logo&&profileFixture.profileWrites.at(-1).previewId===profileFixture.profileWrites.at(-2).previewId");
  await act('profileFixture.holdBrand=true;'); await click('#profileEdit'); await waitFor('profileFixture.pendingGets.length>0');
  await inputName('读取期间输入的新草稿'); await click('#set-brandLogoReset'); await act('profileFixture.releaseBrand();'); await waitFor("!document.getElementById('profileSave').disabled");
  await check('lateReadCannotOverwriteNameOrAvatarDrafts', "document.getElementById('set-brandName').value==='读取期间输入的新草稿'&&document.getElementById('set-brandLogoPreview').classList.contains('relay-default-logo')&&document.getElementById('profileLogo').src===profileFixture.logo");
  await act("const node=document.getElementById('set-brandName');node.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));node.value='中文'.repeat(16);node.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));profileFixture.compositionValue=node.value;profileFixture.beforeImeWrites=profileFixture.profileWrites.length;node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));node.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));");
  await check('imeCompositionIsNotTruncatedUntilCommitAndDoesNotSubmit', "profileFixture.compositionValue==='中文'.repeat(16)&&strWidth(document.getElementById('set-brandName').value)<=40&&document.getElementById('set-brandNameCount').textContent===strWidth(document.getElementById('set-brandName').value)+'/40'&&profileFixture.profileWrites.length===profileFixture.beforeImeWrites");
  await act("document.getElementById('profileSave').focus();"); await key('Tab');
  await check('nativeTabNavigationRemainsInsideTheDialog', "document.getElementById('profileIdentityEditor').contains(document.activeElement)&&document.activeElement.id!=='profileSave'");
  await key('Escape'); await waitFor("!document.getElementById('profileIdentityEditor').open");
  await check('escapeCancelsAndRestoresFocusWithoutSaving', "document.activeElement.id==='profileEdit'&&profileFixture.profileWrites.length===profileFixture.beforeImeWrites&&profileFixture.identity.name==='保存失败后重试'");
  await openEditor(); await inputName('遮罩取消的草稿');
  const outside = await evaluate("(()=>{const r=document.getElementById('profileIdentityEditor').getBoundingClientRect();return{x:Math.max(2,Math.round(r.left)-10),y:Math.round(r.top)+10}})()");
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...outside});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...outside});
  await waitFor("!document.getElementById('profileIdentityEditor').open");
  await check('backdropClickDiscardsTheDraftWithoutAWrite', 'profileFixture.profileWrites.length===profileFixture.beforeImeWrites');
  await openEditor(); await act('profileFixture.holdPick=true;'); await click('#set-brandLogoPick'); await waitFor('profileFixture.pendingPicks.length===1'); await click('#profileCancel'); await act('profileFixture.releasePick();'); await settle();
  await check('latePickerResultIsDiscardedAfterTheDialogCloses', "!document.getElementById('profileIdentityEditor').open&&profileFixture.preview===null&&profileFixture.profileWrites.length===profileFixture.beforeImeWrites");
  await act('profileFixture.failBrand=true;'); await click('#profileEdit'); await waitFor("document.getElementById('profileEditorStatus').textContent.includes('合成资料读取失败')");
  await check('failedReadDisablesSaveButLeavesCancelAndRetryAvailable', "document.getElementById('profileSave').disabled&&!document.getElementById('profileCancel').disabled&&!document.getElementById('profileEditorRetry').hidden");
  await inputName('读取重试也保留草稿'); await act('profileFixture.failBrand=false;'); await click('#profileEditorRetry'); await waitFor("!document.getElementById('profileSave').disabled");
  await check('readRetryRetainsAnAlreadyEditedName', "document.getElementById('set-brandName').value==='读取重试也保留草稿'"); await click('#profileCancel');
  await click('.set-nav-item[data-cat=general]'); await click('#btnSettingsSave'); await waitFor('!settingsSaveBusy&&workspaceFixture.settingsWrites.length===1');
  await check('ordinarySettingsSaveNeverWritesTheDialogIdentity', "profileFixture.profileWrites.length===profileFixture.beforeImeWrites&&profileFixture.legacyWrites===0&&!document.querySelector('.set-cat[data-cat=general] #set-brandName')");
  await evaluate("openSettings('usage')"); await check('legacyUsageAliasReturnsToTheSameProfileAndStatistics', "document.querySelector('.set-cat.active').dataset.cat==='profile'&&document.querySelector('.relay-usage-page')===profileFixture.usageNode&&profileFixture.listeners.size===1");
  await act("profileFixture.mode='hold';"); await click('[data-usage-refresh]'); await click('button[data-usage-days="7"]'); await click('button[data-usage-days="90"]');
  await act('profileFixture.resolve(90,profileFixture.snapshot(90));'); await waitFor("document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='90'");
  await act('profileFixture.resolve(7,profileFixture.snapshot(7));profileFixture.resolve(30,profileFixture.snapshot(30,{totals:{messages:99999}}));'); await settle();
  await check('statisticsStillRejectOutOfOrderRanges', "profileFixture.activityMatches(90)&&document.querySelector('[data-usage-metric=messages]').textContent===String(profileFixture.snapshot(90).totals.messages)&&document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='90'");
  await act("profileFixture.mode='ready';profileFixture.overrides[7]=profileFixture.snapshot(7,{tokens:{available:false,coverage:'unavailable',byModel:[]}});"); await click('button[data-usage-days="7"]'); await waitFor("document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='7'");
  await check('unknownTokensStayUnknownWithRealDailyConversationCounts', "profileFixture.activityMatches(7)&&document.querySelector('[data-usage-metric=tokens]').textContent==='—'");
  win.setSize(780,720); await waitFor('innerWidth<=780'); await act("document.documentElement.dataset.theme='dark';"); await openEditor();
  await check('darkNarrowDialogAndItsActionsFitInsideTheViewport', "(()=>{const d=document.getElementById('profileIdentityEditor'),r=d.getBoundingClientRect(),b=document.getElementById('profileSave').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&b.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth})()");
  await screenshot('profile-dialog-dark-narrow'); await click('#profileCancel');
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await openEditor();
  await check('reducedMotionRemovesDialogEntranceAnimation', "matchMedia('(prefers-reduced-motion: reduce)').matches&&!document.getAnimations().some(animation=>animation.effect?.target?.closest('#profileIdentityEditor')&&animation.playState==='running')");await click('#profileCancel');win.webContents.debugger.detach();
  await check('rendererStayedSandboxedAndAllIdentityWritesUsedTheNewApi', "uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'&&profileFixture.legacyWrites===0&&inputEl.value==='个人资料验收保留的对话草稿'");
  diagnostics.calls=await evaluate('({profiles:profileFixture.profileWrites,previewPicks:profileFixture.previewPicks,discarded:profileFixture.discarded,statistics:profileFixture.calls})');
  win.setSize(1200,920);await waitFor('innerWidth>1100');await act("profileFixture.identity={name:'Relay',logo:null,nameMax:40,revision:'preview'};document.documentElement.dataset.theme='light';");await evaluate('applyBrand()');await click('button[data-usage-days="30"]');await waitFor("document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='30'");await openEditor();await screenshot('profile-editor');await click('#profileCancel');await screenshot('profile-overview');
  step='completed';save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{failures.push(String(error.stack||error));try{if(win&&!win.isDestroyed()){await screenshot('failure');diagnostics.rendererErrors=await evaluate('uiFixture.errors');}}catch(_){}save();console.error(error.stack);clearTimeout(deadline);app.exit(1);});
