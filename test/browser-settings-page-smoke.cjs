'use strict';
// Production settings shell with in-memory browser records; no real profile, network or downloads.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/browser-cleanup-page');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, failures = [], diagnostics = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, failures, diagnostics }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code), act = code => evaluate(`(()=>{${code}\n})()`);
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`); }
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function click(selector) { await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click()})()`); await settle(); }
async function key(keyCode) { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await settle(); }
async function choosePreference(name, value) {
  await click(`[data-browser-setting="${name}"]`);
  await waitFor(`document.querySelector('.rbs-dropdown:has([data-browser-setting="${name}"]) .cs-popup').matches(':popover-open')`);
  await click(`.rbs-dropdown:has([data-browser-setting="${name}"]) .cs-option[data-value="${value}"]`);
}
async function settleTransitions() {
  // Allow actual CSS transitions to finish; forcing finish() can leave capturePage on an older compositor frame.
  for (let pass = 0; pass < 3; pass++) {
    await settle();
    await evaluate(`Promise.race([Promise.allSettled(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished)),new Promise(resolve=>setTimeout(resolve,1000))])`);
  }
  await settle();
}
async function screenshot(name) { await settleTransitions(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function themeSnapshot() {
  return evaluate(`(()=>{const selectors=['.rbs-select','.set-nav-item[data-cat="browser"]','.set-nav-item[data-cat="general"]','#btnSettings'];return {theme:document.documentElement.dataset.theme,activeCategories:[...document.querySelectorAll('.set-nav-item.active')].map(node=>node.dataset.cat),controls:selectors.map(selector=>{const node=document.querySelector(selector),style=getComputedStyle(node);return {selector,background:style.backgroundColor,color:style.color,hovered:node.matches(':hover'),focused:node===document.activeElement}}),animations:document.getAnimations().map(animation=>({target:animation.effect?.target?.className,property:animation.transitionProperty,state:animation.playState}))}})()`);
}
function installFixture() {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  const state = window.browserSettingsFixture = {
    calls: [], listeners: new Set(), holding: true, settingsWaits: [], updateWaits: [], holdUpdate: false, failUpdate: false, external: [], opened: [], formMounts: [], formDestroys: 0,
    settings: { webLinkTarget: 'external', localLinkTarget: 'internal', searchEngine: 'bing', showFullUrl: false, downloadDirectory: 'C:/Synthetic/Downloads', askDownloadLocation: true },
    history: Array.from({ length: 56 }, (_, index) => ({ id: 'h-' + index, url: 'https://example.invalid/' + index, title: index === 0 ? '<img src=x onerror="window.__browserSettingsXss=1">' : index === 1 ? 'new-result' : '文档 ' + index, visitedAt: '2026-09-09T01:00:00Z' })),
    bookmarks: [{ id: 'b-1', url: 'http://localhost:3000', title: '本地预览', createdAt: '2026-09-09T01:00:00Z' }],
    downloads: [
      { id: 'd-1', filename: 'project.zip', url: 'https://example.invalid/project.zip', path: 'C:/Synthetic/Downloads/project.zip', state: 'progressing', receivedBytes: 256, totalBytes: 1024, canResume: true },
      { id: 'd-2', filename: 'readme.md', url: 'https://example.invalid/readme.md', path: 'C:/Synthetic/Downloads/readme.md', state: 'completed', receivedBytes: 512, totalBytes: 512, canResume: false },
      { id: 'd-3', filename: 'archive.zip', url: 'https://example.invalid/archive.zip', path: 'C:/Synthetic/Downloads/archive.zip', state: 'interrupted', receivedBytes: 48, totalBytes: 0, canResume: true },
    ],
    passwords: [{ recordId: 'p-1', origin: 'https://login.example.invalid', username: 'synthetic-user' }],
    contacts: [{ recordId: 'c-1', name: '本地合成联系人', email: 'synthetic@example.invalid', phone: '000-0000', address: 'Synthetic address' }],
    permissions: [{ origin: 'https://camera.example.invalid', permission: 'camera', decision: 'allow' }, { origin: 'https://maps.example.invalid', permission: 'location', decision: 'block' }],
  };
  state.emit = section => [...state.listeners].forEach(listener => listener({ type: 'profile', section }));
  state.finishSettings = () => { state.holding = false; state.settingsWaits.splice(0).forEach(resolve => resolve({ ok: true, settings: clone(state.settings) })); };
  const browser = {
    async invoke(input) {
      state.calls.push(clone(input)); const [kind, action] = input.action.split('.');
      if (input.action === 'settings.get') return state.holding ? new Promise(resolve => state.settingsWaits.push(resolve)) : { ok: true, settings: clone(state.settings) };
      if (input.action === 'settings.update') {
        if (state.failUpdate) { state.failUpdate = false; return { ok: false, error: '合成保存失败' }; }
        if (state.holdUpdate) await new Promise(resolve => state.updateWaits.push(resolve));
        if (state.failHeldUpdate) { state.failHeldUpdate = false; return { ok: false, error: '合成延迟保存失败' }; }
        Object.assign(state.settings, input.settings); state.emit('settings'); return { ok: true, settings: clone(state.settings) };
      }
      if (input.action === 'downloads.chooseDirectory') { if (state.cancelDirectory) { state.cancelDirectory = false; return { ok: true, canceled: true }; } state.settings.downloadDirectory = 'C:/Synthetic/Changed'; return { ok: true, settings: clone(state.settings) }; }
      if (input.action === 'passwords.reveal') return { ok: true, password: 'synthetic password value' };
      if (input.action === 'openLink') return input.url.includes('localhost') ? { ok: true, tab: { id: 'synthetic-browser', url: input.url } } : { ok: true, external: true };
      if (input.action === 'permissions.set') { state.permissions = state.permissions.filter(item => !(item.origin === input.origin && item.permission === input.permission)); if (input.decision !== 'ask') state.permissions.push({ origin: input.origin, permission: input.permission, decision: input.decision }); state.emit('permissions'); return { ok: true }; }
      if (input.action === 'permissions.remove') { state.permissions = state.permissions.filter(item => !(item.origin === input.origin && item.permission === input.permission)); return { ok: true }; }
      if (input.action === 'bookmarks.add') { const item = { id: 'b-' + (state.bookmarks.length + 1), url: input.url, title: input.title, createdAt: '2026-09-09T01:00:00Z' }; state.bookmarks.push(item); return { ok: true, item: clone(item) }; }
      if (input.action === 'data.clear') { if (state.holdClear) await new Promise(resolve => { state.clearWaiter = resolve; }); if (state.failClear) { state.failClear = false; return { ok: false, error: '合成清理失败' }; } if (input.history) state.history = []; if (input.permissions) state.permissions = []; return { ok: true }; }
      if (action === 'list') {
        if (kind === 'history' && state.holdHistory) await new Promise(resolve => { state.historyWaiter = resolve; });
        if (kind === 'downloads' && state.failDownloadsOnce) { state.failDownloadsOnce = false; return { ok: false, error: '合成下载读取失败' }; }
        if (kind === 'history' && input.query === 'old-result') return new Promise(resolve => { state.oldQuery = resolve; });
        const matched = (state[kind] || []).filter(item => !input.query || JSON.stringify(item).toLowerCase().includes(input.query.toLowerCase()));
        return { ok: true, total: matched.length, items: clone(matched.slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))) };
      }
      if (action === 'delete') { state[kind] = state[kind].filter(item => item.id !== input.recordId); return { ok: true }; }
      if (kind === 'downloads') { const item = state.downloads.find(item => item.id === input.recordId); if (action === 'pause') item.state = 'paused'; if (action === 'resume') item.state = 'progressing'; if (action === 'cancel') item.state = 'cancelled'; state.emit('downloads'); return { ok: true }; }
      return { ok: true, tabs: [], activeId: null, visible: false };
    },
    onEvent(listener) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
  };
  window.api = new Proxy(base, { get(target, key) { if (key === 'browser') return browser; if (key === 'openExternal') return url => state.external.push(url); return target[key]; } });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n') + `\n(${installFixture.toString()})();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}\nlocalStorage.clear();</script>`);
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1200, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive(); await waitFor('!!window.relayBrowserSettings&&providerRoutingLoaded&&!restoringActiveRuns');
  await act(`browserSettingsFixture.baseListeners=browserSettingsFixture.listeners.size;relayWorkspacePanel.openUrl=url=>browserSettingsFixture.opened.push(url);relayWorkspacePanel.showBrowserTab=tab=>browserSettingsFixture.opened.push(tab.url);`);
  await evaluate("openSettings('general')"); await waitFor("!!document.querySelector('#set-theme')");

  await act(`inputEl.value='保留的对话草稿';browserSettingsFixture.brandNode=$('set-theme');$('set-theme').dataset.value='dark';$('set-theme').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.set-nav-item[data-cat="browser"]').click();browserSettingsFixture.firstFrame={heading:document.querySelector('[data-browser-heading]')?.textContent,cards:document.querySelectorAll('[data-browser-general] .rbs-card').length};`);
  await check('SettingsCategoryBuildsBrowserShellImmediately', `browserSettingsFixture.firstFrame.heading==='浏览器'&&browserSettingsFixture.firstFrame.cards===5&&!!document.querySelector('.set-nav-item[data-cat="browser"] svg')&&getComputedStyle($('btnSettingsSave')).display==='none'`);
  await check('UnloadedPreferencesCannotBeChanged', `[...document.querySelectorAll('[data-browser-setting]')].every(node=>node.disabled)&&document.querySelector('[data-browser-status]').textContent.includes('读取')`);
  await act('browserSettingsFixture.finishSettings()'); await waitFor(`!document.querySelector('[data-browser-setting="webLinkTarget"]').disabled`);
  await check('GeneralControlsReflectConfirmedBackendPreferences', `document.querySelector('[data-browser-setting="webLinkTarget"]').value==='external'&&document.querySelector('[data-browser-setting="localLinkTarget"]').value==='internal'&&document.querySelector('[data-browser-setting="askDownloadLocation"]').getAttribute('aria-checked')==='true'&&document.querySelector('[data-browser-download-directory]').textContent==='C:/Synthetic/Downloads'`);
  await check('GeneralPreferencesUseRelayDropdownsInsteadOfNativeSelects', `document.querySelectorAll('.rbs-dropdown > button[data-browser-setting]').length===3&&!document.querySelector('select[data-browser-setting]')&&[...document.querySelectorAll('.rbs-dropdown .cs-popup')].every(node=>node.getAttribute('popover')==='manual'&&node.getAttribute('role')==='listbox')`);
  await act(`browserSettingsFixture.keyboardBefore=browserSettingsFixture.calls.filter(call=>call.action==='settings.update').length;browserSettingsFixture.keyboardChecks=[];`);
  for (const name of ['webLinkTarget', 'localLinkTarget', 'searchEngine']) {
    await act(`document.querySelector('[data-browser-setting="${name}"]').focus()`); await key('Down');
    await waitFor(`document.querySelector('.rbs-dropdown:has([data-browser-setting="${name}"]) .cs-popup').matches(':popover-open')`); await key('End');
    await act(`browserSettingsFixture.keyboardChecks.push(document.activeElement===document.querySelector('.rbs-dropdown:has([data-browser-setting="${name}"]) .cs-option:last-child'))`);
    await key('Escape'); await act(`browserSettingsFixture.keyboardChecks.push(document.activeElement===document.querySelector('[data-browser-setting="${name}"]')&&!document.querySelector('.rbs-dropdown .cs-popup:popover-open'))`);
  }
  await check('AllThreeDropdownsSupportKeyboardNavigationAndEscapeWithoutSaving', `browserSettingsFixture.keyboardChecks.every(Boolean)&&browserSettingsFixture.calls.filter(call=>call.action==='settings.update').length===browserSettingsFixture.keyboardBefore`);
  await act('browserSettingsFixture.holdUpdate=true'); await choosePreference('webLinkTarget', 'internal'); await waitFor('browserSettingsFixture.updateWaits.length===1');
  await check('DropdownPendingSaveKeepsConfirmedChoiceAndDisablesRepeatedChanges', `[...document.querySelectorAll('[data-browser-setting]')].every(node=>node.disabled)&&document.querySelector('[data-browser-setting="webLinkTarget"]').value==='external'&&document.querySelector('[data-browser-setting="webLinkTarget"]').textContent.includes('默认浏览器')&&!document.querySelector('.rbs-dropdown .cs-popup:popover-open')`);
  await act('browserSettingsFixture.holdUpdate=false;browserSettingsFixture.updateWaits.shift()()'); await waitFor(`document.querySelector('[data-browser-setting="webLinkTarget"]').value==='internal'&&!document.querySelector('[data-browser-setting="webLinkTarget"]').disabled`);
  await check('DropdownChoiceChangesOnlyAfterSuccessfulPersistence', `browserSettingsFixture.settings.webLinkTarget==='internal'&&document.querySelector('[data-browser-setting="webLinkTarget"]').textContent.includes('Relay 内置浏览器')&&document.querySelector('.rbs-dropdown:has([data-browser-setting="webLinkTarget"]) .cs-option[aria-selected="true"]').dataset.value==='internal'`);
  await choosePreference('webLinkTarget', 'external'); await waitFor(`document.querySelector('[data-browser-setting="webLinkTarget"]').value==='external'&&!document.querySelector('[data-browser-setting="webLinkTarget"]').disabled`);
  for (const [name, value] of [['localLinkTarget', 'external'], ['searchEngine', 'google']]) {
    await choosePreference(name, value); await waitFor(`document.querySelector('[data-browser-setting="${name}"]').value==='${value}'&&!document.querySelector('[data-browser-setting="${name}"]').disabled`);
  }
  await check('EveryDropdownSavesItsOwnPreferenceKey', `browserSettingsFixture.settings.localLinkTarget==='external'&&browserSettingsFixture.settings.searchEngine==='google'&&['webLinkTarget','localLinkTarget','searchEngine'].every(key=>browserSettingsFixture.calls.some(call=>call.action==='settings.update'&&Object.hasOwn(call.settings,key)))`);
  await act('browserSettingsFixture.holdUpdate=true;browserSettingsFixture.holdHistory=true'); await choosePreference('webLinkTarget', 'internal'); await waitFor('browserSettingsFixture.updateWaits.length===1');
  await evaluate("relayBrowserSettings.open('history')"); await waitFor('!!browserSettingsFixture.historyWaiter');
  await act('browserSettingsFixture.holdUpdate=false;browserSettingsFixture.updateWaits.shift()()'); await waitFor(`document.querySelector('[data-browser-setting="webLinkTarget"]').value==='internal'&&!document.querySelector('[data-browser-setting="webLinkTarget"]').disabled`);
  await check('LatePreferenceSuccessCannotReplaceAnotherSectionsLoadingStatus', `document.querySelector('[data-browser-status]').textContent==='正在读取记录…'&&document.querySelector('[data-browser-heading]').textContent==='浏览历史'&&browserSettingsFixture.settings.webLinkTarget==='internal'`);
  await act('browserSettingsFixture.holdHistory=false;browserSettingsFixture.historyWaiter()'); await waitFor(`document.querySelectorAll('.rbs-record').length===50`);
  await evaluate("relayBrowserSettings.open('general')"); await choosePreference('webLinkTarget', 'external'); await waitFor(`document.querySelector('[data-browser-setting="webLinkTarget"]').value==='external'&&!document.querySelector('[data-browser-setting="webLinkTarget"]').disabled`);
  await act('browserSettingsFixture.holdUpdate=true;browserSettingsFixture.failHeldUpdate=true;browserSettingsFixture.failDownloadsOnce=true'); await choosePreference('webLinkTarget', 'internal'); await waitFor('browserSettingsFixture.updateWaits.length===1');
  await evaluate("relayBrowserSettings.open('downloads')"); await waitFor(`document.querySelector('[data-browser-status]').textContent==='合成下载读取失败'`);
  await act('browserSettingsFixture.holdUpdate=false;browserSettingsFixture.updateWaits.shift()()'); await waitFor(`!document.querySelector('[data-browser-setting="webLinkTarget"]').disabled`);
  await check('LatePreferenceFailureCannotReplaceAnotherSectionsErrorStatus', `document.querySelector('[data-browser-status]').textContent==='合成下载读取失败'&&document.querySelector('.relay-browser-settings').classList.contains('has-error')&&browserSettingsFixture.settings.webLinkTarget==='external'`);
  await evaluate("relayBrowserSettings.open('general')");
  await act('browserSettingsFixture.holdUpdate=true'); await click('[data-browser-setting="showFullUrl"]'); await waitFor('browserSettingsFixture.updateWaits.length===1');
  await check('PendingToggleWaitsForActualSave', `document.querySelector('[data-browser-setting="showFullUrl"]').disabled&&document.querySelector('[data-browser-setting="showFullUrl"]').getAttribute('aria-checked')==='false'`);
  await act('browserSettingsFixture.holdUpdate=false;browserSettingsFixture.updateWaits.shift()()'); await waitFor(`document.querySelector('[data-browser-setting="showFullUrl"]').getAttribute('aria-checked')==='true'&&!document.querySelector('[data-browser-setting="showFullUrl"]').disabled`);
  await act(`browserSettingsFixture.failUpdate=true`); await choosePreference('webLinkTarget', 'internal');
  await waitFor(`document.querySelector('[data-browser-status]').textContent.includes('合成保存失败')`);
  await check('RejectedPreferenceReturnsToConfirmedValue', `document.querySelector('[data-browser-setting="webLinkTarget"]').value==='external'&&browserSettingsFixture.settings.webLinkTarget==='external'&&document.querySelector('[data-browser-setting="webLinkTarget"]').textContent.includes('默认浏览器')&&document.querySelector('.rbs-dropdown:has([data-browser-setting="webLinkTarget"]) .cs-option[aria-selected="true"]').dataset.value==='external'`);
  await act(`$('setContent').scrollTop=0`); await click('[data-browser-setting="webLinkTarget"]'); await settleTransitions();
  await act(`browserSettingsFixture.menuTop=document.querySelector('.rbs-dropdown .cs-popup:popover-open').getBoundingClientRect().top;$('setContent').scrollTop+=24`); await settleTransitions();
  await check('BrowserDropdownTracksItsAnchorWhileSettingsScrolls', `(()=>{const popup=document.querySelector('.rbs-dropdown .cs-popup:popover-open'),trigger=document.querySelector('[data-browser-setting="webLinkTarget"]');if(!popup)return false;const p=popup.getBoundingClientRect(),r=trigger.getBoundingClientRect();return Math.abs(p.top-browserSettingsFixture.menuTop)>15&&Math.min(Math.abs(p.top-r.bottom-4),Math.abs(r.top-p.bottom-4))<2})()`);
  await act(`$('setContent').scrollTop+=500`); await settleTransitions();
  await check('ClippedBrowserDropdownClosesInsteadOfDriftingOverOtherSettings', `!document.querySelector('.rbs-dropdown .cs-popup:popover-open')&&document.querySelector('[data-browser-setting="webLinkTarget"]').getAttribute('aria-expanded')==='false'`);
  await act(`$('setContent').scrollTop=0`); await click('[data-browser-setting="searchEngine"]'); await click('.set-nav-item[data-cat="general"]');
  await check('LeavingBrowserSettingsClosesItsTopLayerDropdown', `!document.querySelector('.rbs-dropdown .cs-popup:popover-open')&&[...document.querySelectorAll('.rbs-dropdown .cs-popup')].every(node=>node.hidden)`);
  await click('.set-nav-item[data-cat="browser"]');
  await act('browserSettingsFixture.cancelDirectory=true'); await click('[data-browser-directory]'); await waitFor(`!document.querySelector('[data-browser-directory]').disabled`);
  await check('CancelledDirectoryPickerPreservesDestination', `document.querySelector('[data-browser-download-directory]').textContent==='C:/Synthetic/Downloads'`);
  await click('[data-browser-directory]'); await waitFor(`document.querySelector('[data-browser-download-directory]').textContent==='C:/Synthetic/Changed'`);
  await act(`document.activeElement?.blur();$('setContent').scrollTop=0;`); await screenshot('browser-settings-light');
  await evaluate("relayBrowserSettings.open('history')"); await waitFor(`document.querySelectorAll('.rbs-record').length===50`);
  await check('HistoryUsesSearchablePagedSafeText', `document.querySelector('.rbs-record-title').textContent.includes('<img')&&!document.querySelector('.rbs-record img')&&window.__browserSettingsXss===undefined&&document.querySelector('[data-browser-total]').textContent==='1–50 / 56'`);
  await click('[data-browser-next]'); await waitFor(`document.querySelectorAll('.rbs-record').length===6`);
  await check('HistoryPaginationUsesOffsetAndCorrectTotal', `browserSettingsFixture.calls.some(item=>item.action==='history.list'&&item.offset===50&&item.limit===50)&&document.querySelector('[data-browser-next]').disabled`);
  await act(`const search=document.querySelector('[data-browser-search]');search.value='old-result';search.dispatchEvent(new Event('input',{bubbles:true}));`); await waitFor('!!browserSettingsFixture.oldQuery');
  await act(`const search=document.querySelector('[data-browser-search]');search.value='new-result';search.dispatchEvent(new Event('input',{bubbles:true}));`); await waitFor(`document.querySelectorAll('.rbs-record').length===1&&document.querySelector('.rbs-record-title').textContent==='new-result'`);
  await act(`browserSettingsFixture.oldQuery({ok:true,total:1,items:[{id:'stale',title:'STALE QUERY',url:'https://example.invalid/stale'}]})`); await settle();
  await check('LateSearchCannotReplaceNewerResults', `document.querySelector('.rbs-record-title').textContent==='new-result'&&document.querySelector('[data-browser-search]').value==='new-result'`);
  await click('.rbs-record [data-browser-action="open"]'); await check('HistoryOpensThroughWorkspaceBrowserEntry', `browserSettingsFixture.opened.at(-1)==='https://example.invalid/1'&&browserSettingsFixture.external.length===0`);
  await click('.rbs-record [data-browser-action="delete"]'); await waitFor(`document.querySelector('.rbs-empty')?.textContent==='没有匹配的记录'`);
  await evaluate("relayBrowserSettings.open('bookmarks')"); await waitFor(`document.querySelectorAll('.rbs-record').length===1`); await click('[data-browser-add]');
  await act(`const form=document.querySelector('[data-browser-add-form]');form.elements.url.value='https://example.invalid/new';form.elements.title.value='新增书签';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`); await waitFor(`document.querySelectorAll('.rbs-record').length===2`);
  await check('BookmarkFormSavesRealRecordThenRefreshesList', `browserSettingsFixture.bookmarks.some(item=>item.title==='新增书签')&&document.querySelector('[data-browser-add-form]').hidden`);
  await evaluate("relayBrowserSettings.open('permissions')"); await waitFor(`document.querySelectorAll('.rbs-record').length===2`);
  await act(`const select=document.querySelector('[data-browser-permission-decision]');select.value='ask';select.dispatchEvent(new Event('change',{bubbles:true}));`); await waitFor(`document.querySelectorAll('.rbs-record').length===1`);
  await check('PermissionResetRemovesSavedRule', `browserSettingsFixture.permissions.length===1&&!browserSettingsFixture.permissions.some(item=>item.permission==='camera')`);
  await click('[data-browser-add]'); await act(`const form=document.querySelector('[data-browser-add-form]');form.elements.origin.value='https://voice.example.invalid';form.elements.permission.value='microphone';form.elements.decision.value='allow';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`); await waitFor(`document.querySelectorAll('.rbs-record').length===2`);
  await check('PermissionEditorSavesExplicitOriginAndCapability', `browserSettingsFixture.permissions.some(item=>item.origin==='https://voice.example.invalid'&&item.permission==='microphone'&&item.decision==='allow')`);
  await act(`browserSettingsFixture.permissionSeed=browserSettingsFixture.permissions.slice();for(let index=0;index<105;index++)browserSettingsFixture.permissions.push({origin:'https://permission-'+index+'.example.invalid',permission:'notifications',decision:'block'});browserSettingsFixture.emit('permissions');`); await waitFor(`document.querySelectorAll('.rbs-record').length===50&&document.querySelector('[data-browser-total]').textContent.endsWith('/ 107')`);
  await click('[data-browser-next]'); await waitFor(`document.querySelector('[data-browser-total]').textContent==='51–100 / 107'`); await click('[data-browser-next]'); await waitFor(`document.querySelector('[data-browser-total]').textContent==='101–107 / 107'`);
  await check('SitePermissionsRemainReachableBeyondBackendDefaultPageSize', `document.querySelectorAll('.rbs-record').length===7&&[...document.querySelectorAll('.rbs-record-title')].some(node=>node.textContent==='https://permission-104.example.invalid')&&browserSettingsFixture.calls.some(item=>item.action==='permissions.list'&&item.offset===100&&item.limit===50)`);
  await evaluate("relayBrowserSettings.open('downloads')"); await waitFor(`document.querySelectorAll('.rbs-record').length===3`);
  await check('DownloadRowsExposeOnlyApplicableControlsAndProgress', `(()=>{const active=document.querySelector('[data-browser-record="d-1"]'),done=document.querySelector('[data-browser-record="d-2"]');return active.querySelector('progress').value===25&&!active.querySelector('[data-browser-action="pause"]').hidden&&active.querySelector('[data-browser-action="delete"]').hidden&&!done.querySelector('[data-browser-action="showInFolder"]').hidden&&done.querySelector('[data-browser-action="pause"]').hidden})()`);
  await act(`browserSettingsFixture.progressNode=document.querySelector('[data-browser-record="d-1"] progress');browserSettingsFixture.downloads[0].receivedBytes=768;for(const listener of browserSettingsFixture.listeners)listener({type:'download',item:{...browserSettingsFixture.downloads[0]},status:'progressing'});`); await waitFor(`document.querySelector('[data-browser-record="d-1"] progress').value===75`);
  await check('NativeDownloadEventsUpdateProgressWithoutProfileEventsOrManualRefresh', `document.querySelector('[data-browser-record="d-1"] progress')===browserSettingsFixture.progressNode&&document.querySelector('[data-browser-record="d-1"] .rbs-record-detail').textContent.includes('768 B')`);
  await act(`browserSettingsFixture.downloadNode=document.querySelector('[data-browser-record="d-1"]');browserSettingsFixture.downloadButton=browserSettingsFixture.downloadNode.querySelector('[data-browser-action="pause"]');`);
  await click('[data-browser-record="d-1"] [data-browser-action="pause"]'); await waitFor(`document.querySelector('[data-browser-record="d-1"] .rbs-record-detail').textContent.includes('已暂停')`);
  await check('DownloadUpdatesPreserveRowsAndTheirActionNodes', `document.querySelector('[data-browser-record="d-1"]')===browserSettingsFixture.downloadNode&&browserSettingsFixture.downloadNode.querySelector('[data-browser-action="pause"]')===browserSettingsFixture.downloadButton&&!browserSettingsFixture.downloadNode.querySelector('[data-browser-action="resume"]').hidden`);
  await click('[data-browser-record="d-1"] [data-browser-action="resume"]'); await waitFor(`browserSettingsFixture.downloads[0].state==='progressing'`);
  await click('[data-browser-record="d-1"] [data-browser-action="cancel"]'); await waitFor(`browserSettingsFixture.downloads[0].state==='cancelled'`);
  await click('[data-browser-record="d-2"] [data-browser-action="showInFolder"]');
  await check('DownloadActionsUseOwnedRecordIdentifiers', `['pause','resume','cancel'].every(action=>browserSettingsFixture.calls.some(item=>item.action==='downloads.'+action&&item.recordId==='d-1'))&&browserSettingsFixture.calls.some(item=>item.action==='downloads.showInFolder'&&item.recordId==='d-2')`);
  await evaluate("relayBrowserSettings.open('general')");
  await act(`browserSettingsFixture.clearBefore=browserSettingsFixture.calls.filter(item=>item.action==='data.clear').length;`);
  await check('BrowserGeneralShowsOnlyCleanupManagerEntry', `document.querySelector('[data-browser-clear-panel]').hidden&&!!document.querySelector('[data-browser-general] [data-browser-section="clear"]')&&!document.querySelector('[data-browser-general] [data-browser-clear]')`);
  await click('[data-browser-section="clear"]');
  await check('CleanupOpensAsItsOwnPageWithoutListRequests', `document.querySelector('[data-browser-heading]').textContent==='清理浏览数据'&&!document.querySelector('[data-browser-back]').hidden&&document.querySelector('[data-browser-general]').hidden&&document.querySelector('[data-browser-manager]').hidden&&!document.querySelector('[data-browser-clear-panel]').hidden&&document.querySelector('[data-browser-refresh]').hidden&&!browserSettingsFixture.calls.some(item=>item.action==='clear.list')`);
  await check('ClearDataRequiresExplicitSelectionAndSubmission', `!document.querySelector('[data-browser-clear-panel]').hidden&&browserSettingsFixture.clearBefore===0&&!document.querySelector('[data-browser-clear="cookies"]').checked&&!document.querySelector('[data-browser-clear="permissions"]').checked&&document.querySelectorAll('[data-browser-clear]').length===4`);
  await act(`applyThemeToDOM('light');$('setContent').scrollTop=0;`); await screenshot('browser-cleanup-light');
  await act('browserSettingsFixture.holdClear=true'); await click('[data-browser-clear-submit]'); await waitFor(`!!browserSettingsFixture.clearWaiter`);
  await check('PendingClearDisablesCategoryChangesResetAndDuplicateSubmission', `[...document.querySelectorAll('[data-browser-clear]')].every(input=>input.disabled)&&document.querySelector('[data-browser-clear-cancel]').disabled&&document.querySelector('[data-browser-clear-submit]').disabled&&document.querySelector('[data-browser-clear-panel]').getAttribute('aria-busy')==='true'&&document.querySelector('[data-browser-status]').textContent==='正在清理…'`);
  await click('[data-browser-clear-submit]'); await check('PendingClearIsSubmittedOnlyOnce', `browserSettingsFixture.calls.filter(item=>item.action==='data.clear').length===1`);
  await click('[data-browser-back]'); await evaluate("relayBrowserSettings.open('history')"); await waitFor(`document.querySelector('[data-browser-heading]').textContent==='浏览历史'`);
  await act('browserSettingsFixture.holdClear=false;browserSettingsFixture.clearWaiter()'); await waitFor(`!document.querySelector('[data-browser-clear="history"]').disabled`);
  await check('ClearCompletionCannotReplaceAnotherPagesStatus', `document.querySelector('[data-browser-heading]').textContent==='浏览历史'&&!document.querySelector('[data-browser-status]').textContent.includes('清理')`);
  await evaluate("relayBrowserSettings.open('clear')");
  await check('ClearDataHonorsSelectedCategoriesAndKeepsBookmarksAndFiles', `(()=>{const call=browserSettingsFixture.calls.findLast(item=>item.action==='data.clear');return call.history&&call.cache&&!call.cookies&&!call.permissions&&browserSettingsFixture.bookmarks.length===2&&browserSettingsFixture.downloads.length===3})()`);
  await check('ReturningToCleanupRetainsCompletionStatusAndResetsSelections', `!document.querySelector('[data-browser-clear-panel]').hidden&&[...document.querySelectorAll('[data-browser-clear]')].every(input=>!input.checked)&&document.querySelector('[data-browser-clear-submit]').disabled&&document.querySelector('[data-browser-status]').textContent==='所选数据已清理'`);
  await click('[data-browser-clear="cookies"]'); await click('[data-browser-clear-cancel]');
  await check('ResetDataSelectionNeverClearsDataOrLeavesThePage', `!document.querySelector('[data-browser-clear-panel]').hidden&&[...document.querySelectorAll('[data-browser-clear]')].every(input=>!input.checked)&&browserSettingsFixture.calls.filter(item=>item.action==='data.clear').length===browserSettingsFixture.clearBefore+1`);
  await click('[data-browser-clear="permissions"]'); await act('browserSettingsFixture.failClear=true'); await click('[data-browser-clear-submit]'); await waitFor(`document.querySelector('[data-browser-status]').textContent==='合成清理失败'`);
  await check('FailedClearKeepsSelectionAndReenablesRetry', `document.querySelector('[data-browser-clear="permissions"]').checked&&!document.querySelector('[data-browser-clear-submit]').disabled&&document.querySelector('.relay-browser-settings').classList.contains('has-error')`);
  await click('[data-browser-back]'); await check('CleanupBackRestoresGeneralAndRefreshControl', `document.querySelector('[data-browser-heading]').textContent==='浏览器'&&!document.querySelector('[data-browser-general]').hidden&&document.querySelector('[data-browser-clear-panel]').hidden&&!document.querySelector('[data-browser-refresh]').hidden`);
  await evaluate("relayBrowserSettings.open('clear')"); await check('ClearFailureIsRetainedWhenReturningToItsPage', `document.querySelector('[data-browser-status]').textContent==='合成清理失败'&&document.querySelector('[data-browser-clear="permissions"]').checked`);
  await click('[data-browser-clear-submit]'); await waitFor(`document.querySelector('[data-browser-status]').textContent==='所选数据已清理'`);
  await check('RetryClearsOnlyTheRetainedSelectedCategory', `(()=>{const call=browserSettingsFixture.calls.findLast(item=>item.action==='data.clear');return call.permissions&&!call.history&&!call.cache&&!call.cookies&&browserSettingsFixture.permissions.length===0})()`);
  await evaluate("relayBrowserSettings.open('passwords')"); await waitFor(`!!document.querySelector('[data-form-record="p-1"]')`);
  await check('PasswordManagerMountsInsideTheSharedSettingsShell', `document.querySelector('[data-browser-heading]').textContent==='密码管理器'&&document.querySelector('[data-form-record="p-1"]').textContent.includes('synthetic-user')&&!browserSettingsFixture.calls.some(item=>item.action==='passwords.reveal')`);
  await click('[data-form-record="p-1"] [data-form-action="reveal"]'); await waitFor(`document.querySelector('[data-form-secret]').textContent==='synthetic password value'`);
  await act(`browserSettingsFixture.secretNode=document.querySelector('[data-form-secret]');browserSettingsFixture.formsNode=document.querySelector('.relay-browser-forms');`);
  await click('.set-nav-item[data-cat="general"]');
  await check('LeavingBrowserSettingsDestroysSensitiveFormContents', `!document.querySelector('[data-browser-forms] input')&&browserSettingsFixture.secretNode.hidden&&browserSettingsFixture.secretNode.textContent==='••••••••'`);
  await click('.set-nav-item[data-cat="browser"]'); await waitFor(`!!document.querySelector('[data-form-record="p-1"]')`);
  await check('ReturningToFormManagerMountsFreshContents', `document.querySelector('.relay-browser-forms')!==browserSettingsFixture.formsNode&&document.querySelector('[data-form-secret]').hidden`);
  await evaluate("relayBrowserSettings.open('contacts')"); await waitFor(`!!document.querySelector('[data-form-record="c-1"]')`);
  await click('[data-form-record="c-1"] [data-form-action="edit"]'); await act(`browserSettingsFixture.contactField=document.querySelector('[data-form-field="phone"]');browserSettingsFixture.contactField.value='synthetic unsaved contact';showChatView();`);
  await check('LeavingSettingsViewAlsoClearsFormContents', `!document.querySelector('[data-browser-forms] input')&&browserSettingsFixture.contactField.value===''`);
  await evaluate("relayBrowserSettings.open('general')");
  await check('OtherSettingsAndChatDraftsRemainUnchanged', `$('set-theme')===browserSettingsFixture.brandNode&&$('set-theme').dataset.value==='dark'&&inputEl.value==='保留的对话草稿'&&workspaceFixture.settingsWrites.length===0`);
  await evaluate('relayBrowserSettings.openLink("http://localhost:3000")'); await evaluate('relayBrowserSettings.openLink("https://example.invalid")'); await evaluate('relayBrowserSettings.openLink("mailto:test@example.invalid")');
  await check('PublicLinkRoutingUsesBackendDecisionAndSystemMailHandler', `browserSettingsFixture.opened.at(-1)==='http://localhost:3000'&&browserSettingsFixture.external.length===1&&browserSettingsFixture.external[0]==='mailto:test@example.invalid'`);
  await act(`browserSettingsFixture.listenersBeforeRebuild=browserSettingsFixture.listeners.size;`); await evaluate("loadSettingsForm('browser')"); await waitFor(`!!document.querySelector('.relay-browser-settings')&&!document.querySelector('[data-browser-setting="webLinkTarget"]').disabled`);
  await check('RebuildingSettingsDoesNotLeakBrowserSubscriptions', `browserSettingsFixture.listeners.size===browserSettingsFixture.listenersBeforeRebuild`);
  win.setSize(900, 680); await waitFor('innerWidth<=900'); await act(`applyThemeToDOM('dark');$('setContent').scrollTop=0;`);
  diagnostics.darkThemeBeforeSettling = await themeSnapshot();
  await settleTransitions(); diagnostics.darkThemeSettled = await themeSnapshot();
  await check('DarkBrowserControlsRetainReadableContrastAfterThemeTransition', `(()=>{function luminance(color){const parts=color.match(/[\\d.]+/g).slice(0,3).map(value=>{value=Number(value)/255;return value<=.04045?value/12.92:Math.pow((value+.055)/1.055,2.4)});return parts[0]*.2126+parts[1]*.7152+parts[2]*.0722}return document.documentElement.dataset.theme==='dark'&&[...document.querySelectorAll('.rbs-select')].every(node=>{const style=getComputedStyle(node),foreground=luminance(style.color),background=luminance(style.backgroundColor);return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)>=4.5})&&document.querySelectorAll('.set-nav-item.active').length===1&&document.querySelector('.set-nav-item.active').dataset.cat==='browser'})()`);
  await check('DefaultNarrowWindowFitsBrowserSettingsWithoutHorizontalScroll', `(()=>{const page=document.querySelector('.relay-browser-settings');return page.scrollWidth<=page.clientWidth+1&&$('setContent').scrollWidth<=$('setContent').clientWidth+1&&document.documentElement.scrollWidth<=innerWidth&&[...page.querySelectorAll('.rbs-row')].every(row=>row.scrollWidth<=row.clientWidth+1)})()`);
  await click('[data-browser-setting="searchEngine"]'); await settleTransitions();
  await check('DarkNarrowDropdownRemainsWithinViewportAndAnchoredToItsTrigger', `(()=>{const popup=document.querySelector('.rbs-dropdown .cs-popup:popover-open'),trigger=document.querySelector('[data-browser-setting="searchEngine"]');if(!popup)return false;const p=popup.getBoundingClientRect(),r=trigger.getBoundingClientRect();return p.left>=9&&p.right<=innerWidth-9&&p.top>=9&&p.bottom<=innerHeight-9&&Math.min(Math.abs(p.top-r.bottom-4),Math.abs(r.top-p.bottom-4))<2&&getComputedStyle(popup).backgroundColor===getComputedStyle(document.querySelector('.rbs-card')).backgroundColor})()`);
  await screenshot('browser-settings-dark-narrow');
  await evaluate("relayBrowserSettings.open('clear')"); await click('[data-browser-clear-cancel]'); await act(`$('setContent').scrollTop=0;`); await settleTransitions();
  await check('CleanupDarkNarrowPageFitsWithoutHorizontalScroll', `(()=>{const page=document.querySelector('.relay-browser-settings'),panel=document.querySelector('[data-browser-clear-panel]');return !panel.hidden&&page.scrollWidth<=page.clientWidth+1&&$('setContent').scrollWidth<=$('setContent').clientWidth+1&&document.documentElement.scrollWidth<=innerWidth&&[...panel.querySelectorAll('.rbs-row')].every(row=>row.scrollWidth<=row.clientWidth+1)&&document.documentElement.dataset.theme==='dark'})()`);
  await screenshot('browser-cleanup-dark-narrow');
  await act(`document.querySelector('.relay-browser-settings').style.width='320px';$('setContent').scrollTop=0;`); await settleTransitions();
  diagnostics.cleanupCompact = await evaluate(`(()=>{const panel=document.querySelector('[data-browser-clear-panel]');return {width:panel.getBoundingClientRect().width,client:panel.clientWidth,scroll:panel.scrollWidth,controls:[...panel.querySelectorAll('input,button')].map(node=>{const box=node.getBoundingClientRect(),p=panel.getBoundingClientRect();return {tag:node.tagName,left:box.left-p.left,right:box.right-p.right}})}})()`);
  await check('CleanupVeryNarrowContentKeepsAllControlsInsideItsColumn', `(()=>{const panel=document.querySelector('[data-browser-clear-panel]');return panel.getBoundingClientRect().width<=360&&panel.scrollWidth<=panel.clientWidth+1&&[...panel.querySelectorAll('input,button')].every(node=>{const box=node.getBoundingClientRect(),p=panel.getBoundingClientRect();return box.left>=p.left&&box.right<=p.right+1})})()`);
  await screenshot('browser-cleanup-dark-compact');
  await check('RendererRemainsSandboxedWithoutRuntimeErrors', `uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'`);
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => { failures.push(String(error.stack || error)); save(); console.error(error.stack); try { if (win && !win.isDestroyed()) { await screenshot('failure'); console.error(await evaluate('JSON.stringify(uiFixture.errors)')); } } catch (_) {} clearTimeout(deadline); app.exit(1); });
