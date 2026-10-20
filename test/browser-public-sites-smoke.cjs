'use strict';
// Read-only observations on public production pages. No model or user profile.
const { BaseWindow, app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createBrowserPanelHost } = require('../src/main/browser/browser-panel-host');
const { createBrowserAutomationService } = require('../src/main/browser/browser-automation-service');
const out = path.join(__dirname, '../.codex-tmp/browser-public-sites'), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-public-browser-audit-'));
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(temporary, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), kind: 'public-site-readonly-capability-probe', modelDriven: false, isolatedProfile: true, pages: [] };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
let owner, host, service;
const timer = setTimeout(() => { report.timedOut = true; save(); app.exit(2); }, 240000);
const targets = [
  { name: 'ag-grid', url: 'https://www.ag-grid.com/example/' },
  { name: 'excalidraw', url: 'https://excalidraw.com/' },
  { name: 'github-issues', url: 'https://github.com/microsoft/playwright/issues' },
];
function limit(promise, ms) { let t; return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(Error('audit deadline')), ms); })]).finally(() => clearTimeout(t)); }
app.whenReady().then(async () => {
  // No signed-in state or publishing actions. Do not block read-only GraphQL POSTs
  // used by real applications, since that would change their normal behavior.
  owner = new BrowserWindow({ width: 1360, height: 960, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,<title>Relay public browser audit - isolated profile</title>');
  owner.show(); await pause(150);
  host = createBrowserPanelHost({ BaseWindow, owner, WebContentsView, session, onEvent: event => service?.handleHostEvent(event) });
  service = createBrowserAutomationService({ getHost: () => host });
  for (const target of targets) {
    const entry = { ...target, startedAt: new Date().toISOString() }; report.pages.push(entry); save();
    const controller = new AbortController();
    const context = { conversationId: 'public-audit-' + target.name, runId: 'readonly-run', workspaceRoot: temporary, signal: controller.signal, isCurrent: () => true };
    try {
      const opened = await limit(service.invoke(context, { action: 'open', url: target.url }), 30000);
      if (!opened.ok) throw Error(JSON.stringify(opened));
      const id = opened.tab.id; entry.id = id;
      await host.invoke({ action: 'setBounds', rect: { x: 0, y: 0, width: 1320, height: 900 } });
      await host.invoke({ action: 'visibility', id, visible: true });
      const wc = host.getAutomationTarget(id).webContents;
      const until = Date.now() + 25000;
      while ((wc.isLoadingMainFrame() || wc.getURL() === 'about:blank') && Date.now() < until) await pause(100);
      let readiness = false;
      const readyUntil = Date.now() + 25000;
      while (Date.now() < readyUntil) {
        readiness = await limit(wc.executeJavaScript(`document.querySelectorAll('canvas').length > 0 || document.querySelectorAll('[role="grid"],[role="row"],main a[href*="/issues/"]').length > 3`), 3000).catch(() => false);
        if (readiness) break;
        await pause(500);
      }
      entry.applicationReady = readiness;
      const scrollState = () => wc.executeJavaScript(`({windowY:scrollY,containers:[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+50&&e.clientHeight>50).slice(0,30).map(e=>({tag:e.tagName,className:String(e.className).slice(0,120),top:e.scrollTop}))})`);
      entry.presented = host.getAutomationTarget(id).presented;
      entry.loadingAtObservation = wc.isLoadingMainFrame();
      entry.observation = await limit(service.invoke(context, { action: 'observe', id }), 15000);
      entry.independentInspection = await limit(wc.executeJavaScript(`(() => ({title:document.title,url:location.href,domNodes:document.querySelectorAll('*').length,iframeElements:document.querySelectorAll('iframe').length,canvases:[...document.querySelectorAll('canvas')].map(x=>({width:x.width,height:x.height,visible:!!(x.getBoundingClientRect().width&&x.getBoundingClientRect().height)})),gridRows:document.querySelectorAll('[role="row"]').length,documentScrollHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight,readonlyInspection:true}))()`), 10000);
      // Use the production scroll action, without clicking or editing the public site.
      if (entry.observation.ok) {
        const obs = entry.observation.observation || entry.observation;
        entry.beforeScroll = await scrollState();
        entry.scroll = await limit(service.invoke(context, { action: 'act', id, kind: 'scroll', observationId: obs.observationId, deltaY: 640 }), 12000);
      }
      await pause(250);entry.afterScroll = await scrollState();
      const shot = await limit(wc.capturePage(), 10000);
      fs.writeFileSync(path.join(out, target.name + '.png'), shot.toPNG());
      entry.screenshot = target.name + '.png';
      entry.finishedAt = new Date().toISOString();
      await host.invoke({ action: 'close', id });
    } catch (error) { entry.error = String(error.stack || error); }
    finally { controller.abort(); save(); }
  }
}).catch(error => { report.error = String(error.stack || error); }).finally(() => {
  clearTimeout(timer); service?.dispose(); host?.destroy(); if (owner && !owner.isDestroyed()) owner.destroy();
  report.finishedAt = new Date().toISOString(); report.runtime = { electron: process.versions.electron, chromium: process.versions.chrome }; save();
  try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (_) {}
  report.ok=!report.error&&report.pages.every(page=>!page.error&&page.applicationReady&&page.observation?.ok&&page.scroll?.ok&&page.screenshot);save();app.exit(report.ok ? 0 : 1);
});
