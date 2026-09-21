'use strict';
// Production renderer in an isolated Windows Electron profile. All services are
// memory fixtures; the launcher never opens a real file, terminal or website.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/workspace-launcher-layout-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'loading';
const report = { checks: {}, samples: {}, errors: [] };
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, ...report }, null, 2));
const timeout = setTimeout(() => { report.errors.push('Timeout: ' + step); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = async () => { await delay(360); await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); };
async function until(predicate) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function tick(){if(${predicate})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(predicate)}));setTimeout(tick,20);}tick();})`); }
async function check(name, value) { step = name; report.checks[name] = !!(typeof value === 'string' ? await evaluate(value) : value); save(); if (!report.checks[name]) throw Error(name); }
async function capture(name) { fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function sample(name) {
  const value = await evaluate(`(()=>{
    const panel=$('workspacePanel').getBoundingClientRect(), launcher=$('workspaceNoTabs').getBoundingClientRect(), actions=$('workspaceLauncherActions').getBoundingClientRect();
    const header=document.querySelector('.workspace-panel-header').getBoundingClientRect();
    const buttons=[...$('workspaceLauncherActions').children].map(button=>{const r=button.getBoundingClientRect();return{kind:button.dataset.workspaceCreate,rect:r.toJSON(),hit:button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};});
    return{panel:panel.toJSON(),launcher:launcher.toJSON(),actions:actions.toJSON(),header:header.toJSON(),buttons,xError:actions.left+actions.width/2-panel.left-panel.width/2,yError:actions.top+actions.height/2-panel.top-panel.height/2,scrollHeight:$('workspaceNoTabs').scrollHeight,clientHeight:$('workspaceNoTabs').clientHeight,scrollTop:$('workspaceNoTabs').scrollTop};
  })()`);
  report.samples[name] = value; save(); return value;
}
async function centered(name) {
  await settle(); const geometry = await sample(name);
  await check(name + '-centeredOnPanel', Math.abs(geometry.xError) < 1 && Math.abs(geometry.yError) < 1);
  await check(name + '-actionsFitAndHit', geometry.buttons.length === 4 && geometry.buttons.every(button=>button.hit&&button.rect.left>=geometry.panel.left&&button.rect.right<=geometry.panel.right&&button.rect.top>=geometry.header.bottom&&button.rect.bottom<=geometry.panel.bottom));
  await check(name + '-captionActionsStillHit', `['workspaceMaximize','workspaceClose'].every(id=>{const button=$(id),r=button.getBoundingClientRect();return r.height>=28&&button.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})`);
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{localStorage.clear();const original=window.api;const calls=window.launcherFixture={resolves:0};const workspace={resolve:async context=>{calls.resolves++;return{ok:true,root:'C:/Synthetic/Launcher',conversationId:context.conversationId};},list:async()=>({ok:true,entries:[{name:'example.md',path:'example.md',type:'file',size:24}]}),onTerminalEvent:()=>()=>{}};const browser={invoke:async()=>({ok:true,tabs:[],activeId:null}),onEvent:()=>()=>{}};window.api=new Proxy(original,{get(o,k){if(k==='workspace')return workspace;if(k==='browser')return browser;if(k==='windowChrome')return{overlay:true,initialTheme:'dark',setTheme(){}};return o[k];}});})();`;
  const file = path.join(output, 'fixture.html');
  fs.writeFileSync(file, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer')+path.sep).href}"><script>${fixture}\n${seed}</script>`));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#1a1a1a', symbolColor: '#e4e4e7', height: 36 }, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(file); win.showInactive();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await act("document.documentElement.dataset.theme='dark';$('btnWorkspacePanel').click()");
  await centered('default'); await capture('default-dark');
  await check('EmptyLauncherCreatesNoHistoryOrWorkspace', "launcherFixture.resolves===0&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')&&relayWorkspacePanel.getState().tabs.length===0");
  await act("$('workspaceResizeHandle').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
  await centered('minimumWidth'); await capture('minimum-width');
  // Drive the real resizer's handlers and sample the rendered geometry each frame.
  await act(`window.launcherDrag={pointerId:41,x:$('workspaceResizeHandle').getBoundingClientRect().left+4,start:relayWorkspacePanel.getState().width};$('workspaceResizeHandle').dispatchEvent(new PointerEvent('pointerdown',{pointerId:41,clientX:launcherDrag.x,button:0,bubbles:true,isPrimary:true}));`);
  for (const requested of [350, 475, 630, 510]) {
    await act(`window.dispatchEvent(new PointerEvent('pointermove',{pointerId:41,clientX:launcherDrag.x+launcherDrag.start-${requested},bubbles:true}));`);
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const geometry = await sample('drag-' + requested);
    await check('drag-' + requested + '-remainsCentered', Math.abs(geometry.panel.width-requested)<1&&Math.abs(geometry.xError)<1&&Math.abs(geometry.yError)<1);
  }
  await act("window.dispatchEvent(new PointerEvent('pointerup',{pointerId:41,bubbles:true}));$('workspaceMaximize').click()");
  await centered('maximized'); await capture('maximized-dark');
  await act("$('workspaceMaximize').click();document.documentElement.dataset.theme='light'");
  win.setContentSize(900, 600); await centered('smallWindow'); await capture('small-window-light');
  // A short panel cannot fit centered controls plus its header. Its scrollable
  // launcher must keep every control reachable, with the header still clickable.
  win.setContentSize(900, 220); await settle();
  await act("$('workspaceNoTabs').scrollTop=0");
  const short = await sample('shortWindow');
  await check('ShortWindowKeepsFirstActionBelowHeader', short.scrollHeight>short.clientHeight&&short.buttons[0].rect.top>=short.header.bottom&&short.buttons[0].hit);
  await act("$('workspaceLauncherActions').lastElementChild.focus()"); await settle();
  const afterFocus = await sample('shortWindowLastFocus');
  await check('ShortWindowCanReachLastAction', afterFocus.scrollTop>0&&afterFocus.buttons.at(-1).hit&&afterFocus.buttons.at(-1).rect.bottom<=afterFocus.panel.bottom);
  await check('ShortWindowCaptionActionsStillHit', "['workspaceMaximize','workspaceClose'].every(id=>{const b=$(id),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})");
  await capture('short-window-last-action');
  win.setContentSize(900, 600); await settle();
  await act("$('workspaceNoTabs').scrollTop=0;$('workspaceNoTabs').querySelector('[data-workspace-create=files]').click()");
  await until("document.querySelector('[data-path=\"example.md\"]')"); await settle();
  await check('ToolTabRestoresHeaderFlowAndDividerAlignment', "$('workspaceNoTabs').hidden&&getComputedStyle(document.querySelector('.workspace-panel-header')).position!=='absolute'&&Math.abs($('workspaceFiles').getBoundingClientRect().top-document.querySelector('.chat-header').getBoundingClientRect().bottom)<1");
  await act("$('workspaceTabs').querySelector('.workspace-tab-close').click()");
  await centered('lastTabClosed');
  await act("$('workspaceClose').click();$('btnWorkspacePanel').click()");
  await centered('reopened');
  await check('RendererRemainsSandboxed', "typeof require==='undefined'&&typeof process==='undefined'&&uiFixture.errors.length===0");
  step='completed'; save(); clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(async error=>{report.errors.push(String(error.stack||error));save();console.error(error.stack);try{if(win&&!win.isDestroyed())await capture('failure');}catch(_){}clearTimeout(timeout);app.exit(1);});
