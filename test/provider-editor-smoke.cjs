'use strict';
// Actual renderer with isolated provider records and synthetic probe promises.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = process.argv[2] || path.join(root, '.codex-tmp', 'provider-editor-smoke');
const mediaPresets = { ok: true, ...require('../src/main/providers/provider-media').getMediaProtocolPresets() };
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, errors = [], layouts = {}, resizes = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors, layouts, resizes, step }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
async function settle() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); }
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)};tick()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name); if (!checks[name]) { console.log(await evaluate('JSON.stringify({status:document.getElementById("providerEditorStatus")?.textContent,lastDraft:providerProbeFixture.draftCalls.at(-1),lastDiscovery:providerProbeFixture.discoveries.at(-1),media:document.getElementById("providerMediaEditor")?.textContent})')); throw Error(name); } }
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); }
async function nativeClick(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await settle();
  const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});await settle();
}
async function fill(selector, value) { await act(`const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));`); await settle(); }
async function key(keyCode) {
  // Electron uses accelerator names; Enter's char event activates native buttons.
  keyCode=({ArrowDown:'Down',ArrowUp:'Up',ArrowLeft:'Left',ArrowRight:'Right'})[keyCode]||keyCode;
  win.webContents.sendInputEvent({type:'keyDown',keyCode});
  if(keyCode==='Enter')win.webContents.sendInputEvent({type:'char',keyCode});
  win.webContents.sendInputEvent({type:'keyUp',keyCode});await settle();
}
async function select(selector, value) { await act(`const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));`); await settle(); }
async function openAdvanced(prefix) {
  await act(`const row=document.querySelector(${JSON.stringify(prefix)});if(row.querySelector('[data-editor]').hidden)row.querySelector('[data-edit]').click();`);await settle();
  await act(`const details=document.querySelector(${JSON.stringify(prefix)}).querySelector('[data-advanced]');if(!details.open)details.querySelector('summary').click();`);await settle();
}
async function addFirstCatalogModel() {
  await click('#providerMediaEditor [data-add]');
  await click('#providerMediaEditor [data-catalog-check]:not(:disabled)');
  await click('#providerMediaEditor [data-add-selected]');
}
async function capture(name) {
  await settle(); await evaluate('document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}})');
  await evaluate('new Promise(r=>setTimeout(r,350))');await settle();
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function resizeViewport(name, width, height = width <= 900 ? 600 : 800) {
  step = name + 'Resize';
  const snapshot = async () => ({
    contentSize: win.getContentSize(), bounds: win.getBounds(), zoomFactor: win.webContents.getZoomFactor(),
    renderer: await evaluate('({innerWidth,innerHeight,devicePixelRatio})'),
  });
  const record = { name, requested: { width, height } };
  resizes.push(record);
  win.setContentSize(width, height);
  record.afterSet = await snapshot();save();
  try {
    // Windows fractional DPI can round the native content size by a pixel.
    // Preserve native and renderer measurements even if resize never settles.
    await waitFor(`Math.abs(innerWidth-${width})<=2`);
  } catch (error) {
    record.failed = await snapshot();record.error = error.message || String(error);save();
    console.error('viewport resize failed: ' + JSON.stringify(record));
    throw error;
  }
  await settle();record.settled = await snapshot();save();
}
async function providerLayout(name, width, theme) {
  await resizeViewport(name, width);
  await waitFor("!document.querySelector('#appToast.show')");
  await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};closeProviderModelPickers();document.querySelector('#settingsModal .set-content').scrollTo({top:0,behavior:'instant'});`);
  await settle();
  // Check the rendered controls in the actual Electron viewport. These are
  // geometry and visible-style checks, independent of the CSS implementation.
  layouts[name] = await evaluate(`(() => {
    const content=document.querySelector('#settingsModal .set-content');
    const input=document.getElementById('providerName'), style=getComputedStyle(input);
    const label=document.querySelector('label[for=providerName]');
    const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const color=value=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data);};
    const visible=element=>{if(!element)return false;const r=rect(element),v=rect(content),s=getComputedStyle(element);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&parseFloat(s.opacity)>0&&r.top>=v.top-1&&r.bottom<=v.bottom+1;};
    const background=color(style.backgroundColor);
    const borderWidths=[style.borderTopWidth,style.borderRightWidth,style.borderBottomWidth,style.borderLeftWidth];
    return {
      width:innerWidth,theme:document.documentElement.dataset.theme,
      containers:[document.documentElement,document.getElementById('settingsBody'),content].map(element=>({id:element.id||element.className||element.tagName,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth})),
      input:rect(input),content:rect(content),
      inputStyle:{fontSize:style.fontSize,height:style.height,border:{top:style.borderTop,right:style.borderRight,bottom:style.borderBottom,left:style.borderLeft},backgroundColor:style.backgroundColor},
      hasOriginalTitleStyle:Math.abs(parseFloat(style.fontSize)-28)<.1&&Math.abs(parseFloat(style.height)-50)<=1&&Math.abs(rect(input).height-50)<=1&&borderWidths.every(value=>parseFloat(value)===0)&&background[3]===0,
      namePrompts:{labelAbsent:!label,accessibleName:input.getAttribute('aria-label'),required:input.required&&input.getAttribute('aria-required')==='true',editPromptVisible:visible(input)&&input.placeholder.includes('填写服务商名称')},
      sectionHeaders:[providerEditorTest,providerDiscover].map(button=>{const head=button.closest('.provider-edit-section-head'),title=head?.querySelector('.provider-edit-section-title');return {button:rect(button),header:head&&rect(head),title:title&&rect(title)};}),
      fieldControls:[providerBaseUrl,providerApiKey.closest('.provider-secret-input'),providerModelHaiku.closest('.provider-route-control'),providerModelSonnet.closest('.provider-route-control'),providerModelOpus.closest('.provider-route-control')].map(rect),
      modelRows:[providerModelHaiku,providerModelSonnet,providerModelOpus].map(node=>rect(node.closest('.provider-edit-row'))),
      mediaSection:rect(providerMediaEditor),chatSection:rect(providerModelOpus.closest('.provider-edit-section')),
      mediaControls:Array.from(providerMediaEditor.querySelectorAll('input,select,textarea,button')).filter(node=>node.getBoundingClientRect().width>0).map(rect),
      removedPersistentCopy:!document.querySelector('label[for=providerName],#providerProbeHint,#providerDiscoverHint,.provider-catalog-notice')
    };
  })()`);
  save();
  await check(name + 'HasNoHorizontalOverflow', `(()=>{const nodes=[document.documentElement,document.getElementById('settingsBody'),document.querySelector('#settingsModal .set-content')];return nodes.every(el=>el.scrollWidth<=el.clientWidth+1)})()`);
  await check(name + 'NameKeepsOriginalTitleStyle', JSON.stringify(layouts[name].hasOriginalTitleStyle));
  await check(name + 'NameKeepsAccessibleRequiredAndEditPrompts', JSON.stringify(layouts[name].namePrompts.labelAbsent && layouts[name].namePrompts.accessibleName === '服务商名称' && layouts[name].namePrompts.required && layouts[name].namePrompts.editPromptVisible));
  await check(name + 'SectionActionsAlignWithoutOverlap', JSON.stringify(layouts[name].sectionHeaders.every(({button,header,title})=>header&&title&&button.width>0&&button.left>=title.right+4&&button.right<=header.right+1&&Math.abs((button.top+button.bottom-title.top-title.bottom)/2)<=2)));
  await check(name + 'ConnectionAndChatFieldsAlign', JSON.stringify(layouts[name].fieldControls.every(control=>control.width>0&&Math.abs(control.left-layouts[name].fieldControls[0].left)<=1)&&layouts[name].modelRows.every((row,index,rows)=>!index||row.top>=rows[index-1].bottom-1)));
  await check(name + 'MediaSectionUsesFullWidthWithoutControlOverflow', JSON.stringify(layouts[name].mediaSection.width>0&&Math.abs(layouts[name].mediaSection.left-layouts[name].chatSection.left)<=1&&Math.abs(layouts[name].mediaSection.right-layouts[name].chatSection.right)<=1&&layouts[name].mediaSection.top>=layouts[name].chatSection.bottom-1&&layouts[name].mediaControls.every(control=>control.left>=layouts[name].mediaSection.left-1&&control.right<=layouts[name].mediaSection.right+1)));
  await check(name + 'RedundantPersistentCopyIsRemoved', JSON.stringify(layouts[name].removedPersistentCopy));
  await act("document.querySelector('#settingsModal .set-content').scrollTop=document.querySelector('#settingsModal .set-content').scrollHeight;");
  await settle();
  layouts[name].bottom = await evaluate(`(() => {
    const rect=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height};};
    return {lastField:rect(providerEnabled),footer:rect(document.querySelector('.provider-editor-actions')),content:rect(document.querySelector('#settingsModal .set-content'))};
  })()`);
  save();
  await check(name + 'FooterDoesNotCoverLastField', `(()=>{const field=providerEnabled.getBoundingClientRect(),footer=document.querySelector('.provider-editor-actions').getBoundingClientRect(),content=document.querySelector('#settingsModal .set-content').getBoundingClientRect();return field.height>0&&field.top>=content.top-1&&field.bottom<=Math.min(content.bottom,footer.top)+1&&field.left>=content.left-1&&field.right<=content.right+1})()`);
  await act("document.querySelector('#settingsModal .set-content').scrollTo({top:0,behavior:'instant'});");
  await capture(name);
}
async function providerCatalogLayout(name, width) {
  await resizeViewport(name, width);
  // Bring the model control into view before opening its menu, as a user
  // would. Compare screen coordinates after the opening animation completes.
  await act("closeProviderModelPickers();providerModelSonnet.scrollIntoView({block:'center',behavior:'instant'});");await settle();
  await act('openCatalog();');await capture(name);
  layouts[name] = await evaluate(`(() => {
    const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const popup=document.getElementById('providerModelSonnetOptions');
    return {width:innerWidth,height:innerHeight,input:rect(providerModelSonnet),popup:rect(popup),popupHidden:popup.hidden,position:getComputedStyle(popup).position};
  })()`);
  save();
  await check(name + 'PopupAlignsWithModelInput', "(()=>{const input=providerModelSonnet.getBoundingClientRect(),popup=providerModelSonnetOptions.getBoundingClientRect();return !providerModelSonnetOptions.hidden&&popup.width>0&&popup.height>0&&Math.abs(popup.left-input.left)<=2&&Math.abs(popup.right-input.right)<=2})()");
  await check(name + 'PopupIsAdjacentAndInsideViewport', "(()=>{const input=providerModelSonnet.getBoundingClientRect(),popup=providerModelSonnetOptions.getBoundingClientRect(),below=popup.top-input.bottom,above=input.top-popup.bottom;return ((below>=-1&&below<=12)||(above>=-1&&above<=12))&&popup.left>=-1&&popup.right<=innerWidth+1&&popup.top>=-1&&popup.bottom<=innerHeight+1})()");
}
function providerFixture(mediaPresets) {
  const base = window.api, listeners = new Set();
  const clone = value => JSON.parse(JSON.stringify(value));
  const f = window.providerProbeFixture = {
    profile: { id: 'fixture', name: '合成服务商', revision: 1, baseUrl: 'https://saved.invalid/anthropic',
      hasCredential: true, credentialHint: '已保存', enabled: true, chatReady: true, chatModelCount: 3,
      activeTiers: ['haiku', 'sonnet', 'opus'], activeImageAdapters: [], imageModels: [], mediaModels: [], mediaConnection: { preset: 'custom' }, routed: true,
      models: { haiku: 'saved/fast', sonnet: 'saved/medium', opus: 'saved/expert' }, defaultModel: 'opus' },
    savedCalls: [], draftCalls: [], discoveries: [], writes: [], holdSaved: false, holdDraft: false,
    releaseSaved: null, releaseDraft: null, failDraft: false, draftAuthMode: 'api-key',
    catalogScenario: null, catalogPending: [], imageRouteWrites: [], failUpdate: false,
    holdUpdate: false, releaseUpdate: null, updateFailure: null, committedWrites: 0,
    changed(extraProfiles = []) { const payload = { profiles: [clone(this.profile), ...clone(extraProfiles)], routes: clone(uiFixture.routes) }; for (const callback of listeners) callback(payload); },
  };
  const discover = async request => {
    f.discoveries.push(clone(request));
    if (!f.catalogScenario) return { ok: true, models: [request.saved ? 'saved/fast' : 'draft/fast'], imageModels: [],
      profile: request.saved ? clone(f.profile) : undefined, message: '合成目录已读取' };
    const plan = clone(request.saved ? f.catalogScenario.saved : f.catalogScenario.drafts[request.draft.apiKey] || f.catalogScenario.fallback);
    const imageModels = [{ adapterId: 'gpt-image-2', remoteModelId: plan.label + '/gpt-image-2' }];
    const mediaModels = [{ rawId: plan.label + '/gpt-image-2', ownedBy: 'fixture-owner', model_type: 'image' }];
    if (plan.rotateAuth && !f.catalogAuthChanged) {
      f.catalogAuthChanged = true;
      f.profile = { ...f.profile, revision: f.profile.revision + 1, authMode: 'auth-token' };
      f.changed();
    }
    const response = plan.fail ? { ok: false, models: [], imageModels: [], message: '合成目录刷新失败' }
      : { ok: true, models: [plan.label + '/chat', plan.label + '/gpt-image-2'], imageModels, mediaModels,
        modelCatalog: [{ value: plan.label + '/chat', id: 'chat', ownedBy: 'fixture-owner', idKind: 'owner-qualified', inference: 'configured-owner' }, { value: plan.label + '/gpt-image-2', id: plan.label + '/gpt-image-2' }],
        profile: request.saved ? { ...clone(f.profile), imageModels, mediaCatalog: { models: mediaModels }, imageDiscovery: { status: 'ready' } } : undefined,
        catalogSource: 'gateway-root', gatewayRootFallbackUsed: true, message: '合成共享模型目录已读取' };
    if (!plan.hold) return response;
    return new Promise(resolve => f.catalogPending.push({ request: clone(request), label: plan.label, release: () => resolve(response) }));
  };
  const providers = {
    mediaPresets: async () => clone(mediaPresets),
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
      if (f.holdUpdate) await new Promise(resolve => { f.releaseUpdate = () => { f.releaseUpdate = null; resolve(); }; });
      if (f.updateFailure) return clone(f.updateFailure);
      if (f.failUpdate) return { ok: false, message: '合成保存失败' };
      f.committedWrites += 1;
      f.profile = { ...f.profile, name: input.name, baseUrl: input.baseUrl, models: clone(input.models), mediaModels: clone(input.mediaModels || []), mediaConnection: clone(input.mediaConnection || {}), revision: f.profile.revision + 1 };
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
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', () => '<head><base href="' + base + '"><script>' + fixture + '\n(' + providerFixture.toString() + ')(' + JSON.stringify(mediaPresets).replace(/</g, '\\u003c') + ');localStorage.clear();</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1200, height: 800, titleBarStyle: 'hidden', titleBarOverlay: { color: '#fafafa', symbolColor: '#111111', height: 40 }, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive();
  // Exercise real focus/blur events without taking focus from the user's app.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  await evaluate("openSettings('providers')");
  await waitFor("!!document.querySelector('[data-provider-act=test]')");
  await capture('provider-list-light');
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
  await providerLayout('provider-edit-light-1200', 1200, 'light');
  await providerLayout('provider-edit-dark-900', 900, 'dark');
  await resizeViewport('provider-edit-restore-1200', 1200);
  await fill('#providerName', '');
  await act('providerName.focus();providerBaseUrl.focus();');
  await click('#providerEditorSave');
  await check('missingEditedNameCannotUpdateSavedProvider', "providerProbeFixture.writes.length===0&&providerProbeFixture.profile.name==='合成服务商'&&document.activeElement===providerName&&!providerNameError.hidden&&providerName.getAttribute('aria-invalid')==='true'");
  await fill('#providerName', '合成服务商');
  await check('correctingEditedNameClearsInlineErrorWithoutSaving', "providerNameError.hidden&&providerName.getAttribute('aria-invalid')!=='true'&&providerProbeFixture.writes.length===0&&providerBaseUrl.value==='https://saved.invalid/anthropic'&&providerApiKey.value===''&&providerModelSonnet.value==='saved/medium'");
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
  await check('newProviderNameRetainsRequiredAccessibleNameWithoutRepeatedLabel', "(()=>{const descriptions=(providerName.getAttribute('aria-describedby')||'').split(/\\s+/);return !document.querySelector('label[for=providerName]')&&providerName.getAttribute('aria-label')==='服务商名称'&&providerName.required&&providerName.placeholder.includes('填写服务商名称')&&!document.getElementById('providerNameHint')&&descriptions.includes('providerNameError')&&providerNameError.getAttribute('role')==='alert'})()");
  await check('newProviderStartsWithoutPrematureNameError', "providerName.value===''&&providerNameError.hidden&&providerName.getAttribute('aria-invalid')!=='true'");
  await providerLayout('provider-new-light-1200', 1200, 'light');
  await providerLayout('provider-new-dark-900', 900, 'dark');
  await resizeViewport('provider-new-restore-1200', 1200);
  await act('providerName.focus();providerBaseUrl.focus();');
  await check('leavingEmptyNameShowsInlineError', "!providerNameError.hidden&&providerNameError.textContent.trim().length>0&&providerName.getAttribute('aria-invalid')==='true'&&providerProbeFixture.writes.length===1");
  await fill('#providerBaseUrl', 'https://new.invalid'); await fill('#providerApiKey', 'synthetic-new');
  await fill('#providerModelHaiku', 'new/fast'); await click('#providerEditorTest');
  await check('newProviderDraftTestDoesNotCreateProfile', "providerProbeFixture.draftCalls.at(-1).id===''&&providerProbeFixture.draftCalls.at(-1).models.haiku==='new/fast'&&providerProbeFixture.writes.length===1");
  await check('draftProbeFallsBackToItsFilledTierWithoutChangingGlobalDefault', "providerProbeFixture.draftCalls.at(-1).tier==='sonnet'&&!Object.hasOwn(providerProbeFixture.draftCalls.at(-1),'defaultModel')&&providerEditorStatus.textContent.includes('快速')&&uiFixture.routes.defaultModel==='sonnet'");
  await check('missingNameDoesNotBlockConnectionProbe', "providerName.value===''&&!providerNameError.hidden&&!providerEditorTest.disabled&&providerProbeFixture.draftCalls.at(-1).baseUrl==='https://new.invalid'&&providerProbeFixture.draftCalls.at(-1).apiKey==='synthetic-new'&&providerProbeFixture.writes.length===1");
  await waitFor('!providerDiscover.disabled');await click('#providerDiscover');
  await check('missingNameDoesNotBlockModelDiscovery', "providerName.value===''&&!providerDiscover.disabled&&providerProbeFixture.discoveries.at(-1).draft?.id===''&&providerProbeFixture.discoveries.at(-1).draft?.baseUrl==='https://new.invalid'&&providerProbeFixture.discoveries.at(-1).draft?.apiKey==='synthetic-new'&&providerProbeFixture.writes.length===1");
  await fill('#providerName', '   ');await act('providerName.focus();providerBaseUrl.focus();');
  await check('whitespaceNameRemainsInvalidAfterBlur', "!providerNameError.hidden&&providerName.getAttribute('aria-invalid')==='true'");
  await act("document.querySelector('#settingsModal .set-content').scrollTop=document.querySelector('#settingsModal .set-content').scrollHeight;");await settle();
  await click('#providerEditorSave');
  await waitFor("(()=>{const r=providerName.getBoundingClientRect(),v=document.querySelector('#settingsModal .set-content').getBoundingClientRect();return r.top>=v.top-1&&r.bottom<=v.bottom+1})()");
  await check('missingNewNamePreventsCreateAndRevealsFocusedField', "providerProbeFixture.writes.length===1&&document.activeElement===providerName&&!providerNameError.hidden&&providerName.getAttribute('aria-invalid')==='true'");
  await check('nameValidationPreservesConnectionAndModelDraft', "providerBaseUrl.value==='https://new.invalid'&&providerApiKey.value==='synthetic-new'&&providerModelHaiku.value==='new/fast'&&providerModelSonnet.value===''&&providerModelOpus.value===''");
  await capture('provider-name-error');
  await fill('#providerName', '新合成服务商');
  await check('validNameImmediatelyClearsErrorWithoutAnotherSave', "providerNameError.hidden&&providerName.getAttribute('aria-invalid')!=='true'&&providerProbeFixture.writes.length===1&&providerBaseUrl.value==='https://new.invalid'&&providerApiKey.value==='synthetic-new'&&providerModelHaiku.value==='new/fast'");
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
    window.mediaCatalogHas=prefix=>Array.from(document.querySelectorAll('#providerMediaEditor [data-catalog] option')).some(el=>el.textContent.startsWith(prefix+'/'));
    window.mediaBindingCount=()=>document.querySelectorAll('#providerMediaEditor .media-binding').length;
  `);
  await click('[data-provider-act=edit]');
  await waitFor("providerProbeFixture.discoveries.some(x=>x.saved==='fixture')&&!providerDiscover.disabled");
  await act('openCatalog();');
  await check('savedCatalogDiscoveryUsesProfileIdAndLoadsExplicitMediaCandidates', "providerProbeFixture.discoveries.at(-1).saved==='fixture'&&catalogHas('directory-saved')&&!document.querySelector('.provider-catalog-notice')&&mediaCatalogHas('directory-saved')");
  await check('catalogPopupShowsModelsWithoutRepeatedExplanationOrRouteBadge', "(()=>{const popup=providerModelSonnetOptions,option=popup.querySelector('[data-model=\"directory-saved/chat\"]');return !!option&&Array.from(popup.children).every(node=>node.classList.contains('provider-model-option'))&&!popup.textContent.includes('兼容路由')&&!option.querySelector('small')&&option.title.includes('接口原始 ID：chat')})()");
  await act('providerProbeFixture.catalogSelectionBefore=providerModelSonnet.value;');
  await click('#providerModelSonnetOptions [data-model="directory-saved/chat"]');
  await check('catalogSelectionPreservesExactQualifiedModelIdWithoutSaving', "providerModelSonnet.value==='directory-saved/chat'&&providerModelSonnetOptions.hidden&&providerProbeFixture.writes.length===providerProbeFixture.catalogWritesBefore");
  await fill('#providerModelSonnet', await evaluate('providerProbeFixture.catalogSelectionBefore'));
  await providerCatalogLayout('provider-catalog-1200', 1200);
  await providerCatalogLayout('provider-catalog-900', 900);
  await resizeViewport('provider-catalog-restore-1200', 1200);
  await act("closeProviderModelPickers();providerModelSonnet.scrollIntoView({block:'center',behavior:'instant'});");await settle();await act('openCatalog();');
  await check('sharedImageCatalogDoesNotAutomaticallySelectOrAuthorizeModels', "providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-saved/gpt-image-2')&&mediaBindingCount()===0&&!providerMediaEditor.querySelector('[data-catalog]').textContent.includes('已分配')&&providerProbeFixture.imageRouteWrites.length===0");
  await fill('#providerBaseUrl', 'https://blank-key-draft.invalid/anthropic');await click('#providerDiscover');
  await check('blankDraftCatalogKeyKeepsSavedCredentialWithoutUsingSavedUrl', "(()=>{const x=providerProbeFixture.discoveries.at(-1).draft;return x?.id==='fixture'&&x.apiKey===''&&x.baseUrl==='https://blank-key-draft.invalid/anthropic'})()");
  await fill('#providerBaseUrl', await evaluate('providerProbeFixture.profile.baseUrl'));
  await fill('#providerApiKey', 'synthetic-key-a');await click('#providerDiscover');await act('openCatalog();');
  await check('newKeyCatalogDiscoveryUsesCurrentUnsavedCredential', "(()=>{const x=providerProbeFixture.discoveries.at(-1).draft;return x?.id==='fixture'&&x.apiKey==='synthetic-key-a'&&x.baseUrl===providerBaseUrl.value&&catalogHas('directory-a')&&providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-a/gpt-image-2')})()");
  await act("providerProbeFixture.catalogScenario.drafts['synthetic-key-a']={label:'directory-late-a',hold:true};");
  await click('#providerDiscover');await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-late-a')");
  await fill('#providerApiKey', 'synthetic-key-b');await act('openCatalog();');
  await check('changingKeyImmediatelyClearsOldCatalogAndImageCandidates', "!catalogHas('directory-a')&&!catalogHas('directory-late-a')&&!providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-a/')&&providerMediaEditor.querySelector('[data-catalog]').options.length===1");
  await click('#providerDiscover');await act('openCatalog();');
  await act("providerProbeFixture.catalogPending.find(x=>x.label==='directory-late-a').release();");await settle();
  await check('lateKeyAResponseCannotOverwriteKeyBCatalogOrCapabilities', "catalogHas('directory-b')&&!catalogHas('directory-a')&&!catalogHas('directory-late-a')&&providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-b/gpt-image-2')&&!providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-late-a/')&&providerApiKey.value==='synthetic-key-b'");
  await addFirstCatalogModel();
  await check('mediaCatalogSelectionMatchesKnownFamilyWithoutSaving', "mediaBindingCount()===1&&providerMediaEditor.querySelector('[data-id]').value==='directory-b/gpt-image-2'&&providerMediaEditor.querySelector('[data-owner]').value==='fixture-owner'&&providerMediaEditor.querySelector('[data-protocol]').value==='openai-images'&&JSON.parse(providerMediaEditor.querySelector('[data-json]').value).setup.source==='family-template'&&providerProbeFixture.imageRouteWrites.length===0&&providerProbeFixture.writes.length===providerProbeFixture.catalogWritesBefore");
  await select('#providerMediaEditor [data-protocol]', 'openai-images');
  await check('explicitProtocolSelectionPreservesRawModelAndStartsMinimalCapabilities', "(()=>{const value=JSON.parse(providerMediaEditor.querySelector('[data-json]').value);return value.modelId==='directory-b/gpt-image-2'&&value.protocol==='openai-images'&&value.capabilities.operations.join(',')==='text_to_image'&&Object.keys(value.capabilities.parameters).length===0&&Object.keys(value.capabilities.defaults).length===0})()");
  await providerLayout('provider-media-selected-900', 900, 'dark');
  await resizeViewport('provider-media-selected-restore-1200', 1200);
  await act('closeProviderModelPickers();providerDiscover.closest(".provider-edit-section").scrollIntoView({block:"start"});');await capture('catalog-image-selection');
  await fill('#providerBaseUrl', 'https://changed-directory.invalid/anthropic');await act('openCatalog();');
  await check('changingUrlImmediatelyClearsOldDirectoryAndImageCandidates', "!catalogHas('directory-b')&&providerMediaEditor.querySelector('[data-catalog]').options.length===1");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act("providerProbeFixture.catalogScenario.saved={label:'directory-before-revision'};");
  await click('[data-provider-act=edit]');await click('#providerDiscover');await act('openCatalog();');
  await check('savedDirectoryCanBeCachedForItsCurrentProfileVersion', "catalogHas('directory-before-revision')&&providerProbeFixture.discoveries.at(-1).saved==='fixture'");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act("providerProbeFixture.profile.revision++;providerProbeFixture.catalogScenario.saved={label:'directory-after-revision',hold:true,fail:true};providerProbeFixture.changed();");
  await click('[data-provider-act=edit]');await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-after-revision')");await act('openCatalog();');
  await check('sameUrlCredentialRevisionRejectsCachedDirectoryWhileRefreshing', "!catalogHas('directory-before-revision')&&!providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-before-revision/')&&providerProbeFixture.catalogPending.at(-1).request.saved==='fixture'");
  await act("providerProbeFixture.catalogPending.find(x=>x.label==='directory-after-revision').release();");await settle();await act('openCatalog();');
  await check('failedRefreshDoesNotRestoreEarlierCredentialDirectory', "providerEditorStatus.textContent.includes('合成目录刷新失败')&&!catalogHas('directory-before-revision')&&!catalogHas('directory-after-revision')&&providerMediaEditor.querySelector('[data-catalog]').options.length===1");
  // Leave one saved request pending, rotate the saved credential while its
  // editor remains mounted, then ensure the old response is ignored as well.
  await act("providerProbeFixture.catalogScenario.saved={label:'directory-stale-saved',hold:true};");await click('#providerDiscover');
  await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-stale-saved')");
  await act("providerProbeFixture.profile.revision++;providerProbeFixture.changed();providerProbeFixture.catalogPending.find(x=>x.label==='directory-stale-saved').release();");await settle();await act('openCatalog();');
  await check('lateSavedDirectoryCannotPopulateAfterCredentialRevisionChanges', "!catalogHas('directory-stale-saved')&&!providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-stale-saved/')");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act("providerProbeFixture.catalogScenario.saved={label:'directory-auth-updated',rotateAuth:true};providerProbeFixture.catalogAuthChanged=false;");
  await click('[data-provider-act=edit]');await waitFor('providerProbeFixture.catalogAuthChanged&&!providerDiscover.disabled');await act('openCatalog();');
  await check('savedDiscoveryAcceptsItsOwnAuthRevisionChangeAndCachesLatestProfile', "catalogHas('directory-auth-updated')&&providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-auth-updated/gpt-image-2')&&providerModelCatalog.get('fixture')?.profileKey===providerHealthProfileKey(providerProbeFixture.profile)");
  await act("providerProbeFixture.catalogBeforeUnrelatedChange=providerProbeFixture.discoveries.length;providerProbeFixture.changed([{...providerProbeFixture.profile,id:'unrelated-provider',name:'另一合成服务商',revision:99}]);");await settle();await act('openCatalog();');
  await check('unrelatedProviderChangePreservesCurrentEditorDirectory', "catalogHas('directory-auth-updated')&&providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-auth-updated/gpt-image-2')&&providerProbeFixture.discoveries.length===providerProbeFixture.catalogBeforeUnrelatedChange");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('#providerAdd')");await click('#providerAdd');
  await fill('#providerBaseUrl','https://new-directory.invalid/anthropic');await fill('#providerApiKey','synthetic-key-b');await click('#providerDiscover');
  await check('catalogChecksNeverAutoSelectNewImageRoutesSaveOrInvokeProbes', "providerProbeFixture.discoveries.at(-1).draft.id===''&&providerMediaEditor.querySelector('[data-catalog]').textContent.includes('directory-b/gpt-image-2')&&mediaBindingCount()===0&&providerProbeFixture.writes.length===providerProbeFixture.catalogWritesBefore&&providerProbeFixture.savedCalls.length+providerProbeFixture.draftCalls.length===providerProbeFixture.catalogProbeCallsBefore&&providerProbeFixture.imageRouteWrites.length===0");
  await click('#providerEditorBack');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await act("providerProbeFixture.catalogScenario.saved={label:'directory-save-ready'};");
  await click('[data-provider-act=edit]');await click('#providerDiscover');
  await addFirstCatalogModel();
  await select('#providerMediaEditor [data-protocol]', 'openai-images');
  await fill('#providerName','待保存的合成服务商');
  await act('providerProbeFixture.failUpdate=true;');await click('#providerEditorSave');
  await check('failedSaveUnlocksEditorAndRetainsDraftAndMediaBinding', "providerEditorStatus.textContent.includes('合成保存失败')&&!providerName.disabled&&!providerApiKey.disabled&&!providerEditorBack.disabled&&!providerEditorSave.disabled&&!providerMediaEditor.querySelector('[data-protocol]').disabled&&providerMediaEditor.querySelector('[data-protocol]').value==='openai-images'&&providerMediaEditor.querySelector('[data-id]').value==='directory-save-ready/gpt-image-2'&&providerName.value==='待保存的合成服务商'");
  await act(`
    const f=providerProbeFixture;f.failUpdate=false;f.catalogScenario.saved={label:'directory-save-held',hold:true};
    f.saveEditor=document.querySelector('.provider-editor');f.saveControls=Array.from(f.saveEditor.querySelectorAll('input,button,select,textarea'));
    f.saveMediaProtocol=providerMediaEditor.querySelector('[data-protocol]');f.saveBack=providerEditorBack;
  `);
  await click('#providerEditorSave');await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-save-held')");
  await act('providerProbeFixture.saveBack.click();providerProbeFixture.saveMediaProtocol.click();');
  await check('saveLocksInputsBackAndMediaBindingWhileDiscoveryIsPending', "providerProbeFixture.saveControls.every(control=>control.disabled)&&providerProbeFixture.saveEditor.isConnected&&providerProbeFixture.writes.at(-1).input.mediaModels.length===1&&providerProbeFixture.writes.at(-1).input.mediaModels[0].modelId==='directory-save-ready/gpt-image-2'&&providerProbeFixture.writes.at(-1).input.mediaModels[0].protocol==='openai-images'&&providerProbeFixture.saveMediaProtocol.value==='openai-images'");
  await act('renderProviderEditor(providerProbeFixture.saveEditor.parentElement,null,uiFixture.routes);');
  await fill('#providerName','另一份尚未保存的草稿');
  await act('providerProbeFixture.replacementEditor=document.querySelector(".provider-editor");providerProbeFixture.catalogPending.find(x=>x.label==="directory-save-held").release();');
  await waitFor("document.querySelector('#appToast.show')?.textContent.includes('服务商已更新')");await settle();
  await check('oldSaveCompletesItsSnapshotWithoutReplacingNewEditor', "providerProbeFixture.replacementEditor===document.querySelector('.provider-editor')&&providerName.value==='另一份尚未保存的草稿'&&!providerName.disabled&&providerProbeFixture.imageRouteWrites.length===0&&providerProbeFixture.writes.at(-1).input.mediaModels[0].modelId==='directory-save-ready/gpt-image-2'&&!providerProbeFixture.saveEditor.isConnected");
  // Let the actual debounce start an automatic directory request. Its late
  // success may update candidates, but must not erase a newer connection check.
  await act("providerProbeFixture.catalogScenario.drafts['synthetic-key-probe']={label:'directory-auto-probe',hold:true};");
  await fill('#providerBaseUrl','https://automatic-directory.invalid/anthropic');
  await fill('#providerApiKey','synthetic-key-probe');await fill('#providerModelHaiku','probe/fast');
  await waitFor("providerProbeFixture.catalogPending.some(x=>x.label==='directory-auto-probe')");
  await click('#providerEditorTest');
  await act("providerProbeFixture.probeStatusBeforeLateDirectory=providerEditorStatus.textContent;providerProbeFixture.catalogPending.find(x=>x.label==='directory-auto-probe').release();");await settle();await act('openCatalog();');
  await check('lateAutomaticDirectoryPreservesNewerConversationProbeStatus', "catalogHas('directory-auto-probe')&&providerProbeFixture.probeStatusBeforeLateDirectory.includes('快速')&&providerProbeFixture.probeStatusBeforeLateDirectory.includes('尚未保存')&&providerEditorStatus.textContent===providerProbeFixture.probeStatusBeforeLateDirectory");

  // The configured view is a compact list; fields are revealed only for one
  // row at a time. Test the actual native events as well as draft retention.
  await act(`
    const f=providerProbeFixture;f.catalogScenario.saved={label:'directory-polish'};
    f.profile.mediaModels=[
      {id:'studio-image',modelId:'studio/image-next',label:'工作室生图',protocol:'openai-images',modality:'image',enabled:true,capabilities:{operations:['text_to_image'],parameters:{size:{enum:['1024x1024']}},defaults:{size:'1024x1024'},references:{max:0}}},
      {id:'studio-video',modelId:'studio/video-next',label:'电影短片',protocol:'ark-video',modality:'video',enabled:true,capabilities:{operations:['text_to_video'],parameters:{duration:{enum:[4,6],integer:true}},defaults:{duration:4},references:{max:0}}}
    ];
    f.profile.mediaCatalog=[{id:'studio/catalog-image',ownedBy:'studio',modelType:'image'}];
    renderProviderEditor(document.querySelector('.provider-editor').parentElement,f.profile,uiFixture.routes);
  `);
  await waitFor("document.querySelectorAll('#providerMediaEditor .media-binding').length===2&&!providerMediaEditor.querySelector('[data-add]').disabled&&!providerDiscover.disabled");
  await waitFor("!document.querySelector('#appToast.show')");
  await check('configuredMediaStartsAsCompactRows', "(()=>{const rows=Array.from(providerMediaEditor.querySelectorAll('.media-binding'));return rows.length===2&&rows.every(row=>row.querySelector('[data-editor]').hidden&&row.getBoundingClientRect().height>=54&&row.getBoundingClientRect().height<=70)&&providerMediaEditor.querySelector('.media-connection').hidden&&providerMediaEditor.querySelector('[data-catalog]').hidden})()");
  await check('modelSummaryHasAccessibleControlsAndNoExposedSelect', "(()=>{const rows=Array.from(providerMediaEditor.querySelectorAll('.media-binding'));return rows.every(row=>row.querySelector('[data-edit]').getAttribute('aria-expanded')==='false'&&row.querySelector('[data-enabled]').getAttribute('role')==='switch'&&row.querySelector('[data-enabled]').getAttribute('aria-label').startsWith('启用 ')&&Array.from(row.querySelectorAll('select')).every(select=>!select.checkVisibility({visibilityProperty:true})))})()");
  for (const [name,width,theme] of [['media-compact-light-1200',1200,'light'],['media-compact-light-900',900,'light'],['media-compact-dark-900',900,'dark']]) {
    await resizeViewport(name,width);
    await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};providerMediaEditor.scrollIntoView({block:'center',behavior:'instant'});`);await settle();
    layouts[name]=await evaluate(`(()=>{const section=providerMediaEditor.getBoundingClientRect(),head=providerMediaEditor.querySelector('.media-section-head').getBoundingClientRect();return {section:{left:section.left,right:section.right,width:section.width},head:{height:head.height},rows:Array.from(providerMediaEditor.querySelectorAll('.media-binding-summary')).map(row=>{const r=row.getBoundingClientRect(),main=row.querySelector('[data-edit]').getBoundingClientRect(),toggle=row.querySelector('[data-enabled]').getBoundingClientRect();return {left:r.left,right:r.right,height:r.height,mainRight:main.right,toggleLeft:toggle.left,toggleRight:toggle.right}})}})()`);save();
    await check(name+'FitsWithoutCrowding',JSON.stringify(layouts[name].section.left>=0&&layouts[name].section.right<=width+2&&layouts[name].rows.every(row=>row.height>=54&&row.height<=70&&row.mainRight<=row.toggleLeft+1&&row.toggleRight<=row.right-8)));
    await capture(name);
  }
  await click('#providerMediaEditor .media-binding:first-child [data-edit]');
  await fill('#providerMediaEditor .media-binding:first-child [data-label]','未保存的名称草稿');
  await click('#providerMediaEditor .media-binding:nth-child(2) [data-edit]');
  await check('openingAnotherModelKeepsOneEditorAndFirstDraft', "(()=>{const rows=Array.from(providerMediaEditor.querySelectorAll('.media-binding'));return rows.filter(row=>!row.querySelector('[data-editor]').hidden).length===1&&rows[0].querySelector('[data-label]').value==='未保存的名称草稿'&&rows[1].querySelector('[data-edit]').getAttribute('aria-expanded')==='true'})()");
  await click('#providerMediaEditor .media-binding:first-child [data-edit]');
  await check('reopeningModelRestoresItsUnsavedDraft', "providerMediaEditor.querySelector('.media-binding:first-child [data-label]').value==='未保存的名称草稿'&&!providerMediaEditor.querySelector('.media-binding:first-child [data-editor]').hidden");
  await click('#providerMediaEditor .media-binding:first-child [data-done]');
  await check('doneCollapsesWithoutSavingAndReturnsFocus', "Array.from(providerMediaEditor.querySelectorAll('[data-editor]')).every(e=>e.hidden)&&document.activeElement===providerMediaEditor.querySelector('.media-binding:first-child [data-edit]')&&providerMediaEditor.querySelector('[data-name]').textContent==='未保存的名称草稿'");
  await act("providerMediaEditor.querySelector('.media-binding:first-child [data-enabled]').focus({preventScroll:true});");
  await key('Space');
  await check('mediaSwitchSupportsKeyboardWithoutOpeningEditor', "!providerMediaEditor.querySelector('[data-enabled]').checked&&providerMediaEditor.querySelector('[data-enabled]').getAttribute('aria-checked')==='false'&&providerMediaEditor.querySelector('[data-editor]').hidden");
  await key('Space');
  await check('mediaSwitchCanBeRestoredByKeyboard', "providerMediaEditor.querySelector('[data-enabled]').checked&&providerMediaEditor.querySelector('[data-enabled]').getAttribute('aria-checked')==='true'");
  await click('#providerMediaEditor .media-binding:first-child [data-edit]');
  await openAdvanced('#providerMediaEditor .media-binding:first-child');
  await act("providerMediaEditor.querySelector('.media-binding:first-child [data-protocol]').nextElementSibling.querySelector('.cs-trigger').scrollIntoView({block:'center',behavior:'instant'});providerMediaEditor.querySelector('.media-binding:first-child [data-protocol]').nextElementSibling.querySelector('.cs-trigger').focus({preventScroll:true});");
  await key('ArrowDown');
  await check('mediaProtocolMenuOpensToKeyboardSelection', "(()=>{const holder=providerMediaEditor.querySelector('.media-binding:first-child [data-protocol]').nextElementSibling;return holder.querySelector('.cs-popup').matches(':popover-open')&&holder.querySelector('.cs-trigger').getAttribute('aria-expanded')==='true'&&document.activeElement.getAttribute('role')==='option'})()");
  await key('Home');await key('ArrowDown');await key('Enter');
  await check('mediaProtocolMenuKeyboardSelectionUpdatesBinding', "(()=>{const select=providerMediaEditor.querySelector('.media-binding:first-child [data-protocol]'),holder=select.nextElementSibling;return select.value==='openai-images'&&holder.querySelector('.cs-popup').hidden&&document.activeElement===holder.querySelector('.cs-trigger')&&JSON.parse(providerMediaEditor.querySelector('.media-binding:first-child [data-json]').value).protocol==='openai-images'})()");
  await check('reselectingCurrentProtocolKeepsConfiguredCapabilities', "JSON.parse(providerMediaEditor.querySelector('.media-binding:first-child [data-json]').value).capabilities.defaults.size==='1024x1024'");
  await key('ArrowDown');await key('Escape');
  await check('mediaProtocolEscapeReturnsFocusWithoutChangingValue', "(()=>{const select=providerMediaEditor.querySelector('.media-binding:first-child [data-protocol]');return select.value==='openai-images'&&document.activeElement===select.nextElementSibling.querySelector('.cs-trigger')&&select.nextElementSibling.querySelector('.cs-popup').hidden})()");
  await act("document.documentElement.dataset.theme='light';providerMediaEditor.querySelector('.media-binding:first-child').scrollIntoView({block:'center',behavior:'instant'});");await capture('media-editor-light-900');
  await act("document.documentElement.dataset.theme='dark';");await capture('media-editor-dark-900');
  await openAdvanced('#providerMediaEditor .media-binding:first-child');
  await act("providerProbeFixture.templateTrigger=providerMediaEditor.querySelector('.media-binding:first-child [data-template]').nextElementSibling.querySelector('.cs-trigger');");
  await nativeClick('#providerMediaEditor .media-binding:first-child [data-template] + .media-choice .cs-trigger');
  await key('Home');
  for(let i=0,count=await evaluate("Array.from(providerMediaEditor.querySelector('.media-binding:first-child [data-template]').options).findIndex(o=>o.value==='openai-image')");i<count;i++)await key('ArrowDown');
  await key('Enter');
  await check('mediaTemplateSelectionPreservesEditorFocusAndDisclosure', "(()=>{const row=providerMediaEditor.querySelector('.media-binding:first-child'),template=row.querySelector('[data-template]');return template.value==='openai-image'&&providerProbeFixture.templateTrigger.isConnected&&document.activeElement===providerProbeFixture.templateTrigger&&row.querySelector('[data-advanced]').open&&!row.querySelector('[data-editor]').hidden&&JSON.parse(row.querySelector('[data-json]').value).capabilities.parameters.quality})()");
  await click('#providerMediaEditor .media-binding:first-child .media-json-details > summary');
  const editedBinding=await evaluate("(()=>{const value=JSON.parse(providerMediaEditor.querySelector('.media-binding:first-child [data-json]').value);value.label='JSON 修改名称';value.modelId='studio/edited-image';return JSON.stringify(value,null,2)})()");
  await act("const json=providerMediaEditor.querySelector('.media-binding:first-child [data-json]');json.scrollIntoView({block:'center',behavior:'instant'});json.focus();json.select();");
  await win.webContents.insertText(editedBinding);await settle();
  await nativeClick('#providerMediaEditor .media-binding:first-child [data-done]');
  await check('mediaJsonNativeBlurDoesNotSwallowDoneClick', "(()=>{const row=providerMediaEditor.querySelector('.media-binding:first-child');return row.querySelector('[data-editor]').hidden&&row.querySelector('[data-name]').textContent==='JSON 修改名称'&&row.querySelector('[data-id]').value==='studio/edited-image'&&document.activeElement===row.querySelector('[data-edit]')&&JSON.parse(row.querySelector('[data-json]').value).label==='JSON 修改名称'})()");
  await act("providerMediaEditor.querySelector('[data-add]').scrollIntoView({block:'center',behavior:'instant'});");
  await click('#providerMediaEditor [data-add]');
  await check('mediaAddOpensSearchInsteadOfInsertingEmptyBinding', "providerMediaEditor.querySelector('[data-add-popover]').matches(':popover-open')&&document.activeElement===providerMediaEditor.querySelector('[data-search]')&&mediaBindingCount()===2");
  await fill('#providerMediaEditor [data-search]','does-not-exist');
  await check('mediaCatalogSearchFiltersCandidates', "providerMediaEditor.querySelector('.media-catalog-empty').textContent==='未找到模型'&&providerMediaEditor.querySelectorAll('.media-catalog-option').length===0");
  await key('ArrowDown');
  await check('mediaAddKeyboardReachesManualAction', "document.activeElement===providerMediaEditor.querySelector('[data-add-manual]')");
  await key('Escape');
  await check('mediaAddEscapeClosesAndReturnsFocus', "!providerMediaEditor.querySelector('[data-add-popover]').matches(':popover-open')&&document.activeElement===providerMediaEditor.querySelector('[data-add]')");
  await key('Enter');
  await check('mediaAddKeyboardCanReopen', "providerMediaEditor.querySelector('[data-add-popover]').matches(':popover-open')&&document.activeElement===providerMediaEditor.querySelector('[data-search]')");
  await capture('media-add-search-dark-900');
  await click('#providerMediaEditor [data-add-manual]');
  await check('manualAddExpandsOnlyTheNewBinding', "mediaBindingCount()===3&&Array.from(providerMediaEditor.querySelectorAll('[data-editor]')).filter(e=>!e.hidden).length===1&&!providerMediaEditor.querySelector('.media-binding:last-child [data-editor]').hidden&&document.activeElement===providerMediaEditor.querySelector('.media-binding:last-child [data-id]')");

  await click('#providerMediaEditor [data-add]');
  await fill('#providerMediaEditor [data-search]','studio/catalog');
  await check('mediaSearchFindsRawCatalogIdentity', "providerMediaEditor.querySelectorAll('.media-catalog-option').length===1&&providerMediaEditor.querySelector('.media-catalog-option').textContent.includes('studio/catalog-image')");
  await nativeClick('#providerMediaEditor [data-catalog-check]:not(:disabled)');
  await click('#providerMediaEditor [data-add-selected]');
  await check('mediaCatalogSelectionAddsAndFocusesNewTemplate', "(()=>{const row=providerMediaEditor.querySelector('.media-binding:last-child');return mediaBindingCount()===4&&row.querySelector('[data-id]').value==='studio/catalog-image'&&row.querySelector('[data-owner]').value==='studio'&&!row.querySelector('[data-editor]').hidden&&Array.from(providerMediaEditor.querySelectorAll('[data-editor]')).filter(e=>!e.hidden).length===1&&document.activeElement===row.querySelector('[data-template]').nextElementSibling.querySelector('.cs-trigger')})()");

  // Exercise a real pending save/retry UI with a storage-layer failure response.
  // All credentials and model IDs below are synthetic; userData remains isolated.
  await act(`
    const f=providerProbeFixture;f.catalogScenario=null;f.failUpdate=false;
    f.profile={...f.profile,routed:false,activeTiers:[],mediaModels:[],mediaConnection:{preset:'custom'}};
    renderProviderEditor(document.querySelector('.provider-editor').parentElement,f.profile,uiFixture.routes);
    window.storageDraftSnapshot=()=>({
      name:providerName.value,url:providerBaseUrl.value,key:providerApiKey.value,
      models:[providerModelHaiku.value,providerModelSonnet.value,providerModelOpus.value],
      enabled:providerEnabled.classList.contains('on'),
      routeTiers:Array.from(document.querySelectorAll('[data-chat-route-tier].is-active'),node=>node.dataset.chatRouteTier),
      connection:JSON.parse(providerMediaEditor.querySelector('[data-connection]').value),
      bindings:Array.from(providerMediaEditor.querySelectorAll('[data-json]'),node=>JSON.parse(node.value)),
      bindingEnabled:Array.from(providerMediaEditor.querySelectorAll('[data-enabled]'),node=>node.checked)
    });
  `);
  await waitFor("!providerMediaEditor.querySelector('[data-add]').disabled&&!providerDiscover.disabled");
  await fill('#providerName','保存失败后仍保留的草稿');
  await fill('#providerBaseUrl','https://storage-draft.invalid/anthropic');
  await fill('#providerApiKey','synthetic-unsaved-replacement-key');
  await fill('#providerModelHaiku','draft/quick');await fill('#providerModelSonnet','draft/think');await fill('#providerModelOpus','draft/expert');
  await click('[data-chat-route-tier=sonnet]');
  await click('#providerMediaEditor [data-add]');await click('#providerMediaEditor [data-add-manual]');
  await fill('#providerMediaEditor [data-id]','draft/custom-video');
  await select('#providerMediaEditor [data-protocol]','ark-video');
  await act(`
    const row=providerMediaEditor.querySelector('.media-binding'),json=row.querySelector('[data-json]');
    const binding=JSON.parse(json.value);binding.label='未保存的视频';binding.enabled=false;
    binding.endpoint='/api/v3/contents/generations/tasks';binding.customDraft={retain:'nested-value'};
    binding.capabilities={operations:['text_to_video'],parameters:{duration:{enum:[4,6],integer:true}},defaults:{duration:6},references:{max:0}};
    json.value=JSON.stringify(binding,null,2);json.dispatchEvent(new Event('change',{bubbles:true}));
    providerMediaEditor.querySelector('[data-connection]').value=JSON.stringify({preset:'custom',baseUrl:'https://media-draft.invalid',authMode:'bearer',extraDraft:{keep:true}},null,2);
    const f=providerProbeFixture;f.storageBefore=JSON.stringify(f.profile);f.storageDraftBefore=JSON.stringify(storageDraftSnapshot());
    f.storageCommitsBefore=f.committedWrites;f.storageWritesBefore=f.writes.length;
    f.storageEditor=document.querySelector('.provider-editor');
    f.holdUpdate=true;f.updateFailure={ok:false,code:'PROVIDER_STORAGE_WRITE_FAILED',retryable:true,attempts:5,message:'配置文件暂时无法替换，已重试仍未保存。请稍后重试；若持续失败，请检查文件占用或权限。'};
  `);
  await click('#providerEditorSave');await waitFor('!!providerProbeFixture.releaseUpdate');
  await check('storageRetryKeepsEditorLockedAndDraftIntact', "providerProbeFixture.storageEditor===document.querySelector('.provider-editor')&&Array.from(providerProbeFixture.storageEditor.querySelectorAll('input,button,select,textarea')).every(node=>node.disabled)&&providerEditorSave.textContent==='保存中…'&&providerEditorStatus.textContent==='正在保存…'&&!providerEditorStatus.classList.contains('is-error')&&JSON.stringify(storageDraftSnapshot())===providerProbeFixture.storageDraftBefore&&providerProbeFixture.committedWrites===providerProbeFixture.storageCommitsBefore");
  await act("providerProbeFixture.changed([{...providerProbeFixture.profile,id:'storage-unrelated',name:'其他服务商'}]);providerEditorSave.click();providerEditorBack.click();");
  await check('storageRetryIgnoresDuplicateSaveAndUnrelatedRefresh', "providerProbeFixture.writes.length===providerProbeFixture.storageWritesBefore+1&&JSON.stringify(storageDraftSnapshot())===providerProbeFixture.storageDraftBefore&&providerProbeFixture.storageEditor.isConnected");
  await act('providerProbeFixture.releaseUpdate();');await waitFor('!providerEditorSave.disabled');
  await check('storageFailureShowsFriendlyVisibleAlertWithoutSystemPaths', "providerEditorStatus.textContent.includes('已重试仍未保存')&&providerEditorStatus.textContent.includes('当前填写内容已保留')&&!providerEditorStatus.textContent.includes('EPERM')&&!providerEditorStatus.textContent.includes('provider-profiles.json')&&providerEditorStatus.getAttribute('role')==='alert'&&providerEditorStatus.getAttribute('aria-live')==='assertive'&&providerEditorStatus.classList.contains('is-error')&&(()=>{const r=providerEditorStatus.getBoundingClientRect(),v=document.querySelector('#settingsModal .set-content').getBoundingClientRect();return r.top>=v.top-1&&r.bottom<=v.bottom+1&&providerEditorSave.getBoundingClientRect().bottom<=v.bottom+1})()");
  await check('storageFailurePreservesWholeDraftAndSavedProfile', "JSON.stringify(storageDraftSnapshot())===providerProbeFixture.storageDraftBefore&&JSON.stringify(providerProbeFixture.profile)===providerProbeFixture.storageBefore&&providerProbeFixture.committedWrites===providerProbeFixture.storageCommitsBefore&&providerApiKey.value==='synthetic-unsaved-replacement-key'");
  await check('storageFailureUnlocksRetryAndOriginalControls', "[providerName,providerBaseUrl,providerApiKey,providerModelHaiku,providerModelSonnet,providerModelOpus,providerEditorSave,providerEditorBack,providerEditorCancel,providerDiscover,providerEditorTest,...providerMediaEditor.querySelectorAll('[data-id],[data-protocol],[data-json],[data-connection],[data-enabled],button:not([data-add-selected])')].every(node=>!node.disabled)&&providerMediaEditor.querySelector('[data-add-selected]').disabled&&providerEnabled.getAttribute('aria-disabled')==='false'");
  await capture('storage-failure-draft-preserved');
  await act('providerProbeFixture.profile.revision++;providerProbeFixture.changed();');await settle();
  await check('storageFailureDraftSurvivesCurrentProviderRefresh', "JSON.stringify(storageDraftSnapshot())===providerProbeFixture.storageDraftBefore&&providerEditorStatus.textContent.includes('当前填写内容已保留')&&providerProbeFixture.storageEditor===document.querySelector('.provider-editor')");
  await act('providerProbeFixture.updateFailure=null;providerProbeFixture.holdUpdate=false;');
  await click('#providerEditorSave');await waitFor("!!document.querySelector('[data-provider-act=edit]')");
  await check('storageFailureCanRetrySameDraftAndCommitOnce', "(()=>{const f=providerProbeFixture,first=f.writes[f.storageWritesBefore].input,last=f.writes.at(-1).input;return f.writes.length===f.storageWritesBefore+2&&f.committedWrites===f.storageCommitsBefore+1&&JSON.stringify(first)===JSON.stringify(last)&&last.apiKey==='synthetic-unsaved-replacement-key'&&last.mediaModels[0].enabled===false&&last.mediaModels[0].customDraft.retain==='nested-value'&&last.mediaConnection.extraDraft.keep===true&&last.routeTiers.join(',')==='sonnet'&&f.profile.name===last.name&&f.profile.mediaModels[0].modelId==='draft/custom-video'&&!f.storageEditor.isConnected})()");

  await check('providerProbeFlowHasNoRendererErrors', 'uiFixture.errors.length===0');
  clearTimeout(deadline); step = 'complete'; save(); console.log(JSON.stringify({ passed: Object.keys(checks).length, output })); app.exit(0);
}).catch(error => { clearTimeout(deadline); errors.push(error.stack || String(error)); save(); console.error(error); app.exit(1); });
