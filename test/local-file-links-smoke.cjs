'use strict';
// Actual Relay renderer + synthetic workspace bridge. Never boots main.js or a model.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/local-file-links-smoke');
const baseline = process.argv.includes('--baseline');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const results = {}, failures = [], requests = []; let win;
const save = () => fs.writeFileSync(path.join(output, baseline ? 'before.json' : 'result.json'), JSON.stringify({ results, failures, requests }, null, 2));
const deadline = setTimeout(() => { failures.push('timeout'); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`); }
async function check(name, code) { results[name] = !!await evaluate(code); save(); console.log(name + ': ' + results[name]); if (!results[name]) throw Error(name); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => { if (/^https?:/i.test(details.url)) requests.push(details.url); done({ cancel: /^https?:/i.test(details.url) }); });
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const seed = `(() => {
    const base=window.api;localStorage.clear();window.fileLinks={reads:[],opens:[],resolved:[],external:[],errors:[],copied:null,slow:false,release:null};
    window.addEventListener('error',e=>fileLinks.errors.push(e.message));window.addEventListener('unhandledrejection',e=>fileLinks.errors.push(String(e.reason)));
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{fileLinks.copied=text;}}});
    const absolute=href=>{const parsed=RelayLocalFileLinks.parse(href);return /^[A-Z]:/i.test(parsed.path)?parsed.path:'D:/Synthetic/Project/'+parsed.path.replace(/^\\.\\//,'');};
    const ws={resolve:async()=>({ok:true,root:'D:/Synthetic/Project'}),list:async input=>({ok:true,entries:input.path===''?[{name:'docs',path:'docs',type:'directory'}]:input.path==='docs'?[{name:'README.md',path:'docs/README.md',type:'file',size:100}]:[]}),onTerminalEvent:()=>()=>{},
      open:async input=>{fileLinks.opens.push({...input,legacy:true});return{ok:true,target:'vscode'};},
      readLink:async input=>{fileLinks.reads.push(JSON.parse(JSON.stringify(input)));if(fileLinks.slow)await new Promise(r=>{fileLinks.release=r});
        const parsed=RelayLocalFileLinks.parse(input.href);
        if(parsed.path.endsWith('/missing.md'))return{ok:false,error:'合成文件不存在'};
        if(parsed.path.endsWith('/docs'))return{ok:true,kind:'directory',root:'D:/Synthetic/Project',relativePath:'docs',name:'docs',absolutePath:absolute(input.href),path:absolute(input.href),line:null};
        return{ok:true,absolutePath:absolute(input.href),path:absolute(input.href),line:parsed.line,binary:false,
          content:parsed.path.endsWith('README.md')?'# Delivery\\n\\n[Neighbor](child.txt:3)\\n\\n[Website](https://example.com)':'// Synthetic source\\n'+Array.from({length:220},(_,i)=>'const line'+(i+1)+' = '+(i+1)+';').join('\\n')};},
      resolveLink:async input=>{fileLinks.resolved.push(input);return{ok:true,absolutePath:absolute(input.href)};},
      openLink:async input=>{fileLinks.opens.push(input);return{ok:true};}};
    window.api=new Proxy(base,{get(target,key){if(key==='workspace')return ws;if(key==='openExternal')return async href=>{fileLinks.external.push(href);return{ok:true}};return target[key];}});
  })();`;
  const page = path.join(output, baseline ? 'before-fixture.html' : 'fixture.html');
  let html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>');
  if (baseline) {
    const snapshot = path.join(output, 'workspace-panel.before.js');
    if (!fs.existsSync(snapshot)) throw Error('Capture workspace-panel.before.js before running the baseline');
    html = html.replace('<script src="workspace-panel.js"></script>', '<script src="' + pathToFileURL(snapshot).href + '"></script>');
    if (!html.includes(pathToFileURL(snapshot).href)) throw Error('Baseline panel script was not replaced');
  }
  fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1350, height: 900, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page);win.showInactive();
  await waitFor('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await act(`fileLinks.fullHistoryLinkScans=0;const query=messagesEl.querySelectorAll.bind(messagesEl);messagesEl.querySelectorAll=selector=>{if(selector==='a[href]')fileLinks.fullHistoryLinkScans++;return query(selector);};`);
  await act(`window.linkContext={conversationId:'fixture-file-conversation',workingDir:'D:/Synthetic/Project',title:'文件链接测试'};
    window.relayConversationWorkspace=()=>({...linkContext});window.dispatchEvent(new CustomEvent('relay:conversation-changed'));
    messagesEl.replaceChildren();appendMessage('assistant','已完成：\\n\\n- [main.js](<D:/Synthetic/Project/main.js:160>)\\n- [报告 final.pdf](<D:/Synthetic/Project/报告 final.pdf>)\\n- [README](docs/README.md)\\n- [网站](https://example.com)\\n\\n普通文本 D:/Synthetic/Project/plain.txt\\n\\n\u0060\u0060\u0060text\\n[代码示例](D:/Synthetic/Project/no.md)\\n\u0060\u0060\u0060');`);
  await waitFor("messagesEl.querySelectorAll('.relay-local-file-link').length===3");
  await check('OnlyActualMarkdownFileLinksGetIcons', "messagesEl.querySelectorAll('.relay-local-file-icon').length===3&&!messagesEl.querySelector('pre a')&&messagesEl.textContent.includes('普通文本 D:/Synthetic/Project/plain.txt')");
  await check('ExternalWebLinkIsUnchanged', "messagesEl.querySelector('a[href=\"https://example.com\"]')&&!messagesEl.querySelector('a[href=\"https://example.com\"] .relay-local-file-icon')");
  await act(`const isolated=document.createElement('div');relayRenderReadOnlyMarkdown(isolated,'[Report](report.md) [Web](https://example.com)');fileLinks.unscopedReadonlySafe=!isolated.querySelector('.relay-local-file-link')&&!isolated.querySelector('a[href="report.md"]')&&!!isolated.querySelector('a[href="https://example.com"]');`);
  await check('ReadonlyWithoutExplicitContextDoesNotBorrowCurrentConversation', 'fileLinks.unscopedReadonlySafe');
  await act("messagesEl.querySelector('.relay-local-file-link').click();");
  await waitFor("$('workspacePreviewTitle').textContent==='D:/Synthetic/Project/main.js'");
  await waitFor("$('workspacePreviewMeta').textContent.includes('160')");
  await waitFor("$('workspacePanel').getBoundingClientRect().width>=300&&$('workspacePanel').getBoundingClientRect().right<=innerWidth+2&&!$('workspacePanel').inert");
  await check('LeftClickPreviewsWithoutUsingExternalEditorPreference', "fileLinks.reads.length===1&&fileLinks.opens.length===0&&$('workspacePreviewBody').textContent.includes('const line160')&&relayWorkspacePanel.getState().open");
  await check('FirstFileLinkCreatesOnlyItsPreviewTab', "relayWorkspacePanel.getState().tabs.length===1&&relayWorkspacePanel.getState().tabs[0].path==='D:/Synthetic/Project/main.js'&&!document.querySelector('[data-tab-id=files]')");
  await check('LineNumberScrollsIntoSource', "document.querySelector('pre.workspace-source').scrollTop>1000");
  await check('ClickKeepsSourceConversationAndDoesNotCreateHistory', "fileLinks.reads[0].context.conversationId==='fixture-file-conversation'&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')");
  await act("messagesEl.querySelectorAll('.relay-local-file-link')[2].click();");
  await waitFor("$('workspacePreviewBody').querySelector('h1')?.textContent==='Delivery'");
  await check('SecondFileLinkAddsOnlyItsOwnPreviewTab', "relayWorkspacePanel.getState().tabs.length===2&&relayWorkspacePanel.getState().tabs.every(tab=>tab.path)&&!document.querySelector('[data-tab-id=files]')");
  await check('ReadonlyMarkdownKeepsFileLinksAndExternalLinks', "$('workspacePreviewBody').querySelector('.relay-local-file-link')&&$('workspacePreviewBody').querySelector('a[href=\"https://example.com\"]')");
  await act("$('workspacePreviewBody').querySelector('.relay-local-file-link').click();");
  await waitFor("fileLinks.reads.length===3");
  await check('PreviewRelativeLinksUseTheirSourceFileParent', "fileLinks.reads[2].href==='child.txt:3'&&fileLinks.reads[2].basePath==='D:/Synthetic/Project/docs/README.md'&&fileLinks.reads[2].context.conversationId==='fixture-file-conversation'");
  await act("fileLinks.tabsBeforeRepeat=relayWorkspacePanel.getState().tabs.length;messagesEl.querySelector('.relay-local-file-link').click();");
  await waitFor("$('workspacePreviewTitle').textContent==='D:/Synthetic/Project/main.js'");
  await check('RepeatedFileLinkReusesExistingPreviewWithoutLauncherTab', "relayWorkspacePanel.getState().tabs.length===fileLinks.tabsBeforeRepeat&&relayWorkspacePanel.getState().tabs.filter(tab=>tab.path==='D:/Synthetic/Project/main.js').length===1&&relayWorkspacePanel.getState().tabs.every(tab=>tab.path)");
  await act("messagesEl.querySelectorAll('.relay-local-file-link')[1].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:410,clientY:220}));");
  await check('ContextMenuHasExactlyThreeRequestedActions', "Array.from(document.querySelectorAll('.relay-local-file-menu button')).map(x=>x.textContent).join('|')==='在本地打开|在资源管理器中显示|复制路径'");
  await act("document.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));document.activeElement.click();");
  await waitFor("fileLinks.copied==='D:/Synthetic/Project/报告 final.pdf'");
  await check('CopyUsesResolvedAbsolutePathWithoutLineSuffix', "fileLinks.resolved[0].context.conversationId==='fixture-file-conversation'&&!document.querySelector('.relay-local-file-menu')");
  for (const [index, target] of [[0, 'system'], [1, 'reveal']]) {
    await act(`messagesEl.querySelectorAll('.relay-local-file-link')[1].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));document.querySelectorAll('.relay-local-file-menu button')[${index}].click();`);
    await waitFor(`fileLinks.opens.at(-1)?.target==='${target}'`);
    await check('Menu' + target + 'UsesCapturedLocalDestination', `RelayLocalFileLinks.parse(fileLinks.opens.at(-1).href).path==='D:/Synthetic/Project/报告 final.pdf'&&fileLinks.opens.at(-1).context.conversationId==='fixture-file-conversation'`);
  }
  await act("messagesEl.querySelectorAll('.relay-local-file-link')[1].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));window.dispatchEvent(new CustomEvent('relay:conversation-changed'));");
  await check('ConversationChangeClosesOldContextMenu', "!document.querySelector('.relay-local-file-menu')");
  await act("fileLinks.slow=true;messagesEl.querySelector('.relay-local-file-link').click();");
  await waitFor("!!fileLinks.release");
  await act("linkContext={conversationId:'different-conversation',workingDir:'D:/Other',title:'其他对话'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));fileLinks.release();");
  await evaluate('new Promise(r=>setTimeout(r,80))');
  await check('LateFileResolutionCannotOpenInAnotherConversation', "relayWorkspacePanel.getState().tabs.length===0&&relayWorkspacePanel.getState().activeId===null&&!$('workspaceNoTabs').hidden&&fileLinks.reads.at(-1).context.conversationId==='fixture-file-conversation'");
  await act("linkContext={conversationId:'fixture-file-conversation',workingDir:'D:/Synthetic/Project',title:'文件链接测试'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));fileLinks.slow=false;messagesEl.querySelector('.relay-local-file-link').click();");
  await waitFor("$('workspacePreviewTitle').textContent==='D:/Synthetic/Project/main.js'");
  await waitFor("$('workspacePreviewMeta').textContent.includes('160')&&$('workspacePreviewBody').offsetWidth>0");
  await evaluate('new Promise(r=>setTimeout(r,400))');
  await check('PreviewIsVisibleInsideRightPanel', "$('workspacePanel').getBoundingClientRect().width>=300&&$('workspacePanel').getBoundingClientRect().right<=innerWidth+2&&!$('workspacePanel').inert&&$('workspacePreviewBody').offsetWidth>0");
  fs.writeFileSync(path.join(output, 'local-file-links.png'), (await win.webContents.capturePage()).toPNG());
  await act(`messagesEl.querySelectorAll('.relay-local-file-link')[1].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));`);
  await evaluate('new Promise(r=>setTimeout(r,120))');
  fs.writeFileSync(path.join(output, 'local-file-menu.png'), (await win.webContents.capturePage()).toPNG());
  await act(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));const fixture=document.createElement('div');fixture.innerHTML='<a href="report.md">Report</a>';document.body.append(fixture);const panel=window.relayWorkspacePanel;window.relayWorkspacePanel=null;const handler=RelayLocalFileLinks.install(fixture,{context:linkContext,onError:message=>{fileLinks.missingPreviewError=message;}});fixture.querySelector('a').click();window.relayWorkspacePanel=panel;handler.destroy();fixture.remove();`);
  await check('MissingPreviewReportsAnExplicitError', "fileLinks.missingPreviewError?.includes('此窗口暂不支持文件预览')");
  await act(`
    appendMessage('assistant','[目录](<D:/Synthetic/Project/docs>)\\n\\n[不存在](<D:/Synthetic/Project/missing.md>)\\n\\n[新文件](<D:/Synthetic/Project/another.txt>)\\n\\n[等待文件](<D:/Synthetic/Project/waiting.txt>)');
    fileLinks.link=path=>Array.from(messagesEl.querySelectorAll('.relay-local-file-link')).find(link=>{const parsed=RelayLocalFileLinks.parse(link.title||link.getAttribute('href'));return parsed?.path==='D:/Synthetic/Project/'+path||parsed?.path===path;});
    fileLinks.closeTabs=()=>{for(const tab of relayWorkspacePanel.getState().tabs)document.querySelector('[data-tab-id="'+tab.id+'"] .workspace-tab-close')?.click();};
    fileLinks.closeTabs();$('workspaceClose').click();
  `);
  await waitFor("!!fileLinks.link('missing.md')&&relayWorkspacePanel.getState().tabs.length===0");
  await act("fileLinks.link('missing.md').click();");
  await waitFor("document.querySelector('.app-toast.show')?.textContent.includes('合成文件不存在')");
  await check('FailedFileLinkLeavesNoEmptyTabOrPreview', "!relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tabs.length===0&&relayWorkspacePanel.getState().activeId===null&&!$('workspaceNoTabs').hidden");
  await act("$('btnWorkspacePanel').click();$('workspaceLauncherActions').querySelector('[data-workspace-create=files]').click();");
  await waitFor("relayWorkspacePanel.getState().activeId==='files'");
  await check('ExplicitOpenFilesEntryStillCreatesItsBrowserTab', "relayWorkspacePanel.getState().tabs.length===1&&relayWorkspacePanel.getState().tabs[0].id==='files'&&!$('workspaceFiles').hidden&&$('workspacePreview').hidden");
  await act("fileLinks.link('another.txt').click();");
  await waitFor("$('workspacePreviewTitle').textContent==='D:/Synthetic/Project/another.txt'");
  await check('FileLinkPreservesAnExplicitlyOpenedFilesTab', "relayWorkspacePanel.getState().tabs.length===2&&relayWorkspacePanel.getState().tabs.filter(tab=>tab.id==='files').length===1&&relayWorkspacePanel.getState().tabs.some(tab=>tab.path==='D:/Synthetic/Project/another.txt')");
  await act("linkContext={conversationId:'explicit-files-context',workingDir:'D:/Synthetic/Project',title:'显式文件入口'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));");
  await check('ConversationSwitchRetainsPreviouslyExplicitFilesTabOnly', "relayWorkspacePanel.getState().tabs.length===1&&relayWorkspacePanel.getState().activeId==='files'&&relayWorkspacePanel.getState().tabs[0].id==='files'");
  await act("linkContext={conversationId:'fixture-file-conversation',workingDir:'D:/Synthetic/Project',title:'文件链接测试'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));fileLinks.link('another.txt').click();");
  await waitFor("$('workspacePreviewTitle').textContent==='D:/Synthetic/Project/another.txt'");
  await act("document.querySelector('[data-tab-id=files] .workspace-tab-close').click();fileLinks.link('docs/README.md').click();");
  await waitFor("$('workspacePreviewTitle').textContent==='D:/Synthetic/Project/docs/README.md'");
  await check('OpeningAFileDoesNotRecreatePreviouslyClosedFilesTab', "relayWorkspacePanel.getState().tabs.length===2&&relayWorkspacePanel.getState().tabs.every(tab=>tab.path)&&!document.querySelector('[data-tab-id=files]')");
  await act("fileLinks.link('docs').click();");
  await waitFor("relayWorkspacePanel.getState().activeId==='files'&&document.querySelector('[data-path=docs]')?.getAttribute('aria-current')==='true'");
  await check('DirectoryLinkCreatesFilesTabAndRevealsFolderWithoutFilePreview', "relayWorkspacePanel.getState().tabs.length===3&&relayWorkspacePanel.getState().tabs.filter(tab=>tab.id==='files').length===1&&$('workspacePreview').hidden&&document.querySelector('[data-path=docs]').getAttribute('aria-expanded')==='true'&&!!document.querySelector('[data-path=\"docs/README.md\"]')");
  await act("linkContext={conversationId:'fixture-file-conversation',workingDir:'D:/Synthetic/Project',title:'文件链接测试'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));fileLinks.closeTabs();$('workspaceClose').click();fileLinks.slow=true;fileLinks.release=null;fileLinks.link('waiting.txt').click();");
  await waitFor('!!fileLinks.release');
  await check('PendingFileResolutionDoesNotOpenPanelOrCreateAnEmptyFilesTab', '!relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tabs.length===0');
  await act("fileLinks.slow=false;fileLinks.link('another.txt').click();");
  await waitFor("$('workspacePreviewTitle').textContent==='D:/Synthetic/Project/another.txt'");
  await act('fileLinks.release();fileLinks.release=null;');await evaluate('new Promise(r=>setTimeout(r,80))');
  await check('LateFileResultCannotStealNewerPreviewOrAddEmptyTab', "relayWorkspacePanel.getState().tabs.length===1&&relayWorkspacePanel.getState().tabs[0].path==='D:/Synthetic/Project/another.txt'&&relayWorkspacePanel.getState().activeId===relayWorkspacePanel.getState().tabs[0].id");
  await act("fileLinks.slow=true;fileLinks.link('waiting.txt').click();");await waitFor('!!fileLinks.release');
  await check('PendingFileResolutionPreservesExistingPreviewAndTabSelection', "relayWorkspacePanel.getState().tabs.length===1&&relayWorkspacePanel.getState().activeId===relayWorkspacePanel.getState().tabs[0].id&&$('workspacePreviewTitle').textContent==='D:/Synthetic/Project/another.txt'&&!$('workspacePreview').hidden");
  await act("$('workspaceClose').click();fileLinks.slow=false;fileLinks.release();fileLinks.release=null;");await evaluate('new Promise(r=>setTimeout(r,80))');
  await check('LateFileResultDoesNotReopenClosedPanelOrAddLauncherTab', "!relayWorkspacePanel.getState().open&&relayWorkspacePanel.getState().tabs.length===1&&relayWorkspacePanel.getState().activeId===relayWorkspacePanel.getState().tabs.find(tab=>tab.path==='D:/Synthetic/Project/another.txt')?.id&&relayWorkspacePanel.getState().tabs.every(tab=>tab.path)");
  await check('NoRendererErrorsModelsOrHistoryWrites', "fileLinks.errors.length===0&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')&&typeof require==='undefined'");
  await check('IncrementalDecorationDoesNotRescanHistoryLinks', 'fileLinks.fullHistoryLinkScans===0');
  if (requests.length) throw Error('Unexpected network requests');
  save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => { failures.push(String(error.stack || error)); console.error(error.stack || error); if(win&&!win.isDestroyed())try{console.log(await evaluate('JSON.stringify(relayWorkspacePanel.getState())'));}catch(_){} save(); clearTimeout(deadline); if (win && !win.isDestroyed()) try { fs.writeFileSync(path.join(output, baseline ? 'before-failure.png' : 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) {} app.exit(1); });
