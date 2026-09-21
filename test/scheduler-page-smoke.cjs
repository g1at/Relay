// Isolated renderer checks. Run with Electron, never the Relay main process.
// All scheduler calls are in-memory fixtures; no tasks or network requests execute.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, '.codex-tmp', 'scheduler-page-smoke');
fs.mkdirSync(outputDir, { recursive: true });
const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
const start = source.indexOf('(function initScheduleView()');
const end = source.indexOf('\n})();', start) + '\n})();'.length;
const helpers = source.slice(source.indexOf('function buildSettingsSegmented('), source.indexOf('// 替换浏览器原生 confirm'));
const escaping = source.slice(source.indexOf('function escapeHtml('), source.indexOf('// ── 给 markdown'));
app.setPath('userData', path.join(outputDir, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const timeout = setTimeout(() => app.exit(2), 60000);
const errors = [];

// Exercise rendered menus, scrolling and their real event handlers. Scheduler
// writes stay in the fixture; no real task is saved or executed.
async function checkModelGeometry(theme, containerWidth) {
  const checks = {};
  const prefix = 'model-' + innerWidth + '-' + (containerWidth || 'full') + '-' + theme;
  const host = $('scheduleModal');
  document.body.click();
  document.documentElement.dataset.theme = theme;
  host.style.width = containerWidth ? containerWidth + 'px' : '';
  host.style.maxWidth = containerWidth ? containerWidth + 'px' : '';
  const group = $('svEditModel');
  group.scrollIntoView({ block: 'center', inline: 'nearest' });
  await new Promise(resolve => setTimeout(resolve, 180));
  for (const animation of document.getAnimations()) {
    if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish();
  }
  const buttons = [...group.querySelectorAll('button')].map(button => {
    const glyphs = [];
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      for (let index = 0; index < node.length; index++) {
        if (/\s/.test(node.textContent[index])) continue;
        const range = document.createRange();
        range.setStart(node, index); range.setEnd(node, index + 1);
        glyphs.push(range.getBoundingClientRect().toJSON());
      }
    }
    const rect = button.getBoundingClientRect();
    return {
      label: button.textContent.trim(), value: button.dataset.value, rect: rect.toJSON(), glyphs,
      hit: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
    };
  });
  const rect = group.getBoundingClientRect();
  const row = group.closest('.sv-edit-row').getBoundingClientRect();
  const geometry = { prefix, viewport: [innerWidth, innerHeight], containerWidth, group: rect.toJSON(), row: row.toJSON(), buttons };
  const check = (name, value) => {
    checks[prefix + '-' + name] = !!value;
    if (!value) throw Error(prefix + '-' + name + ': ' + JSON.stringify(geometry));
  };
  check('labelsOnOneLine', buttons.length === 3 && buttons.every(button => button.glyphs.length === 2 && button.glyphs.every(glyph => Math.abs(glyph.top - button.glyphs[0].top) <= 0.75 && Math.abs(glyph.bottom - button.glyphs[0].bottom) <= 0.75)));
  check('textInsideButtons', buttons.every(button => button.glyphs.every(glyph => glyph.width > 0 && glyph.height > 0 && glyph.left >= button.rect.left - 0.75 && glyph.right <= button.rect.right + 0.75 && glyph.top >= button.rect.top - 0.75 && glyph.bottom <= button.rect.bottom + 0.75)));
  check('equalClickableButtons', buttons.every((button, index) => button.hit && button.rect.width > 0 && button.rect.height > 0 && Math.abs(button.rect.width - buttons[0].rect.width) <= 1 && Math.abs(button.rect.height - buttons[0].rect.height) <= 1 && (!index || buttons[index - 1].rect.right <= button.rect.left + 0.75)));
  check('modelFitsRowAndViewport', rect.left >= row.left - 0.75 && rect.right <= row.right + 0.75 && rect.left >= 0 && rect.right <= innerWidth && group.scrollWidth <= group.clientWidth + 1 && buttons.every(button => button.rect.left >= rect.left - 0.75 && button.rect.right <= rect.right + 0.75));
  return { checks, geometry };
}

async function checkSelectInteractions(theme, lifecycle) {
  const checks = {}, geometry = [];
  const prefix = theme + '-' + window.innerWidth;
  const check = (name, value, details) => {
    checks[prefix + '-' + name] = !!value;
    if (!value) throw Error(prefix + '-' + name + ': ' + JSON.stringify(details));
  };
  const settle = (ms = 160) => new Promise(resolve => setTimeout(resolve, ms));
  const host = $('scheduleModal');
  const surface = host.querySelector('.workspace-surface');
  // Task settings are shorter after removing their embedded run history. Add
  // fixture-only scroll room so popover checks can exercise both viewport edges.
  surface.querySelector('[data-fixture-scroll-room]')?.remove();
  const scrollRoom = document.createElement('div');
  scrollRoom.dataset.fixtureScrollRoom = '';
  scrollRoom.style.height = '700px';
  surface.appendChild(scrollRoom);
  const pageScroll = () => [surface.scrollTop, surface.scrollLeft, document.documentElement.scrollTop, document.documentElement.scrollLeft];
  const equalScroll = before => before.every((value, index) => Math.abs(value - pageScroll()[index]) < 1);
  const key = (target, value) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const choose = (id, value) => $(id).querySelector('.cs-option[data-value="' + value + '"]').click();
  const positionTrigger = async (id, targetY = window.innerHeight / 2) => {
    const trigger = $(id).querySelector('.cs-trigger');
    const details = trigger.closest('details');
    if (details) details.open = true;
    surface.scrollTop += trigger.getBoundingClientRect().top - targetY;
    await settle(40);
    return trigger;
  };
  const inspect = (id, label) => {
    const root = $(id), trigger = root.querySelector('.cs-trigger'), popup = root.querySelector('.cs-popup');
    for (const animation of popup.getAnimations()) {
      if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish();
    }
    const r = trigger.getBoundingClientRect(), p = popup.getBoundingClientRect();
    const above = popup.classList.contains('open-up');
    const gap = above ? r.top - p.bottom : p.top - r.bottom;
    const x = p.left + p.width / 2, y = p.top + Math.min(p.height / 2, 24);
    const selected = popup.querySelector('.cs-option.selected');
    const row = selected.getBoundingClientRect();
    const sample = { label, id, theme, viewport: [innerWidth, innerHeight], trigger: r.toJSON(), popup: p.toJSON(), above, gap, transform: getComputedStyle(popup).transform, pageScroll: pageScroll(), popupScroll: popup.scrollTop };
    geometry.push(sample);
    const expectedRight = Math.min(innerWidth - 10, Math.max(p.width + 10, r.right));
    check(label + '-anchored', !popup.hidden && popup.matches(':popover-open') && Math.abs(gap - 4) <= 1.1 && Math.abs(p.right - expectedRight) <= 1.1, sample);
    check(label + '-visibleAndClickable', p.width > 0 && p.height > 0 && p.left >= 9 && p.right <= innerWidth - 9 && p.top >= 9 && p.bottom <= innerHeight - 9 && popup.contains(document.elementFromPoint(x, y)), sample);
    return { root, trigger, popup, selected, sample, selectedVisible: row.top >= p.top - 1 && row.bottom <= p.bottom + 1 };
  };
  const open = async (id, label, targetY) => {
    document.body.click();
    const trigger = await positionTrigger(id, targetY);
    const before = pageScroll();
    trigger.click();
    await settle();
    const opened = inspect(id, label);
    check(label + '-doesNotScrollPage', equalScroll(before), { before, after: pageScroll() });
    return opened;
  };
  document.documentElement.dataset.theme = theme;
  await settle(220);
  document.body.click();
  choose('svEditType', 'chat');
  choose('svEditRepeat', 'daily');
  for (const id of ['svEditType', 'svEditMode', 'svEditMemory', 'svEditRepeat', 'svEditTime']) await open(id, id);
  choose('svEditRepeat', 'weekly');
  await open('svEditWeekDay', 'weekly');
  choose('svEditRepeat', 'monthly');
  await open('svEditMonthDay', 'monthly');
  choose('svEditRepeat', 'custom');
  await open('svEditCustomRepeat', 'customRepeat');
  choose('svEditRepeat', 'every');
  await open('svEditEveryUnit', 'intervalUnit');
  choose('svEditRepeat', 'daily');
  const late = $('svEditTime').querySelector('.cs-option:last-child').dataset.value;
  choose('svEditTime', late);
  let opened = await open('svEditTime', 'lateTime');
  check('lateTime-selectedVisible', opened.selectedVisible && opened.popup.scrollTop > 0 && late.startsWith('23:'), opened.sample);
  const beforeKeys = pageScroll();
  opened.trigger.focus({ preventScroll: true });
  key(opened.trigger, 'Home'); await settle(40);
  check('homeScrollsOnlyOptions', equalScroll(beforeKeys) && document.activeElement === opened.popup.querySelector('.cs-option') && opened.popup.scrollTop < 10, { beforeKeys, after: pageScroll(), menu: opened.popup.scrollTop });
  key(document.activeElement, 'End'); await settle(40);
  check('endScrollsOnlyOptions', equalScroll(beforeKeys) && document.activeElement === opened.popup.querySelector('.cs-option:last-child') && opened.popup.scrollTop > 0, { beforeKeys, after: pageScroll() });
  key(document.activeElement, 'Escape'); await settle(40);
  check('escapeClosesAndReturnsFocus', opened.popup.hidden && !opened.popup.matches(':popover-open') && opened.trigger.getAttribute('aria-expanded') === 'false' && document.activeElement === opened.trigger && equalScroll(beforeKeys));
  opened = await open('svEditTime', 'downward', 180);
  check('downwardWhenRoom', !opened.sample.above, opened.sample);
  opened = await open('svEditTime', 'upward', innerHeight - 110);
  check('upwardWhenRoom', opened.sample.above, opened.sample);
  key(opened.trigger, 'Tab'); await settle(40);
  check('tabClosesMenu', opened.popup.hidden && !opened.popup.matches(':popover-open') && opened.trigger.getAttribute('aria-expanded') === 'false');

  if (lifecycle) {
    opened = await open('svEditTime', 'beforeParentScroll');
    const previousTop = opened.trigger.getBoundingClientRect().top;
    surface.scrollTop += 35;
    await settle();
    inspect('svEditTime', 'afterParentScroll');
    check('parentScrollMovesAnchor', Math.abs(previousTop - opened.trigger.getBoundingClientRect().top) >= 20);
    const oldStyle = host.getAttribute('style');
    const previousRight = opened.trigger.getBoundingClientRect().right;
    host.style.width = '860px'; host.style.maxWidth = 'calc(100% - 120px)'; host.style.marginLeft = '120px';
    await settle(220);
    inspect('svEditTime', 'afterSidebarLayoutChange');
    check('layoutChangeMovesAnchor', Math.abs(previousRight - opened.trigger.getBoundingClientRect().right) >= 20);
    if (oldStyle === null) host.removeAttribute('style'); else host.setAttribute('style', oldStyle);
    await settle();
    document.body.click();
    const type = await open('svEditType', 'exclusiveFirst');
    const modeTrigger = await positionTrigger('svEditMode');
    modeTrigger.click(); await settle();
    const mode = inspect('svEditMode', 'exclusiveSecond');
    check('onlyOneMenuOpen', type.popup.hidden && !type.popup.matches(':popover-open') && document.querySelectorAll('.cs-popup:popover-open').length === 1);
    document.body.click(); await settle(40);
    check('outsideClickCloses', mode.popup.hidden && !mode.popup.matches(':popover-open') && mode.trigger.getAttribute('aria-expanded') === 'false');
    opened = await open('svEditMode', 'beforeHiddenTrigger');
    const hiddenRow = opened.trigger.closest('.sv-edit-row');
    hiddenRow.classList.add('hidden');
    await settle();
    check('hiddenTriggerClosesMenu', opened.popup.hidden && !opened.popup.matches(':popover-open') && opened.trigger.getAttribute('aria-expanded') === 'false', {
      triggerRects: opened.trigger.getClientRects().length,
      checkVisibility: opened.trigger.checkVisibility(),
      checkVisibilityWithProperty: opened.trigger.checkVisibility({ visibilityProperty: true }),
      connected: opened.trigger.isConnected,
      popupHidden: opened.popup.hidden,
      popupOpen: opened.popup.matches(':popover-open'),
      expanded: opened.trigger.getAttribute('aria-expanded'),
      rowHidden: hiddenRow.classList.contains('hidden'),
      visibility: getComputedStyle(opened.trigger).visibility,
    });
    hiddenRow.classList.remove('hidden');
    opened = await open('svEditTime', 'beforePageHidden');
    host.classList.add('hidden'); await settle();
    check('hiddenPageClosesMenu', opened.popup.hidden && !opened.popup.matches(':popover-open'));
    host.classList.remove('hidden'); await settle(40);
    opened = await open('svEditTime', 'beforeEditorReplacement');
    $('svList').querySelector('[data-task-id="every"] .sv-card-select').click(); await settle();
    check('removedTriggerClosesMenu', !opened.trigger.isConnected && opened.popup.hidden && !opened.popup.matches(':popover-open') && document.querySelectorAll('.cs-popup:popover-open').length === 0);
    $('svList').querySelector('[data-task-id="cron"] .sv-card-select').click(); await settle();
  }

  // Shared settings consumers must keep their descendant option handlers and
  // scoped styles when the menu escapes an ancestor's clipping/transform.
  const generic = document.createElement('section');
  generic.style.cssText = 'position:fixed;left:35px;top:100px;width:240px;height:100px;overflow:auto;transform:translateX(19px);z-index:1200';
  generic.innerHTML = '<div style="height:20px"></div>' + buildCustomSelect('fixtureSettingsSelect', Array.from({ length: 32 }, (_, i) => ({ value: String(i), label: '设置选项 ' + i })), '31') + '<div style="height:180px"></div>';
  document.body.appendChild(generic); bindCustomSelects(generic);
  let calls = 0;
  generic.querySelectorAll('.cs-option').forEach(option => option.addEventListener('click', () => { calls++; }));
  const genericScroll = generic.scrollTop;
  generic.querySelector('.cs-trigger').click(); await settle();
  const shared = inspect('fixtureSettingsSelect', 'sharedSettings');
  check('sharedSettingsRetainsSelectionAndTheme', shared.selectedVisible && shared.popup.scrollTop > 0 && generic.scrollTop === genericScroll && getComputedStyle(shared.popup).backgroundColor === getComputedStyle(host.querySelector('.sv-detail-column')).backgroundColor, shared.sample);
  shared.popup.querySelector('.cs-option[data-value="30"]').click();
  check('sharedSettingsRetainsHandlers', calls === 1 && shared.root.dataset.value === '30' && shared.root.querySelector('.cs-text').textContent === '设置选项 30' && shared.popup.hidden);
  generic.remove();
  check('readableTypeHierarchy', parseFloat(getComputedStyle($('svEditPrompt')).fontSize) >= 14 && parseFloat(getComputedStyle(host.querySelector('.sv-field-label')).fontSize) >= 13 && parseFloat(getComputedStyle(host.querySelector('.sv-card-meta')).fontSize) >= 12);
  await open('svEditTime', 'captureTime');
  return { checks, geometry };
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const win = new BrowserWindow({ width: 1250, height: 950, show: false, webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer stopped: ' + details.reason));
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><div class="app"></div></body></html>'));
  win.showInactive();
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
  await win.webContents.executeJavaScript(`(() => { const template=document.createElement('template'); template.innerHTML=${JSON.stringify(html)}; document.querySelector('.app').appendChild(template.content.querySelector('#scheduleModal')); })()`);
  for (const file of [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(match => match[1])) {
    const full = path.join(root, 'renderer', file);
    if (fs.existsSync(full)) await win.webContents.insertCSS(fs.readFileSync(full, 'utf8'));
  }
  await win.webContents.insertCSS('.app{display:block!important;overflow:hidden;width:100%;height:100vh}');
  await win.webContents.executeJavaScript(`
    window.$ = id => document.getElementById(id);
    window.bindTransientScrollbar = () => {};
    window.closeProviderModelPickers = () => {};
    window.rendererErrors = [];
    window.addEventListener('error', event => rendererErrors.push(event.message));
    window.addEventListener('unhandledrejection', event => rendererErrors.push(String(event.reason)));
    window.showToast = value => window.fixture.toasts.push(value);
    window.showAppView = name => { window.fixture.view = name; $('scheduleModal').classList.remove('hidden'); };
    window.returnToConversationView = () => { window.fixture.view = 'chat'; $('scheduleModal').classList.add('hidden'); };
    window.refreshHistoryList = () => {};
    window.loadConversation = async id => { window.fixture.loaded = id; };
    window.loadCreateConv = async id => { window.fixture.loaded = id; };
    window.fixture = { view: 'chat', toasts: [], updates: [], creates: [], runs: [], toggles: [], items: [
      {id:'cron',name:'晨间工作简报',enabled:true,catchUp:true,schedule:{kind:'cron',cron:'0 9 * * 1-5',tz:'Asia/Shanghai',exact:true,jitterSec:17},action:{type:'chat',prompt:'整理今天的工作。',model:'haiku',memory:'read',mode:'plain'},delivery:{notify:false,saveToHistory:false}},
      {id:'every',name:'定期整理',enabled:true,schedule:{kind:'every',everyMs:5400000,tz:'UTC',exact:true,jitterSec:9},action:{type:'chat',prompt:'整理内容',model:'sonnet'},delivery:{}},
      {id:'at',name:'单次提醒',enabled:false,schedule:{kind:'at',at:'2026-01-02T03:04:05.123Z',tz:'UTC',exact:true,jitterSec:2},action:{type:'chat',prompt:'提醒内容',model:'opus'},delivery:{}},
      {id:'complex',name:'复杂计划',enabled:true,schedule:{kind:'cron',cron:'5,25 8-18/2 * * 1,3,5',tz:'Europe/London',exact:true,jitterSec:4},action:{type:'command',command:'synthetic text only'},delivery:{}}
    ] };
    window.api = { scheduler: {
      list: async () => { if(fixture.failList) return {ok:false,error:'合成读取失败'}; return {ok:true,items:structuredClone(fixture.items)}; },
      runs: async id => { fixture.recordReads=(fixture.recordReads||0)+1; if(fixture.failRuns) return {ok:false,error:'合成记录读取失败'}; const items=fixture.items.map((task,index)=>({taskId:task.id,at:'2026-09-07T0'+(index%9)+':00:00Z',status:'ok',summary:'**合成测试记录**'+task.name,ms:3723000,conversationId:'example-'+task.id})); items.push({taskId:'removed',taskName:'已移除的历史任务',at:'2026-09-07T10:00:00Z',status:'error',error:'合成错误详情'}); return {ok:true,items:id?items.filter(record=>record.taskId===id):items}; },
      preview: async schedule => ({ok:true,times:schedule.kind==='at' && Date.parse(schedule.at)<Date.now()?[]:['2099-01-01T00:00:00Z']}),
      update: async (id,payload) => { fixture.updates.push({id,payload:structuredClone(payload)}); if(fixture.failSave) return {ok:false,error:'合成保存失败'}; const task=fixture.items.find(item=>item.id===id); Object.assign(task,structuredClone(payload)); return {ok:true,task:structuredClone(task)}; },
      create: async payload => { const task={id:'new-created',...structuredClone(payload)};fixture.creates.push(task);fixture.items.push(task);return {ok:true,task}; },
      toggle: async (id,enabled) => { fixture.toggles.push({id,enabled});fixture.items.find(item=>item.id===id).enabled=enabled;return {ok:true}; },
      runNow: async id => {fixture.runs.push(id);return {ok:true};},
      remove: async id => {if(fixture.failRemove)return {ok:false,error:'合成删除失败'};(fixture.removed ||= []).push(id);fixture.items=fixture.items.filter(item=>item.id!==id);return {ok:true};},
      onUpdate: handler => {fixture.push=handler;}
    }}; void 0;
  `);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'renderer/vendor/marked.umd.js'), 'utf8') + '; void 0;');
  await win.webContents.executeJavaScript('window.relayRenderMarkdown = text => marked.parse(text); void 0;');
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'renderer/read-only-markdown.js'), 'utf8'));
  const confirmSource = source.slice(source.indexOf('function customConfirm('), source.indexOf('// 文本输入对话框'));
  await win.webContents.executeJavaScript(escaping + helpers + confirmSource + source.slice(start, end));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const result={};
    const check=(name,value)=>{result[name]=!!value;if(!value)throw Error(name);};
    const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
    const select=async id=>{$('svList').querySelector('[data-task-id="'+id+'"] .sv-card-select').click();await settle();};
    const input=(id,value)=>{const control=$(id);control.value=value;control.dispatchEvent(new Event('input',{bubbles:true}));};
    const option=async(id,value)=>{$(id).querySelector('.cs-option[data-value="'+value+'"]').click();await settle();};
    const save=async()=>{$('svEditorSave').click();await settle();};
    window.openScheduleModal();await settle();
    check('initialMainPage',fixture.view==='scheduler'&&$('svList').querySelectorAll('.sv-card').length===4&&!$('svEditorPane').classList.contains('hidden'));
    check('initialTasksDoNotFetchRecords',$('svEditName').value==='晨间工作简报'&&!fixture.recordReads&&!$('svEditorPane').querySelector('[data-sv-runs]')&&$('svRunsPanel').classList.contains('hidden'));
    check('executionSettingsAreDirectlyVisible',!$('svEditType').closest('details')&&$('svEditType').checkVisibility()&&$('svEditModel').checkVisibility()&&$('svEditMode').checkVisibility()&&$('svExecutionTitle').tagName!=='SUMMARY');
    check('cardActionsOnlyOfferDelete',!$('svList').querySelector('.sv-card-menu')&&$('svList').querySelectorAll('.sv-card-delete').length===4&&[...$('svList').querySelectorAll('.sv-card-delete')].every(button=>button.title==='删除定时任务'&&button.querySelector('svg')));
    fixture.items.push({...structuredClone(fixture.items[0]),id:'delete-fixture',name:'可删除的合成任务'});fixture.push();await settle();await select('delete-fixture');
    input('svEditPrompt','取消删除后保留的草稿');
    const requestDelete=()=>document.querySelector('[data-task-id="delete-fixture"] .sv-card-delete').click();
    requestDelete();await settle();
    check('deleteStillRequiresConfirmation',document.querySelector('.confirm-dialog[role="alertdialog"]')?.textContent.includes('可删除的合成任务')&&document.activeElement.classList.contains('cancel')&&!fixture.removed?.length);
    check('deleteDoesNotOfferRedundantEditMenu',!document.querySelector('.copy-popover.show')&&document.querySelector('[data-task-id="delete-fixture"] .sv-card-delete').disabled);
    document.querySelector('.confirm-btn.cancel').click();await settle();
    check('cancelDeletePreservesTaskAndDraft',$('svEditName').value==='可删除的合成任务'&&$('svEditPrompt').value==='取消删除后保留的草稿'&&!fixture.removed?.length&&!document.querySelector('[data-task-id="delete-fixture"] .sv-card-delete').disabled);
    fixture.failRemove=true;requestDelete();await settle();document.querySelector('.confirm-btn.danger').click();await settle();
    check('deleteFailurePreservesTaskAndDraft',fixture.toasts.at(-1)==='合成删除失败'&&$('svEditPrompt').value==='取消删除后保留的草稿'&&!!document.querySelector('[data-task-id="delete-fixture"]'));
    fixture.failRemove=false;requestDelete();await settle();document.querySelector('.confirm-btn.danger').click();await settle();
    check('confirmedDeleteRemovesOnlySelectedTask',fixture.removed.length===1&&fixture.removed[0]==='delete-fixture'&&$('svList').querySelectorAll('.sv-card').length===4&&!document.querySelector('[data-task-id="delete-fixture"]')&&$('svEditName').value==='晨间工作简报');
    $('svRunsTab').click();await settle();
    check('recordsHaveSeparatePage',$('svTasksPanel').classList.contains('hidden')&&!$('svRunsPanel').classList.contains('hidden')&&$('svRunsTab').getAttribute('aria-selected')==='true'&&$('svRunsList').querySelectorAll('.sv-run-record').length===5);
    check('recordsRenderMarkdown',$('svRunsList').querySelector('strong')?.textContent==='合成测试记录');
    check('recordsIncludeRemovedAndDuration',$('svRunsList').textContent.includes('已移除的历史任务')&&$('svRunsList').textContent.includes('1 小时 2 分钟 3 秒'));
    $('svTasksTab').click();await settle();
    check('tasksReturnWithoutFetchingRecords',fixture.recordReads===1);
    const originalEditor=$('svEditName');
    input('svEditName','跨标签草稿');$('svRunsTab').click();await settle();$('svTasksTab').click();await settle();
    check('tabSwitchRetainsDraftNodeAndValue',$('svEditName')===originalEditor&&$('svEditName').value==='跨标签草稿'&&!$('svEditorSave').disabled);
    document.querySelector('[data-sv-detail-history]').click();await settle();
    check('taskHistoryShortcutFiltersRecords',$('svRunTaskSelect').dataset.value==='cron'&&$('svRunsList').querySelectorAll('.sv-run-record').length===1&&$('svRunsList').textContent.includes('晨间工作简报'));
    await option('svRunTaskSelect','');
    check('allTasksFilterIsInstant',$('svRunsList').querySelectorAll('.sv-run-record').length===5);
    input('svRunsSearch','合成错误详情');
    check('recordSearchMatchesErrors',$('svRunsList').querySelectorAll('.sv-run-record').length===1&&$('svRunsList').textContent.includes('已移除的历史任务'));
    input('svRunsSearch','不存在的关键词');check('noMatchingRecords',$('svRunsList').textContent.includes('没有找到相关记录'));
    input('svRunsSearch','');
    fixture.failRuns=true;$('svRunsRefresh').click();await settle();
    check('recordFailureKeepsSnapshot',$('svRunsList').querySelectorAll('.sv-run-record').length===5&&$('svRunsSummary').textContent.includes('刷新重试')&&!$('svRunsRefresh').disabled);
    fixture.failRuns=false;$('svRunsRefresh').click();await settle();
    check('recordRefreshRecovers',$('svRunsSummary').textContent==='5 条运行记录');
    const originalRuns=api.scheduler.runs;
    api.scheduler.runs=async()=>({ok:true,items:Array.from({length:45},(_,i)=>({taskId:'cron',at:new Date(Date.UTC(2026,8,1,0,i)).toISOString(),status:'ok',summary:'分页记录 '+i}))});
    $('svRunsRefresh').click();await settle();
    check('recordsRenderFirstPage',$('svRunsList').querySelectorAll('.sv-run-record').length===20&&!$('svRunsMore').classList.contains('hidden'));
    $('svRunsMore').click();check('recordsLoadSecondPage',$('svRunsList').querySelectorAll('.sv-run-record').length===40);
    $('svRunsMore').click();check('recordsLoadFinalPage',$('svRunsList').querySelectorAll('.sv-run-record').length===45&&$('svRunsMore').classList.contains('hidden'));
    api.scheduler.runs=async()=>({ok:true,items:[]});$('svRunsRefresh').click();await settle();
    check('emptyRecordsAreExplicit',$('svRunsList').textContent.includes('还没有运行记录'));
    const deferred=[];api.scheduler.runs=()=>new Promise(resolve=>deferred.push(resolve));
    $('svTasksTab').click();$('svRunsTab').click();$('svTasksTab').click();$('svRunsTab').click();
    deferred[1]({ok:true,items:[{taskId:'cron',status:'ok',summary:'最新记录',at:'2026-09-08'}]});await settle();
    deferred[0]({ok:true,items:[{taskId:'cron',status:'ok',summary:'过期记录',at:'2026-09-07'}]});await settle();
    check('outOfOrderRunsKeepLatest',$('svRunsList').textContent.includes('最新记录')&&!$('svRunsList').textContent.includes('过期记录'));
    api.scheduler.runs=originalRuns;
    $('svRunsTab').focus();$('svRunsTab').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));await settle();
    check('tabsKeyboardNavigation',document.activeElement===$('svTasksTab')&&$('svTasksTab').getAttribute('aria-selected')==='true');
    input('svEditName','未保存标题');input('svEditPrompt','未保存正文');
    check('dirtySaveEnabled',!$('svEditorSave').disabled&&$('svList').textContent.includes('未保存'));
    fixture.items[0].name='服务推送标题';fixture.items[0].running=true;fixture.push();await settle();
    check('pushKeepsDraftAndUpdatesRunStatus',$('svEditName').value==='未保存标题'&&document.querySelector('[data-sv-detail-run]').disabled);
    await select('every');await select('cron');
    check('taskSwitchKeepsDraft',$('svEditName').value==='未保存标题'&&$('svEditPrompt').value==='未保存正文');
    $('svModalClose').click();window.openScheduleModal();await settle();
    check('navigationKeepsDraft',$('svEditName').value==='未保存标题');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    check('escapeDoesNotDiscard',$('svEditName').value==='未保存标题');
    $('svEditorBack').click();await settle();
    check('cancelUsesLatestServerTask',$('svEditName').value==='服务推送标题'&&$('svEditorSave').disabled);
    fixture.items[0].running=false;fixture.push();await settle();
    await option('svEditRepeat','daily');
    check('customSelectMarksDirty',!$('svEditorSave').disabled);
    $('svEditorBack').click();await settle();
    $('svEditModel').querySelector('button[data-value="opus"]').click();await settle();
    check('segmentedMarksDirty',!$('svEditorSave').disabled);
    input('svEditName','已保存标题');await save();
    check('unchangedCronMetadataPreserved',JSON.stringify(fixture.updates.at(-1).payload.schedule)===JSON.stringify({kind:'cron',cron:'0 9 * * 1-5',tz:'Asia/Shanghai',exact:true,jitterSec:17}));
    check('deliveryAndModelPreserved',fixture.updates.at(-1).payload.delivery.notify===false&&fixture.updates.at(-1).payload.delivery.saveToHistory===false&&fixture.updates.at(-1).payload.action.model==='opus');
    for (const [model,label] of [['haiku','快速'],['sonnet','思考'],['opus','专家']]) {
      $('svEditModel').scrollIntoView({block:'center'});await settle();
      if (model==='sonnet') {
        const active=$('svEditModel').querySelector('button.active');active.focus();
        active.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
      } else $('svEditModel').querySelector('button[data-value="'+model+'"]').click();
      await settle();
      const selected=$('svEditModel').querySelector('button.active');
      check('model-'+model+'-selection',selected.textContent.trim()===label&&selected.dataset.value===model&&selected.getAttribute('aria-checked')==='true'&&$('svEditModel').querySelectorAll('[aria-checked="true"]').length===1&&!$('svEditorSave').disabled);
      await save();
      check('model-'+model+'-savedValue',fixture.updates.at(-1).id==='cron'&&fixture.updates.at(-1).payload.action.model===model&&fixture.items.find(item=>item.id==='cron').action.model===model);
      await select('every');await select('cron');
      check('model-'+model+'-reopens', $('svEditModel').dataset.value===model&&$('svEditModel').querySelector('button.active').dataset.value===model&&$('svEditModel').querySelector('button.active').textContent.trim()===label&&$('svEditorSave').disabled);
    }
    await select('every');input('svEditName','间隔改名');await save();
    check('everyExactSchedulePreserved',fixture.updates.at(-1).payload.schedule.everyMs===5400000&&fixture.updates.at(-1).payload.schedule.kind==='every'&&fixture.updates.at(-1).payload.schedule.jitterSec===9);
    input('svEditEveryAmount','2.5');await option('svEditEveryUnit','3600000');await save();
    check('everyEditsRemainEvery',fixture.updates.at(-1).payload.schedule.everyMs===9000000&&fixture.updates.at(-1).payload.schedule.kind==='every');
    await select('at');input('svEditName','单次改名');await save();
    check('completedAtPreservesMilliseconds',fixture.updates.at(-1).payload.schedule.at==='2026-01-02T03:04:05.123Z'&&fixture.updates.at(-1).payload.schedule.kind==='at');
    input('svEditAt','2099-03-04T05:06:07');await save();
    check('atDateEditsRemainAt',fixture.updates.at(-1).payload.schedule.kind==='at'&&Date.parse(fixture.updates.at(-1).payload.schedule.at)===new Date('2099-03-04T05:06:07').getTime());
    await select('complex');check('complexCronShownExactly',$('svEditRepeat').dataset.value==='cron'&&$('svEditCron').value==='5,25 8-18/2 * * 1,3,5');
    input('svEditName','复杂计划改名');await save();
    check('complexCronSavedExactly',fixture.updates.at(-1).payload.schedule.cron==='5,25 8-18/2 * * 1,3,5'&&fixture.updates.at(-1).payload.schedule.tz==='Europe/London'&&fixture.updates.at(-1).payload.action.command==='synthetic text only');
    await select('every');input('svEditPrompt','草稿仍然在');document.querySelector('[data-sv-detail-toggle]').click();await settle();await save();
    check('toggleDoesNotLoseDraftOrReenable',fixture.updates.at(-1).payload.enabled===false&&fixture.updates.at(-1).payload.action.prompt==='草稿仍然在');
    document.querySelector('[data-sv-detail-run]').click();await settle();check('runButtonUsesExistingApi',fixture.runs.at(-1)==='every');
    fixture.failSave=true;input('svEditName','失败后保留');await save();
    check('saveFailureKeepsDraft',$('svEditName').value==='失败后保留'&&$('svEditorHint').textContent==='合成保存失败'&&!$('svEditorSave').disabled);fixture.failSave=false;
    fixture.failList=true;fixture.push();await settle();check('listFailureKeepsCardsAndDraft',$('svList').querySelectorAll('.sv-card').length===4&&$('svEditName').value==='失败后保留');fixture.failList=false;
    $('svModalAdd').click();await settle();input('svEditName','新草稿');input('svEditPrompt','这是新任务');
    await select('cron');await select('__new__');check('newDraftSurvivesSelection',$('svEditName').value==='新草稿');
    $('svEditorBack').click();await settle();check('cancelNewRemovesDraft',!$('svList').querySelector('[data-task-id="__new__"]'));
    $('svModalAdd').click();await settle();input('svEditName','新建已保存');input('svEditPrompt','合成内容');await save();
    check('createUsesApiAndStaysSelected',fixture.creates.length===1&&$('svEditName').value==='新建已保存'&&$('svList').querySelector('.is-selected').dataset.taskId==='new-created');
    const trigger=$('svEditRepeat').querySelector('.cs-trigger');trigger.focus();trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await settle();
    check('keyboardSelectWorks',$('svEditRepeat').dataset.value==='cron'&&document.activeElement===trigger&&!$('svEditorSave').disabled);
    $('svEditorBack').click();await settle();document.querySelector('[data-sv-detail-history]').click();await settle();document.querySelector('[data-sv-runs] .sv-run-open').click();await settle();
    check('recordOpensRealConversationLink',fixture.loaded==='example-new-created'&&fixture.view==='chat');
    window.openScheduleModal();await settle();$('svTasksTab').click();await settle();
    const originalList=api.scheduler.list;
    const pending=[];
    api.scheduler.list=()=>new Promise(resolve=>pending.push(resolve));
    window.openScheduleModal();window.openScheduleModal();
    const newest=structuredClone(fixture.items);newest.find(item=>item.id==='complex').name='最新列表快照';
    pending[1]({ok:true,items:newest});await settle();pending[0]({ok:true,items:[]});await settle();
    check('outOfOrderListKeepsNewest',$('svList').querySelectorAll('.sv-card').length===5&&$('svList').textContent.includes('最新列表快照'));
    api.scheduler.list=originalList;
    const originalUpdate=api.scheduler.update;let releaseSave;let saves=0;
    api.scheduler.update=async(id,payload)=>{saves++;await new Promise(resolve=>releaseSave=resolve);return originalUpdate(id,payload);};
    input('svEditName','异步保存');$('svEditorSave').click();await settle();
    check('savingFreezesEditorOnly',$('svEditorPane').inert&&$('svEditorBack').disabled&&document.querySelector('[data-sv-detail-run]').disabled);
    $('svEditorSave').click();await select('every');
    check('savingDoesNotSwitchOrDuplicate',saves===1&&$('svEditName').value==='异步保存');
    $('svModalClose').click();releaseSave();await settle();
    check('saveCompletesWhileAway',fixture.view==='chat'&&!$('svEditorPane').inert);
    api.scheduler.update=originalUpdate;window.openScheduleModal();await settle();await select('cron');
    return result;
  })()`);
  await new Promise(resolve => setTimeout(resolve, 180));
  fs.writeFileSync(path.join(outputDir,'wide.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("$('svRunsTab').click()");
  await new Promise(resolve=>setTimeout(resolve,180));
  fs.writeFileSync(path.join(outputDir,'runs-light.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
  fs.writeFileSync(path.join(outputDir,'runs-dark.png'),(await win.webContents.capturePage()).toPNG());
  win.setContentSize(620,720);
  await new Promise(resolve=>setTimeout(resolve,160));
  result.recordsNarrowFits = await win.webContents.executeJavaScript("$('svRunsPanel').scrollWidth <= $('svRunsPanel').clientWidth+1 && $('scheduleModal').scrollWidth <= innerWidth");
  fs.writeFileSync(path.join(outputDir,'runs-narrow.png'),(await win.webContents.capturePage()).toPNG());
  if (!result.recordsNarrowFits) throw new Error('recordsNarrowFits');
  win.setContentSize(1250,950);
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme='light';$('svTasksTab').click()");
  await win.webContents.executeJavaScript("$('scheduleModal').style.width='250px';$('scheduleModal').style.maxWidth='250px'");
  await new Promise(resolve => setTimeout(resolve, 100));
  result.narrow250Fits = await win.webContents.executeJavaScript("$('scheduleModal').scrollWidth<=250 && document.querySelector('.sv-workspace-layout').getBoundingClientRect().width > 0");
  result.footerReachableByScroll = await win.webContents.executeJavaScript("(() => { const surface=$('scheduleModal').querySelector('.workspace-surface'); surface.scrollTop=surface.scrollHeight; return surface.scrollHeight>surface.clientHeight && $('svEditorSave').getBoundingClientRect().bottom <= window.innerHeight; })()");
  if (!result.footerReachableByScroll) throw new Error('footerReachableByScroll');
  if (!result.narrow250Fits) {
    console.log(await win.webContents.executeJavaScript("JSON.stringify([...$('scheduleModal').querySelectorAll('*')].filter(el=>el.scrollWidth>250&&getComputedStyle(el).display!=='none').map(el=>[el.className,el.id,el.scrollWidth]))"));
    throw new Error('narrow250Fits');
  }
  fs.writeFileSync(path.join(outputDir,'narrow.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("$('scheduleModal').style.width='';$('scheduleModal').style.maxWidth='';");
  const geometry = [];
  for (const [width, height, theme, lifecycle] of [[1250, 900, 'light', true], [900, 720, 'dark', false], [620, 720, 'light', false]]) {
    win.setContentSize(width, height);
    await new Promise(resolve => setTimeout(resolve, 180));
    const interaction = await win.webContents.executeJavaScript('(' + checkSelectInteractions.toString() + ')(' + JSON.stringify(theme) + ',' + lifecycle + ')');
    Object.assign(result, interaction.checks); geometry.push(...interaction.geometry);
    await win.webContents.capturePage();
    await new Promise(resolve => setTimeout(resolve, 60));
    fs.writeFileSync(path.join(outputDir, 'time-' + width + '-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript('document.body.click()');
  }
  fs.writeFileSync(path.join(outputDir, 'geometry.json'), JSON.stringify(geometry, null, 2));
  const modelGeometry = [];
  for (const [width, height, containerWidth] of [[1250, 900, 0], [620, 720, 0], [900, 720, 250]]) {
    win.setContentSize(width, height);
    await new Promise(resolve => setTimeout(resolve, 80));
    for (const theme of ['light', 'dark']) {
      const model = await win.webContents.executeJavaScript('(' + checkModelGeometry.toString() + ')(' + JSON.stringify(theme) + ',' + containerWidth + ')');
      Object.assign(result, model.checks); modelGeometry.push(model.geometry);
      fs.writeFileSync(path.join(outputDir, 'model-' + width + '-' + (containerWidth || 'full') + '-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
    }
  }
  fs.writeFileSync(path.join(outputDir, 'model-geometry.json'), JSON.stringify(modelGeometry, null, 2));
  errors.push(...await win.webContents.executeJavaScript('rendererErrors'));
  result.noRendererErrors = errors.length === 0;
  fs.writeFileSync(path.join(outputDir, 'errors.json'), JSON.stringify(errors, null, 2));
  if (!result.noRendererErrors) throw Error('rendererErrors: ' + JSON.stringify(errors));
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  clearTimeout(timeout);win.destroy();app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(outputDir, 'errors.json'), JSON.stringify([...errors, error.stack], null, 2));console.error(error.stack);clearTimeout(timeout);app.exit(1);});
