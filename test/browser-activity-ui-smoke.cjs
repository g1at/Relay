'use strict';
// Browser receipts use the real activity renderer/styles in an isolated profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/browser-activity-ui-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'start';
const checks = {}, errors = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, errors }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout at ' + step); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, expression) {
  step = name; checks[name] = !!await evaluate(expression); save();
  console.log(`${name}: ${checks[name]}`); if (!checks[name]) throw Error(name);
}
async function capture(name) {
  await delay(250);
  const rect = await evaluate(`(() => {
    const host = document.getElementById('host').getBoundingClientRect();
    const x = Math.max(0, Math.floor(host.x) - 16), y = Math.max(0, Math.floor(host.y) - 16);
    return { x, y, width: Math.min(innerWidth - x, Math.ceil(host.width) + 32),
      height: Math.min(innerHeight - y, Math.ceil(stream.getBoundingClientRect().bottom) + 16 - y) };
  })()`);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage(rect)).toPNG());
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  win = new BrowserWindow({ width: 1040, height: 860, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><main id="host"></main></body></html>'));
  for (const file of ['styles.css', 'conversation-stream.css', 'workspace-panel.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(root, 'renderer', file), 'utf8'));
  await win.webContents.insertCSS('body{display:block;height:100vh;overflow:auto;background:var(--bg)}#host{width:min(720px,calc(100vw - 48px));margin:32px auto;min-width:0}');
  for (const file of ['browser-activity.js', 'task-continuity.js', 'activity-stream.js']) await evaluate(fs.readFileSync(path.join(root, 'renderer', file), 'utf8') + '\nvoid 0;');
  await act(`
    window.fixture = { errors: [], reads: [], resources: [] };
    window.addEventListener('error', event => fixture.errors.push(event.message));
    window.state = RelayActivity.createState();
    window.addResult = (id, verb, value, input = {}) => {
      RelayActivity.ingest(state, { type: 'assistant', uuid: id + '-call', message: { content: [{ type: 'tool_use', id, name: 'mcp__relay-browser__' + verb, input }] } });
      RelayActivity.ingest(state, { type: 'user', uuid: id + '-result', message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(value) }] } });
    };
    state.items.push({ id: 'ordinary', type: 'tool', toolName: 'Read', title: '读取项目说明', status: 'success', input: { file_path: '/task/README.md' }, result: '项目说明已读取' });
    addResult('observe', 'observe', { ok: true, elements: [] });
    addResult('click', 'act', { ok: true, executed: true }, { kind: 'click', locator: { name: 'Login' } });
    addResult('verified', 'verify', { ok: true, verified: true });
    addResult('wait', 'wait', { ok: true, satisfied: false });
    addResult('failed', 'verify', { ok: true, verified: false });
    addResult('unknown', 'act', { ok: false, outcome: 'unknown' }, { kind: 'click' });
    addResult('shot', 'screenshot', { ok: true, artifact: { path: '/task/browser-evidence.png' } });
    window.stream = RelayActivity.createElement(state, { collapseOnComplete: false, onResource: detail => fixture.resources.push(detail) });
    document.getElementById('host').append(stream);
    window.row = id => stream.querySelector('[data-process-id="tool-' + id + '"]') || stream.querySelector('[data-process-id="' + id + '"]');
    window.api = { image: { toDataUrl: async path => { fixture.reads.push(path); return { ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHd8AAAAASUVORK5CYII=' }; } } };
  `);
  win.showInactive();
  await check('BrowserActionHasSameHeightAsOrdinaryToolRow', 'Math.abs(row("click").getBoundingClientRect().height-row("ordinary").getBoundingClientRect().height)<2');
  await check('ReceiptIsInlineWithoutCardBorderOrBackground', '(()=>{const status=row("click").querySelector(".process-browser-result"),css=getComputedStyle(status);return status.parentElement.classList.contains("process-item-title")&&css.borderTopWidth==="0px"&&css.backgroundColor==="rgba(0, 0, 0, 0)"})()');
  await check('SuccessfulActionHasNoRepeatedWarning', '!row("click").textContent.includes("仍需核验")&&!row("click").textContent.includes("动作完成不等于")');
  await check('FailureAndUnknownStayVisiblyDistinct', 'row("failed").classList.contains("is-error")&&row("failed").querySelector(".process-browser-result").textContent.includes("未通过核验")&&row("unknown").classList.contains("is-unconfirmed")&&row("unknown").querySelector(".process-browser-result").textContent.includes("未确认")&&row("wait").querySelector(".process-browser-result").textContent.includes("尚未满足")');
  await check('SafetyDetailsRemainCollapsedUntilRequested', 'row("unknown").querySelector(".process-inspector").inert&&row("unknown").querySelector(".process-inspector").getBoundingClientRect().height<1&&!row("unknown").querySelector(".process-item-main").textContent.includes("勿直接重复")');
  await check('EvidenceDoesNotReadScreenshotUntilClicked', 'fixture.reads.length===0&&!row("shot").querySelector("img").hasAttribute("src")');
  await check('ScreenshotIconAlignsWithTitleNotAttachment', 'Math.abs(row("shot").querySelector(".process-item-icon").getBoundingClientRect().top-row("shot").querySelector(".process-item-title").getBoundingClientRect().top)<1');
  await capture('compact-light');
  await act('row("unknown").click();'); await delay(260);
  await check('ClickShowsSpecificOutcomeExplanation', 'row("unknown").getAttribute("aria-expanded")==="true"&&!row("unknown").querySelector(".process-inspector").inert&&row("unknown").querySelector(".is-browser").textContent.includes("勿直接重复")');
  await act('row("unknown").click();row("shot").querySelector(".process-browser-preview-toggle").click();'); await delay(260);
  await check('ScreenshotPreviewKeepsLazyEvidenceAccess', 'fixture.reads.length===1&&fixture.reads[0]==="/task/browser-evidence.png"&&!row("shot").querySelector("img").hidden&&row("shot").getAttribute("aria-expanded")==="false"');
  await act('row("shot").querySelector(".process-task-resource").click();'); await delay(80);
  await check('ScreenshotFileButtonRetainsResourceAction', 'fixture.resources.length===1&&fixture.resources[0].uri==="/task/browser-evidence.png"');
  await act('row("shot").querySelector(".process-browser-preview-toggle").click();document.documentElement.dataset.theme="dark";');
  win.setSize(420, 860); await delay(260);
  await check('NarrowStreamDoesNotOverflow', 'document.documentElement.scrollWidth<=innerWidth&&stream.scrollWidth<=stream.clientWidth+1');
  await check('NarrowSuccessRowStaysCompact', 'row("click").getBoundingClientRect().height<=30');
  await capture('compact-narrow-dark');
  await act('fixture.saved=RelayActivity.serialize(state);fixture.restored=RelayActivity.createElement(RelayActivity.hydrate(fixture.saved),{collapseOnComplete:false});stream.replaceWith(fixture.restored);stream=fixture.restored;');
  await check('HistoryUsesSameInlineVerdicts', 'row("click").querySelector(".process-item-title .process-browser-result")&&row("failed").classList.contains("is-error")&&row("unknown").classList.contains("is-unconfirmed")&&!row("click").textContent.includes("动作完成不等于")');
  await check('RendererHasNoErrors', 'fixture.errors.length===0');
  step = 'complete'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(error => { errors.push(String(error.stack || error)); save(); console.error(error); clearTimeout(deadline); app.exit(1); });
