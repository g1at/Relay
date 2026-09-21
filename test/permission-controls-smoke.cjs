'use strict';
// Production composer/settings and shared component; all permissions/history are synthetic.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/permission-controls-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, failures = [], diagnostics = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, failures, diagnostics }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 150000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function next(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(next,20)}next()})`); }
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await act("document.getAnimations().forEach(animation=>{if(animation.effect?.getComputedTiming().iterations!==Infinity)try{animation.finish()}catch(_){}});"); await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); if (!checks[name]) throw Error(name); }
async function click(selector) { await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click()})()`); await settle(); }
async function key(value) { await act(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(value)},bubbles:true,cancelable:true}));`); await settle(); }
async function screenshot(name) { await settle(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function installFixture() {
  const base = window.api;
  const state = window.permissionFixture = { holdGet: true, getWaiters: [], holdSet: false, pendingSet: null, changes: [], beforeWaiter: null, notices: [] };
  const permissions = {
    get: async id => { if (state.holdGet) await new Promise(resolve => state.getWaiters.push(resolve)); return base.permissions.get(id); },
    set: async request => { state.changes.push(JSON.parse(JSON.stringify(request))); if (state.holdSet) await new Promise(resolve => { state.pendingSet = resolve; }); return base.permissions.set(request); },
    onChanged: handler => base.permissions.onChanged(handler),
  };
  state.releaseGet = () => { state.holdGet = false; for (const resolve of state.getWaiters.splice(0)) resolve(); };
  window.api = new Proxy(base, { get(target, key) { return key === 'permissions' ? permissions : target[key]; } });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n') + `\n(${installFixture.toString()})();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}\nlocalStorage.clear();</script>`);
  const file = path.join(output, 'fixture.html'); fs.writeFileSync(file, html);
  win = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(file); win.showInactive(); await waitFor('providerRoutingLoaded&&!restoringActiveRuns&&!!permissionControls');
  await check('unloadedPermissionIsDisabledAndNeverShowsFullAccess', "document.querySelector('#btnPermissionMode').disabled&&!document.querySelector('#btnPermissionMode').textContent.includes('完全访问')&&document.querySelector('#btnPermissionMode').dataset.permissionMode===''");
  await act('permissionFixture.releaseGet();'); await waitFor("document.querySelector('#btnPermissionMode').dataset.permissionMode==='default'&&!document.querySelector('#btnPermissionMode').disabled");
  await check('compactPermissionTriggerImmediatelyFollowsPlus', "(()=>{const plus=document.querySelector('#btnAttach'),button=document.querySelector('#btnPermissionMode'),a=plus.getBoundingClientRect(),b=button.getBoundingClientRect();return plus.nextElementSibling===button&&b.left>=a.right&&b.left-a.right<12&&b.width<165&&b.height<=30&&button.textContent==='请求批准'})()");
  await check('idlePermissionTriggerMatchesTheTransparentModelControl', "(()=>{const permission=getComputedStyle(document.querySelector('#btnPermissionMode')),model=getComputedStyle(document.querySelector('#btnModelSwitch'));return permission.backgroundColor==='rgba(0, 0, 0, 0)'&&permission.boxShadow==='none'&&permission.borderRadius===model.borderRadius&&permission.height===model.height})()");
  await click('#btnPermissionMode');
  await check('threeRowsDescribeActualPermissionBehaviorAndCurrentChoice', "(()=>{const rows=[...document.querySelectorAll('[data-permission-option]')];return rows.map(row=>row.querySelector('.rpc-option-label').textContent).join('|')==='请求批准|帮我批准|完全访问权限'&&rows[0].textContent.includes('需要工具授权时请求批准')&&rows[1].textContent.includes('自动允许文件编辑，其他操作请求批准')&&rows[2].textContent.includes('跳过常规工具审批，访问文件并执行命令')&&rows[0].getAttribute('aria-checked')==='true'&&getComputedStyle(rows[2].querySelector('.rpc-option-icon')).color!==getComputedStyle(rows[0].querySelector('.rpc-option-icon')).color})()");
  await check('permissionCardIsCompactAndAllDescriptionsRemainVisible', "(()=>{const menu=document.querySelector('.rpc-popover'),r=menu.getBoundingClientRect(),button=document.querySelector('#btnPermissionMode').getBoundingClientRect();return menu.dataset.placement==='above'&&r.width>=276&&r.width<=281&&r.height<=190&&r.top>=10&&r.left>=10&&r.right<=innerWidth-9&&r.bottom<=button.top-6&&menu.scrollHeight<=menu.clientHeight+1&&[...menu.querySelectorAll('.rpc-option-description')].every(node=>{const text=node.getBoundingClientRect();return text.right<=r.right-10&&text.bottom<r.bottom})})()");
  await act("permissionFixture.openBackground=getComputedStyle(document.querySelector('#btnPermissionMode')).backgroundColor;");
  await screenshot('permissions-light');
  await key('ArrowDown'); await key('End');
  await check('keyboardNavigationMovesAmongRowsWithoutChangingPermissions', "document.activeElement.dataset.permissionOption==='bypassPermissions'&&permissionFixture.changes.length===0");
  await key('Escape');
  await check('escapeClosesAndRestoresTriggerFocus', "!document.querySelector('.rpc-popover')&&document.activeElement.id==='btnPermissionMode'");
  await click('#btnModelSwitch'); await waitFor("document.querySelector('#modelSettingsPopup')?.classList.contains('show')");
  await check('permissionOpenBackgroundMatchesTheModelControl', "permissionFixture.openBackground===getComputedStyle(document.querySelector('#btnModelSwitch')).backgroundColor&&permissionFixture.openBackground!=='rgba(0, 0, 0, 0)'");
  await click('#btnPermissionMode');
  await check('permissionOpeningClosesTheModelMenu', "!!document.querySelector('.rpc-popover')&&!document.querySelector('#modelSettingsPopup').classList.contains('show')");
  await click('#btnAttach');
  await check('plusOpeningClosesPermissionAndPermissionOpeningClosesPlus', "!document.querySelector('.rpc-popover')&&!!document.querySelector('.composer-add-menu')");
  await click('#btnPermissionMode');
  await check('permissionOpeningLeavesOnlyItsOwnMenu', "!!document.querySelector('.rpc-popover')&&!document.querySelector('.composer-add-menu')");
  await click('[data-permission-option="acceptEdits"]'); await waitFor("document.querySelector('#btnPermissionMode').dataset.permissionMode==='acceptEdits'");
  await check('successfulChangeUpdatesOnlyAfterTheAcceptedHostState', "document.querySelector('#btnPermissionMode').textContent==='帮我批准'&&!document.querySelector('.rpc-popover')&&permissionFixture.changes.at(-1).permissionMode==='acceptEdits'");
  await act("permissionFixture.holdSet=true;uiFixture.failNextPermission=true;"); await click('#btnPermissionMode'); await click('[data-permission-option="bypassPermissions"]');
  await waitFor('!!permissionFixture.pendingSet');
  await check('pendingChangeKeepsTheOldLabelAndDisablesRepeatSubmission', "document.querySelector('#btnPermissionMode').disabled&&document.querySelector('#btnPermissionMode').textContent==='帮我批准'&&document.querySelector('[data-permission-option=acceptEdits]').getAttribute('aria-checked')==='true'&&[...document.querySelectorAll('[data-permission-option]')].every(node=>node.disabled)");
  await act('permissionFixture.holdSet=false;permissionFixture.pendingSet();'); await waitFor("!document.querySelector('#btnPermissionMode').disabled");
  await check('failedChangeRetainsTheEffectivePermissionAndOffersAnotherChoice', "document.querySelector('#btnPermissionMode').dataset.permissionMode==='acceptEdits'&&!!document.querySelector('.rpc-popover')&&!document.querySelector('[data-permission-option=default]').disabled");
  await key('Escape');
  await click('#btnAttach'); await act("[...document.querySelectorAll('.composer-menu-item')].find(node=>node.querySelector('.composer-menu-label>span')?.textContent==='计划模式').click();");
  await waitFor("currentExecutionMode.kind==='plan'&&document.querySelector('#btnPermissionMode').disabled");
  await check('planModePreservesBasePermissionButMakesItsRestrictionExplicit', "document.querySelector('#btnPermissionMode').textContent==='帮我批准'&&document.querySelector('#btnPermissionMode').title.includes('计划模式')&&!document.querySelector('.rpc-popover')");
  await click('#btnExecutionMode'); await waitFor("currentExecutionMode.kind==='default'&&!document.querySelector('#btnPermissionMode').disabled");
  await check('leavingPlanRestoresTheSameBasePermission', "document.querySelector('#btnPermissionMode').dataset.permissionMode==='acceptEdits'");
  await evaluate("openSettings('general')"); await waitFor("!!document.querySelector('.set-cat[data-cat=general].active')");
  await check('settingsNoLongerContainsTheOldPermissionOrSkipDangerousControls', "!document.querySelector('#set-permMode')&&!document.querySelector('#sw-skipDangerous')");
  await act('closeSettings();');
  await evaluate("(async()=>{const id='dddddddd-1111-4111-8111-222222222222';await window.api.history.save({id,title:'权限验证用历史对话',model:'opus',mode:'plain',createdAt:'2026-09-09T01:00:00Z',updatedAt:'2026-09-09T01:00:00Z',turns:[{user:'保留已有会话',assistant:'已有答复'}]});await loadConversation(id);})()");
  await waitFor("currentConv?.id==='dddddddd-1111-4111-8111-222222222222'&&!document.querySelector('#btnPermissionMode').disabled");
  await act("uiFixture.emit('interactions.onEvent',{type:'interaction.pending',interaction:{id:'live-pending-permission',kind:'permission',state:'pending',conversationId:currentConv.id,toolName:'Bash',permission:{input:{command:'synthetic command'},canAllowForSession:false}}});");
  await waitFor("!interactionSurfaceMount.hidden");
  await check('pendingApprovalStillAllowsOpeningTheCurrentPermissionMenu', "!document.querySelector('#btnPermissionMode').disabled&&document.querySelector('.interaction-permission-card')");
  await act('permissionFixture.holdSet=true;permissionFixture.pendingSet=null;uiFixture.failNextPermission=true;'); await click('#btnPermissionMode'); await click('[data-permission-option="bypassPermissions"]');
  await waitFor('!!permissionFixture.pendingSet');
  await check('pendingSwitchDoesNotOptimisticallyAnswerTheWaitingApproval', "!interactionSurfaceMount.hidden&&uiFixture.decisions.length===0&&currentConv.permissionMode==='acceptEdits'&&document.querySelector('#btnPermissionMode').disabled");
  await act('permissionFixture.holdSet=false;permissionFixture.pendingSet();'); await waitFor("!document.querySelector('#btnPermissionMode').disabled");
  await check('failedSwitchKeepsTheExistingApprovalAvailable', "!interactionSurfaceMount.hidden&&!document.querySelector('.interaction-button-primary').disabled&&uiFixture.decisions.length===0");
  await check('existingConversationFailureCannotChangeItsRecordedPermission', "currentConv.permissionMode==='acceptEdits'&&document.querySelector('#btnPermissionMode').dataset.permissionMode==='acceptEdits'&&permissionFixture.changes.at(-1).conversationId===currentConv.id");
  await key('Escape');
  await act("uiFixture.emit('interactions.onEvent',{type:'interaction.resolved',interaction:{id:'live-pending-permission',kind:'permission',state:'resolved',conversationId:currentConv.id}});");
  await waitFor('interactionSurfaceMount.hidden');
  await click('#btnPermissionMode'); await click('#btnModelSwitch');
  await check('modelOpeningAlsoClosesPermissionCard', "!document.querySelector('.rpc-popover')&&document.querySelector('#modelSettingsPopup').classList.contains('show')");
  await act('hideModelPopup();');
  win.setSize(760, 660); await waitFor('innerWidth<=760'); await act("document.documentElement.dataset.theme='dark';"); await click('#btnPermissionMode');
  await check('darkNarrowPopoverStaysWithinTheWindow', "(()=>{const r=document.querySelector('.rpc-popover').getBoundingClientRect();return r.left>=9&&r.right<=innerWidth-9&&r.top>=9&&r.bottom<=innerHeight-9&&document.documentElement.scrollWidth<=innerWidth})()");
  diagnostics.darkCard = await evaluate("(()=>{const menu=document.querySelector('.rpc-popover'),style=getComputedStyle(menu),rect=menu.getBoundingClientRect();return{opacity:style.opacity,background:style.backgroundColor,color:style.color,scrollX,viewport:innerWidth,rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},htmlLeft:document.documentElement.getBoundingClientRect().left,bodyLeft:document.body.getBoundingClientRect().left}})()");
  await screenshot('permissions-dark-narrow'); await key('Escape');
  await act(`const host=document.createElement('div');host.id='permissionFixtureScroll';host.style.cssText='position:fixed;z-index:3100;left:20px;top:70px;width:300px;height:210px;overflow:auto;background:var(--bg-panel)';const inner=document.createElement('div');inner.style.cssText='height:450px;padding-top:220px;padding-left:12px';const button=document.createElement('button');button.id='permissionFixtureButton';inner.append(button);host.append(inner);document.body.append(host);host.scrollTop=120;permissionFixture.auxState={permissionMode:'default'};permissionFixture.aux=RelayPermissionControls.create({button,getState:()=>permissionFixture.auxState,onChange:async mode=>{permissionFixture.auxState.permissionMode=mode},beforeOpen:()=>permissionFixture.holdBefore?new Promise(resolve=>permissionFixture.beforeWaiter=resolve):undefined,notify:message=>permissionFixture.notices.push(message)});`);
  await click('#permissionFixtureButton'); await act("permissionFixture.oldTop=document.querySelector('.rpc-popover').getBoundingClientRect().top;document.querySelector('#permissionFixtureScroll').scrollTop+=20;"); await settle();
  await check('scrollingRepositionsTheSharedCardWithItsAnchor', "!!document.querySelector('.rpc-popover')&&Math.abs(document.querySelector('.rpc-popover').getBoundingClientRect().top-permissionFixture.oldTop)>10");
  await act("document.querySelector('#permissionFixtureScroll').scrollTop=0;"); await settle();
  await check('clippingTheAnchorClosesTheCardRatherThanLeavingItFloating', "!document.querySelector('.rpc-popover')");
  await act("document.querySelector('#permissionFixtureScroll').scrollTop=120;permissionFixture.holdBefore=true;"); await click('#permissionFixtureButton'); await waitFor('!!permissionFixture.beforeWaiter');
  await key('Escape'); await act('permissionFixture.beforeWaiter();'); await settle();
  await check('cancelledAsyncBeforeOpenCannotReopenAStaleMenu', "!document.querySelector('.rpc-popover')&&!document.querySelector('#permissionFixtureButton').disabled");
  await act('permissionFixture.aux.destroy();document.querySelector("#permissionFixtureScroll").remove();');
  await check('sharedControlNeedsNoBridgeAndRendererHasNoRuntimeErrors', "permissionFixture.notices.length===0&&uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'");
  step='completed';save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{failures.push(String(error.stack||error));try{if(win&&!win.isDestroyed()){diagnostics.state=await evaluate("({errors:uiFixture.errors,mode:currentPermissionState,button:document.querySelector('#btnPermissionMode')?.outerHTML,menu:document.querySelector('.rpc-popover')?.outerHTML})");await screenshot('failure');}}catch(_){}save();console.error(error.stack);clearTimeout(deadline);app.exit(1);});
