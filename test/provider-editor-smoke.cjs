'use strict';
// Actual renderer with isolated provider records and synthetic probe promises.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'provider-editor-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, errors = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors, step }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
async function settle() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); }
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)};tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name); if (!checks[name]) { console.log(await evaluate('JSON.stringify({status:document.getElementById("providerEditorStatus")?.textContent,lastDraft:providerProbeFixture.draftCalls.at(-1),lastDiscovery:providerProbeFixture.discoveries.at(-1),images:document.getElementById("providerImageCapabilities")?.textContent})')); throw Error(name); } }
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); }
async function fill(selector, value) { await act(`const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));`); await settle(); }
async function capture(name) {
  await settle(); await evaluate('document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}})');
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function providerFixture() {
  const base = window.api, listeners = new Set();
  const clone = value => JSON.parse(JSON.stringify(value));
  const f = window.providerProbeFixture = {
    profile: { id: 'fixture', name: '合成服务商', revision: 1, baseUrl: 'https://saved.invalid/anthropic',
      hasCredential: true, credentialHint: '已保存', enabled: true, chatReady: true, chatModelCount: 3,
      activeTiers: ['haiku', 'sonnet', 'opus'], activeImageAdapters: [], imageModels: [], routed: true,
      models: { haiku: 'saved/fast', sonnet: 'saved/medium', opus: 'saved/expert' }, defaultModel: 'opus' },
    savedCalls: [], draftCalls: [], discoveries: [], writes: [], holdSaved: false, holdDraft: false,
    releaseSaved: null, releaseDraft: null, failDraft: false, draftAuthMode: 'api-key',
    catalogScenario: null, catalogPending: [], imageRouteWrites: [], failUpdate: false,
    changed(extraProfiles = []) { const payload = { profiles: [clone(this.profile), ...clone(extraProfiles)], routes: clone(uiFixture.routes) }; for (const callback of listeners) callback(payload); },
  };
  const discover = async request => {
    f.discoveries.push(clone(request));
    if (!f.catalogScenario) return { ok: true, models: [request.saved ? 'saved/fast' : 'draft/fast'], imageModels: [],
      profile: request.saved ? clone(f.profile) : undefined, message: '合成目录已读取' };
    const plan = clone(request.saved ? f.catalogScenario.saved : f.catalogScenario.drafts[request.draft.apiKey] || f.catalogScenario.fallback);
    const imageModels = [{ adapterId: 'gpt-image-2', remoteModelId: plan.label + '/gpt-image-2' }];
    if (plan.rotateAuth && !f.catalogAuthChanged) {
      f.catalogAuthChanged = true;
      f.profile = { ...f.profile, revision: f.profile.revision + 1, authMode: 'auth-token' };
      f.changed();
    }
    const response = plan.fail ? { ok: false, models: [], imageModels: [], message: '合成目录刷新失败' }
      : { ok: true, models: [plan.label + '/chat', plan.label + '/gpt-image-2'], imageModels,
        profile: request.saved ? { ...clone(f.profile), imageModels, imageDiscovery: { status: 'ready' } } : undefined,
        catalogSource: 'gateway-root', gatewayRootFallbackUsed: true, message: '合成共享模型目录已读取' };
    if (!plan.hold) return response;
    return new Promise(resolve => f.catalogPending.push({ request: clone(request), label: plan.label, release: () => resolve(response) }));
  };
  const providers = {
    list: async () => ({ ok: true, profiles: [clone(f.profile)], routes: clone(uiFixture.routes) }),
    onChanged(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    test: async id => {
      f.savedCalls.push(id); const profile = clone(f.profile);
      const result = { ok: true, authMode: 'api-key', latencyMs: 12, profile, scope: 'saved', model: profile.models[uiFixture.routes.defaultModel] };
      return f.holdSaved ? new Promise(resolve => { f.releaseSaved = () => { f.releaseSaved = null; resolve(result); }; }) : result;
    },
    testDraft: async draft => {
      f.draftCalls.push(clone(draft));
      const preferred = draft.tier || uiFixture.routes.defaultModel;
      const tier = draft.models[preferred] ? preferred : Object.keys(draft.models).find(key => draft.models[key]);
      const result = f.failDraft ? { ok: false, scope: 'draft', message: '合成连接错误' }
        : { ok: true, scope: 'draft', tier, model: draft.models[tier], latencyMs: 7, authMode: f.draftAuthMode };
      return f.holdDraft ? new Promise(resolve => { f.releaseDraft = () => { f.releaseDraft = null; resolve(result); }; }) : result;
    },
    discoverModels: async id => discover({ saved: id }),
    discoverDraftModels: async draft => discover({ draft: clone(draft) }),
    update: async (id, input) => {
      f.writes.push({ id, input: clone(input) });
      if (f.failUpdate) return { ok: false, message: '合成保存失败' };
      f.profile = { ...f.profile, name: input.name, baseUrl: input.baseUrl, models: clone(input.models), revision: f.profile.revision + 1 };
      f.changed(); return { ok: true, profile: clone(f.profile) };
    },
    create: async input => { f.writes.push({ input: clone(input) }); return { ok: true }; },
    setImageRoute: async (...args) => { f.imageRouteWrites.push(clone(args)); return { ok: true }; },
  };
  const settings = {
    read: () => base.settings.read(),
    write: async value => {
      const result = await base.settings.write(value);
      if (result?.ok && Object.hasOwn(value.claude || {}, 'defaultModel')) {
        uiFixture.routes.defaultModel = value.claude.defaultModel;
        f.changed();
      }
      return result?.ok ? { ...result, routes: clone(uiFixture.routes) } : result;
    },
  };
  window.api = new Proxy(base, { get(target, key) { return key === 'providers' ? providers : key === 'settings' ? settings : target[key]; } });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const base = pathToFileURL(path.join(root, 'renderer') + path.sep).href;
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + base + '"><script>' + fixture + '\n(' + providerFixture.toString() + ')();localStorage.clear();</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive();
  await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  await evaluate("openSettings('providers')");
  await waitFor("!!document.querySelector('[data-provider-act=test]')");
  await act("Object.assign(uiFixture.routes.chatRoutes.find(route=>route.tier==='haiku'),{configured:false,available:false});providerProbeFixture.changed();");
  await evaluate("openSettings('conversation')");
  await waitFor("!!document.querySelector('#behaviorDefaultModel [data-value=haiku]')");
  await check('behaviorPageShowsTheSingleGlobalDefaultTier', "document.querySelectorAll('#behaviorDefaultModel').length===1&&behaviorDefaultModel.closest('[data-cat=conversation]')&&behaviorDefaultModel.dataset.value==='opus'&&behaviorDefaultModel.textContent.includes('快速')&&behaviorDefaultModel.textContent.includes('思考')&&behaviorDefaultModel.textContent.includes('专家')");
  await click('#behaviorDefaultModel [data-value=haiku]');
  await check('unconfiguredDefaultTierIsDisabledAndCannotBeSelected', "document.querySelector('#behaviorDefaultModel [data-value=haiku]').disabled&&document.querySelector('#behaviorDefaultModel [data-value=haiku]').getAttribute('aria-disabled')==='true'&&behaviorDefaultModel.dataset.value==='opus'&&workspaceFixture.settingsWrites.length===0");
  await click('#behaviorDefaultModel [data-value=sonnet]');
  await act('providerProbeFixture.changed();'); await settle();
  await check('defaultTierDraftSurvivesProviderRefreshWithoutSavingEarly', "behaviorDefaultModel.dataset.value==='sonnet'&&uiFixture.routes.defaultModel==='opus'&&workspaceFixture.savedSettings().claude.defaultModel==='opus'&&workspaceFixture.settingsWrites.length===0");
  await capture('behavior-global-default-draft');
  await click('#btnSettingsSave');
  await waitFor("!settingsSaveBusy&&workspaceFixture.settingsWrites.length===1&&uiFixture.routes.defaultModel==='sonnet'");
  await check('behaviorSaveCommitsOneGlobalDefaultAndLeavesProviderPreferencesAlone', "workspaceFixture.settingsWrites[0].claude.defaultModel==='sonnet'&&workspaceFixture.savedSettings().claude.defaultModel==='sonnet'&&defaultModel==='sonnet'&&providerProbeFixture.profile.defaultModel==='opus'&&providerProbeFixture.writes.length===0");
  await click('#sw-allowCommand'); await click('#btnSettingsSave');
  await waitFor('!settingsSaveBusy&&workspaceFixture.settingsWrites.length===2');
  await check('savingOtherBehaviorOptionsDoesNotRewriteTheDefaultTier', "!Object.hasOwn(workspaceFixture.settingsWrites[1].claude,'defaultModel')&&workspaceFixture.savedSettings().claude.defaultModel==='sonnet'");
  await click('#behaviorDefaultModel [data-value=opus]'); await click('#btnSettingsCancel');
  await evaluate("openSettings('conversation')"); await waitFor("behaviorDefaultModel.dataset.value==='sonnet'");
  await check('cancelDiscardsAnUnsavedDefaultTier', "workspaceFixture.settingsWrites.length===2&&workspaceFixture.savedSettings().claude.defaultModel==='sonnet'&&defaultModel==='sonnet'");
  await act("currentModel='opus';updateModelSwitchUI();"); await click('#btnNewChat');
  await check('newOrdinaryChatUsesSavedGlobalDefaultInsteadOfPreviousTier', "activeView==='chat'&&currentConv===null&&currentMode==='plain'&&currentModel==='sonnet'&&chatTitle.textContent==='新对话'");
  await evaluate("openSettings('providers')");
  await waitFor("!!document.querySelector('[data-provider-act=test]')");
  await click('[data-provider-act=test]');
  await waitFor("!!providerHealth.get('fixture')?.ok");
  await check('savedProbeCachesOnlyItsSavedProfileVersion', "providerProbeFixture.savedCalls.length===1&&providerHealth.get('fixture').profileKey===providerHealthProfileKey(providerProbeFixture.profile)&&document.querySelector('.provider-health').textContent.includes('12 ms')");
  await click('[data-provider-act=edit]');
  await waitFor("!!document.getElementById('providerEditorTest')&&!document.getElementById('providerDiscover').disabled");
  await check('providerEditorHasNoSeparateDefaultTierControl', "!document.getElementById('providerDefaultModel')&&!document.querySelector('.provider-editor').textContent.includes('默认使用')");
  await fill('#providerBaseUrl', 'https://draft.invalid/anthropic');
  await fill('#providerApiKey', 'synthetic-draft-key');
  await fill('#providerModelSonnet', 'draft/new-medium');
  await click('#providerEditorTest');
  await waitFor("providerProbeFixture.draftCalls.length===1&&!document.getElementById('providerEditorTest').disabled");
  await check('editorTestsCurrentUnsavedConnectionWithTheGlobalPreferredTier', "(()=>{const x=providerProbeFixture.draftCalls[0];return x.id==='fixture'&&x.baseUrl==='https://draft.invalid/anthropic'&&x.apiKey==='synthetic-draft-key'&&x.models.sonnet==='draft/new-medium'&&x.tier==='sonnet'&&!Object.hasOwn(x,'defaultModel')&&providerProbeFixture.savedCalls.length===1})()");
  await check('draftSuccessDoesNotWriteConfigOrReplaceSavedHealth', "providerProbeFixture.writes.length===0&&providerProbeFixture.profile.baseUrl==='https://saved.invalid/anthropic'&&providerHealth.get('fixture').latencyMs===12&&providerEditorStatus.textContent.includes('尚未保存')&&providerEditorStatus.textContent.includes('思考')");
  await capture('draft-probe-current-values');
  await fill('#providerApiKey', '');
  await click('#providerEditorTest');
  await check('blankEditedKeyIsSentAsKeepSavedCredential', "providerProbeFixture.draftCalls.at(-1).apiKey===''&&providerProbeFixture.draftCalls.at(-1).id==='fixture'");
  await fill('#providerModelOpus', 'draft/changed-expert');
  await check('editingClearsDraftResultImmediately', "document.querySelector('.provider-test-state').textContent.includes('待检测')&&providerEditorStatus.textContent.includes('重新检测')");
  await act('providerProbeFixture.holdDraft=true;'); await click('#providerEditorTest');
  await waitFor('!!providerProbeFixture.releaseDraft');
  await fill('#providerModelSonnet', 'draft/newest-medium');
  await act('providerProbeFixture.releaseDraft();providerProbeFixture.holdDraft=false;'); await settle();
  await check('lateDraftSuccessCannotOverwriteNewerEditorValues', "providerEditorStatus.textContent.includes('重新检测')&&!document.querySelector('.provider-test-state .is-ok')&&!providerEditorTest.disabled&&providerProbeFixture.writes.length===0");
  await act('providerProbeFixture.failDraft=true;'); await click('#providerEditorTest');
  await check('draftProbeFailureRestoresControlsAndKeepsForm', "providerEditorStatus.textContent.includes('合成连接错误')&&!providerEditorTest.disabled&&providerModelSonnet.value==='draft/newest-medium'");
  await act('providerProbeFixture.failDraft=false;providerProbeFixture.profile.revision++;providerProbeFixture.changed();'); await settle();
  await check('externalSavedChangeInvalidatesHealthWithoutDiscardingDraft', "!providerHealth.has('fixture')&&providerModelSonnet.value==='draft/newest-medium'&&document.querySelector('.provider-test-state').textContent.includes('待检测')");
  await click('#providerEditorBack'); await waitFor("!!document.querySelector('[data-provider-act=test]')");
  await act('providerProbeFixture.holdSaved=true;'); await click('[data-provider-act=test]');
  await waitFor('!!providerProbeFixture.releaseSaved');
  await act('providerProbeFixture.profile.revision++;providerProbeFixture.changed();providerProbeFixture.releaseSaved();providerProbeFixture.holdSaved=false;'); await settle();
  await check('lateSavedProbeCannotRepopulateInvalidatedHealth', "!providerHealth.has('fixture')&&!document.querySelector('.provider-health.is-ok')");
  await click('[data-provider-act=test]'); await waitFor("!!providerHealth.get('fixture')?.ok");
  await click('[data-provider-act=edit]'); await waitFor("!!document.getElementById('providerModelOpus')");
  await fill('#providerModelOpus', 'draft/after-save');
  await act("providerProbeFixture.draftAuthMode='auth-token';");
  await click('#providerEditorTest');
  await check('bearerDiscoveryWaitsForExplicitSave', "providerProbeFixture.writes.length===0&&providerEditorStatus.textContent.includes('Bearer')");
  await click('#providerEditorSave'); await waitFor("providerProbeFixture.writes.length===1&&!!document.querySelector('[data-provider-act=edit]')");
  await check('successfulSaveClearsPreviousHealthProof', "!providerHealth.has('fixture')&&providerProbeFixture.profile.models.opus==='draft/after-save'");
  await check('explicitSaveIncludesDetectedAuthForTheUnchangedTestedDraft', "providerProbeFixture.writes[0].input.authMode==='auth-token'&&providerProbeFixture.writes[0].input.apiKey===''");
  await check('providerSaveNeverOverwritesGlobalDefaultTier', "!Object.hasOwn(providerProbeFixture.writes[0].input,'defaultModel')&&uiFixture.routes.defaultModel==='sonnet'&&workspaceFixture.savedSettings().claude.defaultModel==='sonnet'");
  await click('#providerAdd'); await waitFor("!!document.getElementById('providerEditorTest')");
  await check('newProviderCanBeTestedBeforeSaveButNeedsFields', 'providerEditorTest.disabled');
  await fill('#providerBaseUrl', 'https://new.invalid'); await fill('#providerApiKey', 'synthetic-new');
  await fill('#providerModelHaiku', 'new/fast'); await click('#providerEditorTest');
  await check('newProviderDraftTestDoesNotCreateProfile', "providerProbeFixture.draftCalls.at(-1).id===''&&providerProbeFixture.draftCalls.at(-1).models.haiku==='new/fast'&&providerProbeFixture.writes.length===1");
  await check('draftProbeFallsBackToItsFilledTierWithoutChangingGlobalDefault', "providerProbeFixture.draftCalls.at(-1).tier==='sonnet'&&!Object.hasOwn(providerProbeFixture.draftCalls.at(-1),'defaultModel')&&providerEditorStatus.textContent.includes('快速')&&uiFixture.routes.defaultModel==='sonnet'");
  await fill('#providerName', '新合成服务商');
  await fill('#providerApiKey', 'synthetic-changed-after-probe');
  await click('#providerEditorSave'); await waitFor('providerProbeFixture.writes.length===2');
  await check('editedCredentialsCannotSaveAnEarlierDetectedAuthMode', "!Object.hasOwn(providerProbeFixture.writes[1].input,'authMode')");
  await waitFor("!!document.querySelector('#providerAdd')"); await click('#providerAdd');
  await fill('#providerName', '新 Bearer 服务商'); await fill('#providerBaseUrl', 'https://new-bearer.invalid');
  await fill('#providerApiKey', 'synthetic-bearer-plain-key'); await fill('#providerModelHaiku', 'new/bearer');
  await click('#providerEditorTest'); await click('#providerEditorSave'); await waitFor('providerProbeFixture.writes.length===3');
  await check('newProviderExplicitCreateReceivesVerifiedBearerMode', "providerProbeFixture.writes[2].input.authMode==='auth-token'&&providerProbeFixture.writes[2].input.apiKey==='synthetic-bearer-plain-key'");
  await check('providerCreatesHaveNoDefaultTierSideEffects', "providerProbeFixture.writes.every(write=>!Object.hasOwn(write.input,'defaultModel'))&&workspaceFixture.savedSettings().claude.defaultModel==='sonnet'");
  // Model catalog discovery has its own request lifetime, separate from a
  // conversation probe. Every response and credential below is synthetic.
  await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act(`
    const f=providerProbeFixture;f.discoveries=[];f.catalogPending=[];f.imageRouteWrites=[];
    f.catalogWritesBefore=f.writes.length;f.catalogProbeCallsBefore=f.savedCalls.length+f.draftCalls.length;
    f.catalogScenario={saved:{label:'directory-saved'},drafts:{'':{label:'directory-blank'},'synthetic-key-a':{label:'directory-a'},'synthetic-key-b':{label:'directory-b'}},fallback:{label:'directory-other'}};
    f.profile.imageModels=[];f.profile.activeImageAdapters=[];providerModelCatalog.delete(f.profile.id);f.changed();
    window.openCatalog=()=>{closeProviderModelPickers();document.querySelector('#providerModelSonnet').closest('[data-provider-model-picker]').querySelector('.provider-model-toggle').click();};
    window.catalogHas=prefix=>Array.from(document.querySelectorAll('#providerModelSonnetOptions [data-model]')).some(el=>el.dataset.model.startsWith(prefix+'/'));
  `);
  await click('[data-provider-act=edit]');
  await waitFor("providerProbeFixture.discoveries.some(x=>x.saved==='fixture')&&!providerDiscover.disabled");
  await act('openCatalog();');
  await check('savedCatalogDiscoveryUsesProfileIdAndShowsUnverifiedDirectory', "providerProbeFixture.discoveries.at(-1).saved==='fixture'&&catalogHas('directory-saved')&&document.querySelector('.provider-editor').textContent.includes('模型目录')&&document.querySelector('.provider-editor').textContent.includes('调用权限未验证')");
  await check('sharedImageCatalogDoesNotAutomaticallySelectOrAuthorizeModels', "providerImageCapabilities.textContent.includes('directory-saved/gpt-image-2')&&!providerImageCapabilities.querySelector('[data-image-route-adapter].is-active')&&!providerImageCapabilities.textContent.includes('已分配')&&providerProbeFixture.imageRouteWrites.length===0");
  await fill('#providerBaseUrl', 'https://blank-key-draft.invalid/anthropic');await click('#providerDiscover');
  await check('blankDraftCatalogKeyKeepsSavedCredentialWithoutUsingSavedUrl', "(()=>{const x=providerProbeFixture.discoveries.at(-1).draft;return x?.id==='fixture'&&x.apiKey===''&&x.baseUrl==='https://blank-key-draft.invalid/anthropic'})()");
  await fill('#providerBaseUrl', await evaluate('providerProbeFixture.profile.baseUrl'));
  await fill('#providerApiKey', 'synthetic-key-a');await click('#providerDiscover');await act('openCatalog();');
  await check('newKeyCatalogDiscoveryUsesCurrentUnsavedCredential', "(()=>{const x=providerProbeFixture.discoveries.at(-1).draft;return x?.id==='fixture'&&x.apiKey==='synthetic-key-a'&&x.baseUrl===providerBaseUrl.value&&catalogHas('directory-a')&&providerImageCapabilities.textContent.includes('directory-a/gpt-image-2')})()");
  await act("providerProbeFixture.catalogScenario.drafts['synthetic-key-a']={label:'directory-late-a',hold:true};");
  await click('#providerDiscover');await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-late-a')");
  await fill('#providerApiKey', 'synthetic-key-b');await act('openCatalog();');
  await check('changingKeyImmediatelyClearsOldCatalogAndImageCandidates', "!catalogHas('directory-a')&&!catalogHas('directory-late-a')&&!providerImageCapabilities.textContent.includes('directory-a/')&&!providerImageCapabilities.querySelector('[data-image-route-adapter]')");
  await click('#providerDiscover');await act('openCatalog();');
  await act("providerProbeFixture.catalogPending.find(x=>x.label==='directory-late-a').release();");await settle();
  await check('lateKeyAResponseCannotOverwriteKeyBCatalogOrCapabilities', "catalogHas('directory-b')&&!catalogHas('directory-a')&&!catalogHas('directory-late-a')&&providerImageCapabilities.textContent.includes('directory-b/gpt-image-2')&&!providerImageCapabilities.textContent.includes('directory-late-a/')&&providerApiKey.value==='synthetic-key-b'");
  await click('#providerImageCapabilities [data-image-route-adapter]');
  await check('imageSelectionMeansLocalRouteChoiceAndStillShowsUnverifiedPermission', "providerImageCapabilities.querySelector('[data-image-route-adapter]').textContent==='已选用'&&!providerImageCapabilities.textContent.includes('已分配')&&document.querySelector('.provider-editor').textContent.includes('调用权限未验证')&&providerProbeFixture.imageRouteWrites.length===0");
  await act('closeProviderModelPickers();document.querySelector(".provider-catalog-notice").closest(".provider-edit-section").scrollIntoView({block:"start"});');await capture('catalog-permission-unverified');
  await fill('#providerBaseUrl', 'https://changed-directory.invalid/anthropic');await act('openCatalog();');
  await check('changingUrlImmediatelyClearsOldDirectoryAndImageCandidates', "!catalogHas('directory-b')&&!providerImageCapabilities.querySelector('[data-image-route-adapter]')");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act("providerProbeFixture.catalogScenario.saved={label:'directory-before-revision'};");
  await click('[data-provider-act=edit]');await click('#providerDiscover');await act('openCatalog();');
  await check('savedDirectoryCanBeCachedForItsCurrentProfileVersion', "catalogHas('directory-before-revision')&&providerProbeFixture.discoveries.at(-1).saved==='fixture'");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act("providerProbeFixture.profile.revision++;providerProbeFixture.catalogScenario.saved={label:'directory-after-revision',hold:true,fail:true};providerProbeFixture.changed();");
  await click('[data-provider-act=edit]');await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-after-revision')");await act('openCatalog();');
  await check('sameUrlCredentialRevisionRejectsCachedDirectoryWhileRefreshing', "!catalogHas('directory-before-revision')&&!providerImageCapabilities.textContent.includes('directory-before-revision/')&&providerProbeFixture.catalogPending.at(-1).request.saved==='fixture'");
  await act("providerProbeFixture.catalogPending.find(x=>x.label==='directory-after-revision').release();");await settle();await act('openCatalog();');
  await check('failedRefreshDoesNotRestoreEarlierCredentialDirectory', "providerEditorStatus.textContent.includes('合成目录刷新失败')&&!catalogHas('directory-before-revision')&&!catalogHas('directory-after-revision')&&!providerImageCapabilities.querySelector('[data-image-route-adapter]')");
  // Leave one saved request pending, rotate the saved credential while its
  // editor remains mounted, then ensure the old response is ignored as well.
  await act("providerProbeFixture.catalogScenario.saved={label:'directory-stale-saved',hold:true};");await click('#providerDiscover');
  await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-stale-saved')");
  await act("providerProbeFixture.profile.revision++;providerProbeFixture.changed();providerProbeFixture.catalogPending.find(x=>x.label==='directory-stale-saved').release();");await settle();await act('openCatalog();');
  await check('lateSavedDirectoryCannotPopulateAfterCredentialRevisionChanges', "!catalogHas('directory-stale-saved')&&!providerImageCapabilities.textContent.includes('directory-stale-saved/')");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act("providerProbeFixture.catalogScenario.saved={label:'directory-auth-updated',rotateAuth:true};providerProbeFixture.catalogAuthChanged=false;");
  await click('[data-provider-act=edit]');await waitFor('providerProbeFixture.catalogAuthChanged&&!providerDiscover.disabled');await act('openCatalog();');
  await check('savedDiscoveryAcceptsItsOwnAuthRevisionChangeAndCachesLatestProfile', "catalogHas('directory-auth-updated')&&providerImageCapabilities.textContent.includes('directory-auth-updated/gpt-image-2')&&providerModelCatalog.get('fixture')?.profileKey===providerHealthProfileKey(providerProbeFixture.profile)");
  await act("providerProbeFixture.catalogBeforeUnrelatedChange=providerProbeFixture.discoveries.length;providerProbeFixture.changed([{...providerProbeFixture.profile,id:'unrelated-provider',name:'另一合成服务商',revision:99}]);");await settle();await act('openCatalog();');
  await check('unrelatedProviderChangePreservesCurrentEditorDirectory', "catalogHas('directory-auth-updated')&&providerImageCapabilities.textContent.includes('directory-auth-updated/gpt-image-2')&&providerProbeFixture.discoveries.length===providerProbeFixture.catalogBeforeUnrelatedChange");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('#providerAdd')");await click('#providerAdd');
  await fill('#providerBaseUrl','https://new-directory.invalid/anthropic');await fill('#providerApiKey','synthetic-key-b');await click('#providerDiscover');
  await check('catalogChecksNeverAutoSelectNewImageRoutesSaveOrInvokeProbes', "providerProbeFixture.discoveries.at(-1).draft.id===''&&providerImageCapabilities.textContent.includes('directory-b/gpt-image-2')&&!providerImageCapabilities.querySelector('[data-image-route-adapter].is-active')&&providerProbeFixture.writes.length===providerProbeFixture.catalogWritesBefore&&providerProbeFixture.savedCalls.length+providerProbeFixture.draftCalls.length===providerProbeFixture.catalogProbeCallsBefore&&providerProbeFixture.imageRouteWrites.length===0");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act("providerProbeFixture.catalogScenario.saved={label:'directory-save-ready'};");
  await click('[data-provider-act=edit]');await click('#providerDiscover');
  await click('#providerImageCapabilities [data-image-route-adapter]');
  await fill('#providerName','待保存的合成服务商');
  await act('providerProbeFixture.failUpdate=true;');await click('#providerEditorSave');
  await check('failedSaveUnlocksEditorAndRetainsDraftAndImageChoice', "providerEditorStatus.textContent.includes('合成保存失败')&&!providerName.disabled&&!providerApiKey.disabled&&!providerEditorBack.disabled&&!providerEditorSave.disabled&&!providerImageCapabilities.querySelector('[data-image-route-adapter]').disabled&&providerImageCapabilities.querySelector('[data-image-route-adapter]').classList.contains('is-active')&&providerName.value==='待保存的合成服务商'");
  await act(`
    const f=providerProbeFixture;f.failUpdate=false;f.catalogScenario.saved={label:'directory-save-held',hold:true};
    f.saveEditor=document.querySelector('.provider-editor');f.saveControls=Array.from(f.saveEditor.querySelectorAll('input,button'));
    f.saveImageButton=providerImageCapabilities.querySelector('[data-image-route-adapter]');f.saveBack=providerEditorBack;
  `);
  await click('#providerEditorSave');await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-save-held')");
  await act('providerProbeFixture.saveBack.click();providerProbeFixture.saveImageButton.click();');
  await check('saveLocksInputsBackAndImageSelectionWhileDiscoveryIsPending', "providerProbeFixture.saveControls.every(control=>control.disabled)&&providerProbeFixture.saveEditor.isConnected&&providerProbeFixture.writes.at(-1).input.imageRouteAdapters.join(',')==='gpt-image-2'&&providerProbeFixture.saveImageButton.classList.contains('is-active')");
  await act('renderProviderEditor(providerProbeFixture.saveEditor.parentElement,null,uiFixture.routes);');
  await fill('#providerName','另一份尚未保存的草稿');
  await act('providerProbeFixture.replacementEditor=document.querySelector(".provider-editor");providerProbeFixture.catalogPending.find(x=>x.label==="directory-save-held").release();');
  await waitFor('providerProbeFixture.imageRouteWrites.length===1');await settle();
  await check('oldSaveCompletesItsSnapshotWithoutReplacingNewEditor', "providerProbeFixture.replacementEditor===document.querySelector('.provider-editor')&&providerName.value==='另一份尚未保存的草稿'&&!providerName.disabled&&providerProbeFixture.imageRouteWrites[0][0]==='gpt-image-2'&&providerProbeFixture.imageRouteWrites[0][1]==='fixture'&&!providerProbeFixture.saveEditor.isConnected");
  // Let the actual debounce start an automatic directory request. Its late
  // success may update candidates, but must not erase a newer connection check.
  await act("providerProbeFixture.catalogScenario.drafts['synthetic-key-probe']={label:'directory-auto-probe',hold:true};");
  await fill('#providerBaseUrl','https://automatic-directory.invalid/anthropic');
  await fill('#providerApiKey','synthetic-key-probe');await fill('#providerModelHaiku','probe/fast');
  await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-auto-probe')");
  await click('#providerEditorTest');
  await act("providerProbeFixture.probeStatusBeforeLateDirectory=providerEditorStatus.textContent;providerProbeFixture.catalogPending.find(x=>x.label==='directory-auto-probe').release();");await settle();await act('openCatalog();');
  await check('lateAutomaticDirectoryPreservesNewerConversationProbeStatus', "catalogHas('directory-auto-probe')&&providerProbeFixture.probeStatusBeforeLateDirectory.includes('快速')&&providerProbeFixture.probeStatusBeforeLateDirectory.includes('尚未保存')&&providerEditorStatus.textContent===providerProbeFixture.probeStatusBeforeLateDirectory");
  await check('providerProbeFlowHasNoRendererErrors', 'uiFixture.errors.length===0');
  clearTimeout(deadline); step = 'complete'; save(); console.log(JSON.stringify({ passed: Object.keys(checks).length, output })); app.exit(0);
}).catch(error => { clearTimeout(deadline); errors.push(error.stack || String(error)); save(); console.error(error); app.exit(1); });
