'use strict';
// README images: real production renderer with wholly synthetic in-memory data.
// No Relay main process, preload, user profile, provider or external network.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'readme-capture');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'isolated-profile'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
let win;
const requests = [];
const screenshots = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['renderer/index.html', 'renderer/app.js', 'renderer/styles.css', 'renderer/window-chrome.css', 'renderer/plugins-page.css', 'renderer/memory-page.css', 'renderer/workspace-panel.css', 'renderer/mini.html', 'renderer/mini-chat.js', 'renderer/mini-chat.css', 'test/ui-api-fixture.js', 'test/workspace-api-fixture.js', 'test/plugins-api-fixture.js'];
const sourceHashes = Object.fromEntries(sourceFiles.map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]));
const evaluate = code => win.webContents.executeJavaScript(code).catch(error => {
  console.error('Renderer evaluation failed:', code.slice(0, 250));
  throw error;
});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() {
  await wait(500);
  await evaluate("document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}});new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
}
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+10000;function tick(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(tick,30)}tick()})`);
}
async function capture(name) {
  await settle();
  await win.webContents.capturePage(); // Prewarm Chromium capture after page/view transitions.
  await wait(180);
  await settle();
  const png=(await win.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(output,name+'.png'),png);
  const state=await evaluate(`({theme:document.documentElement.dataset.theme,chromeTheme:document.documentElement.dataset.windowChromeTheme,chromeBackground:getComputedStyle(document.getElementById('windowChrome') || document.documentElement).backgroundColor,canvas:getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim(),horizontalOverflow:document.documentElement.scrollWidth>innerWidth,finiteAnimationsRunning:document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity).length})`);
  screenshots.push({file:name+'.png',sha256:hash(png),bytes:png.length,...state});
}
function installWebsiteData() {
  localStorage.clear();
  localStorage.setItem('relay.workspace-panel.width.v1','630');
  localStorage.setItem('relay.sidebar.layout.v2',JSON.stringify({version:2,width:208,collapsed:false}));
  localStorage.setItem('relay.workspace-file-layout.v1',JSON.stringify({version:1,width:180,collapsed:true}));
  const base=window.api;
  const report = '# 把想法，推进到下一步\n\n项目启动 · 第 1 周\n\n我们整理了访谈、需求与参考资料，形成一份可以直接开始执行的工作计划。\n\n## 本周聚焦\n\n| 方向 | 下一步行动 | 交付物 |\n| --- | --- | --- |\n| 用户体验 | 梳理关键使用路径 | 体验流程图 |\n| 产品设计 | 确认首页信息结构 | 页面原型 |\n| 项目协作 | 对齐里程碑与分工 | 行动清单 |\n\n## 已整理的资料\n\n- **用户访谈**：归纳 3 个最常见的使用场景\n- **需求笔记**：合并重复条目，保留关键背景\n- **参考案例**：为每个方向补充可追溯的来源\n\n## 接下来\n\n1. 确认本周优先级与交付边界\n2. 根据已对齐的方案生成第一版原型\n3. 收集反馈，更新项目记录\n\n> 让每一次讨论，都成为下一步工作的起点。\n';
  const files={'项目计划.md':report,'访谈要点.md':'# 访谈要点\n\n合成演示资料。','行动清单.md':'# 行动清单\n\n- 确认优先级\n- 准备首版原型','设计简报.md':'# 设计简报\n\n清晰、专注、连续。'};
  const items=[
    {file:'writing-preferences.md',name:'我的写作偏好',description:'先说结论，再给依据；内容清楚，表达简洁。',type:'user',scope:'global',status:'active'},
    {file:'collaboration-habits.md',name:'我的协作习惯',description:'保留关键决策、交付标准与下一步行动。',type:'user',scope:'global',status:'active'},
    {file:'weekly-review.md',name:'每周复盘的固定结构',description:'本周进展、遇到的问题、下周计划。',type:'reference',scope:'global',status:'active'},
    {file:'research-method.md',name:'资料整理与引用习惯',description:'原始资料保留来源，事实与推断分别标注。',type:'reference',scope:'global',status:'active'}
  ];
  const memoryText='# 我的写作偏好\n\n把注意力留给内容，让表达自然、清楚。\n\n## 先讲重点\n\n开头直接说明结论和建议，再补充必要的背景与依据。\n\n## 保持可执行\n\n- 每个建议都对应一个具体的下一步\n- 比较方案时，说明适用条件和取舍\n- 文档交付时，保留来源和行动清单\n\n## 使用熟悉的语言\n\n以中文为主，语气自然。减少重复和空泛的修饰，技术细节只保留帮助理解的部分。\n\n> 随着协作继续，把确认过的偏好留在这里。';
  const overrides={
    projects:{list:async()=>({ok:true,projects:[{id:'demo-product',name:'项目空间',path:'C:/Relay-Demo/项目空间'}],workspace:'C:/Relay-Demo'})},
    workspace:{resolve:async()=>({ok:true,root:'C:/Relay-Demo/项目空间'}),list:async()=>({ok:true,entries:Object.keys(files).map(name=>({name,path:name,type:'file',size:files[name].length}))}),read:async({path})=>({ok:true,path,content:files[path]}),readLink:async()=>({ok:true,kind:'file',absolutePath:'C:/Relay-Demo/项目空间/项目计划.md',content:report}),onTerminalEvent:()=>()=>{}},
    memory:{list:async()=>({ok:true,items:items.map(x=>({...x,revision:'1'}))}),read:async file=>({ok:true,content:file==='writing-preferences.md'?memoryText:'# '+items.find(x=>x.file===file)?.name+'\n\n合成演示内容。',revision:'1'}),archived:async()=>({ok:true,items:[]}),history:async()=>({ok:true,items:[]})}
  };
  window.api=new Proxy(base,{get(target,key){return overrides[key]||target[key]}});
  window.websiteSynthetic={files,memory:items,allDataSynthetic:true};
}
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>{if(/^https?:/i.test(details.url))requests.push(details.url);done({cancel:/^https?:/i.test(details.url)});});
  const fixture=['ui-api-fixture.js','workspace-api-fixture.js','plugins-api-fixture.js'].map(x=>fs.readFileSync(path.join(root,'test',x),'utf8')).join('\n')+'\n('+installWebsiteData.toString()+')();';
  const html=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fixture+'</script>');
  const file=path.join(output,'isolated-fixture.html');fs.writeFileSync(file,html);
  win=new BrowserWindow({width:1680,height:1050,frame:false,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error(message); });
  await win.loadFile(file);
  win.webContents.setZoomFactor(1.25);
  await waitFor('providerRoutingLoaded&&!restoringActiveRuns&&!!relayWorkspacePanel');
  await evaluate(`(async()=>{
    const conv={projectId:'demo-product',id:'website-demo',title:'一起推进新的项目',mode:'plain',model:'opus',memoryMode:'read',workingDir:{path:'C:/Relay-Demo/项目空间',name:'项目空间'},createdAt:'2026-09-21T01:00:00Z',updatedAt:'2026-09-21T01:00:00Z',turns:[{user:'把这些资料整理成项目计划，帮我理清下一步。',assistant:'已整理好项目计划，放在右侧工作区。\\n\\n我将访谈、需求和参考资料归纳成了三个方向：\\n\\n- **用户体验**：找到关键使用路径\\n- **产品设计**：明确第一版的重点\\n- **项目协作**：把讨论转成行动清单\\n\\n每个方向都标出了下一步与交付物。你可以直接查看文档，继续补充想法。',status:'complete'}]};
    await api.history.save(conv);await loadConversation(conv.id);
    inputEl.value='接下来，帮我展开第一版的设计简报';inputEl.dispatchEvent(new Event('input',{bubbles:true}));
    await relayWorkspacePanel.openFileLink({href:'C:/Relay-Demo/项目空间/项目计划.md'});
  })()`);
  await waitFor("!!document.querySelector('#workspacePreviewBody h1')");
  if ((await evaluate('relayWorkspacePanel.getState().tabs.length')) !== 1) throw new Error('Expected one document tab');
  await capture('workspace-light');
  await evaluate("applyThemeToDOM('dark')");
  await waitFor("document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.windowChromeTheme==='dark'");
  await capture('workspace-dark');
  await evaluate("applyThemeToDOM('light')");
  await evaluate("relayWorkspacePanel.close();openSettings('memory')");
  await waitFor("document.querySelectorAll('#memorySection .dp-item').length===4");
  await capture('memory');
  await evaluate("document.getElementById('btnPlugins').click()");
  await waitFor("document.querySelectorAll('#skillSection > [data-list] > .dp-item:not(.skill-list-skeleton)').length===6");
  await capture('skills');
  const evidence=await evaluate('({errors:uiFixture.errors,synthetic:websiteSynthetic.allDataSynthetic,fixtureCalls:uiFixture.calls,hasNode:typeof require!=="undefined",hasProcess:typeof process!=="undefined",settingsWrites:workspaceFixture.settingsWrites,pluginWrites:pluginsFixture.writes})');
  const miniSeed=`(()=>{
    localStorage.clear();const base=api;
    const snapshot={running:false,pinned:true,brand:{name:'Relay',theme:'light'},conversation:{id:'website-quick',model:'sonnet',turns:[{user:'把这个想法整理成一段简洁的项目介绍。',assistant:'让零散的想法，变成可以开始的工作。\\n\\n我们希望让团队在同一个项目里整理资料、对齐决策，并持续推进下一步。\\n\\n**第一步**：明确目标，列出本周最重要的三项行动。',status:'complete'}]}};
    window.api=new Proxy(base,{get(target,key){
      if(key==='mini')return{state:async()=>snapshot,brand:async()=>snapshot.brand,onState:()=>()=>{},onFocus:()=>()=>{},resize:async()=>({ok:true})};
      if(key==='providers')return new Proxy(target.providers,{get(original,method){return method==='list'?async()=>({ok:true,routes:uiFixture.routes}):original[method];}});
      return target[key];
    }});
  })();`;
  const miniHtml=fs.readFileSync(path.join(root,'renderer/mini.html'),'utf8').replace('<head>','<head><base href="'+pathToFileURL(path.join(root,'renderer')+path.sep).href+'"><script>'+fs.readFileSync(path.join(root,'test/ui-api-fixture.js'),'utf8')+miniSeed+'</script>');
  const miniFile=path.join(output,'mini-fixture.html');fs.writeFileSync(miniFile,miniHtml);
  const oldWin=win;win=new BrowserWindow({width:800,height:780,frame:false,show:false,transparent:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});oldWin.destroy();
  await win.loadFile(miniFile);win.webContents.setZoomFactor(1.5);
  await waitFor("!!document.querySelector('.mini-answer:not([hidden])')");
  await evaluate("document.getElementById('miniInput').value='再给我一个更精简的版本';document.getElementById('miniInput').dispatchEvent(new Event('input',{bubbles:true}))");
  await capture('quick-chat');
  const miniErrors = await evaluate('uiFixture.errors');
  if (miniErrors.length) throw new Error(JSON.stringify(miniErrors));

  const sourceUnchanged=sourceFiles.every(file=>hash(fs.readFileSync(path.join(root,file)))===sourceHashes[file]);
  fs.writeFileSync(path.join(output,'capture-evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),renderer:'renderer/index.html and production scripts, unchanged',appVersion:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,dataSource:'In-memory ui-api-fixture.js + workspace-api-fixture.js + plugins-api-fixture.js + installWebsiteData()',networkPolicy:'All HTTP(S) blocked',blockedRequests:requests,imageSize:[1680,1050],pageZoom:1.25,captureWarmup:true,finiteAnimationsFinished:true,sourceHashes,sourceUnchanged,screenshots,...evidence},null,2));
  if (evidence.errors.length || requests.length || !sourceUnchanged || screenshots.some(s=>s.horizontalOverflow)) throw new Error('Screenshot validation failed; inspect capture-evidence.json');
  console.log(JSON.stringify({ output, screenshots: screenshots.map(s=>s.file), errors: evidence.errors, blockedRequests: requests, sourceUnchanged }));
  win.destroy();app.exit(0);
}).catch(async error=>{console.error(error.stack);if(win){try{await capture('failure');}catch(_){} }app.exit(1)});
