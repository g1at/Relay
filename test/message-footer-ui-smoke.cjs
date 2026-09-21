'use strict';
// Production renderer, in-memory history/projects and isolated Electron profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const fixtureYear = new Date().getFullYear();
const completedAt = `${fixtureYear}-09-14T11:38:00`;
const previousYearAt = `${fixtureYear - 1}-12-31T23:59:58`;
const completedLabel = '9月14日 11:38';
const previousYearLabel = `${fixtureYear - 1}年12月31日 23:59`;
const out = path.join(root, '.codex-tmp/message-footer-ui-smoke');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'start'; const checks = {}, errors = [];
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, errors }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout: '+step); save(); app.exit(1); }, 75000);
const ev = code => win.webContents.executeJavaScript(code);
const act = code => ev(`(()=>{${code}\n})()`);
const settle = () => new Promise(resolve => setTimeout(resolve, 160));
async function waitFor(code) { await ev(`new Promise((resolve,reject)=>{const deadline=performance.now()+5000;const tick=()=>{if(${code})return resolve();if(performance.now()>deadline)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20);};tick();})`); }
async function check(name, code) { step=name;checks[name]=!!await ev(code);save();console.log(name+': '+checks[name]);if(!checks[name])throw Error(name); }
async function capture(name) { if(name!=='failure')await waitFor('!document.querySelector(".app-toast.show")');await settle();fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG()); }
async function hover(selector) {
  const point=await ev(`(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(box.x+Math.min(box.width/2,20)),y:Math.round(box.y+box.height/2)};})()`);
  const zoom=win.webContents.getZoomFactor();
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x*zoom),y:Math.round(point.y*zoom)});await settle();
}
async function tab(modifiers=[]) { for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Tab',modifiers});await settle(); }
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
  const fixture=fs.readFileSync(path.join(root,'test/ui-api-fixture.js'),'utf8');
  const seed=`(()=>{localStorage.clear();const base=window.api;window.footerReview={copied:[],forks:[],pins:[]};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>footerReview.copied.push(text)}});
    window.api=new Proxy(base,{get(target,key){
      if(key==='projects')return new Proxy(target.projects,{get(original,method){if(method==='list')return async()=>({ok:true,projects:[{id:'synthetic-project',name:'合成项目',path:'D:/synthetic/project'}]});return original[method];}});
      if(key==='history')return new Proxy(target.history,{get(original,method){
        if(method==='fork')return async request=>{footerReview.forks.push(request);return{ok:true,conversationId:'footer-fixture'};};
        if(method==='setPinned')return async(id,pinned)=>{footerReview.pins.push({id,pinned});return{ok:true};};
        return original[method];}});
      return target[key];}});
  })();`;
  const file=path.join(out,'fixture.html');
  fs.writeFileSync(file,fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+seed+'</script>'));
  win=new BrowserWindow({width:1200,height:820,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(file);win.showInactive();await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle');
  await ev(`(async()=>{await window.api.history.save({id:'footer-fixture',title:'合成项目报告',mode:'plain',model:'opus',turns:[{user:'检查合成项目',assistant:'# 合成报告\\n\\n已完成检查，交付内容供核对。',runId:'synthetic-run',status:'complete',ts:'2026-09-12T03:50:00Z',assistantTs:'2026-09-12T03:52:00Z'}]});await loadConversation('footer-fixture');await refreshHistoryList();})()`);
  await act(`currentConv.turns[0].assistantTs=${JSON.stringify(completedAt)};appendMessageTime(document.querySelector('.message.assistant'),currentConv.turns[0].assistantTs);`);
  await check('SameYearFooterIncludesCompactDateAndTime', `document.querySelector('.assistant-actions time').textContent===${JSON.stringify(completedLabel)}`);
  await check('HoverUsesTheSameChineseDateAndPreservesThePreciseTimestamp', `document.querySelector('.assistant-actions time').title===${JSON.stringify(completedLabel)}&&document.querySelector('.assistant-actions time').dateTime===${JSON.stringify(completedAt)}`);
  await check('SharedFormatterDistinguishesPriorYearsAndUsesLocalCalendar', `RelayMessageTime.compact(${JSON.stringify(previousYearAt)})===${JSON.stringify(previousYearLabel)}&&RelayMessageTime.compact(new Date(${fixtureYear},0,1,0,5))==='1月1日 00:05'&&RelayMessageTime.compact('invalid')===''`);
  await act('inputEl.focus();');await hover('.sidebar');
  await check('MainTimestampRemainsHiddenAwayFromTheAnswer', 'getComputedStyle(document.querySelector(".message.assistant .message-meta")).opacity==="0"');
  await hover('.message.assistant .body');
  await check('MainAnswerHoverRevealsTheSameChineseTimestamp', `getComputedStyle(document.querySelector('.message.assistant .message-meta')).opacity==='1'&&document.querySelector('.assistant-actions time').textContent===${JSON.stringify(completedLabel)}`);
  await hover('.sidebar');
  await check('LeavingTheMainAnswerHidesItsTimestamp', 'getComputedStyle(document.querySelector(".message.assistant .message-meta")).opacity==="0"');
  await check('HistoryKeepsRenamePinAndDelete','[".hi-rename",".hi-pin",".hi-del"].every(s=>document.querySelector(".history-item[data-id=footer-fixture]").querySelector(s))');
  await act(`window.getSelection().removeAllRanges();const row=document.querySelector('.history-item[data-id=footer-fixture]');row.querySelector('.hi-title').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:120,clientY:280}));`);await settle();
  await check('HistoryRightClickOpensNeitherRemovedPopover','!document.querySelector(".session-fork-menu")&&!document.querySelector(".composer-add-menu[data-variant=project-picker]")&&footerReview.forks.length===0');
  await capture('history-without-popovers');
  await act(`$('btnProjectContext').click();`);await waitFor('document.querySelector(".composer-add-menu[data-variant=project-picker] .project-search")');
  await check('NormalComposerProjectPickerStillWorks','document.querySelector(".composer-add-menu[data-variant=project-picker]").textContent.includes("合成项目")&&document.querySelector(".composer-add-menu[data-variant=project-picker]").textContent.includes("不在项目中工作")');
  await act(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));document.querySelector('.history-item[data-id=footer-fixture] .hi-pin').click();`);await settle();
  await check('PinStillUsesExistingHistoryAction','footerReview.pins.length===1&&footerReview.pins[0].id==="footer-fixture"');
  await act(`document.querySelector('.assistant-copy').click();`);await settle();
  await check('AnswerCopyRetainsExactMarkdown','footerReview.copied[0]===currentConv.turns[0].assistant');
  await act(`document.querySelector('.assistant-fork').click();`);await settle();
  await check('AnswerBranchStillCallsNativeFork','footerReview.forks.length===1&&footerReview.forks[0].conversationId==="footer-fixture"&&footerReview.forks[0].runId==="synthetic-run"&&!footerReview.forks[0].redo');
  await act(`document.querySelectorAll('.assistant-fork')[1].click();`);await settle();
  await check('AnswerRetryRetainsNativeBranchBehavior','footerReview.forks.length===2&&footerReview.forks[1].redo===true');
  await act(`const p=document.querySelector('.message.assistant .body p'),range=document.createRange();range.selectNodeContents(p);window.getSelection().removeAllRanges();window.getSelection().addRange(range);footerReview.selected=window.getSelection().toString();p.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:520,clientY:260}));`);
  await check('NormalSelectedTextCopyPopoverRemains','document.querySelector(".copy-popover.show .cp-btn")');
  await act(`document.querySelector('.copy-popover.show .cp-btn').click();window.getSelection().removeAllRanges();`);await settle();
  await check('SelectedTextCopyStillWorks','footerReview.copied.at(-1)===footerReview.selected');
  for(const [width,zoom,theme]of [[1200,1,'light'],[780,1,'dark'],[620,1.25,'light']]){
    win.setSize(width,820);win.webContents.setZoomFactor(zoom);
    await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('.assistant-copy').focus();`);await settle();
    await check('FooterIsOneNonOverlappingFlexRow'+width,`(()=>{const footer=document.querySelector('.assistant-actions'),nodes=[...footer.querySelectorAll(':scope > button'),footer.querySelector('.message-meta')],boxes=nodes.map(n=>n.getBoundingClientRect());return getComputedStyle(footer).display==='flex'&&nodes.length===4&&footer.querySelectorAll('.message-time').length===1&&boxes.every((b,i)=>b.width>0&&Math.abs((b.top+b.height/2)-(boxes[0].top+boxes[0].height/2))<1.5&&(!i||b.left>=boxes[i-1].right+3))&&boxes.at(-1).right<=document.querySelector('.message.assistant').getBoundingClientRect().right+1;})()`);
    await check('TimestampIsStaticAndAfterAllButtons'+width,'getComputedStyle(document.querySelector(".assistant-actions .message-meta")).position==="static"&&document.querySelector(".assistant-actions").lastElementChild.classList.contains("message-meta")');
    await act(`appendMessageTime(document.querySelector('.message.assistant'),${JSON.stringify(previousYearAt)});`);
    await check('PriorYearDateDoesNotOverlapButtons'+width, '(()=>{const footer=document.querySelector(".assistant-actions"),meta=footer.querySelector(".message-meta").getBoundingClientRect(),button=footer.querySelectorAll(":scope > button")[2].getBoundingClientRect(),edge=footer.parentElement.getBoundingClientRect();return meta.left>=button.right+3&&meta.right<=edge.right+1&&getComputedStyle(footer.querySelector(".message-meta")).whiteSpace==="nowrap";})()');
    await capture('footer-'+width+'-'+theme);
  }
  await act(`footerReview.early=appendMessage('assistant','稍后收尾的流式回答',null,{streaming:true,ts:'2026-09-12T03:52:00Z'});appendAssistantCopy(footerReview.early);appendMessageTime(footerReview.early,'2026-09-12T03:53:00Z');`);
  await check('StreamingTimestampMovesIntoFooterWithoutDuplication','footerReview.early.querySelectorAll(".message-meta").length===1&&footerReview.early.querySelector(".assistant-actions").lastElementChild.classList.contains("message-meta")&&footerReview.early.querySelector("time").dateTime==="2026-09-12T03:53:00Z"');
  await check('NoRendererErrorsOrUnsafeRuntime','uiFixture.errors.length===0&&typeof require==="undefined"&&typeof process==="undefined"');

  // The production quick-chat renderer uses the same timestamp, beside its
  // copy action. The fixture never opens a real conversation or provider.
  const miniSeed=`(()=>{localStorage.clear();const base=window.api;window.footerReview={copied:[]};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>footerReview.copied.push(value)}});
    const state={conversation:{id:'mini-footer',model:'opus',turns:[{user:'合成小窗问题',assistant:'合成小窗交付',assistantTs:${JSON.stringify(completedAt)},status:'complete'}]},running:false,pinned:true,model:'opus',brand:{name:'Relay',theme:'light'}};
    window.miniFooter={state,emit(){this.callback?.(JSON.parse(JSON.stringify(state)));}};
    const mini={state:async()=>state,brand:async()=>state.brand,onState:callback=>{miniFooter.callback=callback;return()=>{};},onFocus:()=>()=>{},resize:async()=>({ok:true})};
    window.api=new Proxy(base,{get(target,key){if(key==='mini')return mini;return target[key];}});
  })();`;
  const miniFile=path.join(out,'mini-fixture.html');
  fs.writeFileSync(miniFile,fs.readFileSync(path.join(root,'renderer/mini.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+miniSeed+'</script>'));
  const previousWin=win;
  win=new BrowserWindow({width:460,height:420,show:false,useContentSize:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  previousWin.destroy();await win.loadFile(miniFile);win.webContents.setZoomFactor(1);win.showInactive();await waitFor(`document.querySelector('.mini-message-time')?.textContent===${JSON.stringify(completedLabel)}`);
  await check('MiniUsesTheSameCompactDateAndFullTitle', `document.querySelector('.mini-message-time').title===${JSON.stringify(completedLabel)}&&document.querySelector('.mini-message-time').dateTime===${JSON.stringify(completedAt)}&&!document.querySelector('.mini-message-time').hidden`);
  await act('document.getElementById("miniInput").focus();');await hover('.mini-head');
  await check('MiniTimestampHiddenByDefaultAndCopyStillVisible', 'getComputedStyle(document.querySelector(".mini-message-time")).opacity==="0"&&getComputedStyle(document.querySelector(".mini-copy")).opacity==="1"');
  await act('footerReview.timestampBox=document.querySelector(".mini-message-time").getBoundingClientRect().toJSON();footerReview.actionsBox=document.querySelector(".mini-answer-actions").getBoundingClientRect().toJSON();');
  await capture('mini-timestamp-default');
  await hover('.mini-answer');
  await check('HoveringTheMiniAnswerRevealsItsTimestamp', 'getComputedStyle(document.querySelector(".mini-message-time")).opacity==="1"');
  await capture('mini-timestamp-answer-hover');
  await hover('.mini-answer-actions');
  await check('HoveringMiniActionsKeepsTheTimestampVisible', 'getComputedStyle(document.querySelector(".mini-message-time")).opacity==="1"');
  await hover('.mini-head');
  await check('LeavingTheMiniAnswerHidesItsTimestamp', 'getComputedStyle(document.querySelector(".mini-message-time")).opacity==="0"');
  await hover('.mini-user');
  await check('HoveringTheUserBubbleDoesNotRevealAnswerMetadata', 'getComputedStyle(document.querySelector(".mini-message-time")).opacity==="0"');
  await hover('.mini-head');await act('document.getElementById("miniInput").focus();');await tab(['shift']);
  await check('KeyboardFocusOnCopyRevealsTheTimestamp', 'document.activeElement.matches(".mini-copy")&&getComputedStyle(document.querySelector(".mini-message-time")).opacity==="1"');
  await capture('mini-timestamp-keyboard-focus');
  await tab();
  await check('KeyboardFocusLeavingTheAnswerHidesTheTimestamp', 'document.activeElement.id==="miniInput"&&getComputedStyle(document.querySelector(".mini-message-time")).opacity==="0"');
  await check('TimestampVisibilityNeverMovesTheFooterOrCopyButton', '(()=>{const time=document.querySelector(".mini-message-time").getBoundingClientRect(),actions=document.querySelector(".mini-answer-actions").getBoundingClientRect();return ["x","y","width","height"].every(key=>time[key]===footerReview.timestampBox[key]&&actions[key]===footerReview.actionsBox[key]);})()');
  await act('document.querySelector(".mini-copy").click();');await settle();
  await check('MiniTimestampDoesNotAlterCopiedAnswer', 'footerReview.copied[0]==="合成小窗交付"');
  for(const [width,zoom]of [[460,1],[380,1.25]]){
    win.setContentSize(width,420);win.webContents.setZoomFactor(zoom);
    await act(`miniFooter.state.conversation.turns[0].assistantTs=${JSON.stringify(previousYearAt)};miniFooter.emit();`);await settle();
    await check('MiniPriorYearTimestampFitsBesideCopy'+width, '(()=>{const time=document.querySelector(".mini-message-time").getBoundingClientRect(),copy=document.querySelector(".mini-copy").getBoundingClientRect(),row=document.querySelector(".mini-answer-actions").getBoundingClientRect();return time.width>0&&time.left>=copy.right+4&&time.right<=row.right+1&&Math.abs((time.top+time.height/2)-(copy.top+copy.height/2))<=1;})()');
    await act('document.querySelector(".mini-copy").focus();');await settle();
    await capture('mini-footer-'+width);
  }
  await act('delete miniFooter.state.conversation.turns[0].assistantTs;miniFooter.emit();');await settle();
  await check('MiniDoesNotInventADateForLegacyAnswers', 'document.querySelector(".mini-message-time").hidden&&!document.querySelector(".mini-message-time").textContent');
  await act(`miniFooter.state.conversation.turns[0].assistantTs=${JSON.stringify(completedAt)};miniFooter.state.conversation.turns[0].status='running';miniFooter.state.running=true;miniFooter.emit();`);await settle();
  await check('MiniDoesNotShowCompletionTimestampWhileStillRunning', 'document.querySelector(".mini-message-time").hidden&&document.querySelector(".mini-answer-actions").hidden');
  await check('MiniRendererHasNoErrors', 'uiFixture.errors.length===0');
  step='complete';save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{errors.push(String(error.stack||error));console.error(error);if(win&&!win.isDestroyed())try{console.error(await ev('JSON.stringify({errors:uiFixture.errors,footer:document.querySelector(".assistant-actions")?.outerHTML})'));await capture('failure');}catch(_){}save();clearTimeout(deadline);app.exit(1);});
