'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/mcp-permission-controls-smoke');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win; const checks = [], errors = [];
const evaluate = code => win.webContents.executeJavaScript(code);
const waitFor = code => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`);
async function check(label, code) { if (!await evaluate(code)) throw Error(label); checks.push(label); }
function seed() {
  const base = window.api, state = window.mcpPermissionFixture = { mode: null, requests: [], reject: false, release: null, hold: false };
  const mcp = { list: async () => ({ ok: true, items: [{ name: 'guarded-fixture', enabled: true, summary: '本地验收工具', permissionModeOverride: state.mode }] }),
    status: async () => ({ ok: true, available: false, items: [] }),
    setPermission: async (name, mode) => {
      state.requests.push({ name, mode }); if (state.hold) await new Promise(resolve => { state.release = resolve; });
      if (state.reject) throw Error('synthetic failure'); state.mode = mode;
      return { ok: true, items: [{ name, mode }] };
    } };
  window.api = new Proxy(base, { get: (target, key) => key === 'mcp' ? mcp : target[key] });
}
const deadline = setTimeout(() => { errors.push('UI fixture timeout'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n') + `\n(${seed.toString()})();localStorage.clear();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}</script>`);
  const file = path.join(out, 'fixture.html'); fs.writeFileSync(file, html);
  win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(file); await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  win.showInactive();
  await evaluate("openPlugins('mcp')"); await waitFor("document.querySelector('.rmp-permission-picker .cs-trigger')");
  await waitFor("document.querySelector('.rmp-permission-picker').checkVisibility({checkOpacity:true,checkVisibilityCSS:true})");
  await check('production MCP row mounts compact session-follow picker', "document.querySelector('.rmp-permission-picker .cs-text').textContent==='跟随会话'&&document.querySelector('.rmp-permission-picker').getBoundingClientRect().width>=100&&document.querySelector('.rmp-permission-picker').getBoundingClientRect().width<=140");
  await evaluate("mcpPermissionFixture.hold=true;document.querySelector('.rmp-permission-picker .cs-trigger').click();document.querySelector('.rmp-permission-picker [data-value=default]').click()");
  await waitFor('mcpPermissionFixture.release');
  await check('pending approval change stays disabled without optimistic privilege changes', "document.querySelector('.rmp-permission-picker .cs-trigger').disabled&&document.querySelector('.rmp-permission-picker .cs-text').textContent==='跟随会话'&&mcpPermissionFixture.requests[0].name==='guarded-fixture'");
  await evaluate('mcpPermissionFixture.hold=false;mcpPermissionFixture.release()'); await waitFor("!document.querySelector('.rmp-permission-picker .cs-trigger').disabled");
  await check('successful host acknowledgement updates the displayed mode', "document.querySelector('.rmp-permission-picker .cs-text').textContent==='始终请求批准'&&mcpPermissionFixture.mode==='default'");
  await evaluate("mcpPermissionFixture.reject=true;document.querySelector('.rmp-permission-picker .cs-trigger').click();document.querySelector('.rmp-permission-picker [data-value=follow]').click()");
  await waitFor("!document.querySelector('.rmp-permission-picker .cs-trigger').disabled");
  await check('failed clear retains the tighter setting', "document.querySelector('.rmp-permission-picker .cs-text').textContent==='始终请求批准'&&mcpPermissionFixture.mode==='default'");
  await evaluate("mcpPermissionFixture.reject=false;const button=document.querySelector('.rmp-permission-picker .cs-trigger');button.focus();button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
  await waitFor("document.querySelector('.rmp-permission-picker .cs-text').textContent==='跟随会话'");
  await check('keyboard selection uses the same host API', 'mcpPermissionFixture.requests.length===3&&mcpPermissionFixture.requests[2].mode===null');
  await check('no renderer error', 'uiFixture.errors.length===0');
  await waitFor("!document.querySelector('#appToast.show')");
  await evaluate("document.querySelector('.rmp-permission-picker .cs-trigger').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await new Promise(resolve=>setTimeout(resolve, 200));
  fs.writeFileSync(path.join(out, 'mcp-approval.png'), (await win.webContents.capturePage()).toPNG());
}).catch(error => { errors.push(error.stack || String(error)); }).finally(() => {
  clearTimeout(deadline); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: errors.length === 0, checks, errors }, null, 2));
  console.log(JSON.stringify({ ok: errors.length === 0, checks: checks.length, errors })); app.exit(errors.length ? 1 : 0);
});
