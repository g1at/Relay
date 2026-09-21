'use strict';
// Synthetic long history; production renderer, no provider calls or user data.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const label = process.argv.includes('--baseline') ? 'baseline' : 'updated';
const output = path.join(root, '.codex-tmp/chat-resize-performance');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile-' + label));
app.commandLine.appendSwitch('disable-gpu');
let win;
const result = { label, checks: {}, errors: [] };
const save = () => fs.writeFileSync(path.join(output, label + '.json'), JSON.stringify(result, null, 2));
const deadline = setTimeout(() => { result.errors.push('timeout'); save(); app.exit(1); }, 120000);
const evaluate = value => win.webContents.executeJavaScript(value);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const page = path.join(output, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8') + '</script>'));
  win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 2) console.log(message); });
  await win.loadFile(page); win.showInactive();
  await evaluate('new Promise(resolve=>{const timer=setInterval(()=>{if(window.relayWorkspacePanel&&providerRoutingLoaded&&!restoringActiveRuns){clearInterval(timer);resolve();}},25)})');
  result.history = await evaluate(String.raw`(async()=>{
    const code=Array.from({length:80},(_,i)=>'const item'+i+' = { title: "Synthetic line '+i+'", enabled: true };').join('\n');
    const text='# 合成长对话\n\n'+('说明文字用于检查布局换行及滚动定位。'.repeat(20))+'\n\n'+String.fromCharCode(96).repeat(3)+'js\n'+code+'\n'+String.fromCharCode(96).repeat(3);
    const conv={id:'performance-history',title:'合成长历史',mode:'chat',model:'opus',turns:Array.from({length:60},(_,i)=>({user:'问题 '+i,assistant:text,ts:new Date().toISOString()}))};
    await api.history.save(conv);const started=performance.now();await loadConversation(conv.id);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return{loadMs:performance.now()-started,turns:60,characters:text.length*60,messages:messagesEl.querySelectorAll('.message').length};
  })()`);
  result.drag = await evaluate(`new Promise(resolve=>{
    $('btnWorkspacePanel').click();
    const handle=$('workspaceResizeHandle'), gaps=[], costs=[]; let frame=0,last=null;
    setTimeout(()=>{const x=handle.getBoundingClientRect().x+3;handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:71,clientX:x,isPrimary:true}));
      function tick(now){if(last!==null)gaps.push(now-last);last=now;
        const began=performance.now();window.dispatchEvent(new PointerEvent('pointermove',{pointerId:71,clientX:x-Math.sin(frame/12)*110}));costs.push(performance.now()-began);
        if(++frame<90)requestAnimationFrame(tick);else{window.dispatchEvent(new PointerEvent('pointerup',{pointerId:71,clientX:x}));const sorted=gaps.toSorted((a,b)=>a-b);resolve({frames:gaps.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:Math.max(...gaps),over50:gaps.filter(v=>v>50).length,handlerMax:Math.max(...costs)});}}
      requestAnimationFrame(tick);
    },350);
  })`);
  result.checks.historyIntact = await evaluate('messagesEl.querySelectorAll(".message.user").length===60&&messagesEl.querySelectorAll(".message.assistant").length===60');
  result.checks.noOverflow = await evaluate('document.documentElement.scrollWidth<=innerWidth');
  if (label !== 'baseline') {
    result.checks.historyAnchorNavigation = await evaluate(`new Promise(resolve=>{
      stickToBottom=false; messagesEl.scrollTop=0;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        const first=messagesEl.querySelector('.message.user').getBoundingClientRect(),box=messagesEl.getBoundingClientRect();
        resolve(first.top>=box.top-1&&first.top<box.bottom);
      }));
    })`);
    result.streaming = await evaluate(String.raw`new Promise(resolve=>{
      detachStreamRenderTarget();stickToBottom=true;
      const fence=String.fromCharCode(96).repeat(3);
      const prefix='# 实时输出\n\n'+fence+'js\n'+Array.from({length:240},(_,i)=>'const stream'+i+' = "streaming code";').join('\n')+'\n'+fence+'\n\n';
      appendOrUpdateAssistant(prefix,true);
      const handle=$('workspaceResizeHandle'),gaps=[];let frame=0,last=null,oldCode;
      setTimeout(()=>{oldCode=currentAssistantBubble.querySelector('pre');const x=handle.getBoundingClientRect().x+3;
        handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:72,clientX:x,isPrimary:true}));
        function tick(now){if(last!==null)gaps.push(now-last);last=now;
          appendOrUpdateAssistant('继续生成内容，保持代码框与滚动稳定。',true);
          window.dispatchEvent(new PointerEvent('pointermove',{pointerId:72,clientX:x-Math.sin(frame/12)*110}));
          if(++frame<90)requestAnimationFrame(tick);else{
            window.dispatchEvent(new PointerEvent('pointerup',{pointerId:72,clientX:x}));flushStreamRender();
            const sorted=gaps.toSorted((a,b)=>a-b);
            resolve({frames:gaps.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:Math.max(...gaps),stableCode:oldCode===currentAssistantBubble.querySelector('pre'),fullText:currentAssistantBubble.dataset.raw===prefix+'继续生成内容，保持代码框与滚动稳定。'.repeat(90),copyButton:!!currentAssistantBubble.querySelector('.assistant-copy')});
          }}requestAnimationFrame(tick);
      },120);
    })`);
    result.checks.streamingNoLostText = result.streaming.fullText;
    result.checks.streamingCodeDomPreserved = result.streaming.stableCode;
    result.checks.finalCopyAvailable = result.streaming.copyButton;
    result.checks.historyDragResponsive = result.drag.p95 < 75;
  }
  result.errors.push(...await evaluate('uiFixture.errors'));
  fs.writeFileSync(path.join(output, label + '.png'), (await win.webContents.capturePage()).toPNG());
  save(); console.log(JSON.stringify(result)); clearTimeout(deadline); app.exit(result.errors.length || Object.values(result.checks).some(v=>!v) ? 1 : 0);
}).catch(error => { result.errors.push(String(error.stack || error)); save(); clearTimeout(deadline); app.exit(1); });
