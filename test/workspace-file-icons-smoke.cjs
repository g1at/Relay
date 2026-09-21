'use strict';
// Real renderer and SVG artwork, isolated profile, synthetic files, no main/SDK.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.codex-tmp/workspace-file-icons-smoke');
fs.mkdirSync(output, { recursive: true });app.setPath('userData', path.join(output, 'profile'));app.commandLine.appendSwitch('disable-gpu');
let win, step = 'start';const checks = {}, errors = [], requests = [];
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ step, checks, errors, requests }, null, 2));
const deadline = setTimeout(() => { errors.push('timeout at ' + step);save();app.exit(1); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(code) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;const tick=()=>{if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,20)};tick()})`); }
async function check(name, code) { step=name;checks[name]=!!await evaluate(code);save();console.log(name+': '+checks[name]);if(!checks[name])throw Error(name); }
async function capture(name) { await delay(280);await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.writeFileSync(path.join(output, name+'.png'), (await win.webContents.capturePage()).toPNG()); }
function installFixture() {
  const base=window.api, ROOT='D:/Synthetic/IconReview';localStorage.clear();
  const p=window.iconReview={errors:[],reads:[],samples:[
    ['src',{directory:true}],['expanded',{directory:true,expanded:true}],['app.js'],['types.ts'],['view.tsx'],['worker.py'],
    ['run.sh'],['main.rs'],['README.md'],['data.json'],['settings.yaml'],['index.html'],['style.css'],['diagram.png'],
    ['movie.mp4'],['voice.mp3'],['report.pdf'],['notes.docx'],['table.xlsx'],['release.zip'],['native.dll'],['unknown.file'],
  ]};
  window.addEventListener('error', e=>p.errors.push(e.message));window.addEventListener('unhandledrejection', e=>p.errors.push(String(e.reason)));
  const content='# Synthetic delivery\n\nReadable project notes.';
  const read=name=>({ok:true,path:name,binary:false,content:name.endsWith('.py')?'from pathlib import Path\n\ndef verify_output(path: Path) -> bool:\n    """Read the generated file without changing it."""\n    return path.exists() and path.stat().st_size > 0\n\nprint("Ready")\n':content});
  const ws={resolve:async()=>({ok:true,root:ROOT}),list:async input=>({ok:true,entries:input.path==='src'?[{name:'worker.py',path:'src/worker.py',type:'file',size:230}]:input.path?[]:p.samples.filter(([name])=>name!=='expanded').map(([name,opts])=>({name,path:name,type:opts?.directory?'directory':'file',size:opts?.directory?undefined:230}))}),
    read:async input=>{p.reads.push(input);return read(input.path);},readLink:async input=>{p.reads.push(input);const parsed=RelayLocalFileLinks.parse(input.href);const absolutePath=/^[A-Z]:/i.test(parsed.path)?parsed.path:ROOT+'/'+parsed.path;return {...read(absolutePath),absolutePath,line:parsed.line};},
    open:async()=>({ok:true,target:'relay'}),onTerminalEvent:()=>()=>{}};
  window.api=new Proxy(base,{get(target,key){if(key==='workspace')return ws;return target[key];}});
}
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>{if(/^https?:/i.test(details.url))requests.push(details.url);done({cancel:/^https?:/i.test(details.url)});});
  const base=pathToFileURL(path.join(root,'renderer')+path.sep).href;
  const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+base+'"><script>'+fs.readFileSync(path.join(__dirname,'ui-api-fixture.js'),'utf8')+'\n('+installFixture.toString()+')();</script>');
  const page=path.join(output,'fixture.html');fs.writeFileSync(page,html);
  win=new BrowserWindow({width:1450,height:980,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(page);win.showInactive();await waitFor('!!relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns');
  await win.webContents.insertCSS('#iconSpecimen{position:fixed;inset:0;z-index:9999;overflow:auto;background:var(--bg);padding:44px 54px;color:var(--text)}#iconSpecimen h1{font-size:30px;letter-spacing:-1px;margin:0 0 8px}#iconSpecimen>p{margin:0 0 30px;color:var(--text-dim)}.icon-specimen-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.icon-specimen-item{display:flex;align-items:center;gap:22px;border:1px solid var(--border);border-radius:12px;background:var(--bg-panel);padding:18px 16px;min-height:86px}.icon-specimen-marks{display:flex;align-items:center;gap:12px}.icon-specimen-copy{display:flex;flex-direction:column;gap:5px;font-size:12px;min-width:0}.icon-specimen-copy strong{font-size:13px;font-weight:550}.icon-specimen-copy small{color:var(--text-muted)}');
  await act(`
    window.relayConversationWorkspace=()=>({conversationId:'icon-fixture',workingDir:'D:/Synthetic/IconReview',title:'文件图标示例'});window.dispatchEvent(new CustomEvent('relay:conversation-changed'));
    messagesEl.replaceChildren();appendMessage('assistant',${JSON.stringify('## 交付文件\n\n- [worker.py](D:/Synthetic/IconReview/worker.py:3) — 数据整理脚本\n- [verify_output.py](D:/Synthetic/IconReview/verify_output.py:1) — 结果校验\n- [README.md](D:/Synthetic/IconReview/README.md) — 使用说明\n\n[worker.py](D:/Synthetic/IconReview/worker.py)\n\n[report.pdf](D:/Synthetic/IconReview/report.pdf)\n\n[release.zip](D:/Synthetic/IconReview/release.zip)')});
    const specimen=document.createElement('section');specimen.id='iconSpecimen';specimen.innerHTML='<h1>文件图标</h1><p>16 / 18 / 24 px · 同一套图形，在列表、链接与交付卡片里保持一致。</p><div class="icon-specimen-grid"></div>';
    for(const [name,options] of iconReview.samples){const cell=document.createElement('div');cell.className='icon-specimen-item';const marks=document.createElement('div');marks.className='icon-specimen-marks';for(const size of [16,18,24]){const svg=relayWorkspaceFileTypes.createIcon(name,{...options,title:true});svg.style.setProperty('--workspace-file-icon-size',size+'px');marks.append(svg);}const copy=document.createElement('div');copy.className='icon-specimen-copy';const title=document.createElement('strong');title.textContent=relayWorkspaceFileTypes.describe(name,options).label;const subtitle=document.createElement('small');subtitle.textContent=name;copy.append(title,subtitle);cell.append(marks,copy);specimen.lastElementChild.append(cell);}document.body.append(specimen);
  `);
  await waitFor("messagesEl.querySelectorAll('.relay-file-card').length===3");
  await check('ArtworkStaysStaticAndAccessibilityLabelsRemainSafe', `(()=>{const icons=[...document.querySelectorAll('#iconSpecimen svg')];const unsafe=relayWorkspaceFileTypes.createIcon('<svg onload=alert(1)>.py',{title:'<svg onload=alert(1)>'});return icons.length===66&&icons.every(el=>el.getAttribute('viewBox')==='0 0 24 24'&&el.getAttribute('role')==='img'&&!el.querySelector('script,image,use,foreignObject'))&&!unsafe.querySelector('[onload]')&&unsafe.querySelector('title').textContent==='<svg onload=alert(1)>';})()`);
  for(const theme of ['light','dark']){
    await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.getElementById('iconSpecimen').hidden=false;`);
    await check('SmallIconsFitTheirViewboxes-'+theme, `Array.from(document.querySelectorAll('#iconSpecimen svg')).every(svg=>{const b=svg.getBBox(),r=svg.getBoundingClientRect();return b.x>=0&&b.y>=0&&b.x+b.width<=24.1&&b.y+b.height<=24.1&&[16,18,24].includes(r.width)&&r.width===r.height;})`);
    await capture('file-icons-specimen-'+theme);
    await act("document.getElementById('iconSpecimen').hidden=true;relayWorkspacePanel.open('files');");
    await waitFor("document.querySelectorAll('.workspace-file-row').length>=21");
    await act("const row=document.querySelector('[data-path=src]');if(row.getAttribute('aria-expanded')!=='true')row.click();");
    await waitFor("!!document.querySelector('[data-path=\"src/worker.py\"]')");
    await check('TreeInlineAndCardUseMatchingTypeArtwork-'+theme, `(()=>{const tree=document.querySelector('[data-path="worker.py"] .workspace-file-icon'),link=messagesEl.querySelector('a:not(.relay-file-card) .workspace-file-icon[data-file-kind=python]'),card=messagesEl.querySelector('.relay-file-card .workspace-file-icon[data-file-kind=python]');return tree&&link&&card&&tree.innerHTML===link.innerHTML&&link.innerHTML===card.innerHTML&&link.getBoundingClientRect().width===16&&card.getBoundingClientRect().width===25&&document.querySelector('[data-path=src] .workspace-file-icon').dataset.fileKind==='folder-open';})()`);
    await capture('file-icons-context-'+theme);
    await act("messagesEl.querySelector('a:not(.relay-file-card) .workspace-file-icon[data-file-kind=python]').closest('a').click();");
    await waitFor("document.querySelector('.workspace-tab[aria-selected=true] .workspace-file-icon')?.dataset.fileKind==='python'");
    await check('PreviewTabRetainsReadablePythonIdentity-'+theme, "document.querySelector('.workspace-tab[aria-selected=true]').textContent.includes('worker.py')&&document.querySelector('.workspace-source-code').textContent.includes('verify_output')");
    await capture('file-icons-preview-'+theme);
  }
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
  await act("document.getElementById('iconSpecimen').hidden=false;");
  await check('HighContrastKeepsPythonAndLetterMarksDistinct', `(()=>{const blue=document.querySelector('#iconSpecimen .file-icon-python-blue'),gold=document.querySelector('#iconSpecimen .file-icon-python-gold'),tile=document.querySelector('#iconSpecimen .file-icon-brand-tile'),label=document.querySelector('#iconSpecimen .file-icon-brand-label'),sheet=document.querySelector('#iconSpecimen .file-icon-sheet');return matchMedia('(forced-colors: active)').matches&&getComputedStyle(blue).fill!==getComputedStyle(gold).fill&&getComputedStyle(tile).fill!==getComputedStyle(label).fill&&getComputedStyle(sheet).fillOpacity==='1';})()`);
  await capture('file-icons-high-contrast');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});win.webContents.debugger.detach();
  await check('PreviewStaysOfflineAndNeverWritesHistoryOrStartsModels', "iconReview.errors.length===0&&uiFixture.errors.length===0&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')&&typeof require==='undefined'");
  if(requests.length)throw Error('Unexpected network requests');step='complete';save();clearTimeout(deadline);win.destroy();app.exit(0);
}).catch(async error=>{errors.push(String(error.stack||error));console.error(error);save();if(win&&!win.isDestroyed())try{await capture('failure');}catch(_){}clearTimeout(deadline);app.exit(1);});
