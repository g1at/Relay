'use strict';
const {app,BrowserWindow,session}=require('electron');const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.codex-tmp/sdk-medium-report');fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.commandLine.appendSwitch('disable-gpu');
const report={ok:false,scope:'Windows 隔离 Electron 报告查看器；无网络、无用户数据',checks:{},errors:[]};let win;
const timer=setTimeout(()=>{report.errors.push('timeout');done();},60000);
const js=code=>win.webContents.executeJavaScript(code);async function check(name,code){report.checks[name]=!!await js(code);if(!report.checks[name])throw Error(name);}
function done(){clearTimeout(timer);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(report.ok?0:1);}
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((r,cb)=>cb({cancel:/^https?:/.test(r.url)}));
 win=new BrowserWindow({width:1260,height:880,show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 await win.loadFile(path.join(root,'docs/Relay-SDK-0.3.266-逐项评估.html'));
 await check('default is the complete 106-row medium hybrid batch',`document.getElementById('count').textContent==='筛选 106 / 673 条'&&document.querySelector('[data-view=medium]').getAttribute('aria-pressed')==='true'`);
 await check('first page has 40 rows and all carry implementation evidence',`document.querySelectorAll('[data-row-id]').length===40&&[...document.querySelectorAll('#rows tr')].every(r=>r.textContent.includes('验证与边界'))`);
 await js(`document.getElementById('next').click();document.getElementById('next').click()`);
 await check('last page has the remaining 26 rows including the two gated tools',`document.querySelectorAll('[data-row-id]').length===26&&document.getElementById('rows').textContent.includes('ProposeGoal')&&document.getElementById('rows').textContent.includes('上游限制')`);
 await js(`document.querySelector('[data-view=adoption]').click()`);
 await check('previous eight SDK adoption rows remain available',`document.querySelectorAll('[data-row-id]').length===8&&document.getElementById('count').textContent==='筛选 8 / 673 条'`);
 await js(`document.querySelector('[data-view=high]').click()`);
 await check('previous 47 high-priority rows retain their batch',`document.getElementById('count').textContent==='筛选 47 / 673 条'`);
 await js(`document.querySelector('[data-view=limited]').click()`);
 await check('upstream filter includes four prior MCP rows plus two new tool rows',`document.querySelectorAll('[data-row-id]').length===6&&[...document.querySelectorAll('#rows tr')].every(r=>r.textContent.includes('上游限制'))`);
 await js(`document.querySelector('[data-view=all]').click()`);
 await check('all 673 evaluations remain selectable',`document.getElementById('count').textContent==='筛选 673 / 673 条'`);
 await js(`document.getElementById('search').value='ProposeGoal';document.getElementById('search').dispatchEvent(new Event('input'))`);
 await check('search locates the original assessment and current implementation',`[...document.querySelectorAll('#rows tr')].some(r=>r.dataset.rowId==='16-041'&&r.textContent.includes('当前'))`);
 await js(`document.querySelector('[data-view=medium]').click()`);
 await check('batch resets search and returns to all 106',`!document.getElementById('search').value&&document.getElementById('count').textContent==='筛选 106 / 673 条'`);
 await check('desktop layout does not overflow',`document.documentElement.scrollWidth<=innerWidth`);
 win.setSize(720,800);await new Promise(r=>setTimeout(r,150));
 await check('compact layout does not overflow',`document.documentElement.scrollWidth<=innerWidth`);
 await check('regression result is synchronized',`document.getElementById('regression-status').textContent.includes('134 / 134')`);
 report.ok=true;
}).catch(e=>report.errors.push(e.stack||String(e))).finally(done);
