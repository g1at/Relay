'use strict';
// Loopback-only streamed HTML pauses in a parser-blocking script. Measurements
// come from the page itself before DOMContentLoaded, including its first paint.
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { createBrowserPanelHost } = require('../browser-panel-host');
const { attachBrowserPageScrollbars } = require('../browser-page-scrollbars');
const output = path.resolve(__dirname, '../.codex-tmp/browser-page-scrollbars-reload-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-background-networking'); app.on('window-all-closed', () => {});
const report = { checks: {}, errors: [], documents: {} }, gates = new Map(), counts = new Map();
let owner, host, server, control, stage = 'startup';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { report.errors.push('timeout: ' + stage); finish(1); }, 45000);
function finish(code) {
  clearTimeout(deadline); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  for (const response of gates.values()) response.end(); gates.clear();
  host?.destroy(); control?.webContents.close({ waitForBeforeUnload: false });
  if (owner && !owner.isDestroyed()) owner.destroy(); server?.close(); app.exit(code);
}
function check(name, condition) { stage = name; report.checks[name] = !!condition; console.log(name + ': ' + report.checks[name]); if (!condition) throw Error(name); }
async function until(fn, label) { stage = label; const end = Date.now() + 6500; while (Date.now() < end) { if (await fn()) return; await pause(25); } throw Error('timeout: ' + label); }
const snapshots = id => report.documents[id] || [];
const frames = id => snapshots(id).filter(item => item.phase === 'frame' && item.ready === 'loading' && item.overflow);
function release(id) { const response = gates.get(id); if (!response) throw Error('missing script gate ' + id); gates.delete(id); response.end('/* synthetic parser gate released */'); }
app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    if (url.pathname === '/report') {
      let data = ''; request.on('data', chunk => { data += chunk; }); request.on('end', () => {
        const value = JSON.parse(data); (report.documents[value.id] ||= []).push(value);
        response.writeHead(204); response.end();
      }); return;
    }
    if (url.pathname === '/gate.js') { response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); gates.set(url.searchParams.get('id'), response); return; }
    const label = url.searchParams.get('id') || 'fixture', ordinal = (counts.get(label) || 0) + 1;
    counts.set(label, ordinal); const id = label + '-' + ordinal;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'" });
    response.flushHeaders();
    response.end(`<!doctype html><meta charset="utf-8"><title>Delayed browser fixture ${id}</title>
      <style>html{scrollbar-width:auto!important}html::-webkit-scrollbar{width:24px!important;background:#eee!important}html::-webkit-scrollbar-button{display:block!important;width:24px!important;height:24px!important}body{margin:0;background:#fafafa;color:#292929;font:16px system-ui}h1,p{padding:0 30px}.long{height:2500px;background:linear-gradient(#fafafa,#dedfe4)}</style>
      <script>
        const id=${JSON.stringify(id)};
        function record(phase){const root=document.documentElement;fetch('/report',{method:'POST',body:JSON.stringify({id,phase,ready:document.readyState,
          width:getComputedStyle(root,'::-webkit-scrollbar').width,arrows:getComputedStyle(root,'::-webkit-scrollbar-button').display,
          actualWidth:innerWidth-root.clientWidth,overflow:root.scrollHeight>innerHeight,
          isolated:typeof require==='undefined'&&typeof process==='undefined'&&typeof window.api==='undefined'&&typeof window.electron==='undefined'})});}
        record('first-script');addEventListener('DOMContentLoaded',()=>record('dom-content-loaded'));
      </script><body><h1>页面刷新中的滚动条</h1><p>这是本地慢速页面，正文已经绘制，后续脚本仍在等待。</p><div class="long"></div>
      <script>let count=0;function sample(){record('frame');if(++count<120)requestAnimationFrame(sample);}requestAnimationFrame(sample);</script>
      <script src="/gate.js?id=${id}"></script></body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + server.address().port;
  app.on('session-created', ses => ses.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(base + '/') })));
  owner = new BrowserWindow({ width: 660, height: 760, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('about:blank');
  // Reproduce the old lifecycle without the new preload: dom-ready arrives after
  // the page has already painted its wide scrollbar for several frames.
  control = new WebContentsView({ webPreferences: { session: session.fromPartition('relay-scrollbar-control'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  owner.contentView.addChildView(control); control.setBounds({ x: 0, y: 0, width: 640, height: 680 }); owner.show();
  attachBrowserPageScrollbars(control.webContents); void control.webContents.loadURL(base + '/slow?id=control');
  await until(() => frames('control-1').length >= 4 && gates.has('control-1'), 'old lifecycle first frames');
  check('regressionFixtureReproducesWideScrollbarBeforeDomReady', frames('control-1').every(item => item.width === '24px' && item.arrows === 'block'));
  release('control-1'); await until(() => !control.webContents.isLoading(), 'control load finish');
  await until(() => control.webContents.executeJavaScript('getComputedStyle(document.documentElement,"::-webkit-scrollbar").width==="9px"'), 'control style catches up');
  check('oldLifecycleOnlyFixesScrollbarAfterLoad', true); control.webContents.close({ waitForBeforeUnload: false }); owner.contentView.removeChildView(control); control = null;
  host = createBrowserPanelHost({ owner, WebContentsView, session });
  const created = await host.invoke({ action: 'create', url: base + '/slow?id=fixed' });
  await host.invoke({ action: 'setBounds', rect: { x: 0, y: 0, width: 640, height: 680 } });
  await host.invoke({ action: 'visibility', id: created.id, visible: true });
  const wc = owner.contentView.children.find(view => view.webContents !== owner.webContents).webContents;
  wc.on('preload-error', (_event, _path, error) => { report.errors.push('preload: ' + error.message); });
  for (const ordinal of [1, 2, 3]) {
    const id = 'fixed-' + ordinal;
    if (ordinal > 1) await host.invoke({ action: 'reload', id: created.id });
    await until(() => frames(id).length >= 8 && gates.has(id), 'styled loading frames ' + ordinal);
    check('document' + ordinal + 'StartsStyledBeforeFirstPageScript', snapshots(id).find(item => item.phase === 'first-script')?.width === '9px');
    check('document' + ordinal + 'HasNoWideScrollbarDuringDelayedPaint', frames(id).every(item => item.width === '9px' && item.arrows === 'none' && item.actualWidth === 9));
    check('document' + ordinal + 'RemainsSandboxedWhileLoading', snapshots(id).every(item => item.isolated));
    if (ordinal === 2) fs.writeFileSync(path.join(output, 'reload-before-dom-ready.png'), (await wc.capturePage()).toPNG());
    release(id); await until(() => !wc.isLoading(), 'completed reload ' + ordinal);
    await until(() => wc.executeJavaScript('document.adoptedStyleSheets.length===1&&getComputedStyle(document.documentElement,"::-webkit-scrollbar").width==="9px"'), 'completed page same style ' + ordinal);
  }
  check('reloadNeverExposesPreloadBridgeAndProducesNoPreloadErrors', report.errors.length === 0 && Object.values(report.documents).flat().every(item => item.isolated));
  finish(0);
}).catch(error => { report.errors.push(String(error.stack || error)); console.error(error); finish(1); });
