'use strict';
// Real renderer, isolated Electron profile and synthetic workspace bridge only.
// No main process, user history, filesystem bridge, network or model is started.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/directory-links-smoke');
const baseline = process.argv.includes('--baseline'), visualOnly = process.argv.includes('--visual');
const suffix = baseline ? 'before' : visualOnly ? 'visual' : 'result';
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, baseline ? 'baseline-profile' : 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'startup';
const checks = {}, errors = [], requests = [];
const save = () => fs.writeFileSync(path.join(output, suffix + '.json'), JSON.stringify({ baseline, step, checks, errors, requests }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout'); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
async function settle() { await evaluate('new Promise(resolve=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)),350))'); }
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`);
}
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }
async function click(label) { await act(`directoryProbe.link(${JSON.stringify(label)}).click();`); }
async function hold(kind, key) { await act(`directoryProbe.hold={kind:${JSON.stringify(kind)},key:${JSON.stringify(key)},readCount:directoryProbe.reads.length};directoryProbe.release=null;`); }
async function release() { await act('directoryProbe.release();directoryProbe.release=null;'); await settle(); }
function installDirectoryFixture() {
  const base = window.api;
  localStorage.clear();
  localStorage.setItem('relay.workspace-file-layout.v1', JSON.stringify({ version: 1, width: 250, collapsed: true }));
  const PROJECT = 'D:/Synthetic/Project', SCRATCH = 'D:/Synthetic/Scratch/conv/deliveries/交付目录';
  const ESCAPED = 'D:/Synthetic/Scratch/conv/run#2 %20literal';
  const nested = 'reports/嵌套目录', clone = value => JSON.parse(JSON.stringify(value));
  const probe = window.directoryProbe = { reads: [], lists: [], opens: [], errors: [], hold: null, release: null, PROJECT, SCRATCH, ESCAPED, nested };
  window.addEventListener('error', event => probe.errors.push(event.message));
  window.addEventListener('unhandledrejection', event => probe.errors.push(String(event.reason)));
  const file = name => ({ name, path: name, type: 'file', size: 30 });
  const folder = (name, parent = '') => ({ name, path: parent ? parent + '/' + name : name, type: 'directory' });
  const fillers = prefix => Array.from({ length: 45 }, (_, i) => file(prefix + 'entry-' + String(i).padStart(2, '0') + '.txt'));
  const trees = {
    '': [...fillers(''), folder('reports'), file('keep.md'), file('tree-note.md'), folder('assets')],
    reports: [...fillers('reports/'), folder('嵌套目录', 'reports'), folder('其他目录', 'reports'), folder('obsolete', 'reports')],
    [nested]: [{ ...file('child.md'), path: nested + '/child.md' }, folder('deep', nested)],
    'reports/其他目录': [{ ...file('alternate.txt'), path: 'reports/其他目录/alternate.txt' }],
  };
  const pause = async (kind, key) => {
    if (probe.hold?.kind !== kind || probe.hold.key !== key) return;
    // Periodic tree refreshes share this bridge. Hold only the new directory
    // navigation's listing, after its readLink request.
    if (kind === 'list' && probe.reads.length <= probe.hold.readCount) return;
    probe.hold = null;
    await new Promise(resolve => { probe.release = resolve; });
  };
  const absolute = input => {
    const parsed = RelayLocalFileLinks.parse(input.href);
    if (!parsed) throw Error('Invalid synthetic link');
    return /^[A-Z]:/i.test(parsed.path) ? parsed.path : PROJECT + '/' + parsed.path.replace(/^\.\//, '');
  };
  const resolveLink = input => {
    const absolutePath = absolute(input), name = absolutePath.split('/').at(-1);
    if (absolutePath.endsWith('/missing')) return { ok: false, error: '合成目录已不存在' };
    const isScratch = absolutePath === SCRATCH || absolutePath === ESCAPED, relativePath = absolutePath === PROJECT ? '' : absolutePath.slice(PROJECT.length + 1);
    if (isScratch || Object.hasOwn(trees, relativePath)) return { ok: true, kind: 'directory', root: isScratch ? 'D:/Synthetic/Scratch/conv' : PROJECT,
      relativePath: isScratch ? 'deliveries/交付目录' : relativePath, path: absolutePath, absolutePath, name, line: null };
    return { ok: true, kind: 'file', root: absolutePath.startsWith(SCRATCH) ? 'D:/Synthetic/Scratch/conv' : PROJECT,
      relativePath, path: absolutePath, absolutePath, name, line: RelayLocalFileLinks.parse(input.href).line,
      binary: false, content: '# Synthetic preview\n\n' + name + '\n\n[Child directory](reports/嵌套目录)' };
  };
  const workspace = {
    resolve: async context => ({ ok: true, root: context.workingDir || PROJECT }),
    list: async input => {
      probe.lists.push(clone(input)); await pause('list', input.path || '');
      if (input.directoryLink) {
        const linkPath = RelayLocalFileLinks.parse(input.directoryLink.href)?.path;
        if (![SCRATCH, ESCAPED].includes(linkPath) || input.context?.conversationId !== 'directory-fixture') throw Error('Unexpected synthetic directory scope');
        return { ok: true, entries: input.path ? [] : [file(linkPath === ESCAPED ? 'report#final %20.md' : 'artifact.md'), folder('data')] };
      }
      if (probe.missingDirectory === input.path) return { ok: false, error: 'Synthetic directory removed' };
      return { ok: true, entries: trees[input.path || ''] || [] };
    },
    readLink: async input => { probe.reads.push(clone(input)); await pause('read', absolute(input)); return resolveLink(input); },
    resolveLink: async input => resolveLink(input),
    read: async input => { probe.reads.push({ ...clone(input), legacy: true }); return { ok: true, path: input.path, content: '# Tree file\n\n' + input.path, binary: false }; },
    open: async input => { probe.opens.push({ ...clone(input), legacy: true }); return { ok: true, target: 'relay' }; },
    openLink: async input => { probe.opens.push(clone(input)); return { ok: true, target: 'relay' }; },
    onTerminalEvent: () => () => {},
    onRuntimeChanged: listener => { probe.runtimeListener = listener; return () => {}; },
  };
  window.api = new Proxy(base, { get(target, key) { return key === 'workspace' ? workspace : target[key]; } });
  // File cards also show type/location/action text. Locate the original link
  // label through its accessible description instead of the whole card text.
  probe.link = label => [...document.querySelectorAll('#messages .relay-local-file-link')]
    .find(node => node.textContent === label || node.getAttribute('aria-label')?.endsWith('，' + label));
  probe.row = value => [...document.querySelectorAll('.workspace-file-row')].find(node => node.dataset.path === value);
  probe.visible = node => {
    if (!node || node.closest('[inert]')) return false;
    const rect = node.getBoundingClientRect(), viewport = document.getElementById('workspaceFileTree').getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1;
  };
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const network = /^https?:/i.test(details.url); if (network) requests.push(details.url); done({ cancel: network });
  });
  const base = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  let page = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  page = page.replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + base + '\n(' + installDirectoryFixture.toString() + ')();</script>');
  if (baseline) {
    const snapshot = path.join(output, 'baseline-workspace-panel.js');
    if (!fs.existsSync(snapshot)) fs.copyFileSync(path.join(root, 'renderer/workspace-panel.js'), snapshot);
    page = page.replace(/<script\b[^>]*src="workspace-panel\.js"[^>]*><\/script>/, '<script src="' + pathToFileURL(snapshot).href + '"></script>');
    if (!page.includes(pathToFileURL(snapshot).href)) throw Error('Baseline panel script was not replaced');
  }
  const pagePath = path.join(output, suffix + '-fixture.html'); fs.writeFileSync(pagePath, page);
  win = new BrowserWindow({ width: 1350, height: 900, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(pagePath);
  win.showInactive();
  await waitFor('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await act(`window.directoryContext={conversationId:'directory-fixture',workingDir:'D:/Synthetic/Project',title:'目录链接测试'};
    window.relayConversationWorkspace=()=>({...directoryContext});window.dispatchEvent(new CustomEvent('relay:conversation-changed'));
    messagesEl.replaceChildren();appendMessage('assistant','[Keep](<D:/Synthetic/Project/keep.md>)\\n\\n[Nested](<D:/Synthetic/Project/reports/嵌套目录>)\\n\\n[Root](<D:/Synthetic/Project>)\\n\\n[Other](<D:/Synthetic/Project/reports/其他目录>)\\n\\n[Scratch](<D:/Synthetic/Scratch/conv/deliveries/交付目录>)\\n\\n[EncodedScratch](<D:/Synthetic/Scratch/conv/run%232%20%2520literal>)\\n\\n[Missing](<D:/Synthetic/Project/missing>)');`);
  await waitFor("!!directoryProbe.link('Nested')");
  await click('Keep'); await waitFor("$('workspacePreviewTitle').textContent==='D:/Synthetic/Project/keep.md'"); await settle();
  await check('FileLinksStillCreateReadablePreview', "!$('workspacePreview').hidden&&$('workspacePreviewBody').textContent.includes('Synthetic preview')&&relayWorkspacePanel.getState().tabs.filter(t=>t.path).length===1");
  await act("$('workspaceMaximize').click();$('workspaceFileFilter').value='no-matching-files';$('workspaceFileFilter').dispatchEvent(new Event('input',{bubbles:true}));");
  await settle();
  await check('FixtureStartsWithCollapsedTreeAndExistingPreview', 'relayWorkspaceFileLayout.getState().collapsed&&relayWorkspaceFileLayout.getState().width===0');
  await click('Nested'); await waitFor('directoryProbe.reads.length===2'); await settle();
  await check('DirectoryDoesNotBecomeFilePreview', "relayWorkspacePanel.getState().activeId==='files'&&$('workspacePreview').hidden&&relayWorkspacePanel.getState().tabs.filter(t=>t.path).length===1");
  await waitFor("!!directoryProbe.row('reports/嵌套目录/child.md')");
  await check('DirectoryLinkExpandsAncestorsAndTarget', "directoryProbe.row('reports').getAttribute('aria-expanded')==='true'&&directoryProbe.row('reports/嵌套目录').getAttribute('aria-expanded')==='true'");
  await check('DirectoryLinkClearsFilterSelectsAndScrollsToTarget', "$('workspaceFileFilter').value===''&&directoryProbe.row(directoryProbe.nested).getAttribute('aria-current')==='true'&&directoryProbe.visible(directoryProbe.row(directoryProbe.nested))&&$('workspaceFileTree').scrollTop>0");
  await check('DirectoryLinkRevealsCollapsedTree', "!$('workspaceTreePane').inert&&$('workspaceTreePane').getBoundingClientRect().width>=160");
  await check('DirectoryNavigationKeepsOldPreviewTab', "relayWorkspacePanel.getState().tabs.some(t=>t.path==='D:/Synthetic/Project/keep.md')&&directoryProbe.opens.length===0");
  // Hidden native windows can capture an obsolete compositor frame despite
  // correct DOM geometry. Paint the isolated fixture without taking focus.
  win.showInactive(); await settle();
  fs.writeFileSync(path.join(output, 'nested-directory-visible.png'), (await win.webContents.capturePage()).toPNG());
  if (visualOnly) { step = 'visual-completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0); return; }
  await act("$('workspaceMaximize').click()"); await settle();
  await click('Nested'); await settle();
  await check('NarrowPanelKeepsSelectedDirectoryVisible', "relayWorkspaceFileLayout.getState().narrow&&directoryProbe.visible(directoryProbe.row(directoryProbe.nested))&&!$('workspaceTreePane').inert&&$('workspacePanel').getBoundingClientRect().right<=innerWidth+1");
  await click('Root'); await settle();
  await check('RootDirectoryLinkSelectsRootWithoutPreview', "relayWorkspacePanel.getState().activeId==='files'&&$('workspaceRootPath').textContent===directoryProbe.PROJECT&&$('workspaceRootPath').getAttribute('aria-current')==='true'&&$('workspacePreview').hidden&&!!directoryProbe.row('keep.md')");
  await click('Keep'); await settle();
  await check('ExistingPreviewTabRemainsUsableAfterDirectoryNavigation', "$('workspacePreviewTitle').textContent===directoryProbe.PROJECT+'/keep.md'&&!$('workspacePreview').hidden&&relayWorkspacePanel.getState().tabs.filter(t=>t.path).length===1");

  await hold('read', 'D:/Synthetic/Project/reports/嵌套目录'); await click('Nested'); await waitFor('!!directoryProbe.release');
  await click('Keep'); await settle(); await release();
  await check('LateDirectoryResolutionCannotStealNewFileNavigation', "relayWorkspacePanel.getState().tabs.find(t=>t.id===relayWorkspacePanel.getState().activeId)?.path===directoryProbe.PROJECT+'/keep.md'&&!$('workspacePreview').hidden");
  await hold('read', 'D:/Synthetic/Project/reports/嵌套目录'); await click('Nested'); await waitFor('!!directoryProbe.release');
  await act("$('workspaceClose').click()"); await release();
  await check('LateDirectoryResolutionCannotReopenClosedPanel', "!relayWorkspacePanel.getState().open&&$('workspacePanel').inert");
  await hold('read', 'D:/Synthetic/Project/reports/嵌套目录'); await click('Nested'); await waitFor('!!directoryProbe.release');
  await act("directoryContext={conversationId:'other-directory-fixture',workingDir:'D:/Synthetic/Other',title:'其他任务'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));"); await release();
  await check('LateDirectoryResolutionCannotReturnToOldConversation', "!relayWorkspacePanel.getState().open&&$('workspacePanel').inert&&relayWorkspacePanel.getState().tabs.every(t=>!t.path)&&!directoryProbe.row(directoryProbe.nested)?.hasAttribute('aria-current')");
  await act("relayWorkspacePanel.open('files')"); await settle();
  await check('ExplicitReopenLoadsTheNewConversationDirectory', "relayWorkspacePanel.getState().open&&$('workspaceRootPath').textContent==='D:/Synthetic/Other'&&relayWorkspacePanel.getState().tabs.length===1&&relayWorkspacePanel.getState().activeId==='files'");
  await act("directoryContext={conversationId:'directory-fixture',workingDir:'D:/Synthetic/Project',title:'目录链接测试'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));");
  await click('Keep'); await settle();
  await hold('list', 'reports/嵌套目录'); await click('Nested'); await waitFor('!!directoryProbe.release');
  await click('Keep'); await settle(); await release();
  await check('LateDirectoryListingCannotStealNewFileNavigation', "relayWorkspacePanel.getState().tabs.find(t=>t.id===relayWorkspacePanel.getState().activeId)?.path===directoryProbe.PROJECT+'/keep.md'&&!$('workspacePreview').hidden");

  await click('Scratch'); await settle();
  await waitFor("$('workspaceRootPath').textContent===directoryProbe.SCRATCH&&!!directoryProbe.row('artifact.md')");
  await check('AuthorizedScratchDirectoryUsesScopedTemporaryTree', "relayWorkspacePanel.getState().activeId==='files'&&directoryProbe.lists.some(x=>RelayLocalFileLinks.parse(x.directoryLink?.href)?.path===directoryProbe.SCRATCH&&x.path==='')&&directoryProbe.lists.filter(x=>x.directoryLink).every(x=>x.context.conversationId==='directory-fixture'&&!x.context.roots)&&$('workspacePreview').hidden");
  await act("$('workspaceRootOpen').click()"); await waitFor('directoryProbe.opens.length>0');
  await check('TemporaryTreeRootOpenUsesValidatedAbsoluteLink', "RelayLocalFileLinks.parse(directoryProbe.opens.at(-1).href)?.path===directoryProbe.SCRATCH&&!directoryProbe.opens.at(-1).legacy&&directoryProbe.opens.at(-1).context.conversationId==='directory-fixture'");
  await act("directoryProbe.row('artifact.md').click()"); await settle();
  await check('TemporaryTreeChildFileUsesAbsoluteReadLink', "RelayLocalFileLinks.parse(directoryProbe.reads.at(-1).href)?.path===directoryProbe.SCRATCH+'/artifact.md'&&!directoryProbe.reads.at(-1).legacy&&!$('workspacePreview').hidden&&$('workspacePreviewTitle').textContent===directoryProbe.SCRATCH+'/artifact.md'");
  await click('Root'); await settle();
  await check('ProjectDirectoryRestoresNormalTreeAndRetainsPreviews', "$('workspaceRootPath').textContent===directoryProbe.PROJECT&&!!directoryProbe.row('keep.md')&&relayWorkspacePanel.getState().tabs.some(t=>t.path===directoryProbe.SCRATCH+'/artifact.md')&&relayWorkspacePanel.getState().tabs.some(t=>t.path===directoryProbe.PROJECT+'/keep.md')&&!directoryProbe.lists.at(-1).directoryLink");

  await act("directoryProbe.row('tree-note.md').click()"); await waitFor("$('workspacePreviewTitle').textContent==='tree-note.md'");
  await act("directoryProbe.oldTreeTab=relayWorkspacePanel.getState().activeId");
  await click('Scratch'); await settle();
  await act("document.querySelector('[data-tab-id=\"'+directoryProbe.oldTreeTab+'\"] .workspace-tab').click();$('workspacePreviewOpen').click()");
  await waitFor("RelayLocalFileLinks.parse(directoryProbe.opens.at(-1).href)?.path===directoryProbe.PROJECT+'/tree-note.md'");
  await check('OldProjectTreePreviewKeepsItsOriginalOpenTarget', "!directoryProbe.opens.at(-1).legacy&&RelayLocalFileLinks.parse(directoryProbe.opens.at(-1).href)?.path===directoryProbe.PROJECT+'/tree-note.md'");
  await act("$('workspaceRefresh').click()"); await settle();
  await check('OldProjectTreePreviewKeepsItsOriginalRefreshTarget', "RelayLocalFileLinks.parse(directoryProbe.reads.at(-1).href)?.path===directoryProbe.PROJECT+'/tree-note.md'&&$('workspacePreviewTitle').textContent===directoryProbe.PROJECT+'/tree-note.md'");
  await click('Scratch'); await settle();
  await act("directoryProbe.runtimeListener({conversationId:'directory-fixture'})"); await settle();
  await check('RuntimeChangeClearsTemporaryDirectoryScope', "$('workspaceRootPath').textContent===directoryProbe.PROJECT&&!!directoryProbe.row('tree-note.md')&&!directoryProbe.row('artifact.md')&&!directoryProbe.lists.at(-1).directoryLink");

  await click('Nested'); await settle();
  await hold('read', 'D:/Synthetic/Project/reports/嵌套目录'); await click('Nested'); await waitFor('!!directoryProbe.release');
  await act("directoryProbe.row('reports/其他目录').click()"); await release();
  await check('LateDirectoryLinkCannotOverrideManualTreeSelection', "directoryProbe.row('reports/其他目录').getAttribute('aria-current')==='true'&&!directoryProbe.row(directoryProbe.nested).hasAttribute('aria-current')");
  await act("directoryProbe.row('reports/obsolete').click()"); await settle();
  await act("directoryProbe.missingDirectory='reports/obsolete'"); await click('Other'); await settle();
  await check('DeletedUnrelatedExpandedFolderDoesNotBlockDirectoryLink', "directoryProbe.row('reports/其他目录').getAttribute('aria-current')==='true'&&!!directoryProbe.row('reports/其他目录/alternate.txt')&&!$('workspaceFileNotice').textContent.includes('Synthetic directory removed')&&directoryProbe.row('reports/obsolete').getAttribute('aria-expanded')==='false'");

  await click('EncodedScratch'); await settle();
  await check('TemporaryDirectoryEscapesHashAndLiteralPercentOnce', "$('workspaceRootPath').textContent===directoryProbe.ESCAPED&&!!directoryProbe.row('report#final %20.md')&&RelayLocalFileLinks.parse(directoryProbe.lists.at(-1).directoryLink?.href)?.path===directoryProbe.ESCAPED");
  await act("$('workspaceRootOpen').click();directoryProbe.row('report#final %20.md').click()"); await settle();
  await check('TemporaryFileAndRootLinksPreserveReservedCharacters', "RelayLocalFileLinks.parse(directoryProbe.opens.at(-1).href)?.path===directoryProbe.ESCAPED&&RelayLocalFileLinks.parse(directoryProbe.reads.at(-1).href)?.path===directoryProbe.ESCAPED+'/report#final %20.md'&&$('workspacePreviewTitle').textContent===directoryProbe.ESCAPED+'/report#final %20.md'");
  await click('Missing'); await waitFor("document.querySelector('.app-toast.show')?.textContent.includes('合成目录已不存在')");
  await check('MissingDirectoryReportsFailureWithoutCreatingPreview', "($('workspaceFileNotice').textContent.includes('合成目录已不存在')||document.querySelector('.app-toast.show')?.textContent.includes('合成目录已不存在'))&&!relayWorkspacePanel.getState().tabs.some(t=>t.path?.endsWith('/missing'))");
  await check('RendererStaysOfflineSandboxedAndDoesNotWriteHistory', "directoryProbe.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')");
  if (requests.length) throw Error('Unexpected network requests');
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  errors.push(String(error.stack || error)); console.error(error.stack || error); save(); clearTimeout(deadline);
  if (win && !win.isDestroyed()) try {
    const diagnostic = await evaluate(`(() => { const row=directoryProbe?.row(directoryProbe.nested),tree=document.getElementById('workspaceFileTree');
      return {state:relayWorkspacePanel?.getState(),layout:relayWorkspaceFileLayout?.getState(),filter:document.getElementById('workspaceFileFilter')?.value,
        selected:row?.getAttribute('aria-current'),row:row?.getBoundingClientRect().toJSON(),tree:tree?.getBoundingClientRect().toJSON(),scrollTop:tree?.scrollTop,
        notice:document.getElementById('workspaceFileNotice')?.textContent,errors:directoryProbe?.errors}; })()`);
    fs.writeFileSync(path.join(output, suffix + '-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
    fs.writeFileSync(path.join(output, suffix + '-failure.png'), (await win.webContents.capturePage()).toPNG());
  } catch (_) {}
  app.exit(1);
});
