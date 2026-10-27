'use strict';
// Actual main renderer and sanitized readers; only synthetic in-memory history.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/code-blocks-ui-smoke');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const checks = {}, failures = [], network = [];
let win;
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ checks, failures, network }, null, 2));
const deadline = setTimeout(() => { failures.push('timeout'); save(); app.exit(1); }, 90000);
const ev = code => win.webContents.executeJavaScript(code);
const act = code => ev(`(()=>{${code}\n})()`);
const wait = code => ev(`new Promise((resolve,reject)=>{const end=Date.now()+6000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`);
async function check(name, code) { checks[name] = !!await ev(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function capture(name) { await ev('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await win.webContents.capturePage(); await new Promise(resolve => setTimeout(resolve, 100)); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
const code = ['<!doctype html>', '<html lang="zh-CN">', '<head><title>Isolated fixture</title></head>', '<body>', ...Array.from({ length: 22 }, (_, i) => `<p>Fixture line ${i} ${'long-'.repeat(28)}</p>`), '</body>', '</html>'].join('\n');
const first = '完整代码：\n\n```html\n' + code + '\n```';
const final = '根据补充要求，仅展示代码：\n\n```html\n' + code.replace('Isolated fixture', 'Final fixture') + '\n```';

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => { if (/^https?:/i.test(details.url)) network.push(details.url); done({ cancel: /^https?:/i.test(details.url) }); });
  const seed = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8') + `;window.codeFixture={copied:[],previews:[]};Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>codeFixture.copied.push(text)}});`;
  const page = path.join(out, 'main.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + seed + '</script>'));
  win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page); await wait('providerRoutingLoaded&&!restoringActiveRuns&&!!window.relayWorkspacePanel');
  await act(`window.relayWorkspacePanel={...window.relayWorkspacePanel,openCodePreview:async html=>{codeFixture.previews.push(html);return{ok:true}}};
    window.firstCode=${JSON.stringify(first)};window.finalCode=${JSON.stringify(final)};
    currentConv={id:'code-fixture-conversation',title:'代码块一致性测试',turns:[]};messagesEl.replaceChildren();
    const O=RelayAssistantOutput;codeFixture.output=O.createState();
    O.ingest(codeFixture.output,{type:'assistant',uuid:'first-frame',message:{id:'first-message',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:firstCode}]}});
    codeFixture.turn={runId:'code-run',user:'输出HTML',assistant:'',status:'running',output:codeFixture.output,supplements:[]};
    codeFixture.run={jobId:'code-run',convId:currentConv.id,turn:codeFixture.turn,turnIndex:0,outputState:codeFixture.output,activityState:newActivityState()};
    currentConv.turns=[codeFixture.turn];syncRunOutputActivity(codeFixture.run,true);`);
  await wait("messagesEl.querySelector('.conversation-narration pre.relay-code-block .code-run')");
  await check('ProcessCodeHasTheSameChromeAndAllActions', "(()=>{const pre=messagesEl.querySelector('.conversation-narration pre');return getComputedStyle(pre,'::before').height==='28px'&&pre.querySelector('.code-run')&&pre.querySelector('.code-toggle')&&pre.querySelector('.code-copy')})()");
  await check('CodeChromeDoesNotPromoteProcessToFinal', "!messagesEl.querySelector('.message.assistant .body')&&codeFixture.output.status==='running'");
  await act("messagesEl.querySelector('.conversation-narration .code-copy').click();messagesEl.querySelector('.conversation-narration .code-run').click()");
  await wait('codeFixture.copied.length===1&&codeFixture.previews.length===1');
  await check('ProcessCopyAndRunUseOnlyExactSource', `codeFixture.copied[0]===${JSON.stringify(code)}&&codeFixture.previews[0]===${JSON.stringify(code)}`);
  await act("messagesEl.querySelector('.conversation-narration .code-toggle').click();codeFixture.extra=document.createElement('div');messagesEl.append(codeFixture.extra);relayRenderReadOnlyMarkdown(codeFixture.extra,firstCode)");
  await check('ReadonlyCodeGetsTrustedControlsAfterSanitization', '!!codeFixture.extra.querySelector("pre.relay-code-block .code-run")');
  await act("codeFixture.extra.querySelector('.code-toggle').click();relayRenderReadOnlyMarkdown(codeFixture.extra,firstCode+'\\n\\n继续输出')");
  await check('ReadonlyRedrawPreservesUserCollapseState', 'codeFixture.extra.querySelector("pre").classList.contains("collapsed")&&codeFixture.extra.querySelectorAll(".code-actions").length===1');
  await act("codeFixture.extra.querySelector('.code-toggle').click();relayRenderReadOnlyMarkdown(codeFixture.extra,firstCode+'\\n\\n更多输出')");
  await check('ReadonlyRedrawPreservesUserExpandedState', '!codeFixture.extra.querySelector("pre").classList.contains("collapsed")');
  await check('HorizontalScrollStaysInsideCodeWithoutMovingHeader', "(()=>{const pre=codeFixture.extra.querySelector('pre'),code=pre.querySelector('code');return code.scrollWidth>code.clientWidth&&pre.scrollWidth<=pre.clientWidth+1&&getComputedStyle(pre).overflowX==='hidden'})()");
  await act(`codeFixture.extra.remove();codeFixture.turn.supplements=[{id:'supplement',text:'不写文件，只输出代码',status:'applied',presentation:RelaySupplementTimeline.capture(codeFixture.output)}];
    syncRunOutputActivity(codeFixture.run,true);const O=RelayAssistantOutput;
    O.ingest(codeFixture.output,{type:'assistant',uuid:'final-frame',message:{id:'final-message',role:'assistant',stop_reason:'end_turn',content:[{type:'text',text:finalCode}]}});
    O.ingest(codeFixture.output,{type:'result',subtype:'success',result:finalCode,user_message_uuids:['code-run','supplement']});
    codeFixture.turn.assistant=O.finish(codeFixture.output,{exitCode:0,supplements:codeFixture.turn.supplements});codeFixture.turn.status='complete';
    codeFixture.run.activityState.phase='complete';syncRunOutputActivity(codeFixture.run,true);`);
  await wait("messagesEl.querySelector('.message.assistant .body pre .code-run')");
  await check('SupplementFinalAndEarlierProcessBothHaveFullChrome', "messagesEl.querySelectorAll('pre.relay-code-block').length===2&&[...messagesEl.querySelectorAll('pre')].every(pre=>pre.querySelectorAll('.code-actions').length===1&&pre.querySelector('.code-run')&&pre.querySelector('.code-toggle'))");
  await check('EarlierStageRemainsSeparateFromFinalAnswer', "messagesEl.querySelector('.conversation-narration').textContent.includes('Isolated fixture')&&!messagesEl.querySelector('.message.assistant .body').textContent.includes('Isolated fixture')&&messagesEl.querySelector('.message.assistant .body').textContent.includes('Final fixture')");
  await act('syncRunOutputActivity(codeFixture.run,true);syncRunOutputActivity(codeFixture.run,true)');
  await check('RepeatFinalRendersDoNotDuplicateControls', "messagesEl.querySelectorAll('.code-actions').length===2&&messagesEl.querySelectorAll('.code-copy').length===2");
  await act("codeFixture.turn.activity=RelayActivity.serialize(codeFixture.run.activityState);codeFixture.turn.output=RelayAssistantOutput.serialize(codeFixture.output);");
  await ev('window.api.history.save(currentConv)');
  await ev("loadConversation('code-fixture-conversation',null,{forceReload:true}).catch(error=>{codeFixture.historyError=error.stack;throw error})");
  // Restored completed processes mount their rows only when opened. Exercise
  // that user action before inspecting the earlier process's code controls.
  await wait("messagesEl.querySelector('.message.assistant .body pre .code-run')");
  await check('RestoredProcessStartsCollapsed', "!!messagesEl.querySelector('.process-summary')?.closest('.is-collapsed')");
  await act("messagesEl.querySelectorAll('.process-summary').forEach(summary=>{if(summary.closest('.is-collapsed'))summary.click()})");
  await wait("messagesEl.querySelectorAll('pre.relay-code-block').length===2");
  await check('RealHistoryRestoreEnhancesBothCodeSurfaces', "[...messagesEl.querySelectorAll('pre')].every(pre=>pre.querySelector('.code-run')&&pre.querySelector('.code-copy')&&getComputedStyle(pre,'::before').height==='28px')");
  await act("messagesEl.querySelectorAll('.process-summary').forEach(summary=>{if(summary.closest('.is-collapsed'))summary.click()});stopFollowingMessages();document.getAnimations().forEach(animation=>{if(animation.effect?.getComputedTiming().iterations!==Infinity)animation.finish()});messagesEl.querySelector('.conversation-narration pre').scrollIntoView({block:'start'})");
  await capture('process-code');
  await act("messagesEl.querySelector('.message.assistant .body pre').scrollIntoView({block:'start'})");
  await capture('final-code');
  await act("window.readonlyProbe=document.createElement('div');messagesEl.append(readonlyProbe);relayRenderReadOnlyMarkdown(readonlyProbe,'<button onclick=alert(1)>危险按钮</button>\\n\\n<script>window.codeExecuted=true</script>\\n\\n```js\\nconst value = 1;\\n```')");
  await check('SanitizerStillRejectsModelButtonsScriptsAndHandlers', "!window.codeExecuted&&!readonlyProbe.querySelector('[onclick],script')&&readonlyProbe.querySelectorAll('button').length===1&&readonlyProbe.querySelector('.code-copy')&&!readonlyProbe.querySelector('.code-run')");
  await act("const standalone=document.createElement('div');standalone.innerHTML=relayRenderMarkdown(firstCode);RelayCodeBlocks.enhance(standalone);codeFixture.standalone=standalone;messagesEl.append(standalone)");
  await check('StandaloneMiniStyleReaderHasCopyCollapseWithoutInventedRunAPI', "codeFixture.standalone.querySelector('.code-copy')&&codeFixture.standalone.querySelector('.code-toggle')&&!codeFixture.standalone.querySelector('.code-run')&&getComputedStyle(codeFixture.standalone.querySelector('pre'),'::before').height==='28px'");
  await act("const fallback=document.createElement('div');fallback.innerHTML='<pre class=md-fallback>原始文字</pre>';enhanceCodeBlocks(fallback);codeFixture.fallbackSafe=!fallback.querySelector('.code-actions')");
  await check('FallbackTextDoesNotAcquireCodeActions', 'codeFixture.fallbackSafe');
  await ev("(()=>{\n window.incrementalCodeProbe=document.createElement('div'); incrementalCodeProbe.style.width='320px'; messagesEl.append(incrementalCodeProbe);\n relayRenderReadOnlyMarkdown(incrementalCodeProbe,firstCode+'\\n\\n尾段',{incremental:true});\n window.stableCodePre=incrementalCodeProbe.querySelector('pre'); window.stableCode=stableCodePre.querySelector('code'); window.codeMetricReads=0;\n for(const name of ['scrollLeft','scrollTop']){const get=Object.getOwnPropertyDescriptor(Element.prototype,name).get;Object.defineProperty(stableCode,name,{configurable:true,get(){codeMetricReads++;return get.call(this)}});}\n relayRenderReadOnlyMarkdown(incrementalCodeProbe,firstCode+'\\n\\n尾段追加',{incremental:true});\n})()");
  await check('IncrementalTailNeverMeasuresUnchangedCodeLayout', 'codeMetricReads===0&&incrementalCodeProbe.querySelector("pre")===stableCodePre&&stableCode.isConnected');
  await ev("(()=>{\n delete stableCode.scrollLeft;delete stableCode.scrollTop;\n window.growingCodeSource=String.fromCharCode(96).repeat(3)+'js\\n'+Array.from({length:30},(_,i)=>'const line'+i+' = '+JSON.stringify('x'.repeat(200))+';').join('\\n');\n relayRenderReadOnlyMarkdown(incrementalCodeProbe,growingCodeSource,{incremental:true});incrementalCodeProbe.querySelector('.code-toggle').click();\n incrementalCodeProbe.querySelector('code').scrollLeft=42;window.growingCodeScroll=incrementalCodeProbe.querySelector('code').scrollLeft;window.growingCodePre=incrementalCodeProbe.querySelector('pre');\n relayRenderReadOnlyMarkdown(incrementalCodeProbe,growingCodeSource+'\\nconst finalValue = 2;\\n'+String.fromCharCode(96).repeat(3),{incremental:true});\n})()");
  await check('ReplacedStreamingCodeRetainsUserCollapseAndScroll', 'growingCodeScroll>0&&incrementalCodeProbe.querySelector("pre")!==growingCodePre&&incrementalCodeProbe.querySelector("pre").classList.contains("collapsed")&&incrementalCodeProbe.querySelector("code").scrollLeft===growingCodeScroll');
  await check('ReplacedStreamingCodeHasOneControlSet', 'incrementalCodeProbe.querySelectorAll(".code-actions").length===1&&incrementalCodeProbe.querySelectorAll(".code-copy").length===1&&incrementalCodeProbe.querySelector("code").textContent.includes("const finalValue = 2;")');
  await act('incrementalCodeProbe.remove()');
  await check('NoRendererErrorsModelCallsOrUnexpectedNetwork', "uiFixture.errors.length===0&&!uiFixture.calls.includes('runClaude')&&typeof require==='undefined'");
  if (network.length) throw Error('Unexpected network');
  save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => { failures.push(String(error.stack || error)); console.error(error); save(); clearTimeout(deadline);
  if (win && !win.isDestroyed()) try { console.error(await ev('JSON.stringify({fixture:codeFixture,errors:uiFixture.errors,process:messagesEl.querySelector(".conversation-narration")?.innerHTML})')); } catch (_) {}
  if (win && !win.isDestroyed()) try { await capture('failure'); } catch (_) {}
  app.exit(1);
});
