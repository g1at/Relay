'use strict';
// Production settings renderer with synthetic snapshots only. No main process or user files.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/usage-page-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile')); app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting'; const checks = {}, failures = [], diagnostics = {};
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, failures, diagnostics }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout: ' + step); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function next(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(next,20)}next()})`); }
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function check(name, code) { step = name; checks[name] = !!await evaluate(code); save(); if (!checks[name]) throw Error(name); }
async function click(selector) { await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'nearest'});node.click()})()`); await settle(); }
async function screenshot(name) { await settle(); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
function installFixture() {
  const base = window.api;
  const state = window.usageFixture = { mode: 'hold', calls: [], pending: [], listeners: new Set(), overrides: {}, firstFrame: null };
  state.snapshot = (days, extra = {}) => {
    const daily = Array.from({ length: days }, (_, index) => ({ date: new Date(Date.UTC(2026, 8, 9 - days + 1 + index)).toISOString().slice(0, 10), count: index % 5 === 0 ? 0 : (index * 7) % 13 + 1 }));
    const result = { ok: true, available: true, days, generatedAt: '2026-09-09T04:12:00Z', refreshing: false, stale: false, error: null, totals: { messages: daily.reduce((sum, day) => sum + day.count, 0) }, daily,
      tokens: { available: true, totalTokens: 75000, inputTokens: 45000, outputTokens: 19000, cacheReadTokens: 6400, cacheCreationTokens: 4600, coverage: 'partial', byModel: [
        { key: 'provider/deepseek-v4-flash', count: 44000 }, { key: 'provider/claude-sonnet', count: 18000 }, { key: 'provider/claude-haiku', count: 7000 }, { key: 'provider/claude-opus', count: 3000 },
        { key: 'gateway/<img src=x onerror="window.__usageXss=1">', count: 1700 }, { key: 'model-six-with-a-very-long-name-that-must-stay-within-the-page', count: 900 }, { key: 'provider/model-seven', count: 400 },
      ] }, coverage: { history: 'complete', warningCodes: [] }, ...extra };
    if (result.tokens.available) {
      const fields=['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens'], weight=daily.reduce((total,item)=>total+item.count,0); let consumed=0;
      result.tokens.daily=daily.map(item=>{const before=consumed;consumed+=item.count;const row={date:item.date};for(const key of fields)row[key]=Math.floor(consumed/weight*result.tokens[key])-Math.floor(before/weight*result.tokens[key]);row.totalTokens=fields.reduce((total,key)=>total+row[key],0);return row;});
      let modelTotal=0;for(const model of result.tokens.byModel){const before=modelTotal;modelTotal+=model.count;for(const key of fields.slice(0,-1))model[key]=Math.floor(modelTotal/result.tokens.totalTokens*result.tokens[key])-Math.floor(before/result.tokens.totalTokens*result.tokens[key]);model.cacheCreationTokens=model.count-fields.slice(0,-1).reduce((sum,key)=>sum+model[key],0);}
    }
    return result;
  };
  state.scaleSnapshot = (days, multiplier) => {
    const result = state.snapshot(days), fields = ['totalTokens','inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens'];
    result.totals.messages *= multiplier; result.daily.forEach(day => { day.count *= multiplier; });
    for (const key of fields) result.tokens[key] *= multiplier;
    for (const day of result.tokens.daily) for (const key of fields) day[key] *= multiplier;
    for (const model of result.tokens.byModel) { model.count *= multiplier; for (const key of fields.slice(1)) model[key] *= multiplier; }
    return result;
  };
  state.peakMatches = expected => {
    const known = (expected.tokens.daily || []).filter(day => typeof day.totalTokens === 'number'), peak = known.reduce((best, day) => !best || day.totalTokens >= best.totalTokens ? day : best, null);
    const node = document.querySelector('[data-usage-metric=peak]');
    return node.textContent === (peak ? peak.totalTokens.toLocaleString('zh-CN') : '—') && node.dataset.usagePeakDate === (peak?.date || '') && (!peak || node.title.includes(peak.date));
  };
  state.emit = () => [...state.listeners].forEach(listener => listener({}));
  state.resolve = (days, value) => { const entry = state.pending.findLast(item => item.days === days && !item.done); if (!entry) throw Error('No pending range ' + days); entry.done = true; entry.resolve(value); };
  const stats = {
    overview(days, options) {
      state.calls.push({ days, options });
      if (state.mode === 'hold') return new Promise(resolve => state.pending.push({ days, resolve, done: false }));
      if (state.mode === 'fail') return Promise.reject(Error('Synthetic statistics failure'));
      return Promise.resolve(state.overrides[days] || state.snapshot(days));
    },
    onUpdated(callback) { state.listeners.add(callback); return () => state.listeners.delete(callback); },
  };
  window.api = new Proxy(base, { get(target, key) { return key === 'stats' ? stats : target[key]; } });
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n') + `\n(${installFixture.toString()})();`;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}\nlocalStorage.clear();</script>`);
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({ width: 1200, height: 860, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page); win.showInactive(); await waitFor('!!window.relayUsagePage&&providerRoutingLoaded&&!restoringActiveRuns');
  await evaluate("openSettings('personalize')"); await waitFor("!!document.querySelector('#set-theme')");
  await act("inputEl.value='用量页测试保留的对话草稿';const name=document.querySelector('#set-theme');name.dataset.value='dark';name.dispatchEvent(new Event('input',{bubbles:true}));usageFixture.nameNode=name;document.querySelector('[data-cat=profile].set-nav-item').click();usageFixture.firstFrame={metrics:document.querySelectorAll('[data-usage-metric]').length,chart:!!document.querySelector('[data-usage-chart]'),models:!!document.querySelector('[data-usage-models]'),heading:document.querySelector('.rpp-heading h2')?.textContent};");
  await check('firstClickSynchronouslyBuildsTheCompletePageBeforeStatisticsResolve', "usageFixture.firstFrame.metrics===4&&usageFixture.firstFrame.chart&&usageFixture.firstFrame.models&&usageFixture.firstFrame.heading==='个人资料'&&[...document.querySelectorAll('[data-usage-metric]')].every(node=>node.textContent==='—')");
  diagnostics.initialLoading = await evaluate(`(()=>{const buttons=[...document.querySelectorAll('button[data-usage-days]')],status=document.querySelector('[data-usage-status]')?.textContent||'';return {threeRangeButtons:buttons.length===3,controlsEnabled:buttons.every(node=>!node.disabled),noBlockingLoading:!document.querySelector('.stats-loading'),backgroundStatus:status.includes('后台统计'),buttonCount:buttons.length,matchingAttributes:document.querySelectorAll('[data-usage-days]').length,status};})()`);
  await check('initialLoadingIsQuietAndLeavesRangeControlsAvailable', JSON.stringify(['threeRangeButtons','controlsEnabled','noBlockingLoading','backgroundStatus'].every(key=>diagnostics.initialLoading[key])));
  await screenshot('usage-first-frame');
  await act("usageFixture.resolve(30,{ok:true,days:30,available:false,refreshing:true,totals:{messages:null},daily:[],tokens:{available:false}});");
  await waitFor("document.querySelector('[data-usage-status]').textContent.includes('后台统计')");
  await check('emptyWorkerSnapshotNeverClaimsZeroUsage', "[...document.querySelectorAll('[data-usage-metric]')].every(node=>node.textContent==='—')&&document.querySelector('.relay-usage-page').dataset.usageState==='refreshing'");
  await act("usageFixture.mode='ready';usageFixture.emit();"); await waitFor("document.querySelector('[data-usage-metric=tokens]').textContent==='75,000'");
  await check('completedSnapshotShowsFourMetricsAndOneConsistentDateRange', "document.querySelector('[data-usage-metric=messages]').textContent===usageFixture.snapshot(30).totals.messages.toLocaleString('zh-CN')&&document.querySelectorAll('.rup-heatmap-cell[data-usage-date]').length===30&&document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='30'&&document.querySelectorAll('[data-usage-model]').length===7");
  await check('singleDayPeakIsAnExactRecordedValueWithItsDateWithinTheThirtyDayRange', "usageFixture.peakMatches(usageFixture.snapshot(30))&&document.querySelector('[data-usage-metric=tokens]').textContent==='75,000'&&document.querySelectorAll('[data-usage-metric]').length===4");
  await check('fourBreakdownCardsKeepAbbreviatedValuesAndCenterLabelsAndValues', "(()=>{const keys=['inputTotalTokens','outputTokens','cacheHitRate','cacheReadTokens'],values=['56K','19K','11.4%','6.4K'];return keys.every((key,index)=>{const value=document.querySelector('[data-usage-part='+key+']'),card=value.closest('.rup-token-part'),label=card.querySelector('h4');return value.textContent===values[index]&&getComputedStyle(card).textAlign==='center'&&getComputedStyle(label).justifyContent==='center'&&getComputedStyle(value).textAlign==='center'})})()");
  await check('cacheHitRateReplacesTheCreationCardAndExplainsItsDenominator', "!document.querySelector('[data-usage-part=cacheCreationTokens]')&&document.querySelector('[data-usage-part=cacheHitRate]').closest('article').textContent.includes('缓存命中率')&&document.querySelector('[data-usage-part=cacheHitRate]').title.includes('不包含输出')");
  diagnostics.tokenSummary = await evaluate(`(()=>{const expected=usageFixture.snapshot(30),points=[...document.querySelectorAll('[data-usage-trend-point]')];return {partsMatch:['inputTotalTokens','outputTokens','cacheReadTokens'].every(key=>document.querySelector('[data-usage-part='+key+']').title.startsWith((key==='inputTotalTokens'?expected.tokens.inputTokens+expected.tokens.cacheReadTokens+expected.tokens.cacheCreationTokens:expected.tokens[key]).toLocaleString('zh-CN')+' Token')),compositionReady:document.querySelector('[data-usage-composition]').dataset.state==='ready',tokenMode:document.querySelector('[data-usage-trend-chart]').dataset.mode==='tokens',pointCount:points.length,accuratePoints:points.every((point,index)=>point.dataset.usageTrendPoint===expected.tokens.daily[index].date&&Number(point.dataset.usageCount)===expected.tokens.daily[index].totalTokens),modelComponentCount:document.querySelectorAll('.rup-model-fill .rup-component').length,modelCounters:expected.tokens.byModel.map(model=>({count:model.count,sum:model.inputTokens+model.outputTokens+model.cacheReadTokens+model.cacheCreationTokens}))};})()`);
  await check('tokenSummaryUsesFourRealComponentsAndPreservesAnAccurateDailySeries', JSON.stringify(diagnostics.tokenSummary.partsMatch&&diagnostics.tokenSummary.compositionReady&&diagnostics.tokenSummary.tokenMode&&diagnostics.tokenSummary.pointCount===30&&diagnostics.tokenSummary.accuratePoints&&diagnostics.tokenSummary.modelComponentCount===28));
  await check('tokenHeatmapUsesDailyTokenCountsTitlesAndScale', "(()=>{const expected=usageFixture.snapshot(30).tokens.daily,cells=[...document.querySelectorAll('[data-usage-chart] [data-usage-date]')],peak=Math.max(...expected.map(day=>day.totalTokens));usageFixture.tokenColor=getComputedStyle(document.querySelector('[data-usage-chart] [data-level=\"4\"]')).backgroundColor;return cells.length===30&&document.querySelector('.rup-trend h3').textContent==='每日 Token'&&document.querySelector('[data-usage-chart]').dataset.usageMode==='tokens'&&cells.every((cell,index)=>cell.dataset.usageCount===String(expected[index].totalTokens)&&cell.title===expected[index].date+' · '+expected[index].totalTokens.toLocaleString('zh-CN')+' Token'&&Number(cell.dataset.level)===(expected[index].totalTokens===0?0:Math.max(1,Math.ceil(expected[index].totalTokens/peak*4))))})()");
  await click('[data-usage-trend-mode=messages]');
  await check('conversationTrendIsExplicitAndNeverRelabelsActivityAsTokens', "document.querySelector('[data-usage-flow-caption]').textContent==='每日对话轮次'&&[...document.querySelectorAll('[data-usage-trend-point]')].every((point,index)=>Number(point.dataset.usageCount)===usageFixture.snapshot(30).daily[index].count)&&document.querySelectorAll('.rup-heatmap-cell[data-usage-date]').length===30");
  await waitFor("getComputedStyle(document.querySelector('[data-usage-chart] [data-level=\"4\"]')).backgroundColor!==usageFixture.tokenColor");
  await check('heatmapSwitchesItsTitleTooltipColorsAndCountsWithTheConversationTrend', "(()=>{const expected=usageFixture.snapshot(30).daily,cells=[...document.querySelectorAll('[data-usage-chart] [data-usage-date]')];return document.querySelector('.rup-trend h3').textContent==='每日对话'&&document.querySelector('[data-usage-chart]').dataset.usageMode==='messages'&&cells.every((cell,index)=>cell.dataset.usageCount===String(expected[index].count)&&cell.title===expected[index].date+' · '+expected[index].count.toLocaleString('zh-CN')+' 轮对话')&&getComputedStyle(document.querySelector('[data-usage-chart] [data-level=\"4\"]')).backgroundColor!==usageFixture.tokenColor})()");
  await click('[data-usage-trend-mode=tokens]');
  await act("document.querySelector('[data-usage-trend-chart]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));");
  await check('dailyTokenDetailsAreKeyboardAccessibleWithoutMovingFocus', "document.activeElement.hasAttribute('data-usage-trend-chart')&&document.activeElement.dataset.selectedDate==='2026-09-09'&&document.querySelector('[data-usage-flow-detail]').textContent.includes('Token')&&document.querySelectorAll('[data-usage-flow-detail] .rup-flow-value').length===4");
  await check('removedFooterKeepsRecordedLabelsAndLegendWhileHostileModelsStayPlainText', "!document.querySelector('.rup-footnote')&&document.querySelector('.rup-metric-primary h3').textContent==='已记录 Token'&&document.querySelectorAll('.rup-model-legend').length===4&&!document.querySelector('.rup-models img')&&window.__usageXss===undefined&&!document.querySelector('.model-token-donut')&&!document.querySelector('.run-list')");
  await check('allModelsStayInsideEqualHeightScrollableCardsWithoutPagination', "(()=>{const list=document.querySelector('[data-usage-models]'),cards=[...document.querySelectorAll('.rup-profile-panels > .rup-section')];return document.querySelectorAll('[data-usage-model]').length===7&&!document.querySelector('[data-usage-model-toggle]')&&cards.length===2&&cards.every(card=>Math.abs(card.getBoundingClientRect().height-300)<1)&&list.scrollHeight>list.clientHeight&&getComputedStyle(list).overflowY==='auto'&&list.getAttribute('tabindex')==='0'})()");
  await act("document.querySelector('[data-usage-models]').scrollIntoView({block:'center'});document.querySelector('[data-usage-models]').focus();");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});
  await waitFor("document.querySelector('[data-usage-models]').scrollTop>0");
  await check('modelListCanBeScrolledFromTheKeyboardWithoutMovingItsCard', "document.activeElement.hasAttribute('data-usage-models')&&document.querySelectorAll('[data-usage-model]').length===7&&Math.abs(document.querySelector('.rup-models').getBoundingClientRect().height-document.querySelector('.rup-trend').getBoundingClientRect().height)<1&&document.querySelector('[data-usage-metric=tokens]').textContent==='75,000'");
  await act("document.querySelector('[data-usage-models]').scrollTop=0;"); await screenshot('usage-light');
  await act("usageFixture.mode='hold';usageFixture.metricNode=document.querySelector('[data-usage-metric=messages]');");
  await click('[data-usage-refresh]');
  await check('refreshKeepsExistingContentAndOnlyExplicitButtonRequestsForce', "document.querySelector('[data-usage-metric=messages]')===usageFixture.metricNode&&document.querySelector('[data-usage-metric=tokens]').textContent==='75,000'&&usageFixture.calls.at(-1).options.refresh===true");
  await click('button[data-usage-days="7"]');
  await check('uncachedRangeKeepsOldDataClearlyLabelledUntilReplacementArrives', "document.querySelector('button[data-usage-days="+'"7"'+"]').getAttribute('aria-pressed')==='true'&&document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='30'&&document.querySelector('[data-usage-range]').textContent==='近 30 天'&&document.querySelector('[data-usage-status]').textContent.includes('近 7 天')");
  await click('button[data-usage-days="90"]');
  await act("usageFixture.resolve(90,usageFixture.snapshot(90));"); await waitFor("document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='90'");
  await act("usageFixture.resolve(7,usageFixture.snapshot(7));usageFixture.resolve(30,usageFixture.snapshot(30,{totals:{messages:99999}}));"); await settle();
  await check('lateResponsesCannotMixOldTotalsIntoTheChosenRange', "document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='90'&&document.querySelector('[data-usage-metric=messages]').textContent===usageFixture.snapshot(90).totals.messages.toLocaleString('zh-CN')&&document.querySelectorAll('.rup-heatmap-cell[data-usage-date]').length===90");
  await check('rangeChangesAndLateResponsesCannotLeaveThePeakFromAnOlderRange', "usageFixture.peakMatches(usageFixture.snapshot(90))&&Math.max(...usageFixture.snapshot(90).tokens.daily.map(day=>day.totalTokens))!==Math.max(...usageFixture.snapshot(30).tokens.daily.map(day=>day.totalTokens))");
  await act("usageFixture.mode='fail';"); await click('[data-usage-refresh]'); await waitFor("document.querySelector('.relay-usage-page').dataset.usageState==='error'");
  await check('failedRefreshKeepsUsefulMetricsAndOffersRetry', "document.querySelector('[data-usage-refresh]').textContent.includes('重试')&&document.querySelector('[data-usage-metric=tokens]').textContent==='75,000'&&document.querySelector('[data-usage-status]').textContent.includes('保留已有统计')");
  await act("usageFixture.mode='ready';usageFixture.overrides[7]=usageFixture.snapshot(7,{tokens:{available:false,coverage:'unavailable',byModel:[]}});"); await click('button[data-usage-days="7"]');
  await waitFor("document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='7'");
  await check('missingTokenRecordsAreUnknownWhileHistoryMetricsRemainUsable', "document.querySelector('[data-usage-metric=tokens]').textContent==='—'&&document.querySelector('[data-usage-metric=peak]').textContent==='—'&&document.querySelector('[data-usage-models]').textContent.includes('尚未记录')&&document.querySelectorAll('.rup-heatmap-cell[data-usage-date]').length===7&&document.querySelector('[data-usage-metric=messages]').textContent!=='—'");
  await check('unavailableTokensStayUnknownAcrossCardsAndTheSelectedTokenTrend', "[...document.querySelectorAll('[data-usage-part]')].every(node=>node.textContent==='—')&&document.querySelector('[data-usage-composition]').dataset.state==='unknown'&&document.querySelector('[data-usage-trend-chart]').dataset.state==='unknown'&&document.querySelectorAll('[data-usage-trend-point]').length===0");
  await check('missingTokenHeatmapDaysRemainUnknownInsteadOfUsingConversationCounts', "document.querySelector('.rup-trend h3').textContent==='每日 Token'&&document.querySelector('[data-usage-chart]').dataset.usageChartState==='unknown'&&[...document.querySelectorAll('[data-usage-chart] [data-usage-date]')].every(cell=>cell.dataset.usageCount===''&&cell.dataset.level==='unknown'&&cell.title.endsWith('未记录'))");
  await act("usageFixture.overrides[7]=usageFixture.snapshot(7);usageFixture.overrides[7].tokens.daily[1].totalTokens=null;usageFixture.emit();");
  await waitFor("document.querySelector('[data-usage-metric=tokens]').textContent==='75,000'");
  await check('knownZeroAndMissingTokenDatesUseDifferentHeatmapCells', "(()=>{const cells=[...document.querySelectorAll('[data-usage-chart] [data-usage-date]')];return cells[0].dataset.usageCount==='0'&&cells[0].dataset.level==='0'&&cells[1].dataset.usageCount===''&&cells[1].dataset.level==='unknown'&&cells[1].title.endsWith('未记录')&&cells[2].dataset.usageCount!==''})()");
  await check('partialDailyDataShowsTheRecordedPeakAndDoesNotTreatUnknownDaysAsZero', "usageFixture.peakMatches(usageFixture.overrides[7])&&document.querySelector('[data-usage-peak-detail]').textContent.includes('已记录峰值')&&document.querySelector('[data-usage-metric=peak]').title.includes('6 天记录')");
  await click('.set-nav-item[data-cat="general"]'); await click('.set-nav-item[data-cat="profile"]');
  await check('switchingSettingsCategoriesPreservesDraftControlsAndOneSubscription', "document.querySelector('#set-theme')===usageFixture.nameNode&&usageFixture.nameNode.dataset.value==='dark'&&usageFixture.listeners.size===1&&workspaceFixture.settingsWrites.length===0&&inputEl.value==='用量页测试保留的对话草稿'");
  await act("usageFixture.pageNode=document.querySelector('.relay-usage-page');preserveSettingsView();usageFixture.emit();"); await settle();
  await act('restoreSettingsView();');
  await check('detachedSettingsViewRestoresTheSamePageWithoutBlankingOrDuplicatingListeners', "document.querySelector('.relay-usage-page')===usageFixture.pageNode&&document.querySelector('[data-usage-metric=messages]').textContent!=='—'&&usageFixture.listeners.size===1");
  await act("usageFixture.mode='hold';usagePageView.refresh();usageFixture.oldRequest=usageFixture.pending.at(-1);");
  await evaluate("loadSettingsForm('usage')"); await waitFor("!!document.querySelector('.relay-usage-page')");
  await check('rebuiltSettingsReusesMemoryBeforeItsNewRequestResolves', "document.querySelector('[data-usage-metric=messages]').textContent!=='—'&&usageFixture.listeners.size===1&&document.querySelector('.relay-usage-page')!==usageFixture.pageNode");
  await act("usageFixture.oldRequest.resolve(usageFixture.snapshot(7,{totals:{messages:99999}}));usageFixture.mode='ready';usageFixture.emit();"); await settle();
  await check('destroyedPageCannotPublishLateDataIntoItsReplacement', "document.querySelector('[data-usage-metric=messages]').textContent===usageFixture.snapshot(7).totals.messages.toLocaleString('zh-CN')&&usageFixture.listeners.size===1");
  await act("document.documentElement.dataset.theme='dark';"); win.setSize(780, 720); await waitFor('innerWidth<=780'); await settle();
  await check('narrowDarkPageFitsItsContainerWithoutHorizontalScrolling', "(()=>{const p=document.querySelector('.relay-usage-page'),r=p.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&p.scrollWidth<=p.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.rup-metric')].every(node=>node.scrollWidth<=node.clientWidth+1)})()");
  await check('compactColoredCardsAndTrendFitDarkNarrowSettings', "(()=>{const parts=[...document.querySelectorAll('.rup-token-part')],plot=document.querySelector('[data-usage-trend-chart]'),tones=[...document.querySelectorAll('.rup-token-part .rup-dot')].map(node=>getComputedStyle(node).backgroundColor);return parts.length===4&&parts.every(node=>node.scrollWidth<=node.clientWidth+1)&&plot.scrollWidth<=plot.clientWidth+4&&new Set(tones).size===4})()");
  await check('lowerCardsKeepTheSameHeightAndModelScrollInsideNarrowSettings', "(()=>{const cards=[...document.querySelectorAll('.rup-profile-panels > .rup-section')],list=document.querySelector('[data-usage-models]');return cards.every(card=>Math.abs(card.getBoundingClientRect().height-300)<1&&card.scrollWidth<=card.clientWidth+1)&&list.scrollHeight>list.clientHeight&&list.scrollWidth<=list.clientWidth+1&&!document.querySelector('.rup-footnote')})()");
  await screenshot('usage-dark-narrow');
  await act("document.querySelector('button[data-usage-days="+'"7"'+"]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));");
  await waitFor("document.querySelector('.relay-usage-page').dataset.usageDays==='30'");
  await check('rangeSelectionWorksFromTheKeyboardWithoutMovingFocusElsewhere', "document.activeElement.dataset.usageDays==='30'&&document.querySelector('button[data-usage-days="+'"30"'+"]').getAttribute('aria-pressed')==='true'");
  await act("usageFixture.overrides[30]=usageFixture.scaleSnapshot(30,24);usageFixture.emit();");
  await waitFor("document.querySelector('[data-usage-metric=tokens]').textContent==='1,800,000'");
  await check('millionTokenTotalsRemainCompleteWhileTheFourSmallCardsStayCompact', "document.querySelector('[data-usage-metric=tokens]').textContent==='1,800,000'&&document.querySelector('[data-usage-metric=messages]').textContent===usageFixture.overrides[30].totals.messages.toLocaleString('zh-CN')&&usageFixture.peakMatches(usageFixture.overrides[30])&&['1.3M','456K','11.4%','154K'].every((value,index)=>document.querySelectorAll('[data-usage-part]')[index].textContent===value)");
  await act("usageFixture.overrides[30]=usageFixture.scaleSnapshot(30,100000000);usageFixture.emit();");
  await waitFor("document.querySelector('[data-usage-metric=tokens]').textContent==='7,500,000,000,000'");
  await check('longCompleteMetricValuesFitTheNarrowTwoByTwoGridWithoutTruncation', "(()=>{const metrics=[...document.querySelectorAll('[data-usage-metric]')],page=document.querySelector('.relay-usage-page'),cards=[...document.querySelectorAll('.rup-metric')],rows=cards.map(card=>Math.round(card.getBoundingClientRect().top));return metrics.length===4&&usageFixture.peakMatches(usageFixture.overrides[30])&&metrics.every(node=>!/[KMB]/.test(node.textContent)&&node.scrollWidth<=node.clientWidth+1&&getComputedStyle(node).textOverflow!=='ellipsis')&&new Set(rows).size===2&&rows[0]===rows[1]&&rows[2]===rows[3]&&page.scrollWidth<=page.clientWidth+1})()");
  await screenshot('usage-complete-values-narrow');
  await check('rendererRemainsSandboxedAndHasNoRuntimeErrors', "uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'");
  // Keep the hostile-input assertions above; the shareable overview uses normal mock names.
  win.setSize(1200, 860); await waitFor('innerWidth>1100');
  await act("const preview=usageFixture.scaleSnapshot(30,24);preview.tokens.byModel[4].key='provider/gemini-2.5-pro';usageFixture.overrides[30]=preview;usageFixture.mode='ready';document.documentElement.dataset.theme='light';");
  await evaluate('usagePageView.refresh()');
  await waitFor("document.querySelector('.relay-usage-page').dataset.usageDisplayedDays==='30'&&!document.querySelector('[data-usage-models]').textContent.includes('onerror')");
  await act("document.activeElement?.blur();document.getElementById('setContent').scrollTop=0;modalBody.scrollTop=0;");
  await settle();
  await act("document.getAnimations().forEach(animation=>{if(animation.effect?.getComputedTiming().iterations!==Infinity)try{animation.finish()}catch(_){}});");
  // Sidebars reduce the available content width; exercise the actual >800px container breakpoint.
  win.setSize(1440, 900); await waitFor("document.querySelector('.relay-usage-page').clientWidth>800"); await settle();
  diagnostics.wideOverview = await evaluate("(()=>{const page=document.querySelector('.relay-usage-page'),cards=[...document.querySelectorAll('.rup-metric')];return {viewportWidth:innerWidth,containerWidth:page.clientWidth,gridColumns:getComputedStyle(document.querySelector('.rup-metrics')).gridTemplateColumns,rows:cards.map(card=>Math.round(card.getBoundingClientRect().top)),cardWidths:cards.map(card=>({width:card.clientWidth,scrollWidth:card.scrollWidth})),values:[...document.querySelectorAll('[data-usage-metric]')].map(node=>node.textContent)}})()");
  await check('wideOverviewPlacesFourCompleteMetricsInOneRow', "(()=>{const cards=[...document.querySelectorAll('.rup-metric')];return new Set(cards.map(card=>Math.round(card.getBoundingClientRect().top))).size===1&&cards.every(card=>card.scrollWidth<=card.clientWidth+1)&&document.querySelector('[data-usage-metric=tokens]').textContent==='1,800,000'})()");
  await screenshot('usage-overview-wide');
  win.setSize(1200, 860); await waitFor('innerWidth<1300'); await settle();
  await screenshot('usage-overview');
  await act("document.querySelector('[data-usage-models]').scrollTop=0;document.querySelector('.rup-profile-panels').scrollIntoView({block:'start'});"); await screenshot('usage-cards-tokens');
  await click('[data-usage-trend-mode=messages]'); await act("document.querySelector('.rup-profile-panels').scrollIntoView({block:'start'});"); await screenshot('usage-cards-conversations');
  await click('[data-usage-trend-mode=tokens]');
  await act("document.querySelector('.rup-overview').scrollIntoView({block:'start'});"); await screenshot('usage-statistics-light');
  await act("document.documentElement.dataset.theme='dark';document.getAnimations().forEach(animation=>{if(animation.effect?.getComputedTiming().iterations!==Infinity)try{animation.finish()}catch(_){}});");
  await screenshot('usage-statistics-dark');
  win.setSize(780,800); await waitFor('innerWidth<=780');
  await act("document.querySelector('.rup-overview').scrollIntoView({block:'start'});"); await screenshot('usage-statistics-dark-narrow');
  await act("document.documentElement.dataset.theme='light';document.getAnimations().forEach(animation=>{if(animation.effect?.getComputedTiming().iterations!==Infinity)try{animation.finish()}catch(_){}});");
  await screenshot('usage-statistics-light-narrow');
  // Reproduce only the anonymous numeric values from the reported screenshot.
  win.setSize(1200, 860); await waitFor('innerWidth>1100');
  await act("usageFixture.overrides[30]=usageFixture.snapshot(30,{tokens:{available:true,inputTokens:14004572,outputTokens:3376993,cacheReadTokens:361773440,cacheCreationTokens:0,totalTokens:379155005,coverage:'partial',byModel:[{key:'fixture/model',count:379155005}]}});usageFixture.mode='ready';usageFixture.emit();document.documentElement.dataset.theme='light';");
  await waitFor("document.querySelector('[data-usage-metric=tokens]').textContent==='379,155,005'");
  await act("document.getElementById('setContent').scrollTop=0;modalBody.scrollTop=0;document.activeElement?.blur();");
  await check('reportedTotalsDisplayInclusiveInputWithoutCountingCacheTwice',
    "(()=>{const input=document.querySelector('[data-usage-part=inputTotalTokens]'),output=document.querySelector('[data-usage-part=outputTokens]'),read=document.querySelector('[data-usage-part=cacheReadTokens]'),segments=[...document.querySelectorAll('[data-usage-composition] .rup-component')];return input.textContent==='376M'&&input.title.startsWith('375,778,012 Token')&&input.closest('article').textContent.includes('输入（含缓存）')&&input.title.includes('14,004,572')&&output.textContent==='3.4M'&&output.title.startsWith('3,376,993 Token')&&output.title.includes('多次模型调用累计')&&output.title.includes('不等于最终回答字数')&&read.textContent==='362M'&&read.title.includes('已包含在输入和总量中')&&document.querySelector('[data-usage-part=cacheHitRate]').textContent==='96.3%'&&Math.abs(segments.reduce((n,node)=>n+parseFloat(node.style.width),0)-100)<.01&&document.querySelector('[data-usage-token-detail]').textContent.includes('未缓存输入')})()");
  await check('reportedTotalsCardsAndLabelsFitWideSettings',
    "[...document.querySelectorAll('.rup-token-part,.rup-token-part h4,.rup-token-part strong')].every(node=>node.scrollWidth<=node.clientWidth+1)");
  await screenshot('usage-reported-values-wide');
  diagnostics.reportedValueTooltips = await evaluate("Object.fromEntries([...document.querySelectorAll('[data-usage-part]')].map(node=>[node.dataset.usagePart,node.title]))");
  // A fixture-only note makes the native title text visible in capturePage.
  await act("const note=document.createElement('div');note.id='usage-tooltip-preview';note.textContent=document.querySelector('[data-usage-part=inputTotalTokens]').title;Object.assign(note.style,{position:'fixed',left:'360px',top:'475px',width:'460px',padding:'14px 18px',whiteSpace:'pre-wrap',font:'12px/1.7 Segoe UI',color:'var(--text)',background:'var(--bg-panel)',border:'1px solid var(--border)',borderRadius:'8px',boxShadow:'0 5px 20px #0002',zIndex:99999});document.body.append(note);");
  await screenshot('usage-reported-values-input-tooltip');
  await act("document.getElementById('usage-tooltip-preview').remove();");
  win.setSize(780, 800); await waitFor('innerWidth<=780'); await settle();
  await check('reportedTotalsCardsAndLabelsFitNarrowSettings',
    "(()=>{const page=document.querySelector('.relay-usage-page');return page.scrollWidth<=page.clientWidth+1&&[...document.querySelectorAll('.rup-token-part,.rup-token-part h4,.rup-token-part strong')].every(node=>node.scrollWidth<=node.clientWidth+1)})()");
  await screenshot('usage-reported-values-narrow');
  step = 'completed'; save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => { failures.push(String(error.stack || error)); save(); console.error(error.stack); try { if (win && !win.isDestroyed()) { await screenshot('failure'); console.error(await evaluate('JSON.stringify(uiFixture.errors)')); } } catch (_) {} clearTimeout(deadline); app.exit(1); });
