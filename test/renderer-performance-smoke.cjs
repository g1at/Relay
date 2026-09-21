'use strict';
// Real renderer with synthetic conversations and no provider or user-data access.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp/renderer-performance-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
let win;
const result = { checks: {}, errors: [] };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
const timeout = setTimeout(() => { result.errors.push('timeout'); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(async () => { ${code}\n })()`);
const wait = code => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`);
async function check(name, code) {
  result.checks[name] = !!await evaluate(code); save();
  if (!result.checks[name]) throw Error(name);
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const tracking = `
    window.perfFixture={};
    window.WeakMap=class extends WeakMap {
      set(key,value) {
        if(key?.id==='messages'&&value instanceof Map)perfFixture.summaryRegistry=this;
        return super.set(key,value);
      }
    };
  `;
  const page = path.join(out, 'page.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}\n${tracking}</script>`));
  win = new BrowserWindow({ width: 1100, height: 800, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page);
  await wait('providerRoutingLoaded&&!restoringActiveRuns&&!!window.relayWorkspacePanel');
  await check('TerminalLibrariesAbsentFromChatStartup', 'typeof Terminal==="undefined"&&typeof FitAddon==="undefined"&&!performance.getEntriesByType("resource").some(entry=>/vendor\\/xterm(?:-addon-fit)?\\.js/.test(entry.name))');
  await check('NoUnusedEnvironmentProbeAndOneStartupSettingsRead', 'uiFixture.calls.filter(name=>name==="settings.read").length===1&&!uiFixture.calls.includes("probeEnv")');
  await act(`
    const items=Array.from({length:150},(_,i)=>({id:'history-'+i,type:'tool',toolName:'Read',title:'读取合成文件 '+i,status:'success',input:{file_path:'synthetic/file-'+i},result:'合成工具输出。'.repeat(100)}));
    const state=RelayActivity.createState({phase:'complete',items});
    await api.history.save({id:'perf-history',title:'合成长任务',model:'opus',turns:[{runId:'history-run',user:'查看合成文件',assistant:'已完成',activity:RelayActivity.serialize(state),ts:new Date().toISOString()}]});
    await loadConversation('perf-history');
  `);
  await check('LongHistoryRegistersItsTaskSummary', 'perfFixture.summaryRegistry?.has(messagesEl)&&messagesEl.querySelectorAll(".process-item").length===150');
  await act('startNewConv();');
  await check('BlankConversationReleasesPreviousSummaryRegistryImmediately', '!perfFixture.summaryRegistry.has(messagesEl)&&!messagesEl.querySelector(".process-stream")');
  await act(`inputEl.value='继续合成任务';await send();perfFixture.liveId=currentConv.id;perfFixture.jobId=uiFixture.runId;
    uiFixture.emit('onEvent',{jobId:perfFixture.jobId,type:'stream_event',event:{type:'message_start',message:{id:'synthetic-live'}}});
    uiFixture.emit('onEvent',{jobId:perfFixture.jobId,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'切换前过程内容。'}}});`);
  await wait('messagesEl.textContent.includes("切换前过程内容。")');
  await act(`startNewConv();
    uiFixture.emit('onEvent',{jobId:perfFixture.jobId,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'切换后的后台过程内容。'}}});`);
  await check('BackgroundTaskHasStateButNoDetachedDomReferences', '(()=>{const run=runs.get(perfFixture.liveId);return run&&run.activityState&&["activityEl","outputBubble","errorEl","supplementTimeline"].every(key=>run[key]===null)&&run.turn.activityEl===null&&!messagesEl.textContent.includes("后台过程")})()');
  await act('await loadConversation(perfFixture.liveId);');
  await wait('messagesEl.textContent.includes("切换前过程内容。切换后的后台过程内容。")');
  await check('ReturningToBackgroundTaskRebuildsTheLatestStream', 'isRunning&&runs.get(perfFixture.liveId)?.activityEl?.isConnected');
  await act(`const final={type:'result',subtype:'success',result:'后台任务完成'};uiFixture.emit('onEvent',{jobId:perfFixture.jobId,...final});uiFixture.emit('onEvent',{jobId:perfFixture.jobId,type:'job-done',exitCode:0,finalResult:final});`);
  await wait('!isRunning&&runs.size===0&&messagesEl.textContent.includes("后台任务完成")');
  await check('TaskStillCompletesAndPersistsAfterNavigation', '(async()=>{const conv=await api.history.load(perfFixture.liveId);return conv.turns.at(-1).assistant==="后台任务完成"})()');
  await check('RendererHadNoErrors', 'uiFixture.errors.length===0');
  clearTimeout(timeout); save(); win.destroy(); app.exit(0);
}).catch(error => {
  result.errors.push(String(error.stack || error)); save(); console.error(error);
  clearTimeout(timeout); if(win&&!win.isDestroyed())win.destroy(); app.exit(1);
});
