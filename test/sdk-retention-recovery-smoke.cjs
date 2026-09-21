'use strict';
// Real Relay renderer; synthetic stream, isolated profile and synthetic history.
// A removed fixture transcript exercises the existing missing-session recovery.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/sdk-retention-recovery');
fs.mkdirSync(out, { recursive: true }); app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const checks = {}, failures = []; let win;
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ checks, failures }, null, 2));
const timer = setTimeout(() => { failures.push('timeout'); save(); app.exit(1); }, 60000);
const ev = code => win.webContents.executeJavaScript(code);
const act = code => ev(`(()=>{${code}\n})()`);
async function waitFor(code) { await ev(`new Promise((resolve,reject)=>{const end=Date.now()+7000;function check(){if(${code})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(code)}));setTimeout(check,20)}check()})`); }
async function check(name, code) { checks[name] = !!await ev(code); save(); if (!checks[name]) throw Error(name); }
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const seed = `(()=>{ localStorage.clear(); const base=window.api;window.recoveryFixture={launches:[],drops:[]};window.api=new Proxy(base,{get(target,key){
    if(key==='runClaude')return async(...args)=>{recoveryFixture.launches.push(args);return target.runClaude(...args);};
    if(key==='dropClaudeSession')return async id=>{recoveryFixture.drops.push(id);return {ok:true};};return target[key];}});})();`;
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const page = path.join(out, 'fixture.html');
  fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'renderer') + path.sep).href}"><script>${fixture}${seed}</script>`));
  win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(page); await waitFor('providerRoutingLoaded&&!restoringActiveRuns');
  await act("$('input').value='保留这条历史信息';$('btnSend').click();"); await waitFor('recoveryFixture.launches.length===1&&runs.size===1');
  await act("recoveryFixture.id=currentConv.id;handleClaudeEvent({jobId:uiFixture.runId,type:'system',subtype:'init',session_id:'expired-native-fixture'});handleClaudeEvent({jobId:uiFixture.runId,type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',result:'这是已经完成的历史结果'}});");
  await waitFor("runs.size===0&&currentConv.turns[0].assistant.includes('历史结果')");
  const transcript = path.join(out, 'expired-native-fixture.jsonl'); fs.writeFileSync(transcript, 'synthetic transcript'); fs.unlinkSync(transcript);
  await act("$('input').value='继续之前的任务';$('btnSend').click();"); await waitFor('recoveryFixture.launches.length===2&&runs.size===1');
  await check('existingConversationResumesNativeSessionBeforeExpiryIsDetected', "recoveryFixture.launches[1][1]==='expired-native-fixture'");
  await act("handleClaudeEvent({jobId:uiFixture.runId,type:'stderr',text:'No conversation found with session ID: expired-native-fixture'});handleClaudeEvent({jobId:uiFixture.runId,type:'job-done',exitCode:1});");
  await waitFor('recoveryFixture.launches.length===3&&runs.size===1');
  await check('recoveryStartsWithoutResumeAndCarriesPreviousConversation', "recoveryFixture.launches[2][1]===null&&recoveryFixture.launches[2][0].includes('保留这条历史信息')&&recoveryFixture.launches[2][0].includes('这是已经完成的历史结果')&&recoveryFixture.launches[2][0].includes('继续之前的任务')");
  await check('sameRelayHistoryAndProjectIdentityRemain', "currentConv.id===recoveryFixture.id&&currentConv.turns.length===2&&currentConv.turns[0].assistant==='这是已经完成的历史结果'&&recoveryFixture.drops.includes(recoveryFixture.id)");
  await act("handleClaudeEvent({jobId:uiFixture.runId,type:'system',subtype:'init',session_id:'replacement-native-fixture'});handleClaudeEvent({jobId:uiFixture.runId,type:'job-done',exitCode:0,finalResult:{type:'result',subtype:'success',result:'已使用保留的历史继续完成'}});");
  await waitFor("runs.size===0&&currentConv.turns[1].assistant.includes('继续完成')");
  await check('replacementSessionIsPersistedAndNoDuplicateFailedTurnRemains', "currentConv.sessionId==='replacement-native-fixture'&&currentConv.turns.length===2&&uiFixture.errors.length===0");
  save(); clearTimeout(timer); app.exit(0);
}).catch(error => { failures.push(error.stack || String(error)); save(); console.error(error); clearTimeout(timer); app.exit(1); });
