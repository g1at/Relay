'use strict';
// Real production renderer; synthetic workspace files and no model/network calls.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const { attachLocalPreviewGuard } = require('../local-preview-guard');
const output = path.join(root, '.codex-tmp/workspace-file-preview-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'start';
const checks = {}, errors = [], requests = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, errors, requests }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = async () => { await delay(380); await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); };
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,25);};tick();})`); }
async function check(name, code) { step=name;checks[name]=!!await evaluate(code);save();console.log(name+': '+checks[name]);if(!checks[name])throw Error(name); }
async function capture(name) { await settle(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function openFile(name) { await act(`relayWorkspacePanel.open('files');document.querySelector('[data-path="${name}"]').click();`); await waitFor(`document.getElementById('workspacePreviewTitle').textContent===${JSON.stringify(name)}`); await settle(); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => { if (/^https?:/i.test(details.url)) requests.push(details.url); done({ cancel: /^https?:/i.test(details.url) }); });
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const seed = `(() => {
    localStorage.clear(); const base=window.api;
    const files={
      'settings.json': JSON.stringify({ name:'Relay', description:'本地工作区', model:'deepseek-chat', tools:['files','terminal'], instructions:Array.from({length:100},(_,i)=>({step:i+1,content:'保持清晰的源码与连续的行号'})),longLine:'Long line '.repeat(100)},null,2),
      'README.md': '# 项目文档\\n\\n**只读预览**\\n\\n'+Array.from({length:70},(_,i)=>'## 第 '+(i+1)+' 节\\n内容说明\\n').join('\\n'),
      'main.ts':'// TypeScript\\nexport const greeting: string = "Relay";\\n',
      'danger.html':'<img src="https://invalid.example/probe" onerror="window.sourceExecuted=true"><script>window.sourceExecuted=true;parent.postMessage({probe:"html-lifecycle",stage:"boot"},"*");</'+'script>',
      'large.log': '<script>window.sourceExecuted=true;</'+'script>\\n'+'Plain text 数据 '.repeat(12000),
      'photo.png':'', 'report.pdf':'', 'bundle.zip':'', 'unknown.custom':''
    };
    window.fileReview={files,opens:[],reads:[],linkReads:[],htmlMessages:[],target:'relay',copied:null,errors:[]};
    window.addEventListener('message',event=>{if(event.data?.probe==='html-lifecycle')fileReview.htmlMessages.push(event.data.stage);});
    window.addEventListener('error',e=>fileReview.errors.push(e.message));
    window.addEventListener('unhandledrejection',e=>fileReview.errors.push(String(e.reason)));
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{fileReview.copied=value;}}});
    const ws={resolve:async()=>({ok:true,root:'C:/Synthetic/RelayProjects/files'}),list:async()=>({ok:true,entries:[{name:'src',path:'src',type:'directory'},...Object.keys(files).map(name=>({name,path:name,type:'file',size:files[name].length}))]}),read:async({path})=>{fileReview.reads.push(path);return{ok:true,path,content:files[path],binary:path.endsWith('.pdf')};},readLink:async input=>{fileReview.linkReads.push(input);if(input.href==='slow.js')return new Promise(resolve=>{fileReview.releaseAsset=()=>resolve({ok:true,path:'slow.js',content:'parent.postMessage({probe:"html-lifecycle",stage:"late-asset"},"*");'});});return{ok:false,error:'合成资源不存在'};},open:async payload=>{fileReview.opens.push(payload);return{ok:true,target:fileReview.target};},onTerminalEvent:()=>()=>{}};
    window.api=new Proxy(base,{get(target,key){if(key==='workspace')return ws;if(key==='windowChrome')return{overlay:true,initialTheme:'light',setTheme(){}};return target[key];}});
  })();`;
  const page = path.join(output, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+seed+'</script>'));
  win=new BrowserWindow({width:1400,height:900,titleBarStyle:'hidden',titleBarOverlay:{color:'#fafafa',symbolColor:'#343436',height:36},show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error('renderer:', message); });
  attachLocalPreviewGuard(win.webContents);
  await win.loadFile(page);win.showInactive();
  await waitFor('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await act("fileReview.context={conversationId:'html-life-a',workingDir:'C:/Synthetic/RelayProjects/files',title:'合成会话 A'};window.relayConversationWorkspace=()=>fileReview.context;window.dispatchEvent(new CustomEvent('relay:conversation-changed'));");
  await act("relayWorkspacePanel.open('files');$('workspaceMaximize').click();");
  await waitFor("document.querySelectorAll('.workspace-file-row').length===10");await settle();
  await check('TreeDistinguishesFileKinds', `['settings.json','README.md','main.ts','danger.html','photo.png','report.pdf','bundle.zip','unknown.custom'].map(path=>document.querySelector('[data-path="'+path+'"]').dataset.fileKind).join(',')==='config,markdown,typescript,html,image,pdf,archive,file'`);
  await check('TypesHaveDifferentShapesAndAccessibleDescriptions', `new Set([...document.querySelectorAll('.workspace-file-row .workspace-file-icon')].map(svg=>svg.innerHTML)).size>=7&&document.querySelector('[data-path="README.md"]').getAttribute('aria-label').includes('Markdown')`);
  await openFile('settings.json');
  await check('SourceHasChromeLanguageSyntaxAndLineNumbers', `document.querySelectorAll('.workspace-source-lights i').length===3&&document.querySelector('.workspace-source-code .hljs-attr')&&document.querySelector('.workspace-source-lines').textContent.split('\\n').length===fileReview.files['settings.json'].split('\\n').length&&document.querySelector('.workspace-source-code').textContent===fileReview.files['settings.json']`);
  await check('FileTabCarriesTheMatchingTypeIcon', `document.querySelector('.workspace-tab[aria-selected=true] .workspace-file-icon').dataset.fileKind==='config'`);
  await check('OnlyTheSourceSurfaceScrollsInBothDirections', `(()=>{const p=document.querySelector('pre.workspace-source'),b=$('workspacePreviewBody'),c=p.querySelector('code');return p.scrollHeight>p.clientHeight&&p.scrollWidth>p.clientWidth&&b.scrollHeight<=b.clientHeight+1&&b.scrollWidth<=b.clientWidth+1&&getComputedStyle(c).overflow==='visible'&&document.documentElement.scrollWidth<=innerWidth})()`);
  await check('CodeAndGutterShareOneFontAndLineHeight', `(()=>{const c=getComputedStyle(document.querySelector('.workspace-source-code')),g=getComputedStyle(document.querySelector('.workspace-source-lines'));return c.lineHeight===g.lineHeight&&c.fontSize===g.fontSize&&parseFloat(c.fontSize)>=12})()`);
  await capture('source-light');
  await act("const s=document.querySelector('pre.workspace-source');s.scrollTop=420;s.scrollLeft=110;fileReview.sourceScroll=[s.scrollTop,s.scrollLeft];$('workspacePreviewCopy').click();");
  await check('CopyContainsOnlyTheOriginalFile', `fileReview.copied===fileReview.files['settings.json']`);
  await check('LineNumbersStayAtLeftWhileCodeScrolls', `(()=>{const s=document.querySelector('pre.workspace-source').getBoundingClientRect(),g=document.querySelector('.workspace-source-lines').getBoundingClientRect();return Math.abs(g.left-s.left)<1})()`);
  await openFile('main.ts');
  await act(`document.querySelector('.workspace-tab[title="settings.json"]').click();`);await settle();
  await check('SwitchingFilesRestoresBothSourceScrollAxes', `(()=>{const s=document.querySelector('pre.workspace-source');return s.scrollTop===fileReview.sourceScroll[0]&&s.scrollLeft===fileReview.sourceScroll[1]})()`);
  await act("document.querySelector('pre.workspace-source').scrollTop=0;document.querySelector('pre.workspace-source').scrollLeft=0;document.documentElement.dataset.theme='dark';");await capture('source-dark');
  await openFile('README.md');
  await check('MarkdownStillRendersAsDocument', `!!$('workspacePreviewBody').querySelector('h1')&&!$('workspacePreviewBody').classList.contains('is-source')`);
  await act("$('workspacePreviewBody').scrollTop=200;fileReview.markdownScroll=$('workspacePreviewBody').scrollTop;$('workspacePreviewMode').click();");
  await check('MarkdownSourcePreservesLiteralContent', `document.querySelector('.workspace-source-code').textContent===fileReview.files['README.md']&&document.querySelector('pre.workspace-source').scrollTop===0`);
  await act("document.querySelector('pre.workspace-source').scrollTop=300;$('workspacePreviewMode').click();");
  await check('DocumentAndSourceKeepIndependentReadingPositions', `$('workspacePreviewBody').scrollTop===fileReview.markdownScroll&&!$('workspacePreviewBody').classList.contains('is-source')`);
  await act("$('workspacePreviewMode').click();");
  await check('ReturningToSourceRestoresItsPosition', `document.querySelector('pre.workspace-source').scrollTop===300`);
  await openFile('danger.html');
  await waitFor("!!$('workspacePreviewBody').querySelector('iframe[srcdoc]')");
  await check('HtmlPreviewIsAnOpaqueScriptSandbox', `$('workspacePreviewBody').querySelector('iframe').getAttribute('sandbox')==='allow-scripts'&&!window.sourceExecuted&&$('workspacePreviewMode').hidden===false`);
  await waitFor("fileReview.htmlMessages.includes('boot')");
  await act("fileReview.beforeSettingsFrame=$('workspacePreviewBody').querySelector('iframe');fileReview.beforeSettingsBoots=fileReview.htmlMessages.length;showAppView('settings');");
  await waitFor("!$('workspacePreviewBody').querySelector('iframe')");
  await check('EnteringSettingsDestroysHtmlFrame', "document.querySelector('.app').dataset.view==='settings'&&!fileReview.beforeSettingsFrame.isConnected&&!$('workspacePreviewBody').querySelector('iframe')");
  await act("showAppView('chat');");
  await waitFor("!!$('workspacePreviewBody').querySelector('iframe[srcdoc]')&&fileReview.htmlMessages.length>fileReview.beforeSettingsBoots");
  await check('ReturningFromSettingsRemountsTheCurrentHtmlPreview', "$('workspacePreviewBody').querySelector('iframe')!==fileReview.beforeSettingsFrame&&$('workspacePreviewTitle').textContent==='danger.html'&&!window.sourceExecuted");
  await act("fileReview.beforeCloseFrame=$('workspacePreviewBody').querySelector('iframe');fileReview.beforeCloseBoots=fileReview.htmlMessages.length;relayWorkspacePanel.close();");
  await waitFor("!$('workspacePreviewBody').querySelector('iframe')");
  await check('ClosingRightPanelDestroysHtmlFrame', "!relayWorkspacePanel.getState().open&&!fileReview.beforeCloseFrame.isConnected&&!$('workspacePreviewBody').querySelector('iframe')");
  await act("relayWorkspacePanel.open();");
  await waitFor("!!$('workspacePreviewBody').querySelector('iframe[srcdoc]')&&fileReview.htmlMessages.length>fileReview.beforeCloseBoots");
  await check('ReopeningRightPanelRestoresInteractiveHtml', "relayWorkspacePanel.getState().open&&$('workspacePreviewBody').querySelector('iframe')!==fileReview.beforeCloseFrame&&$('workspacePreviewTitle').textContent==='danger.html'&&!window.sourceExecuted");
  await capture('html-reopened');
  await act(`fileReview.originalDanger=fileReview.files['danger.html'];fileReview.files['danger.html']='<head><script src="slow.js" defer></'+'script></head><body><button id="go">延迟资源</button></body>';`);
  await openFile('danger.html');
  await waitFor("typeof fileReview.releaseAsset==='function'");
  await act("fileReview.pendingFrame=$('workspacePreviewBody').querySelector('iframe');fileReview.beforeLateMessages=fileReview.htmlMessages.length;fileReview.context={conversationId:'html-life-b',workingDir:'C:/Synthetic/RelayProjects/files-b',title:'合成会话 B'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));");
  await waitFor("!$('workspacePreviewBody').querySelector('iframe')");
  await check('ChangingConversationDestroysPendingHtmlFrame', "!fileReview.pendingFrame.isConnected&&$('workspacePreview').hidden&&!relayWorkspacePanel.getState().tabs.some(item=>item.path==='danger.html')&&fileReview.linkReads.at(-1).context.conversationId==='html-life-a'");
  await act("fileReview.releaseAsset();");await settle();
  await check('LateAssetCannotExecuteOrRepopulateAnotherConversation', "!$('workspacePreviewBody').querySelector('iframe')&&!fileReview.pendingFrame.hasAttribute('srcdoc')&&fileReview.htmlMessages.length===fileReview.beforeLateMessages&&!fileReview.htmlMessages.includes('late-asset')&&$('workspaceRootTitle').textContent==='合成会话 B'&&!window.sourceExecuted");
  await act("fileReview.files['danger.html']=fileReview.originalDanger;fileReview.context={conversationId:'html-life-a',workingDir:'C:/Synthetic/RelayProjects/files',title:'合成会话 A'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));");
  await waitFor("document.querySelectorAll('.workspace-file-row').length===10");
  await openFile('danger.html');
  await waitFor("!!$('workspacePreviewBody').querySelector('iframe[srcdoc]')&&fileReview.htmlMessages.length>fileReview.beforeLateMessages");
  await check('OriginalConversationCanOpenFreshHtmlAfterCanceledAsset', "$('workspacePreviewBody').querySelector('iframe')!==fileReview.pendingFrame&&$('workspaceRootTitle').textContent==='合成会话 A'&&!window.sourceExecuted");
  await act("$('workspacePreviewMode').click();");
  await check('HtmlSourceIsInert', `!fileReview.sourceExecuted&&!window.sourceExecuted&&!$('workspacePreviewBody').querySelector('script,img,iframe')&&document.querySelector('.workspace-source-code').textContent===fileReview.files['danger.html']`);
  await openFile('large.log');
  await check('LargeTextSkipsExpensiveHighlightingWithoutLosingData', `document.querySelector('.workspace-source-code').textContent===fileReview.files['large.log']&&!document.querySelector('.workspace-source-code').classList.contains('hljs')&&!window.sourceExecuted`);
  await openFile('report.pdf');
  await check('BinaryFileUsesExistingSystemOpenFallback', `!$('workspacePreviewBody').classList.contains('is-source')&&$('workspacePreviewCopy').disabled&&$('workspacePreviewBody').textContent.includes('系统应用')`);
  await openFile('settings.json');
  await act("document.documentElement.dataset.theme='light';$('workspaceMaximize').click();const h=$('workspaceResizeHandle');h.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));");await settle();
  await check('NarrowPreviewUsesAvailableWidthWithoutPageOverflow', `(()=>{const b=$('workspacePreviewBody'),s=document.querySelector('pre.workspace-source');return b.clientWidth>=280&&s.clientWidth>=240&&s.getBoundingClientRect().right<=$('workspacePanel').getBoundingClientRect().right&&document.documentElement.scrollWidth<=innerWidth})()`);
  await capture('source-narrow');
  await act("fileReview.target='vscode';fileReview.beforeEditorReads=fileReview.reads.length;document.querySelector('[data-path=\"main.ts\"]').click();"); await settle();
  await check('DefaultEditorOpensWithoutReadingOrReplacingInternalPreview', "fileReview.opens.at(-1).target==='default'&&fileReview.opens.at(-1).path==='main.ts'&&fileReview.reads.length===fileReview.beforeEditorReads&&$('workspacePreviewTitle').textContent==='settings.json'");
  await act("fileReview.target='relay';document.querySelector('[data-path=\"main.ts\"]').click();"); await waitFor("$('workspacePreviewTitle').textContent==='main.ts'");
  await check('ReturningDefaultToRelayRestoresInternalFilePreview', "fileReview.reads.at(-1)==='main.ts'&&document.querySelector('.workspace-source-code').textContent===fileReview.files['main.ts']");
  await check('NoRuntimeErrorsOrConversationSideEffects', `fileReview.errors.length===0&&!uiFixture.calls.includes('runClaude')&&!uiFixture.calls.includes('history.save')&&typeof require==='undefined'`);
  if(requests.length)throw Error('Unexpected source network request');
  step='completed';save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{errors.push(String(error.stack||error));console.error(error.stack||error);if(win&&!win.isDestroyed())try{await capture('failure');}catch(_){}save();clearTimeout(deadline);app.exit(1);});
