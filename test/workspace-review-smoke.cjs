'use strict';

// Production renderer, preload and workspace IPC; only a disposable Git repository
// and synthetic application settings are used. No Relay profile or history is read.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { registerWorkspaceTools } = require('../src/main/workspace/workspace-tools');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'workspace-review-smoke');
fs.mkdirSync(output, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'relay-review-ui-'));
const repository = path.join(fixtureRoot, 'project');
const plain = path.join(fixtureRoot, 'plain');
fs.mkdirSync(repository); fs.mkdirSync(plain);
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const report = { results: {}, failures: [] };
let win, registry;
const timeout = setTimeout(() => { console.error('Review UI test timed out'); app.exit(1); }, 180000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code) {
  const end = Date.now() + 7000;
  while (Date.now() < end) { if (await evaluate(code)) return; await pause(25); }
  throw Error('Timed out: ' + code);
}
async function check(name, code) {
  report.results[name] = !!(typeof code === 'string' ? await evaluate(code) : code);
  if (!report.results[name]) throw Error(name);
}
const click = selector => act(`document.querySelector(${JSON.stringify(selector)}).click();`);
const capture = async name => {
  await pause(340);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
};
function git(...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', ...args], {
    cwd: repository, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  git('init', '-b', 'review-demo');
  git('config', 'user.name', 'Relay test'); git('config', 'user.email', 'relay-test@example.invalid');
  fs.writeFileSync(path.join(repository, 'README.md'), '# 项目说明\n旧说明\n');
  fs.writeFileSync(path.join(repository, 'app.js'), 'const value = 1;\n');
  fs.writeFileSync(path.join(repository, 'removed.txt'), '即将删除\n');
  git('add', '.'); git('commit', '-m', 'synthetic baseline');
  fs.writeFileSync(path.join(repository, 'README.md'), '# 项目说明\n新的项目说明\n');
  fs.writeFileSync(path.join(repository, 'app.js'), 'const value = 2;\n'); git('add', 'app.js');
  fs.writeFileSync(path.join(repository, 'app.js'), 'const value = 3;\n');
  fs.rmSync(path.join(repository, 'removed.txt'));
  fs.writeFileSync(path.join(repository, '新文件.txt'), '<script>window.reviewInjected = true</script>\n新增说明\n');
  fs.writeFileSync(path.join(repository, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]));

  const fixture = path.join(output, 'fixture.html');
  const fixturePreload = path.join(output, 'preload.cjs');
  fs.writeFileSync(fixturePreload, fs.readFileSync(path.join(root, 'preload.js'), 'utf8').replace("contextBridge.exposeInMainWorld('api',", "contextBridge.exposeInMainWorld('reviewNativeApi',"));
  const source = fs.readFileSync(path.join(__dirname, './ui-api-fixture.js'), 'utf8');
  const seed = `(()=>{
    const base=window.api, native=window.reviewNative;
    const state=window.reviewFixture={context:{conversationId:'review-demo',projectId:'project-a',workingDir:'project-a',title:'演示项目'},calls:[],pending:[],hold:false,fail:false};
    const workspace={...native,review:async context=>{state.calls.push(['review',context]);if(state.fail)throw Error('模拟读取失败');const value=await native.review(context);if(state.hold)return new Promise(resolve=>state.pending.push(()=>resolve(value)));return value;},reviewDiff:async input=>{state.calls.push(['diff',input]);const value=await native.reviewDiff(input);if(state.hold)return new Promise(resolve=>state.pending.push(()=>resolve(value)));return value;}};
    window.api=new Proxy(base,{get(o,k){if(k==='workspace')return workspace;return o[k];}});
    window.addEventListener('load',()=>{window.relayConversationWorkspace=()=>state.context;window.dispatchEvent(new Event('relay:conversation-changed'));});
  })();`;
  fs.writeFileSync(fixture, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>window.reviewNative=window.reviewNativeApi.workspace;' + source + seed + '</script>'));
  win = new BrowserWindow({ width: 1220, height: 850, show: false, webPreferences: { preload: fixturePreload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3 && !message.includes('Content Security Policy')) report.failures.push('Renderer: ' + message); });
  registry = registerWorkspaceTools({ ipcMain, getWindow: () => win, rendererURL: pathToFileURL(fixture).href,
    resolveWorkspace: async context => ({ root: context.projectId === 'plain' ? plain : repository, conversationId: context.conversationId, managed: true }),
  });
  await win.loadFile(fixture); win.showInactive();
  await until('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await click('#btnWorkspacePanel');
  await check('launcherOffersReviewWithoutCreatingATab', '!!document.querySelector("[data-workspace-create=review]")&&relayWorkspacePanel.getState().tabs.length===0&&document.querySelectorAll("#workspaceLauncherActions [data-workspace-create]").length===4&&!document.querySelector("[data-workspace-create=tasks]")');
  await click('[data-workspace-create=review]');
  await until('document.querySelectorAll("[data-review-path]").length>=6');
  await check('productionIpcListsAllThreeChangeGroups', '["staged","unstaged","untracked"].every(stage=>document.querySelector(`[data-review-stage="${stage}"]`))&&document.querySelector("#workspaceReview").textContent.includes("review-demo")');
  await check('reviewDoesNotCreateHistoryOrRunAnAssistant', '!uiFixture.calls.includes("history.save")&&!uiFixture.calls.includes("runClaude")&&typeof require==="undefined"&&typeof process==="undefined"');
  await check('reviewHeadingStartsAtConversationDividerWithoutShrinkingRefresh', 'Math.abs(document.querySelector(".wrev-heading").getBoundingClientRect().top-document.querySelector(".chat-header").getBoundingClientRect().bottom)<1&&document.querySelector("[data-review-refresh]").getBoundingClientRect().height>=28');
  await click('[data-review-path="app.js"][data-review-stage="staged"]');
  await until('document.querySelector("[data-review-diff]")?.textContent.includes("const value = 2;")');
  await check('stagedDiffUsesIndexAgainstHead', 'document.querySelector("[data-review-diff]").textContent.includes("const value = 1;")&&!document.querySelector("[data-review-diff]").textContent.includes("const value = 3;")&&document.querySelectorAll("[data-review-line]").length>0');
  await click('[data-review-path="app.js"][data-review-stage="unstaged"]');
  await until('document.querySelector("[data-review-diff]")?.textContent.includes("const value = 3;")');
  await check('unstagedDiffUsesWorktreeAgainstIndex', 'document.querySelector("[data-review-diff]").textContent.includes("const value = 2;")&&!document.querySelector("[data-review-diff]").textContent.includes("const value = 1;")');
  await capture('review-compact');
  await click('[data-review-path="新文件.txt"]');
  await until('document.querySelector("[data-review-diff]")?.textContent.includes("新增说明")');
  await check('untrackedSourceIsRenderedAsText', '!window.reviewInjected&&!document.querySelector("[data-review-diff] script")&&document.querySelector("[data-review-diff]").textContent.includes("<script>")');
  await click('[data-review-path="image.bin"]');
  await until('document.querySelector("[data-review-diff]")?.textContent.includes("二进制")');
  await check('binaryChangeHasReadableFallback', '!document.querySelector("[data-review-diff]").textContent.includes("�")');
  await click('[data-review-path="README.md"]');
  await until('document.querySelector("[data-review-diff]")?.textContent.includes("新的项目说明")');
  fs.writeFileSync(path.join(repository, 'README.md'), '# 项目说明\n刷新后的项目说明\n');
  await click('[data-review-refresh]');
  await until('document.querySelector("[data-review-diff]")?.textContent.includes("刷新后的项目说明")');
  await check('refreshReloadsTheSelectedDiffFromDisk', true);
  await click('#workspaceMaximize'); await capture('review-expanded');
  await check('reviewResizesToFullWorkspace', 'relayWorkspacePanel.getState().maximized&&document.querySelector("#workspaceReview").getBoundingClientRect().width>=innerWidth-2&&document.documentElement.scrollWidth<=innerWidth+1');
  await act('applyThemeToDOM("dark");'); await capture('review-dark');
  await click('#workspaceMaximize'); win.setSize(820, 650); await pause(350);
  await check('compactLayoutHasNoPageOverflow', 'document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector("#workspaceReview").scrollWidth<=document.querySelector("#workspaceReview").clientWidth+1');
  await capture('review-narrow');

  await act('reviewFixture.hold=true;'); await click('[data-review-path="新文件.txt"]');
  await until('reviewFixture.pending.length>0');
  await act('reviewFixture.hold=false;reviewFixture.context={conversationId:"review-demo",projectId:"plain",workingDir:"project-a",title:"空目录"};window.dispatchEvent(new Event("relay:conversation-changed"));');
  await until('document.querySelector("#workspaceReview").textContent.includes("Git")&&document.querySelectorAll("[data-review-path]").length===0');
  await act('reviewFixture.pending.splice(0).forEach(release=>release());'); await pause(100);
  await check('switchingWorkspaceIgnoresLateDiff', '!document.querySelector("#workspaceReview").textContent.includes("新增说明")&&document.querySelectorAll("[data-review-path]").length===0');
  await capture('review-non-git');
  await act('reviewFixture.context={conversationId:"review-demo",projectId:"project-a",workingDir:"project-a",title:"演示项目"};window.dispatchEvent(new Event("relay:conversation-changed"));');
  await until('document.querySelectorAll("[data-review-path]").length>=6');
  await act('reviewFixture.fail=true;'); await click('[data-review-refresh]');
  await until('document.querySelector("#workspaceReview").textContent.includes("模拟读取失败")');
  await check('loadFailureLeavesAWorkingRetry', '!document.querySelector("[data-review-refresh]").disabled');
  await act('reviewFixture.fail=false;'); await click('[data-review-refresh]');
  await until('!document.querySelector("#workspaceReview").textContent.includes("模拟读取失败")&&document.querySelectorAll("[data-review-path]").length>=6');
  await click('#workspaceAdd');
  await act('[...document.querySelectorAll("#workspaceAddMenu button")].find(b=>b.dataset.workspaceCreate==="review").click();');
  await check('addMenuReusesTheReviewTab', 'relayWorkspacePanel.getState().tabs.filter(t=>t.kind==="review").length===1');
  await act('reviewFixture.hold=true;'); await click('[data-review-refresh]');
  await until('reviewFixture.pending.length>0');
  await click('#workspaceTabs .workspace-tab-close');
  await act('reviewFixture.hold=false;reviewFixture.pending.splice(0).forEach(release=>release());'); await pause(100);
  await check('closingTabDisposesPendingReview', 'relayWorkspacePanel.getState().tabs.length===0&&!document.querySelector("#workspaceNoTabs").hidden&&document.querySelector("#workspaceReviewMount").children.length===0');
  await click('[data-workspace-create=review]'); await until('document.querySelectorAll("[data-review-path]").length>=6');
  await check('reopeningCreatesAWorkingFreshView', 'document.querySelectorAll("[data-review-refresh]").length===1');
  await check('productionBridgeRejectsTraversal', 'reviewNative.reviewDiff({context:reviewFixture.context,path:"../outside.txt",stage:"unstaged"}).then(r=>r.ok===false)');
  await check('productionBridgeRejectsInvalidStage', 'reviewNative.reviewDiff({context:reviewFixture.context,path:"README.md",stage:"erase"}).then(r=>r.ok===false)');
  await check('rendererHasNoUnhandledErrors', 'uiFixture.errors.length===0');
}).catch(async error => { report.failures.push(error.stack || String(error)); if(win&&!win.isDestroyed()){report.state=await evaluate('({text:document.querySelector("#workspaceReview")?.innerText,panel:window.relayWorkspacePanel?.getState(),calls:window.reviewFixture?.calls,errors:window.uiFixture?.errors})').catch(()=>null);await capture('failure');} }).finally(() => {
  clearTimeout(timeout); registry?.dispose(); if (win && !win.isDestroyed()) win.destroy();
  try { fs.rmSync(fixtureRoot, {recursive:true,force:true,maxRetries:3,retryDelay:100}); } catch (_) {}
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); app.exit(report.failures.length ? 1 : 0);
});
