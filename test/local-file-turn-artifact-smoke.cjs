'use strict';
// Native DOM + production link decorator; no model, main app or user workspace.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp/local-file-turn-artifact-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const report = { checks: [], errors: [], externalRequests: 0 }; let win;
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
const deadline = setTimeout(() => { report.errors.push('timeout'); save(); app.exit(1); }, 45000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate('(() => {' + code + '\n})()');
const settle = () => evaluate('new Promise(resolve => setTimeout(resolve, 40))');
async function check(name, code) { const ok = !!await evaluate(code); report.checks.push({ name, ok }); console.log(name + ': ' + ok); if (!ok) throw Error(name); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const external = /^https?:/i.test(details.url); if (external) report.externalRequests++;
    done({ cancel: external });
  });
  win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><div id="messages"></div><div id="outside"><a href="D:/Fixture/report.md">Outside</a></div>'));
  await evaluate(fs.readFileSync(path.join(root, 'renderer/local-file-links.js'), 'utf8'));
  await act(`
    window.audit = { errors: [], calls: [], previews: [], navigation: [], resolved: [], opens: [], copied: null, mode: 'unknown' };
    window.addEventListener('error', e => audit.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => audit.errors.push(String(e.reason)));
    window.messages = document.getElementById('messages');
    messages.innerHTML = '<div id="body" class="message assistant" data-conversation-id="conv-a" data-run-id="run-a" data-turn-ts="time-a"><p><a id="main" href="D:/Fixture/report.md"><strong>原始报告</strong></a></p><p>请看 <a id="inline" href="D:/Fixture/report.md">报告引用</a>。</p><p><a id="line" href="D:/Fixture/report.md:7">第七行</a></p><p><a id="source" href="D:/Fixture/app.js:12">源码</a></p><p><a id="different" href="D:/Other/report.md">同名其他文件</a></p></div>'
      + '<div id="other" class="message assistant" data-conversation-id="conv-b" data-run-id="run-a" data-turn-ts="time-a"><p><a href="D:/Fixture/report.md">其他对话</a></p></div>'
      + '<div id="older" class="message assistant" data-conversation-id="conv-a" data-run-id="run-old" data-turn-ts="time-a"><p><a href="D:/Fixture/report.md">其他轮次</a></p></div>'
      + '<div id="timestamp" class="message assistant" data-conversation-id="conv-a" data-run-id="run-a" data-turn-ts="time-old"><p><a href="D:/Fixture/report.md">其他发送时间</a></p></div>'
      + '<section class="message assistant turn-deliverables" data-conversation-id="conv-a" data-run-id="run-a" data-turn-ts="time-a"><p><a id="destination" href="D:/Fixture/report.md">报告成果</a></p></section>';
    window.byId = id => document.getElementById(id);
    window.relayWorkspaceFileTypes = { describe: () => ({ label: '文件' }), createIcon: () => { const n = document.createElement('span'); n.className = 'relay-local-file-icon'; return n; } };
    window.api = RelayLocalFileLinks.install(messages, {
      context: () => ({ conversationId: 'conv-a', workingDir: 'D:/Fixture' }),
      resolveTurnArtifact: (link, parsed) => {
        const owner = link.closest('.message'); audit.calls.push(link.id || owner?.id || 'destination');
        if (audit.mode === 'unknown' || parsed.path !== 'D:/Fixture/report.md' || !owner
          || owner.dataset.conversationId !== 'conv-a' || owner.dataset.runId !== 'run-a' || owner.dataset.turnTs !== 'time-a') return null;
        if (audit.mode === 'throw') throw Error('resolver fixture failure');
        if (audit.mode === 'malformed') return { conversationId: 'conv-a' };
        return { conversationId: 'conv-a', runId: 'run-a', turnTs: 'time-a', itemId: audit.itemId || 'item-a', pending: audit.mode === 'pending', label: audit.label };
      },
      navigateTurnArtifact: (reference, link) => { audit.navigation.push({ reference, id: link.id }); if (audit.rejectNavigation) return { ok: false, error: '合成导航失败' }; byId('destination').focus(); return true; },
      preview: async input => { audit.previews.push(input); return { ok: true }; },
      bridge: { resolveLink: async input => { audit.resolved.push(input); return { ok: true, absolutePath: 'D:/Fixture/report.md' }; }, openLink: async input => { audit.opens.push(input); return { ok: true }; } },
      clipboard: { writeText: async text => { audit.copied = text; } }, onError: message => audit.errors.push(message)
    });
  `);
  await settle();
  await check('legacy standalone link remains a card without an artifact match', "byId('main').classList.contains('relay-file-card')&&byId('main').textContent.includes('report.md')");
  await act("audit.calls=[];audit.mode='pending';api.decorate(byId('body'));"); await settle();
  await check('pending registered artifact retains original text and preview without a premature card', "!byId('main').classList.contains('relay-file-card')&&!byId('main').classList.contains('relay-turn-artifact-reference')&&byId('main').textContent==='原始报告'&&byId('main').querySelector('strong')");
  await check('scoped refresh never visits another turn or conversation', "audit.calls.every(id=>['main','inline','different'].includes(id))");
  await act("byId('main').click();"); await settle();
  await check('pending reference opens the original file instead of navigating to an unavailable result', "audit.previews.length===1&&audit.previews[0].href==='D:/Fixture/report.md'&&audit.navigation.length===0");
  await act("audit.mode='ready';api.decorate(byId('body'));"); await settle();
  await check('ready artifact becomes one lightweight reference with no duplicate filename or icon', "byId('main').textContent==='查看本轮成果'&&byId('main').classList.contains('relay-turn-artifact-reference')&&!byId('main').classList.contains('relay-file-card')&&!byId('main').querySelector('.relay-local-file-icon')&&byId('inline').textContent==='查看本轮成果'");
  await check('artifact section keeps its full file card', "byId('destination').classList.contains('relay-file-card')&&!byId('destination').classList.contains('relay-turn-artifact-reference')");
  await check('source and line references remain ordinary file links', "!byId('line').classList.contains('relay-turn-artifact-reference')&&!byId('source').classList.contains('relay-turn-artifact-reference')&&byId('line').textContent==='第七行'&&byId('source').textContent==='源码'");
  await act("api.decorate();"); await settle();
  await check('same filename other path and mismatched conversation run or time are not downgraded', "['different','other','older','timestamp'].every(id=>{const n=byId(id);const a=n.matches('a')?n:n.querySelector('a');return a.classList.contains('relay-file-card')&&!a.classList.contains('relay-turn-artifact-reference')})");
  await act("byId('main').click();"); await settle();
  await check('ready reference navigates exactly once and never also previews', "audit.navigation.length===1&&audit.previews.length===1&&audit.navigation[0].reference.conversationId==='conv-a'&&audit.navigation[0].reference.runId==='run-a'&&audit.navigation[0].reference.turnTs==='time-a'&&audit.navigation[0].reference.itemId==='item-a'&&document.activeElement===byId('destination')");
  await act("byId('main').dispatchEvent(new MouseEvent('auxclick',{bubbles:true,button:1}));"); await settle();
  await check('middle click follows the same artifact navigation without opening the file', 'audit.navigation.length===2&&audit.previews.length===1');
  await act("byId('main').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:20,clientY:20}));document.querySelectorAll('.relay-local-file-menu button')[2].click();"); await settle();
  await check('copy path retains the original href behind the lightweight reference', "audit.copied==='D:/Fixture/report.md'&&audit.resolved[0].href==='D:/Fixture/report.md'");
  await act("byId('main').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}));document.querySelector('.relay-local-file-menu button').click();"); await settle();
  await check('open locally retains the existing original file action', "audit.opens.length===1&&audit.opens[0].href==='D:/Fixture/report.md'&&audit.opens[0].target==='system'");
  await act("audit.itemId='item-new';audit.label='查看已确认成果';api.decorate(byId('main'));"); await settle();
  await check('identity and label changes invalidate the presentation cache', "byId('main').textContent==='查看已确认成果'");
  await act("byId('main').click();"); await settle();
  await check('navigation uses the refreshed complete identity', "audit.navigation.at(-1).reference.itemId==='item-new'&&audit.navigation.at(-1).reference.label==='查看已确认成果'");
  await act("audit.mode='unknown';byId('main').click();"); await settle();
  await check('click rechecks expired ownership and restores original file behavior without stale navigation', "audit.navigation.length===3&&audit.previews.length===2&&byId('main').classList.contains('relay-file-card')&&!byId('main').classList.contains('relay-turn-artifact-reference')");
  await act("audit.mode='ready';delete audit.label;api.decorate(byId('main'));audit.mode='pending';byId('main').click();"); await settle();
  await check('click rechecks pending state before navigating', "audit.navigation.length===3&&audit.previews.length===3&&byId('main').textContent==='原始报告'&&!byId('main').classList.contains('relay-file-card')");
  await act("audit.mode='malformed';api.decorate(byId('body'));"); await settle();
  await check('malformed ownership never creates an artifact navigation', "!byId('body').querySelector('.relay-turn-artifact-reference')&&byId('main').classList.contains('relay-file-card')");
  await act("audit.mode='throw';api.decorate(byId('body'));audit.calls=[];api.decorate(byId('outside'));"); await settle();
  await check('resolver failures fall back and scopes outside the owner container are ignored', "audit.errors.length===0&&audit.calls.length===0&&!byId('outside').querySelector('.relay-local-file-link')");
  await act("audit.mode='ready';audit.rejectNavigation=true;byId('main').click();"); await settle();
  await check('unavailable destination is reported without a second file open', "audit.errors.length===1&&audit.errors[0]==='合成导航失败'&&audit.previews.length===3");
  await act("api.destroy();");
  await check('fixture runs in the native isolated renderer', "typeof require==='undefined'&&typeof process==='undefined'");
  report.ok = report.checks.every(item => item.ok) && report.externalRequests === 0;
}).catch(error => { report.ok = false; report.errors.push(error.stack || String(error)); }).finally(() => {
  clearTimeout(deadline); save(); win?.destroy(); app.exit(report.ok ? 0 : 1);
});
