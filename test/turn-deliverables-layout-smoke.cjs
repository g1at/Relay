'use strict';
// Native Chromium integration with Relay's actual grid, scrolling conversation,
// answer columns, file links, and turn controllers. Uses synthetic content only.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/delivery-ui-fix-2026-10-15');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'layout-profile'));
app.commandLine.appendSwitch('disable-gpu');
const report = { checks: [], errors: [], externalRequests: 0, geometry: {} }; let win;
const sources = ['app.js', 'styles.css', 'workspace-panel.css', 'workspace-file-types.js', 'local-file-links.js', 'local-file-links.css', 'turn-delivery-references.js', 'turn-deliverables.js', 'turn-deliverables.css'];
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'renderer', file))).digest('hex')]));
const save = () => fs.writeFileSync(path.join(output, 'layout-result.json'), JSON.stringify(report, null, 2));
const timeout = setTimeout(() => { report.errors.push('native layout test timed out'); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate('(()=>{' + code + '\n})()');
const settle = () => new Promise(resolve => setTimeout(resolve, 220));
async function check(name, expression) { const ok = !!await evaluate(expression); report.checks.push({ name, ok }); console.log(name + ': ' + ok); save(); }
async function measure(name) { report.geometry[name] = await evaluate('review.measure()'); save(); }
async function capture(name) { fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function declaration(source, name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  if (!match) throw Error('missing production function ' + name);
  const tail = source.slice(match.index), next = /\n(?:async )?function \w+\(/.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}
function fixture() {
  window.review = { previews: [], notices: [], changes: [], errors: [], missing: false };
  window.addEventListener('error', e => review.errors.push(e.message));
  window.messagesEl = document.getElementById('messages');
  window.appEl = document.querySelector('.app');
  window.makeSnapshot = (runId, status = 'complete', file = 'D:/fixture/reports/' + runId + '.pdf') => ({
    version: 1, conversationId: 'conversation-a', runId, turnTs: '2026-10-15T07:33:44.441Z', status,
    complete: status === 'complete', items: [{ id: runId + '-file', path: file, name: '核对报告', size: 2048, mtimeMs: 1, source: 'output' }], warnings: [],
  });
  window.convA = { id: 'conversation-a', workingDir: 'D:/fixture', turns: [
    { runId: 'first', ts: '2026-10-15T07:33:44.441Z', assistant: '真实层级的长回答', deliverables: makeSnapshot('first') },
    { runId: 'second', ts: '2026-10-15T07:33:44.441Z', assistant: '' },
    { runId: 'empty', ts: '2026-10-15T07:33:44.441Z', assistant: '', deliverables: makeSnapshot('empty') },
  ] };
  window.currentConv = convA;
  window.runMap = new Map();
  window.runA = { convId: convA.id, jobId: 'first', turnIndex: 0, turn: convA.turns[0], outputState: { status: 'complete', final: '长回答' } };
  window.runB = { convId: convA.id, jobId: 'second', turnIndex: 1, turn: convA.turns[1], outputState: { status: 'running', final: '' } };
  window.runEmpty = { convId: convA.id, jobId: 'empty', turnIndex: 2, turn: convA.turns[2], outputState: { status: 'complete', final: '' } };
  for (const run of [runA, runB, runEmpty]) runMap.set(run.jobId, run);
  window.activeView = 'chat';
  window.currentAssistantBubble = null;
  window.outputStateForRun = run => run.outputState;
  window.streamMarkdownRenderer = { release() {}, render(body, text) { body.textContent = text; } };
  window.detachStreamRenderTarget = () => { currentAssistantBubble = null; };
  window.flushStreamRender = () => {};
  window.scrollToBottom = () => {};
  window.renderStreamBubble = el => { el.querySelector('.body').innerHTML = el.dataset.raw; };
  window.appendMessage = (role, text) => {
    const el = document.createElement('div'); el.className = 'message ' + role;
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    const body = document.createElement('div'); body.className = 'body'; body.innerHTML = text;
    bubble.append(body); el.append(bubble); messagesEl.append(el); return el;
  };
  review.addFooter = bubble => {
    appendAssistantCopy(bubble);
    const meta = document.createElement('div'); meta.className = 'message-meta';
    const time = document.createElement('span'); time.className = 'message-time'; time.textContent = '15:33'; meta.append(time);
    bubble.querySelector('.assistant-actions').append(meta);
  };
  review.footerLast = bubble => bubble.lastElementChild?.classList.contains('assistant-actions')
    && !!bubble.lastElementChild.querySelector('.message-time')
    && bubble.querySelector('.body').nextElementSibling?.classList.contains('turn-deliverables');
  window.anchor = index => {
    const el = document.createElement('span'); el.className = 'conversation-turn-anchor'; el.dataset.turnAnchor = index;
    messagesEl.append(el); return el;
  };
  window.section = id => Array.from(messagesEl.querySelectorAll('.turn-deliverables')).find(el => el.dataset.runId === id);
  window.ref = id => ({ conversationId: convA.id, runId: id, turnTs: convA.turns[0].ts, itemId: id + '-file' });
  window.relayTurnDeliveryReferences = RelayTurnDeliveryReferences.create({
    container: messagesEl, getConversation: () => currentConv,
    getTarget: reference => window.relayTurnDeliverables.getArtifactTarget(reference),
  });
  window.filelinks = RelayLocalFileLinks.install(messagesEl, {
    context: () => ({ conversationId: currentConv.id, workingDir: currentConv.workingDir }),
    resolveTurnArtifact: (link, parsed) => relayTurnDeliveryReferences.resolve(link, parsed),
    navigateTurnArtifact: reference => relayTurnDeliveryReferences.navigate(reference),
    preview: async input => { review.previews.push(input); return review.missing ? { ok: false, error: '文件已不存在' } : { ok: true }; },
    onError: text => review.notices.push(text),
  });
  window.relayTurnDeliverables = RelayTurnDeliverables.createController({
    container: messagesEl, getConversation: () => currentConv, getRun: id => runMap.get(id), isVisible: () => activeView === 'chat',
    bridge: { get: async () => ({ ok: false }), onChanged: cb => { review.changed = cb; return () => { review.unsubscribed = true; }; } },
    onPresentationChanged: owner => {
      review.changes.push(owner);
      relayTurnDeliveryReferences.refresh(owner, scope => filelinks.decorate(scope));
    },
  });
  anchor(0); appendMessage('user', '生成核对报告，并解释验证过程。');
  let longAnswer = '<p><a id="first-reference" href="D:/fixture/reports/first.pdf">下载核对报告</a></p><h2>核对报告与执行记录</h2>';
  for (let i = 0; i < 22; i++) longAnswer += '<p>第 ' + (i + 1) + ' 项：这是脱敏后的长回答布局样本，记录输入、核对范围、验证结果和局限。每个结果都属于明确的会话与轮次，不能靠相同文件名归并。</p>';
  longAnswer += '<table><thead><tr><th>范围</th><th>结果</th></tr></thead><tbody><tr><td>当前会话</td><td>已核对</td></tr><tr><td>下一轮</td><td>独立登记</td></tr></tbody></table>';
  longAnswer += '<ul><li>首个文件只保留一张成果卡。</li><li>切换侧栏后与正文列保持一致。</li></ul><p class="answer-end">本轮长回答结束，下面才是本轮成果。</p>';
  runA.outputState.final = longAnswer; renderRunOutput(runA); review.addFooter(runA.outputBubble);
  anchor(1); appendMessage('user', '请继续核对第二份报告。');
  runB.outputBubble = appendMessage('assistant', '<p><a id="second-reference" href="D:/fixture/reports/second.pdf">第二份核对报告</a></p><p>正在整理第二轮结果。</p>');
  RelayTurnDeliveryReferences.stampOwner(runB.outputBubble, convA.id, runB.turn, 1);
  filelinks.decorate();
  review.measure = () => {
    const rect = el => { const b = el.getBoundingClientRect(); return { x: b.x, width: b.width, top: b.top, bottom: b.bottom }; };
    return { viewport: innerWidth, stage: rect(document.querySelector('.conversation-stage')), messages: rect(messagesEl), answer: rect(runA.outputBubble), result: rect(section('first')), composer: rect(document.querySelector('.input-card')) };
  };
  review.aligned = () => { const g = review.measure(); return Math.abs(g.answer.x - g.result.x) < 1 && Math.abs(g.answer.width - g.result.width) < 1 && g.result.width <= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--max-chat-w')) + 1; };
}
app.whenReady().then(async () => {
  report.sourceHashes = hashes();
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const cancel = /^https?:/i.test(details.url); if (cancel) report.externalRequests++; done({ cancel });
  });
  win = new BrowserWindow({ width: 1920, height: 1000, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (...args) => { const message = args[1]?.message || args[2]; if (typeof message === 'string') console.log('renderer:', message); });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN" style="--max-chat-w:1080px"><meta charset="utf-8"><body><div class="app has-workspace-panel" style="--sidebar-visible-width:384px"><aside class="sidebar"><div class="sidebar-header">Relay · 独立布局验收</div></aside><main class="chat"><div class="chat-header">长回答与按轮成果</div><div class="conversation-stage"><div class="messages" id="messages"></div></div><div class="input-area"><div class="input-card"><div class="textarea-wrap"><textarea placeholder="继续对话"></textarea></div></div></div></main><aside class="workspace-panel"><div class="workspace-panel-header">报告预览</div><div class="workspace-preview-body">独立文件预览区域</div></aside></div></body></html>'));
  win.webContents.setZoomFactor(0.7);
  for (const file of ['styles.css', 'workspace-panel.css', 'workspace-file-types.css', 'local-file-links.css', 'turn-deliverables.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(root, 'renderer', file), 'utf8'));
  for (const file of ['workspace-file-types.js', 'local-file-links.js', 'turn-delivery-references.js']) await evaluate(fs.readFileSync(path.join(root, 'renderer', file), 'utf8') + '\nvoid 0;');
  // Optional saved pre-fix module/CSS reproduces both screenshot defects in the
  // same layout. It is a source replay, not a claim about a running old app.
  const beforeJs = path.join(output, 'before-turn-deliverables.js'), beforeCss = path.join(output, 'before-turn-deliverables.css');
  if (fs.existsSync(beforeJs) && fs.existsSync(beforeCss)) {
    const cssKey = await win.webContents.insertCSS(fs.readFileSync(beforeCss, 'utf8'));
    await evaluate(fs.readFileSync(beforeJs, 'utf8') + '\nvoid 0;');
    report.baseline = await evaluate(String.raw`(function(){const container=document.getElementById("messages"),turn={runId:"baseline",ts:"baseline-ts",deliverables:{version:1,conversationId:"baseline",runId:"baseline",turnTs:"baseline-ts",status:"running",complete:false,items:[{id:"baseline-file",path:"D:/fixture/report.pdf"}],warnings:[]}},conv={id:"baseline",turns:[turn]};container.innerHTML="<div class=\"message assistant\"><div class=\"bubble\"><div class=\"body\">修复前模块宽度复现</div></div></div>";const controller=RelayTurnDeliverables.createController({container,getConversation:()=>conv,getRun:()=>({convId:conv.id,jobId:turn.runId,turn,outputState:{status:"running"}})});controller.render(turn,{conversationId:conv.id,turnIndex:0});const a=container.firstChild.getBoundingClientRect(),s=container.querySelector(".turn-deliverables"),b=s.getBoundingClientRect(),result={kind:"saved pre-fix module and CSS in current real layout",answer:{x:a.x,width:a.width},result:{x:b.x,width:b.width},runningResultVisible:!!s,aligned:Math.abs(a.x-b.x)<1&&Math.abs(a.width-b.width)<1};controller.destroy();container.replaceChildren();return result;})()`);
    await win.webContents.removeInsertedCSS(cssKey); save();
  }
  await evaluate(fs.readFileSync(path.join(root, 'renderer/turn-deliverables.js'), 'utf8') + '\nvoid 0;');
  const appSource = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  await evaluate(declaration(appSource, 'appendAssistantCopy') + '\nvoid 0;');
  await evaluate(declaration(appSource, 'renderRunOutput') + '\nvoid 0;');
  await evaluate(declaration(appSource, 'renderSupplementTimeline') + '\nvoid 0;');
  await evaluate('(' + fixture.toString() + ')()'); win.showInactive(); await settle(); await act('section("first").scrollIntoView({block:"center"});'); await settle();
  await check('long answer owns one bottom card and an inline reference, not a duplicate body card', 'section("first").querySelectorAll(".relay-file-card").length===1&&runA.outputBubble.querySelectorAll(".body .relay-file-card").length===0&&document.getElementById("first-reference").classList.contains("relay-turn-artifact-reference")');
  await check('wide answer and result inherit the same real column', 'review.aligned()&&review.measure().answer.width===1080&&review.measure().stage.width>1080'); await measure('wide');
  await check('result follows full answer and stays before the next turn', 'runA.outputBubble.querySelector(".body").nextElementSibling===section("first")&&runA.outputBubble.nextElementSibling?.dataset.turnAnchor==="1"');
  await check('long answer keeps copy branch retry and time below its embedded result', 'review.footerLast(runA.outputBubble)&&runA.outputBubble.querySelectorAll(".assistant-actions > button").length===3&&runA.outputBubble.getBoundingClientRect().height>800');
  await check('a file with no registered ownership retains its ordinary standalone card', 'document.getElementById("second-reference").classList.contains("relay-file-card")&&!section("second")');
  await act('review.changed({conversationId:convA.id,runId:"second",snapshot:makeSnapshot("second","running")});'); await settle();
  await check('late running ownership removes an existing body card without showing early results', '!document.getElementById("second-reference").classList.contains("relay-file-card")&&!document.getElementById("second-reference").classList.contains("relay-turn-artifact-reference")&&!section("second")&&!relayTurnDeliverables.getArtifactTarget(ref("second"))&&runB.turn.deliverables.status==="running"');
  await act('review.countBefore=review.changes.length;review.changed({conversationId:convA.id,runId:"second",snapshot:makeSnapshot("second","running")});');
  await check('repeated running snapshots do not refresh body ownership again', 'review.changes.length===review.countBefore');
  await act('review.changed({conversationId:convA.id,runId:"second",snapshot:makeSnapshot("second")});'); await settle();
  await check('host terminal snapshot waits for live final output before exposing a target', '!section("second")&&!relayTurnDeliverables.getArtifactTarget(ref("second"))&&!document.getElementById("second-reference").classList.contains("relay-file-card")');
  await act(String.raw`runB.outputState={status:"complete",final:"<p><a id=\"second-reference\" href=\"D:/fixture/reports/second.pdf\">第二份核对报告</a></p><p>第二轮已完成，成果属于第二轮。</p>"};renderRunOutput(runB);`); await settle();
  await check('final live output shows its own one card after its answer', 'runB.outputBubble.querySelector(".body").nextElementSibling===section("second")&&section("second").querySelectorAll(".relay-file-card").length===1&&runB.outputBubble.querySelectorAll(".body .relay-file-card").length===0&&document.getElementById("second-reference").classList.contains("relay-turn-artifact-reference")');
  await act('review.addFooter(runB.outputBubble);');
  await check('footer added after result creation still remains the last part of the same answer', 'review.footerLast(runB.outputBubble)&&runB.outputBubble.querySelector(".bubble").lastElementChild===section("second")');
  await act('review.previewCount=review.previews.length;document.getElementById("first-reference").click();'); await settle();
  await check('inline reference navigates and focuses its exact bottom card without opening a second preview', 'review.previews.length===review.previewCount&&document.activeElement===relayTurnDeliverables.getArtifactTarget(ref("first"))');
  await act('relayTurnDeliverables.getArtifactTarget(ref("first")).click();'); await settle();
  await check('the unique bottom card keeps the existing local preview action', 'review.previews.length===review.previewCount+1&&RelayLocalFileLinks.parse(review.previews.at(-1).href).path==="D:/fixture/reports/first.pdf"&&review.previews.at(-1).context.conversationId===convA.id');
  await act('review.stableTarget=relayTurnDeliverables.getArtifactTarget(ref("first"));review.stableTarget.focus();review.countBefore=review.changes.length;review.changed({conversationId:convA.id,runId:"first",snapshot:makeSnapshot("first")});'); await settle();
  await check('identical terminal events preserve target focus and avoid redundant body decoration', 'review.stableTarget===relayTurnDeliverables.getArtifactTarget(ref("first"))&&document.activeElement===review.stableTarget&&review.changes.length===review.countBefore');
  await act('review.staleEnd=document.createComment("stale old timeline marker after next turn");messagesEl.append(review.staleEnd);relayTurnDeliverables.render(runA.turn,{conversationId:convA.id,turnIndex:0,before:review.staleEnd});');
  await check('a stale timeline marker cannot move an earlier result under the next turn', 'section("first").closest(".message").nextElementSibling?.dataset.turnAnchor==="1"');
  await act('review.missing=true;relayTurnDeliverables.getArtifactTarget(ref("first")).click();'); await settle();
  await check('missing file retains recorded ownership and reports preview failure', 'review.notices.at(-1)==="文件已不存在"&&relayTurnDeliverables.getArtifactTarget(ref("first"))===review.stableTarget');
  await act('section("first").scrollIntoView({block:"center"});'); win.showInactive(); await settle(); await capture('long-answer-wide');
  await act('appEl.classList.add("workspace-open");appEl.style.setProperty("--workspace-visible-width","380px");appEl.style.setProperty("--workspace-panel-width","380px");'); await settle();
  await check('opening the real workspace grid keeps the result aligned with its answer', 'review.aligned()&&review.measure().stage.width<1300'); await measure('workspace-open'); await capture('long-answer-sidebar');
  await act('document.documentElement.style.setProperty("--max-chat-w","760px");'); await settle();
  await check('changing the answer width preference resizes result and body together', 'review.aligned()&&review.measure().answer.width===760'); await measure('preferred-760');
  await act('appEl.classList.remove("workspace-open");appEl.classList.add("sidebar-collapsed");appEl.style.setProperty("--workspace-visible-width","0px");appEl.style.setProperty("--workspace-panel-width","0px");document.documentElement.dataset.theme="dark";'); win.webContents.setZoomFactor(1); win.setSize(420, 800); await settle();
  await act('section("first").scrollIntoView({block:"center"});'); await settle();
  await check('narrow dark viewport uses the same answer width with no result overflow', 'review.aligned()&&document.documentElement.scrollWidth<=innerWidth&&section("first").scrollWidth<=section("first").clientWidth+1&&section("first").getBoundingClientRect().right<=innerWidth'); await measure('narrow-dark'); await capture('long-answer-narrow-dark');
  await act('anchor(2);appendMessage("user","只生成文件，无需正文。");renderRunOutput(runEmpty);anchor(3);appendMessage("user","下一轮独立输入。");'); await settle();
  await check('empty final output still places its card in its own turn before the next input', 'section("empty")&&section("empty").nextElementSibling?.dataset.turnAnchor==="3"&&!runEmpty.outputBubble&&section("empty").dataset.turn==="2"');
  await act('review.segmentTurn={runId:"supplement",ts:convA.turns[0].ts,deliverables:makeSnapshot("supplement")};convA.turns.push(review.segmentTurn);review.partial=appendMessage("assistant","<p>较早的补充回答段。</p>");RelayTurnDeliveryReferences.stampOwner(review.partial,convA.id,review.segmentTurn,3);review.partial.dataset.timelinePartial="true";review.finalSegment=appendMessage("assistant","<p>最后完成的补充回答段。</p>");RelayTurnDeliveryReferences.stampOwner(review.finalSegment,convA.id,review.segmentTurn,3);relayTurnDeliverables.render(review.segmentTurn,{conversationId:convA.id,turnIndex:3});'); await settle();
  await check('supplement results attach only to the last complete answer segment', 'section("supplement")?.parentNode===review.finalSegment.querySelector(".bubble")&&!review.partial.querySelector(".turn-deliverables")');
  await act('review.segmentTarget=relayTurnDeliverables.getArtifactTarget(ref("supplement"));review.finalSegment.remove();review.rebuiltSegment=appendMessage("assistant","<p>重建后的最后补充回答段。</p>");RelayTurnDeliveryReferences.stampOwner(review.rebuiltSegment,convA.id,review.segmentTurn,3);relayTurnDeliverables.render(review.segmentTurn,{conversationId:convA.id,turnIndex:3});'); await settle();
  await check('rebuilding an answer segment reattaches its existing exact result without duplicating cards', 'section("supplement")?.parentNode===review.rebuiltSegment.querySelector(".bubble")&&relayTurnDeliverables.getArtifactTarget(ref("supplement"))===review.segmentTarget&&messagesEl.querySelectorAll(".turn-deliverables[data-run-id=supplement]").length===1');
  await act('window.otherConv={id:"conversation-b",turns:[]};currentConv=otherConv;');
  await check('switching selected conversation immediately invalidates old mounted card targets', '!relayTurnDeliverables.getArtifactTarget(ref("first"))&&!relayTurnDeliveryReferences.navigate(ref("first"))');
  await act('relayTurnDeliverables.clear();messagesEl.replaceChildren();review.changed({conversationId:convA.id,runId:"first",snapshot:makeSnapshot("first")});');
  await check('background completion cannot display cards or modify the other conversation', '!messagesEl.querySelector(".turn-deliverables")&&otherConv.turns.length===0');
  await act(String.raw`currentConv=JSON.parse(JSON.stringify(convA));runMap.clear();anchor(0);runA.outputBubble=appendMessage("assistant","<p><a id=\"reopened-reference\" href=\"D:/fixture/reports/first.pdf\">重新打开报告</a></p><p>历史回答末尾。</p>");RelayTurnDeliveryReferences.stampOwner(runA.outputBubble,currentConv.id,currentConv.turns[0],0);anchor(1);appendMessage("user","下一轮历史输入");relayTurnDeliverables.render(currentConv.turns[0],{conversationId:currentConv.id,turnIndex:0});filelinks.decorate();`); await settle();
  await check('history reopen reconstructs one card and one inline reference from persisted exact ownership', 'messagesEl.querySelectorAll(".relay-file-card").length===1&&document.getElementById("reopened-reference").classList.contains("relay-turn-artifact-reference")&&section("first").closest(".message").nextElementSibling?.dataset.turnAnchor==="1"');
  await act('review.countBefore=review.changes.length;relayTurnDeliverables.clear();'); await settle();
  await check('removing mounted results invalidates targets and restores compact pending file links', '!relayTurnDeliverables.getArtifactTarget(ref("first"))&&!document.getElementById("reopened-reference").classList.contains("relay-turn-artifact-reference")&&!document.getElementById("reopened-reference").classList.contains("relay-file-card")&&review.changes.length===review.countBefore+1');
  await check('native renderer remains isolated without runtime errors or injected Node globals', 'review.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');
  await act('relayTurnDeliverables.destroy();filelinks.destroy();');
  await check('controller teardown unsubscribes its host event', 'review.unsubscribed');
  report.finalSourceHashes = hashes(); report.sourceUnchanged = JSON.stringify(report.sourceHashes) === JSON.stringify(report.finalSourceHashes);
  report.ok = report.checks.every(c => c.ok) && report.externalRequests === 0 && report.sourceUnchanged;
}).catch(error => { report.ok = false; report.errors.push(error.stack || String(error)); }).finally(() => {
  clearTimeout(timeout); save(); win?.destroy(); app.exit(report.ok ? 0 : 1);
});
