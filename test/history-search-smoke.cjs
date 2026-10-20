'use strict';
// Production renderer with delayed synthetic IPC responses and populated result lists.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.codex-tmp/history-search-2026-10-14/ui');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const report = { runtime: process.versions.electron, platform: process.platform, checks: {}, measurements: {}, failures: [] };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...report, step }, null, 2));
const deadline = setTimeout(() => { report.failures.push('Timeout: ' + step); save(); app.exit(1); }, 90000);
const evaluate = source => win.webContents.executeJavaScript(source);
const act = source => evaluate('(()=>{' + source + '\n})()');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(source) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await evaluate(source)) return; await pause(20); }
  throw Error('Timed out: ' + source);
}
async function check(name, source) {
  step = name; report.checks[name] = !!await evaluate(source); save();
  if (!report.checks[name]) throw Error(name);
}
async function capture(name) {
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await win.webContents.capturePage(); await pause(150);
  fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function seed() {
  const base = window.api, clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const records = new Map();
  for (let index = 0; index < 80; index++) {
    const id = 'search-fixture-' + index, kind = index % 7 === 6 ? 'create' : 'chat';
    records.set(id, { id, title: '安全工程分析 ' + index, kind, mode: index % 3 === 1 ? 'agent' : 'plain', model: 'opus',
      updatedAt: new Date(Date.now() - index * 86400000).toISOString(),
      turns: kind === 'create'
        ? [{ prompt: '安全图示 ' + index, model: 'fixture', size: '1024x1024', resultPaths: [] }]
        : [{ user: '原始问题 ' + index, assistant: '安全分析：合成答案 ' + index, ts: '2026-10-14T00:00:00.000Z' },
          { user: '后续问题 ' + index, assistant: '第二轮安全分析 ' + index, ts: '2026-10-14T00:01:00.000Z' }] });
  }
  const state = window.searchFixture = { records, requests: [], cancels: 0, loads: [], writes: [], loadJumps: [],
    items(query, count = 50) {
      return [...records.values()].slice(0, count).map((record, index) => ({ id: record.id,
        title: index === 2 ? '<img src=x onerror=alert(1)> ' + query : query + '工程分析 ' + index,
        kind: record.kind, mode: record.mode, updatedAt: record.updatedAt,
        snippet: '已审查完整上下文：\x00' + query + '\x01 相关技术记录 <script>not executable</script> ' + index,
        turnIndex: index % 2 ? null : 1, matchSide: index % 2 ? null : record.kind === 'create' ? 'prompt' : 'assistant' }));
    },
    finish(index, result) { const request = state.requests[index]; if (!request) throw Error('Missing query ' + index); request.resolve(result); },
    reject(index) { state.requests[index].reject(Error('Synthetic delayed request failure')); },
  };
  const history = new Proxy(base.history, { get(target, key) {
    if (key === 'search') return (query, limit) => new Promise((resolve, reject) => state.requests.push({ query, limit, resolve, reject }));
    if (key === 'cancelSearch') return async () => { state.cancels++; return { ok: true }; };
    if (key === 'list') return async () => clone([...records.values()]);
    if (key === 'load') return async id => { state.loads.push(id); return clone(records.get(id) || null); };
    if (key === 'save') return async value => { state.writes.push(clone(value)); return clone(value); };
    return target[key];
  } });
  window.api = new Proxy(base, { get(target, key) { return key === 'history' ? history : target[key]; } });
}
async function type(value) {
  await act("const input=document.querySelector('.search-input');input.value=" + JSON.stringify(value) + ";input.dispatchEvent(new InputEvent('input',{bubbles:true}));");
}
async function nextRequest(value) {
  const count = await evaluate('searchFixture.requests.length'); await type(value);
  await waitFor('searchFixture.requests.length===' + (count + 1)); return count;
}
async function finish(index, query, extra) {
  await act('searchFixture.finish(' + index + ',{ok:true,items:searchFixture.items(' + JSON.stringify(query) + ')' + (extra ? ',' + extra : '') + '});');
}
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixtures = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(root, 'test', name), 'utf8')).join('\n')
    + '\n(' + seed.toString().replace(/<\/script/gi, '<\\/script') + ')();localStorage.clear();';
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>',
    '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixtures + '</script>');
  const fixture = path.join(out, 'fixture.html'); fs.writeFileSync(fixture, html);
  win = new BrowserWindow({ width: 1220, height: 900, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(fixture); await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['control'] });
  await waitFor("document.activeElement.classList.contains('search-input')");
  await check('nativeControlKOpensAndFocusesHistorySearch', "searchEl.classList.contains('show')&&document.querySelector('.search-input')===document.activeElement&&searchFixture.requests.length===0");
  await type('a'); await pause(35); await type('an'); await pause(35); await type('安全');
  await waitFor('searchFixture.requests.length===1');
  await check('rapidTypingDebouncesToLatestBoundedQuery', "searchFixture.requests[0].query==='安全'&&searchFixture.requests[0].limit===50&&searchFixture.cancels>=4");
  await type('安全新'); await finish(0, '过期响应'); await pause(30);
  await check('inputImmediatelyInvalidatesResponsesBeforeNextDebounce', "document.querySelectorAll('.search-result').length===0&&!document.querySelector('[data-results]').textContent.includes('过期响应')");
  await waitFor('searchFixture.requests.length===2');
  report.measurements.populatedResultRenderMs = await evaluate("new Promise(resolve=>{const start=performance.now();searchFixture.finish(1,{ok:true,items:searchFixture.items('安全新')});requestAnimationFrame(()=>resolve(Math.round((performance.now()-start)*10)/10));})");
  await check('populatedResultsKeepGroupsIconsAndEscapedHighlights', "document.querySelectorAll('.search-result').length===50&&document.querySelectorAll('.search-group-title').length>=4&&document.querySelectorAll('.sr-ico svg').length===50&&document.querySelectorAll('.sr-snippet mark').length===50&&!document.querySelector('[data-results] img, [data-results] script')&&document.querySelector('[data-results]').textContent.includes('<script>not executable</script>')");
  await capture('populated-search');
  await act("const input=document.querySelector('.search-input');searchFixture.beforeIme=searchFixture.requests.length;searchFixture.loadsBeforeIme=searchFixture.loads.length;input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));input.value='an';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:true}));input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));");
  await pause(230);
  await check('imeDoesNotSearchPinyinNavigateOrCloseOnCandidateKeys', "searchFixture.requests.length===searchFixture.beforeIme&&searchFixture.loads.length===searchFixture.loadsBeforeIme&&searchEl.classList.contains('show')&&document.querySelectorAll('.search-result').length===0");
  await act("const input=document.querySelector('.search-input');input.value='安全';input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'安全'}));input.dispatchEvent(new InputEvent('input',{bubbles:true}));");
  await waitFor('searchFixture.requests.length===3'); await finish(2, '安全');
  await check('imeCommitRunsExactlyOneFinalQuery', "searchFixture.requests[2].query==='安全'&&document.querySelectorAll('.search-result').length===50");
  const closePending = await nextRequest('关闭中');
  await act('hideSearchModal();showSearchModal();'); await finish(closePending, '关闭过期'); await pause(30);
  await check('closingAndReopeningDiscardsOldSuccessfulResponse', "!document.querySelector('[data-results]').textContent.includes('关闭过期')&&document.querySelectorAll('.search-result').length===0&&document.querySelector('.search-input').value===''");
  const oldSame = await nextRequest('相同词');
  await act('hideSearchModal();showSearchModal();'); const newSame = await nextRequest('相同词');
  await finish(oldSame, '上次打开'); await pause(20);
  await check('sameQueryAcrossModalSessionsStillRejectsOldResult', "document.querySelectorAll('.search-result').length===0&&!document.querySelector('[data-results]').textContent.includes('上次打开')");
  await finish(newSame, '相同词');
  const staleError = await nextRequest('旧失败'); await type('新查询'); await act('searchFixture.reject(' + staleError + ');'); await pause(25);
  await check('staleErrorCannotReplaceNewQueryWithEmptyOrError', "document.querySelector('[data-results]').getAttribute('aria-busy')==='true'&&document.querySelector('[data-results]').textContent==='正在搜索…'");
  await waitFor('searchFixture.requests.length===' + (staleError + 2));
  await act('searchFixture.finish(' + (staleError + 1) + ",{ok:false,error:'合成读取失败，请重试'});");
  await check('currentStructuredErrorIsNotReportedAsNoMatches', "document.querySelector('[data-results]').textContent==='合成读取失败，请重试'&&!document.querySelector('[data-results]').hasAttribute('aria-busy')");
  const rejected = await nextRequest('当前失败'); await act('searchFixture.reject(' + rejected + ');');
  await check('currentRejectedRequestShowsRetryMessage', "document.querySelector('[data-results]').textContent==='搜索暂时失败，请稍后重试。'");
  const canceled = await nextRequest('取消旧查询'); await type(''); await act('searchFixture.finish(' + canceled + ',{ok:true,canceled:true,items:[]});'); await pause(210);
  await check('clearingInputCancelsWithoutEmptyQueryRequest', "document.querySelector('[data-results]').textContent==='输入关键词搜索你的历史对话'&&searchFixture.requests.length===" + (canceled + 1));
  const closedCount = await evaluate('searchFixture.requests.length');
  await type('关闭前待搜索'); await act('hideSearchModal();'); await pause(230);
  await check('closingClearsDebounceAndDoesNotStealFocus', "searchFixture.requests.length===" + closedCount + "&&!searchEl.classList.contains('show')");
  await act('showSearchModal();'); const partial = await nextRequest('部分结果'); await finish(partial, '部分结果', 'partial:true');
  await check('partialResultsStayVisibleWithReadableNotice', "document.querySelectorAll('.search-result').length===50&&document.querySelector('[data-results]').textContent.includes('部分历史暂时无法读取')");
  const partialEmpty = await nextRequest('部分为空'); await act('searchFixture.finish(' + partialEmpty + ',{ok:true,items:[],partial:true});');
  await check('partialEmptyDoesNotClaimNoMatchingHistory', "document.querySelector('[data-results]').textContent==='部分历史暂时无法读取，请稍后重试。'");
  const slow = await nextRequest('慢查询');
  report.measurements.inputWhileSearchPending = await evaluate("new Promise(resolve=>{let frames=0,start=performance.now(),last=start,maxGap=0;const input=document.querySelector('.search-input');input.value='慢查询仍可继续输入';input.dispatchEvent(new InputEvent('input',{bubbles:true}));function tick(now){frames++;maxGap=Math.max(maxGap,now-last);last=now;if(now-start<300)requestAnimationFrame(tick);else resolve({frames,maxGapMs:Math.round(maxGap*10)/10,input:document.querySelector('.search-input').value})}requestAnimationFrame(tick)})");
  await check('inputAndRenderingRemainActiveDuringPendingSearch', "document.querySelector('.search-input').value==='慢查询仍可继续输入'&&document.activeElement.classList.contains('search-input')");
  await waitFor('searchFixture.requests.length===' + (slow + 2));
  await finish(slow, '旧慢查询');
  await finish(slow + 1, '安全定位');
  await act("searchFixture.expectedId=document.querySelector('.search-result').dataset.id;document.querySelector('.search-input').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter'}));");
  await waitFor("currentConv&&currentConv.id===searchFixture.expectedId&&document.querySelector('.search-hit')");
  await check('enterNavigatesToSelectedConversationAndClosesModal', "!searchEl.classList.contains('show')&&searchFixture.loads.at(-1)===searchFixture.expectedId&&document.querySelector('.message.assistant.search-hit[data-turn=\"1\"]')");
  await check('rendererRemainsSandboxedWithoutWritesOrUncaughtErrors', "typeof require==='undefined'&&typeof process==='undefined'&&uiFixture.errors.length===0&&searchFixture.writes.length===0");
  report.measurements.requestCount = await evaluate('searchFixture.requests.length');
  await capture('search-result-navigation'); step = 'completed'; save(); clearTimeout(deadline); app.exit(0);
}).catch(async error => {
  report.failures.push(String(error.stack || error)); save(); console.error(error.stack || error);
  try { if (win && !win.isDestroyed()) { await capture('failure'); console.error(await evaluate('JSON.stringify(uiFixture.errors)')); } } catch (_) {}
  clearTimeout(deadline); app.exit(1);
});
