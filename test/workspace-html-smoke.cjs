'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const { attachLocalPreviewGuard } = require('../local-preview-guard');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/workspace-html-smoke');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
const results = {}, requests = [], failures = []; let win;
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ results, requests, failures }, null, 2));
const timer = setTimeout(() => { failures.push('timeout'); save(); app.exit(1); }, 90000);
const run = code => win.webContents.executeJavaScript(code);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastFrameKey = '';
async function child() { for (let i = 0; i < 100; i++) {
  const frame = win.webContents.mainFrame.frames.find(f => f.url === 'about:srcdoc' && `${f.processId}:${f.routingId}` !== lastFrameKey);
  if (frame && await frame.executeJavaScript('document.readyState === "complete"')) { lastFrameKey = `${frame.processId}:${frame.routingId}`; return frame; }
  await wait(25);
} throw Error('Preview did not load'); }
async function check(name, condition) { results[name] = !!await condition; console.log(name + ': ' + results[name]); save(); if (!results[name]) throw Error(name); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => { if (/^https?:|^file:/i.test(details.url) && !details.url.startsWith(pathToFileURL(output).href)) requests.push(details.url); done({ cancel: /^https?:/i.test(details.url) }); });
  const page = path.join(output, 'fixture.html');
  const sources = ['local-file-links.js', 'workspace-html.js'].map(f => fs.readFileSync(path.join(root, 'renderer', f), 'utf8'));
  fs.writeFileSync(page, '<!doctype html><html><head><style>html,body{margin:0;overflow:hidden}#body{height:100vh;width:100vw}.workspace-html-frame{display:block;width:100%;height:100%;border:0}</style></head><body><div id="body"></div></body></html>');
  win = new BrowserWindow({ show: false, width: 950, height: 820, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  attachLocalPreviewGuard(win.webContents); await win.loadFile(page);
  for (const source of sources) await run(source);
  await run(`window.reads=[];window.scope={conversationId:'fixture'};window.assets={
    'app.js':'document.getElementById("go").onclick=()=>document.getElementById("value").textContent="42";window.deferReady=true;',
    'style.css':'body{background:rgb(240, 241, 242)}',
    'preview.png':'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg=='
  }; window.mount=async html=>{document.getElementById('body').replaceChildren();return RelayWorkspaceHtml.mount(document.getElementById('body'),{content:html,path:'D:/Synthetic/site/index.html'},{context:scope,readLink:async input=>{reads.push(input);const v=assets[input.href];return v?{ok:true,...(v.startsWith('data:')?{dataUrl:v}:{content:v})}:{ok:false}},onReady:text=>{window.statusText=text}})};void 0;`);
  const html = '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script src="app.js" defer></script></head><body><button id="go">Run</button><div id="value">0</div><img src="preview.png"><script>window.scopeBlocked=false;try{parent.document.body.dataset.leaked="yes"}catch(e){window.scopeBlocked=true}window.noBridge=typeof api==="undefined"&&typeof require==="undefined";</script><img src="https://example.invalid/probe"><iframe src="https://example.invalid/frame"></iframe></body></html>';
  await run('mount(' + JSON.stringify(html) + ')'); let frame = await child();
  await check('DeferredLocalScriptRunsAfterBodyParsing', frame.executeJavaScript('window.deferReady===true'));
  await check('LocalCssAndBitmapAreLoadedInScope', frame.executeJavaScript('getComputedStyle(document.body).backgroundColor==="rgb(240, 241, 242)"&&document.querySelector("img").naturalWidth===1'));
  await frame.executeJavaScript('document.getElementById("go").click()');
  await check('PreviewButtonsAreInteractive', frame.executeJavaScript('document.getElementById("value").textContent==="42"'));
  await check('PreviewCannotReadParentOrPreload', frame.executeJavaScript('window.scopeBlocked&&window.noBridge'));
  await check('AssetReadsKeepConversationAndParentDirectory', run('reads.length===3&&reads.every(x=>x.context.conversationId==="fixture"&&x.basePath==="D:/Synthetic/site/index.html")'));
  await frame.executeJavaScript('try{location.href="https://example.invalid/navigation"}catch(e){}'); await wait(150);
  await check('PreviewCannotNavigateToOtherOrigins', frame.url === 'about:srcdoc');
  await run('mount(' + JSON.stringify(String.raw`<script>window.closedTag="<\/script>";window.stillAlive=true</script><button>Local</button>`) + ')'); frame = await child();
  await check('InlineScriptsRemainInsidePreview', frame.executeJavaScript('window.stillAlive===true'));
  await check('NoNetworkRequestsFromParsingOrPreview', requests.length === 0);
  // A pending workspace read must never revive a discarded preview.
  await run(`document.getElementById('body').replaceChildren();window.pending=RelayWorkspaceHtml.mount(document.getElementById('body'),{content:'<script src="slow.js"></script>',path:'index.html'},{context:scope,readLink:()=>new Promise(r=>window.release=r)});void 0;`);
  await run("document.getElementById('body').replaceChildren();release({ok:true,content:'window.oldPreview=true'});pending");
  await check('RemovedFrameNeverResumesFromLateAssetResponse', run('!document.querySelector("iframe")'));
  if (process.argv[2] || process.env.RELAY_CALCULATOR_FIXTURE) {
    const file = process.argv[2] || process.env.RELAY_CALCULATOR_FIXTURE, calculator = fs.readFileSync(file, 'utf8');
    await run('mount(' + JSON.stringify(calculator) + ')'); frame = await child();
    results.calculator = [];
    for (const [a, op, b, expected] of [['7','*','8','56'],['78','*','78','6084'],['12','+','34','46'],['9','/','3','3'],['0.1','+','0.2','0.3']]) {
      const actual = await frame.executeJavaScript(`(()=>{const click=s=>document.querySelector(s).click();click('[data-action="clear"]');const num=s=>{for(const n of s)click(n==='.'?'[data-action="dot"]':'[data-digit="'+n+'"]')};num(${JSON.stringify(a)});click('[data-op="${op}"]');num(${JSON.stringify(b)});click('[data-action="equals"]');return document.getElementById('current').textContent.replace(/,/g,'')})()`);
      results.calculator.push({ expression: `${a}${op}${b}`, expected, actual }); if (actual !== expected) throw Error('Calculator mismatch');
    }
    await check('OriginalDeliveredCalculatorCorrectArithmetic', results.calculator.length === 5);
    win.showInactive(); await wait(400);
    await frame.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    fs.writeFileSync(path.join(output, 'calculator-preview.png'), (await win.webContents.capturePage()).toPNG());
  }
  save(); clearTimeout(timer); win.destroy(); app.exit(0);
}).catch(error => { failures.push(String(error.stack || error)); console.error(error); save(); clearTimeout(timer); app.exit(1); });
