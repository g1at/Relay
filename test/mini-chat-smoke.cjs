'use strict';

// Real isolated renderer with synthetic session/interaction APIs. No model,
// personal history, global shortcut, clipboard, or application main process.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'mini-chat-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const checks = {}, failures = [], rendererErrors = [], visualSamples = {};
let win, step = 'starting';
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, rendererErrors, visualSamples, step }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function frames() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); }
async function settle() {
  await frames();
  if (await evaluate('!!document.getElementById("miniCard")')) {
    const height = await evaluate('window.miniFixture.resizeHeight || 246');
    const size = win.getContentSize();
    if (size[1] !== height) win.setContentSize(size[0], height);
  }
  await frames();
  await evaluate('document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}})');
}
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)};tick()})`);
}
async function check(name, code) {
  step = name;
  checks[name] = !!await evaluate(code); save(); console.log(name);
  if (!checks[name]) throw Error(name);
}
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); }
async function input(text) { await act(`miniInput.value=${JSON.stringify(text)};miniInput.dispatchEvent(new Event('input',{bubbles:true}));`); await settle(); }
async function screenshot(name) {
  if (await evaluate('!!document.getElementById("miniCard")')) await settle();
  else await frames();
  await win.webContents.capturePage(); await delay(75);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

function fixture() {
  const callbacks = new Set(), focusCallbacks = new Set(), interactions = new Set(), providerCallbacks = new Set(), permissionCallbacks = new Set();
  const clone = value => JSON.parse(JSON.stringify(value));
  const f = window.miniFixture = {
    snapshot: { conversation: null, model: 'haiku', running: false, pinned: true, brand: { name: 'Relay', logo: null, theme: 'light' } },
    calls: [], responses: [], requests: [], resizeHeight: 246, maxResizeHeight: 600, resizeCalls: [], hidden: 0, pauses: 0, opens: 0,
    copied: '', error: null, nextConversation: 1, holdSubmitReceipt: false, releaseSubmit: null,
    providerMode: 'normal', pendingProviderLists: [],
    permissionDefaults: { permissionMode: 'default', executionMode: { kind: 'default' }, revision: 1 },
    conversationPermissions: {}, permissionError: null, permissionWrites: [],
    routing: { defaultModel: 'haiku', chatRoutes: [
      { tier: 'haiku', configured: true, available: true, modelId: 'gateway/fast-model' },
      { tier: 'sonnet', configured: false, available: false, modelId: '' },
      { tier: 'opus', configured: true, available: true, modelId: 'gateway/expert-model' },
    ] },
    emit() { for (const callback of callbacks) callback(clone(this.snapshot)); },
    emitProviders() { for (const callback of providerCallbacks) callback({ routes: clone(this.routing) }); },
    emitPermissions(id = null) { for (const callback of permissionCallbacks) callback({ conversationId: id }); },
    update(text) { const turns = this.snapshot.conversation.turns; turns[turns.length - 1].preview = text; this.emit(); },
    finish(text) { const turn = this.snapshot.conversation.turns.at(-1); turn.assistant = text; turn.preview = ''; turn.status = 'complete'; this.snapshot.running = false; this.emit(); },
    focus() { for (const callback of focusCallbacks) callback(); },
    interaction(item) { this.requests.push(item); for (const callback of interactions) callback({ type: 'interaction.pending', interaction: item }); },
  };
  function submitReceipt(value) {
    if (!f.holdSubmitReceipt) return value;
    f.holdSubmitReceipt = false;
    return new Promise(resolve => { f.releaseSubmit = error => {
      f.releaseSubmit = null; resolve(error ? { ok: false, error } : value);
    }; });
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { f.copied = text; } } });
  window.api = {
    openExternal: async href => { f.calls.push({ kind: 'external', href }); },
    permissions: {
      get: async id => ({ ok: true, conversationId: id || null, ...clone(id ? f.conversationPermissions[id] : f.permissionDefaults) }),
      set: async value => {
        f.permissionWrites.push(clone(value));
        if (f.permissionError) return { ok: false, error: f.permissionError };
        const id = value.conversationId || null;
        const current = id ? f.conversationPermissions[id] : f.permissionDefaults;
        const next = { ...current, permissionMode: value.permissionMode, revision: current.revision + 1 };
        if (id) f.conversationPermissions[id] = next; else f.permissionDefaults = next;
        f.emitPermissions(id);
        return { ok: true, conversationId: id, ...clone(next) };
      },
      onChanged(callback) { permissionCallbacks.add(callback); return () => permissionCallbacks.delete(callback); },
    },
    providers: {
      list: async () => {
        if (f.providerMode === 'error') throw Error('Synthetic route failure');
        const result = { ok: true, routes: clone(f.routing) };
        if (f.providerMode === 'hold') return new Promise(resolve => f.pendingProviderLists.push(() => resolve(result)));
        return result;
      },
      onChanged(callback) { providerCallbacks.add(callback); return () => providerCallbacks.delete(callback); },
    },
    mini: {
      brand: async () => clone(f.snapshot.brand), state: async () => clone(f.snapshot),
      onState(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
      onFocus(callback) { focusCallbacks.add(callback); return () => focusCallbacks.delete(callback); },
      submit: async value => {
        f.calls.push({ kind: 'submit', ...value });
        if (f.error) return { ok: false, error: f.error };
        if (f.snapshot.running) {
          const turn = f.snapshot.conversation.turns.at(-1);
          const input = { id: 'supplement-' + f.calls.length, text: value.text, status: 'applied' };
          (turn.supplements || (turn.supplements = [])).push(input); f.emit(); return submitReceipt({ ok: true, input, conversationId: f.snapshot.conversation.id });
        }
        if (!f.snapshot.conversation) {
          f.snapshot.conversation = { id: 'mini-conv-' + f.nextConversation++, model: value.model, turns: [] };
          f.conversationPermissions[f.snapshot.conversation.id] = { ...clone(f.permissionDefaults),
            permissionMode: value.permissionMode || f.permissionDefaults.permissionMode,
            executionMode: value.executionMode || clone(f.permissionDefaults.executionMode) };
        }
        f.snapshot.conversation.model = value.model;
        f.snapshot.conversation.turns.push({ user: value.text, assistant: '', preview: '', status: 'running', activityLabel: '正在思考' });
        f.snapshot.running = true; f.emit(); return submitReceipt({ ok: true, conversationId: f.snapshot.conversation.id });
      },
      pause: async () => {
        f.pauses++;
        if (f.error) return { ok: false, error: f.error };
        f.snapshot.running = false; f.snapshot.conversation.turns.at(-1).status = 'paused'; f.emit(); return { ok: true };
      },
      newChat: async () => { f.snapshot.conversation = null; f.snapshot.model = f.routing.defaultModel; f.emit(); return { ok: true }; },
      hide: async () => { f.hidden++; return { ok: true }; },
      openMain: async () => { f.opens++; return { ok: true }; },
      setPinned: async pinned => { f.snapshot.pinned = pinned; f.emit(); return { ok: true }; },
      resize: async value => { f.resizeHeight = Math.max(246, Math.min(f.maxResizeHeight, Math.round(value.height))); f.resizeCalls.push(value); return { ok: true }; },
      orbDrag: async value => { f.calls.push({ kind: 'orbDrag', ...value }); },
      toggle: async () => { f.calls.push({ kind: 'toggle' }); },
      orbMenu: async () => { f.calls.push({ kind: 'orbMenu' }); },
    },
    interactions: {
      list: async () => ({ items: clone(f.requests) }),
      onEvent(callback) { interactions.add(callback); return () => interactions.delete(callback); },
      respond: async (id, decision) => {
        f.responses.push({ id, decision });
        const item = f.requests.find(value => value.id === id);
        if (item) item.state = 'resolved';
        for (const callback of interactions) callback({ type: 'interaction.resolved', interaction: { ...item, id, state: 'resolved' } });
        return { ok: true };
      },
    },
  };
  window.addEventListener('error', event => console.error('mini-fixture-error:' + event.message));
  window.addEventListener('unhandledrejection', event => console.error('mini-fixture-error:' + String(event.reason)));
}
async function loadRenderer(name, size = [460, 246]) {
  const base = pathToFileURL(path.join(root, 'renderer') + path.sep).href;
  const html = fs.readFileSync(path.join(root, 'renderer', name), 'utf8').replace('<head>', '<head><base href="' + base + '"><script>(' + fixture.toString() + ')();</script>');
  const file = path.join(output, name); fs.writeFileSync(file, html);
  const next = new BrowserWindow({ width: size[0], height: size[1], useContentSize: true, frame: false, transparent: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  next.webContents.on('console-message', (_event, level, message) => { if (typeof message === 'string' && message.includes('mini-fixture-error:')) rendererErrors.push(message); });
  await next.loadFile(file); next.showInactive(); return next;
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  win = await loadRenderer('mini.html');
  await waitFor("document.getElementById('miniModelLabel').textContent==='快速'"); await settle();
  await check('idleReservesComfortableComposerAndMenuSpace', "innerWidth===460&&miniFixture.resizeHeight===246&&Math.abs(miniCard.getBoundingClientRect().height-214)<=1&&miniTranscript.hidden&&miniSend.disabled&&miniModelLabel.textContent==='快速'&&miniInput.getBoundingClientRect().height>=42&&miniSend.getBoundingClientRect().bottom<innerHeight-18");
  await check('headerSupportsDragAndControlsRemainInteractive', "getComputedStyle(document.querySelector('.mini-head')).webkitAppRegion==='drag'&&getComputedStyle(miniSend).webkitAppRegion==='no-drag'&&miniPin.getAttribute('aria-pressed')==='true'");
  const mainHtml = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const mainNewButton = mainHtml.match(/<button\b[^>]*id="btnNewChat"[^>]*>[\s\S]*?<\/button>/)?.[0];
  if (!mainNewButton) throw Error('Main new-chat reference button not found');
  await check('newChatIconUsesTheMainWindowConversationGlyph', `(()=>{const reference=new DOMParser().parseFromString(${JSON.stringify(mainNewButton)},'text/html').querySelector('svg');const actual=miniNew.querySelector('svg');const shape=svg=>[...svg.children].map(node=>[node.tagName.toLowerCase(),[...node.attributes].map(a=>[a.name,a.value]).sort()]);return actual.getAttribute('viewBox')===reference.getAttribute('viewBox')&&JSON.stringify(shape(actual))===JSON.stringify(shape(reference))})()`);
  await screenshot('mini-idle-light');
  await waitFor("miniPermissionMode.dataset.permissionMode==='default'&&!miniPermissionMode.disabled");
  await check('miniPermissionTriggerFitsBesideModelWithoutGrowingTheWindow', "miniPermissionMode.textContent==='请求批准'&&miniPermissionMode.getBoundingClientRect().right<miniModelButton.getBoundingClientRect().left&&innerWidth===460&&innerHeight===246");
  await check('miniPermissionTriggerUsesTheSameTransparentRestingStyleAsModel', "(()=>{const permission=getComputedStyle(miniPermissionMode),model=getComputedStyle(miniModelButton);return permission.backgroundColor==='rgba(0, 0, 0, 0)'&&permission.boxShadow==='none'&&permission.borderRadius===model.borderRadius})()");
  await click('#miniPermissionMode');
  await waitFor("!!document.querySelector('.rpc-popover.is-open')");
  await check('miniPermissionMenuUsesTheSharedThreeModesAndFitsCompactViewport', "(()=>{const card=document.querySelector('.rpc-popover'),r=card.getBoundingClientRect();return [...card.querySelectorAll('.rpc-option-label')].map(x=>x.textContent).join(',')==='请求批准,帮我批准,完全访问权限'&&Math.abs(r.width-244)<=1&&r.height<=140&&card.scrollHeight<=card.clientHeight+1&&[...card.querySelectorAll('.rpc-option-description')].every(x=>x.getBoundingClientRect().bottom<r.bottom)&&r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth&&innerHeight===246&&miniFixture.resizeHeight===246})()");
  await act('miniFixture.permissionOpenBackground=getComputedStyle(miniPermissionMode).backgroundColor;');
  await screenshot('mini-permission-menu');
  await click('[data-permission-option=acceptEdits]');
  await waitFor("miniPermissionMode.dataset.permissionMode==='acceptEdits'&&!document.querySelector('.rpc-popover')");
  await check('miniDraftPermissionChangeCreatesNoHistory', "miniFixture.snapshot.conversation===null&&miniFixture.permissionDefaults.permissionMode==='acceptEdits'&&miniFixture.nextConversation===1");
  await act("miniFixture.permissionDefaults={permissionMode:'bypassPermissions',executionMode:{kind:'default'},revision:10};miniFixture.emitPermissions();"); await settle();
  await check('anotherWindowsDefaultChangeDoesNotOverwriteTheVisibleMiniDraft', "miniPermissionMode.dataset.permissionMode==='acceptEdits'");
  await click('#miniPermissionMode');
  await act("miniFixture.permissionError='模拟权限更新失败';");
  await click('[data-permission-option=bypassPermissions]');
  await waitFor("!document.querySelector('.rpc-popover').getAttribute('aria-busy')||document.querySelector('.rpc-popover').getAttribute('aria-busy')==='false'");
  await check('miniFailedPermissionChangeRetainsActualSelection', "miniPermissionMode.dataset.permissionMode==='acceptEdits'&&miniError.textContent==='模拟权限更新失败'&&document.querySelector('[data-permission-option=acceptEdits]').getAttribute('aria-checked')==='true'");
  await act('miniFixture.permissionError=null;');
  await click('[data-permission-option=default]');
  await waitFor("miniPermissionMode.dataset.permissionMode==='default'&&!document.querySelector('.rpc-popover')"); await settle();
  await act("miniFixture.menuBaseline={height:innerHeight,requested:miniFixture.resizeHeight,calls:miniFixture.resizeCalls.length,composerBottom:miniForm.getBoundingClientRect().bottom};");
  await click('#miniModelButton');
  await check('miniPermissionAndModelUseTheSameOpenBackground', "miniFixture.permissionOpenBackground===getComputedStyle(miniModelButton).backgroundColor&&miniFixture.permissionOpenBackground!=='rgba(0, 0, 0, 0)'");
  await check('modelMenuFitsInsideCompactNativeWindow', "(()=>{const r=miniModelMenu.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&miniModelButton.getAttribute('aria-expanded')==='true'})()");
  await check('openingModelMenuDoesNotGrowOrMoveTheComposer', "innerHeight===miniFixture.menuBaseline.height&&miniFixture.resizeHeight===miniFixture.menuBaseline.requested&&miniFixture.resizeCalls.slice(miniFixture.menuBaseline.calls).every(call=>call.height===miniFixture.menuBaseline.requested)&&Math.abs(miniForm.getBoundingClientRect().bottom-miniFixture.menuBaseline.composerBottom)<=1");
  await check('menuShowsConfiguredModelSuffixAndDisablesMissingRoute', "document.querySelector('[data-model=haiku] small').textContent==='fast-model'&&document.querySelector('[data-model=opus] small').textContent==='expert-model'&&document.querySelector('[data-model=sonnet]').disabled&&document.querySelector('[data-model=sonnet] small').textContent==='未配置模型'&&miniModelLabel.textContent==='快速'&&miniModelButton.title.includes('fast-model')");
  await act("document.querySelector('[data-model=haiku]').focus();miniModelMenu.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));document.querySelector('[data-model=sonnet]').click();");
  await check('keyboardAndClickCannotChooseUnavailableTier', "document.activeElement.dataset.model==='opus'&&miniModelLabel.textContent==='快速'&&document.querySelector('[data-model=haiku]').getAttribute('aria-checked')==='true'");
  await click('#miniModelMenu [data-model="opus"]');
  await check('closingModelMenuRetainsTheSameNativeSize', "innerHeight===miniFixture.menuBaseline.height&&miniModelMenu.hidden&&miniFixture.resizeHeight===miniFixture.menuBaseline.requested&&Math.abs(miniForm.getBoundingClientRect().bottom-miniFixture.menuBaseline.composerBottom)<=1");
  await input('解释一下这个功能');
  await act("miniInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true}));");
  await check('imeEnterKeepsDraftAndDoesNotSend', "miniFixture.calls.filter(x=>x.kind==='submit').length===0&&miniInput.value==='解释一下这个功能'");
  await click('#miniSend');
  await waitFor('miniFixture.snapshot.running&&miniInput.value.length===0'); await settle();
  await check('submitStartsInlineConversationWithoutOpeningMain', "miniFixture.opens===0&&miniFixture.calls.find(x=>x.kind==='submit').model==='opus'&&document.querySelector('.mini-user').textContent==='解释一下这个功能'&&!miniTranscript.hidden&&miniSend.classList.contains('is-stop')");
  await act("miniFixture.snapshot.conversation.turns[0].activity={startupPhase:'preparing',items:[]};miniFixture.emit();"); await settle();
  await check('miniPreparationUsesAnActiveIndicatorWithoutClaimingThinking', "document.querySelector('.mini-process-label').textContent==='正在准备'&&getComputedStyle(document.querySelector('.mini-process-mark')).animationName==='mini-spin'&&miniLiveStatus.textContent==='正在准备'");
  await act("miniFixture.snapshot.conversation.turns[0].activity.startupPhase='waiting';miniFixture.emit();"); await settle();
  await check('miniInitializedSessionWaitsForActualReplyWithoutAStaticCheckmark', "document.querySelector('.mini-process-label').textContent==='正在等待回复'&&getComputedStyle(document.querySelector('.mini-process-mark')).animationName==='mini-spin'&&miniLiveStatus.textContent==='正在等待回复'");
  await screenshot('startup-waiting');
  await act("miniFixture.snapshot.conversation.turns[0].activity={startupPhase:'waiting',items:[{id:'relay-api-retry',status:'running',title:'服务商限流，等待重试'}]};miniFixture.emit();"); await settle();
  await check('miniRetryOverridesTheGenericWait', "document.querySelector('.mini-process-label').textContent==='服务商限流，等待重试'");
  await act("miniFixture.snapshot.conversation.turns[0].activity={startupPhase:null,items:[]};miniFixture.emit();"); await settle();
  await check('miniActualThinkingKeepsExistingRunningAnimation', "document.querySelector('.mini-process-label').textContent==='正在思考'&&getComputedStyle(document.querySelector('.mini-process-mark')).animationName==='mini-spin'");
  await check('runningDisablesOnlyConversationHandoffAndNewChat', "miniOpenMain.disabled&&miniNew.disabled&&!miniInput.disabled&&!miniSend.disabled&&miniOpenMain.title.includes('回复完成')");
  await waitFor('!miniPermissionMode.disabled');
  await click('#miniPermissionMode'); await waitFor("!!document.querySelector('.rpc-popover')");
  await click('[data-permission-option=acceptEdits]');
  await waitFor("miniPermissionMode.dataset.permissionMode==='acceptEdits'&&!document.querySelector('.rpc-popover')");
  await check('miniCanExplicitlyChangeItsRunningConversationPermission', "miniFixture.snapshot.running&&miniFixture.permissionWrites.at(-1).conversationId==='mini-conv-1'&&miniFixture.conversationPermissions['mini-conv-1'].permissionMode==='acceptEdits'&&miniFixture.calls.filter(x=>x.kind==='submit').length===1");
  await act("miniFixture.routing.defaultModel='haiku';miniFixture.routing.chatRoutes.find(r=>r.tier==='opus').available=false;miniFixture.emitProviders();"); await settle();
  await check('providerChangesNeverRemapRunningModelOrDisablePause', "miniModelLabel.textContent==='专家'&&miniFixture.snapshot.conversation.model==='opus'&&document.querySelector('[data-model=opus]').disabled&&document.querySelector('[data-model=opus]').getAttribute('aria-checked')==='true'&&!miniSend.disabled&&miniSend.classList.contains('is-stop')");
  await input('配置变化时仍可补充');
  await check('activeRunCanStillReceiveSupplementsWhenItsRouteDisappears', "!miniSend.disabled&&miniSend.title.includes('调整方向')&&miniFixture.snapshot.running");
  await input('');
  await act("miniFixture.routing.chatRoutes.find(r=>r.tier==='opus').available=true;miniFixture.emitProviders();"); await settle();
  const response = '这是 **直接对话**。\n\n- 在小窗中继续\n- 保留执行过程\n\n```js\nconst ready = true;\n```';
  await act(`miniFixture.beforeStream={height:innerHeight,composerBottom:miniForm.getBoundingClientRect().bottom};miniFixture.update(${JSON.stringify(response)});`);
  await frames();
  await check('streamGrowthWaitsForTheNativeViewportInsteadOfJumpingTheComposer', "innerHeight===miniFixture.beforeStream.height&&Math.abs(miniForm.getBoundingClientRect().bottom-miniFixture.beforeStream.composerBottom)<=1&&miniTranscript.style.height===''&&miniForm.getBoundingClientRect().bottom<=innerHeight-18");
  await settle();
  await check('streamRemainsInVisibleProcessUntilConfirmed', "document.querySelector('.mini-answer').hidden&&document.querySelector('.mini-process').open&&document.querySelector('.mini-process-entry-body').textContent.includes('const ready')");
  await input('再补充一个例子'); await click('#miniSend');
  await check('followupKeepsTaskRunningWithoutPause', "miniFixture.pauses===0&&miniFixture.snapshot.running&&miniFixture.snapshot.conversation.turns.length===1&&document.querySelector('.mini-supplement .mini-user')?.textContent==='再补充一个例子'&&miniInput.value===''");
  await act("miniFixture.snapshot.followUpMode='queue';miniFixture.emit();");
  await input('稍后继续');
  await check('queueDefaultHasSpecificTooltip', "miniSend.title.includes('加入队列')");
  await act("miniInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));"); await settle();
  await check('ctrlEnterReversesOnlyThisSupplementWithoutPause', "miniFixture.calls.at(-1).reverseFollowUp===true&&miniFixture.snapshot.followUpMode==='queue'&&miniFixture.pauses===0&&miniFixture.snapshot.running&&miniFixture.snapshot.conversation.turns.length===1&&miniInput.value===''");
  await act(`miniFixture.finish(${JSON.stringify(response)});`); await settle();
  await check('finalRendersMarkdownOnlyAfterConfirmation', "document.querySelector('.mini-answer strong')?.textContent==='直接对话'&&document.querySelectorAll('.mini-answer li').length===2&&document.querySelector('.mini-answer pre code')?.textContent.includes('const ready')&&!document.querySelector('.mini-answer-actions').hidden");
  await act("window.miniPreviewStrong=document.querySelector('.mini-answer strong');");
  await click('.mini-copy');
  await check('copyContainsOnlyFinalAnswer', `miniFixture.copied===${JSON.stringify(response)}`);
  await screenshot('mini-expanded-light');
  await input('尚未发送的草稿'); await click('#miniHide'); await act('miniFixture.focus();'); await settle();
  await check('hideAndRefocusPreserveDraftAndConversation', "miniFixture.hidden===1&&miniInput.value==='尚未发送的草稿'&&document.querySelector('.mini-answer strong')===miniPreviewStrong&&miniFixture.snapshot.conversation.turns.length===1");
  await click('#miniPin');
  await check('pinTracksHostState', "miniFixture.snapshot.pinned===false&&miniPin.getAttribute('aria-pressed')==='false'");
  await input('继续第二轮'); await click('#miniSend');
  await check('secondRoundContinuesExistingConversation', "miniFixture.snapshot.conversation.id==='mini-conv-1'&&miniFixture.snapshot.conversation.turns.length===2&&document.querySelectorAll('.mini-turn').length===2&&miniFixture.opens===0");
  await act("miniFixture.error='模拟暂停失败';"); await click('#miniSend');
  await check('pauseErrorKeepsRunningAndAllowsRetry', "miniFixture.pauses===1&&miniFixture.snapshot.running&&!miniError.hidden&&miniError.textContent==='模拟暂停失败'&&!miniSend.disabled");
  await act('miniFixture.error=null;'); await click('#miniSend');
  await check('pauseSettlesWithoutLosingConversation', "!miniFixture.snapshot.running&&document.querySelectorAll('.mini-turn-status')[1].textContent.includes('已暂停')&&miniFixture.snapshot.conversation.turns.length===2");
  await input('发送失败的内容'); await act("miniFixture.error='模拟发送失败';"); await click('#miniSend');
  await check('sendErrorRetainsDraftForRetry', "miniInput.value==='发送失败的内容'&&miniError.textContent==='模拟发送失败'");
  await act('miniFixture.error=null;'); await input('执行一个小任务'); await click('#miniSend');
  await act("miniFixture.interaction({id:'permission-1',state:'pending',kind:'permission',conversationId:'mini-conv-1',toolName:'Bash',createdAt:new Date().toISOString(),permission:{input:{command:'echo Relay fixture'},description:'合成权限请求',canAllowForSession:false}});");
  await waitFor("!interactionSurfaceMount.hidden&&!!document.querySelector('.interaction-permission-card')"); await settle();
  await check('approvalAppearsInlineAndWithinWindow', "!interactionSurfaceMount.hidden&&document.querySelector('.interaction-permission-preview-code').textContent==='echo Relay fixture'&&document.querySelector('.interaction-button-primary').getBoundingClientRect().bottom<=innerHeight-18");
  await check('pendingMiniApprovalAllowsPermissionSwitching', "!miniPermissionMode.disabled&&miniPermissionMode.dataset.permissionMode==='acceptEdits'");
  await check('miniApprovalIsCompactAndLeavesTheComposerAccessible', "(()=>{const card=document.querySelector('.interaction-surface').getBoundingClientRect(),action=document.querySelector('.interaction-button-primary').getBoundingClientRect();return Math.abs(card.width-miniForm.getBoundingClientRect().width)<1&&card.height<=270&&action.height>=28&&action.height<=32&&action.bottom<miniForm.getBoundingClientRect().top&&parseFloat(getComputedStyle(interactionSurfaceTitle).fontSize)>=12})()");
  await screenshot('mini-inline-approval');
  await click('.interaction-button-primary');
  await check('approvalRespondsWithoutMainWindow', "miniFixture.responses[0].id==='permission-1'&&miniFixture.responses[0].decision.action==='allow_once'&&miniFixture.opens===0");
  await act("miniFixture.interaction({id:'question-1',state:'pending',kind:'question',conversationId:'mini-conv-1',createdAt:new Date().toISOString(),question:{questions:[{header:'格式',question:'用哪种格式展示？',multiSelect:false,options:[{label:'列表',description:'逐项查看'},{label:'表格',description:'对比查看'}]}]}});");
  await waitFor("!!document.querySelector('.interaction-question-form')"); await settle();
  await check('requestingAnAnswerDoesNotDisablePermissionControls', '!miniPermissionMode.disabled');
  await check('miniQuestionUsesCompactRowsWithoutAnswerButtonOverlap', "(()=>{const card=document.querySelector('.interaction-surface').getBoundingClientRect(),option=document.querySelector('.interaction-option').getBoundingClientRect(),input=document.querySelector('.interaction-other-input').getBoundingClientRect(),action=document.querySelector('.interaction-question-actions').getBoundingClientRect();return card.height<=245&&option.height>=44&&option.height<=62&&input.width>=100&&input.right<=action.left&&action.bottom<miniForm.getBoundingClientRect().top})()");
  await click('.interaction-option input');
  await screenshot('mini-inline-question');
  await click('.interaction-question-form .interaction-button-primary');
  await check('askChoiceSubmitsInsidePanel', "miniFixture.responses.some(x=>x.id==='question-1'&&JSON.stringify(x.decision).includes('列表'))&&miniFixture.opens===0");
  // Simulate a short display work area: the host may clamp a request below the
  // usual 600px cap. Long content must scroll without covering decision buttons.
  await act("miniFixture.maxResizeHeight=470;miniFixture.resizeHeight=470;");
  win.setContentSize(460, 470); await frames();
  await act("miniFixture.interaction({id:'permission-short',state:'pending',kind:'permission',conversationId:'mini-conv-1',toolName:'Bash',createdAt:new Date().toISOString(),permission:{input:{command:Array.from({length:24},(_,i)=>'echo synthetic-check-'+i).join('\\n')},description:'检查较长的任务命令，完整内容可以滚动查看。',canAllowForSession:true}});");
  await waitFor("!!document.querySelector('.interaction-permission-card')"); await settle();
  await click('.interaction-permission-input summary');
  await check('shortMiniPermissionScrollsDetailsAndKeepsDecisionsAboveComposer', "(()=>{const card=document.querySelector('.interaction-surface'),content=document.querySelector('.interaction-content'),actions=[...document.querySelectorAll('.interaction-action-allow button')].filter(x=>x.checkVisibility()).map(x=>x.getBoundingClientRect()),viewport=content.getBoundingClientRect();return innerHeight===470&&content.scrollHeight>content.clientHeight&&card.scrollWidth<=card.clientWidth&&actions.every(r=>r.top>=viewport.top&&r.bottom<=viewport.bottom+1&&r.bottom<miniForm.getBoundingClientRect().top)})()");
  await screenshot('mini-short-approval');
  await click('.interaction-allow-menu-toggle');
  await check('shortMiniPermissionRetainsExplicitSessionScopeActions', "(()=>{const button=document.querySelector('.interaction-allow-menu [data-action=allow_session]'),r=button.getBoundingClientRect();return button.checkVisibility()&&r.height>=28&&r.bottom<miniForm.getBoundingClientRect().top&&r.right<innerWidth})()");
  await click('[data-action=deny]');
  await check('compactPermissionLayoutDoesNotChangeDenialScope', "miniFixture.responses.at(-1).id==='permission-short'&&miniFixture.responses.at(-1).decision.action==='deny'&&!miniFixture.responses.at(-1).decision.interrupt");
  await act("miniFixture.interaction({id:'question-short',state:'pending',kind:'question',conversationId:'mini-conv-1',createdAt:new Date().toISOString(),question:{questions:[{question:'选择需要检查的内容，也可以在下方补充具体要求。',multiSelect:true,options:['布局','字体','动画','交互'].map(label=>({label,description:'在较短的小窗里检查显示和操作，确保文字完整可读。'}))},{question:'如何展示结果？',options:[{label:'简洁说明'},{label:'详细报告'}]}]}});");
  await waitFor("!!document.querySelector('.interaction-question-form')"); await settle();
  await act("document.querySelector('.interaction-question:not([hidden]) input[data-option]').click();const other=document.querySelector('.interaction-question:not([hidden]) .interaction-other-input');other.value=Array.from({length:12},(_,i)=>'补充要求 '+i).join('\\n');other.dispatchEvent(new Event('input',{bubbles:true}));"); await settle();
  await check('shortMiniMultiSelectAndLongFreeAnswerKeepContinueVisible', "(()=>{const content=document.querySelector('.interaction-content'),card=document.querySelector('.interaction-surface'),other=document.querySelector('.interaction-question:not([hidden]) .interaction-other-input'),button=document.querySelector('.interaction-question-actions .interaction-button-primary').getBoundingClientRect(),viewport=content.getBoundingClientRect();return innerHeight===470&&content.scrollHeight>content.clientHeight&&other.clientHeight===100&&other.scrollHeight>other.clientHeight&&card.scrollWidth<=card.clientWidth&&button.top>=viewport.top&&button.bottom<=viewport.bottom+1&&button.bottom<miniForm.getBoundingClientRect().top})()");
  await screenshot('mini-short-multiselect');
  await click('.interaction-question-actions .interaction-button-primary');
  await waitFor("document.querySelector('.interaction-question-position').textContent==='2 / 2'");
  await click('.interaction-question:not([hidden]) input[data-option]');
  await click('.interaction-question-actions .interaction-button-primary');
  await check('compactMultiQuestionKeepsAllSelectionsAndFreeText', "(()=>{const response=miniFixture.responses.find(x=>x.id==='question-short');return response?.decision.action==='submit'&&response.decision.answers['选择需要检查的内容，也可以在下方补充具体要求。'][0]==='布局'&&response.decision.answers['选择需要检查的内容，也可以在下方补充具体要求。'][1].includes('补充要求 11')&&response.decision.answers['如何展示结果？']==='简洁说明'&&miniFixture.opens===0})()");
  await act("miniFixture.maxResizeHeight=600;miniFixture.focus();"); await settle();
  await act("miniFixture.snapshot.brand.theme='dark';miniFixture.emit();");
  const longText = Array.from({ length: 48 }, (_, i) => '第 ' + (i + 1) + ' 项：**执行结果**，内容保持可阅读。').join('\n\n');
  await act(`miniFixture.update(${JSON.stringify(longText)});`); await settle();
  await check('longStreamCapsHeightAndScrollsInDarkTheme', "miniFixture.resizeHeight===600&&document.documentElement.dataset.theme==='dark'&&miniTranscript.scrollHeight>miniTranscript.clientHeight+100&&miniInput.getBoundingClientRect().bottom<innerHeight-20&&document.documentElement.scrollWidth<=innerWidth");
  await act("miniTranscript.scrollTop=0;miniTranscript.dispatchEvent(new Event('scroll'));");
  await act(`miniFixture.update(${JSON.stringify(longText + '\n\n新的内容')});`); await settle();
  await check('readingOlderOutputDoesNotJumpToBottom', 'miniTranscript.scrollTop===0');
  await screenshot('mini-long-dark');
  await input(Array.from({length: 18}, (_, i) => '待发送的第 ' + (i + 1) + ' 行补充要求').join('\n'));
  await check('textareaAndTranscriptNativeScrollbarsShareTheSameRightEdge', "(()=>{const input=miniInput.getBoundingClientRect(),transcript=miniTranscript.getBoundingClientRect();return Math.abs(input.right-transcript.right)<=1&&miniInput.scrollHeight>miniInput.clientHeight+100&&input.height===150&&miniTranscript.scrollHeight>miniTranscript.clientHeight+100&&getComputedStyle(miniInput,'::-webkit-scrollbar').width===getComputedStyle(miniTranscript,'::-webkit-scrollbar').width&&miniSend.getBoundingClientRect().bottom<innerHeight-18&&miniFixture.resizeHeight===600})()");
  win.webContents.sendInputEvent({type:'mouseMove',x:100,y:40}); await delay(1100);
  await check('idleScrollbarsAreHiddenWithoutChangingTheirHitArea', "[miniTranscript,miniInput].every(node=>getComputedStyle(node,'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(node,'::-webkit-scrollbar').width==='9px')");
  await screenshot('mini-scrollbars-hidden');
  const scrollGeometry = await evaluate("(()=>{const t=miniTranscript.getBoundingClientRect(),i=miniInput.getBoundingClientRect();return{right:Math.floor(t.right),transcriptTop:Math.ceil(t.top),transcriptMiddle:Math.floor((t.top+t.bottom)/2),inputMiddle:Math.floor((i.top+i.bottom)/2)}})()");
  win.webContents.sendInputEvent({type:'mouseMove',x:scrollGeometry.right-11,y:scrollGeometry.transcriptMiddle}); await frames();
  await check('approachingTranscriptEdgeRevealsOnlyItsScrollbar', "getComputedStyle(miniTranscript,'::-webkit-scrollbar-thumb').backgroundColor!=='rgba(0, 0, 0, 0)'&&getComputedStyle(miniInput,'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)'");
  win.webContents.sendInputEvent({type:'mouseMove',x:100,y:scrollGeometry.transcriptMiddle}); await frames();
  await check('hoveringTranscriptContentKeepsTheScrollbarHidden', "getComputedStyle(miniTranscript,'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)'");
  win.webContents.sendInputEvent({type:'mouseMove',x:scrollGeometry.right-11,y:scrollGeometry.inputMiddle}); await frames();
  await check('approachingTextareaEdgeRevealsItsAlignedScrollbar', "getComputedStyle(miniInput,'::-webkit-scrollbar-thumb').backgroundColor!=='rgba(0, 0, 0, 0)'&&getComputedStyle(miniTranscript,'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)'");
  win.webContents.sendInputEvent({type:'mouseMove',x:100,y:40});
  await act('miniInput.scrollTop=35;miniTranscript.scrollTop=40;'); await frames();
  await check('scrollingRevealsBothScrollbarsWithoutThePointerAtTheirEdges', "[miniTranscript,miniInput].every(node=>node.scrollTop>0&&getComputedStyle(node,'::-webkit-scrollbar-thumb').backgroundColor!=='rgba(0, 0, 0, 0)')");
  await screenshot('mini-scrollbars-aligned'); await delay(1100);
  await check('scrollbarsFadeOutAfterScrollingStops', "[miniTranscript,miniInput].every(node=>getComputedStyle(node,'::-webkit-scrollbar-thumb').backgroundColor==='rgba(0, 0, 0, 0)')");
  // Exercise Chromium's actual scrollbar thumb, without synthetic DOM scrolls.
  await act('miniTranscript.scrollTop=0;'); await frames();
  win.webContents.sendInputEvent({type:'mouseMove',x:scrollGeometry.right-3,y:scrollGeometry.transcriptTop+12}); await frames();
  win.webContents.sendInputEvent({type:'mouseDown',x:scrollGeometry.right-3,y:scrollGeometry.transcriptTop+12,button:'left',clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove',x:scrollGeometry.right-3,y:scrollGeometry.transcriptTop+60,modifiers:['leftButtonDown']}); await delay(80);
  win.webContents.sendInputEvent({type:'mouseUp',x:scrollGeometry.right-3,y:scrollGeometry.transcriptTop+60,button:'left',clickCount:1}); await frames();
  await check('nativeScrollbarThumbRemainsDraggable', 'miniTranscript.scrollTop>100');
  await input('');
  await check('clearingLongInputRestoresItsCompactAutomaticHeight', 'miniInput.getBoundingClientRect().height===42&&miniSend.getBoundingClientRect().bottom<innerHeight-18&&miniFixture.resizeHeight===600');
  const hostile = '**安全渲染**\n\n<img src="https://invalid.example/image" onerror="window.__miniXss=1">\n\n<script>window.__miniXss=1</script>\n\n[不可执行](javascript:alert(1))';
  await act(`miniFixture.finish(${JSON.stringify(hostile)});`); await settle();
  await check('hostileMarkdownCannotCreateExecutableDom', "!document.querySelector('.mini-answer img,.mini-answer script,.mini-answer [onerror],.mini-answer a[href^=javascript]')&&window.__miniXss===undefined&&document.querySelectorAll('.mini-answer strong').length>=2");
  await click('#miniOpenMain');
  await check('mainWindowOpensOnlyOnExplicitActionAfterCompletion', 'miniFixture.opens===1');
  await click('#miniNew');
  await check('newChatReturnsToCompactEmptyComposer', "miniFixture.snapshot.conversation===null&&miniTranscript.hidden&&miniInput.value===''&&innerWidth===460&&miniFixture.resizeHeight===246&&Math.abs(miniCard.getBoundingClientRect().height-214)<=1");
  await act("miniFixture.routing.defaultModel='opus';miniFixture.emitProviders();"); await click('#miniNew');
  await check('newMiniChatUsesTheLatestGlobalDefaultReturnedByTheHost', "miniFixture.snapshot.model==='opus'&&miniFixture.snapshot.conversation===null&&miniModelLabel.textContent==='专家'&&document.querySelector('[data-model=opus]').getAttribute('aria-checked')==='true'&&miniTranscript.hidden");
  await act("miniFixture.routing.defaultModel='haiku';miniFixture.emitProviders();"); await click('#miniNew');
  await check('laterDefaultChangesApplyToNewMiniChatsWithoutCreatingHistory', "miniFixture.snapshot.model==='haiku'&&miniModelLabel.textContent==='快速'&&miniFixture.snapshot.conversation===null&&miniFixture.nextConversation===2");
  await input('Escape 不丢草稿');
  await act("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));miniFixture.focus();"); await settle();
  await check('escapeHidesWithoutDiscardingDraft', "miniFixture.hidden===2&&miniInput.value==='Escape 不丢草稿'");
  await act("miniFixture.providerMode='error';miniFixture.focus();");
  await waitFor("document.querySelector('[data-model=haiku] small').textContent==='模型加载失败'"); await settle();
  await check('routeFetchFailureDisablesChoicesAndKeepsDraftAndSelectedTier', "[...miniModelMenu.querySelectorAll('button')].every(button=>button.disabled)&&miniSend.disabled&&miniInput.value==='Escape 不丢草稿'&&miniModelLabel.textContent==='快速'");
  await act("miniFixture.providerMode='normal';"); await click('#miniModelButton');
  await waitFor("!document.querySelector('[data-model=haiku]').disabled"); await settle();
  await check('reopeningMenuRecoversCurrentProviderConfiguration', "document.querySelector('[data-model=haiku] small').textContent==='fast-model'&&!miniSend.disabled&&miniInput.value==='Escape 不丢草稿'");
  await click('#miniModelButton');
  await act("miniFixture.providerMode='hold';miniFixture.focus();"); await waitFor('miniFixture.pendingProviderLists.length===1');
  await act("miniFixture.routing.chatRoutes.find(r=>r.tier==='haiku').modelId='new-provider/current-fast';miniFixture.emitProviders();miniFixture.pendingProviderLists.shift()();miniFixture.providerMode='normal';"); await settle();
  await check('olderProviderResponseCannotOverwriteNewerRouteEvent', "document.querySelector('[data-model=haiku] small').textContent==='current-fast'&&miniModelButton.title.includes('current-fast')&&miniModelLabel.textContent==='快速'&&miniInput.value==='Escape 不丢草稿'");

  await act("miniFixture.permissionDefaults={permissionMode:'default',executionMode:{kind:'plan'},revision:20,legacyPlan:true};miniFixture.emitPermissions();");
  await click('#miniNew');
  await waitFor("miniPermissionMode.dataset.permissionPlan==='true'");
  await check('newMiniChatDisplaysAndLocksMigratedPlanPermissions', "miniPermissionMode.disabled&&miniPermissionMode.title.includes('计划模式')&&miniFixture.snapshot.conversation===null&&innerHeight===246");
  await input('只分析，不执行'); await click('#miniSend');
  await waitFor('miniFixture.snapshot.running');
  await check('miniFirstSendRetainsTheVisibleLegacyPlanInsteadOfForcingDefault', "miniFixture.calls.filter(x=>x.kind==='submit').at(-1).executionMode.kind==='plan'&&miniFixture.conversationPermissions[miniFixture.snapshot.conversation.id].executionMode.kind==='plan'&&miniPermissionMode.disabled");
  await act("miniFixture.finish('只读计划已完成');"); await settle();

  // Same serialized timeline used by the main window and actual mini host.
  await act(`
    const f=miniFixture, O=RelayAssistantOutput;
    f.timelineState=O.createState(); f.prefix=['已输出的安排。','',''].join(String.fromCharCode(10));
    O.ingest(f.timelineState,{type:'stream_event',event:{type:'message_start',message:{id:'mini-timeline-answer'}}});
    O.ingest(f.timelineState,{type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:f.prefix}}});
    f.snapshot.conversation={id:'mini-timeline-fixture',model:'haiku',turns:[{runId:'mini-timeline-run',user:'制定两日游日程',status:'running',output:O.serialize(f.timelineState)}]};
    f.snapshot.running=true;f.emit();
  `); await settle();
  await act(`
    const turn=miniFixture.snapshot.conversation.turns[0];
    turn.supplements=[{id:'mini-timeline-input',text:'改成一天',status:'applied',presentation:RelaySupplementTimeline.capture(miniFixture.timelineState)}];
    miniFixture.emit();
  `); await settle();
  await check('miniSupplementAppearsAfterAlreadyVisibleOutput', "(()=>{const p=document.querySelector('.mini-timeline .mini-process:not([hidden])'),u=document.querySelector('.mini-timeline .mini-supplement:not([hidden])');return p.textContent.includes('已输出的安排')&&u.textContent.includes('改成一天')&&!!(p.compareDocumentPosition(u)&Node.DOCUMENT_POSITION_FOLLOWING)})()");
  await act(`
    miniFixture.prefixNode=document.querySelector('.mini-timeline .mini-process');
    miniFixture.suffix='一天即可完成，下午返回。';
    RelayAssistantOutput.ingest(miniFixture.timelineState,{type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:miniFixture.suffix}}});
    miniFixture.snapshot.conversation.turns[0].output=RelayAssistantOutput.serialize(miniFixture.timelineState);miniFixture.emit();
  `); await settle();
  await check('miniSameMessageContinuesBelowInputAndRetainsEarlierDOM', "(()=>{const a=[...document.querySelectorAll('.mini-timeline .mini-process:not([hidden])')],u=document.querySelector('.mini-timeline .mini-supplement:not([hidden])');return a.length===2&&a[0]===miniFixture.prefixNode&&a[1].textContent.includes('一天即可完成')&&!!(u.compareDocumentPosition(a[1])&Node.DOCUMENT_POSITION_FOLLOWING)&&document.querySelector('.mini-answer-actions').hidden})()");
  await act(`
    const f=miniFixture,O=RelayAssistantOutput,turn=f.snapshot.conversation.turns[0];
    turn.assistant=O.finish(f.timelineState,{exitCode:0,finalResult:{type:'result',subtype:'success',result:f.prefix+f.suffix}});
    turn.output=O.serialize(f.timelineState);turn.status='complete';f.snapshot.running=false;f.emit();
  `); await settle();
  await check('miniFinalRetainsBothSegmentsAndOneCopyButton', "document.querySelectorAll('.mini-timeline .mini-answer:not([hidden])').length===2&&document.querySelectorAll('.mini-copy').length===1&&!document.querySelector('.mini-answer-actions').hidden");
  await click('.mini-copy');
  await check('miniSegmentedAnswerCopiesTheWholeFinal', 'miniFixture.copied===miniFixture.prefix+miniFixture.suffix');
  await screenshot('mini-supplement-timeline');

  // Conversation state changes can arrive externally while a submit receipt is pending.
  await act(`miniFixture.draftA=JSON.parse(JSON.stringify(miniFixture.snapshot.conversation));`);
  await input('小窗 A 尚未发送的草稿');
  await act(`miniFixture.draftB={id:'mini-draft-b',model:'haiku',turns:[{user:'合成 B',assistant:'B 回答',status:'complete'}]};miniFixture.conversationPermissions['mini-draft-b']={...miniFixture.permissionDefaults};miniFixture.snapshot.conversation=miniFixture.draftB;miniFixture.emit();`); await settle();
  await check('externalMiniConversationSwitchClearsThePreviousComposer', 'miniInput.value===""');
  await input('小窗 B 尚未发送的草稿');
  await act('miniFixture.snapshot.conversation=miniFixture.draftA;miniFixture.emit();'); await settle();
  await check('miniConversationReturnRestoresItsOwnDraft', 'miniInput.value==="小窗 A 尚未发送的草稿"');
  await click('#miniNew');
  await check('miniNewConversationStartsWithAnEmptyComposer', '!miniFixture.snapshot.conversation&&miniInput.value===""');
  await input('创建新会话并延迟回执'); await act('miniFixture.holdSubmitReceipt=true;');
  await click('#miniSend'); await waitFor('miniFixture.releaseSubmit&&miniFixture.snapshot.running');
  await input('首次发送准备期间新写的补充');
  await act('miniFixture.releaseSubmit();'); await settle();
  await check('miniFirstConversationBindingPreservesNewlyTypedFollowUp', 'miniInput.value==="首次发送准备期间新写的补充"&&miniFixture.snapshot.running');
  await act(`miniFixture.finish('已完成');miniFixture.draftC=JSON.parse(JSON.stringify(miniFixture.snapshot.conversation));`); await settle();
  await input('两个会话恰好相同的草稿'); await act('miniFixture.holdSubmitReceipt=true;');
  await click('#miniSend'); await waitFor('miniFixture.releaseSubmit');
  await act('miniFixture.draftC=JSON.parse(JSON.stringify(miniFixture.snapshot.conversation));miniFixture.snapshot.conversation=miniFixture.draftB;miniFixture.snapshot.running=false;miniFixture.emit();'); await settle();
  await check('miniOtherDraftSurvivesADeferredSubmission', 'miniInput.value==="小窗 B 尚未发送的草稿"');
  await input('两个会话恰好相同的草稿');
  await act('miniFixture.releaseSubmit();'); await settle();
  await check('lateMiniReceiptCannotClearIdenticalTextInAnotherConversation', 'miniInput.value==="两个会话恰好相同的草稿"&&miniError.hidden');
  await act('miniFixture.snapshot.conversation=miniFixture.draftC;miniFixture.snapshot.running=true;miniFixture.emit();'); await settle();
  await check('lateMiniSuccessConsumesOnlyTheSourceDraft', 'miniInput.value===""');
  await input('失败后保留的补充'); await act('miniFixture.holdSubmitReceipt=true;');
  await click('#miniSend'); await waitFor('miniFixture.releaseSubmit');
  await act('miniFixture.snapshot.conversation=miniFixture.draftB;miniFixture.snapshot.running=false;miniFixture.emit();'); await settle();
  await act('miniFixture.releaseSubmit("合成回执失败");'); await settle();
  await check('miniBackgroundSubmissionErrorDoesNotLeakToOtherConversation', 'miniInput.value==="两个会话恰好相同的草稿"&&miniError.hidden');
  await act('miniFixture.snapshot.conversation=miniFixture.draftC;miniFixture.snapshot.running=true;miniFixture.emit();'); await settle();
  await check('miniBackgroundSubmissionFailureKeepsItsOriginalDraft', 'miniInput.value==="失败后保留的补充"');


  await act("miniFixture.snapshot.running=false;miniFixture.snapshot.conversation=null;miniFixture.emit();"); await settle();
  await input('');
  await act(`
    const C = window.RelayTaskContinuity, now = Date.now();
    const first = {runId:'resume-first',user:'验证同一任务的暂停恢复',assistant:'',status:'paused',ts:new Date(now-100000).toISOString(),taskRun:C.finish(C.begin({runId:'resume-first',startedAt:now-100000}),{finishedAt:now-64000})};
    miniFixture.snapshot.conversation={id:'mini-resume-test',model:'opus',paused:{runId:first.runId,at:new Date(now-64000).toISOString()},turns:[first]};
    miniFixture.conversationPermissions['mini-resume-test']={permissionMode:'default',executionMode:{kind:'default'},revision:1};
    miniFixture.snapshot.running=false;miniFixture.snapshot.brand.theme='light';miniFixture.emit();
    window.api.mini.submit = async value => {
      miniFixture.calls.push({kind:'explicit-resume',...value});
      const conv=miniFixture.snapshot.conversation;
      const taskRun=C.begin({runId:'resume-second',startedAt:Date.now(),conversation:conv,resumedFromRunId:conv.paused.runId});
      conv.turns.push({runId:'resume-second',inputKind:'resume',user:'',assistant:'',status:'running',taskRun,activityLabel:'正在处理'});
      delete conv.paused;miniFixture.snapshot.running=true;miniFixture.emit();return {ok:true};
    };
  `); await settle();
  await check('pausedMiniUsesSameButtonToResumeWithAnEmptyComposer', "!miniSend.disabled&&miniSend.title==='继续任务'&&miniInput.value===''&&document.querySelector('.mini-task-time').textContent==='36秒'");
  await click('#miniSend');
  await check('miniResumeSendsExplicitIntentAndNoUserPrompt', "miniFixture.calls.at(-1).kind==='explicit-resume'&&miniFixture.calls.at(-1).resume===true&&miniFixture.calls.at(-1).text===''&&[...document.querySelectorAll('.mini-turn>.mini-user')].filter(n=>!n.hidden).length===1");
  await check('miniResumeUpdatesTheOriginalTaskHeaderAndKeepsOneClock', "document.querySelectorAll('.mini-process-label')[0].textContent==='正在处理'&&document.querySelectorAll('.mini-turn-status')[0].hidden&&[...document.querySelectorAll('.mini-task-time')].filter(n=>!n.hidden).length===1&&document.querySelector('.mini-task-time').closest('.mini-turn')===document.querySelector('.mini-turn')");
  await act(`
    const conv=miniFixture.snapshot.conversation,t=conv.turns.at(-1),now=Date.now();
    t.taskRun.segmentStartedAt=now-67000;t.taskRun.rootStartedAt=now-200000;
    t.taskRun=RelayTaskContinuity.finish(t.taskRun,{finishedAt:now});t.status='complete';t.assistant='已交付';
    miniFixture.snapshot.running=false;miniFixture.emit();
  `); await settle();
  await check('miniFinalClockShowsCumulativeHoursMinutesSeconds', "[...document.querySelectorAll('.mini-task-time')].filter(n=>!n.hidden).map(n=>n.textContent).join()==='1分43秒'&&miniSend.disabled");
  await act('miniFixture.snapshot.conversation=JSON.parse(JSON.stringify(miniFixture.snapshot.conversation));miniFixture.emit();'); await settle();
  await check('miniClockSurvivesReloadedHistoryWithoutAnInternalPromptBubble', "[...document.querySelectorAll('.mini-turn>.mini-user')].filter(n=>!n.hidden).length===1&&[...document.querySelectorAll('.mini-task-time')].filter(n=>!n.hidden)[0].textContent==='1分43秒'");
  await screenshot('mini-resumed-task');
  const panel = win; win = await loadRenderer('floating-orb.html', [64, 64]); panel.close();
  await waitFor('!!window.api&&!!document.getElementById("relayOrb")'); await frames();
  await waitFor('orbLogo.complete&&orbLogo.naturalWidth>0');
  const logoSvg = fs.readFileSync(path.join(root, 'renderer', 'logo.svg'), 'utf8');
  await check('defaultLogoInkOccupiesMostOfTheOrbWithoutChangingItsHitArea', `(()=>{const svg=new DOMParser().parseFromString(${JSON.stringify(logoSvg)},'image/svg+xml').documentElement;svg.style.cssText='position:absolute;visibility:hidden;width:1024px;height:1024px';document.body.append(svg);const ink=svg.getBBox(),view=svg.viewBox.baseVal,orb=relayOrb.getBoundingClientRect(),logo=orbLogo.getBoundingClientRect();const ratio=ink.width/view.width*logo.width/orb.width;svg.remove();return ratio>=.75&&ratio<=.94&&Math.abs(orb.width-48)<=1&&Math.abs(logo.width-56)<=1&&getComputedStyle(relayOrb).overflow==='hidden'})()`);
  await screenshot('orb-default-light');
  const customLogo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="5" y="5" width="90" height="90" rx="18" fill="#3d3d3d"/></svg>');
  await act(`miniFixture.snapshot.brand.logo=${JSON.stringify(customLogo)};miniFixture.emit();`);
  await waitFor('orbLogo.complete&&orbLogo.naturalWidth>0'); await frames();
  await check('customLogoFillsTheCircularOrbWithoutChangingWindowClearSpace', "(()=>{const orb=relayOrb.getBoundingClientRect(),logo=orbLogo.getBoundingClientRect(),style=getComputedStyle(relayOrb),image=getComputedStyle(orbLogo);return !orbLogo.classList.contains('relay-default-logo')&&Math.abs(logo.width-(orb.width-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth)))<=1&&image.objectFit==='cover'&&image.objectPosition==='50% 50%'&&image.borderRadius==='50%'&&logo.height<=orb.height&&orb.left>0&&orb.top>0})()");
  await screenshot('orb-custom-light');
  await act('miniFixture.snapshot.brand.logo=null;miniFixture.emit();'); await frames();
  await check('orbSnapshotsRetainTheNativeSixtyFourPixelWindow', 'innerWidth===64&&innerHeight===64');
  const orbCenter = await evaluate('(()=>{const r=relayOrb.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  win.webContents.sendInputEvent({ type: 'mouseMove', ...orbCenter }); await delay(320);
  visualSamples.orbHover = await evaluate("(()=>{const style=getComputedStyle(relayOrb),rect=relayOrb.getBoundingClientRect();return {hovered:relayOrb.matches(':hover'),boxShadow:style.boxShadow,transform:style.transform,borderColor:style.borderColor,viewport:{width:innerWidth,height:innerHeight},orb:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}})()");
  visualSamples.orbHover.nativeContentSize = win.getContentSize(); save();
  await check('orbHoverHasOnlyNeutralShadowsWithoutAnExternalBlueHalo', "(()=>{if(!relayOrb.matches(':hover'))return false;const colors=getComputedStyle(relayOrb).boxShadow.match(/rgba?\\([^)]+\\)/g)||[];return colors.length>0&&colors.every(color=>{const rgb=color.match(/[\\d.]+/g).slice(0,3).map(Number);return Math.max(...rgb)-Math.min(...rgb)<=10})})()");
  await screenshot('orb-hover-light');
  await act("relayOrb.click();relayOrb.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));");
  await check('orbClickAndContextMenuUseVisibilityBridge', "miniFixture.calls.some(x=>x.kind==='toggle')&&miniFixture.calls.some(x=>x.kind==='orbMenu')");
  await act("relayOrb.setPointerCapture=()=>{};relayOrb.hasPointerCapture=()=>false;relayOrb.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,isPrimary:true,screenX:100,screenY:100,bubbles:true}));relayOrb.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,screenX:102,screenY:102,bubbles:true}));relayOrb.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,screenX:150,screenY:160,bubbles:true}));relayOrb.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,screenX:150,screenY:160,bubbles:true}));relayOrb.dispatchEvent(new MouseEvent('click',{detail:1,bubbles:true}));");
  await check('orbDragHasThresholdAndDoesNotAlsoOpenChat', "miniFixture.calls.filter(x=>x.kind==='orbDrag').map(x=>x.phase).join(',')==='start,move,end'&&miniFixture.calls.filter(x=>x.kind==='toggle').length===1");
  await act("miniFixture.snapshot.running=true;miniFixture.snapshot.brand.theme='dark';miniFixture.emit();"); await frames();
  await check('orbShowsRunningStatusAndTheme', "relayOrb.classList.contains('is-running')&&document.documentElement.dataset.theme==='dark'");
  fs.writeFileSync(path.join(output, 'orb-dark.png'), (await win.webContents.capturePage()).toPNG());
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await waitFor("matchMedia('(prefers-reduced-motion: reduce)').matches"); await frames();
  await check('orbReducedMotionRemovesHoverMovementAndRunningAnimation', "getComputedStyle(relayOrb).transform==='none'&&getComputedStyle(relayOrb).transitionDuration.split(',').every(x=>parseFloat(x)===0)&&getComputedStyle(document.querySelector('.orb-status')).animationName==='none'");
  win.webContents.debugger.detach();
  if (rendererErrors.length) throw Error(rendererErrors.join('\n'));
  clearTimeout(deadline); step = 'complete'; save();
  console.log(JSON.stringify({ passed: Object.keys(checks).length, output })); app.exit(0);
}).catch(error => {
  clearTimeout(deadline); failures.push(error.stack || String(error)); save(); console.error(error); app.exit(1);
});
