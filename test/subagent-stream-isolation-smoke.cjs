'use strict';
// Run: electron test/subagent-stream-isolation-smoke.cjs [--progress=<read-only progress JSON>]
// Uses the real reducers, projection and DOM renderer. No Relay main process,
// provider requests, business tools, user-profile writes or history mutation.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/subagent-stream-2026-10-14');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'ui-profile'));
app.commandLine.appendSwitch('disable-gpu');
const report = { checks: [], errors: [], externalRequests: 0, fixture: 'synthetic two-round Agent/SendMessage reuse' };
let win;
const save = () => fs.writeFileSync(path.join(output, 'ui-result.json'), JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { report.errors.push('UI fixture exceeded 60 seconds'); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate('(()=>{' + code + '\n})()');
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
async function check(name, expression) {
  const ok = !!await evaluate(expression);
  report.checks.push({ name, ok }); save(); console.log(name + ': ' + ok);
}
function declaration(source, name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  if (!match) throw Error('Missing production renderer declaration: ' + name);
  const tail = source.slice(match.index), next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
// A frozen, explicitly named comparison to the previous production algorithm.
// This is not used to provide the expected renderer result.
function legacyProjection(output, activityItems = []) {
  const childParents = new Map(), receipts = new Map();
  for (const message of output.messages) {
    if (!message.parent) continue;
    for (const block of message.blocks) if (block.type === 'text') childParents.set('output:' + message.parent + ':' + message.id + ':' + block.index, message.parent);
  }
  for (const task of activityItems) {
    if ((task.type !== 'task' && task.type !== 'tool') || !task.toolUseId || !task.result) continue;
    if (!receipts.has(task.toolUseId)) receipts.set(task.toolUseId, []);
    receipts.get(task.toolUseId).push(String(task.result));
  }
  return window.RelayAssistantOutput.processItems(output, { includeChildren: true }).filter(item => {
    if (item.type !== 'narration') return true;
    const parent = childParents.get(item.id);
    return !parent || !(receipts.get(parent) || []).some(result => result.includes(item.result));
  });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const external = /^https?:/i.test(details.url);
    if (external) report.externalRequests++;
    done({ cancel: external });
  });
  win = new BrowserWindow({ width: 1000, height: 780, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main id="host"></main></body></html>'));
  for (const file of ['styles.css', 'conversation-stream.css', 'read-only-markdown.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(root, 'renderer', file), 'utf8'));
  await win.webContents.insertCSS('body{display:block;height:100vh;overflow:auto;background:var(--bg)}#host{width:min(740px,calc(100vw - 40px));margin:24px auto;min-width:0}');
  const appSource = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  report.sourceHashes = Object.fromEntries(['app.js', 'activity-stream.js', 'assistant-output.js'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'renderer', file))).digest('hex')]));
  for (const file of ['vendor/marked.umd.js', 'vendor/highlight.min.js', 'stream-markdown.js']) await evaluate(fs.readFileSync(path.join(root, 'renderer', file), 'utf8') + '\nvoid 0;');
  await evaluate(appSource.slice(0, appSource.indexOf('const messagesEl =')) + '\nvoid 0;');
  for (const file of ['read-only-markdown.js', 'task-continuity.js', 'assistant-output.js', 'activity-stream.js']) await evaluate(fs.readFileSync(path.join(root, 'renderer', file), 'utf8') + '\nvoid 0;');
  for (const name of ['activityOutputItems', 'activityEventsForClaudeEvent']) await evaluate(declaration(appSource, name) + '\nvoid 0;');
  await evaluate(legacyProjection.toString() + '\nvoid 0;');
  await act(
    "window.review={errors:[],actions:[],first:'FIRST_CHILD_ROUND',second:'SECOND_CHILD_ROUND',main:'MAIN_AGENT_ONLY'};" +
    "window.addEventListener('error',e=>review.errors.push(e.message));" +
    "window.api={tasks:{stopTask:()=>review.actions.push('stop'),backgroundTask:()=>review.actions.push('background')}};" +
    "window.state=RelayActivity.createState();window.outputState=RelayAssistantOutput.createState();" +
    "window.stream=RelayActivity.createElement(state,{collapseOnComplete:false});document.getElementById('host').append(stream);" +
    "window.sync=()=>{state.items=RelayAssistantOutput.mergeActivityItems(state.items,activityOutputItems(outputState,state.items));RelayActivity.updateElement(stream,state,{collapseOnComplete:false});};" +
    "window.emit=event=>{RelayAssistantOutput.ingest(outputState,event);for(const e of activityEventsForClaudeEvent(event,state))RelayActivity.ingest(state,e);sync();};" +
    "window.mainNarration=()=>Array.from(stream.querySelectorAll('.is-narration')).map(el=>el.textContent).join('\\n');" +
    "window.row=id=>stream.querySelector('[data-process-id=\"'+id+'\"]');" +
    "window.full=(id,text,extra={})=>({type:'assistant',uuid:id,message:{id,content:[{type:'text',text}]},...extra});" +
    "window.delta=(id,text,parent)=>{emit({type:'stream_event',parent_tool_use_id:parent,event:{type:'message_start',message:{id}}});emit({type:'stream_event',parent_tool_use_id:parent,event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});emit({type:'stream_event',parent_tool_use_id:parent,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text}}});};"
  );
  await act(
    "emit(full('main-1',review.main+'：开始核对。'));" +
    "emit({type:'assistant',uuid:'launch',message:{id:'launch',content:[{type:'tool_use',id:'agent-call',name:'Agent',input:{description:'合成核对任务',prompt:'核对合成 fixture',subagent_type:'general-purpose',run_in_background:true}}]}});" +
    "emit({type:'system',subtype:'task_started',task_id:'agent-fixture',tool_use_id:'agent-call',task_type:'local_agent',description:'合成核对任务',is_backgrounded:true});" +
    "emit({type:'user',uuid:'launch-receipt',tool_use_result:{isAsync:true,agentId:'agent-fixture'},message:{content:[{type:'tool_result',tool_use_id:'agent-call',content:'Async agent launched successfully'}]}});" +
    "delta('child-1',review.first+'：第一轮流式内容。','agent-call');" +
    "review.legacyLeak=legacyProjection(outputState,state.items).some(i=>i.type==='narration'&&i.result.includes(review.first));"
  );
  await check('legacy projection reproduces unowned child narration before receipt', 'review.legacyLeak');
  await check('streaming child does not enter main narration', 'mainNarration().includes(review.main)&&!mainNarration().includes(review.first)');
  await check('streaming child is inspectable before its final frame', 'row("agent-call")?.classList.contains("is-inspectable")');
  await act('row("agent-call").click();review.taskRow=row("agent-call");');
  await check('task expansion shows the current streaming text', 'review.taskRow.classList.contains("is-expanded")&&review.taskRow.querySelector(".process-inspector").textContent.includes(review.first)');
  await act(
    "emit(full('child-1',review.first+'：第一轮流式内容。',{parent_tool_use_id:'agent-call'}));" +
    "emit({type:'system',subtype:'task_notification',task_id:'agent-fixture',tool_use_id:'agent-call',status:'completed',summary:'第一轮完成'});" +
    "emit(full('main-2',review.main+'：补充一项核对。'));" +
    "emit({type:'assistant',uuid:'follow-up',message:{id:'follow-up',content:[{type:'tool_use',id:'send-call',name:'SendMessage',input:{to:'agent-fixture',message:'继续核对第二轮'}}]}});" +
    "emit({type:'system',subtype:'task_started',task_id:'agent-fixture',tool_use_id:'send-call',task_type:'local_agent',description:'合成核对任务',is_backgrounded:true});" +
    "emit({type:'user',uuid:'send-receipt',message:{content:[{type:'tool_result',tool_use_id:'send-call',content:'Message delivered'}]}});" +
    "delta('child-2',review.second+'：第二轮流式内容。','agent-call');"
  );
  await check('same agent after SendMessage retains exactly one task row', 'state.items.filter(i=>i.type==="task"&&i.taskId==="agent-fixture").length===1');
  await check('task DOM and expansion persist while follow-up streams', 'row("agent-call")===review.taskRow&&review.taskRow.classList.contains("is-expanded")');
  await check('both child rounds remain available under the task', 'review.taskRow.querySelector(".process-inspector").textContent.includes(review.first)&&review.taskRow.querySelector(".process-inspector").textContent.includes(review.second)');
  await check('SendMessage receipt does not replace original Agent task result', 'review.taskRow.textContent.includes(review.first)&&!review.taskRow.querySelector(".process-inspector").textContent.includes("Message delivered")');
  await check('second child round also stays outside main narration', '!mainNarration().includes(review.first)&&!mainNarration().includes(review.second)');
  await act(
    "review.protocol='<tool_call><function=fakeWrite><parameter=path>fixture.txt</parameter></function></tool_call>\\n<script>window.review.xmlExecuted=true</script>';" +
    "emit(full('child-2',review.second+'：第二轮流式内容。\\n'+review.protocol,{parent_tool_use_id:'agent-call'}));" +
    "emit({type:'system',subtype:'task_notification',task_id:'agent-fixture',tool_use_id:'send-call',status:'completed',summary:'第二轮完成'});"
  );
  await check('child XML remains inert literal detail without pseudo tool execution', '!review.xmlExecuted&&!stream.querySelector("script,tool_call,function")&&review.actions.length===0&&!state.items.some(i=>i.toolName==="fakeWrite")&&review.taskRow.querySelector(".process-inspector").textContent.includes("<tool_call>")');
  await check('all task rounds finish without promoting child prose to the main stream', 'state.items.find(i=>i.type==="task"&&i.taskId==="agent-fixture").status==="success"&&!mainNarration().includes(review.first)&&!mainNarration().includes(review.second)');
  win.showInactive(); await settle();
  fs.writeFileSync(path.join(output, 'synthetic-expanded-light.png'), (await win.webContents.capturePage()).toPNG());
  await act('review.savedActivity=RelayActivity.serialize(state);review.savedOutput=RelayAssistantOutput.serialize(outputState);state=RelayActivity.hydrate(review.savedActivity);outputState=RelayAssistantOutput.createState(review.savedOutput);stream.remove();stream=RelayActivity.createElement(state,{collapseOnComplete:false});document.getElementById("host").append(stream);sync();row("agent-call").click();');
  await check('serialized history preserves two child rounds and main isolation', 'state.items.filter(i=>i.type==="task"&&i.taskId==="agent-fixture").length===1&&row("agent-call").querySelector(".process-inspector").textContent.includes(review.first)&&row("agent-call").querySelector(".process-inspector").textContent.includes(review.second)&&!mainNarration().includes(review.first)&&!mainNarration().includes(review.second)');
  await act('document.documentElement.dataset.theme="dark";'); win.setSize(420, 720); await settle();
  await check('expanded child details fit narrow windows', 'document.documentElement.scrollWidth<=innerWidth&&stream.scrollWidth<=stream.clientWidth+1');
  fs.writeFileSync(path.join(output, 'synthetic-expanded-narrow-dark.png'), (await win.webContents.capturePage()).toPNG());
  const progressArg = process.argv.find(arg => arg.startsWith('--progress='));
  if (progressArg) {
    const progressPath = progressArg.slice('--progress='.length), bytes = fs.readFileSync(progressPath), progress = JSON.parse(bytes);
    report.realReplay = { readOnly: true, beforeSha256: crypto.createHash('sha256').update(bytes).digest('hex'), inputMessages: progress.output.messages.length, inputChildMessages: progress.output.messages.filter(m => m.parent).length, inputTaskRows: progress.activity.items.filter(i => i.type === 'task').length };
    await evaluate('window.realProgress=' + JSON.stringify(progress) + ';void 0;');
    await act(
      'review.realOutput=RelayAssistantOutput.createState(realProgress.output);' +
      'review.legacyItems=legacyProjection(review.realOutput,realProgress.activity.items);' +
      'review.realActivity=RelayActivity.hydrate(realProgress.activity);' +
      'review.realItems=activityOutputItems(review.realOutput,review.realActivity.items);' +
      'review.realActivity.items=RelayAssistantOutput.mergeActivityItems(review.realActivity.items,review.realItems);' +
      'review.childIds=new Set(RelayAssistantOutput.processItems(review.realOutput,{includeChildren:true}).filter(i=>!RelayAssistantOutput.processItems(review.realOutput).some(root=>root.id===i.id)).map(i=>i.id));' +
      'review.realTasks=review.realActivity.items.filter(i=>i.type==="task"&&i.taskId);' +
      'review.realParents=new Set(review.realOutput.messages.filter(m=>m.parent).map(m=>m.parent));'
    );
    Object.assign(report.realReplay, await evaluate('({legacyProjectedChildItems:review.legacyItems.filter(i=>review.childIds.has(i.id)).length,legacyProjectedChildChars:review.legacyItems.filter(i=>review.childIds.has(i.id)).reduce((n,i)=>n+(i.result||"").length,0),currentProjectedChildItems:review.realItems.filter(i=>i.type==="narration"&&review.childIds.has(i.id)).length,currentTaskRows:review.realTasks.length,uniqueTaskIds:new Set(review.realTasks.map(i=>i.taskId)).size,childGroupsAvailable:review.realTasks.filter(i=>i.childOutput||i.childResults?.length||i.result).length})'));
    await check('real stored progress replays without anonymous child narration', 'review.realItems.every(i=>i.type!=="narration"||!review.childIds.has(i.id))');
    await check('real duplicate task rows coalesce on hydration', 'review.realTasks.length===new Set(review.realTasks.map(i=>i.taskId)).size');
    await check('real child groups retain inspectable content', 'review.realTasks.filter(i=>i.childOutput||i.childResults?.length||i.result).length===review.realParents.size');
    report.realReplay.afterSha256 = crypto.createHash('sha256').update(fs.readFileSync(progressPath)).digest('hex');
    // A live task can legitimately update its own journal while this test reads.
    report.realReplay.inputUnchangedDuringRead = report.realReplay.beforeSha256 === report.realReplay.afterSha256;
  }
  await check('renderer has no errors or Node exposure', 'review.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  report.ok = report.checks.every(item => item.ok) && report.externalRequests === 0;
}).catch(error => { report.ok = false; report.errors.push(error.stack || String(error)); }).finally(() => {
  clearTimeout(deadline); save(); win?.destroy(); app.exit(report.ok ? 0 : 1);
});
