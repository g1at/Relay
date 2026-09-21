'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/subagent-history-smoke'); fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
const report = { checks: [], errors: [] }; let win;
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { report.ok = false; report.errors.push('UI fixture exceeded 40 seconds'); save(); app.exit(1); }, 40000);
const evaluate = source => win.webContents.executeJavaScript(source);
const settle = () => evaluate('new Promise(resolve => setTimeout(resolve,20))');
async function check(label, expression) { if (!await evaluate(expression)) throw Error(label); report.checks.push(label); save(); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const page = path.join(output, 'fixture.html');
  fs.writeFileSync(page, `<!doctype html><html><head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><link rel="stylesheet" href="subagent-history.css"><style>:root{--bg-panel:#fff;--text:#242424;--text-muted:#777;--text-dim:#555;--border:#e5e5e5}body{font-family:system-ui}</style></head><body><button id="launcher">Open</button><script>
    window.fixture={calls:[],mode:'normal'};window.api={sessionHistory:{
      listSubagents:async input=>{fixture.calls.push(['list',input]);if(fixture.mode==='delayed')return new Promise(resolve=>{fixture.release=resolve});return{ok:true,items:[{agentId:'first'},{agentId:'second'}]};},
      getSubagentMessages:async input=>{fixture.calls.push(['messages',input]);if(fixture.mode==='missing')return{ok:false,code:'SUBAGENT_HISTORY_UNAVAILABLE',message:'子 Agent 的原生记录已清理。'};return{ok:true,items:[{uuid:input.agentId+'-'+input.offset,type:'assistant',message:{content:[{type:'text',text:'<img src=https://fixture.invalid onerror=alert(1)> '+input.agentId},{type:'tool_use',name:'Read',input:{path:'fixture.txt'}}]}}],nextOffset:input.offset+1,hasMore:input.offset===0};}
    }};
    </script><script src="read-only-markdown.js"></script><script src="subagent-history.js"></script></body></html>`);
  win = new BrowserWindow({ width: 840, height: 700, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page);
  await check('history is lazy until explicitly opened', 'fixture.calls.length===0&&document.querySelector(".subagent-history-overlay").hidden');
  await evaluate('launcher.focus();relaySubagentHistory.open({convId:"conversation-a",runId:"run-a",agentId:"first",title:"Fixture agent"})'); await settle();
  await check('detail is bounded and renders history safely', '!document.querySelector(".subagent-history-overlay").hidden&&document.querySelector(".subagent-history-dialog").getBoundingClientRect().height<=644&&!document.querySelector("img")&&document.querySelector(".subagent-history-text").textContent.includes("<img")');
  await check('tool details start collapsed', '!document.querySelector(".subagent-history-tool").open');
  await evaluate('document.querySelector(".subagent-history-footer button").click()'); await settle();
  await check('pagination appends without duplicating or replacing earlier messages', 'document.querySelectorAll(".subagent-history-message").length===2&&fixture.calls.at(-1)[1].offset===1');
  await evaluate('document.querySelectorAll(".subagent-history-tabs button")[1].click()'); await settle();
  await check('switching agents resets only detail pagination', 'document.querySelectorAll(".subagent-history-message").length===1&&document.querySelector(".subagent-history-text").textContent.includes("second")&&fixture.calls.at(-1)[1].offset===0');
  await evaluate('window.dispatchEvent(new CustomEvent("relay:conversation-changed",{detail:{conversationId:"conversation-b"}}))');
  await check('switching conversations immediately clears details and restores focus', 'document.querySelector(".subagent-history-overlay").hidden&&!document.querySelector(".subagent-history-message")&&document.activeElement===launcher');
  await evaluate('fixture.mode="delayed";void relaySubagentHistory.open({convId:"conversation-a",runId:"run-a"})'); await settle();
  await evaluate('relaySubagentHistory.close();fixture.release({ok:true,items:[{agentId:"first"}]})'); await settle();
  await check('late list response after closing never reopens or fetches messages', 'document.querySelector(".subagent-history-overlay").hidden&&fixture.calls.at(-1)[0]==="list"');
  await evaluate('fixture.mode="missing";relaySubagentHistory.open({convId:"conversation-a",runId:"run-a",agentId:"first"})'); await settle();
  await check('deleted records have an explicit retryable error', 'document.querySelector(".subagent-history-status").textContent.includes("已清理")&&!document.querySelectorAll(".subagent-history-footer button")[1].hidden');
  await evaluate('document.querySelector(".subagent-history-dialog").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await check('Escape closes the read-only detail dialog', 'document.querySelector(".subagent-history-overlay").hidden');
  report.ok = true;
}).catch(error => { report.ok = false; report.errors.push(error.stack || String(error)); }).finally(() => { clearTimeout(deadline); save(); win?.destroy(); app.exit(report.ok ? 0 : 1); });
