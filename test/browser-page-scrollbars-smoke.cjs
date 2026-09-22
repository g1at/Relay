'use strict';
// Real WebContents + production browser host; only synthetic loopback documents.
// No Relay main window/services and no external webpage is opened.
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { createBrowserPanelHost } = require('../src/main/browser/browser-panel-host');
const output = path.resolve(__dirname, '../.codex-tmp/browser-page-scrollbars-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const report = { checks: {}, errors: [] };
let owner, host, first, second, current = 'startup';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { report.errors.push('timeout: ' + current); finish(1); }, 55000);
function finish(code) {
  clearTimeout(deadline); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  host?.destroy(); if (owner && !owner.isDestroyed()) owner.destroy(); first?.close(); second?.close(); app.exit(code);
}
async function until(fn, label) { current = label; const end = Date.now() + 6500; while (Date.now() < end) { try { if (await fn()) return; } catch (_) {} await pause(30); } throw Error('timeout: ' + label); }
async function check(name, condition) { current = name; report.checks[name] = !!await condition; console.log(name + ': ' + report.checks[name]); if (!report.checks[name]) throw Error(name); }
app.whenReady().then(async () => {
  let iframeBase;
  const serve = (request, response) => {
    if (request.url === '/site.css') {
      response.writeHead(200, { 'Content-Type': 'text/css' });
      response.end('html{scrollbar-width:thin!important}html::-webkit-scrollbar{width:24px!important}html::-webkit-scrollbar-button{display:block!important;width:24px!important;height:24px!important}body{margin:0;padding:30px;font:15px system-ui;background:#fafafa;color:#242424}body.dark{background:#18191b;color:#eee}h1{font-size:24px}.scroll{width:260px;height:120px;overflow:auto;border:1px solid #aaa}.scroll>div{height:700px;width:600px}textarea{width:260px;height:80px;display:block;margin-top:20px}iframe{width:300px;height:200px;border:1px solid #aaa}.spacer{height:1400px}'); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; frame-src http://127.0.0.1:*; script-src 'none'" });
    response.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/site.css"><title>Relay scrollbar fixture</title><h1>网页滚动条验证</h1><div id="nested" class="scroll"><div>独立滚动内容</div></div><textarea id="input">' + '可编辑文字\n'.repeat(30) + '</textarea><iframe src="' + iframeBase + '/frame"></iframe><div class="spacer">底部内容</div>');
  };
  // Frame uses a separate origin and no privileged bridge. It has ordinary author
  // scrollbar rules; main page intentionally uses stronger author !important rules.
  second = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'" });
    response.end('<!doctype html><style>body{margin:0;background:#fff}::-webkit-scrollbar{width:22px}div{height:1800px}</style><div>跨源子页面</div>');
  });
  await new Promise(resolve => second.listen(0, '127.0.0.1', resolve)); iframeBase = 'http://127.0.0.1:' + second.address().port;
  first = http.createServer(serve); await new Promise(resolve => first.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + first.address().port;
  app.on('session-created', ses => ses.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) && ![base, iframeBase].some(origin => details.url.startsWith(origin + '/')) })));
  owner = new BrowserWindow({ width: 660, height: 760, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await owner.loadURL('about:blank'); host = createBrowserPanelHost({ owner, WebContentsView, session });
  const created = await host.invoke({ action: 'create', url: base + '/' });
  await host.invoke({ action: 'setBounds', rect: { x: 0, y: 0, width: 640, height: 680 } });
  await host.invoke({ action: 'visibility', id: created.id, visible: true }); owner.show();
  const wc = owner.contentView.children.find(view => view.webContents !== owner.webContents).webContents;
  const js = code => wc.executeJavaScript(code);
  const move = (x, y) => wc.sendInputEvent({ type: 'mouseMove', x, y });
  await until(() => js('document.adoptedStyleSheets.length===1&&!!document.getElementById("nested")'), 'main document styled');
  move(220, 25); await pause(900);
  await check('strictCspPageGetsNinePixelNativeBarWithoutArrows', js('getComputedStyle(document.documentElement,"::-webkit-scrollbar").width==="9px"&&getComputedStyle(document.documentElement,"::-webkit-scrollbar-button").display==="none"'));
  await check('thumbStartsHiddenWithoutChangingPageOverflow', js('getComputedStyle(document.documentElement,"::-webkit-scrollbar-thumb").backgroundColor==="rgba(0, 0, 0, 0)"&&getComputedStyle(document.documentElement).overflowY==="visible"'));
  const size = await js('({width:innerWidth,height:innerHeight})'); move(size.width - 12, 25);
  await until(() => js('document.documentElement.hasAttribute("data-relay-scroll-visible")'), 'native edge reveal');
  await check('edgeRevealsRoundedThumb', js('getComputedStyle(document.documentElement,"::-webkit-scrollbar-thumb").borderRadius==="999px"&&getComputedStyle(document.documentElement,"::-webkit-scrollbar-thumb").backgroundColor!=="rgba(0, 0, 0, 0)"'));
  fs.writeFileSync(path.join(output, 'webpage-scrollbar-light.png'), (await wc.capturePage()).toPNG());
  move(400, 40); await pause(950);
  await check('leavingEdgeHidesThumb', js('!document.documentElement.hasAttribute("data-relay-scroll-visible")'));
  await js('window.scrollTo(0,250)'); await until(() => js('scrollY>100&&document.documentElement.hasAttribute("data-relay-scroll-visible")'), 'scroll reveal');
  await check('programmaticAndWheelScrollRemainNative', js('scrollY>100'));
  move(350, 240); wc.sendInputEvent({ type: 'mouseWheel', x: 350, y: 240, deltaY: -140, wheelTicksY: -1, canScroll: true });
  await until(() => js('scrollY>250'), 'wheel scroll');
  await js('scrollTo(0,0)'); await pause(150);
  move(size.width - 3, 35); wc.sendInputEvent({ type: 'mouseDown', x: size.width - 3, y: 35, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseMove', x: size.width - 3, y: 185, modifiers: ['leftButtonDown'] });
  wc.sendInputEvent({ type: 'mouseUp', x: size.width - 3, y: 185, button: 'left', clickCount: 1 });
  await until(() => js('scrollY>0'), 'native scrollbar drag');
  await check('draggingNativeThumbStillScrollsDocument', js('scrollY>0'));
  await js('scrollTo(0,0);document.body.classList.add("dark")'); move(size.width - 12, 26);
  await until(() => js('document.documentElement.getAttribute("data-relay-scroll-tone")==="dark"'), 'dark thumb');
  fs.writeFileSync(path.join(output, 'webpage-scrollbar-dark.png'), (await wc.capturePage()).toPNG());
  await js('document.getElementById("nested").scrollTop=90;document.getElementById("input").scrollTop=40');
  await until(() => js('document.getElementById("nested").hasAttribute("data-relay-scroll-visible")&&document.getElementById("input").hasAttribute("data-relay-scroll-visible")'), 'nested scroll');
  await check('nestedScrollersAndEditableTextareasUseThinTracks', js('["nested","input"].every(id=>getComputedStyle(document.getElementById(id),"::-webkit-scrollbar").width==="9px")&&document.getElementById("input").value.includes("可编辑文字")'));
  await until(async () => { const frame = wc.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(iframeBase)); return frame && await frame.executeJavaScript('document.adoptedStyleSheets.length===1'); }, 'cross origin iframe styled');
  const frame = wc.mainFrame.framesInSubtree.find(frame => frame.url.startsWith(iframeBase));
  await check('crossOriginFrameReceivesPresentationOnly', frame.executeJavaScript('getComputedStyle(document.documentElement,"::-webkit-scrollbar").width==="9px"&&typeof require==="undefined"&&typeof window.api==="undefined"'));
  await js('const box=document.createElement("div");box.id="dynamic";box.className="scroll";box.innerHTML="<div>动态内容</div>";document.body.prepend(box);box.scrollTop=60');
  await until(() => js('document.getElementById("dynamic").hasAttribute("data-relay-scroll-visible")'), 'dynamic content styled');
  await check('spaInsertedScrollersNeedNoReinstallation', js('document.adoptedStyleSheets.length===1&&getComputedStyle(document.getElementById("dynamic"),"::-webkit-scrollbar").height==="9px"'));
  await host.invoke({ action: 'navigate', id: created.id, url: base + '/next' });
  await until(() => js('location.pathname==="/next"&&document.adoptedStyleSheets.length===1&&getComputedStyle(document.documentElement,"::-webkit-scrollbar").width==="9px"'), 'new document styled');
  await check('navigationReinstallsWithoutDuplicateSheetsOrAppAccess', js('document.adoptedStyleSheets.length===1&&typeof require==="undefined"&&typeof window.api==="undefined"'));
  finish(0);
}).catch(async error => { report.errors.push(String(error.stack || error)); console.error(error); finish(1); });
