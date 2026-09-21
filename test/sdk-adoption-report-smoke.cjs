'use strict';
const {app, BrowserWindow, session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.codex-tmp/sdk-adoption-report-smoke');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));
app.commandLine.appendSwitch('disable-gpu');
const report={ok:false,checks:{},errors:[],scope:'isolated Electron report viewer'};let win;
const timer=setTimeout(()=>{report.errors.push('timeout');done();},60000);
function done(){clearTimeout(timer);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(report.ok?0:1);}
async function check(name,js){report.checks[name]=!!await win.webContents.executeJavaScript(js);if(!report.checks[name])throw Error(name);}
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((detail,callback)=>callback({cancel:/^https?:/.test(detail.url)}));
 win=new BrowserWindow({width:1260,height:860,show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 await win.loadFile(path.join(root,'docs/Relay-SDK-0.3.266-逐项评估.html'));
 await win.webContents.executeJavaScript(`document.querySelector('[data-view=adoption]').click()`);
 await check('opens directly on all eight implemented SDK rows',`document.querySelectorAll('[data-row-id]').length===8&&[...document.querySelectorAll('#rows tr')].every(row=>row.textContent.includes('已落实'))`);
 await check('new batch button is selected',`document.querySelector('[data-view=adoption]').getAttribute('aria-pressed')==='true'`);
 await win.webContents.executeJavaScript(`document.querySelector('[data-view=high]').click()`);
 await check('earlier high priority batch remains available',`document.getElementById('count').textContent.includes('47')&&document.getElementById('priority').value==='高'`);
 await win.webContents.executeJavaScript(`document.querySelector('[data-view=limited]').click()`);
 await check('upstream restriction is retained along with medium restrictions',`document.querySelectorAll('[data-row-id]').length===6&&[...document.querySelectorAll('#rows tr')].every(row=>row.textContent.includes('上游限制'))`);
 await win.webContents.executeJavaScript(`document.querySelector('[data-view=all]').click()`);
 await check('all 673 rows remain selectable',`document.getElementById('count').textContent.includes('673')`);
 await win.webContents.executeJavaScript(`document.querySelector('[data-view=adoption]').click();document.getElementById('search').value='listSubagents';document.getElementById('search').dispatchEvent(new Event('input'));`);
 await check('search works independently of batch shortcut',`[...document.querySelectorAll('#rows tr')].some(row=>row.textContent.includes('listSubagents'))`);
 await win.webContents.executeJavaScript(`document.querySelector('[data-view=adoption]').click()`);
 await check('returning to SDK batch clears search and restores eight rows',`!document.getElementById('search').value&&document.querySelectorAll('[data-row-id]').length===8`);
 await new Promise(resolve=>setTimeout(resolve,180));
 await check('desktop has no horizontal overflow',`document.documentElement.scrollWidth<=innerWidth`);
 fs.writeFileSync(path.join(out,'sdk-adoption-report.png'),(await win.webContents.capturePage()).toPNG());
 win.setSize(720,800);await new Promise(resolve=>setTimeout(resolve,100));
 await check('compact report remains within viewport',`document.documentElement.scrollWidth<=innerWidth`);
 report.ok=true;
}).catch(error=>report.errors.push(error.stack||String(error))).finally(done);
