'use strict';
// Real renderer, isolated Electron profile and entirely synthetic host APIs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/settings-retirement-preferences');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, failures = [];
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step, checks, failures }, null, 2));
const deadline = setTimeout(() => { failures.push('timeout: ' + step); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code), act = code => evaluate(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function check(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(check,20)}check()})`); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); if (!checks[name]) throw Error(name); }
async function reveal(selector) {
  const category=await evaluate(`document.querySelector(${JSON.stringify(selector)})?.closest('.set-cat')?.dataset.cat`);
  if(category) await evaluate(`openSettings(${JSON.stringify(category)})`);
  await act(`const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});`);
}
async function click(selector) { await reveal(selector);await act(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function choose(key, value) { await reveal('#general-'+key); await act(`const host=document.getElementById('general-'+${JSON.stringify(key)});host.querySelector('.cs-trigger').click();host.querySelector('[data-value="'+${JSON.stringify(value)}+'"].cs-option').click();`); }
async function capture(name) { await delay(150); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function seed() {
  const base = window.api, clone = value => JSON.parse(JSON.stringify(value));
  const state = window.prefsFixture = { gets: 0, diagnosticCalls: 0, holdDiagnostics: false, releaseDiagnostics: null, failDiagnostics: false, fullContextCalls: 0, hold: false, release: null, failRefresh: false, refreshOptions: [], folderMode: 'ok', steers: [], pauses: 0,
    capabilities: {
      fileOpenTargets: [{ id: 'relay', label: 'Relay', available: true }, { id: 'system', label: '系统默认应用', available: true }, { id: 'vscode', label: 'VS Code', available: true }],
      agentEnvironments: [{ id: 'native', label: 'Windows 原生', available: true }, { id: 'wsl', label: 'WSL', available: false, reason: '示例环境未安装 Linux 运行时' }],
      terminalShells: [{ id: 'auto', label: '系统默认', available: true }, { id: 'powershell', label: 'Windows PowerShell', available: true }, { id: 'cmd', label: '命令提示符', available: true }, { id: 'wsl', label: 'WSL', available: true }],
    },
  };
  const prefs = () => ({ workspaceRoot: '', defaultWorkspaceRoot: 'C:\\fixture-user\\RelayProjects', fileOpenTarget: 'relay', agentEnvironment: 'native', terminalShell: 'auto', followUpMode: 'steer', ...workspaceFixture.savedSettings().app });
  window.api = new Proxy(base, { get(target, key) {
    if (key === 'settings') return {
      ...target.settings,
      async read() { const saved = await target.settings.read(); return { ...saved, app: { ...saved.app, sdkMemoryMode: 'isolated-sdk', sdkAutoDreamEnabled: true } }; },
    };
    if (key === 'claudeContextDetails') return async () => { state.fullContextCalls++; return { ok: true, sampledAt: new Date().toISOString(), estimated: true, totalTokens: 1280, categories: [{ name: '系统提示', tokens: 1024 }, { name: 'MCP 工具', tokens: 256, deferred: true }] }; };
    if (key === 'generalPreferences') return {
      async get(options) { state.gets++; state.refreshOptions.push(clone(options || {})); if (state.failRefresh) throw Error('合成环境检测失败'); const result = { ok: true, preferences: prefs(), capabilities: clone(state.capabilities), projectContext: { id: 'fixture-project', name: '示例项目' } }; if (state.hold) await new Promise(resolve => { state.release = () => { state.release = null; state.hold = false; resolve(); }; }); return result; },
      async diagnostics() { state.diagnosticCalls++; if(state.failDiagnostics) throw Error("Synthetic diagnostics failure"); if(state.holdDiagnostics) await new Promise(resolve=>{state.releaseDiagnostics=()=>{state.releaseDiagnostics=null;state.holdDiagnostics=false;resolve();};}); return { ok: true, hooksDisabled: true, sources: [{ source: 'user', file: 'settings.json', keys: ['permissions'] }], instructions: [{ file: 'CLAUDE.md', source: 'Project' }], limitations: ['配置预览不执行 policyHelper。'],
        runtime: { sessionState: 'running', catalog: { commands: ['goal'], agents: ['fixture-agent'], tools: ['Read', 'Edit'], plugins: ['fixture-plugin'] }, initialization: { readyMs: 235, hooksApplied: false, pluginsApplied: true }, timing: { firstVisibleMs: 650, mcpMs: 122 }, stderrCounts: { mcp: 2 } },
        routeTiming: [{ routeTier: 'opus', samples: 2, averageFirstVisibleMs: 650, averageRequestMs: 300 }] }; },
      async contextDetails() { state.fullContextCalls++; return { ok: true, sampledAt: new Date().toISOString(), estimated: true, totalTokens: 1280, categories: [{ name: '系统提示', tokens: 1024 }, { name: 'MCP 工具', tokens: 256, deferred: true }] }; },
      async pickWorkspaceRoot() { return state.folderMode === 'cancel' ? { ok: false, canceled: true } : { ok: true, path: 'D:\\Fixture Workspace\\Relay Projects' }; },
    };
    if (key === 'steerClaude') return async request => {
      state.steers.push(clone(request));
      const input = { id: request.messageId, text: request.prompt, files: request.files, skill: request.skill,
        followUpMode: request.followUpMode, status: 'queued', ts: new Date().toISOString() };
      return { ok: true, jobId: request.jobId, conversationId: request.conversationId, input };
    };
    if (key === 'pauseClaude') return async () => { state.pauses++; return { paused: true, settled: true }; };
    return target[key];
  } });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(root, 'test', name), 'utf8')).join('\n') + `\n(${seed.toString()})();localStorage.clear();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}</script>`);
  const page = path.join(out, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1200, height: 850, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page); await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  await check('startupDoesNotProbeDesktopApplications', 'prefsFixture.gets===0');
  // Initial form selection and the explicit category can both refresh cached capabilities.
  // Wait for a settled render rather than depending on the asynchronous call count.
  await evaluate("openSettings('general')"); await waitFor('settingsFormLoaded');
  await check('generalOpensWithoutProbingOrNativeHistory', 'prefsFixture.gets===0&&prefsFixture.fullContextCalls===0');
  await evaluate("openSettings('workspace')"); await waitFor("prefsFixture.gets>=1&&!document.querySelector('[data-general-refresh]').disabled");
  await check('refreshIsAnAccessibleHeaderActionAndNotAFooterButton', "(()=>{const button=document.querySelector('[data-general-refresh]'),section=button.closest('.rgp-section'),heading=button.closest('.set-section-head'),b=button.getBoundingClientRect(),h=heading.getBoundingClientRect();return heading.contains(button)&&!!heading.textContent.trim()&&!section.querySelector('.rgp-feedback button')&&button.title==='重新检测'&&button.getAttribute('aria-label')==='重新检测'&&button.getAttribute('aria-busy')==='false'&&Math.abs(b.right-h.right)<1&&Math.abs((b.top+b.bottom)-(h.top+h.bottom))<2;})()");
  await check('preferencesAreSeparatedByPurposeWithoutDuplicatingControls', "(()=>{const groups={workspace:['workspaceRoot','fileOpenTarget','agentEnvironment','terminalShell'],conversation:['followUpMode','maxParallelTasks']};return Object.entries(groups).every(([category,keys])=>keys.every(key=>document.querySelector('[data-general-row='+key+']')?.closest('.set-cat').dataset.cat===category))&&document.querySelectorAll('[data-general-row]').length===6&&!document.querySelector('[data-general-row=sdkSettingSources],[data-general-row=sdkTrustedProjectIds]')&&!document.querySelector('[data-cat=general] [data-general-row]')&&!document.querySelector('.rgp-section select');})()");
  await evaluate("openSettings('memory')");
  await waitFor("!!document.getElementById('memorySection').firstElementChild");
  await check('relayMemoryRemainsAvailableWithoutRetiredSdkMemoryControls', "!!document.getElementById('memorySection').firstElementChild&&!document.querySelector('[data-general-row=sdkMemoryMode],[data-general-row=sdkAutoDreamEnabled],[data-general-setting=sdkMemoryMode],[data-general-setting=sdkAutoDreamEnabled]')&&![...document.querySelectorAll('.rgp-heading')].some(node=>node.textContent.includes('SDK 记忆'))");
  await check('legacyEnabledMemoryValuesDoNotBecomeSettingsDrafts', "!Object.hasOwn(generalPreferencesView.getPatch(),'sdkMemoryMode')&&!Object.hasOwn(generalPreferencesView.getPatch(),'sdkAutoDreamEnabled')&&workspaceFixture.settingsWrites.length===0");
  await check('maintenanceControlsAreRemovedWithoutEagerBackendWork', "!document.querySelector('[data-cat=maintenance],.rgp-diagnostics,.rgp-history,[data-general-row=sdkCleanupPeriodDays],[data-general-context-details],[data-general-apply-runtime]')&&prefsFixture.diagnosticCalls===0&&prefsFixture.fullContextCalls===0");
  await check('parallelConversationsHaveOnlyFourChoicesAndDefaultToTwo', "$('general-maxParallelTasks').dataset.value==='2'&&[...$('general-maxParallelTasks').querySelectorAll('.cs-option')].map(item=>item.dataset.value).join(',')==='2,6,9,0'&&!document.querySelector('[data-general-parallel-custom]')");
  await choose('agentEnvironment', 'wsl');
  await check('unavailableAgentEnvironmentCannotBeSelected', "document.getElementById('general-agentEnvironment').dataset.value==='native'&&document.querySelector('.rgp-status').textContent.includes('未安装')&&!generalPreferencesView.getPatch().agentEnvironment");
  await act("closeCustomSelect();prefsFixture.folderMode='cancel';document.querySelector('[data-general-choose-folder]').click();"); await delay(70);
  await check('cancelingNativeFolderDialogKeepsTheDraft', "!Object.hasOwn(generalPreferencesView.getPatch(),'workspaceRoot')");
  await act("prefsFixture.folderMode='ok';document.querySelector('[data-general-choose-folder]').click();");
  await waitFor("generalPreferencesView.getPatch().workspaceRoot?.includes('Fixture Workspace')");
  await choose('fileOpenTarget', 'vscode'); await choose('terminalShell', 'wsl'); await choose('followUpMode', 'queue');
  await choose('maxParallelTasks', '6');
  await check('parallelPresetIsANumericDraft', "generalPreferencesView.getPatch().maxParallelTasks===6&&workspaceFixture.settingsWrites.length===0");
  await check('editingPreferencesDoesNotSaveOrChangeRunningBehavior', "workspaceFixture.settingsWrites.length===0&&followUpMode==='steer'&&generalPreferencesView.getPatch().terminalShell==='wsl'");
  await evaluate("openSettings('profile')"); await evaluate("openSettings('general')");
  await check('navigationPreservesAllEnvironmentDrafts', "generalPreferencesView.getPatch().fileOpenTarget==='vscode'&&generalPreferencesView.getPatch().followUpMode==='queue'");
  await act("workspaceFixture.settingsWriteMode='refuse';$('btnSettingsSave').click();");
  await waitFor("!settingsSaveBusy&&$('settingsHint').textContent.includes('拒绝')");
  await check('failedSavePreservesChoicesAndCommittedSendMode', "generalPreferencesView.getPatch().followUpMode==='queue'&&followUpMode==='steer'");
  await act("workspaceFixture.settingsWriteMode='ok';$('btnSettingsSave').click();"); await waitFor("!settingsSaveBusy&&followUpMode==='queue'");
  await check('oneSaveCommitsAllEditedFieldsWithoutChangingProviderDefault', "workspaceFixture.savedSettings().app.workspaceRoot.includes('Fixture Workspace')&&workspaceFixture.savedSettings().app.fileOpenTarget==='vscode'&&workspaceFixture.savedSettings().app.terminalShell==='wsl'&&!Object.hasOwn(workspaceFixture.settingsWrites.at(-1).claude,'defaultModel')&&Object.keys(generalPreferencesView.getPatch()).length===0");
  await check('ordinarySaveDoesNotResubmitRetiredMemoryPreferences', "!Object.hasOwn(workspaceFixture.settingsWrites.at(-1).app,'sdkMemoryMode')&&!Object.hasOwn(workspaceFixture.settingsWrites.at(-1).app,'sdkAutoDreamEnabled')");
  await act("prefsFixture.hold=true;document.querySelector('[data-general-refresh]').click();"); await waitFor('!!prefsFixture.release');
  await check('refreshShowsBusyStateAndPreventsDuplicateRequests', "(()=>{const button=document.querySelector('[data-general-refresh]'),count=prefsFixture.gets;button.click();return button.disabled&&button.getAttribute('aria-busy')==='true'&&prefsFixture.gets===count&&prefsFixture.refreshOptions.at(-1).refresh===true&&document.querySelector('.rgp-feedback [role=status]').textContent.includes('正在检测');})()");
  await choose('followUpMode', 'steer'); await evaluate('saveMainSettings()'); await act('prefsFixture.release();');
  await waitFor("!document.querySelector('[data-general-refresh]').disabled");
  await check('lateDetectionCannotRevertAChoiceSavedDuringTheRequest', "$('general-followUpMode').dataset.value==='steer'&&followUpMode==='steer'&&Object.keys(generalPreferencesView.getPatch()).length===0");
  await act("prefsFixture.failRefresh=true;document.querySelector('[data-general-refresh]').click();");
  await waitFor("!document.querySelector('[data-general-refresh]').disabled");
  await check('refreshFailureKeepsItsAccessibleRetryAndFooterError', "document.querySelector('[data-general-refresh]').getAttribute('aria-busy')==='false'&&document.querySelector('.rgp-feedback [role=status]').textContent==='合成环境检测失败'&&$('general-followUpMode').dataset.value==='steer'");
  await act("prefsFixture.failRefresh=false;document.querySelector('[data-general-refresh]').click();");
  await waitFor("!document.querySelector('[data-general-refresh]').disabled");
  await check('successfulRetryClearsDetectionError', "document.querySelector('.rgp-status').textContent===''&&document.querySelector('[data-general-refresh]').getAttribute('aria-busy')==='false'");
  await choose('terminalShell', 'cmd'); await act("$('btnSettingsCancel').click();"); await waitFor("settingsFormLoaded&&$('general-terminalShell').dataset.value==='wsl'");
  await check('cancelRestoresSavedPreferences', "!Object.keys(generalPreferencesView.getPatch()).length");
  await act("document.querySelector('[data-general-reset-folder]').click();"); await evaluate('saveMainSettings()');
  await check('resetFolderPersistsDefaultSentinel', "workspaceFixture.savedSettings().app.workspaceRoot===''&&document.querySelector('.rgp-path').textContent.endsWith('RelayProjects')");
  await choose('maxParallelTasks', '9'); await evaluate('saveMainSettings()');
  await check('nineConversationTierPersistsWithoutResettingWSLOrOtherPreferences', "workspaceFixture.savedSettings().app.maxParallelTasks===9&&workspaceFixture.savedSettings().app.terminalShell==='wsl'&&workspaceFixture.savedSettings().app.fileOpenTarget==='vscode'&&!Object.hasOwn(workspaceFixture.settingsWrites.at(-1).app,'agentEnvironment')");
  await reveal('[data-general-refresh]'); await act("document.querySelector('[data-general-refresh]').closest('.rgp-section').scrollIntoView({block:'start'});"); await capture('general-work-environment-light');
  for (const [width, height, theme] of [[900, 700, 'light'], [700, 650, 'dark']]) {
    win.setSize(width, height); await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('[data-general-refresh]').closest('.rgp-section').scrollIntoView({block:'start'});`); await delay(160);
    await check('refreshStaysAtHeaderRightWithoutOverlappingTitle_' + width, "(()=>{const heading=document.querySelector('[data-general-refresh]').closest('.rgp-heading'),range=document.createRange();range.selectNodeContents(heading.firstChild);const title=range.getBoundingClientRect(),button=heading.querySelector('button').getBoundingClientRect();return title.right<button.left&&Math.abs(button.right-heading.getBoundingClientRect().right)<1;})()");
    await check('noHorizontalOverflow_' + width, "[document.getElementById('setContent'),...document.querySelectorAll('.set-cat.active .rgp-section,.set-cat.active .rgp-row')].every(node=>node.scrollWidth<=node.clientWidth+1)");
  }
  await capture('general-work-environment-narrow');
  await choose('maxParallelTasks', '0'); await evaluate('saveMainSettings()');
  await check('unlimitedPersistsAsZeroWithoutCustomInput', "workspaceFixture.savedSettings().app.maxParallelTasks===0&&!document.querySelector('[data-general-parallel-custom]')&&workspaceFixture.savedSettings().app.terminalShell==='wsl'");
  await evaluate("openSettings('shortcuts')");
  await check('reverseFollowupShortcutIsDocumented', "document.getElementById('keyboardShortcutsSection').textContent.includes('切换本次跟进方式')");
  await act("startNewConv();$('input').value='执行合成任务';$('btnSend').click();"); await waitFor('runs.size===1&&!pendingConversationSends.size');
  await act("prefsFixture.originalRun=[...runs.values()][0];$('input').value='调整当前要求';$('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
  await waitFor('prefsFixture.steers.length===1&&!conversationControls.size');
  await check('enterUsesCommittedSteeringMode', "prefsFixture.steers[0].followUpMode==='steer'&&prefsFixture.pauses===0&&runs.get(currentConv.id)===prefsFixture.originalRun");
  await act("$('input').value='排队后续要求';$('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));");
  await waitFor('prefsFixture.steers.length===2&&!conversationControls.size');
  await check('controlEnterQueuesOneMessageWithoutPausing', "prefsFixture.steers[1].followUpMode==='queue'&&prefsFixture.pauses===0&&currentConv.turns.length===1&&document.querySelector('[data-supplement-id=\"'+prefsFixture.steers[1].messageId+'\"] .supplement-status').textContent.includes('已排队')");
  await evaluate("openSettings('general')"); await choose('followUpMode', 'queue'); await evaluate('saveMainSettings()'); await act("showChatView();$('input').value='默认排队';$('btnSend').click();");
  await waitFor('prefsFixture.steers.length===3&&!conversationControls.size');
  await act("$('input').value='本次调整';$('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));");
  await waitFor('prefsFixture.steers.length===4&&!conversationControls.size');
  await check('queueDefaultAndReverseUseOppositeModesWithinTheSameRun', "prefsFixture.steers[2].followUpMode==='queue'&&prefsFixture.steers[3].followUpMode==='steer'&&prefsFixture.steers.every(request=>request.jobId===prefsFixture.originalRun.jobId)&&prefsFixture.pauses===0");
  await act("$('input').value='输入法未确认';for(const extra of [{isComposing:true},{repeat:true},{shiftKey:true},{altKey:true}])$('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,...extra}));"); await delay(100);
  await check('composingRepeatingAndNewlineKeysDoNotSubmit', 'prefsFixture.steers.length===4');
  await check('rendererRemainsSandboxedAndErrorFree', "typeof require==='undefined'&&typeof process==='undefined'&&uiFixture.errors.length===0");
  step = 'completed'; save(); clearTimeout(deadline); app.exit(0);
}).catch(async error => { failures.push(String(error.stack || error)); save(); console.error(error.stack); try { if (win && !win.isDestroyed()) { await capture('failure'); console.error(await evaluate('JSON.stringify(uiFixture.errors)')); } } catch (_) {} clearTimeout(deadline); app.exit(1); });
