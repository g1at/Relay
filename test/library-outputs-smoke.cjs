'use strict';

// Production renderer only, synthetic library IPC, isolated profile, no Relay main process.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = process.env.RELAY_SMOKE_OUTPUT ? path.resolve(process.env.RELAY_SMOKE_OUTPUT) : path.join(root, '.codex-tmp', 'library-outputs-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const checks = {}, failures = [];
let win, step = 'starting';
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, failures }, null, 2));
const timeout = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`); }
async function click(selector) { await act(`const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing button');el.click();`); await settle(); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); if (!checks[name]) throw Error(name); }
async function capture(name) { await settle(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
  const overrides = `
    window.libraryFixture = {
      files: [
        { path:'/synthetic/outputs/final-report.pdf', name:'final-report.pdf', type:'pdf', kind:'output', conversationId:'synthetic-chat', mtime:1700000000000, size:3456 },
        { path:'/synthetic/scratch/check.py', name:'check.py', type:'code', kind:'process', mtime:1700000000010, size:1234 },
        { path:'/synthetic/project/old-report.md', name:'old-report.md', type:'document', mtime:1700000000020, size:1024 }
      ], images: [], opened: [], deleted: [], calls:0, truncated:false, warnings:[], fail:false, hold:false, pending:[],
    };
    window.api.library.listFiles = async () => {
      libraryFixture.calls++;
      if(libraryFixture.hold)return new Promise(resolve=>libraryFixture.pending.push(resolve));
      if(libraryFixture.fail)return {ok:false,error:'synthetic read failure'};
      return {ok:true,items:libraryFixture.files,truncated:libraryFixture.truncated,warnings:libraryFixture.warnings};
    };
    window.api.library.listImages = async () => ({ok:true,items:libraryFixture.images});
    window.api.library.openFile = async file => { libraryFixture.opened.push(file); return {ok:true}; };
    window.api.library.deleteFile = async file => { libraryFixture.deleted.push(file); return {ok:true}; };
  `;
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + '\n' + overrides + '</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1220, height: 900, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page);
  await waitFor("typeof activeView !== 'undefined' && providerRoutingLoaded && !restoringActiveRuns");
  await act('void openMyWork();');
  await waitFor("activeView==='library' && !libSources.files.loading && !!document.querySelector('.libp-item')");
  await check('defaultOutputsExcludeIntermediateAndLegacyFiles', "[...document.querySelectorAll('.libp-item-name')].map(el=>el.textContent).join(',')==='final-report.pdf' && document.querySelector('[data-lib-kind=output]').getAttribute('aria-pressed')==='true'");
  await check('purposeCountsPreserveAllThreeSources', "['output','process','legacy'].every(kind=>document.querySelector('[data-lib-count='+kind+']').textContent==='1')");
  await click('.libp-item .libp-open');
  await check('outputOpenUsesExistingLibraryAction', "libraryFixture.opened.join(',')==='/synthetic/outputs/final-report.pdf'");
  await capture('outputs-desktop');
  await click('[data-lib-kind=process]');
  await check('processViewExplainsCleanupAndDoesNotShowOutputs', "document.querySelector('.libp-item-name').textContent==='check.py' && document.querySelectorAll('.libp-item').length===1 && document.querySelector('[data-lib-description]').textContent.includes('删除会话')");
  await click('[data-lib-filter=code]');
  await act("const input=document.querySelector('.libp-search input');input.value='check';input.dispatchEvent(new Event('input',{bubbles:true}));");
  await waitFor("libState.query==='check' && !libState.searchTimer");
  await click('[data-lib-view=list]');
  await check('existingTypeSearchAndListControlsWorkWithinProcessView', "document.querySelectorAll('.libp-list .libp-item').length===1 && document.querySelector('.libp-item-name').textContent==='check.py'");
  await click('[data-lib-kind=legacy]');
  await check('scopeChangesDoNotSilentlyDiscardSearch', "!!document.querySelector('[data-lib-clear]') && libState.query==='check' && libState.fileType==='code'");
  await click('[data-lib-clear]');
  await check('unclassifiedLegacyFileRemainsAccessible', "document.querySelector('.libp-item-name').textContent==='old-report.md' && document.querySelector('[data-lib-description]').textContent.includes('尚未确认')");
  await click('.libp-item .libp-open');
  await check('legacyFileOpenRetainsOriginalPath', "libraryFixture.opened.at(-1)==='/synthetic/project/old-report.md'");

  await act("libraryFixture.files=libraryFixture.files.filter(item=>item.kind!=='output');void refreshLibrary({force:true});");
  await waitFor('!libSources.files.loading');
  await click('[data-lib-kind=output]');
  await check('emptyOutputsExplainAndLinkToExistingHistory', "document.querySelector('.libp-empty').textContent.includes('另有 1 项历史文件') && !!document.querySelector('.libp-empty [data-lib-kind=legacy]')");
  await click('.libp-empty [data-lib-kind=legacy]');
  await check('historyEmptyStateActionShowsRetainedFile', "libState.kind==='legacy' && document.querySelector('.libp-item-name').textContent==='old-report.md'");
  await act("libraryFixture.truncated=true;libraryFixture.warnings=['synthetic inaccessible directory'];void refreshLibrary({force:true});");
  await waitFor('!libSources.files.loading');
  await check('partialScanIsVisibleWithoutDiscardingAvailableFiles', "!document.querySelector('.libp-status').hidden && document.querySelector('.libp-status').textContent.includes('尚未完整读取') && document.querySelectorAll('.libp-item').length===1 && document.querySelector('.libp-total').textContent.includes('已载入')");
  await act('libraryFixture.fail=true;void refreshLibrary({force:true});');
  await waitFor('!libSources.files.loading');
  await check('failedRefreshRetainsFileAndOffersRetry', "!!document.querySelector('[data-lib-retry=files]') && document.querySelector('.libp-status').textContent.includes('已保留上次结果') && document.querySelector('.libp-item-name').textContent==='old-report.md'");
  await act('libraryFixture.fail=false;libraryFixture.truncated=false;libraryFixture.warnings=[];');
  await click('[data-lib-retry=files]');
  await waitFor('!libSources.files.loading');
  await check('successfulRetryClearsIncompleteState', "document.querySelector('.libp-status').hidden && !document.querySelector('.libp-total').textContent.includes('已载入')");

  await act('libraryFixture.hold=true;void refreshLibrary({force:true});');
  await waitFor('libraryFixture.pending.length===1');
  await click('[data-lib-kind=process]');
  await act("libraryFixture.hold=false;libraryFixture.pending.shift()({ok:true,items:libraryFixture.files});");
  await waitFor('!libSources.files.loading');
  await check('lateRefreshKeepsSelectedPurpose', "libState.kind==='process' && document.querySelector('.libp-item-name').textContent==='check.py'");
  win.setSize(780, 720); await waitFor('innerWidth<=780');
  await act("document.documentElement.dataset.theme='dark';");
  await settle();
  await check('narrowLayoutKeepsPurposeButtonsInsidePage', "document.documentElement.scrollWidth<=innerWidth+1 && [...document.querySelectorAll('.libp-kinds button')].every(button=>{const r=button.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.width>=50&&r.height>=32})");
  await capture('process-narrow-dark');
  await act("libraryFixture.files.push({path:'/synthetic/custom/website',name:'website',type:'other',kind:'output',isDirectory:true,mtime:1700000000020,size:null});void refreshLibrary({force:true});");
  await waitFor('!libSources.files.loading');
  await click('[data-lib-kind=output]');
  await check('explicitDirectoryHasAnOpenFolderAction', "document.querySelector('.libp-item-name').textContent==='website' && document.querySelector('.libp-open').title.includes('打开文件夹')");
  await click('.libp-item .libp-open');
  await check('directoryOpenPreservesItsPath', "libraryFixture.opened.at(-1)==='/synthetic/custom/website'");
  await click('.libp-item-menu');
  await check('directoryMenuDoesNotOfferDelete', "ensureCopyPopover().querySelector('.cp-del').hidden");
  await act('hideCopyPopover();');
  await check('isolatedRendererHasNoErrorsOrRealFileMutations', "uiFixture.errors.length===0 && typeof require==='undefined' && typeof process==='undefined' && libraryFixture.deleted.length===0");
  step = 'completed'; save(); clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack || error));
  try { if (win && !win.isDestroyed()) await capture('failure'); } catch (_) {}
  save(); console.error(error.stack); clearTimeout(timeout); app.exit(1);
});
