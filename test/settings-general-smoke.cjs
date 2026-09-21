'use strict';

// Real renderer and DOM, isolated profile, synthetic settings and OS-startup API.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'settings-retirement-general');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, failures = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, failures }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout at ' + step); save(); app.exit(1); }, 90000);
const evaluate = source => win.webContents.executeJavaScript(source);
const act = source => evaluate(`(() => { ${source}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() {
  await evaluate("document.getAnimations().forEach(animation=>{if(animation.effect?.getComputedTiming().iterations!==Infinity)try{animation.finish()}catch(_){}});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
}
async function waitFor(source) {
  await evaluate(`new Promise((resolve,reject)=>{const until=Date.now()+6000;function check(){if(${source})return resolve();if(Date.now()>until)return reject(Error(${JSON.stringify(source)}));setTimeout(check,20)}check()})`);
}
async function check(name, source) {
  step = name; checks[name] = !!await evaluate(source); save(); console.log(name + ': ' + checks[name]);
  if (!checks[name]) throw Error(name);
}
async function click(selector) {
  const category = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.closest('.set-cat')?.dataset.cat`);
  if (category) await evaluate(`openSettings(${JSON.stringify(category)})`);
  await act(`const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click();`);
  await settle();
}
async function capture(name) {
  await settle(); await delay(70);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function installFixture() {
  const base = window.api, copy = value => JSON.parse(JSON.stringify(value));
  const state = window.generalFixture = {
    writes: [], reads: 0, mode: 'ok', readMode: 'ok', releaseSave: null, autoLaunch: false, autoWrites: [], failAuto: false,
    saved: { app: { theme: 'light', conversationIndex: true, allowCommandTasks: false, miniInputEnabled: false,
      floatingOrbEnabled: true, permissionMode: 'default', unrelatedValue: 'retained' },
    claude: { alwaysThinking: true, defaultModel: 'opus', routes: copy(uiFixture.routes) }, info: { uiVersion: '2.1.0' } },
  };
  const settings = {
    read: async () => { state.reads++; if (state.readMode === 'fail') throw Error('合成设置读取失败'); return copy(state.saved); },
    write: async value => {
      const payload = copy(value); state.writes.push(payload);
      if (state.mode === 'fail') return { ok: false, message: '合成设置保存失败' };
      const commit = () => {
        state.saved.app = { ...state.saved.app, ...payload.app };
        state.saved.claude = { ...state.saved.claude, ...payload.claude };
        if (payload.claude?.defaultModel) state.saved.claude.routes.defaultModel = payload.claude.defaultModel;
        return { ok: true, routes: copy(state.saved.claude.routes) };
      };
      if (state.mode === 'hold') return new Promise(resolve => { state.releaseSave = () => { state.releaseSave = null; resolve(commit()); }; });
      return commit();
    },
  };
  const scheduler = new Proxy(base.scheduler, { get(target, key) {
    if (key === 'getAutoLaunch') return async () => ({ enabled: state.autoLaunch });
    if (key === 'setAutoLaunch') return async enabled => { state.autoWrites.push(enabled); if (state.failAuto) throw Error('合成自启失败'); state.autoLaunch = enabled; return { ok: true, enabled }; };
    return target[key];
  } });
  const mini = new Proxy(base.mini, { get(target, key) { return key === 'brand' ? async () => ({ enabled: false, shortcut: null }) : target[key]; } });
  window.api = new Proxy(base, { get(target, key) { return key === 'settings' ? settings : key === 'scheduler' ? scheduler : key === 'mini' ? mini : target[key]; } });
  state.visible = selector => {
    const node = document.querySelector(selector);
    return !!node && !!node.getClientRects().length && !node.closest('[hidden],[inert],.hidden') && getComputedStyle(node).display !== 'none';
  };
  state.groups = { general: ['set-theme','sw-conversationIndex','sw-autoLaunch','sw-quickChat'], conversation: ['behaviorDefaultModel','sw-allowCommand'] };
  state.controls = Object.values(state.groups).flat();
  state.general = () => document.querySelector('.set-cat[data-cat=general]');
  state.sameControls = () => state.controls.every(id => document.getElementById(id) === state.nodes[id]);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(root, 'test', name), 'utf8')).join('\n') + `\n(${installFixture.toString()})();\nlocalStorage.clear();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}</script>`);
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page); await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  await evaluate("openSettings('general')"); await waitFor('settingsFormLoaded&&generalFixture.general()?.classList.contains("active")');
  await check('generalReplacesBothOldMenusAndSectionsWithOneMonochromeEntry', "document.querySelectorAll('.set-nav-item[data-cat=general]').length===1&&document.querySelectorAll('.set-cat[data-cat=general]').length===1&&!document.querySelector('[data-cat=personalize],[data-cat=behavior]')&&document.querySelector('.set-nav-item[data-cat=general]').textContent.trim()==='常规'&&document.querySelector('.set-nav-item[data-cat=general] svg').getAttribute('stroke')==='currentColor'");
  await check('originalControlsAreSeparatedByPurposeWithoutDuplicatedIds', "Object.entries(generalFixture.groups).every(([category,ids])=>ids.every(id=>document.getElementById(id)?.closest('.set-cat').dataset.cat===category&&document.querySelectorAll('[id=\"'+id+'\"]').length===1))&&!generalFixture.general().querySelector('[data-general-row],[data-sdk-preference]')&&['general','conversation','workspace'].every(cat=>document.querySelector('.set-nav-item[data-cat='+cat+'] svg'))&&!document.querySelector('.set-nav-item[data-cat=advanced]')");
  await check('generalRetainsBatchSaveAndPersonalProfileStaysSeparate', "generalFixture.visible('#btnSettingsSave')&&generalFixture.visible('#btnSettingsCancel')&&!generalFixture.general().querySelector('#profilePage,#usageSection,#set-brandName')&&document.querySelector('.set-nav-item').dataset.cat==='profile'");
  await check('inactiveThinkingControlIsRemovedAndQuickChatHasOneSwitch', "!document.getElementById('sw-alwaysThinking')&&!document.getElementById('sw-miniInput')&&!document.getElementById('sw-floatingOrb')&&document.getElementById('sw-quickChat').classList.contains('on')");
  await capture('general-light');
  await act("generalFixture.nodes=Object.fromEntries(generalFixture.controls.map(id=>[id,document.getElementById(id)]));inputEl.value='常规设置验收保留的对话草稿';");
  await click('#set-theme [data-value=dark]');
  await click('#behaviorDefaultModel [data-value=haiku]');
  for (const id of ['sw-conversationIndex','sw-quickChat','sw-allowCommand']) await click('#' + id);
  await check('themePreviewsWhileAppearanceAndBehaviorChangesRemainDrafts', "document.documentElement.dataset.theme==='dark'&&generalFixture.saved.app.theme==='light'&&generalFixture.saved.claude.alwaysThinking===true&&generalFixture.writes.length===0&&document.getElementById('settingsHint').textContent.includes('未保存')");
  await click('.set-nav-item[data-cat=shortcuts]');
  await waitFor("document.querySelector('[data-shortcut-global=miniWindow]')?.dataset.shortcutState==='disabled'");
  await check('shortcutHelpPointsToGeneral', "document.querySelector('[data-shortcut-global=miniWindow]').textContent.includes('设置 → 常规')&&!document.querySelector('[data-shortcut-global=miniWindow]').textContent.includes('设置 → 行为')");
  for (const alias of ['personalize','behavior']) {
    await evaluate(`openSettings(${JSON.stringify(alias)})`);
    await check('legacyOpenSettingsAlias_' + alias, "generalFixture.general().classList.contains('active')&&lastSettingsCat==='general'&&generalFixture.sameControls()&&document.getElementById('set-theme').dataset.value==='dark'&&!document.getElementById('sw-quickChat').classList.contains('on')&&generalFixture.writes.length===0");
  }
  await act("showAppView('chat');"); await evaluate('openSettings()');
  await check('mainPageRoundTripPreservesAllDraftNodesAndConversationInput', "generalFixture.sameControls()&&generalFixture.general().classList.contains('active')&&inputEl.value==='常规设置验收保留的对话草稿'&&generalFixture.writes.length===0");
  win.setSize(1200,620); await delay(100); await settle();
  await act("document.getElementById('setContent').scrollTop=160;generalFixture.scrollTop=document.getElementById('setContent').scrollTop;");
  await check('generalUsesItsOwnContentAreaWithoutHorizontalOverflow', 'document.getElementById("setContent").scrollWidth<=document.getElementById("setContent").clientWidth+1');
  await click('.set-nav-item[data-cat=shortcuts]'); await evaluate("openSettings('behavior')");
  await check('legacyAliasRestoresGeneralScrollPosition', 'Math.abs(document.getElementById("setContent").scrollTop-generalFixture.scrollTop)<=1&&generalFixture.sameControls()');
  await act("preserveSettingsView();modalBody.innerHTML='<div>合成详情内容</div>';restoreSettingsView();"); await settle();
  await check('detailRoundTripRestoresTheCombinedFormAndSaveHandler', 'generalFixture.sameControls()&&activeSaveHandler===saveMainSettings&&generalFixture.visible("#btnSettingsSave")&&Math.abs(document.getElementById("setContent").scrollTop-generalFixture.scrollTop)<=1');
  await click('#btnSettingsSave'); await waitFor('!settingsSaveBusy&&generalFixture.writes.length===1');
  await check('saveWritesAppearanceAndBehaviorInTheSameConfirmedRequest', "(()=>{const payload=generalFixture.writes[0];return payload.app.theme==='dark'&&payload.app.conversationIndex===false&&payload.app.quickChatEnabled===false&&!('miniInputEnabled' in payload.app)&&!('floatingOrbEnabled' in payload.app)&&payload.app.allowCommandTasks===true&&!('alwaysThinking' in payload.claude)&&generalFixture.saved.claude.alwaysThinking===true&&payload.claude.defaultModel==='haiku'&&generalFixture.saved.app.theme==='dark'&&generalFixture.saved.claude.defaultModel==='haiku'&&generalFixture.saved.app.unrelatedValue==='retained'&&!('autoLaunch' in payload.app)&&!('permissionMode' in payload.app)&&workspaceFixture.brandWrites.length===0;})()");
  await click('#btnSettingsSave'); await waitFor('!settingsSaveBusy&&generalFixture.writes.length===2');
  await check('unchangedDefaultModelIsNotRewrittenByOrdinarySave', '!Object.prototype.hasOwnProperty.call(generalFixture.writes[1].claude,"defaultModel")');
  await click('#sw-autoLaunch'); await waitFor('generalFixture.autoWrites.length===1');
  await check('startupRemainsAnImmediateOsPreferenceOutsideBatchSave', 'generalFixture.autoLaunch&&generalFixture.writes.length===2&&document.getElementById("sw-autoLaunch").classList.contains("on")');
  await act('generalFixture.failAuto=true;'); await click('#sw-autoLaunch');
  await check('startupFailureRestoresItsPreviousState', 'generalFixture.autoLaunch&&document.getElementById("sw-autoLaunch").classList.contains("on")&&generalFixture.writes.length===2');
  await act('generalFixture.failAuto=false;');
  await click('#set-theme [data-value=light]'); await click('#sw-quickChat');
  await act('generalFixture.mode="fail";generalFixture.beforeFailedSave=JSON.stringify(generalFixture.saved);');
  await click('#btnSettingsSave'); await waitFor('!settingsSaveBusy&&document.getElementById("settingsHint").textContent.includes("合成设置保存失败")');
  await check('saveFailureRetainsAppearanceBehaviorDraftsAndPriorSavedValues', 'JSON.stringify(generalFixture.saved)===generalFixture.beforeFailedSave&&document.getElementById("set-theme").dataset.value==="light"&&document.getElementById("sw-quickChat").classList.contains("on")&&generalFixture.sameControls()&&!document.getElementById("btnSettingsSave").disabled');
  await act('generalFixture.mode="hold";'); await click('#btnSettingsSave'); await waitFor('!!generalFixture.releaseSave');
  await click('#sw-conversationIndex');
  await act('showAppView("chat");'); await evaluate('openSettings("general")');
  await check('pendingSavePreservesFormAndNewerEditsAcrossNavigation', 'generalFixture.sameControls()&&settingsSaveBusy&&document.getElementById("btnSettingsSave").disabled&&document.getElementById("sw-conversationIndex").classList.contains("on")');
  await act('generalFixture.releaseSave();'); await waitFor('!settingsSaveBusy');
  await check('confirmedSaveDoesNotClaimNewerDraftWasSaved', 'generalFixture.saved.app.theme==="light"&&generalFixture.saved.app.quickChatEnabled===true&&generalFixture.saved.app.conversationIndex===false&&document.getElementById("sw-conversationIndex").classList.contains("on")&&document.getElementById("settingsHint").textContent.includes("未保存")');
  await act('generalFixture.mode="ok";'); await click('#btnSettingsSave'); await waitFor('!settingsSaveBusy');
  await check('retryAndLaterSavePersistTheRetainedChanges', 'generalFixture.saved.app.conversationIndex===true&&generalFixture.saved.app.theme==="light"');
  await click('#set-theme [data-value=dark]'); await click('#sw-allowCommand');
  await evaluate("openSettings('general')"); await click('#btnSettingsCancel'); await waitFor('settingsFormLoaded&&document.getElementById("set-theme").dataset.value==="light"');
  await check('cancelRestoresBothGroupsButKeepsImmediateStartupChoice', 'document.documentElement.dataset.theme==="light"&&document.getElementById("sw-allowCommand").classList.contains("on")&&document.getElementById("sw-autoLaunch").classList.contains("on")&&lastSettingsCat==="general"');
  for (const alias of ['personalize','behavior']) {
    await act(`lastSettingsCat=${JSON.stringify(alias)};`); await evaluate('loadSettingsForm()');
    await check('legacyRememberedCategoryNormalizesOnReload_' + alias, 'lastSettingsCat==="general"&&generalFixture.general().classList.contains("active")');
  }
  await act('generalFixture.readMode="fail";'); await evaluate('loadSettingsForm("behavior")');
  await check('failedSettingsReadProvidesRetryWithoutBrokenLegacyCategory', 'generalFixture.visible("#settingsLoadRetry")&&!generalFixture.visible("#btnSettingsSave")');
  await act('generalFixture.readMode="ok";'); await click('#settingsLoadRetry'); await waitFor('settingsFormLoaded&&generalFixture.general()?.classList.contains("active")');
  await check('retryRestoresCanonicalPages', 'lastSettingsCat==="general"&&Object.entries(generalFixture.groups).every(([category,ids])=>ids.every(id=>document.getElementById(id)?.closest(".set-cat").dataset.cat===category))');
  for (const [width,height,theme] of [[1200,800,'light'],[900,620,'dark'],[620,700,'dark'],[780,560,'light']]) {
    win.setSize(width,height); await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`); await delay(120); await settle();
    await act('document.getElementById("setContent").scrollTop=document.getElementById("setContent").scrollHeight;');
    await check('generalFitsWindow_' + width + '_' + height, '(()=>{const area=document.getElementById("setContent"),save=document.getElementById("btnSettingsSave").getBoundingClientRect(),last=document.getElementById("sw-quickChat").getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&area.scrollWidth<=area.clientWidth+1&&save.bottom<=innerHeight&&last.bottom<=area.getBoundingClientRect().bottom+1&&[...generalFixture.general().querySelectorAll(".settings-segmented")].every(node=>node.getBoundingClientRect().right<=area.getBoundingClientRect().right+1);})()');
    if (width===900) await capture('general-dark');
    if (width===620) await capture('general-narrow');
  }
  await check('noUnrelatedProfileProviderModelOrNativeWorkWasPerformed', 'workspaceFixture.brandWrites.length===0&&workspaceFixture.providerWrites.length===0&&!uiFixture.calls.includes("runClaude")&&!uiFixture.calls.includes("workspace.terminalStart")&&uiFixture.errors.length===0&&typeof require==="undefined"&&inputEl.value==="常规设置验收保留的对话草稿"');
  step='completed';save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error => {
  failures.push(error.stack || String(error)); console.error(error.stack || error);
  if(win&&!win.isDestroyed()){try{console.error(await evaluate('JSON.stringify(uiFixture.errors)'));await capture('failure');}catch(_){}}
  save();clearTimeout(deadline);app.exit(1);
});
