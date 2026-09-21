'use strict';
// Production renderers, isolated profile, synthetic APIs. No Relay main process.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'read-only-surfaces-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win, step = 'starting';
const checks = {}, failures = [], requests = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, requests, step }, null, 2));
const deadline = setTimeout(() => { failures.push('timeout at ' + step); save(); app.exit(1); }, 120000);
const evaluate = code => win.webContents.executeJavaScript(code);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, code) { step=name;checks[name]=!!await evaluate(code);save();console.log(name,checks[name]);if(!checks[name])throw Error(name); }
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+5000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error('timeout '+${JSON.stringify(code)}));setTimeout(tick,25);};tick();})`); }
async function capture(name) { await delay(150);await win.webContents.capturePage();await delay(100);fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG()); }
async function fixture() {
  const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><div id="windowChrome">Relay</div><main id="outside"><button id="outsideButton">主页面操作</button><input id="outsideInput" value="保留的草稿"><div id="markdown"></div></main></body></html>';
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  for(const file of ['styles.css','read-only-markdown.css','code-blocks.css'])await win.webContents.insertCSS(fs.readFileSync(path.join(root,'renderer',file),'utf8'));
  await win.webContents.insertCSS('#windowChrome{position:fixed;inset:0 0 auto;height:36px;padding:8px 14px;background:var(--bg-panel);border-bottom:1px solid var(--border)}#outside{padding:52px 18px 18px;min-width:0}#markdown{width:min(610px,calc(100vw - 36px));max-height:600px;overflow:auto;border:1px solid var(--border);border-radius:9px;padding:14px;margin-top:20px;font-size:12px;line-height:1.75}');
  await evaluate(`window.review={external:[],errors:[]};
    window.addEventListener('error',e=>review.errors.push(e.message));window.addEventListener('unhandledrejection',e=>review.errors.push(String(e.reason)));
    window.api={openExternal:async href=>review.external.push(href)};void 0;`);
}
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>{if(/^https?:/i.test(details.url))requests.push(details.url);done({cancel:/^https?:/i.test(details.url)});});
  win=new BrowserWindow({width:1120,height:800,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await fixture();
  for(const file of ['vendor/marked.umd.js','vendor/highlight.min.js','stream-markdown.js','code-blocks.js'])await evaluate(fs.readFileSync(path.join(root,'renderer',file),'utf8')+'\nvoid 0;');
  const appSource=fs.readFileSync(path.join(root,'renderer/app.js'),'utf8');
  await evaluate(appSource.slice(0,appSource.indexOf('const messagesEl ='))+'\nvoid 0;');
  await evaluate(fs.readFileSync(path.join(root,'renderer/read-only-markdown.js'),'utf8'));
  const markdown='# 运行结果\n\n**已完成**资料整理，保留 `原始内容`。\n\n- 整理文档\n- 更新索引\n\n| 内容 | 状态 |\n| --- | --- |\n| 文档 | 已完成 |\n\n```js\nconst example = "'+('synthetic-'.repeat(60))+'";\n```\n\n[文档](https://example.invalid/docs) [邮件](mailto:example@example.invalid) [危险](javascript:alert%281%29)\n\n![远程图片](https://example.invalid/private-pixel)\n\n<img src="https://example.invalid/raw-image" onerror="window.markdownExecuted=true">';
  await evaluate(`window.markdownSource=${JSON.stringify(markdown)};relayRenderReadOnlyMarkdown(document.getElementById('markdown'),markdownSource);`);
  await check('MarkdownHeadingsListsTablesAndCodeRender',"!!document.querySelector('#markdown h1')&&document.querySelectorAll('#markdown li').length===2&&!!document.querySelector('#markdown table')&&!!document.querySelector('#markdown pre code')");
  await check('HtmlAndUnsafeProtocolsAreInert',"!window.markdownExecuted&&!document.querySelector('#markdown img, #markdown script, #markdown [onclick], #markdown [onerror], #markdown a[href^=javascript]')&&document.getElementById('markdown').textContent.includes('<img')");
  await check('MarkdownOnlyCodeHasHorizontalScrolling',"document.documentElement.scrollWidth<=innerWidth&&document.getElementById('markdown').scrollWidth<=document.getElementById('markdown').clientWidth+1&&document.querySelector('#markdown pre code').scrollWidth>document.querySelector('#markdown pre code').clientWidth");
  await check('ReadonlyUsesSharedTrustedCodeControls', "document.querySelector('#markdown pre').classList.contains('relay-code-block')&&document.querySelector('#markdown .code-copy')&&!document.querySelector('#markdown .code-run')");
  await evaluate("document.querySelector('#markdown a[href^=https]').click();relayRenderReadOnlyMarkdown(document.getElementById('markdown'),markdownSource);document.querySelector('#markdown a[href^=mailto]').click();");
  await check('LinksUseExistingExternalApiExactlyOnceWithoutNavigation',"review.external.join(',')==='https://example.invalid/docs,mailto:example@example.invalid'&&location.protocol==='data:'");
  await evaluate("document.querySelector('#markdown a[href^=https]').dispatchEvent(new MouseEvent('auxclick',{button:2,bubbles:true,cancelable:true}));review.afterRightClick=review.external.length;document.querySelector('#markdown a[href^=https]').dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));");
  await check('OnlyMiddleAuxiliaryClickOpensExternalLink',"review.afterRightClick===2&&review.external.length===3&&review.external[2]==='https://example.invalid/docs'&&location.protocol==='data:'");
  await capture('markdown-light');
  await evaluate("document.documentElement.dataset.theme='dark';");await capture('markdown-dark');
  await evaluate(`window.incrementalSource='## 增量过程\\n\\n\`\`\`js\\n'+Array.from({length:30},(_,i)=>'const line'+i+' = '+i+';').join('\\n')+'\\n\`\`\`\\n\\n最新进展';
    relayRenderReadOnlyMarkdown(document.getElementById('markdown'),incrementalSource,{incremental:true});
    review.completedCode=document.querySelector('#markdown pre');review.completedCopy=document.querySelector('#markdown .code-copy');
    document.querySelector('#markdown .code-toggle').click();
    relayRenderReadOnlyMarkdown(document.getElementById('markdown'),incrementalSource+'继续补充',{incremental:true});`);
  await check('IncrementalNarrationKeepsCompletedCodeControlsAndCollapseState',"document.querySelector('#markdown pre')===review.completedCode&&document.querySelector('#markdown .code-copy')===review.completedCopy&&review.completedCode.classList.contains('collapsed')&&document.querySelectorAll('#markdown .code-copy').length===1&&document.getElementById('markdown').textContent.includes('最新进展继续补充')");
  await evaluate("review.paragraph=marked.defaults.renderer.paragraph;marked.defaults.renderer.paragraph=()=>'<p style=display:none onclick=alert(1)>safe</p><img src=https://example.invalid/incremental-probe onerror=alert(1)><a href=javascript:alert(1)>bad</a><script>window.incrementalExecuted=true</script>';relayRenderReadOnlyMarkdown(document.getElementById('markdown'),'different token',{incremental:true});marked.defaults.renderer.paragraph=review.paragraph;void 0;");
  await check('IncrementalTokensAreSanitizedBeforeMounting',"!window.incrementalExecuted&&!document.querySelector('#markdown img,#markdown script,#markdown [style],#markdown [onclick],#markdown a[href]')&&document.getElementById('markdown').textContent.includes('safe')");
  await evaluate("review.originalMarkdown=relayRenderMarkdown;review.originalHooks=marked.defaults.hooks;marked.defaults.hooks={};window.relayRenderMarkdown=()=>'<p onclick=alert(1)>fallback text</p><img src=https://example.invalid/incremental-fallback><a href=javascript:alert(1)>unsafe</a>';relayRenderReadOnlyMarkdown(document.getElementById('markdown'),'fallback source',{incremental:true});marked.defaults.hooks=review.originalHooks;window.relayRenderMarkdown=review.originalMarkdown;void 0;");
  await check('IncrementalFullFallbackAlsoPassesTheSanitizer',"document.getElementById('markdown').textContent.includes('fallback text')&&!document.querySelector('#markdown img,#markdown [onclick],#markdown a[href]')");
  await evaluate("marked.defaults.renderer.paragraph=()=>{throw Error('synthetic token failure')};window.relayRenderMarkdown=()=>{throw Error('synthetic full failure')};relayRenderReadOnlyMarkdown(document.getElementById('markdown'),'<b>完整原文</b>',{incremental:true});marked.defaults.renderer.paragraph=review.paragraph;window.relayRenderMarkdown=review.originalMarkdown;void 0;");
  await check('IncrementalDoubleFailureKeepsInertOriginalText',"document.getElementById('markdown').textContent==='<b>完整原文</b>'&&!document.querySelector('#markdown b')");
  await evaluate("review.originalMarkdown=relayRenderMarkdown;window.relayRenderMarkdown=()=>'<p class=evil style=display:none onclick=alert(1)>safe</p><a href=javascript:alert(1)>bad</a><img src=https://example.invalid/sanitizer-probe alt=图片><svg onload=alert(1)></svg><input type=text autofocus><input type=checkbox checked><pre><code class=\"hljs language-js\">code</code></pre>';relayRenderReadOnlyMarkdown(document.getElementById('markdown'),'fixture');");
  await check('SanitizerRemovesAttributesAndUnexpectedInteractiveElements',"!document.querySelector('#markdown [style],#markdown [onclick],#markdown img,#markdown input:not([type=checkbox]),#markdown a[href]')&&[...document.querySelectorAll('#markdown svg')].every(node=>node.closest('.code-actions'))&&document.querySelector('#markdown input').disabled&&document.querySelector('#markdown input').checked&&document.querySelector('#markdown code').classList.contains('hljs')");
  await evaluate("window.relayRenderMarkdown=()=>{throw Error('synthetic malformed Markdown')};relayRenderReadOnlyMarkdown(document.getElementById('markdown'),'<b>原文仍保留</b>');");
  await check('ParserFailureKeepsInertOriginalText',"document.getElementById('markdown').textContent==='<b>原文仍保留</b>'&&!document.querySelector('#markdown b')");
  await delay(120);checks.noMarkdownImageRequests=requests.length===0;if(!checks.noMarkdownImageRequests)throw Error('Markdown image request');
  await check('NoRendererErrorsOrNodeExposure',"review.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'");
  step='completed';save();console.log(JSON.stringify({checks,failures,requests}));clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{failures.push(String(error.stack||error));console.error(error.stack||error);if(win&&!win.isDestroyed())try{await capture('failure');}catch(_){}save();clearTimeout(deadline);app.exit(1);});
