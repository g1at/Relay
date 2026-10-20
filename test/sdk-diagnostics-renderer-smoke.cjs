'use strict';
// Isolated renderer acceptance: synthetic diagnostic DTOs, no SDK task or user profile.
if (!process.argv.includes('--run')) { console.log('Run with Electron and --run for isolated UI acceptance.'); process.exit(0); }
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { diagnosticsFromEvent } = require('../src/main/sdk/sdk-diagnostic-details');
const { SdkSessionObserver } = require('../src/main/sdk/sdk-session-observer');
const root = path.resolve(__dirname, '..'), base = path.join(root, '.codex-tmp/sdk-diagnostics-renderer-smoke');
fs.mkdirSync(base, { recursive: true }); const output = fs.mkdtempSync(path.join(base, 'run-'));
app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
const checks = {}, errors = []; let win;
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, errors, scope: 'Production activity renderer and backend sanitizer, synthetic events only.' }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout'); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const tick = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function check(name, code) { checks[name] = !!await evaluate(code); save(); if (!checks[name]) throw Error(name); }
async function capture(name) { await new Promise(resolve => setTimeout(resolve, 230)); await tick(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
async function emit(event) { const safe = { ...event, relay_diagnostics: diagnosticsFromEvent(event) }; await evaluate(`emit(${JSON.stringify(safe)})`); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  win = new BrowserWindow({ width: 950, height: 730, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main><h3>任务运行记录</h3><div id="activity"></div></main></body></html>'));
  for (const file of ['styles.css', 'conversation-stream.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(root, 'renderer', file), 'utf8'));
  await win.webContents.insertCSS('body{display:block;padding:24px;background:var(--bg);color:var(--text)}main{max-width:760px;margin:10px auto}h3{font-size:17px;margin:0 0 22px}');
  await evaluate(fs.readFileSync(path.join(root, 'renderer/activity-stream.js'), 'utf8') + '\nvoid 0;');
  await act("window.state=RelayActivity.createState();window.stream=RelayActivity.createElement(state,{collapseOnComplete:false});document.getElementById('activity').append(stream);window.update=()=>RelayActivity.updateElement(stream,state,{collapseOnComplete:false});window.emit=event=>{RelayActivity.ingest(state,event);update()};window.diagnosticRows=()=>stream.querySelectorAll('.is-diagnostic');");
  win.showInactive();
  await emit({ type: 'system', subtype: 'init', session_id: 'fixture' });
  await check('ordinaryInitializationHasNoAddedDiagnosticRows', "diagnosticRows().length===0&&stream.textContent.includes('正在等待回复')");
  await emit({ type: 'system', subtype: 'init', session_id: 'fixture', plugin_errors: [
    { plugin: 'sample@local', type: 'dependency-unsatisfied', message: 'RAW_SECRET', path: 'C:\\private\\secret' },
    { plugin: '<img src=x onerror=alert(1)>', type: 'unknown', message: '<script>alert(1)</script>' },
  ] });
  await check('pluginProblemsAreVisibleWhileTheTaskKeepsWaiting', "diagnosticRows().length===1&&stream.textContent.includes('插件加载存在问题（2 项）')&&stream.textContent.includes('正在等待回复')&&state.phase==='running'&&state.error===null");
  await act("stream.querySelector('[data-process-id=relay-sdk-plugin-errors]').click();");
  await check('pluginDetailsUseSafeIdentifiersAndFixedReasons', "(()=>{const row=stream.querySelector('[data-process-id=relay-sdk-plugin-errors]');return row.getAttribute('aria-expanded')==='true'&&row.textContent.includes('sample@local')&&row.textContent.includes('依赖')&&row.textContent.includes('未识别插件')&&!row.textContent.includes('RAW_SECRET')&&!row.textContent.includes('private')&&!row.querySelector('script,img')})()");
  await emit({ type: 'assistant', session_id: 'fixture', resume_reason: 'checkpoint_restore', message: { id: 'reply', content: [] } });
  await act("stream.querySelector('[data-process-id=relay-sdk-runtime]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));window.runtimeRow=stream.querySelector('[data-process-id=relay-sdk-runtime]');");
  await emit({ type: 'result', subtype: 'success', session_id: 'fixture', result: '', first_text_post_ms: 1432, first_stream_post_queue_wait_ms: 0, first_stream_post_queued_behind: 'none' });
  await check('timingUpdatesPreserveExpandedRowAndKeyboardFocus', "stream.querySelector('[data-process-id=relay-sdk-runtime]')===runtimeRow&&document.activeElement===runtimeRow&&runtimeRow.getAttribute('aria-expanded')==='true'&&runtimeRow.textContent.includes('SDK 首次文本投递：1,432 毫秒')&&runtimeRow.textContent.includes('排队：0 毫秒')&&runtimeRow.textContent.includes('检查点恢复')&&state.phase==='running'");
  let now = 1000; const observer = new SdkSessionObserver({ now: () => now }); observer.beginTurn();
  observer.preparation({ startupMs: 100, modeMs: 500, mcpMs: 600, totalMs: 710 }); now = 2800;
  observer.observe({ type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic first text' }] } });
  await emit({ type: 'system', subtype: 'fixture', relay_diagnostics: observer.snapshot().diagnostics });
  await check('localObserverDurationsAreUsefulWithoutInventingSDKDeliveryOrAddingParallelTimes', "runtimeRow.textContent.includes('会话启动准备：100 毫秒')&&runtimeRow.textContent.includes('模式准备：500 毫秒')&&runtimeRow.textContent.includes('工具连接准备：600 毫秒')&&runtimeRow.textContent.includes('准备总耗时：710 毫秒')&&runtimeRow.textContent.includes('本地首正文到达：1,800 毫秒')&&runtimeRow.textContent.includes('耗时不相加')");
  await capture('diagnostics-light');
  await act("window.saved=RelayActivity.serialize(state);state=RelayActivity.hydrate(saved);update();");
  await check('restoredHistoryKeepsDiagnosticsAndDoesNotDuplicateRows', "diagnosticRows().length===2&&stream.textContent.includes('sample@local')&&stream.textContent.includes('1,432 毫秒')");
  await emit({ type: 'conversation_reset', session_id: 'fixture', new_conversation_id: 'next', uuid: 'reset' });
  await emit({ type: 'result', session_id: 'fixture', subtype: 'error_during_execution', startup_failure_reason: 'temp_dir_unusable', errors: ['fixture'] });
  await check('oldSessionCannotInjectStartupDiagnosticIntoNewContext', "!stream.querySelector('[data-process-id^=relay-sdk-startup-failure]')");
  await act("state=RelayActivity.createState();update();");
  await emit({ type: 'result', subtype: 'error_during_execution', is_error: true, startup_failure_reason: 'cwd_unavailable', errors: ['Synthetic startup failure'] });
  await act("const row=stream.querySelector('[data-process-id=relay-sdk-startup-failure]');row.click();RelayActivity.finish(state,'Synthetic startup failure');update();");
  await check('startupFailureExplainsCauseAndActionAndStopsOnlyWithRealCompletion', "stream.textContent.includes('工作目录不可用')&&stream.textContent.includes('重新选择可访问的工作目录后重试')&&state.phase==='error'&&!stream.querySelector('.process-spinner')");
  win.setContentSize(390, 500);
  await act("document.documentElement.dataset.theme='dark';"); await tick();
  await check('expandedDiagnosticWrapsInsideNarrowDarkViewport', "document.documentElement.scrollWidth<=innerWidth&&[...stream.querySelectorAll('.process-item,.process-output-text')].every(row=>row.scrollWidth<=row.clientWidth+1)");
  await capture('startup-diagnostic-dark-narrow');
  await check('rendererRemainsSandboxedAndNeverAddsActionButtons', "typeof require==='undefined'&&typeof process==='undefined'&&!stream.querySelector('.process-task-stop,.process-task-background,.process-task-resource')");
  save(); console.log(JSON.stringify({ output, checks: Object.keys(checks).length, errors })); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(error => { errors.push(String(error.stack || error)); save(); console.error(error); clearTimeout(deadline); app.exit(1); });
