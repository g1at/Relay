'use strict';

// Actual renderer in an isolated Electron window; all history/API data is
// synthetic, and no Relay main process, model or business MCP is launched.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.codex-tmp', 'plugins-polish-smoke');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
let win;
const checks = {}, failures = [];
let step = 'starting';
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, failures, step }, null, 2));
// Reset evidence before boot so a timeout cannot report an older successful run.
save();
const deadline = setTimeout(() => { failures.push('Overall timeout at ' + step); save(); app.exit(1); }, 180000);
const evaluate = code => win.webContents.executeJavaScript(code);
const act = code => evaluate(`(() => { ${code}\n })()`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settleUI() {
  await evaluate("document.getAnimations().forEach(a=>{if(a.effect&&a.effect.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} });");
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function waitFor(code) {
  await evaluate(`new Promise((resolve,reject)=>{ const end=Date.now()+6000; const tick=()=>{ if(${code})return resolve(); if(Date.now()>end)return reject(new Error('State timeout: '+${JSON.stringify(code)})); setTimeout(tick,25); }; tick(); })`);
}
async function check(name, code) {
  step = name; console.log(name);
  checks[name] = !!await evaluate(code); save();
  if (!checks[name]) throw new Error(name);
}
async function click(selector) {
  await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)throw new Error('Missing '+${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest',inline:'nearest'}); el.click(); })()`);
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(90);
}
async function capture(name) {
  step = 'capture ' + name;
  await evaluate("document.getAnimations().forEach(a=>{ if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){} }); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await win.webContents.capturePage(); await delay(130);
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}

async function checkTitlebarPixels(theme) {
  const shot = await win.webContents.capturePage(), {width,height} = shot.getSize();
  const pixels = shot.getBitmap(), scale = height / await evaluate('innerHeight');
  const y = Math.floor(33 * scale);
  // Compare with the current theme's actual caption surface, not a retired
  // palette. Any modal shadow leaking into this strip still changes the pixels.
  const expected = await evaluate("getComputedStyle(document.getElementById('windowChrome')).backgroundColor.match(/[\\d.]+/g).slice(0,3).map(Number)");
  const name = theme + 'ModalShadowCannotShadeCaptionBackground';
  checks[name] = [.4,.7,.95].every(fraction => {
    const offset = (y * width + Math.floor(width * fraction)) * 4;
    return [0,1,2].every(channel => Math.abs(pixels[offset + channel] - expected[2 - channel]) <= 1);
  });
  save(); if (!checks[name]) throw new Error(name);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const draftFixture = `(() => {
    const base = window.api;
    window.polishDiff = '--- a/SKILL.md\\n+++ b/SKILL.md\\n@@ -1 +1,80 @@\\n-before\\n' +
      Array.from({length:80}, (_,i) => '+' + (i+1) + ': ' + 'Local draft preview, synthetic content only. '.repeat(14)).join('\\n') + '\\n+END_OF_SYNTHETIC_DIFF';
    const drafts = {
      list: async () => ({ok:true,items:[{id:'polish-draft',skillName:'周报整理',operation:'update',status:'draft',validation:{ok:true},changes:[]}]}),
      diff: async id => { window.polishDiffRead = id; return {ok:true,diff:{changed:true,additions:81,deletions:1,text:polishDiff}}; }
    };
    window.api = new Proxy(base, {get(target,category) {
      if(category!=='skillDrafts') return target[category];
      return new Proxy(target[category], {get(original,method) {return drafts[method] || original[method];}});
    }});
  })();`;
  const fixture = ['ui-api-fixture.js', 'workspace-api-fixture.js', 'plugins-api-fixture.js'].map(name => fs.readFileSync(path.join(__dirname, name), 'utf8')).join('\n') + draftFixture;
  const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + '\nlocalStorage.clear();</script>');
  const page = path.join(output, 'fixture.html'); fs.writeFileSync(page, html);
  win = new BrowserWindow({width:1320,height:920,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  await win.loadFile(page);
  win.showInactive();
  await waitFor('!!window.relayPluginsPage&&providerRoutingLoaded&&!restoringActiveRuns');
  await act("window.visible=s=>!!document.querySelector(s)?.getClientRects().length; window.fits=s=>{const r=document.querySelector(s).getBoundingClientRect();return r.top>=36&&r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;}; inputEl.value='界面调整期间保留的对话草稿';");
  await check('settingsAndUpdateShareTopNavigationWithoutDuplicateFooter', "(()=>{const s=document.getElementById('btnSettings'),u=document.getElementById('btnRelayUpdate');return !!s.closest('.nav-list')&&s.parentElement===u.parentElement&&document.querySelectorAll('#btnSettings').length===1&&!document.querySelector('.sidebar-bottom')&&s.getBoundingClientRect().top<document.getElementById('historyList').getBoundingClientRect().top;})()");
  await check('updateHiddenUntilNewVersionDetected', "!visible('#btnRelayUpdate')&&!visible('#sidebarUpdatePanel')");
  await act("workspaceFixture.setUpdate({state:'available',latest:'2.2.0',releaseNotes:'合成更新说明，仅验证本地界面。'});");
  await click('#btnRelayUpdate'); await settleUI();
  await check('topUpdatePopoverFitsBelowAnchorAndTitlebar', "fits('#sidebarUpdatePanel')&&document.getElementById('sidebarUpdatePanel').getBoundingClientRect().top>=document.getElementById('btnRelayUpdate').getBoundingClientRect().bottom&&workspaceFixture.updateCalls.every(call=>call==='status')");
  await capture('top-settings-update'); await key('ESCAPE');
  await check('updateEscapeReturnsFocusToMovedButton', "!visible('#sidebarUpdatePanel')&&document.activeElement.id==='btnRelayUpdate'");
  await act("workspaceFixture.setUpdate({state:'idle',latest:''});");
  await click('#btnSettings'); await waitFor("!!document.getElementById('set-brandName')");
  await check('movedSettingsOpensSameSettingsPage', "activeView==='settings'&&document.getElementById('btnSettings').getAttribute('aria-current')==='page'");
  await click('#btnPlugins');
  for (const theme of ['light','dark']) {
    await act(`document.documentElement.dataset.theme=${JSON.stringify(theme)};`);
    for (const [category, count] of [['skill',6],['agent',2],['mcp',2]]) {
      await click(`[data-plugin-tab=${category}]`);
      await waitFor(`document.querySelectorAll('#${category}Section > [data-list] > .dp-item:not(.skill-list-skeleton)').length===${count}&&!document.getElementById('pluginsRefresh').disabled`);
      await settleUI();
      await check(`${theme}_${category}_allCardsHaveFourContinuousCornersWithSharedElevation`, `(()=>{const probe=document.createElement('span');probe.style.boxShadow='var(--shadow-control)';document.body.append(probe);const expected=getComputedStyle(probe).boxShadow;probe.remove();const cards=Array.from(document.querySelectorAll('#${category}Section > [data-list] > .dp-item'));return expected!=='none'&&cards.length===${count}&&cards.every(e=>{const s=getComputedStyle(e);return ['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].every(k=>s[k]==='12px')&&s.boxShadow===expected;});})()`);
      const point = await evaluate(`(()=>{const r=document.querySelector('#${category}Section > [data-list] > .dp-item').getBoundingClientRect();return{x:Math.round(r.left+25),y:Math.round(r.top+25)};})()`);
      win.webContents.sendInputEvent({type:'mouseMove',...point});
      await waitFor(`document.querySelector('#${category}Section > [data-list] > .dp-item').matches(':hover')`);
      await check(`${theme}_${category}_firstCardHoverUsesContinuousRoundedBackground`, `(()=>{const e=document.querySelector('#${category}Section > [data-list] > .dp-item'),s=getComputedStyle(e);return e.matches(':hover')&&s.backgroundColor!=='rgba(0, 0, 0, 0)'&&['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].every(k=>s[k]==='12px');})()`);
      if (theme==='light'||category==='skill') await capture(`${theme}-${category}-hover`);
    }
  }
  await act("document.documentElement.dataset.theme='light';");
  await click('[data-plugin-tab=skill]');
  await act('pluginsFixture.refreshBefore=pluginsFixture.overviewCount;');
  await click('#pluginsRefresh');
  await waitFor('pluginsFixture.overviewCount>pluginsFixture.refreshBefore&&!document.getElementById("pluginsRefresh").disabled');
  await check('replacementRefreshStillReloadsCurrentCategory', 'pluginsFixture.overviewCount===pluginsFixture.refreshBefore+1');
  await click('[data-skill-view=updates]');
  await waitFor("!!document.querySelector('#skillSection [data-draft-list] [data-action=diff]')");
  await click('#skillSection [data-draft-list] [data-action=diff]');
  await waitFor("!!document.querySelector('.preview-overlay.show .pv-code')"); await settleUI();
  await check('draftDiffUsesActualDraftApiAndPreservesEntireText', "polishDiffRead==='polish-draft'&&document.querySelector('.pv-code code').textContent===polishDiff&&document.querySelector('.pv-code code').classList.contains('hljs')");
  await check('oneScrollContainerHandlesBothAxes', "(()=>{const p=document.querySelector('.pv-code'),c=p.querySelector('code');return p.scrollWidth>p.clientWidth&&p.scrollHeight>p.clientHeight&&getComputedStyle(c).overflowX==='visible'&&getComputedStyle(c).overflowY==='visible'&&c.scrollWidth<=c.clientWidth;})()");
  await check('diffScrollbarsUseSharedRoundedStyleWithoutArrowButtons', "(()=>{const e=document.querySelector('.pv-code'),s=getComputedStyle(e,'::-webkit-scrollbar'),t=getComputedStyle(e,'::-webkit-scrollbar-thumb'),b=getComputedStyle(e,'::-webkit-scrollbar-button');return s.height==='9px'&&s.width==='9px'&&t.borderRadius==='999px'&&b.display==='none';})()");
  await check('diffBackdropLeavesEntireTitlebarClearAndDialogFits', "(()=>{const o=document.querySelector('.preview-overlay.show'),h=document.getElementById('windowChrome');return o.getBoundingClientRect().top===h.getBoundingClientRect().bottom&&fits('.preview-box')&&!!document.elementFromPoint(innerWidth-50,15)?.closest('#windowChrome')&&!!document.elementFromPoint(300,15)?.closest('#windowChrome');})()");
  await capture('draft-diff-light');
  await checkTitlebarPixels('light');
  await act("const p=document.querySelector('.pv-code');p.scrollLeft=p.scrollWidth;p.scrollTop=p.scrollHeight;");
  await check('diffCanReachFarRightAndLastLine', "(()=>{const p=document.querySelector('.pv-code');return p.scrollLeft>100&&p.scrollTop>100&&Math.abs(p.scrollHeight-p.clientHeight-p.scrollTop)<=1&&p.textContent.endsWith('+END_OF_SYNTHETIC_DIFF');})()");
  await act("document.documentElement.dataset.theme='dark';const p=document.querySelector('.pv-code');p.scrollLeft=0;p.scrollTop=0;");
  await capture('draft-diff-dark');
  await checkTitlebarPixels('dark');
  win.setSize(940,640); await waitFor('innerWidth<=940'); await settleUI();
  await check('diffStillFitsAtMinimumWindowSize', "fits('.preview-box')&&document.documentElement.scrollWidth<=innerWidth");
  await capture('draft-diff-compact'); await key('ESCAPE');
  await check('draftDiffEscapeClosesPreview', "!document.querySelector('.preview-overlay.show')");
  await click('#skillSection [data-draft-list] [data-action=diff]');
  await waitFor("!!document.querySelector('.preview-overlay.show .preview-close')");
  await click('.preview-overlay.show .preview-close');
  await check('draftDiffCloseButtonStillWorks', "!document.querySelector('.preview-overlay.show')");
  await click('#pluginsReturn');
  await check('chatDraftAndSettingsRemainUntouched', "activeView==='chat'&&inputEl.value==='界面调整期间保留的对话草稿'&&workspaceFixture.settingsWrites.length===0&&pluginsFixture.writes.length===0");
  await check('noRendererErrorsOrNodeAccess', "uiFixture.errors.length===0&&typeof require==='undefined'&&typeof process==='undefined'");
  step='completed'; save(); console.log(JSON.stringify({checks,failures})); clearTimeout(deadline); win.destroy(); app.exit(0);
}).catch(async error => {
  failures.push(String(error.stack||error)); console.error(error.stack||error);
  if(win&&!win.isDestroyed()){try{console.error(await evaluate('JSON.stringify(uiFixture.errors)'));await capture('failure');}catch(_){} }
  save(); clearTimeout(deadline); app.exit(1);
});
