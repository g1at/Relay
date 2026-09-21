'use strict';
// Renderer-only Windows Electron validation. No application host, model calls,
// network, user history, clipboard, browser automation, or personal profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'activity-startup-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const checks = {}, errors = [];
let win;
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout'); save(); app.exit(1); }, 60000);
const run = source => win.webContents.executeJavaScript(source);
const act = source => run(`(()=>{${source}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, source) {
  checks[name] = Boolean(await run(source)); save();
  console.log(name + ': ' + checks[name]);
  if (!checks[name]) throw Error(name);
}
async function capture(name) {
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  win = new BrowserWindow({ width: 900, height: 460, show: false, webPreferences: {
    contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main><p>帮我写一个 HTML 计算器</p><div id="activity"></div></main></body></html>'));
  for (const file of ['styles.css', 'conversation-stream.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(root, 'renderer', file), 'utf8'));
  await win.webContents.insertCSS('body{display:block;padding:30px;background:var(--bg);color:var(--text)}main{max-width:720px;margin:24px auto}p{margin-bottom:35px;font-size:15px}');
  await run(fs.readFileSync(path.join(root, 'renderer/activity-stream.js'), 'utf8') + '\nvoid 0;');
  await act(`window.state=RelayActivity.createState();window.stream=RelayActivity.createElement(state);document.getElementById('activity').append(stream);
    window.update=()=>RelayActivity.updateElement(stream,state,{collapseOnComplete:false});
    window.emit=event=>{RelayActivity.ingest(state,event);update()};
    window.row=()=>stream.querySelector('[data-process-id="relay-startup"]');
    window.ready={type:'system',subtype:'relay_mcp_status',phase:'settled',ok:true};`);
  win.showInactive();
  await check('preparingIsVisibleAndAnimated', 'row().checkVisibility()&&row().textContent.trim()==="正在准备"&&getComputedStyle(row().querySelector(".process-spinner")).animationName==="processSpin"');
  await act(`emit({type:'system',subtype:'init',session_id:'fixture'});emit(ready);window.originalRow=row();window.before=getComputedStyle(row().querySelector('.process-spinner')).transform;`);
  await delay(240);
  await check('readyGapKeepsSameRowAndActuallyAdvancesAnimation', 'row()===originalRow&&row().textContent.trim()==="正在等待回复"&&getComputedStyle(row().querySelector(".process-spinner")).transform!==before&&!stream.textContent.includes("工具连接已就绪")');
  await capture('waiting-light');
  await act(`emit({...ready,ok:false,items:[{name:'示例工具',status:'failed'}]});stream.querySelector('[data-process-id="relay-mcp-ready"]').click();`);
  await delay(180);
  await check('connectionErrorDetailOpensWhileWaitingContinues', 'stream.querySelector(".is-diagnostic").getAttribute("aria-expanded")==="true"&&stream.querySelector(".process-output-text").checkVisibility()&&stream.textContent.includes("示例工具：连接失败")&&row().checkVisibility()');
  await capture('connection-detail');
  win.setContentSize(400, 350);
  await act(`document.documentElement.dataset.theme='dark';`);
  await delay(180);
  await check('narrowDarkStateFitsWithoutHorizontalOverflow', 'document.documentElement.scrollWidth<=innerWidth&&row().getBoundingClientRect().right<=innerWidth');
  await capture('waiting-dark-narrow');
  await act(`emit(ready);emit({type:'stream_event',event:{type:'message_start',message:{id:'response'}}});emit({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}}});`);
  await check('actualThinkingReplacesStartupWithoutADuplicateSpinner', '!row()&&stream.querySelectorAll(".process-spinner").length===1&&stream.textContent.includes("正在思考")');
  for (const [name, error] of [['complete', null], ['error', '连接失败'], ['paused', '已暂停']]) {
    await act(`state=RelayActivity.createState();emit(ready);RelayActivity.finish(state,${JSON.stringify(error)});update();`);
    await check(name + 'StopsStartupAnimation', '!row()&&!stream.querySelector(".process-spinner")&&!stream.classList.contains("is-running")');
  }
  save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(error => { errors.push(error.stack || String(error)); save(); clearTimeout(deadline); console.error(error); app.exit(1); });
