'use strict';

// Run this file with Electron, never Relay's main.js. The real renderer receives
// only browser mocks, with an isolated profile and all HTTP(S) requests blocked.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = process.env.RELAY_SMOKE_OUTPUT ? path.resolve(process.env.RELAY_SMOKE_OUTPUT) : path.join(root, '.codex-tmp', 'workspace-navigation-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win;
const results = {}, failures = [];
const deadline = setTimeout(() => { console.error('Workspace UI check timed out'); app.exit(1); }, 160000);
const evaluate = source => win.webContents.executeJavaScript(source);
const act = source => evaluate(`(() => { ${source}\n })()`);
const settle = async () => {
  await evaluate("document.getAnimations().forEach(a=>{ if(a.effect && a.effect.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} });");
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
};
async function waitFor(source) {
  await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 5000; const tick = () => { if (${source}) return resolve(true); if (Date.now() > end) return reject(new Error('UI state timeout: ' + ${JSON.stringify(source)})); setTimeout(tick, 20); }; tick(); })`);
}
async function check(name, source) {
  const value = await evaluate(source);
  results[name] = !!value;
  if (!value) { failures.push(name); throw new Error(name + ' failed'); }
}
async function click(selector) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing click target: ' + ${JSON.stringify(selector)}); el.click(); })()`);
  await settle();
}
async function capture(name) {
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect && animation.effect.getComputedTiming().iterations !== Infinity) { try { animation.finish(); } catch (_) {} } });");
  await win.webContents.capturePage(); await settle();
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function checkPageHeader(name, page, surface, title) {
  await check(name + 'ContentStartsBelowWindowChromeWithoutExtraStrip', `(() => {
    const page = document.querySelector(${JSON.stringify(page)}), surface = document.querySelector(${JSON.stringify(surface)});
    const chrome = document.getElementById('windowChrome');
    return !page.querySelector(':scope > .workspace-header') && !page.querySelector('[data-return-conversation]') &&
      Math.abs(surface.getBoundingClientRect().top - page.getBoundingClientRect().top) <= 1 &&
      Math.abs(page.getBoundingClientRect().top - chrome.getBoundingClientRect().bottom) <= 1 &&
      workspaceFits('#btnToggleSidebar') && workspaceFits('#btnWorkspacePanel');
  })()`);
  await check(name + 'KeepsBodyHeading', `workspaceVisible(${JSON.stringify(title)}) && document.querySelector(${JSON.stringify(title)}).textContent.trim().length > 0`);
}
async function checkSchedulerHeader(name) {
  // The scheduler now has task/record tabs, not the retired page-title strip.
  // Check both seams so a restored title spacer cannot hide behind the tab bar.
  await check(name + 'TabsAndContentStartBelowChromeWithoutExtraStrip', `(() => {
    const page = document.getElementById('scheduleModal'), chrome = document.getElementById('windowChrome');
    const header = page.querySelector(':scope > .sv-page-header'), surface = page.querySelector(':scope > .workspace-surface');
    const tabs = header?.querySelector('[role=tablist]');
    return !!tabs && page.querySelectorAll(':scope > .workspace-header').length === 1 && header.firstElementChild === tabs &&
      !header.querySelector('.workspace-title, .modal-title, [data-return-conversation]') &&
      Math.abs(page.getBoundingClientRect().top - chrome.getBoundingClientRect().bottom) <= 1 &&
      Math.abs(header.getBoundingClientRect().top - page.getBoundingClientRect().top) <= 1 &&
      Math.abs(surface.getBoundingClientRect().top - header.getBoundingClientRect().bottom) <= 1 &&
      ['svTasksTab','svRunsTab'].every(id => {
        const button = document.getElementById(id), panel = document.getElementById(button.getAttribute('aria-controls'));
        return workspaceFits('#' + id) && button.getAttribute('role') === 'tab' &&
          panel?.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === id &&
          workspaceVisible('#' + panel.id) === (button.getAttribute('aria-selected') === 'true');
      }) && workspaceFits('#svModalAdd') && workspaceFits('#btnToggleSidebar') && workspaceFits('#btnWorkspacePanel') &&
      document.documentElement.scrollWidth <= innerWidth + 1;
  })()`);
  await check(name + 'KeepsTaskHeading', `workspaceVisible('#svEditorPane [data-sv-detail-title]') && document.querySelector('#svEditorPane [data-sv-detail-title]').textContent.trim().length > 0`);
}
async function checkPluginHeader(name) {
  await check(name + 'PluginTabsStartAtLeftWithActionsIntact', `(() => {
    const header = document.querySelector('#pluginsPage .plugins-header'), tabs = header.querySelector('[role=tablist]');
    return !header.querySelector('.workspace-title') && header.firstElementChild === tabs &&
      Math.abs(tabs.getBoundingClientRect().left - header.getBoundingClientRect().left - parseFloat(getComputedStyle(header).paddingLeft)) <= 1 &&
      ['skill','agent','mcp','package'].every(kind=>tabs.querySelector('#pluginsTab-'+kind+'[role=tab]')) && tabs.querySelectorAll('[role=tab]').length === 4 &&
      workspaceFits('#pluginsRefresh') && workspaceFits('#pluginsReturn') && document.documentElement.scrollWidth <= innerWidth + 1;
  })()`);
}
async function finishMockRun(text) {
  await evaluate(`(() => { const final = { type:'result', subtype:'success', is_error:false, result:${JSON.stringify(text)} }; const jobId = uiFixture.runId;
    uiFixture.emit('onEvent', {jobId,type:'assistant',uuid:'final-' + jobId,message:{id:'final-' + jobId,content:[{type:'text',text:final.result}]}});
    uiFixture.emit('onEvent', {jobId,...final}); uiFixture.emit('onEvent', {jobId,type:'job-done',exitCode:0,finalResult:final}); })()`);
  await waitFor('!runs.has(workspaceFixture.conversationId) && !isRunning');
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + '</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1220, height: 920, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page);
  await waitFor("typeof activeView !== 'undefined' && providerRoutingLoaded && !restoringActiveRuns && !!relayUpdateUI");
  await act(`relaySidebarLayout.reset(); if(!relaySidebarLayout.getState().expanded) relaySidebarLayout.toggle(); window.workspaceVisible = selector => { const el = document.querySelector(selector); if (!el) return false; const r = el.getBoundingClientRect(), style = getComputedStyle(el); return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0' && style.display !== 'none'; };
    window.workspaceFits = selector => { const el = document.querySelector(selector); if (!el) return false; const r = el.getBoundingClientRect(); return r.width >= 24 && r.height >= 24 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; };
    window.workspaceSinglePage = id => [...document.querySelectorAll('main')].filter(el => el.getBoundingClientRect().width && el.getBoundingClientRect().height).length === 1 && workspaceVisible(id);`);
  await check('isolatedRendererBoots', 'uiFixture.errors.length === 0 && !window.require');
  await check('sidebarHasWorkingPageEntrypoints', "['#btnMyWorkChat','#btnSchedule','#btnSettings'].every(selector=>!!document.querySelector('.sidebar ' + selector))");
  await check('noUpdateLeavesNoPlaceholder', "!workspaceVisible('#btnRelayUpdate') && !workspaceVisible('#sidebarUpdatePanel')");

  // Page changes retain the same composer, even before the first conversation exists.
  await act("inputEl.value = '尚未发送的导航草稿'; inputEl.dispatchEvent(new Event('input',{bubbles:true})); workspaceFixture.inputNode = inputEl; workspaceFixture.messageHost = messagesEl;");
  await click('#btnMyWorkChat'); await waitFor("activeView === 'library' && document.querySelector('.libp-results').children.length > 0");
  await check('libraryIsMainPageWithVisibleSidebar', "workspaceSinglePage('#libraryPage') && workspaceVisible('.sidebar') && !document.querySelector('.mywork-overlay.show') && document.querySelector('#libraryPage').tagName === 'MAIN' && document.querySelector('#btnMyWorkChat').getAttribute('aria-current') === 'page'");
  await check('libraryContentKeepsPageInsets', "parseFloat(getComputedStyle(document.getElementById('libraryPageBody')).paddingLeft) >= 16 && document.querySelector('.libp-content').getBoundingClientRect().left >= document.getElementById('libraryPage').getBoundingClientRect().left + 16");
  await checkPageHeader('library', '#libraryPage', '#libraryPageBody', '#libraryPage .libp-head h1');
  await capture('library');
  await click('#btnSchedule'); await waitFor("activeView === 'scheduler' && !!document.getElementById('svEditName')");
  await check('schedulerIsMainPage', "workspaceSinglePage('#scheduleModal') && !document.querySelector('#scheduleModal').classList.contains('modal-backdrop')");
  await checkSchedulerHeader('scheduler');
  await act("workspaceFixture.scheduleName = document.getElementById('svEditName'); workspaceFixture.schedulePrompt = document.getElementById('svEditPrompt'); workspaceFixture.scheduleName.value = '任务编辑草稿'; workspaceFixture.scheduleName.dispatchEvent(new Event('input',{bubbles:true})); workspaceFixture.schedulePrompt.value = '未保存的任务内容'; workspaceFixture.schedulePrompt.dispatchEvent(new Event('input',{bubbles:true}));");
  // Removing a page header must not shift the time menu away from its trigger.
  await act("const repeat = document.getElementById('svEditRepeat'); const details = repeat.closest('details'); if (details) details.open = true; repeat.scrollIntoView({block:'center'});"); await settle();
  await click('#svEditRepeat .cs-trigger'); await click('#svEditRepeat .cs-option[data-value="daily"]');
  await act("const trigger = document.querySelector('#svEditTime .cs-trigger'); const details = trigger.closest('details'); if (details) details.open = true; trigger.scrollIntoView({block:'center'});"); await settle();
  await click('#svEditTime .cs-trigger');
  await check('schedulerTimeMenuStaysAnchoredAfterHeaderRemoval', `(() => {
    const trigger = document.querySelector('#svEditTime .cs-trigger'), popup = document.querySelector('#svEditTime .cs-popup');
    const t = trigger.getBoundingClientRect(), p = popup.getBoundingClientRect();
    const gap = popup.classList.contains('open-up') ? t.top - p.bottom : p.top - t.bottom;
    return popup.matches(':popover-open') && Math.abs(gap - 4) <= 1.1 &&
      Math.abs(p.right - Math.min(innerWidth - 10, Math.max(p.width + 10, t.right))) <= 1.1 &&
      popup.contains(document.elementFromPoint(p.left + p.width / 2, p.top + Math.min(24, p.height / 2)));
  })()`);
  await click('#svEditTime .cs-option[data-value="09:30"]');
  await check('schedulerTimeMenuStillSelectsWithoutSaving', "document.getElementById('svEditTime').dataset.value === '09:30' && !document.querySelector('#svEditTime .cs-popup').matches(':popover-open') && workspaceFixture.schedulerWrites.length === 0");
  await capture('scheduler');
  await click('#btnMyWorkChat'); await click('#btnSchedule');
  await check('schedulerDraftKeepsItsMountedInputs', "document.getElementById('svEditName') === workspaceFixture.scheduleName && document.getElementById('svEditName').value === '任务编辑草稿' && document.getElementById('svEditPrompt') === workspaceFixture.schedulePrompt && document.getElementById('svEditPrompt').value === '未保存的任务内容' && workspaceFixture.schedulerWrites.length === 0");
  await click('#btnPlugins'); await waitFor("activeView === 'plugins' && !!document.getElementById('pluginsReturn')");
  await checkPluginHeader('desktop'); await capture('plugins');
  await click('#pluginsReturn');
  await check('unsentChatDraftSurvivesPageRoundTrip', "activeView === 'chat' && inputEl === workspaceFixture.inputNode && messagesEl === workspaceFixture.messageHost && inputEl.value === '尚未发送的导航草稿'");

  // Start a real renderer run using the mock runClaude endpoint, then finish off-page.
  await click('#btnSend'); await waitFor('uiFixture.runId && currentConv && isRunning');
  await act("workspaceFixture.conversationId = currentConv.id; workspaceFixture.firstJobId = uiFixture.runId; workspaceFixture.userNode = document.querySelector('.message.user'); workspaceFixture.historyLoads = uiFixture.calls.filter(call => call === 'history.load').length; inputEl.value = '后台完成后的补充草稿'; inputEl.dispatchEvent(new Event('input',{bubbles:true}));");
  await waitFor("!!document.querySelector('.history-item[data-id=\"' + workspaceFixture.conversationId + '\"]')");
  await click('#btnMyWorkChat');
  await act("document.querySelector('.history-item[data-id=\"' + workspaceFixture.conversationId + '\"]').click();"); await settle();
  await check('sameConversationHistoryReturnPreservesDOMAndDraft', "activeView === 'chat' && document.querySelector('.message.user') === workspaceFixture.userNode && inputEl.value === '后台完成后的补充草稿' && uiFixture.calls.filter(call => call === 'history.load').length === workspaceFixture.historyLoads");
  await click('#btnMyWorkChat');
  await act(`uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'assistant',uuid:'workspace-progress',message:{id:'workspace-progress',content:[{type:'text',text:'后台仍在核对导航与草稿。'}]}});
    uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'stream_event',event:{type:'message_start',message:{id:'workspace-stream'}}});
    uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'正在整理最终验收结果。'}}});`);
  await check('backgroundStreamingDoesNotStealMainPage', "activeView === 'library' && runs.has(workspaceFixture.conversationId) && !document.getElementById('libraryPage').textContent.includes('后台仍在核对')");
  await finishMockRun('导航验收完成：草稿保留，后台任务正常结束。');
  await check('backgroundCompletionKeepsLibraryActive', "activeView === 'library' && currentConv.turns.at(-1).assistant === '导航验收完成：草稿保留，后台任务正常结束。'");
  await act("document.querySelector('.history-item[data-id=\"' + workspaceFixture.conversationId + '\"]').click();"); await settle();
  await check('backgroundCompletionReturnsOneFinalAndUsableComposer', "activeView === 'chat' && !isRunning && !sendBtn.disabled && inputEl.value === '后台完成后的补充草稿' && document.querySelector('.message.user') === workspaceFixture.userNode && [...document.querySelectorAll('.message.assistant .body')].filter(el=>el.textContent.includes('导航验收完成：')).length === 1 && ![...document.querySelectorAll('.conversation-narration')].some(el=>el.textContent.includes('导航验收完成：'))");
  await capture('chat-complete');
  await click('#btnSend'); await waitFor('uiFixture.runId !== workspaceFixture.firstJobId && isRunning');
  await finishMockRun('第二轮对话正常完成。');
  await check('continuationRunsAfterOffPageCompletion', "currentConv.turns.length === 2 && currentConv.turns.at(-1).assistant === '第二轮对话正常完成。' && [...document.querySelectorAll('.message.assistant .body')].filter(el=>el.textContent.includes('导航验收完成：')).length === 1");

  // Settings state and the same field nodes survive both category and main-page navigation.
  await click('#btnSettings'); await waitFor("activeView === 'settings' && document.getElementById('set-theme')?.dataset.value === 'light'");
  await check('settingsIsMainPage', "workspaceSinglePage('#settingsModal') && !document.querySelector('#settingsModal').classList.contains('modal-backdrop')");
  await checkPageHeader('settings', '#settingsModal', '#settingsModal > .workspace-surface', '#settingsModal .modal-title');
  await act("workspaceFixture.settingsNameNode = document.getElementById('set-theme'); workspaceFixture.settingsNameNode.dataset.value = 'system'; workspaceFixture.settingsNameNode.dispatchEvent(new Event('input',{bubbles:true})); workspaceFixture.settingsReadsAtEdit = workspaceFixture.settingsReads;");
  await click('.set-nav-item[data-cat="conversation"]'); await click('#sw-allowCommand');
  await act("workspaceFixture.commandDraft = document.getElementById('sw-allowCommand').classList.contains('on');");
  await click('#btnMyWorkChat'); await click('#btnSchedule'); await click('#btnSettings');
  await check('settingsDraftAndCategorySurviveNavigation', "document.getElementById('set-theme') === workspaceFixture.settingsNameNode && workspaceFixture.settingsNameNode.dataset.value === 'system' && document.querySelector('.set-nav-item[data-cat=conversation]').classList.contains('active') && document.getElementById('sw-allowCommand').classList.contains('on') === workspaceFixture.commandDraft && workspaceFixture.settingsReads === workspaceFixture.settingsReadsAtEdit && workspaceFixture.settingsWrites.length === 0");
  await capture('settings');

  // Real updater controller, synthetic API responses only. Opening/later never download.
  await click('.set-nav-item[data-cat="about"]');
  await act("workspaceFixture.setUpdate({state:'available',latest:'2.2.0',dismissed:true,releaseNotes:'<strong data-release-markup>示例更新说明</strong>'});");
  await waitFor("workspaceVisible('#btnRelayUpdate')");
  await check('availableUpdateOnlyShowsSidebarEntrypoint', "!workspaceVisible('#sidebarUpdatePanel') && !document.getElementById('updateBubble') && !workspaceFixture.updateCalls.some(call=>['download','install'].includes(call)) && document.getElementById('set-relayUpdateNote').textContent.includes('2.2.0')");
  await click('#btnRelayUpdate');
  await check('updatePanelShowsTextWithoutReleaseHTML', "workspaceFits('#sidebarUpdatePanel') && document.querySelector('.sidebar-update-notes p').textContent.includes('<strong') && !document.querySelector('#sidebarUpdatePanel [data-release-markup]')");
  await capture('update-available');
  await click('.sidebar-update-later');
  await check('laterKeepsUpdateDiscoverable', "!workspaceVisible('#sidebarUpdatePanel') && workspaceVisible('#btnRelayUpdate') && !workspaceFixture.updateCalls.includes('dismiss')");
  await click('#btnRelayUpdate'); await act('workspaceFixture.failNextDownload = true;'); await click('.sidebar-update-primary');
  await waitFor("document.querySelector('.sidebar-update-error').textContent.includes('模拟下载请求失败')");
  await check('downloadRefusalRemainsRetryable', "!document.querySelector('.sidebar-update-primary').disabled && document.querySelector('.sidebar-update-primary').textContent === '重试下载'");
  await click('.sidebar-update-primary'); await waitFor("relayUpdateUI.getState().state === 'downloading'");
  await act("workspaceFixture.setUpdate({state:'downloading',progress:53});");
  await check('downloadingStateSharedWithSettings', "document.querySelector('.sidebar-update-primary').disabled && document.querySelector('.sidebar-update-progress-label').textContent.includes('53%') && document.getElementById('set-relayUpdateNote').textContent.includes('53%')");
  await click('.sidebar-update-later'); await act("workspaceFixture.setUpdate({state:'ready',progress:100});");
  await check('readyDoesNotOpenOrRestartAutomatically', "!workspaceVisible('#sidebarUpdatePanel') && workspaceVisible('#btnRelayUpdate') && !workspaceFixture.updateCalls.includes('install')");
  await click('#btnRelayUpdate'); await click('.sidebar-update-primary');
  await check('restartOnlyCallsMockAfterExplicitClick', "workspaceFixture.updateCalls.filter(call=>call==='install').length === 1 && document.querySelector('.sidebar-update-primary').disabled");
  await click('.sidebar-update-later'); await act("workspaceFixture.setUpdate({state:'idle',latest:'',progress:0});");
  await check('noUpdateHidesButtonAndPanel', "!workspaceVisible('#btnRelayUpdate') && !workspaceVisible('#sidebarUpdatePanel')");

  // The persistent titlebar restores navigation from both desktop and narrow collapse.
  await act("workspaceFixture.setUpdate({state:'available',latest:'2.2.0',releaseNotes:'界面与稳定性更新。'});");
  await click('#btnMyWorkChat'); await click('#windowChrome [data-toggle-sidebar]');
  await check('desktopCollapsedSidebarRestoresFromWindowTitlebar', "!relaySidebarLayout.getState().expanded && document.querySelector('.sidebar').getBoundingClientRect().width <= 1 && workspaceFits('#btnToggleSidebar')");
  await click('#btnToggleSidebar');
  await check('restoredSidebarKeepsNavigationAndUpdate', "['#btnMyWorkChat','#btnSchedule','#btnSettings','#btnRelayUpdate'].every(workspaceFits)");
  await click('#btnToggleSidebar');
  await capture('collapsed-sidebar');
  win.setSize(520, 860); await settle();
  await act("document.querySelector('.app').classList.remove('sidebar-mobile-open'); relaySidebarLayout.sync();"); await settle();
  await checkPageHeader('narrowLibrary', '#libraryPage', '#libraryPageBody', '#libraryPage .libp-head h1');
  await check('narrowSidebarHiddenWithoutOverflow', "!relaySidebarLayout.getState().expanded && workspaceFits('#btnToggleSidebar') && document.documentElement.scrollWidth <= innerWidth + 1");
  await click('#btnToggleSidebar');
  await check('narrowOverlayRestoresClickableEntries', "['#btnMyWorkChat','#btnSchedule','#btnSettings','#btnRelayUpdate'].every(workspaceFits)");
  await click('#btnRelayUpdate'); await check('updatePanelFitsNarrowViewport', "workspaceFits('#sidebarUpdatePanel')"); await capture('update-narrow');
  win.webContents.sendInputEvent({ type:'keyDown', keyCode:'ESC' }); win.webContents.sendInputEvent({ type:'keyUp', keyCode:'ESC' }); await settle();
  await check('escapeClosesUpdateAndReturnsFocus', "!workspaceVisible('#sidebarUpdatePanel') && document.activeElement === document.getElementById('btnRelayUpdate')");
  await click('#btnSchedule'); await act("document.getElementById('svEditorSave').scrollIntoView({block:'nearest'});"); await settle();
  await check('narrowTaskDraftAndSaveRemainAccessible', "document.getElementById('svEditName').value === '任务编辑草稿' && workspaceFits('#svEditorSave') && document.documentElement.scrollWidth <= innerWidth + 1");
  await checkSchedulerHeader('narrowScheduler');
  await capture('scheduler-narrow');
  await click('#btnToggleSidebar'); await click('#btnPlugins'); await waitFor("activeView === 'plugins' && !!document.getElementById('pluginsReturn')");
  await checkPluginHeader('narrow'); await capture('plugins-narrow');
  await click('#btnToggleSidebar'); await click('#btnSettings'); await click('.set-nav-item[data-cat="general"]');
  await act("document.getElementById('btnSettingsSave').scrollIntoView({block:'nearest'});"); await settle();
  await check('narrowSettingsDraftAndSaveRemainAccessible', "document.getElementById('set-theme') === workspaceFixture.settingsNameNode && workspaceFixture.settingsNameNode.dataset.value === 'system' && workspaceFits('#btnSettingsSave') && document.documentElement.scrollWidth <= innerWidth + 1");
  await checkPageHeader('narrowSettings', '#settingsModal', '#settingsModal > .workspace-surface', '#settingsModal .modal-title');
  await capture('settings-narrow');
  await act("document.documentElement.setAttribute('data-theme','dark');"); await click('#btnToggleSidebar'); await click('#btnRelayUpdate'); await capture('update-dark');
  await click('.sidebar-update-later');

  // Saving failures and cancellation use the real settings lifecycle against a durable mock baseline.
  win.setSize(1220, 920); await settle();
  await act("applyThemeToDOM(_themeSetting); relaySidebarLayout.reset(); if (!relaySidebarLayout.getState().expanded) relaySidebarLayout.toggle();"); await settle();
  await click('#set-theme button[data-value="dark"]');
  await check('themePreviewLeavesSavedPreferenceUntouched', "document.documentElement.dataset.theme === 'dark' && _themeSetting === 'light' && workspaceFixture.savedSettings().app.theme === 'light'");
  await click('#btnMyWorkChat'); await click('#btnSettings');
  await check('themePreviewSurvivesPageNavigation', "document.documentElement.dataset.theme === 'dark' && document.getElementById('set-theme').dataset.value === 'dark' && workspaceFixture.settingsWrites.length === 0");
  await click('#btnSettingsCancel');
  await waitFor("settingsFormLoaded && !settingsFormPromise && document.getElementById('set-theme')?.dataset.value === 'light'");
  await check('cancelRestoresInitialBaselineAndTheme', "document.documentElement.dataset.theme === 'light' && document.getElementById('set-theme').dataset.value === 'light' && document.getElementById('set-theme').dataset.value === 'light' && !document.getElementById('sw-allowCommand').classList.contains('on') && workspaceFixture.settingsWrites.length === 0");
  await act("workspaceFixture.saveDraftNode = document.getElementById('set-theme'); workspaceFixture.saveDraftNode.dataset.value = 'dark'; workspaceFixture.saveDraftNode.dispatchEvent(new Event('input',{bubbles:true})); workspaceFixture.settingsWriteMode = 'refuse';");
  await click('#set-theme button[data-value="dark"]');
  await click('#btnSettingsSave'); await waitFor("!settingsSaveBusy && document.getElementById('settingsHint').textContent.includes('模拟保存被拒绝')");
  await check('settingsRefusalRetainsDraftAndReportsFailure', "document.getElementById('set-theme') === workspaceFixture.saveDraftNode && workspaceFixture.saveDraftNode.dataset.value === 'dark' && document.getElementById('set-theme').dataset.value === 'dark' && _themeSetting === 'light' && !document.getElementById('btnSettingsSave').disabled && document.getElementById('settingsHint').dataset.error === 'true' && workspaceFixture.brandWrites.length === 0");
  await act("workspaceFixture.settingsWriteMode = 'reject';"); await click('#btnSettingsSave');
  await waitFor("!settingsSaveBusy && document.getElementById('settingsHint').textContent.includes('模拟保存异常')");
  await check('settingsRejectionRetainsDraftAndAllowsRetry', "workspaceFixture.settingsWrites.length === 2 && document.getElementById('set-theme') === workspaceFixture.saveDraftNode && workspaceFixture.saveDraftNode.dataset.value === 'dark' && !document.getElementById('btnSettingsSave').disabled && workspaceFixture.brandWrites.length === 0");
  await act("workspaceFixture.settingsWriteMode = 'hold'; workspaceFixture.writesBeforeHold = workspaceFixture.settingsWrites.length; document.getElementById('btnSettingsSave').click(); document.getElementById('btnSettingsSave').click(); document.getElementById('btnSettingsSave').dispatchEvent(new MouseEvent('click',{bubbles:true}));");
  await check('settingsPendingSavePreventsDuplicateRequests', "settingsSaveBusy && document.getElementById('btnSettingsSave').disabled && document.getElementById('btnSettingsCancel').disabled && workspaceFixture.settingsWrites.length === workspaceFixture.writesBeforeHold + 1 && typeof workspaceFixture.releaseSettingsSave === 'function'");
  await click('#btnMyWorkChat'); await click('#btnSettings');
  await check('pendingSettingsSaveSurvivesPageRoundTrip', "settingsSaveBusy && document.getElementById('set-theme') === workspaceFixture.saveDraftNode && document.getElementById('btnSettingsSave').disabled");
  await act("workspaceFixture.releaseSettingsSave();"); await waitFor("!settingsSaveBusy && document.getElementById('settingsHint').textContent.includes('已保存')");
  await check('successfulRetryCommitsOneBaseline', "workspaceFixture.settingsWrites.length === 3 && workspaceFixture.brandWrites.length === 0 && workspaceFixture.savedSettings().app.theme === 'dark' && _themeSetting === 'dark' && document.getElementById('settingsHint').dataset.error === 'false'");
  await act("workspaceFixture.settingsWriteMode = 'ok'; document.getElementById('set-theme').dataset.value = 'light'; document.getElementById('set-theme').dispatchEvent(new Event('input',{bubbles:true}));");
  await click('#set-theme button[data-value="light"]'); await click('#btnSettingsCancel');
  await waitFor("settingsFormLoaded && !settingsFormPromise && document.getElementById('set-theme')?.dataset.value === 'dark'");
  await check('cancelRestoresPersistedBaselineNotOriginalDefaults', "document.getElementById('set-theme').dataset.value === 'dark' && document.documentElement.dataset.theme === 'dark' && document.getElementById('set-theme').dataset.value === 'dark' && workspaceFixture.settingsWrites.length === 3 && workspaceFixture.brandWrites.length === 0");
  await capture('settings-saved-baseline');

  // Provider editors are nested settings content; page changes must retain their nodes too.
  await click('.set-nav-item[data-cat="providers"]'); await waitFor("!!document.querySelector('[data-provider-id=fixture]')");
  await click('[data-provider-id="fixture"] [data-provider-act="edit"]');
  await act("workspaceFixture.providerNameNode = document.getElementById('providerName'); workspaceFixture.providerUrlNode = document.getElementById('providerBaseUrl'); workspaceFixture.providerModelNode = document.getElementById('providerModelOpus'); workspaceFixture.providerNameNode.value = '服务商编辑草稿'; workspaceFixture.providerUrlNode.value = 'https://draft.example.invalid/v1'; workspaceFixture.providerModelNode.value = 'vendor/draft-model'; [workspaceFixture.providerNameNode,workspaceFixture.providerUrlNode,workspaceFixture.providerModelNode].forEach(el=>el.dispatchEvent(new Event('input',{bubbles:true})));");
  await click('#btnMyWorkChat'); await click('#btnSchedule'); await click('#btnSettings');
  await check('providerEditorDraftSurvivesPageNavigation', "document.querySelector('.set-nav-item[data-cat=providers]').classList.contains('active') && document.getElementById('providerName') === workspaceFixture.providerNameNode && workspaceFixture.providerNameNode.value === '服务商编辑草稿' && document.getElementById('providerBaseUrl') === workspaceFixture.providerUrlNode && workspaceFixture.providerUrlNode.value === 'https://draft.example.invalid/v1' && document.getElementById('providerModelOpus') === workspaceFixture.providerModelNode && workspaceFixture.providerModelNode.value === 'vendor/draft-model' && workspaceFixture.providerWrites.length === 0");
  await act("uiFixture.emit('providers.onChanged',{routes:uiFixture.routes});"); await settle();
  await check('providerRefreshDoesNotReplaceEditingDraft', "document.getElementById('providerName') === workspaceFixture.providerNameNode && workspaceFixture.providerModelNode.value === 'vendor/draft-model' && workspaceFixture.providerWrites.length === 0");
  await capture('provider-draft');
  await check('onlyOneUpdaterSubscriptionAcrossPageChanges', "uiFixture.calls.filter(call=>call==='relayUpdate.onEvent').length === 1");
  await check('noRendererErrors', 'uiFixture.errors.length === 0');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks: results, failures }, null, 2));
  console.log(JSON.stringify({ checks: results, failures })); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack || error));
  console.error(error.stack || error);
  if (win && !win.isDestroyed()) {
    try { console.error(await evaluate('JSON.stringify({errors:uiFixture.errors,view:typeof activeView === "undefined" ? null : activeView,update:workspaceFixture.updateCalls,sidebar:relaySidebarLayout.getState(),classes:document.querySelector(".app").className,style:document.querySelector(".app").getAttribute("style"),innerWidth,pages:[...document.querySelectorAll("main")].map(el=>({id:el.id,hidden:el.classList.contains("hidden"),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})),sidebarStyle:{opacity:getComputedStyle(document.querySelector(".sidebar")).opacity,width:document.querySelector(".sidebar").getBoundingClientRect().width},selected:document.getElementById("btnMyWorkChat").getAttribute("aria-current")})')); await capture('failure'); } catch (captureError) { console.error(captureError.message); }
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks: results, failures }, null, 2));
  clearTimeout(deadline); app.exit(1);
});
