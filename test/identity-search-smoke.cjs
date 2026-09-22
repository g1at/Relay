'use strict';
// Real production renderers with synthetic APIs and deliberately non-square
// artwork. Compare sampled rendered pixels, not just matching CSS declarations.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp', 'identity-search-smoke');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
let win, step = 'starting';
const report = { checks: {}, failures: [], crops: {} };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ...report, step }, null, 2));
const timeout = setTimeout(() => { report.failures.push('Timeout: ' + step); save(); app.exit(1); }, 150000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(()=>{${code}\n})()`);
async function until(code) { const end = Date.now() + 7000; while (Date.now() < end) { if (await evaluate(code)) return; await pause(25); } throw Error('Timed out: ' + code); }
async function settle() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(200); }
async function check(name, value) { step = name; report.checks[name] = !!(typeof value === 'string' ? await evaluate(value) : value); save(); if (!report.checks[name]) throw Error(name); }
async function click(selector) { await act(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); }
async function screenshot(name) { await settle(); fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
const profileSource = fs.readFileSync(path.join(__dirname, './profile-page-smoke.cjs'), 'utf8');
const profileSeed = profileSource.slice(profileSource.indexOf('function installFixture()'), profileSource.indexOf('\nasync function key('));
const miniSource = fs.readFileSync(path.join(__dirname, './mini-chat-smoke.cjs'), 'utf8');
const miniSeed = miniSource.slice(miniSource.indexOf('function fixture()'), miniSource.indexOf('\nasync function loadRenderer('));
const mainSeed = ['ui-api-fixture.js', 'workspace-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n');
function artwork(width, height) {
  // A nonrepeating grid exposes source-region and scale differences. A simple
  // four-quadrant image would look identical under several incorrect crops.
  let tiles = '';
  for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) {
    const fill = `rgb(${28 + column * 26},${28 + row * 26},${36 + ((column + row) % 8) * 23})`;
    tiles += `<rect x="${column * width / 8}" y="${row * height / 8}" width="${width / 8}" height="${height / 8}" fill="${fill}"/>`;
  }
  return 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${tiles}</svg>`).toString('base64');
}
async function load(kind, source) {
  if (win && !win.isDestroyed()) win.destroy();
  const main = kind === 'main', name = main ? 'index.html' : kind === 'mini' ? 'mini.html' : 'floating-orb.html';
  const seed = main ? `${mainSeed}\n${profileSeed}\ninstallFixture();profileFixture.mode='instant';profileFixture.identity={name:'统一头像裁切',logo:${JSON.stringify(source)},revision:'synthetic',nameMax:40};profileFixture.logo=${JSON.stringify(source)};`
    : `${miniSeed}\nfixture();miniFixture.snapshot.brand={name:'统一头像裁切',logo:${JSON.stringify(source)},theme:'light'};`;
  const html = fs.readFileSync(path.join(root, 'renderer', name), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + seed + '</script>');
  const file = path.join(out, kind + '.html'); fs.writeFileSync(file, html);
  const size = main ? [1200, 860] : kind === 'mini' ? [460, 246] : [64, 64];
  win = new BrowserWindow({ width:size[0],height:size[1],useContentSize:true,frame:false,transparent:true,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false} });
  win.webContents.on('console-message', (_e,level,message) => { if(level>=3 && !message.includes('Content Security Policy')) report.failures.push(message); });
  await win.loadFile(file);win.show();await settle();
  if(main){await until('providerRoutingLoaded&&!restoringActiveRuns');await act("openSettings('profile')");await until('!!document.getElementById("profileLogo")');}
  else await until(kind==='mini'?'miniLogo.complete&&miniLogo.naturalWidth>0':'orbLogo.complete&&orbLogo.naturalWidth>0');
}
async function sample(id, label) {
  await until(`document.getElementById(${JSON.stringify(id)}).complete&&document.getElementById(${JSON.stringify(id)}).naturalWidth>0`);await settle();
  const geometry = await evaluate(`(()=>{const el=document.getElementById(${JSON.stringify(id)}),r=el.getBoundingClientRect(),s=getComputedStyle(el);return{rect:r.toJSON(),naturalWidth:el.naturalWidth,naturalHeight:el.naturalHeight,fit:s.objectFit,position:s.objectPosition,radius:s.borderRadius,padding:s.padding,border:s.borderWidth,source:el.src}})()`);
  const r=geometry.rect, picture=await win.webContents.capturePage({x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}),size=picture.getSize(),bytes=picture.toBitmap();
  const points=[[.3,.3],[.7,.3],[.3,.7],[.7,.7]],pixels=points.map(([x,y])=>{const offset=(Math.floor(y*size.height)*size.width+Math.floor(x*size.width))*4;return[bytes[offset+2],bytes[offset+1],bytes[offset],bytes[offset+3]]});
  fs.writeFileSync(path.join(out,label+'.png'),picture.toPNG());
  delete geometry.source;report.crops[label]={...geometry,pixels};
  await check(label+' has square centered circular artwork',Math.abs(r.width-r.height)<.1&&geometry.fit==='cover'&&geometry.position==='50% 50%'&&geometry.radius==='50%'&&geometry.padding==='0px'&&geometry.border==='0px');
  return pixels;
}
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:/^https?:/i.test(details.url)}));
  for(const [shape,width,height] of [['landscape',200,100],['portrait',100,200]]){
    const source=artwork(width,height), samples={};
    await load('main',source);
    samples.sidebar=await sample('brandLogo',shape+'-sidebar');samples.profile=await sample('profileLogo',shape+'-profile');
    await screenshot(shape+'-profile-page');await click('#profileEdit');await until('profileIdentityEditor.open&&!profileSave.disabled');
    samples.editor=await sample('set-brandLogoPreview',shape+'-editor');await screenshot(shape+'-profile-editor');await click('#profileCancel');
    if(shape==='landscape'){
      await act('showChatView();showSearchModal()');await until("document.activeElement.classList.contains('search-input')");
      for(const [theme,size] of [['light',[1200,860]],['dark',[700,420]]]){
        win.setContentSize(...size);await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await settle();
        await check(theme+' search dims the window chrome and has one intact outer border',`(()=>{const box=document.querySelector('.search-box'),head=document.querySelector('.search-head'),input=document.querySelector('.search-input'),b=box.getBoundingClientRect(),h=head.getBoundingClientRect(),s=getComputedStyle(box),i=getComputedStyle(input);return document.documentElement.dataset.windowChromeDimmed==='true'&&['borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth'].every(key=>s[key]==='1px')&&Math.abs(h.top-b.top-1)<1&&h.left>=b.left&&h.right<=b.right&&h.bottom<=b.bottom&&b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&getComputedStyle(head).borderBottomWidth==='1px'&&i.borderWidth==='0px'&&i.boxShadow==='none'&&i.outlineStyle==='none'})()`);
        await screenshot('search-'+theme+'-focused');await act("document.querySelector('.search-close').focus()");await settle();
        await check(theme+' search header geometry is unchanged on focus transfer',`(()=>{const b=document.querySelector('.search-box').getBoundingClientRect(),h=document.querySelector('.search-head').getBoundingClientRect();return Math.abs(h.top-b.top-1)<1&&getComputedStyle(document.querySelector('.search-input')).boxShadow==='none'})()`);
        await act("document.querySelector('.search-input').focus()");
      }
      await click('.search-close');await check('search can close without changing conversation data',`!document.querySelector('.search-overlay').classList.contains('show')&&document.documentElement.dataset.windowChromeDimmed==='false'&&!uiFixture.calls.includes('history.save')&&!uiFixture.calls.includes('runClaude')`);
    }
    await load('mini',source);samples.mini=await sample('miniLogo',shape+'-mini');await screenshot(shape+'-mini-window');
    await load('orb',source);samples.orb=await sample('orbLogo',shape+'-orb');
    await check(shape+' custom orb fills its inner circle',`(()=>{const o=relayOrb.getBoundingClientRect(),r=orbLogo.getBoundingClientRect(),s=getComputedStyle(relayOrb);return Math.abs(r.width-(o.width-parseFloat(s.borderLeftWidth)-parseFloat(s.borderRightWidth)))<.1&&Math.abs(r.height-(o.height-parseFloat(s.borderTopWidth)-parseFloat(s.borderBottomWidth)))<.1&&o.width===48})()`);
    for(const [name,pixels] of Object.entries(samples))if(name!=='sidebar')await check(shape+' '+name+' renders the same source crop as sidebar',pixels.every((p,i)=>p.every((channel,c)=>Math.abs(channel-samples.sidebar[i][c])<=3)));
    await act('miniFixture.snapshot.brand.logo=null;miniFixture.emit()');await settle();
    await check(shape+' reset preserves default SVG clear space and orb hit area',`orbLogo.classList.contains('relay-default-logo')&&orbLogo.getAttribute('src')==='logo.svg'&&getComputedStyle(orbLogo).objectFit==='contain'&&orbLogo.getBoundingClientRect().width===56&&relayOrb.getBoundingClientRect().width===48`);
  }
}).catch(async error=>{report.failures.push(error.stack||String(error));try{await screenshot('failure')}catch(_){}}).finally(()=>{clearTimeout(timeout);save();if(win&&!win.isDestroyed())win.destroy();console.log(JSON.stringify(report));app.exit(report.failures.length?1:0)});
