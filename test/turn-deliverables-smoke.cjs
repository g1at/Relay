'use strict';
// Isolated Electron renderer: structured host snapshots and actual file-card UI,
// no provider, business tools, OS file opening or production user-data writes.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/turn-deliverables-2026-10-15');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'ui-profile')); app.commandLine.appendSwitch('disable-gpu');
const report = { checks: [], errors: [], externalRequests: 0 }; let win;
const save = () => fs.writeFileSync(path.join(output, 'ui-result.json'), JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { report.errors.push('timed out'); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate('(()=>{' + code + '\n})()');
const settle = () => new Promise(resolve => setTimeout(resolve, 80));
async function check(name, code) { const ok = !!await evaluate(code); report.checks.push({ name, ok }); console.log(name + ': ' + ok); save(); }
function declaration(source, name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  if (!match) throw Error('missing production function ' + name);
  const tail = source.slice(match.index), next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => { const cancel = /^https?:/i.test(details.url); if (cancel) report.externalRequests++; done({ cancel }); });
  win = new BrowserWindow({ width: 900, height: 740, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main id="messages"></main></body></html>'));
  for (const file of ['styles.css', 'workspace-file-types.css', 'local-file-links.css', 'turn-deliverables.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(root, 'renderer', file), 'utf8'));
  await win.webContents.insertCSS('body{display:block;height:100vh;overflow:auto;background:var(--bg)}#messages{width:min(720px,calc(100vw - 40px));margin:26px auto;min-width:0}');
  for (const file of ['workspace-file-types.js', 'local-file-links.js', 'turn-deliverables.js']) await evaluate(fs.readFileSync(path.join(root, 'renderer', file), 'utf8') + '\nvoid 0;');
  const appSource = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  for (const name of ['renderRunOutput', 'renderSupplementTimeline']) await evaluate(declaration(appSource, name) + '\nvoid 0;');
  report.sourceHashes = Object.fromEntries(['app.js', 'turn-deliverables.js', 'turn-deliverables.css', 'index.html'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'renderer', file))).digest('hex')]));
  await act(
    "window.review={errors:[],previews:[],notices:[],missing:false};window.addEventListener('error',e=>review.errors.push(e.message));" +
    "window.snapshot=(conversationId,runId,turnTs,items)=>({version:1,conversationId,runId,turnTs,status:'complete',complete:true,warnings:[],items});" +
    "window.makeTurn=(runId,path)=>({runId,ts:'2026-10-15T00:00:00Z',assistant:'',deliverables:snapshot('a',runId,'2026-10-15T00:00:00Z',[{id:runId+'-file',path,name:'核对报告'}])});" +
    "window.convA={id:'a',turns:[makeTurn('first','D:/fixture/report.pdf'),makeTurn('second','D:/fixture/report#2.md')]};window.convB={id:'b',turns:[]};window.currentConv=convA;window.activeView='chat';" +
    "window.runA={convId:'a',jobId:'first',turnIndex:0,turn:convA.turns[0],outputState:{status:'complete',final:''}};window.runB={convId:'a',jobId:'second',turnIndex:1,turn:convA.turns[1],outputState:{status:'complete',final:''}};window.runMap=new Map([['first',runA],['second',runB]]);" +
    "window.messagesEl=document.getElementById('messages');window.currentAssistantBubble=null;window.outputStateForRun=run=>run.outputState;window.streamMarkdownRenderer={release:()=>{}};window.detachStreamRenderTarget=()=>{currentAssistantBubble=null};window.flushStreamRender=()=>{};window.scrollToBottom=()=>{};" +
    "window.renderStreamBubble=el=>{el.querySelector('.body').textContent=el.dataset.raw};window.appendMessage=(role,text)=>{const el=document.createElement('div');el.className='message '+role;const body=document.createElement('div');body.className='body';body.textContent=text;el.append(body);messagesEl.append(el);return el;};" +
    "window.relayTurnDeliverables=RelayTurnDeliverables.createController({container:messagesEl,getConversation:()=>currentConv,getRun:id=>runMap.get(id),isVisible:()=>activeView==='chat',bridge:{get:async()=>({ok:false}),onChanged:cb=>{review.changed=cb;return()=>{review.unsubscribed=true}}}});" +
    "window.cardLinks=RelayLocalFileLinks.install(messagesEl,{context:()=>({conversationId:currentConv.id,workingDir:'D:/fixture'}),preview:async input=>{review.previews.push(input);return review.missing?{ok:false,error:'文件已不存在'}:{ok:true};},onError:message=>review.notices.push(message)});" +
    "window.anchor=index=>{const node=document.createElement('span');node.className='conversation-turn-anchor';node.dataset.turnAnchor=index;messagesEl.append(node);return node;};" +
    "window.section=id=>Array.from(messagesEl.querySelectorAll('.turn-deliverables')).find(el=>el.dataset.runId===id);anchor(0);renderRunOutput(runA);anchor(1);renderRunOutput(runB);"
  ); await settle();
  await check('empty final answers still show per-turn result cards', 'messagesEl.querySelectorAll(".turn-deliverables").length===2&&messagesEl.querySelectorAll(".relay-file-card").length===2&&section("first").dataset.turn==="0"&&section("second").dataset.turn==="1"');
  await check('one run never borrows the next turn despite identical timestamps', 'section("first").textContent.includes("report.pdf")&&!section("first").textContent.includes("report#2")&&section("second").textContent.includes("report#2.md")');
  await act('section("second").querySelector("a").click();'); await settle();
  await check('existing file preview receives absolute path and owning conversation', 'review.previews.length===1&&review.previews[0].context.conversationId==="a"&&RelayLocalFileLinks.parse(review.previews[0].href).path==="D:/fixture/report#2.md"');
  await act('review.firstNode=section("first");review.firstCard=review.firstNode.querySelector("a");review.firstCard.focus();review.changed({conversationId:"a",runId:"first",snapshot:convA.turns[0].deliverables});'); await settle();
  await check('duplicate snapshot preserves card DOM and keyboard focus', 'section("first")===review.firstNode&&section("first").querySelector("a")===review.firstCard&&document.activeElement===review.firstCard');
  await check('older turn refresh stays before the next turn anchor', 'section("first").nextElementSibling?.dataset.turnAnchor==="1"');
  await act('review.missing=true;section("first").querySelector("a").click();'); await settle();
  await check('deleted file preview reports an error without removing the recorded artifact', 'review.notices.at(-1)==="文件已不存在"&&section("first").querySelector("a")===review.firstCard');
  await act('relayTurnDeliverables.clear();messagesEl.replaceChildren();currentConv=convB;review.changed({conversationId:"a",runId:"first",snapshot:snapshot("a","first",runA.turn.ts,[{id:"background-file",path:"D:/fixture/background.html",name:"后台成果"}])});');
  await check('background result does not appear in the selected other conversation', '!messagesEl.querySelector(".turn-deliverables")&&runA.turn.deliverables.items[0].id==="background-file"&&convB.turns.length===0');
  await act('currentConv=JSON.parse(JSON.stringify(convA));anchor(0);relayTurnDeliverables.render(currentConv.turns[0],{conversationId:"a",turnIndex:0});anchor(1);relayTurnDeliverables.render(currentConv.turns[1],{conversationId:"a",turnIndex:1});'); await settle();
  await check('history reopen restores independently persisted cards without Markdown', 'messagesEl.querySelectorAll(".relay-file-card").length===2&&section("first").textContent.includes("background.html")&&currentConv.turns.every(turn=>turn.assistant==="")');
  await act('review.beforeUnknown=messagesEl.innerHTML;review.changed({conversationId:"a",runId:"unknown",snapshot:snapshot("a","unknown",runA.turn.ts,[{id:"x",path:"D:/fixture/unowned.pdf"}])});');
  await check('unknown run cannot be assigned to the last visible turn', 'messagesEl.innerHTML===review.beforeUnknown&&!messagesEl.textContent.includes("unowned")');
  await act('review.beforeWrong=messagesEl.innerHTML;review.changed({conversationId:"a",runId:"first",snapshot:snapshot("a","first","wrong-time",[{id:"x",path:"D:/fixture/wrong.pdf"}])});');
  await check('mismatched original send time cannot replace an existing card', 'messagesEl.innerHTML===review.beforeWrong&&!messagesEl.textContent.includes("wrong.pdf")');
  await act('review.changed({conversationId:"a",runId:"first",snapshot:snapshot("a","first",runA.turn.ts,[{id:"literal",path:"D:/fixture/<tag>.html",name:"<img src=x onerror=alert(1)>"}])});'); await settle();
  await check('file labels are text and never inject markup', '!messagesEl.querySelector("img,script,tag")&&section("first").textContent.includes("<img src=x onerror=alert(1)>")');
  await act('runB.outputState={status:"complete",final:"已核对本轮文件。"};renderRunOutput(runB);'); await settle();
  await check('confirmed prose and structured files remain separate and ordered', 'runB.outputBubble.nextElementSibling===section("second")&&runB.outputBubble.textContent==="已核对本轮文件。"');
  await act('relayTurnDeliverables.clear();messagesEl.replaceChildren();window.RelaySupplementTimeline={plan:()=>[]};window.RelayActivity={syncTaskSummary:()=>{}};runA.supplementTimeline=null;runA.outputBubble=null;runA.activityEl=null;runA.turn=currentConv.turns[0];runA.turn.supplements=[{id:"supplement"}];renderSupplementTimeline(runA,true);'); await settle();
  await check('supplement timeline renders results even when it has no answer segment', 'section("first")?.nextSibling===runA.supplementTimeline.end&&messagesEl.querySelectorAll(".turn-deliverables").length===1');
  await act('review.changed({conversationId:"a",runId:"first",snapshot:snapshot("a","first",runA.turn.ts,[{id:"report",path:"D:/fixture/核对报告.pdf",name:"核对报告"},{id:"summary",path:"D:/fixture/结果摘要.md",name:"结果摘要"}])});');
  win.showInactive(); await settle(); fs.writeFileSync(path.join(output, 'results-light.png'), (await win.webContents.capturePage()).toPNG());
  await act('document.documentElement.dataset.theme="dark";'); win.setSize(420, 700); await settle();
  await check('result cards fit narrow dark windows', 'document.documentElement.scrollWidth<=innerWidth&&section("first").scrollWidth<=section("first").clientWidth+1');
  fs.writeFileSync(path.join(output, 'results-narrow-dark.png'), (await win.webContents.capturePage()).toPNG());
  await act('relayTurnDeliverables.clear();');
  await check('conversation cleanup releases every result view', '!messagesEl.querySelector(".turn-deliverables")');
  await check('renderer remains isolated and error free', 'review.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  await act('relayTurnDeliverables.destroy();cardLinks.destroy();');
  await check('controller shutdown removes its event subscription', 'review.unsubscribed');
  report.ok = report.checks.every(check => check.ok) && report.externalRequests === 0;
}).catch(error => { report.ok = false; report.errors.push(error.stack || String(error)); }).finally(() => {
  clearTimeout(deadline); save(); win?.destroy(); app.exit(report.ok ? 0 : 1);
});
