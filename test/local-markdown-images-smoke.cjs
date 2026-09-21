'use strict';
// Production main/mini renderers, isolated synthetic history and bitmap bridge.
// No user data, model, executable deliverable, or application main is loaded.
const { app, BrowserWindow, session, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/local-markdown-images-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {}); // Main and mini fixtures run sequentially.
let win;
const checks = {}, failures = [], network = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, network }, null, 2));
const deadline = setTimeout(() => { failures.push('Timeout'); save(); app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const wait = code => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)}tick()})`);
const delay = () => evaluate('new Promise(resolve=>setTimeout(resolve,80))');
async function screenshot(name) {
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await win.webContents.capturePage(); await delay();
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function check(name, code) { checks[name] = !!await evaluate(code); save(); console.log(name + ': ' + checks[name]); if (!checks[name]) throw Error(name); }

function seed(png) {
  const base = window.api;
  const f = window.imageFixture = { reads: [], releases: [], blocked: false, errors: [], opens: [], callbacks: [],
    context: { conversationId: 'image-a', workingDir: 'C:\\Fixture' }, png,
    snapshot: { running: false, pinned: true, model: 'haiku', conversation: null },
    emit(conversation) { this.snapshot.conversation = conversation; for (const fn of this.callbacks) fn(JSON.parse(JSON.stringify(this.snapshot))); },
  };
  window.addEventListener('error', event => f.errors.push(event.message));
  window.addEventListener('unhandledrejection', event => f.errors.push(String(event.reason)));
  async function read(input) {
    f.reads.push(JSON.parse(JSON.stringify(input)));
    if (input.href.includes('hold')) await new Promise(resolve => f.releases.push(resolve));
    if (input.href.includes('missing')) return { ok: false, code: 'ENOENT' };
    if (input.href.includes('oversized')) return { ok: true, truncated: true, binary: true };
    if (input.href.includes('evil')) return { ok: true, dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' };
    if (input.href.includes('calculator')) return { ok: true, path: 'calculator.html', absolutePath: 'C:\\Fixture\\calculator.html', content: '<!doctype html><title>Fixture</title>', language: 'html' };
    return { ok: true, dataUrl: png, mimeType: 'image/png' };
  }
  const workspace = { resolve: async () => ({ ok: true, root: 'C:\\Fixture' }), list: async () => ({ ok: true, entries: [] }), readLink: read, onTerminalEvent: () => () => {} };
  const mini = { state: async () => f.snapshot, brand: async () => ({ name: 'Relay' }), onState: fn => { f.callbacks.push(fn); return () => {}; }, onFocus: () => () => {},
    readLocalImage: read, resize: async () => ({}), setPinned: async () => ({}), hide: async () => ({}), openMain: async () => ({}) };
  window.api = new Proxy(base, { get(target, key) {
    if (key === 'workspace') return workspace;
    if (key === 'mini') return mini;
    if (key === 'providers') return { list: async () => ({ ok: true, routes: uiFixture.routes }), onChanged: () => () => {} };
    return target[key];
  } });
}
async function launch(name, png) {
  const bootstrap = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const page = path.join(output, name + '.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer', name === 'main' ? 'index.html' : 'mini.html'), 'utf8').replace('<head>',
    '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + bootstrap + '(' + seed + ')(' + JSON.stringify(png) + ');</script>'));
  win = new BrowserWindow({ width: name === 'main' ? 1200 : 540, height: 850, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(page);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const blocked = /^(?:https?:|c:|d:)/i.test(details.url);
    if (blocked) network.push(details.url); done({ cancel: blocked });
  });
  const pixels = Buffer.alloc(280 * 140 * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 210; pixels[i + 1] = 120; pixels[i + 2] = 40; pixels[i + 3] = 255; }
  const png = nativeImage.createFromBitmap(pixels, { width: 280, height: 140 }).toDataURL();
  await launch('main', png);
  await wait('!!window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await act(`window.relayConversationWorkspace=()=>({...imageFixture.context});window.dispatchEvent(new CustomEvent('relay:conversation-changed'));messagesEl.replaceChildren();
    window.imageMarkdown=${JSON.stringify('**[calculator.html](C:\\Fixture\\calculator.html)**\n\n![计算器预览](C:\\Fixture\\preview.png)')};
    appendMessage('assistant',imageMarkdown);`);
  await wait("messagesEl.querySelector('.relay-local-image img')?.naturalWidth===280");
  await check('MainEncodedWindowsMarkdownLinkIsIntercepted', "messagesEl.querySelector('a[data-relay-file-link]')?.getAttribute('href')==='#'&&RelayLocalFileLinks.parse(messagesEl.querySelector('a').title).path.endsWith('calculator.html')");
  await act("messagesEl.querySelector('a[data-relay-file-link]').click()");
  await wait("imageFixture.reads.some(item=>item.href.includes('calculator'))");
  await check('LinkAndImageUseCapturedConversation', "imageFixture.reads.length===2&&imageFixture.reads.every(item=>item.context.conversationId==='image-a')");
  await check('MainImageHasOnlyValidatedDataSource', "messagesEl.querySelector('.relay-local-image img').src.startsWith('data:image/png;base64,')&&!messagesEl.querySelector('img[src^=\"C:\"]')");
  await act(`window.streamingBody=document.createElement('div');messagesEl.append(streamingBody);for(let i=0;i<15;i++)streamMarkdownRenderer.render(streamingBody,imageMarkdown+'\\n\\n输出 '+i);`);
  await wait("streamingBody.querySelector('.relay-local-image img')?.naturalWidth===280");
  await check('StreamingRedrawReusesImageRead', "imageFixture.reads.filter(item=>item.href.includes('preview')).length===1");
  await act("messagesEl.replaceChildren();appendMessage('assistant',imageMarkdown)");
  await wait("messagesEl.querySelector('.relay-local-image img')?.naturalWidth===280");
  await check('HistoryRedrawReusesScopedImageCache', "imageFixture.reads.filter(item=>item.href.includes('preview')).length===1");
  await act("appendMessage('assistant','![缺失](missing.png) ![过大](oversized.png) ![假图片](evil.png)')");
  await wait("messagesEl.querySelectorAll('.is-unavailable').length===3");
  await check('MissingOversizedAndNonBitmapHaveGracefulText', "[...messagesEl.querySelectorAll('.is-unavailable')].every(node=>node.textContent.includes('无法预览图片')&&!node.querySelector('img'))");
  await act(`const host=document.createElement('div');relayRenderReadOnlyMarkdown(host,'![不自动读取](private.png) ![远程](https://example.invalid/img.png)');imageFixture.readonlySafe=!host.querySelector('img,[data-relay-local-image]');`);
  await check('OrdinaryReadonlySurfacesStillDoNotLoadImages', 'imageFixture.readonlySafe');
  await act("appendMessage('assistant','![A 等待](hold-a.png)')");
  await wait('imageFixture.releases.length===1');
  await act("imageFixture.oldImage=messagesEl.querySelector('[data-relay-local-image=\"hold-a.png\"]');imageFixture.context={conversationId:'image-b',workingDir:'C:\\\\Other'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));messagesEl.replaceChildren();appendMessage('assistant',imageMarkdown);imageFixture.releases.shift()()");
  await wait("messagesEl.querySelector('.relay-local-image img')?.naturalWidth===280");
  await check('SlowOldConversationCannotMountIntoNewConversation', "!imageFixture.oldImage.querySelector('img')&&imageFixture.reads.filter(item=>item.href.includes('preview')).length===2&&imageFixture.reads.at(-1).context.conversationId==='image-b'");
  await act("window.dispatchEvent(new CustomEvent('relay:conversation-changed'));appendMessage('assistant','![同会话](preview2.png)')");
  await wait("messagesEl.querySelectorAll('.relay-local-image img').length===2");
  await check('SameConversationNotificationsDoNotStrandImages', "messagesEl.querySelectorAll('[aria-busy]').length===0");
  await act("messagesEl.replaceChildren();appendMessage('assistant','![1](hold-1.png) ![2](hold-2.png) ![3](hold-3.png) ![4](hold-4.png)')");
  await wait('imageFixture.releases.length===2');
  await check('ImageReadsHaveTwoRequestConcurrencyLimit', "imageFixture.reads.filter(item=>/hold-[1234]/.test(item.href)).length===2");
  await act("imageFixture.context={conversationId:'image-c',workingDir:'C:\\\\Third'};window.dispatchEvent(new CustomEvent('relay:conversation-changed'));messagesEl.replaceChildren();imageFixture.releases.splice(0).forEach(fn=>fn());appendMessage('assistant',imageMarkdown)");
  await wait("messagesEl.querySelector('.relay-local-image img')?.naturalWidth===280");
  await check('QueuedOldImagesAreCanceledBeforePrivilegedRead', "!imageFixture.reads.some(item=>/hold-[34]/.test(item.href))");
  await check('MainImageIsVisibleInMessageLayout', "messagesEl.querySelector('.relay-local-image img').getBoundingClientRect().height>0&&getComputedStyle(messagesEl).display!=='none'");
  await screenshot('main');
  await check('MainHasNoRendererErrorsOrHistoryWrites', "imageFixture.errors.length===0&&uiFixture.errors.length===0&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')");
  win.destroy();

  await launch('mini', png);
  await wait('imageFixture.callbacks.length>0');
  await act(`imageFixture.emit({id:'mini-image-a',turns:[{id:'t1',user:'查看图片',assistant:${JSON.stringify('![小窗预览](C:\\Fixture\\preview.png)')},status:'complete'}]})`);
  await wait("document.querySelector('#miniTurns .relay-local-image img')?.naturalWidth===280");
  await check('MiniUsesRestrictedImageBridgeWithCurrentConversation', "imageFixture.reads.length===1&&imageFixture.reads[0].context.conversationId==='mini-image-a'");
  await act("imageFixture.snapshot.conversation.turns[0].assistant+='\\n\\n后续说明';imageFixture.emit(imageFixture.snapshot.conversation)");
  await wait("document.querySelector('#miniTurns .relay-local-image img')?.naturalWidth===280");
  await check('MiniRedrawKeepsBitmapAndAvoidsRepeatRead', 'imageFixture.reads.length===1');
  await act("imageFixture.snapshot.conversation.turns[0].assistant+='\\n\\n![不存在](missing.png)';imageFixture.emit(imageFixture.snapshot.conversation)");
  await wait("document.querySelector('#miniTurns .is-unavailable')");
  await check('MiniMissingImageHasNoBrokenImageElement', "document.querySelector('#miniTurns .is-unavailable').textContent.includes('无法预览图片')&&!document.querySelector('#miniTurns .is-unavailable img')");
  await screenshot('mini');
  await act("imageFixture.emit({id:'mini-image-a',turns:[{id:'t2',user:'等待',assistant:'![旧图片](hold-mini.png)',status:'complete'}]})");
  await wait('imageFixture.releases.length===1');
  await act("imageFixture.oldImage=document.querySelector('#miniTurns [data-relay-local-image]');imageFixture.emit({id:'mini-image-b',turns:[{id:'t3',user:'新对话',assistant:'只有文字',status:'complete'}]})");
  await wait("document.querySelector('#miniTurns').textContent.includes('只有文字')");
  await act('imageFixture.releases.shift()()'); await delay();
  await check('MiniLateImageCannotCrossConversation', "!document.querySelector('#miniTurns img')&&!imageFixture.oldImage.querySelector('img')");
  await check('MiniHasNoRendererErrorsOrModelRuns', "imageFixture.errors.length===0&&uiFixture.errors.length===0&&!uiFixture.calls.includes('runClaude')");
  if (network.length) throw Error('Unexpected image network request');
  save(); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => { failures.push(String(error.stack || error)); console.error(error); save(); clearTimeout(deadline);
  if (win && !win.isDestroyed()) try { fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG()); } catch (_) {}
  app.exit(1);
});
