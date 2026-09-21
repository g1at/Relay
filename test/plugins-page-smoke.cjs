'use strict';

// Actual renderer in an isolated Electron window; all history/API data is
// synthetic, and no Relay main process, model or business MCP is launched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'plugins-page-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win;
const checks = {}, failures = [];
let step = 'starting';
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, step }, null, 2));
const deadline = setTimeout(() => { failures.push('Overall timeout at ' + step); save(); app.exit(1); }, 180000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settleUI() {
  await evaluate("document.getAnimations().forEach(a=>{if(a.effect&&a.effect.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} });");
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{ const end=Date.now()+6000; const tick=()=>{ if(${code})return resolve(); if(Date.now()>end)return reject(new Error('State timeout: '+${JSON.stringify(code)})); setTimeout(tick,25); }; tick(); })`);
}
async function check(name, code) {
  step = name; console.log(name);
  checks[name] = !!await evaluate(code); save();
  if (!checks[name]) throw new Error(name);
}
async function click(selector) {
  await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)throw new Error('Missing '+${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest',inline:'nearest'}); el.click(); })()`);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(90);
}
async function rightClick(selector) {
  const point = await evaluate(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2) }; })()`);
  win.webContents.sendInputEvent({ type:'mouseMove', ...point });
  win.webContents.sendInputEvent({ type:'mouseDown', ...point, button:'right', clickCount:1 });
  win.webContents.sendInputEvent({ type:'mouseUp', ...point, button:'right', clickCount:1 });
  await waitFor("!!document.getElementById('sidebarExploreSurface')");
}
async function capture(name) {
  step = 'capture ' + name;
  await evaluate("document.getAnimations().forEach(a=>{ if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} }); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await win.webContents.capturePage(); await delay(130);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js', 'plugins-api-fixture.js'].map(name => {
    const text = fs.readFileSync(path.join(__dirname, name), 'utf8');
    return name === 'plugins-api-fixture.js' ? text.replace("state: 'active' }", "state: i === 0 ? 'stale' : 'active', pinned: i === 1 }") : text;
  }).join('\n');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + '\nlocalStorage.clear();</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width:1320, height:920, show:false, webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false} });
  await win.loadFile(page);
  await waitFor("!!window.relayPluginsPage&&providerRoutingLoaded&&!restoringActiveRuns");
  await act("window.visible=selector=>{const e=document.querySelector(selector);return !!e&&!!e.getClientRects().length&&!e.closest('[hidden],.hidden,[inert]');}; inputEl.value='插件导航期间的对话草稿';pluginsFixture.chatNode=inputEl;");
  await evaluate(`(async()=>{ await window.api.history.save({id:'plugins-history',title:'插件管理验收',mode:'plain',model:'opus',memoryMode:'read',turns:[],createdAt:'2026-09-07T01:00:00Z',updatedAt:'2026-09-07T01:00:00Z'}); await loadConversation('plugins-history'); inputEl.value='插件导航期间的对话草稿'; pluginsFixture.chatNode=inputEl; })()`);
  await check('pluginsStartsInSidebarAndToggleIsFarLeft', "document.getElementById('btnPlugins').parentElement.id==='sidebarPinnedFeatures'&&document.getElementById('windowChrome').firstElementChild.id==='btnToggleSidebar'");
  await click('#btnSettings'); await waitFor("!!document.getElementById('set-theme')");
  await click('.set-nav-item[data-cat=general]');
  await act("pluginsFixture.settingsNode=document.getElementById('set-theme');pluginsFixture.settingsNode.dataset.value='dark';pluginsFixture.settingsNode.dispatchEvent(new Event('input',{bubbles:true}));");
  await waitFor("document.getElementById('settingsHint').textContent.includes('未保存')");
  await act("pluginsFixture.settingsHint=document.getElementById('settingsHint').textContent;");
  await check('settingsNoLongerContainsPluginCategories', "!document.querySelector('#setNav [data-cat=skill],#setNav [data-cat=agent],#setNav [data-cat=data]')&&!document.querySelector('#settingsBody #skillSection,#settingsBody #agentSection,#settingsBody #mcpSection')");
  await click('#btnPlugins'); await waitFor("document.querySelectorAll('#skillSection > [data-list] > .dp-item:not(.skill-list-skeleton)').length===6&&!document.getElementById('pluginsRefresh').disabled");
  await check('pluginsLoadsRealSkillManagerInsideMainPage', "activeView==='plugins'&&visible('#pluginsPage')&&!visible('#settingsModal')&&document.getElementById('btnPlugins').getAttribute('aria-current')==='page'&&document.querySelectorAll('#pluginsPage [data-plugin-tab]').length===4");
  await check('installedSkillsUseTwoColumnLayoutAndSeparateMaintenanceView', "getComputedStyle(document.querySelector('#skillSection > [data-list]')).gridTemplateColumns.split(' ').length===2&&document.querySelector('#skillSection .plugins-maintenance').hidden&&!document.querySelector('#skillSection details.plugins-maintenance')&&document.querySelector('[data-skill-view=library]').getAttribute('aria-selected')==='true'&&!visible('#skillSection [data-draft-review]')");
  await act("pluginsFixture.skillImport=document.querySelector('#pluginsCategory-skill .plugins-intro-actions [data-import]');");
  await check('skillImportIsCompactNeutralActionBesideTitleBeforeSearch', "(()=>{const b=pluginsFixture.skillImport,h=document.querySelector('#pluginsCategory-skill h1'),s=document.querySelector('#pluginsCategory-skill .plugins-search');if(!b)return false;const r=b.getBoundingClientRect(),hr=h.getBoundingClientRect();return !document.querySelector('#skillSection [data-import]')&&r.left>=hr.right&&r.top>=hr.top-1&&r.top<hr.bottom&&r.bottom<s.getBoundingClientRect().top&&r.width<=160&&r.height<=36&&getComputedStyle(b).color===getComputedStyle(b.querySelector('svg')).color;})()");
  await capture('plugins-skills');
  await check('skillFilterUsesSharedCustomSelectAndAccessibleOptions', "!document.querySelector('.plugins-skill-filter select')&&document.querySelector('[data-skill-filter]').classList.contains('custom-select')&&document.querySelector('#pluginsSkillFilter .cs-trigger').getAttribute('aria-haspopup')==='listbox'&&[...document.querySelectorAll('#pluginsSkillFilter [role=option]')].map(e=>e.dataset.value).join(',')==='all,stale,protected,archived'");
  await click('#pluginsSkillFilter .cs-trigger');
  await check('skillFilterOpensSharedTopLayerMenu', "document.querySelector('#pluginsSkillFilter .cs-popup').matches(':popover-open')&&document.querySelector('#pluginsSkillFilter .cs-trigger').getAttribute('aria-expanded')==='true'");
  await capture('plugins-skill-filter');
  await click('#pluginsSkillFilter [data-value=stale]');
  await check('idleFilterShowsOnlyIdleSkills', "document.querySelector('[data-skill-filter]').dataset.value==='stale'&&document.querySelectorAll('#skillSection [data-list] > .dp-item:not([hidden])').length===1&&!!document.querySelector('#skillSection [data-list] > .dp-item.skill-stale:not([hidden])')");
  await click('#pluginsRefresh'); await waitFor("!document.getElementById('pluginsRefresh').disabled");
  await check('refreshKeepsCustomFilterLabelAndSelection', "document.querySelector('[data-skill-filter]').dataset.value==='stale'&&document.querySelector('#pluginsSkillFilter .cs-text').textContent==='闲置'&&document.querySelector('#pluginsSkillFilter [aria-selected=true]').dataset.value==='stale'&&document.querySelectorAll('#skillSection [data-list] > .dp-item:not([hidden])').length===1");
  await click('#pluginsSkillFilter .cs-trigger'); await click('#pluginsSkillFilter [data-value=protected]');
  await check('protectedFilterShowsOnlyPinnedSkills', "document.querySelector('[data-skill-filter]').dataset.value==='protected'&&document.querySelectorAll('#skillSection [data-list] > .dp-item:not([hidden])').length===1&&!!document.querySelector('#skillSection [data-list] > .dp-item:not([hidden]) .skill-badge.pin')");
  await act("document.querySelector('#pluginsSkillFilter .cs-trigger').focus();");
  await key('DOWN'); await key('HOME'); await key('ESCAPE');
  await check('escapeClosesFilterWithoutChangingSelection', "document.querySelector('[data-skill-filter]').dataset.value==='protected'&&document.querySelector('#pluginsSkillFilter .cs-popup').hidden&&document.activeElement===document.querySelector('#pluginsSkillFilter .cs-trigger')");
  await key('SPACE'); await key('HOME'); await key('ENTER');
  await check('keyboardHomeAndEnterRestoreAllSkills', "document.querySelector('[data-skill-filter]').dataset.value==='all'&&document.querySelectorAll('#skillSection [data-list] > .dp-item:not([hidden])').length===6&&document.querySelector('#pluginsSkillFilter .cs-popup').hidden");
  await key('DOWN'); await key('DOWN'); await key('UP'); await key('TAB');
  await check('tabClosesFilterAndContinuesToSearch', "document.querySelector('#pluginsSkillFilter .cs-popup').hidden&&document.activeElement===document.querySelector('[data-plugin-search=skill]')&&document.querySelector('[data-skill-filter]').dataset.value==='all'");
  await click('#pluginsSkillFilter .cs-trigger'); await click('#pluginsCategory-skill .plugins-search');
  await check('outsideClickClosesSharedSkillFilter', "document.querySelector('#pluginsSkillFilter .cs-popup').hidden&&document.querySelector('#pluginsSkillFilter .cs-trigger').getAttribute('aria-expanded')==='false'");
  await act("const e=document.querySelector('[data-plugin-search=skill]');e.value='文档';e.dispatchEvent(new Event('input',{bubbles:true}));");
  await check('searchFiltersInstalledSkills', "document.querySelectorAll('#skillSection [data-list] > .dp-item:not([hidden])').length===1&&document.querySelector('#skillSection [data-list] > .dp-item:not([hidden]) .dp-item-name').textContent==='文档阅读'");
  await click('#pluginsRefresh'); await waitFor("!document.getElementById('pluginsRefresh').disabled");
  await check('refreshPreservesSearchAndFiltersNewRows', "document.querySelector('[data-plugin-search=skill]').value==='文档'&&document.querySelectorAll('#skillSection [data-list] > .dp-item:not([hidden])').length===1");
  await check('refreshKeepsOneLiveImportButtonInTheTitle', "document.querySelector('#pluginsCategory-skill [data-import]')===pluginsFixture.skillImport&&document.querySelectorAll('#pluginsCategory-skill [data-import]').length===1");
  await act("const e=document.querySelector('[data-plugin-search=skill]');e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));");
  await click('[data-skill-view=maintenance]');
  await check('maintenanceIsAnIndependentViewWithExistingControls', "visible('#skillSection .plugins-maintenance')&&!visible('#skillSection [data-list]')&&!visible('#skillSection [data-draft-review]')&&!visible('[data-plugin-search=skill]')&&!!document.querySelector('#skillSection [data-review-on]')");
  await click('[data-skill-view=updates]');
  await check('updatesViewKeepsCandidatePanelAndHidesMaintenance', "visible('#skillSection [data-draft-review]')&&!visible('#skillSection .plugins-maintenance')&&!visible('#skillSection [data-list]')&&visible('[data-plugin-search=skill]')");
  await click('[data-skill-view=library]');
  await act("document.querySelector('#pluginsSkillFilter .cs-trigger').focus();"); await key('DOWN'); await key('END'); await key('ENTER');
  await check('archiveFilterReplacesInstalledListWithoutAnotherFold', "visible('#skillSection [data-arch-list]')&&!visible('#skillSection [data-list]')&&!visible('#skillSection [data-arch-toggle]')&&document.querySelector('#skillSection [data-arch-list]').textContent.includes('old-helper')");
  await act("pluginsFixture.beforeArchiveRefresh=pluginsFixture.overviewCount;uiFixture.emit('skills.onUsageUpdated',{});");
  await waitFor('pluginsFixture.overviewCount>pluginsFixture.beforeArchiveRefresh');
  await check('usageUpdatePreservesArchiveView', "document.querySelector('[data-skill-filter]').dataset.value==='archived'&&document.querySelector('#pluginsSkillFilter [aria-selected=true]').dataset.value==='archived'&&visible('#skillSection [data-arch-list]')&&!visible('#skillSection [data-list]')");
  await act("const e=document.querySelector('[data-plugin-search=skill]');e.value='missing-archive';e.dispatchEvent(new Event('input',{bubbles:true}));");
  await check('archiveSearchAndEmptyStateUseArchivedRows', "!document.querySelector('#skillSection [data-arch-list] > .dp-item:not([hidden])')&&visible('#pluginsCategory-skill .plugins-search-empty')");
  await act("const s=document.querySelector('[data-plugin-search=skill]');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));");
  await click('#pluginsSkillFilter .cs-trigger'); await click('#pluginsSkillFilter [data-value=all]');
  await click('#pluginsCategory-skill .plugins-intro-actions [data-import]'); await waitFor('pluginsFixture.imports.length===1');
  await check('skillImportUsesExistingPackageApiAndLeavesSettingsHintIntact', "pluginsFixture.imports[0].kind==='skill'&&document.getElementById('settingsHint').textContent===pluginsFixture.settingsHint&&workspaceFixture.settingsWrites.length===0");

  await click('[data-plugin-tab=agent]'); await waitFor("document.querySelectorAll('#agentSection [data-list] > .dp-item').length===2");
  await click('#pluginsCategory-agent .plugins-intro-actions [data-import]'); await waitFor('pluginsFixture.imports.length===2');
  await check('agentTitleImportRetainsItsOwnPackageKind', "pluginsFixture.imports[1].kind==='agent'&&!document.querySelector('#agentSection [data-import]')&&document.querySelectorAll('#pluginsCategory-agent [data-import]').length===1");
  await act("(()=>{const b=document.querySelector('#pluginsCategory-agent [data-import]'),data=new DataTransfer();data.items.add(new File(['synthetic zip fixture'],'dropped-agent.zip',{type:'application/zip'}));b.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:data}));pluginsFixture.importDragActive=b.classList.contains('is-dragging');b.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()");
  await waitFor('pluginsFixture.imports.length===3');
  await check('titleImportStillAcceptsZipDropWithoutOpeningAnotherPicker', "pluginsFixture.importDragActive&&pluginsFixture.imports[2].kind==='agent'&&pluginsFixture.imports[2].path.endsWith('dropped-agent.zip')&&!document.querySelector('#pluginsCategory-agent [data-import]').classList.contains('is-dragging')");
  await capture('plugins-agents');
  await click('#agentSection [data-list] > .dp-item .dp-more'); await click('#agentSection [data-action=detail]');
  await waitFor("document.getElementById('plugin-agent-dpEditor')?.value.includes('合成的详情')");
  await check('agentDetailLivesInPluginsAndLeavesSettingsMounted', "visible('#plugin-agent-dpMemoryPreview')&&document.getElementById('set-theme')===pluginsFixture.settingsNode&&pluginsFixture.settingsNode.dataset.value==='dark'");
  await click('#plugin-agent-memViewToggle');
  await act("pluginsFixture.agentEditor=document.getElementById('plugin-agent-dpEditor');pluginsFixture.agentEditor.value='# 未保存的 Agent 草稿';pluginsFixture.agentEditor.dispatchEvent(new Event('input',{bubbles:true}));");
  await click('#btnSettings');
  await check('settingsDraftSurvivesPluginDetailNavigation', "activeView==='settings'&&document.getElementById('set-theme')===pluginsFixture.settingsNode&&pluginsFixture.settingsNode.dataset.value==='dark'&&document.getElementById('settingsHint').textContent===pluginsFixture.settingsHint");
  await click('#btnPlugins');
  await check('pluginDetailDraftSurvivesMainPageRoundTrip', "visible('#plugin-agent-dpMemorySource')&&document.getElementById('plugin-agent-dpEditor')===pluginsFixture.agentEditor&&pluginsFixture.agentEditor.value==='# 未保存的 Agent 草稿'");
  await capture('plugins-agent-editor');
  await act('pluginsFixture.mcpFail=true;'); await click('[data-plugin-tab=mcp]');
  await waitFor("!!document.querySelector('#mcpSection .plugins-load-error')");
  await check('mcpFailureHasInlineRetryWithoutAffectingOtherTabs', "document.querySelector('#mcpSection .plugins-load-error').textContent.includes('模拟 MCP')&&pluginsFixture.agentEditor.value==='# 未保存的 Agent 草稿'");
  await act('pluginsFixture.mcpFail=false;'); await click('#mcpSection .plugins-load-error button');
  await waitFor("document.querySelectorAll('#mcpSection [data-list] > .dp-item').length===2&&!document.getElementById('pluginsRefresh').disabled");
  await check('mcpRetryLoadsCurrentConversationStatus', "document.querySelector('#mcpSection [data-state]').textContent.includes('已连接')&&document.querySelector('#mcpSection [data-state]').textContent.includes('3 个工具')");
  await check('mcpServersUseOneFullWidthRowEachOnWideScreens', "(()=>{const list=document.querySelector('#mcpSection > [data-list]'),rows=[...list.querySelectorAll(':scope > .dp-item')],r=rows.map(e=>e.getBoundingClientRect());return rows.length===2&&getComputedStyle(list).gridTemplateColumns.split(' ').length===1&&Math.abs(r[0].left-r[1].left)<1&&r[1].top>=r[0].bottom&&r.every(b=>Math.abs(b.width-list.clientWidth)<1)&&rows.every(e=>e.querySelector('.dp-item-main').getBoundingClientRect().width>e.clientWidth*.6);})()");
  await capture('plugins-mcp');
  await act("pluginsFixture.mcpViewText=[...document.querySelectorAll('#mcpSection .dp-item-name,#mcpSection [data-summary]')].map(e=>[e,e.textContent]);document.querySelector('#mcpSection .dp-item-name').textContent='本地资料工具-very-long-unbroken-server-name-'.repeat(3);document.querySelector('#mcpSection [data-summary]').textContent='C:/合成验收目录/very-long-folder-name/'.repeat(8);");
  win.setSize(440,740); await waitFor('innerWidth<=440'); await settleUI();
  await check('narrowMcpRowsKeepLongNamesStatusAndActionsInsideThePage', "(()=>{const body=document.querySelector('.plugins-body'),rows=[...document.querySelectorAll('#mcpSection [data-list] > .dp-item')];return body.scrollWidth<=body.clientWidth+1&&rows.length===2&&rows.every(e=>{const r=e.getBoundingClientRect(),main=e.querySelector('.dp-item-main').getBoundingClientRect(),actions=e.querySelector('.dp-item-actions').getBoundingClientRect();return actions.top>=main.bottom&&e.scrollWidth<=e.clientWidth+1&&[...e.querySelectorAll('.dp-item-name,[data-state],[data-summary],.dp-item-actions,[data-reconnect],[data-toggle],.dp-more')].every(c=>{const b=c.getBoundingClientRect();return b.width>0&&b.left>=r.left-1&&b.right<=r.right+1&&b.bottom<=r.bottom+1;});});})()");
  await capture('plugins-mcp-narrow');
  await act('pluginsFixture.mcpViewText.forEach(([e,text])=>e.textContent=text);');
  win.setSize(1320,920); await waitFor('innerWidth>1100'); await settleUI();
  await act('pluginsFixture.toggleFail=true;'); await click('#mcpSection [data-list] > .dp-item [data-toggle]');
  await check('mcpToggleFailureRollsBack', "document.querySelector('#mcpSection [data-toggle]').classList.contains('on')");
  await act('pluginsFixture.toggleFail=false;'); await click('#mcpSection [data-list] > .dp-item [data-toggle]');
  await waitFor("!document.querySelector('#mcpSection [data-toggle]').classList.contains('on')");
  await check('mcpToggleUsesCurrentConversation', "pluginsFixture.writes.filter(w=>w.action==='mcpToggle').at(-1).convId===currentConv.id");
  await click('#mcpSection [data-list] > .dp-item [data-toggle]');
  await waitFor("!document.querySelector('#mcpSection [data-reconnect]').disabled");
  await click('#mcpSection [data-reconnect]'); await waitFor("pluginsFixture.writes.some(w=>w.action==='reconnect')");
  await check('mcpReconnectUsesExistingApi', "pluginsFixture.writes.find(w=>w.action==='reconnect').convId===currentConv.id");

  await click('[data-plugin-tab=skill]'); await click('#skillSection [data-list] > .dp-item .dp-more');
  await act("pluginsFixture.readMode='fail';"); await click('#skillSection [data-list] [data-action=detail]');
  await waitFor("document.getElementById('plugin-skill-memViewToggle')?.textContent==='重试'");
  await check('failedDetailIsNotAnEmptyEditableFile', "!visible('#plugin-skill-dpMemorySource')&&!visible('#pluginsCategory-skill [data-detail-save]')&&document.getElementById('plugin-skill-dpMemoryPreview').textContent.includes('模拟详情读取失败')");
  await act("pluginsFixture.readMode='ok';"); await click('#plugin-skill-memViewToggle');
  await waitFor("document.getElementById('plugin-skill-dpEditor')?.value.includes('合成的详情')");
  await click('#plugin-skill-memViewToggle');
  await act("pluginsFixture.skillEditor=document.getElementById('plugin-skill-dpEditor');pluginsFixture.skillEditor.value='# 准备保存的技能';pluginsFixture.writeMode='fail';");
  await click('#pluginsCategory-skill [data-detail-save]'); await waitFor("!document.querySelector('#pluginsCategory-skill [data-detail-save]').disabled");
  await check('failedSaveRetainsEditableDraftAndRetry', "visible('#plugin-skill-dpMemorySource')&&pluginsFixture.skillEditor.value==='# 准备保存的技能'&&visible('#pluginsCategory-skill [data-detail-save]')");
  await act("pluginsFixture.writeMode='hold';");
  await click('#pluginsCategory-skill [data-detail-save]'); await waitFor('!!pluginsFixture.pendingWrite');
  await act("pluginsFixture.writesAtHold=pluginsFixture.writes.length;document.querySelector('#pluginsCategory-skill [data-detail-save]').click();");
  await check('pendingDetailSavePreventsDoubleSubmission', "pluginsFixture.writes.length===pluginsFixture.writesAtHold&&document.querySelector('#pluginsCategory-skill [data-detail-back]').disabled");
  await click('#btnSettings'); await act('pluginsFixture.pendingWrite();');
  await waitFor("document.querySelector('#pluginsCategory-skill [data-detail-hint]').textContent==='✓ 已保存'");
  await check('hiddenPluginSaveCannotOverwriteSettingsDraftOrStatus', "activeView==='settings'&&pluginsFixture.settingsNode.dataset.value==='dark'&&document.getElementById('settingsHint').textContent===pluginsFixture.settingsHint&&workspaceFixture.settingsWrites.length===0");
  await click('#btnPlugins');
  await check('hiddenPluginSaveCompletesInItsOwnPage', "visible('#plugin-skill-dpMemoryPreview')&&!visible('#plugin-skill-dpMemorySource')");
  await click('[data-plugin-tab=agent]');
  await check('parallelCategoryEditorsDoNotShareNodesOrDrafts', "visible('#plugin-agent-dpMemorySource')&&pluginsFixture.agentEditor.value==='# 未保存的 Agent 草稿'&&document.querySelectorAll('#plugin-agent-dpEditor').length===1&&document.querySelectorAll('#plugin-skill-dpEditor').length===1");
  await click('#pluginsCategory-agent [data-detail-back]'); await click('#pluginsCategory-agent [data-detail-back]');
  await check('returnRestoresAgentListWithoutReloadingSettings', "visible('#agentSection')&&!visible('#pluginsCategory-agent .plugins-detail')&&document.getElementById('set-theme')===pluginsFixture.settingsNode");
  await act("pluginsFixture.readMode='hold';");
  await click('#agentSection .dp-more'); await click('#agentSection [data-action=detail]'); await waitFor('!!pluginsFixture.pendingRead');
  await click('#pluginsCategory-agent [data-detail-back]'); await act('pluginsFixture.pendingRead();');
  await check('lateDetailReadCannotRestoreClosedEditor', "visible('#agentSection')&&!document.getElementById('plugin-agent-dpEditor')&&!visible('#pluginsCategory-agent .plugins-detail')");
  await act("pluginsFixture.readMode='ok';pluginsFixture.writeMode='ok';");
  await click('[data-plugin-tab=skill]'); await click('#pluginsCategory-skill [data-detail-back]');
  await click('#btnSettings'); await click('#btnSettingsCancel'); await waitFor('!!document.getElementById("set-theme")');
  await act('pluginsFixture.beforeUsageEvent=pluginsFixture.overviewCount;uiFixture.emit("skills.onUsageUpdated",{});');
  await waitFor('pluginsFixture.overviewCount>pluginsFixture.beforeUsageEvent');
  await check('settingsReloadKeepsExactlyOneSkillUpdateSubscription', 'pluginsFixture.overviewCount===pluginsFixture.beforeUsageEvent+1');
  await click('#btnPlugins'); await click('[data-plugin-tab=mcp]'); await act("document.querySelector('[data-plugin-tab=mcp]').focus();"); await key('HOME');
  await check('pluginTabsHomeSelectsFirstCategory', "document.querySelector('[data-plugin-tab=package]').getAttribute('aria-selected')==='true'&&document.activeElement.dataset.pluginTab==='package'");
  await key('RIGHT');
  await check('pluginTabsSupportKeyboardNavigation', "document.querySelector('[data-plugin-tab=skill]').getAttribute('aria-selected')==='true'&&document.activeElement.dataset.pluginTab==='skill'");
  await click('#pluginsReturn');
  await check('chatDraftSurvivesAllPluginOperations', "activeView==='chat'&&inputEl===pluginsFixture.chatNode&&inputEl.value==='插件导航期间的对话草稿'");
  await act("relaySidebarExplore.setPinned('plugins',false);"); await click('#btnExplore'); await click('#sidebarExploreSurface [data-feature=plugins]');
  await check('hiddenPluginsRemainReachableThroughExplore', "activeView==='plugins'&&document.getElementById('btnExplore').classList.contains('has-active-feature')");
  await act("relaySidebarExplore.setPinned('plugins',true);document.documentElement.dataset.theme='dark';");
  await capture('plugins-dark');
  win.setSize(940,740); await settleUI(); await capture('plugins-compact');
  await check('compactPluginPageFitsWithoutHorizontalOverflow', "document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.plugins-body').scrollWidth<=document.querySelector('.plugins-body').clientWidth+1");
  await check('noRendererErrorsOrNodeAccess', "uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'");
  step='completed'; save(); console.log(JSON.stringify({checks,failures})); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack||error)); console.error(error.stack||error);
  if(win&&!win.isDestroyed()){try{console.error(await evaluate('JSON.stringify(uiFixture.errors)'));await capture('failure');}catch(_){} }
  save(); clearTimeout(deadline); app.exit(1);
});
