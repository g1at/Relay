'use strict';

// Run with Electron. Loads the real renderer against an isolated in-memory API.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, '.codex-tmp', 'ui-smoke');
fs.mkdirSync(dir, { recursive: true });
// A failed run must not leave a previous successful result looking current.
fs.rmSync(path.join(dir, 'result.json'), { force: true });
app.setPath('userData', path.join(dir, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const deadline = setTimeout(() => { console.error('UI check timed out'); app.exit(1); }, 55000);
let win;
const results = {};
const evaluate = source => win.webContents.executeJavaScript(source);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function check(name, source) {
  const value = await evaluate(source);
  if (!value) throw new Error(name + ' failed');
  results[name] = true;
}
async function capture(name) {
  // Hidden windows may begin finite entrance animations on their first capture.
  // Finish only those for stable evidence; the continuous shimmer stays active.
  await evaluate("document.getAnimations().forEach(animation => { if (animation.effect && animation.effect.getComputedTiming().iterations !== Infinity) { try { animation.finish(); } catch (_) {} } });");
  await win.webContents.capturePage();
  await new Promise(resolve => setTimeout(resolve, 120));
  await settle();
  fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
  if (['permission', 'question', 'question-dark'].includes(name)) {
    const bounds = await evaluate("(() => { const r = document.querySelector('.interaction-surface').getBoundingClientRect(); const x = Math.max(0, Math.floor(r.left)), y = Math.max(0, Math.floor(r.top)); return { x, y, width: Math.min(innerWidth, Math.ceil(r.right)) - x, height: Math.min(innerHeight, Math.ceil(r.bottom)) - y }; })()");
    fs.writeFileSync(path.join(dir, name + '-card.png'), (await win.webContents.capturePage(bounds)).toPNG());
  }
}
async function waitFor(source) {
  await evaluate(`new Promise((resolve, reject) => { const end = Date.now() + 4000; const tick = () => { if (${source}) return resolve(true); if (Date.now() > end) return reject(new Error('UI state timeout: ' + ${JSON.stringify(source)})); setTimeout(tick, 20); }; tick(); })`);
}
async function question() {
  await evaluate(`uiFixture.emit('interactions.onEvent', {type:'interaction.pending', interaction:{id:'ask-fixture',kind:'question',state:'pending',conversationId:currentConv && currentConv.id || 'fixture-conversation',question:{questions:[
    {question:'你希望如何查看这次调整？',header:'展示方式',options:[{label:'先看预览 (Recommended)',description:'确认界面布局和动画效果。'},{label:'直接使用',description:'在下一轮对话中体验。'}]},
    {question:'哪些部分需要保留？',header:'保留内容',multiSelect:true,options:[{label:'执行详情',description:'可随时展开查看。'},{label:'任务进度',description:'查看每个步骤的状态。'}]}
  ]}}});`);
  await waitFor("!!document.querySelector('.interaction-question-form')");
}
async function permission(id, canAllowForSession = true, fromOther = false) {
  await evaluate(`uiFixture.emit('interactions.onEvent', {type:'interaction.pending', interaction:{id:${JSON.stringify(id)},kind:'permission',state:'pending',conversationId:${fromOther ? "'fixture-other-conversation'" : "currentConv && currentConv.id || 'fixture-conversation'"},toolName:'Bash',permission:{description:'运行本地界面检查，验证布局和交互。',decisionReason:'检查本次界面调整',input:{command:'npm run test:ui',description:'运行界面检查'},canAllowForSession:${canAllowForSession}}}});`);
  await waitFor(fromOther ? "interactionSurfaceMount.hidden" : "!!document.querySelector('.interaction-permission-card')");
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixtureScript = fs.readFileSync(path.join(__dirname, 'ui-api-fixture.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixtureScript + '</script>');
  const page = path.join(dir, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1120, height: 920, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page);
  await waitFor("typeof currentModel !== 'undefined' && providerRoutingLoaded && !restoringActiveRuns");
  await check('fullRendererBoots', 'uiFixture.errors.length === 0');
  await check('windowTitlebarHasOnlySidebarToggle', "document.querySelectorAll('main [data-toggle-sidebar]').length === 0 && document.querySelectorAll('#windowChrome [data-toggle-sidebar]').length === 1 && !!document.getElementById('btnNewChat') && !!document.getElementById('btnNewAnalysis')");
  await check('modelButtonBesideSend', "document.getElementById('modelSwitch').nextElementSibling === sendBtn && document.getElementById('modelSwitch').parentElement.classList.contains('ib-right')");
  await evaluate("if (relaySidebarLayout.getState().expanded) relaySidebarLayout.toggle(); inputEl.value = '请调整对话界面，并验证模型名称和交互卡片。'; document.getElementById('btnSend').click();");
  await waitFor('uiFixture.runId');
  await evaluate(`uiFixture.emit('onEvent', {jobId:uiFixture.runId,type:'assistant',uuid:'progress-one',message:{id:'progress-one',content:[{type:'text',text:'我会先核对当前配置，再调整对话和选择界面。'}]}});
    uiFixture.emit('onEvent', {jobId:uiFixture.runId,type:'assistant',uuid:'read-call',message:{id:'read-call',content:[{type:'tool_use',id:'read-fixture',name:'Read',input:{file_path:'renderer/app.js'}}]}});
    uiFixture.emit('onEvent', {jobId:uiFixture.runId,type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-fixture',content:'synthetic local source'}]}});
    uiFixture.emit('onEvent', {jobId:uiFixture.runId,type:'stream_event',event:{type:'message_start',message:{id:'progress-two'}}});
    uiFixture.emit('onEvent', {jobId:uiFixture.runId,type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'模型名称已核对。接下来会检查权限审批与请求选择，让整个过程更清楚。'}}});`);
  // Until job-done confirms the answer, all streamed prose stays interleaved
  // with tools in the process instead of flashing as a provisional final reply.
  await waitFor("[...document.querySelectorAll('.conversation-stream .conversation-narration')].some(row => row.textContent.includes('模型名称已核对'))");
  await capture('conversation-running');
  await check('streamingProseIsVisibleInOrder', "(() => { const rows = [...document.querySelectorAll('.conversation-stream .process-items > .process-item')]; const a = rows.findIndex(e => e.textContent.includes('我会先核对')); const b = rows.findIndex(e => e.textContent.includes('app.js')); const c = rows.findIndex(e => e.textContent.includes('模型名称已核对')); return a >= 0 && b > a && c > b && rows[c].getBoundingClientRect().height > 0 && rows[c].getBoundingClientRect().top >= rows[b].getBoundingClientRect().bottom && !document.querySelector('.conversation-stream').classList.contains('is-collapsed') && ![...document.querySelectorAll('.message.assistant .body')].some(row => row.textContent.includes('模型名称已核对')); })()");
  await evaluate(`uiFixture.emit('onEvent', {jobId:uiFixture.runId,type:'assistant',uuid:'thinking-fixture',message:{id:'thinking-fixture',content:[{type:'thinking',thinking:'fixture-private-thinking-only-in-details'}]}});
    uiFixture.emit('onEvent', {jobId:uiFixture.runId,type:'assistant',uuid:'protocol-fixture',message:{id:'protocol-fixture',content:[{type:'text',text:'<tool_call><function=Read><parameter=file_path>example.txt</parameter></function></tool_call>'}]}});`);
  await check('thinkingAndProtocolStayOutOfVisibleProse', "![...document.querySelectorAll('.conversation-narration')].some(el => /fixture-private-thinking|<tool_call>/.test(el.textContent)) && !document.querySelector('tool_call, parameter')");
  await question(); await capture('question');
  await check('noDecisionWithoutUserInput', 'uiFixture.decisions.length === 0');
  await check('questionIsTheCardTitleWithTopPagerAndExplicitClose', "interactionSurfaceTitle.textContent==='你希望如何查看这次调整？'&&document.querySelector('.interaction-question-position').textContent==='1 / 2'&&!document.querySelector('.interaction-close').hidden&&document.querySelector('.interaction-question-back').disabled");
  await check('questionOptionsUseCircularNumbersAndPreserveRecommendedLabels', "(()=>{const number=document.querySelector('.interaction-option-number'),style=getComputedStyle(number),option=document.querySelector('input[data-option]');return parseFloat(style.borderRadius)>=number.clientWidth/2&&document.querySelector('.interaction-recommended').textContent==='推荐'&&document.querySelector('.interaction-option-label').textContent==='先看预览'&&option.value==='先看预览 (Recommended)'&&!option.checked&&!!document.querySelector('.interaction-other-mark svg')})()");
  await check('decisionSurfaceUsesLightBordersWithoutHeavyShadow', "getComputedStyle(document.querySelector('.interaction-surface')).boxShadow==='none'&&parseFloat(getComputedStyle(document.querySelector('.interaction-surface')).borderRadius)>=18");
  await check('questionCardIsCompactWithoutCompressingReadableControls', "(()=>{const card=document.querySelector('.interaction-surface').getBoundingClientRect(),number=document.querySelector('.interaction-option-number').getBoundingClientRect(),action=document.querySelector('.interaction-button-primary').getBoundingClientRect();return Math.abs(card.width-inputCard.getBoundingClientRect().width)<1&&card.height<=252&&number.width>=24&&number.width<=26&&action.height>=28&&action.height<=32&&parseFloat(getComputedStyle(document.querySelector('.interaction-option-label')).fontSize)>=12&&action.right<card.right&&action.bottom<card.bottom})()");
  await evaluate("document.querySelector('.interaction-question-form').requestSubmit();");
  await check('unansweredQuestionIsBlocked', "uiFixture.decisions.length === 0 && !!document.querySelector('.interaction-field-error:not([hidden])')");
  await evaluate("document.querySelector('.interaction-question:not([hidden]) input[data-option]').click(); document.querySelector('.interaction-question-next').click();");
  await waitFor("document.querySelectorAll('.interaction-question')[1].hidden === false");
  await evaluate("document.querySelector('.interaction-question-back').click();");
  await check('questionDraftSurvivesBack', "document.querySelector('.interaction-question:not([hidden]) input[data-option]').checked");
  await evaluate("document.querySelector('.interaction-question-form').requestSubmit();");
  await evaluate("const longAnswer = document.querySelector('.interaction-question:not([hidden]) .interaction-other-input'); longAnswer.value = Array.from({length:12}, (_,i) => '补充说明 ' + i).join(String.fromCharCode(10)); longAnswer.dispatchEvent(new Event('input',{bubbles:true}));");
  await check('freeAnswerGrowsWithinLimitWithoutResizeHandle', "(()=>{const input=document.querySelector('.interaction-question:not([hidden]) .interaction-other-input');return input.clientHeight===100&&input.scrollHeight>input.clientHeight&&getComputedStyle(input).overflowY==='auto'&&getComputedStyle(input).resize==='none'})()");
  await evaluate("document.querySelector('.interaction-question-back').click(); document.querySelector('.interaction-question-next').click();");
  await settle();
  await check('freeAnswerRestoresHeightAfterPaging', "(()=>{const input=document.querySelector('.interaction-question:not([hidden]) .interaction-other-input');return input.value.includes('补充说明 11')&&input.clientHeight===100})()");
  await evaluate("const shortAnswer = document.querySelector('.interaction-question:not([hidden]) .interaction-other-input'); shortAnswer.value = '历史回复'; shortAnswer.dispatchEvent(new Event('input',{bubbles:true}));");
  await check('freeAnswerShrinksWhenTextIsRemoved', "(()=>{const input=document.querySelector('.interaction-question:not([hidden]) .interaction-other-input');return input.clientHeight>=29&&input.clientHeight<40&&getComputedStyle(input).overflowY==='hidden'})()");
  await evaluate("document.querySelector('.interaction-question:not([hidden]) input[data-option]').click(); const other = document.querySelector('.interaction-question:not([hidden]) .interaction-other-input'); other.value = '历史回复'; other.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('.interaction-question-form').requestSubmit();");
  await waitFor('uiFixture.decisions.length === 1');
  await check('questionAnswersPreserveShape', "uiFixture.decisions[0].action === 'submit' && uiFixture.decisions[0].answers['你希望如何查看这次调整？'] === '先看预览 (Recommended)' && JSON.stringify(uiFixture.decisions[0].answers['哪些部分需要保留？']) === JSON.stringify(['执行详情','历史回复'])");
  await waitFor("document.getElementById('interactionSurfaceMount').hidden");
  await permission('permission-once'); await capture('permission');
  await check('permissionCardUsesLessSpaceAndKeepsBothDecisionButtonsVisible', "(()=>{const card=document.querySelector('.interaction-surface').getBoundingClientRect(),deny=document.querySelector('[data-action=deny]').getBoundingClientRect(),allow=document.querySelector('[data-action=allow_once]').getBoundingClientRect();return Math.abs(card.width-inputCard.getBoundingClientRect().width)<1&&card.height<=355&&deny.height>=28&&allow.height<=32&&deny.right<allow.left&&deny.top>=card.top&&allow.bottom<card.bottom&&card.bottom<=inputCard.getBoundingClientRect().top})()");
  const permissionChrome = await evaluate("(()=>{const session=document.querySelector('.interaction-allow-menu [data-action=allow_session]');return {category:document.querySelector('.interaction-eyebrow').textContent,denyHint:document.querySelector('[data-action=deny] kbd').textContent,allowLabel:document.querySelector('[data-action=allow_once]').textContent,menuOpen:document.querySelector('.interaction-allow-menu').matches(':popover-open'),sessionRects:session.getClientRects().length,sessionVisible:session.checkVisibility(),sessionDisplay:getComputedStyle(session).display}})()");
  fs.writeFileSync(path.join(dir, 'permission-chrome.json'), JSON.stringify(permissionChrome, null, 2));
  await check('permissionUsesSplitAllowButtonWithoutMoreOrStopActions', "document.querySelector('.interaction-eyebrow').textContent==='终端'&&document.querySelector('[data-action=deny] kbd').textContent==='Esc'&&document.querySelector('[data-action=allow_once]').textContent.includes('允许一次')&&!document.querySelector('.interaction-permission-more,.interaction-button-stop')&&!document.querySelector('.interaction-allow-menu').matches(':popover-open')&&!document.querySelector('.interaction-allow-menu [data-action=allow_session]').checkVisibility()");
  await check('sameConversationNeedsNoSourceWarning', "document.querySelector('.interaction-source').hidden");
  await check('pendingApprovalAllowsChangingThisConversationsPermission', "!document.querySelector('#btnPermissionMode').disabled");
  await evaluate("uiFixture.holdDecision = true; document.querySelector('.interaction-permission-actions .interaction-button-primary').click();");
  await check('permissionWaitsAndPreventsDoubleSubmit', "uiFixture.decisions.at(-1).action === 'allow_once' && document.querySelector('.interaction-permission-actions .interaction-button-primary').disabled");
  await evaluate('uiFixture.holdDecision = false; uiFixture.resolveDecision();');
  await waitFor("document.getElementById('interactionSurfaceMount').hidden");
  await permission('permission-session');
  await evaluate("document.querySelector('.interaction-allow-menu-toggle').click();");
  await check('splitDropdownExposesOnlyExplicitAllowScopes', "document.querySelector('.interaction-allow-menu').matches(':popover-open')&&document.querySelector('.interaction-allow-menu [data-action=allow_session]').checkVisibility()&&document.querySelectorAll('.interaction-allow-menu [role=menuitem]').length===2&&!document.querySelector('.interaction-button-stop')");
  await evaluate("document.querySelector('.interaction-allow-menu [data-action=allow_session]').click();");
  await waitFor("document.getElementById('interactionSurfaceMount').hidden");
  await check('sessionScopePreserved', "uiFixture.decisions.at(-1).action === 'allow_session'");
  await permission('permission-deny', false);
  await check('noSessionChoiceWithoutCapability', "!document.querySelector('.interaction-allow-menu-toggle')");
  await evaluate("uiFixture.failNextDecision = true; document.querySelector('.interaction-permission-actions .interaction-button-quiet').click();");
  await waitFor("document.querySelector('.interaction-live-status').textContent.includes('失败')");
  await check('decisionFailureAllowsRetry', "!document.querySelector('.interaction-permission-actions .interaction-button-quiet').disabled");
  await evaluate("document.querySelector('.interaction-permission-actions .interaction-button-quiet').click();");
  await waitFor("document.getElementById('interactionSurfaceMount').hidden");
  await check('denialDoesNotBecomeApproval', "uiFixture.decisions.at(-1).action === 'deny' && !uiFixture.decisions.at(-1).interrupt");
  await permission('permission-menu-keyboard');
  await evaluate("document.querySelector('.interaction-allow-menu-toggle').click();");
  await capture('permission-menu');
  await check('allowMenuIsTopLayerAndFitsAboveComposer', "(()=>{const menu=document.querySelector('.interaction-allow-menu'),r=menu.getBoundingClientRect();return menu.matches(':popover-open')&&r.width<=180&&r.right<=innerWidth&&r.bottom<document.querySelector('[data-action=allow_once]').getBoundingClientRect().top&&document.activeElement.dataset.action==='allow_once'})()");
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));");
  await check('escapeClosesAllowMenuWithoutMakingAPermissionDecision', "!document.querySelector('.interaction-allow-menu').matches(':popover-open')&&!uiFixture.decisions.some(item=>item.id==='permission-menu-keyboard')&&document.activeElement.classList.contains('interaction-allow-menu-toggle')");
  await evaluate("interactionSurfaceTitle.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));");
  await waitFor("document.getElementById('interactionSurfaceMount').hidden");
  await permission('permission-keyboard', false);
  await evaluate("interactionSurfaceTitle.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));");
  await check('imeEnterCannotApprovePermissions', "!uiFixture.decisions.some(item=>item.id==='permission-keyboard')&&document.querySelector('.interaction-permission-card')!==null");
  await evaluate("interactionSurfaceTitle.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));");
  await waitFor("document.getElementById('interactionSurfaceMount').hidden");
  await check('permissionEscapeExplicitlyDeniesWithoutInterrupt', "uiFixture.decisions.at(-1).action==='deny'&&!uiFixture.decisions.at(-1).interrupt");
  await permission('permission-enter', false);
  await evaluate("interactionSurfaceTitle.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));");
  await waitFor("document.getElementById('interactionSurfaceMount').hidden");
  await check('permissionEnterApprovesOnlyOnce', "uiFixture.decisions.at(-1).action==='allow_once'");
  await permission('permission-other-source', false, true);
  await check('otherConversationsPermissionIsHiddenAndCannotBeAnswered', "interactionSurfaceMount.hidden&&!uiFixture.decisions.some(item=>item.id==='permission-other-source')");
  await check('anotherConversationsApprovalDoesNotLockThisPermissionSelector', "!document.querySelector('#btnPermissionMode').disabled");
  await evaluate("uiFixture.emit('interactions.onEvent',{type:'interaction.resolved',interaction:{id:'permission-other-source',kind:'permission',state:'resolved'}})");
  await question();
  await evaluate("document.querySelector('.interaction-question:not([hidden]) input[data-option]').click();document.querySelector('.interaction-close').click();");
  await waitFor("document.getElementById('interactionSurfaceMount').hidden");
  await check('questionCloseSkipsWithoutSendingPartialAnswers', "uiFixture.decisions.at(-1).action==='deny'&&!uiFixture.decisions.at(-1).answers");
  await evaluate(`const final = {type:'result',subtype:'success',is_error:false,result:'界面调整已完成。模型名称与配置一致，审批和请求选择也已验证。'};
    uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'assistant',uuid:'final-fixture',message:{id:'final-fixture',content:[{type:'text',text:final.result}]}});
    uiFixture.emit('onEvent',{jobId:uiFixture.runId,...final});
    uiFixture.emit('onEvent',{jobId:uiFixture.runId,type:'job-done',exitCode:0,finalResult:final});`);
  await waitFor('!isRunning');
  await capture('conversation-complete');
  await check('completionCollapsesProcessAndKeepsOneFinal', "document.querySelector('.conversation-stream').classList.contains('is-collapsed') && [...document.querySelectorAll('.message.assistant .body')].filter(e=>e.textContent.includes('界面调整已完成')).length === 1 && ![...document.querySelectorAll('.conversation-narration')].some(e=>e.textContent.includes('界面调整已完成'))");
  await evaluate("modelPopupHomePage = 'model'; document.getElementById('btnModelSwitch').click();");
  await check('compactTierKeepsConfiguredModelInMenu', "(() => { const expected = ['mimo-v2.5-pro[1m]', 'mimo-x-flash-preview', 'mimo-x-pro-preview']; return [...modelPopup.querySelectorAll('.mp-row')].every((row,i) => row.querySelector('.mp-desc').textContent === expected[i] && row.title === expected[i]) && msLabel.textContent === '专家' && btnModelSwitch.title.includes(expected[2]); })()");
  await capture('models');
  await check('modelMenuActuallyVisible', "modelPopup.classList.contains('show') && getComputedStyle(modelPopup).opacity === '1' && modelPopup.getBoundingClientRect().height > 100");
  await evaluate("hideModelPopup(); currentEffort = 'max'; modelPopupHomePage = 'advanced'; showModelPopup();");
  await capture('reasoning');
  await check('reasoningShimmerIsAnimated', "getComputedStyle(modelPopup.querySelector('.model-effort-shimmer')).animationName === 'relay-model-shimmer'");
  await check('reasoningSliderDescribesSelection', "(() => { const range = modelPopup.querySelector('input[type=range]'); return !!range && range.getAttribute('aria-valuetext') === '最大'; })()");
  await check('reasoningMaxUsesPurpleOverlay', "getComputedStyle(modelPopup.querySelector('.model-effort-fill'), '::before').opacity === '1'");
  await evaluate("const animationRange = modelPopup.querySelector('.model-effort-range'); animationRange.value = '0'; animationRange.dispatchEvent(new Event('input',{bubbles:true}));");
  await capture('reasoning-low');
  await check('reasoningLowerLevelsUseBlue', "getComputedStyle(modelPopup.querySelector('.model-effort-fill'), '::before').opacity === '0' && modelPopup.querySelector('.model-menu-page').dataset.effort === 'low'");
  await check('thumbAndFillAnimateTogether', `new Promise(resolve => {
    const range = modelPopup.querySelector('.model-effort-range');
    const thumb = modelPopup.querySelector('.model-effort-thumb');
    const fill = modelPopup.querySelector('.model-effort-fill');
    const start = thumb.getBoundingClientRect().left;
    range.value = range.max; range.dispatchEvent(new Event('input',{bubbles:true}));
    getComputedStyle(thumb).left;
    requestAnimationFrame(() => {
      const thumbAnimation = thumb.getAnimations().find(a => a.transitionProperty === 'left');
      const fillAnimation = fill.getAnimations().find(a => a.transitionProperty === 'width');
      if (!thumbAnimation || !fillAnimation) return resolve(false);
      [thumbAnimation,fillAnimation].forEach(a => { a.pause(); a.currentTime = a.effect.getComputedTiming().duration / 2; });
      const middle = thumb.getBoundingClientRect();
      const aligned = Math.abs(middle.left + middle.width/2 - fill.getBoundingClientRect().right) < 3;
      [thumbAnimation,fillAnimation].forEach(a => a.finish());
      const end = thumb.getBoundingClientRect().left;
      resolve(aligned && middle.left > start + 1 && middle.left < end - 1);
    });
  })`);
  await capture('reasoning');
  await evaluate("modelPopup.querySelector('input[type=range]').focus();");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Left'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Left'});
  await settle();
  await check('reasoningSliderAcceptsKeyboard', "modelPopup.querySelector('input[type=range]').getAttribute('aria-valuetext') !== '最大'");
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await check('reducedMotionDisablesShimmer', "matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(modelPopup.querySelector('.model-effort-shimmer')).animationName === 'none'");
  await check('reducedMotionDisablesSliderTransitions', "getComputedStyle(modelPopup.querySelector('.model-effort-thumb')).transitionDuration === '0s' && getComputedStyle(modelPopup.querySelector('.model-effort-fill'), '::before').transitionDuration === '0s'");
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[]});
  win.webContents.debugger.detach();
  win.setSize(520, 900); await settle(); await evaluate('hideModelPopup(); showModelPopup();');
  await evaluate("contextUsageEl.classList.remove('hidden'); contextUsageLabel.textContent = '82%';");
  await capture('reasoning-narrow');
  await check('reasoningMenuActuallyVisible', "modelPopup.classList.contains('show') && getComputedStyle(modelPopup).opacity === '1' && modelPopup.getBoundingClientRect().height > 80");
  await check('menuFitsNarrowViewport', "(() => { const r = modelPopup.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()");
  await check('composerControlsFitAndDoNotOverlap', "(() => { const card = inputCard.getBoundingClientRect(), model = btnModelSwitch.getBoundingClientRect(), send = sendBtn.getBoundingClientRect(), left = inputCard.querySelector('.ib-left').getBoundingClientRect(), right = inputCard.querySelector('.ib-right').getBoundingClientRect(); return left.right <= right.left && model.right <= send.left && send.right <= card.right && send.width >= 28 && model.width >= 80; })()");
  await evaluate('hideModelPopup();');
  await question(); await capture('question-narrow');
  await check('questionFitsNarrowViewport', "(() => { const r = document.querySelector('.interaction-surface').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()");
  await check('narrowQuestionStillFitsAnswerAndContinueOnOneRow', "(()=>{const card=document.querySelector('.interaction-surface'),field=document.querySelector('.interaction-question:not([hidden]) .interaction-other-input').getBoundingClientRect(),action=document.querySelector('.interaction-question-actions').getBoundingClientRect();return card.scrollWidth<=card.clientWidth&&field.width>=100&&field.right<=action.left&&action.right<card.getBoundingClientRect().right&&action.bottom<card.getBoundingClientRect().bottom})()");
  await evaluate("document.documentElement.setAttribute('data-theme','dark');"); await capture('question-dark');
  await check('darkFreeAnswerKeepsTheSharedCardSurface', "getComputedStyle(document.querySelector('.interaction-other-input')).backgroundColor==='rgba(0, 0, 0, 0)'");
  await check('darkPrimaryButtonHasReadableContrast', `(() => {
    const style = getComputedStyle(document.querySelector('.interaction-button-primary'));
    const luminance = color => { const values = color.match(/[\\d.]+/g).slice(0,3).map(Number).map(value => color.startsWith('color(') ? value : value/255).map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4); return values[0]*.2126 + values[1]*.7152 + values[2]*.0722; };
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a,b)+.05)/(Math.min(a,b)+.05) >= 4.5;
  })()`);
  await check('noRendererErrors', 'uiFixture.errors.length === 0');
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results)); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  console.error(error.stack || error);
  if (win && !win.isDestroyed()) { console.error(await evaluate('JSON.stringify(uiFixture.errors)')); await capture('failure'); }
  clearTimeout(deadline); app.exit(1);
});
