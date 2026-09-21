'use strict';
// Real Chromium CSS/keyboard checks with production styles and synthetic content.
// No application bridge, user settings, terminal process or remote requests.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/scrollbars-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, failures = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, failures }, null, 2));
const timeout = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`); }
function cssLinks(documentName) {
  const html = fs.readFileSync(path.join(root, 'renderer', documentName), 'utf8');
  return [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map(match => match[0]).filter(tag => !tag.includes('scrollbars.css')).join('\n');
}
function surface(id, classes, options = {}) {
  const tag = options.tag || 'div';
  const content = tag === 'textarea' ? 'Long editable line '.repeat(30) + '\n' + 'Editable content\n'.repeat(35) : '<div class="audit-content">' + ('Long horizontal content '.repeat(18) + '<br>').repeat(25) + '</div>';
  const element = `<${tag} id="${id}" data-audit-scroll class="audit-scroll ${classes}" tabindex="0" ${tag === 'textarea' ? 'wrap="off"' : ''}>${content}</${tag}>`;
  return `<section class="audit-case"><h2>${id}</h2>${options.before || ''}${element}${options.after || ''}</section>`;
}
async function loadFixture(kind) {
  const mainCases = [
    surface('messages', 'messages'), surface('history', 'sidebar-section'), surface('setContent', 'set-content'),
    surface('modal', 'modal-body', { before: '<div id="settingsModal" class="audit-wrapper">', after: '</div>' }),
    surface('schedule', 'modal', { before: '<div id="scheduleModal" class="schedule-page audit-wrapper">', after: '</div>' }),
    surface('library', 'workspace-page-body'), surface('memory', 'memory-markdown-view'),
    surface('diff', '', { tag: 'pre', before: '<div class="skill-rebase-versions audit-wrapper">', after: '</div>' }),
    surface('agent', 'agent-selection-list'), surface('approval', 'interaction-content'),
    surface('permission', 'rpc-popover'), surface('explore', 'se-customize-list'), surface('select', 'cs-popup'),
    surface('menu', 'workspace-menu'), surface('source', 'workspace-source', { tag: 'pre' }),
    surface('newUnregisteredSource', '', { tag: 'pre' }), surface('models', 'rup-model-list'),
    surface('markdown', '', { tag: 'pre', before: '<div class="relay-readonly-markdown audit-wrapper">', after: '</div>' }),
    surface('input', '', { tag: 'textarea', before: '<div class="input-card audit-wrapper">', after: '</div>' }),
    surface('code', 'pv-code', { tag: 'pre' }),
  ];
  const miniCases = [surface('miniProcess', 'mini-process-content'), surface('miniApproval', 'interaction-content'),
    surface('miniCode', '', { tag: 'pre', before: '<div class="relay-readonly-markdown audit-wrapper">', after: '</div>' }),
    surface('miniPermission', 'rpc-popover'), surface('miniTranscript', 'mini-transcript'), surface('miniInput', '', { tag: 'textarea' })];
  const exceptions = '<section class="audit-case"><h2>intentional exceptions</h2><div class="workspace-tabs" id="hiddenTabs"><span style="min-width:800px">Hidden tab strip</span></div><div class="xterm"><div class="xterm-viewport" id="terminalViewport"><div style="height:500px">Terminal</div></div><div class="xterm-scrollable-element"><div class="scrollbar"><div class="slider" id="terminalSlider"></div></div></div><iframe id="independentPage" srcdoc="&lt;style&gt;body{overflow:scroll}::-webkit-scrollbar{width:17px;height:17px}::-webkit-scrollbar-thumb{background:rgb(77,88,99)}&lt;/style&gt;Separate document"></iframe></section>';
  const html = `<!doctype html><html data-theme="light"><head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}">${cssLinks(kind === 'mini' ? 'mini.html' : 'index.html')}<style>
    html,body{margin:0;min-width:0;width:100%;height:100%;overflow:hidden!important;background:var(--bg-panel);color:var(--text)}
    #audit{height:100%;overflow:auto;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:12px;align-content:start}
    .audit-case{min-width:0;padding:10px;border:1px solid var(--border);border-radius:9px}.audit-case h2{margin:0 0 7px;font:12px/1.5 sans-serif}
    .audit-wrapper{display:block!important;position:static!important;overflow:visible!important;opacity:1!important;transform:none!important}
    .audit-scroll{display:block!important;position:static!important;inset:auto!important;flex:none!important;box-sizing:border-box!important;width:100%!important;height:112px!important;min-height:0!important;max-height:none!important;min-width:0!important;max-width:none!important;padding:6px!important;margin:0!important;overflow:auto!important;opacity:1!important;transform:none!important;border:1px solid var(--border)!important;animation:none!important;transition:none!important}
    .audit-content{width:650px;min-height:500px;white-space:nowrap;font:11px/1.5 monospace}
    #terminalViewport{position:static;width:100px;height:35px;overflow:auto}#hiddenTabs{max-width:100px}#independentPage{width:100px;height:35px;border:0}
  </style></head><body><main id="audit">${(kind === 'mini' ? miniCases : mainCases).join('')}${exceptions}</main></body></html>`;
  const page = path.join(output, kind + '.html'); fs.writeFileSync(page, html); await win.loadFile(page); win.showInactive(); await settle();
  await waitFor("document.getElementById('independentPage').contentDocument?.readyState==='complete'");
  await act(`window.audit={kind:${JSON.stringify(kind)},exceptions:()=>{const viewport=document.getElementById('terminalViewport'),tabs=document.getElementById('hiddenTabs'),frame=document.getElementById('independentPage');return {terminalWidth:getComputedStyle(viewport,'::-webkit-scrollbar').width,terminalColor:getComputedStyle(viewport,'::-webkit-scrollbar-thumb').backgroundColor,slider:getComputedStyle(document.getElementById('terminalSlider')).backgroundColor,tabsWidth:getComputedStyle(tabs).scrollbarWidth,tabsDisplay:getComputedStyle(tabs,'::-webkit-scrollbar').display,remoteWidth:frame.contentWindow.getComputedStyle(frame.contentDocument.body,'::-webkit-scrollbar').width}},surfaces:()=>[...document.querySelectorAll('[data-audit-scroll]')].filter(node=>!['miniInput','miniTranscript'].includes(node.id))};audit.before=audit.exceptions();`);
  await evaluate(`new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href='scrollbars.css';link.onload=resolve;link.onerror=()=>reject(Error('scrollbars.css'));document.head.append(link)})`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 }); await settle();
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  win = new BrowserWindow({ width: 1150, height: 850, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  await loadFixture('main');
  await check('MainSurfacesUseNinePixelTracksInBothDirections', "audit.surfaces().length===20&&audit.surfaces().every(node=>{const css=getComputedStyle(node,'::-webkit-scrollbar');return css.width==='9px'&&css.height==='9px'&&node.scrollWidth>node.clientWidth&&node.scrollHeight>node.clientHeight})");
  await check('LegacyStandardThinRulesNoLongerOverrideTheSharedStyle', "audit.surfaces().every(node=>getComputedStyle(node).scrollbarWidth==='auto'&&getComputedStyle(node).scrollbarColor==='auto')");
  await check('IdleThumbsAndTracksAreTransparentWithoutNativeArrows', "audit.surfaces().every(node=>getComputedStyle(node,'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(node,'::-webkit-scrollbar-track').backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(node,'::-webkit-scrollbar-button').display==='none'&&getComputedStyle(node,'::-webkit-scrollbar-thumb').borderRadius==='999px')");
  await check('HiddenTabTerminalAndIndependentDocumentStylesRemainUnchanged', "JSON.stringify(audit.before)===JSON.stringify(audit.exceptions())&&audit.exceptions().tabsWidth==='none'&&audit.exceptions().tabsDisplay==='none'&&audit.exceptions().remoteWidth==='17px'");
  const point = await evaluate("(()=>{const r=document.getElementById('messages').getBoundingClientRect();return {x:Math.round(r.left+25),y:Math.round(r.top+25)}})()");
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await settle();
  await check('PointerHoverRevealsTheTargetScrollbar', "getComputedStyle(document.getElementById('messages'),'::-webkit-scrollbar-thumb').backgroundColor!=='rgba(0, 0, 0, 0)'&&getComputedStyle(document.getElementById('history'),'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)'");
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 }); await act("document.getElementById('newUnregisteredSource').focus()"); await settle();
  await check('FocusMakesUnregisteredHorizontalSourceReachable', "getComputedStyle(document.getElementById('newUnregisteredSource'),'::-webkit-scrollbar-thumb').backgroundColor!=='rgba(0, 0, 0, 0)'");
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await waitFor("document.getElementById('newUnregisteredSource').scrollLeft>0");
  await check('HorizontalSourceCanBeScrolledUsingTheKeyboard', "document.activeElement.id==='newUnregisteredSource'&&document.activeElement.scrollLeft>0");
  await act("document.activeElement.blur();document.getElementById('modal').classList.add('is-scrolling')"); await settle();
  await check('ExistingScrollActivityClassesRevealTheScrollbar', "getComputedStyle(document.getElementById('modal'),'::-webkit-scrollbar-thumb').backgroundColor!=='rgba(0, 0, 0, 0)'");
  await act("document.getElementById('modal').classList.remove('is-scrolling');document.documentElement.dataset.theme='dark';document.getElementById('setContent').focus()"); await settle();
  await check('DarkThemeUsesItsOwnThumbColorAndRetainsTransparentTrack', "getComputedStyle(document.getElementById('setContent'),'::-webkit-scrollbar-thumb').backgroundColor==='rgb(63, 63, 66)'&&getComputedStyle(document.getElementById('setContent'),'::-webkit-scrollbar-track').backgroundColor==='rgba(0, 0, 0, 0)'");
  await act("document.documentElement.dataset.theme='light';document.getElementById('code').focus()"); await settle();
  await check('DarkCodeSurfacesHaveReadableThumbsInTheLightTheme', "getComputedStyle(document.getElementById('code'),'::-webkit-scrollbar-thumb').backgroundColor==='rgb(89, 97, 109)'");
  await act("document.activeElement.blur();document.getElementById('audit').scrollTop=0"); await settle(); fs.writeFileSync(path.join(output, 'main-light.png'), (await win.webContents.capturePage()).toPNG());
  await loadFixture('mini');
  await check('MiniProcessApprovalCodeAndPermissionSurfacesAreUnified', "audit.surfaces().length===4&&audit.surfaces().every(node=>getComputedStyle(node,'::-webkit-scrollbar').width==='9px'&&getComputedStyle(node,'::-webkit-scrollbar').height==='9px'&&getComputedStyle(node,'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)')");
  await check('MiniTranscriptAndInputRetainTheirProximityControlledHiddenState', "['miniTranscript','miniInput'].every(id=>{const node=document.getElementById(id);return getComputedStyle(node,'::-webkit-scrollbar').width==='9px'&&getComputedStyle(node,'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)'})");
  await act("document.getElementById('miniTranscript').classList.add('is-scroll-near');document.getElementById('miniInput').classList.add('is-scroll-active')"); await settle();
  await check('MiniExistingProximityAndScrollActivityStillRevealTheirThumbs', "['miniTranscript','miniInput'].every(id=>getComputedStyle(document.getElementById(id),'::-webkit-scrollbar-thumb').backgroundColor!=='rgba(0, 0, 0, 0)')");
  await act("document.documentElement.dataset.theme='dark';document.getElementById('miniApproval').focus()"); await settle();
  await check('MiniOtherSurfacesSupportDarkThemeAndKeyboardFocus', "getComputedStyle(document.getElementById('miniApproval'),'::-webkit-scrollbar-thumb').backgroundColor==='rgb(73, 78, 88)'&&getComputedStyle(document.getElementById('miniApproval'),'::-webkit-scrollbar-button').display==='none'");
  await check('StyleFixtureRemainsSandboxedAndOffline', "typeof require==='undefined'&&typeof process==='undefined'");
  step = 'completed'; save(); clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(async error => { failures.push(String(error.stack || error)); save(); console.error(error.stack); try { if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) {} clearTimeout(timeout); app.exit(1); });
