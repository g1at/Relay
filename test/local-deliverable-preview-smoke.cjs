'use strict';
// Real Relay renderer with synthetic local deliveries and an isolated profile.
// Never loads main.js, real history, a filesystem bridge, MCP, or a model.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/local-deliverable-preview-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'startup';
const checks = {}, errors = [], requests = [], screenshots = [], geometry = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, errors, requests, screenshots, geometry }, null, 2));
const deadline = setTimeout(() => { errors.push('Timed out: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
async function settle() { await evaluate('new Promise(resolve=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)),220))'); }
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`);
}
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function recordGeometry(label) {
  geometry[label] = await evaluate('deliverableProbe.cardGeometry()');
  await act(`deliverableProbe.lastGeometryAligned=deliverableProbe.cardsAlignWithComposer();
    deliverableProbe.previousScroll=messagesEl.scrollTop;
    deliverableProbe.scrollSpacer=document.createElement('div');deliverableProbe.scrollSpacer.style.height=(messagesEl.clientHeight+1000)+'px';
    messagesEl.append(deliverableProbe.scrollSpacer);messagesEl.scrollTop=0;`);
  await settle();
  geometry[label + '-scrolling'] = await evaluate('deliverableProbe.cardGeometry()');
  await act(`deliverableProbe.lastGeometryAligned=deliverableProbe.lastGeometryAligned&&deliverableProbe.cardsAlignWithComposer();
    deliverableProbe.scrollSpacer.remove();messagesEl.scrollTop=deliverableProbe.previousScroll;`);
  await settle(); save();
}
async function capture(name) {
  win.showInactive(); await settle(); win.webContents.invalidate(); await settle();
  const file = path.join(output, name + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); screenshots.push(file); save();
}
async function captureCardDetail() {
  await settle(); win.webContents.invalidate(); await settle();
  const rect = await evaluate(`(() => { const box=deliverableProbe.heading.getBoundingClientRect();
    const x=Math.max(0,Math.floor(box.left)-12),y=Math.max(0,Math.floor(box.top)-12);
    return {x,y,width:Math.min(innerWidth-x,Math.ceil(box.right)-x+12),height:Math.min(innerHeight-y,Math.ceil(box.bottom)-y+12)}; })()`);
  const file = path.join(output, 'file-card-detail.png');
  fs.writeFileSync(file, (await win.webContents.capturePage(rect)).toPNG()); screenshots.push(file); save();
}
function installFixture() {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  localStorage.clear();
  const PROJECT = 'D:/Synthetic/Project', EXTERNAL = 'E:/SyntheticDeliveries/项目 甲';
  const DOCUMENT = EXTERNAL + '/docs/IMPROVEMENT_BACKLOG.md';
  const SECOND = EXTERNAL + '/docs/实施步骤 #2 %literal.md';
  const FIGURE = EXTERNAL + '/assets/diagram.png';
  const DOCUMENT_B = EXTERNAL + '/phase-b/docs/SECOND_REPORT.md';
  const FIGURE_B = EXTERNAL + '/phase-b/assets/diagram.png';
  const probe = window.deliverableProbe = { PROJECT, EXTERNAL, DOCUMENT, SECOND, FIGURE, DOCUMENT_B, FIGURE_B,
    reads: [], opens: [], resolutions: [], lists: [], external: [], copied: [], errors: [], imageUrls: {}, heldImages: [], holdImage: null };
  probe.releaseImages = () => { probe.holdImage = null; for (const resolve of probe.heldImages.splice(0)) resolve(); };
  window.addEventListener('error', event => probe.errors.push(event.message));
  window.addEventListener('unhandledrejection', event => probe.errors.push(String(event.reason)));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { probe.copied.push(value); } } });
  probe.href = value => encodeURI(value).replace(/#/g, '%23').replace(/\?/g, '%3F');
  const normalize = value => {
    const parts = [];
    for (const part of value.replace(/\\/g, '/').split('/')) {
      if (part === '..') parts.pop(); else if (part !== '.') parts.push(part);
    }
    return parts.join('/');
  };
  const absolute = input => {
    const parsed = RelayLocalFileLinks.parse(input.href);
    if (!parsed) throw Error('Invalid synthetic local link');
    return /^[a-z]:[\\/]/i.test(parsed.path) ? normalize(parsed.path)
      : normalize((input.basePath ? input.basePath.slice(0, input.basePath.lastIndexOf('/')) : PROJECT) + '/' + parsed.path);
  };
  probe.absolute = absolute;
  const resolveLink = input => {
    const absolutePath = absolute(input);
    return { ok: true, kind: 'file', absolutePath, path: absolutePath,
      root: absolutePath.startsWith(PROJECT + '/') ? PROJECT : EXTERNAL,
      name: absolutePath.split('/').at(-1), line: RelayLocalFileLinks.parse(input.href).line };
  };
  const documentText = '# 外部交付预览（合成数据）\n\n此文档用于测试，保存在当前项目之外。\n\n'
    + '![合成示意图](../assets/diagram.png)\n\n[相邻文档](./child.md)\n\n[普通网页](https://example.com/docs)\n';
  const bitmap = file => {
    const second = file === FIGURE_B;
    const canvas = document.createElement('canvas'); canvas.width = second ? 380 : 360; canvas.height = 110;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = second ? '#e5f7eb' : '#eaf1ff'; ctx.fillRect(0, 0, canvas.width, 110);
    ctx.fillStyle = second ? '#26844a' : '#376ad6'; ctx.fillRect(24, 57, 58, 29); ctx.fillRect(100, 40, 58, 46); ctx.fillRect(176, 23, 58, 63);
    ctx.fillStyle = '#27364f'; ctx.font = '14px sans-serif'; ctx.fillText(second ? 'Synthetic B' : 'Synthetic fixture', 246, 60);
    return probe.imageUrls[file] = canvas.toDataURL('image/png');
  };
  const workspace = {
    resolve: async context => ({ ok: true, root: context.workingDir || PROJECT }),
    list: async input => { probe.lists.push(clone(input)); return { ok: true, entries: [
      { name: 'project-note.md', path: 'project-note.md', type: 'file', size: 32 },
    ] }; },
    resolveLink: async input => { probe.resolutions.push(clone(input)); return resolveLink(input); },
    readLink: async input => {
      probe.reads.push(clone(input)); const resolved = resolveLink(input);
      if ([FIGURE, FIGURE_B].includes(resolved.absolutePath)) {
        if (probe.holdImage === resolved.absolutePath) await new Promise(resolve => probe.heldImages.push(resolve));
        return { ...resolved, binary: true, dataUrl: bitmap(resolved.absolutePath) };
      }
      return { ...resolved, binary: false, content: resolved.absolutePath === DOCUMENT ? documentText
        : resolved.absolutePath === DOCUMENT_B ? '# 文档 B（合成数据）\n\n![合成 B 图](../assets/diagram.png)'
        : resolved.absolutePath.endsWith('/child.md') ? '# 相邻文档（合成数据）\n\n外部文档目录解析正确。'
          : '# 合成文件\n\n' + resolved.name };
    },
    openLink: async input => { probe.opens.push(clone(input)); return { ok: true }; },
    open: async input => { probe.opens.push({ ...clone(input), legacy: true }); return { ok: true, target: 'relay' }; },
    onTerminalEvent: () => () => {}, onRuntimeChanged: () => () => {},
  };
  window.api = new Proxy(base, { get(target, key) {
    if (key === 'workspace') return workspace;
    if (key === 'openExternal') return async href => { probe.external.push(href); return { ok: true }; };
    return target[key];
  } });
  probe.card = anchor => anchor?.matches('.relay-file-card') ? anchor : anchor?.closest('.relay-file-card') || anchor?.querySelector('.relay-file-card');
  probe.fits = node => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.left >= -1 && rect.right <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 2;
  };
  probe.cardGeometry = () => {
    const rect = node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    const composer = rect(document.getElementById('inputCard'));
    return { viewportWidth: innerWidth, rightPanelOpen: window.relayWorkspacePanel.getState().open, composer,
      messageViewport: { width: messagesEl.clientWidth, scrollbarWidth: messagesEl.offsetWidth - messagesEl.clientWidth,
        hasVerticalOverflow: messagesEl.scrollHeight > messagesEl.clientHeight },
      cards: [probe.heading, probe.standalone].map(anchor => {
        const card = probe.card(anchor), bounds = rect(card);
        return { ...bounds, fits: probe.fits(card),
          deltaLeft: bounds.left - composer.left, deltaRight: bounds.right - composer.right, deltaWidth: bounds.width - composer.width };
      }) };
  };
  probe.cardsAlignWithComposer = () => {
    const measured = probe.cardGeometry();
    return measured.composer.width > 0 && measured.cards.every(card => card.fits
      && Math.abs(card.deltaLeft) <= 1 && Math.abs(card.deltaRight) <= 1 && Math.abs(card.deltaWidth) <= 1);
  };
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const network = /^https?:/i.test(details.url); if (network) requests.push(details.url); done({ cancel: network });
  });
  const base = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="'
    + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + base + '\n(' + installFixture.toString() + ')();</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1380, height: 960, show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
  } });
  await win.loadFile(page); win.showInactive();
  await waitFor('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await act(`window.deliverableContext={conversationId:'deliverable-fixture',projectId:'synthetic-project',workingDir:deliverableProbe.PROJECT,title:'交付预览测试（合成数据）'};
    window.relayConversationWorkspace=()=>({...deliverableContext});window.dispatchEvent(new CustomEvent('relay:conversation-changed'));
    messagesEl.replaceChildren();
    const doc=deliverableProbe.href(deliverableProbe.DOCUMENT),second=deliverableProbe.href(deliverableProbe.SECOND);
    deliverableProbe.message=appendMessage('assistant','已生成改进事项清单。以下均为独立测试数据。\\n\\n# [IMPROVEMENT_BACKLOG.md](<'+doc+'>)\\n\\n[实施步骤](<'+second+'>)\\n\\n正文中参考 [项目说明](<D:/Synthetic/Project/project-note.md>)，或阅读 [官方文档](https://example.com/docs)。\\n\\n[main.js:12](<D:/Synthetic/Project/main.js:12>)');
    deliverableProbe.body=deliverableProbe.message.querySelector('.body');
    deliverableProbe.heading=deliverableProbe.body.querySelector('h1 a');
    deliverableProbe.standalone=[...deliverableProbe.body.querySelectorAll('p a')][0];
    deliverableProbe.inline=[...deliverableProbe.body.querySelectorAll('p a')][1];
    deliverableProbe.web=deliverableProbe.body.querySelector('a[href="https://example.com/docs"]');`);
  await waitFor("deliverableProbe.heading.classList.contains('relay-local-file-link')");
  await check('StandaloneHeadingAndParagraphBecomeFileCards', "!!deliverableProbe.card(deliverableProbe.heading)&&!!deliverableProbe.card(deliverableProbe.standalone)&&deliverableProbe.body.querySelectorAll('.relay-file-card').length===2");
  await check('InlineReferencesRemainCompactAndHttpsRemainsOrdinary', "!deliverableProbe.card(deliverableProbe.inline)&&deliverableProbe.inline.classList.contains('relay-local-file-link')&&!deliverableProbe.card(deliverableProbe.web)&&!deliverableProbe.web.classList.contains('relay-local-file-link')&&deliverableProbe.web.getAttribute('href')==='https://example.com/docs'");
  await check('StandaloneSourceLineReferenceStaysCompact', "[...deliverableProbe.body.querySelectorAll('a')].some(anchor=>anchor.textContent.includes('main.js:12')&&anchor.classList.contains('relay-local-file-link')&&!deliverableProbe.card(anchor))");
  await check('HeadingCardKeepsAccessibleNativeLinkAndNormalTextSize', "deliverableProbe.heading.tagName==='A'&&deliverableProbe.heading.tabIndex===0&&deliverableProbe.heading.textContent.includes('IMPROVEMENT_BACKLOG.md')&&parseFloat(getComputedStyle(deliverableProbe.heading).fontSize)<=17");
  await check('FileCardExposesFileNameLocationTypeAndPreviewAction', "deliverableProbe.heading.querySelector('.relay-file-card-name')?.textContent==='IMPROVEMENT_BACKLOG.md'&&deliverableProbe.heading.querySelector('.relay-file-card-meta')?.textContent.includes('docs')&&deliverableProbe.heading.querySelector('.relay-file-card-action')?.textContent.includes('预览')&&deliverableProbe.heading.querySelectorAll('.relay-file-card-icon .relay-local-file-icon').length===1");
  for (const [width, theme] of [[1380, 'light'], [1380, 'dark'], [760, 'light'], [760, 'dark']]) {
    win.setSize(width, 960);
    await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.body.dataset.theme=${JSON.stringify(theme)};messagesEl.scrollTop=0;`);
    await settle();
    await recordGeometry('panel-closed-' + width + '-' + theme);
    await check('FileCardsAlignWithComposer' + width + theme, "deliverableProbe.lastGeometryAligned&&deliverableProbe.cardsAlignWithComposer()&&document.documentElement.scrollWidth<=innerWidth+1");
    await capture('file-cards-' + width + '-' + theme);
    if (width === 1380 && theme === 'light') await captureCardDetail();
  }
  win.setSize(1380, 960); await act("document.documentElement.dataset.theme='light';document.body.dataset.theme='light';deliverableProbe.heading.focus();"); await settle();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor("$('workspacePreviewBody').querySelector('h1')?.textContent==='外部交付预览（合成数据）'");
  await check('KeyboardEnterOpensExternalDocumentInRightPreview', "$('workspacePreviewTitle').textContent===deliverableProbe.DOCUMENT&&relayWorkspacePanel.getState().open&&!$('workspacePreview').hidden&&deliverableProbe.opens.length===0&&deliverableProbe.reads[0].context.conversationId==='deliverable-fixture'");
  await waitFor("$('workspacePreviewBody').querySelector('img')?.naturalWidth===360");
  await check('ExternalMarkdownRelativeImageUsesDocumentParent', "deliverableProbe.reads.some(input=>deliverableProbe.absolute(input)===deliverableProbe.FIGURE&&input.basePath===deliverableProbe.DOCUMENT)&&$('workspacePreviewBody').querySelector('img').src.startsWith('data:image/png;base64,')");
  await settle(); await recordGeometry('panel-open-1380-light');
  await check('ExternalPreviewKeepsSelectedProjectAndItsFileTree', "deliverableContext.workingDir===deliverableProbe.PROJECT&&deliverableContext.projectId==='synthetic-project'&&$('workspaceRootPath').textContent===deliverableProbe.PROJECT&&deliverableProbe.lists.every(input=>input.context.workingDir===deliverableProbe.PROJECT&&!input.directoryLink)&&deliverableProbe.lastGeometryAligned&&deliverableProbe.cardsAlignWithComposer()");
  await capture('external-preview-wide-light');
  win.setSize(760, 960); await act("document.documentElement.dataset.theme='dark';document.body.dataset.theme='dark';"); await settle();
  await recordGeometry('panel-open-760-dark');
  await check('ExternalPreviewRemainsVisibleAndBoundedOnNarrowScreen', "$('workspacePanel').getBoundingClientRect().right<=innerWidth+1&&$('workspacePreviewBody').getBoundingClientRect().width>0&&!$('workspacePanel').inert&&document.documentElement.scrollWidth<=innerWidth+1&&deliverableProbe.lastGeometryAligned&&deliverableProbe.cardsAlignWithComposer()");
  await capture('external-preview-narrow-dark');
  await act("[...$('workspacePreviewBody').querySelectorAll('a')].find(node=>node.textContent.includes('相邻文档')).click();");
  await waitFor("$('workspacePreviewBody').querySelector('h1')?.textContent==='相邻文档（合成数据）'");
  await check('ExternalMarkdownRelativeFileUsesCapturedDocumentBase', "deliverableProbe.reads.some(input=>input.href==='./child.md'&&input.basePath===deliverableProbe.DOCUMENT&&input.context.projectId==='synthetic-project')&&$('workspacePreviewTitle').textContent===deliverableProbe.EXTERNAL+'/docs/child.md'");
  await act("deliverableProbe.holdImage=deliverableProbe.FIGURE;void relayWorkspacePanel.openFileLink({href:deliverableProbe.href(deliverableProbe.DOCUMENT),context:{...deliverableContext}});");
  await waitFor('deliverableProbe.heldImages.length>0');
  await check('LifecycleFixtureHoldsDocumentAImageBeforeItLoads', "$('workspacePreviewTitle').textContent===deliverableProbe.DOCUMENT&&!$('workspacePreviewBody').querySelector('img')");
  await act("void relayWorkspacePanel.openFileLink({href:deliverableProbe.href(deliverableProbe.DOCUMENT_B),context:{...deliverableContext}});");
  await waitFor("$('workspacePreviewBody').querySelector('img')?.naturalWidth===380");
  await check('SameConversationDocumentBResolvesIdenticalRelativeImageFromItsOwnDirectory', "$('workspacePreviewTitle').textContent===deliverableProbe.DOCUMENT_B&&deliverableProbe.reads.some(input=>input.href==='../assets/diagram.png'&&input.basePath===deliverableProbe.DOCUMENT_B&&input.context.conversationId==='deliverable-fixture')&&$('workspacePreviewBody').querySelector('img').src===deliverableProbe.imageUrls[deliverableProbe.FIGURE_B]");
  await act('deliverableProbe.releaseImages();'); await settle();
  await check('LateDocumentAImageCannotReplaceDocumentBImage', "$('workspacePreviewTitle').textContent===deliverableProbe.DOCUMENT_B&&$('workspacePreviewBody').querySelectorAll('img').length===1&&$('workspacePreviewBody').querySelector('img').naturalWidth===380&&$('workspacePreviewBody').querySelector('img').src===deliverableProbe.imageUrls[deliverableProbe.FIGURE_B]&&deliverableProbe.imageUrls[deliverableProbe.FIGURE]!==deliverableProbe.imageUrls[deliverableProbe.FIGURE_B]");
  await act("deliverableProbe.holdImage=deliverableProbe.FIGURE;void relayWorkspacePanel.openFileLink({href:deliverableProbe.href(deliverableProbe.DOCUMENT),context:{...deliverableContext}});");
  await waitFor('deliverableProbe.heldImages.length>0');
  await act("$('workspacePreviewMode').click();");
  await waitFor("$('workspacePreviewBody').classList.contains('is-source')");
  await act('deliverableProbe.releaseImages();'); await settle();
  await check('SwitchingToSourcePreventsLateImageFromMounting', "$('workspacePreviewTitle').textContent===deliverableProbe.DOCUMENT&&$('workspacePreviewBody').classList.contains('is-source')&&!$('workspacePreviewBody').querySelector('img')&&$('workspacePreviewBody').textContent.includes('../assets/diagram.png')&&$('workspacePreviewMode').getAttribute('aria-pressed')==='true'");
  await act("relayWorkspacePanel.close();deliverableProbe.standalone.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:260,clientY:260}));");
  await check('FileCardContextMenuKeepsExactlyThreeLocalActions', "[...document.querySelectorAll('.relay-local-file-menu button')].map(node=>node.textContent).join('|')==='在本地打开|在资源管理器中显示|复制路径'");
  await act("document.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));document.activeElement.click();");
  await waitFor('deliverableProbe.copied.length===1');
  await check('CopyPathPreservesReservedCharactersAndCapturedContext', "deliverableProbe.copied[0]===deliverableProbe.SECOND&&deliverableProbe.resolutions[0].context.conversationId==='deliverable-fixture'&&!document.querySelector('.relay-local-file-menu')");
  for (const [index, target] of [[0, 'system'], [1, 'reveal']]) {
    await act(`deliverableProbe.standalone.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));document.querySelectorAll('.relay-local-file-menu button')[${index}].click();`);
    await waitFor(`deliverableProbe.opens.at(-1)?.target===${JSON.stringify(target)}`);
    await check('CardMenu' + target + 'TargetsOriginalExternalFile', "deliverableProbe.absolute(deliverableProbe.opens.at(-1))===deliverableProbe.SECOND&&deliverableProbe.opens.at(-1).context.projectId==='synthetic-project'");
  }
  await act(`const handler=RelayLocalFileLinks.install(messagesEl,{context:()=>({...deliverableContext})});
    for(let i=0;i<5;i++)handler.decorate();deliverableProbe.handler=handler;`);
  await settle();
  await check('RepeatedDecorationDoesNotDuplicateCardsIconsOrLabels', "deliverableProbe.body.querySelectorAll('.relay-file-card').length===2&&deliverableProbe.heading.querySelectorAll('.relay-local-file-icon').length===1&&deliverableProbe.heading.querySelectorAll('.relay-file-card-name').length===1&&deliverableProbe.heading.querySelector('.relay-file-card-name').textContent==='IMPROVEMENT_BACKLOG.md'");
  await act("deliverableProbe.heading.setAttribute('href',deliverableProbe.href(deliverableProbe.SECOND));"); await settle();
  await check('ChangedHrefUpdatesCardWithoutDuplicatingDecoration', "deliverableProbe.heading.getAttribute('title').includes('实施步骤 #2 %literal.md')&&deliverableProbe.heading.querySelector('.relay-file-card-name')?.textContent==='实施步骤 #2 %literal.md'&&deliverableProbe.body.querySelectorAll('.relay-file-card').length===2&&deliverableProbe.heading.querySelectorAll('.relay-local-file-icon').length===1");
  await act("deliverableProbe.heading.click();"); await waitFor("$('workspacePreviewTitle').textContent===deliverableProbe.SECOND");
  await check('ChangedHrefNavigatesToLatestTarget', 'deliverableProbe.absolute(deliverableProbe.reads.at(-1))===deliverableProbe.SECOND');
  await act("deliverableProbe.heading.setAttribute('href','https://example.com/changed');"); await settle();
  await check('ChangingLocalHrefToHttpsRemovesFileCardAndLocalDecoration', "!deliverableProbe.card(deliverableProbe.heading)&&!deliverableProbe.heading.classList.contains('relay-local-file-link')&&!deliverableProbe.heading.hasAttribute('data-relay-file-link')&&!deliverableProbe.heading.querySelector('.relay-local-file-icon')&&deliverableProbe.heading.getAttribute('href')==='https://example.com/changed'");
  await act(`relayWorkspacePanel.close();deliverableProbe.stream=appendMessage('assistant','',{streaming:true});
    deliverableProbe.streamBody=deliverableProbe.stream.querySelector('.body');
    deliverableProbe.streamText='[流式交付](<'+deliverableProbe.href(deliverableProbe.DOCUMENT)+'>)';
    streamMarkdownRenderer.render(deliverableProbe.streamBody,deliverableProbe.streamText);`); await settle();
  await check('StreamingCompletedLinkGetsOneCard', "deliverableProbe.streamBody.querySelectorAll('.relay-file-card').length===1");
  await act("streamMarkdownRenderer.render(deliverableProbe.streamBody,deliverableProbe.streamText+'\\n\\n补充说明。');streamMarkdownRenderer.render(deliverableProbe.streamBody,deliverableProbe.streamText+'\\n\\n补充说明。');"); await settle();
  await check('StreamingRepeatedUpdatesKeepOneCard', "deliverableProbe.streamBody.querySelectorAll('.relay-file-card').length===1&&deliverableProbe.streamBody.querySelectorAll('.relay-local-file-icon').length===1");
  await act("streamMarkdownRenderer.render(deliverableProbe.streamBody,deliverableProbe.streamText+' 是本段引用的文件，正文继续。');"); await settle();
  await check('StreamingSentenceContinuationDowngradesCardToCompactLink', "deliverableProbe.streamBody.querySelectorAll('.relay-file-card').length===0&&deliverableProbe.streamBody.querySelectorAll('.relay-local-file-icon').length===1&&deliverableProbe.streamBody.textContent.includes('正文继续')");
  await check('NoRendererErrorsNetworkModelsOrHistoryWrites', "deliverableProbe.errors.length===0&&uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')");
  if (requests.length) throw Error('Unexpected network requests');
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  errors.push(String(error.stack || error)); console.error(error.stack || error); save(); clearTimeout(deadline);
  if (win && !win.isDestroyed()) try {
    const diagnostic = await evaluate(`(() => { const p=window.deliverableProbe;
      return {state:window.relayWorkspacePanel?.getState(),root:document.getElementById('workspaceRootPath')?.textContent,
        heading:p?.heading?.outerHTML,standalone:p?.standalone?.outerHTML,reads:p?.reads,errors:p?.errors,
        panel:document.getElementById('workspacePanel')?.getBoundingClientRect().toJSON()}; })()`);
    fs.writeFileSync(path.join(output, 'diagnostic.json'), JSON.stringify(diagnostic, null, 2));
    fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
  } catch (_) {}
  app.exit(1);
});
