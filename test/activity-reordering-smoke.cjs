'use strict';
// Real Chromium layout with synthetic activity only; separate profile, no Relay main or network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/parallel-stall-2026-10-13/activity-reordering-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const files = ['renderer/vendor/marked.umd.js', 'renderer/vendor/highlight.min.js', 'renderer/stream-markdown.js',
  'renderer/app.js', 'renderer/read-only-markdown.js', 'renderer/task-continuity.js', 'renderer/activity-stream.js'];
const sources = new Map(files.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
const hashes = Object.fromEntries([...sources].map(([file, text]) => [file, crypto.createHash('sha256').update(text).digest('hex')]));
let win, step = 'start';
const checks = {}, errors = [], audits = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, errors, audits, hashes }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout at ' + step); save(); app.exit(1); }, 60000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = fn => evaluate('(' + fn.toString() + ')()');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, fn) {
  step = name; checks[name] = !!await act(fn); save(); console.log(name + ': ' + checks[name]);
  if (!checks[name]) throw new Error(name + ': ' + await act(() => JSON.stringify({ audit, lastAudit,
    sameB: row('b') === saved.b, samePreB: pre('b') === saved.preB, scrollB: pre('b')?.scrollTop, scrollD: pre('d')?.scrollTop,
    preStart: pre('b')?.textContent.slice(0, 40) })));
}
async function audit(name, fn) {
  await evaluate('audit={active:true,reads:0,hiddenReads:0,readsAfterMove:0,moves:0};try{(' + fn.toString() + ')()}finally{audit.active=false;lastAudit={...audit}}');
  audits[name] = await act(() => lastAudit); save();
  await check(name + 'AvoidsHiddenAndInterleavedLayoutReads', () => lastAudit.hiddenReads === 0 && lastAudit.readsAfterMove === 0);
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  win = new BrowserWindow({ width: 1040, height: 800, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html data-theme="light"><body><main id="host"></main></body></html>'));
  for (const file of ['renderer/styles.css', 'renderer/conversation-stream.css', 'renderer/read-only-markdown.css']) await win.webContents.insertCSS(fs.readFileSync(path.join(root, file), 'utf8'));
  await win.webContents.insertCSS('body{display:block;overflow:auto;padding:20px}#host{max-width:900px;margin:auto}.process-inspect-section.is-result pre{max-height:72px;max-width:420px;overflow:auto;white-space:pre}');
  for (const [file, source] of sources) await evaluate((file === 'renderer/app.js' ? source.slice(0, source.indexOf('const messagesEl =')) : source) + '\n;undefined;');
  await act(() => {
    window.audit = { active: false }; window.lastAudit = {}; window.saved = {}; window.renderErrors = [];
    window.addEventListener('error', e => renderErrors.push(String(e.message)));
    window.addEventListener('unhandledrejection', e => renderErrors.push(String(e.reason)));
    const hidden = '.process-item:not(.is-expanded) > .process-inspector, .process-tool-group:not(.is-expanded) > .process-tool-group-body, .process-stream.is-collapsed > .process-items';
    for (const key of ['scrollTop', 'scrollLeft']) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, key);
      Object.defineProperty(Element.prototype, key, { ...descriptor, get() {
        if (audit.active && this.matches('pre,.process-inspect-markdown,.process-inspect-fields') && this.closest('.process-items')) {
          audit.reads++; if (this.closest(hidden)) audit.hiddenReads++; if (audit.moves) audit.readsAfterMove++;
        }
        return descriptor.get.call(this);
      } });
    }
    const insert = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function (...args) { if (audit.active) audit.moves++; return insert.apply(this, args); };
    window.call = id => ({ id, type: 'tool', toolName: 'Read', title: 'Read ' + id, input: { file_path: id + '.txt' }, status: 'success',
      result: Array.from({ length: 80 }, (_, i) => id + ' line ' + i + ' ' + '.'.repeat(200)).join('\n') });
    window.note = id => ({ id, type: 'narration', status: 'success', result: 'Synthetic grouping boundary ' + id });
    window.calls = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(id => [id, call(id)]));
    window.state = RelayActivity.createState({ items: [calls.a, calls.b, calls.c, calls.d] });
    for (const item of state.items) calls[item.id] = item;
    window.stream = RelayActivity.createElement(state, { collapseOnComplete: false }); host.append(stream);
    window.row = id => stream.querySelector('[data-process-id="' + id + '"]');
    window.pre = id => row(id)?.querySelector('.is-result pre');
    window.update = () => RelayActivity.updateElement(stream, state);
    window.group = id => row(id).closest('.process-tool-group');
    window.openGroup = id => { const g = group(id); if (g && !g.classList.contains('is-expanded')) g.querySelector('button').click(); };
    openGroup('a'); row('b').click(); row('d').click();
    saved.b = row('b'); saved.d = row('d'); saved.preB = pre('b'); saved.preD = pre('d');
    pre('b').scrollTop = 90; pre('b').scrollLeft = 45; pre('d').scrollTop = 120; pre('d').scrollLeft = 60;
    saved.bTop = pre('b').scrollTop; saved.bLeft = pre('b').scrollLeft; saved.dTop = pre('d').scrollTop; saved.dLeft = pre('d').scrollLeft;
    row('d').focus({ preventScroll: true });
  });
  win.showInactive(); await delay(120);
  await check('FixtureHasRealScrollableExpandedDetails', () => saved.bTop === 90 && saved.bLeft === 45 && saved.dTop === 120 && saved.dLeft === 60);
  await audit('StableTextUpdate', () => { calls.b.result = 'updated\n' + calls.b.result; update(); });
  await check('StableTextUpdateNeverMeasuresOldDetails', () => lastAudit.reads === 0 && row('b') === saved.b && pre('b') === saved.preB && pre('b').textContent.startsWith('updated') && pre('b').scrollTop === saved.bTop);
  await audit('StableGroupAppend', () => { state.items.push(calls.e); update(); });
  await check('StableGroupAppendNeverMeasuresOldDetails', () => lastAudit.reads === 0 && pre('d').scrollTop === saved.dTop);
  await audit('GroupSplit', () => { state.items = [calls.a, calls.b, note('boundary'), calls.c, calls.d, calls.e]; update(); });
  await check('SplitPreservesRowsFocusAndBothScrollAxes', () => row('b') === saved.b && row('d') === saved.d && pre('d') === saved.preD && pre('d').scrollTop === saved.dTop && pre('d').scrollLeft === saved.dLeft && document.activeElement === saved.d);
  await audit('GroupReorder', () => { state.items = [calls.c, calls.d, calls.e, note('boundary'), calls.a, calls.b]; update(); });
  await check('GroupReorderPreservesExpandedDetails', () => pre('b').scrollTop === saved.bTop && pre('d').scrollTop === saved.dTop && document.activeElement === saved.d);
  await act(() => group('c').querySelector('button').click());
  await audit('CollapsedGroupReorder', () => { state.items = [calls.a, calls.b, note('boundary'), calls.c, calls.e, calls.d]; update(); });
  await act(() => openGroup('c'));
  await check('CollapsedGroupRestoresItsLastVisibleOffsets', () => pre('d').scrollTop === saved.dTop && pre('d').scrollLeft === saved.dLeft);
  await act(() => row('d').click());
  await audit('CollapsedInspectorMerge', () => { state.items = [calls.a, calls.b, calls.d, calls.c, calls.e]; update(); });
  await act(() => row('d').click());
  await check('CollapsedInspectorRestoresAfterGroupMerge', () => pre('d') === saved.preD && pre('d').scrollTop === saved.dTop && pre('d').scrollLeft === saved.dLeft && stream.querySelectorAll('.process-tool-group').length === 1);
  await act(() => stream.querySelector('.process-summary').click());
  await audit('CollapsedStreamReorder', () => { state.items = [calls.a, calls.d, calls.b, calls.e, calls.c]; update(); });
  await act(() => stream.querySelector('.process-summary').click());
  await check('CollapsedStreamRestoresNestedDetails', () => pre('b').scrollTop === saved.bTop && pre('d').scrollTop === saved.dTop);
  // One task's header also folds other pause/resume segments.
  await act(() => {
    RelayActivity.syncTaskSummary(stream, 'shared-task');
    window.secondState = RelayActivity.createState({ items: [call('x'), call('y')] });
    window.second = RelayActivity.createElement(secondState, { taskKey: 'shared-task', collapseOnComplete: false }); host.append(second); RelayActivity.syncTaskSummary(second);
    second.querySelector('.process-tool-group-summary').click();
    saved.y = second.querySelector('[data-process-id="y"]'); saved.y.click(); saved.preY = saved.y.querySelector('.is-result pre');
    saved.preY.scrollTop = 115; saved.preY.scrollLeft = 33;
    stream.querySelector('.process-summary').click();
  });
  await check('TaskHeaderCollapsesEverySegment', () => stream.classList.contains('is-collapsed') && second.classList.contains('is-collapsed'));
  await audit('CollapsedOtherSegmentReorder', () => { secondState.items.reverse(); RelayActivity.updateElement(second, secondState); });
  await act(() => stream.querySelector('.process-summary').click());
  await check('TaskHeaderRestoresOtherSegmentsAfterHiddenMoves', () => !second.classList.contains('is-collapsed') && saved.y.isConnected && saved.preY.scrollTop === 115 && saved.preY.scrollLeft === 33);
  // Set expansion programmatically to exercise the pre-existing automatic-collapse policy.
  await act(() => {
    window.autoState = RelayActivity.createState({ items: [call('auto-a'), call('auto-b')] });
    window.autoEl = RelayActivity.createElement(autoState); host.append(autoEl);
    autoEl._processExpanded.add('auto-b'); autoEl._processGroupExpanded.set('auto-a', true); RelayActivity.updateElement(autoEl, autoState);
    saved.auto = autoEl.querySelector('[data-process-id="auto-b"] .is-result pre'); saved.auto.scrollTop = 99; saved.auto.scrollLeft = 21;
    RelayActivity.finish(autoState); RelayActivity.updateElement(autoEl, autoState);
  });
  await check('UninspectedCompletionStillAutoCollapses', () => autoEl.classList.contains('is-collapsed') && !autoEl.dataset.userToggled);
  await audit('AutoCollapsedReorder', () => { autoState.items.reverse(); RelayActivity.updateElement(autoEl, autoState); });
  await act(() => { autoState.phase = 'running'; RelayActivity.updateElement(autoEl, autoState); });
  await check('AutoExpansionRestoresPreviouslyVisibleDetails', () => !autoEl.classList.contains('is-collapsed') && saved.auto.scrollTop === 99 && saved.auto.scrollLeft === 21);
  await check('NoRendererErrorsOrNodeExposure', () => renderErrors.length === 0 && typeof require === 'undefined' && typeof process === 'undefined');
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(error => { errors.push(String(error.stack || error)); console.error(error); save(); clearTimeout(deadline); app.exit(1); });
