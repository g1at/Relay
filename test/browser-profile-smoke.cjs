'use strict';
// Real Relay renderer, IPC, persistent Chromium session and encrypted form store.
// Only loopback pages and an isolated profile; native pickers select test artifacts.
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const https = require('node:https'), { X509Certificate } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { registerBrowserPanelIpc } = require('../browser-panel-ipc');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp', 'browser-profile-smoke');
fs.mkdirSync(output, { recursive: true });
const profileRoot = fs.mkdtempSync(path.join(output, 'profile-'));
app.setPath('userData', profileRoot);
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const report = { checks: {}, errors: [] }, exported = [], external = [];
let win, registry, server, secureServer;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { report.errors.push('timeout'); finish(); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const invoke = value => evaluate(`api.browser.invoke(${JSON.stringify(value)})`);
async function waitFor(predicate) { const end = Date.now() + 10000; while (Date.now() < end) { if (await (typeof predicate === 'function' ? predicate() : evaluate(predicate))) return; await delay(30); } throw Error('State did not settle: ' + predicate); }
async function check(name, value) { report.checks[name] = !!await (typeof value === 'string' ? evaluate(value) : value); if (!report.checks[name]) throw Error(name); }
const views = () => win.contentView.children.filter(v => v.webContents && v.webContents !== win.webContents);
async function capture(name) { await delay(300); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function finish() { clearTimeout(deadline); try { registry?.dispose(); if (win && !win.isDestroyed()) win.destroy(); for (const instance of [server, secureServer]) if (instance) { instance.closeAllConnections(); instance.close(); } } catch (_) {} fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); app.exit(report.errors.length ? 1 : 0); }
app.whenReady().then(async () => {
  const downloadDirectory = path.join(output, 'downloads'); fs.mkdirSync(downloadDirectory, { recursive: true });
  const handler = (request, response) => {
    if (request.url === '/slow') {
      const total = 4 * 1024 * 1024, start = Number(/bytes=(\d+)-/.exec(request.headers.range || '')?.[1] || 0);
      response.writeHead(start ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="relay-slow.bin"', 'Content-Length': total - start, 'Accept-Ranges': 'bytes', ...(start ? { 'Content-Range': `bytes ${start}-${total - 1}/${total}` } : {}) });
      let sent = start; const timer = setInterval(() => { const size = Math.min(65536, total - sent); response.write(Buffer.alloc(size, 42)); sent += size; if (sent === total) { clearInterval(timer); response.end(); } }, 35);
      response.on('close', () => clearInterval(timer)); return;
    }
    if (request.url === '/download') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="relay-delivery.txt"', 'Content-Length': '18' }); response.end('Relay test content'); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>浏览器交付测试</title><style>body{font:18px system-ui;padding:32px;background:#fafafa;color:#242424}input{display:block;margin:12px;padding:8px}</style><h1>Relay 浏览器</h1><p>历史、书签、下载和本地表单测试。</p><input autocomplete="username" name="username"><input type="password" autocomplete="current-password" name="password"><input autocomplete="name" name="name"><input autocomplete="email" name="email"><input autocomplete="tel" name="phone"><textarea autocomplete="street-address" name="address"></textarea><a id="download" href="/download">下载交付物</a>');
  };
  server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cert = fs.readFileSync(path.join(__dirname, 'fixtures/browser-tls/localhost.pem'));
  secureServer = https.createServer({ cert, key: fs.readFileSync(path.join(__dirname, 'fixtures/browser-tls/localhost.key')) }, handler);
  await new Promise(resolve => secureServer.listen(0, '127.0.0.1', resolve));
  const secureBase = `https://127.0.0.1:${secureServer.address().port}`;
  const fingerprint = value => String(value).replace(/[^a-f0-9]/gi, '').toLowerCase();
  // Trust exactly the repository's synthetic loopback fixture in this harness.
  // Production never overrides certificate verification.
  app.on('certificate-error', (event, _contents, url, _error, certificate, callback) => {
    let trusted = false;
    try { trusted = url.startsWith(secureBase + '/') && fingerprint(new X509Certificate(certificate.data).fingerprint256) === fingerprint(new X509Certificate(cert).fingerprint256); } catch (_) {}
    if (trusted) event.preventDefault(); callback(trusted);
  });
  app.on('session-created', session => session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) && ![base, secureBase].some(origin => details.url.startsWith(origin + '/')) })));
  const entry = path.join(output, 'fixture.html'), preload = path.join(output, 'preload.cjs');
  fs.writeFileSync(preload, `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeBrowser',{invoke:input=>ipcRenderer.invoke('browser:invoke',input),onEvent:handler=>{const listener=(_e,p)=>handler(p);ipcRenderer.on('browser:event',listener);return()=>ipcRenderer.removeListener('browser:event',listener);}});`);
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{localStorage.clear();const original=window.api;const workspace={resolve:async c=>({ok:true,root:'C:/Synthetic/Project',conversationId:c.conversationId}),list:async()=>({ok:true,entries:[]}),onTerminalEvent:()=>()=>{}};window.api=new Proxy(original,{get(o,k){if(k==='browser')return nativeBrowser;if(k==='settings')return{...o[k],read:async()=>({...await o[k].read(),info:{uiVersion:'test'}})};if(k==='workspace')return workspace;if(k==='windowChrome')return{overlay:true,initialTheme:'light',setTheme(){}};return o[k];}});})();`;
  fs.writeFileSync(entry, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 820, show: false, titleBarStyle: 'hidden', titleBarOverlay: { color: '#fafafa', symbolColor: '#343436', height: 35 }, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  registry = registerBrowserPanelIpc({ ipcMain, getWindow: () => win, entryFile: entry, getElectron: () => ({ ...electron,
    shell: { ...electron.shell, openExternal: async url => external.push(url) },
    dialog: { ...electron.dialog, showSaveDialog: async (_owner, options) => { const filePath = path.join(downloadDirectory, 'page.' + options.filters[0].extensions[0]); exported.push(filePath); return { canceled: false, filePath }; } }
  }) });
  await win.loadFile(entry); win.show();
  await waitFor('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await evaluate(`relayWorkspacePanel.openUrl(${JSON.stringify(base + '/one')})`);
  await waitFor(async () => (await invoke({ action: 'state' })).tab?.title === '浏览器交付测试');
  await waitFor(async () => (await invoke({ action: 'state' })).visible);
  let current = (await invoke({ action: 'state' })).tab, first = views().find(v => v.webContents.getURL() === base + '/one');
  await check('real browser stays isolated from Relay IPC', await first.webContents.executeJavaScript('typeof api==="undefined"&&typeof require==="undefined"&&typeof process==="undefined"'));
  await first.webContents.executeJavaScript('document.cookie="relay_session=fixture; Max-Age=3600; SameSite=Lax";localStorage.setItem("relay_session","fixture")');
  await evaluate(`relayWorkspacePanel.openUrl(${JSON.stringify(base + '/two')})`);
  await waitFor(async () => (await invoke({ action: 'state' })).tab?.url === base + '/two' && !(await invoke({ action: 'state' })).tab.loading);
  const second = views().find(v => v.webContents.getURL() === base + '/two');
  await check('same-origin tabs share persistent login storage', first.webContents.session === second.webContents.session && await second.webContents.executeJavaScript('document.cookie.includes("relay_session=fixture")&&localStorage.getItem("relay_session")==="fixture"'));
  await check('persistent browser session is separate from app session', second.webContents.session !== win.webContents.session && second.webContents.session.isPersistent());
  await check('completed visits enter searchable history', (await invoke({ action: 'history.list', query: '/two' })).items.length === 1);
  await act('document.getElementById("workspaceBrowserBookmark").click();');
  await waitFor(async () => (await invoke({ action: 'bookmarks.list' })).items.length === 1);
  await check('bookmark toolbar reflects stored favorite', 'document.getElementById("workspaceBrowserBookmark").getAttribute("aria-pressed")==="true"');
  await invoke({ action: 'settings.update', settings: { showFullUrl: false, searchEngine: 'duckduckgo', downloadDirectory, askDownloadLocation: false } });
  // The test window may be behind the user's app. Chromium then defers native
  // focus events, so deliver the blur that a foreground click would produce.
  await act('const field=document.getElementById("workspaceBrowserAddress");field.blur();field.dispatchEvent(new FocusEvent("blur"));');
  await waitFor(`document.getElementById('workspaceBrowserAddress').value===${JSON.stringify(new URL(base).host)}`);
  second.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] });
  await waitFor(`document.getElementById('workspaceBrowserAddress').value===${JSON.stringify(base + '/two')}`);
  await check('native address shortcut reveals full URL for editing', 'document.activeElement.id==="workspaceBrowserAddress"');
  await check('address search follows selected engine', (await invoke({ action: 'resolve', text: 'Relay 搜索测试' })).url === 'https://duckduckgo.com/?q=' + encodeURIComponent('Relay 搜索测试'));
  await invoke({ action: 'settings.update', settings: { webLinkTarget: 'external', localLinkTarget: 'internal' } });
  await check('normal links honor external browser preference', (await invoke({ action: 'openLink', url: 'https://example.test/path' })).external && external.at(-1) === 'https://example.test/path');
  await evaluate(`relayBrowserSettings.openLink(${JSON.stringify(base + '/three')})`);
  await waitFor(async () => (await invoke({ action: 'state' })).tab?.url === base + '/three' && !(await invoke({ action: 'state' })).tab.loading);
  current = (await invoke({ action: 'state' })).tab;
  await waitFor(async () => (await invoke({ action: 'state' })).visible);
  await delay(200);
  await check('local links open an internal tab through routing', 'document.querySelector(".app").dataset.view==="chat"&&relayWorkspacePanel.getState().tab==="browser"');
  await invoke({ action: 'mute', id: current.id, muted: true });
  await check('mute changes actual Chromium audio state', (await invoke({ action: 'state', id: current.id })).tab.muted);
  for (const action of ['savePdf', 'saveScreenshot']) { const result = await invoke({ action, id: current.id }); if (!result.ok) throw Error(action + ': ' + result.code + ' ' + result.error); await check(action + ' writes real page artifact', result.ok); }
  await check('PDF and PNG exports have valid file signatures', fs.readFileSync(exported[0]).subarray(0, 4).toString() === '%PDF' && fs.readFileSync(exported[1]).subarray(1, 4).toString() === 'PNG');
  const activeView = views().find(v => v.webContents.getURL() === base + '/three');
  await invoke({ action: 'permissions.set', origin: base, permission: 'notifications', decision: 'block' });
  await check('website permissions persist and enforce denial', (await invoke({ action: 'permissions.list' })).items.some(v => v.origin === base && v.permission === 'notifications' && v.decision === 'block'));
  await activeView.webContents.executeJavaScript('document.getElementById("download").click()', true);
  await waitFor(async () => (await invoke({ action: 'downloads.list' })).items.some(v => v.state === 'completed'));
  const download = (await invoke({ action: 'downloads.list' })).items.find(v => v.state === 'completed');
  await check('real downloads finish in selected directory with progress record', path.dirname(download.path) === downloadDirectory && fs.readFileSync(download.path, 'utf8') === 'Relay test content' && download.receivedBytes === 18);
  await activeView.webContents.executeJavaScript(`(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['Relay generated CSV'],{type:'text/csv'}));a.download='relay-generated.csv';document.body.append(a);a.click();})()`, true);
  await waitFor(async () => (await invoke({ action: 'downloads.list' })).items.some(v => v.filename === 'relay-generated.csv' && v.state === 'completed'));
  const generated = (await invoke({ action: 'downloads.list' })).items.find(v => v.filename === 'relay-generated.csv');
  await check('user generated Blob exports download with durable source record', generated.url === base + '/three' && fs.readFileSync(generated.path, 'utf8') === 'Relay generated CSV');
  const savedPassword = await invoke({ action: 'passwords.save', origin: secureBase, username: 'fixture-user', password: 'synthetic-password-only' });
  await check('password list contains metadata without plaintext', savedPassword.ok && !(await invoke({ action: 'passwords.list' })).items.some(item => 'password' in item));
  const passwordId = (await invoke({ action: 'passwords.list' })).items[0].recordId;
  const savedContact = await invoke({ action: 'contacts.save', name: '本地测试', email: 'test@example.invalid', phone: '00000000000', address: '合成测试地址' });
  await check('passwords and contacts are encrypted by the operating system on disk', savedContact.ok && !fs.readFileSync(path.join(profileRoot, 'browser/forms.enc.json'), 'utf8').includes('synthetic-password-only') && !fs.readFileSync(path.join(profileRoot, 'browser/forms.enc.json'), 'utf8').includes('test@example.invalid'));
  await check('saved credentials cannot fill an HTTP page', (await invoke({ action: 'passwords.fill', id: current.id, recordId: passwordId })).code === 'INSECURE_FORM');
  await evaluate(`relayWorkspacePanel.openUrl(${JSON.stringify(secureBase + '/form')})`);
  await waitFor(async () => (await invoke({ action: 'state' })).tab?.url === secureBase + '/form' && !(await invoke({ action: 'state' })).tab.loading);
  const secureTab = (await invoke({ action: 'state' })).tab, secureView = views().find(v => v.webContents.getURL() === secureBase + '/form');
  await check('manual password fill succeeds on matching HTTPS origin', (await invoke({ action: 'passwords.fill', id: secureTab.id, recordId: passwordId })).ok && await secureView.webContents.executeJavaScript('document.querySelector("input[name=username]").value==="fixture-user"&&document.querySelector("input[type=password]").value==="synthetic-password-only"'));
  await check('manual contact fill uses actual page fields', (await invoke({ action: 'contacts.fill', id: secureTab.id, recordId: (await invoke({ action: 'contacts.list' })).items[0].recordId })).ok && await secureView.webContents.executeJavaScript('document.querySelector("input[autocomplete=email]").value==="test@example.invalid"'));
  await evaluate(`relayWorkspacePanel.openUrl(${JSON.stringify(base + '/download-source')})`);
  await waitFor(async () => (await invoke({ action: 'state' })).tab?.url === base + '/download-source' && !(await invoke({ action: 'state' })).tab.loading);
  const sourceView = views().find(v => v.webContents.getURL() === base + '/download-source');
  const sourceContents = sourceView.webContents;
  await sourceContents.executeJavaScript('document.getElementById("download").href="/slow";document.getElementById("download").click()', true);
  await waitFor(async () => (await invoke({ action: 'downloads.list' })).items.some(v => v.filename === 'relay-slow.bin' && v.receivedBytes > 0 && v.state === 'progressing'));
  const slow = (await invoke({ action: 'downloads.list' })).items.find(v => v.filename === 'relay-slow.bin');
  await check('real download can be paused', (await invoke({ action: 'downloads.pause', recordId: slow.id })).ok && (await invoke({ action: 'downloads.list' })).items.find(v => v.id === slow.id).state === 'paused');
  await check('real download can be resumed', (await invoke({ action: 'downloads.resume', recordId: slow.id })).ok);
  await act('document.querySelector("#workspaceTabs .is-active .workspace-tab-close").click();');
  await waitFor(async () => (await invoke({ action: 'downloads.list' })).items.some(v => v.id === slow.id && v.state === 'completed'));
  await check('download continues after its source tab closes', sourceContents.isDestroyed() && fs.statSync((await invoke({ action: 'downloads.list' })).items.find(v => v.id === slow.id).path).size === 4 * 1024 * 1024);
  await evaluate('relayBrowserSettings.open("general")');
  await waitFor('!!document.querySelector("[data-browser-setting=searchEngine]:not(:disabled)")');
  await check('browser settings show the saved configuration', 'document.querySelector("[data-browser-setting=searchEngine]").value==="duckduckgo"');
  await check('settings hide native browser view', !(await invoke({ action: 'state' })).visible);
  await capture('settings-light');
  await evaluate('relayBrowserSettings.open("history")');
  await waitFor('!!document.querySelector("[data-browser-records]")?.textContent.includes("浏览器交付测试")');
  await capture('history-light');
  await evaluate('relayBrowserSettings.open("downloads")');
  await waitFor('document.querySelector("[data-browser-records]")?.textContent.includes("relay-delivery")');
  await capture('downloads-light');
  await evaluate('relayBrowserSettings.open("passwords")');
  await waitFor('document.querySelector("[data-browser-forms]")?.textContent.includes("fixture-user")');
  await check('password manager shows stored accounts without revealing passwords', '!document.querySelector("[data-browser-forms]").textContent.includes("synthetic-password-only")');
  await capture('passwords-light');
  await invoke({ action: 'data.clear', cookies: true, cache: true, history: true });
  await check('clear data removes only browser storage and history', (await invoke({ action: 'history.list' })).items.length === 0 && (await activeView.webContents.session.cookies.get({ url: base })).length === 0 && (await invoke({ action: 'bookmarks.list' })).items.length === 1);
  await check('browser work never creates conversation history or model runs', '!currentConv&&!uiFixture.calls.includes("history.save")&&!uiFixture.calls.includes("runClaude")');
}).catch(async error => { report.errors.push(String(error.stack || error)); try { await capture('failure'); } catch (_) {} }).finally(finish);
