'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.codex-tmp/settings-retirement-sdk-ui'); fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile')); app.commandLine.appendSwitch('disable-gpu');
const report = { scope: 'actual Relay renderer; isolated profile; mocked UI APIs; network blocked', checks: [], errors: [] }; let win;
const timer = setTimeout(() => { report.errors.push('timeout'); done(); }, 90000);
const evaluate = code => win.webContents.executeJavaScript(code);
function done() { clearTimeout(timer); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); win?.destroy(); app.exit(report.ok ? 0 : 1); }
async function waitFor(expression) { await evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;const poll=()=>{if(${expression})return resolve();if(Date.now()>end)return reject(Error(${JSON.stringify(expression)}));setTimeout(poll,30);};poll();})`); }
async function check(label, expression) { if (!await evaluate(expression)) throw Error(label); report.checks.push(label); }
async function layout() { await evaluate('document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function checkNavigation(width) {
  const geometry = await evaluate(`(()=>{const rows=[...document.querySelectorAll('#setNav .set-nav-item')].map(node=>({category:node.dataset.cat,top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom,left:node.getBoundingClientRect().left}));return {rows,gaps:rows.slice(1).map((row,index)=>row.top-rows[index].bottom)};})()`);
  report.navigation = report.navigation || {}; report.navigation[width] = geometry;
  if (geometry.rows.length !== 9 || !geometry.gaps.every(gap => gap >= 2 && gap <= 4)
      || geometry.rows.some(row => Math.abs(row.left - geometry.rows[0].left) > 1)) throw Error('Settings navigation must have nine adjacent rows at width ' + width + ': ' + JSON.stringify(geometry));
  report.checks.push('all nine settings menus have the same compact row spacing: ' + width);
}
const seed = `(() => {
const base = window.api; const state = window.mediumFixture = { changes: [], historyCalls: [], pluginCalls: [], flags: [], diagnosticsCalls: 0,
 saved: { sdkSettingSources:'local',sdkTrustedProjectIds:['fixture-project'],sdkRuntimePreferences: { thinking: 'adaptive', thinkingBudget: 8192, thinkingDisplay: 'omitted', skillBudget: 'compact', outputBudget: 'expanded', skills: ['legacy-skill'], skillOverrides: { 'legacy-skill': 'on' }, autoCompactWindow: 24000, forwardSubagentText: true, switchModelsOnFlag: 'disabled', customSystemPrompt: { static: ['fixture legacy prompt'], dynamic: [] } } } };
state.originalLegacy = structuredClone(state.saved.sdkRuntimePreferences);
let item = { id: 'fixture-plugin', name: 'fixture', description: '标准 SDK 插件', path: 'D:/fixture', enabled: false, options: { label: '原值' }, fields: { label: { type: 'string', title: '显示名称', description: '普通配置' }, secret: { type: 'string', title: '凭据', description: '安全存储', sensitive: true } } };
window.api = new Proxy(base, { get(target, key) {
 if (key === 'settings') return { read: async () => { const original=await target.settings.read();return { ...original, app:{...original.app,...state.saved}, info: { uiVersion: 'fixture' } }; },write: async patch => {state.changes.push(structuredClone(patch));state.saved={...state.saved,...patch.app};return{ok:true};} };
 if (key === 'generalPreferences') return { get:async()=>({ok:true,preferences:state.saved,capabilities:{},projectContext:{id:'fixture-project',name:'示例项目'}}), diagnostics:async()=>{state.diagnosticsCalls++;return{ok:true,sources:[]};},applyRuntimeFlags:async()=>({ok:true}) };
 if (key === 'history') return new Proxy(target.history,{get(object,name){return name==='native'?input=>state.nativeApi[input.operation](input.sessionId):object[name];}});
 if (key === 'sdkPlugins') return { list: async () => ({ ok: true, items: item ? [item] : [] }), add: async () => ({ canceled: true }), update: async (id, patch) => { state.pluginCalls.push({id,patch}); Object.assign(item,patch); return {ok:true}; }, remove: async id => { state.pluginCalls.push({id,remove:true}); item=null;return{ok:true}; } };
 return target[key];
} });
state.nativeApi = { list: async () => { state.historyCalls.push('list'); return { ok: true, items: [{sessionId:'native',title:'原生样例'}],nextOffset:null }; }, inspect:async()=>({ok:true,message:'已核验'}), repair:async()=>({ok:true,added:1,repaired:0}), rename:async()=>({ok:true}), import:async id=>{state.historyCalls.push('import:'+id);return {ok:true};}, deleteNative:async()=>{state.historyCalls.push('delete');return {ok:true};} };
})();`;
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/i.test(details.url) }));
  const fixture = fs.readFileSync(path.join(root, 'test/ui-api-fixture.js'), 'utf8');
  const page = path.join(out, 'fixture.html'); fs.writeFileSync(page, fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(path.join(root, 'renderer') + path.sep).href + '"><script>' + fixture + seed + '</script>'));
  win = new BrowserWindow({ width: 1200, height: 850, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); await win.loadFile(page);win.showInactive();
  await waitFor('providerRoutingLoaded&&!restoringTaskLifecycle'); await evaluate(`openSettings('general')`); await waitFor('settingsFormLoaded');
  await check('General contains no SDK configuration form or eager diagnostic work', '!document.querySelector(".set-cat[data-cat=general] [data-sdk-preference]")&&mediumFixture.diagnosticsCalls===0&&mediumFixture.historyCalls.length===0');
  await evaluate(`openSettings('conversation')`); await waitFor('!!document.querySelector("[data-sdk-preference=autoCompact]")');
  await layout(); await checkNavigation(1200);
  await check('Advanced is removed and tool rules are the last conversation settings section', '!document.querySelector(".set-nav-item[data-cat=advanced],.set-cat[data-cat=advanced]")&&document.getElementById("toolRulesPreferencesSection").parentElement.dataset.cat==="conversation"&&document.getElementById("toolRulesPreferencesSection").parentElement.lastElementChild.id==="toolRulesPreferencesSection"&&document.querySelector("[data-sdk-group=tool-rules]").parentElement.id==="toolRulesPreferencesSection"');
  await evaluate('mediumFixture.toolRuleNodes=["allowedTools","disallowedTools","disableSkillShellExecution"].map(key=>document.querySelector("[data-sdk-setting="+key+"]")||document.querySelector("[data-sdk-preference="+key+"] textarea"));');
  fs.writeFileSync(path.join(out, 'settings-navigation-compact.png'), (await win.webContents.capturePage()).toPNG());
  await check('context controls belong to conversation settings and low-level thinking controls are removed', 'document.querySelector("[data-sdk-preference=autoCompact]").closest(".set-cat").dataset.cat==="conversation"&&!document.querySelector("[data-sdk-preference=thinking]")');
  await check('inheritance is labelled automatic with accessible setting-specific explanations', '(()=>{return ["autoCompact","showThinkingSummaries"].every(key=>{const row=document.querySelector("[data-sdk-preference="+key+"]"),trigger=row.querySelector(".cs-trigger"),note=row.querySelector(".rgp-label p");return trigger.querySelector(".cs-text").textContent==="自动"&&trigger.getAttribute("aria-describedby")===note.id&&note.textContent.includes("默认")&&!row.textContent.includes("模型默认");});})()');
  await check('thinking summaries describe an API request rather than a reasoning switch', 'document.querySelector("[data-sdk-preference=showThinkingSummaries] .rgp-label label").textContent==="请求思考摘要"&&document.querySelector("[data-sdk-group=summaries] .sdk-settings-note").textContent.includes("不改变推理强度")&&document.querySelector("[data-sdk-group=summaries] .sdk-settings-note").textContent.includes("需服务商支持")');
  for (const [key, descriptions] of [
    ['autoCompact', { enabled: '开启自动压缩', disabled: '关闭自动压缩', inherit: '使用默认压缩策略' }],
    ['showThinkingSummaries', { enabled: '请求服务商提供思考摘要', disabled: '模型仍可进行推理', inherit: '使用默认摘要策略' }],
  ]) for (const [value, description] of Object.entries(descriptions)) {
    await evaluate(`document.querySelector('[data-sdk-preference=${key}] .cs-trigger').click();document.querySelector('[data-sdk-preference=${key}] [data-value=${value}]').click()`);
    const timing = value === 'inherit' ? '下次启动会话时生效' : '保存后尝试应用于当前对话';
    await check('selection explains behavior and application timing without changing legacy values: ' + key + ' ' + value, `document.querySelector('[data-sdk-preference=${key}] .rgp-label p').textContent.includes(${JSON.stringify(description)})&&document.querySelector('[data-sdk-preference=${key}] .rgp-label p').textContent.includes(${JSON.stringify(timing)})&&generalPreferencesView.getPatch().sdkRuntimePreferences[${JSON.stringify(key)}]===${JSON.stringify(value)}&&mediumFixture.changes.length===0&&Object.entries(mediumFixture.originalLegacy).every(([key,value])=>JSON.stringify(generalPreferencesView.getPatch().sdkRuntimePreferences[key])===JSON.stringify(value))`);
  }
  await evaluate('document.querySelector("[data-sdk-preference=autoCompact] .cs-trigger").click();document.querySelector("[data-sdk-preference=autoCompact] [data-value=enabled]").click()');
  await check('context preference changes are retained as drafts without persisting unrelated legacy values', 'generalPreferencesView.getPatch().sdkRuntimePreferences.autoCompact==="enabled"&&mediumFixture.changes.length===0&&Object.entries(mediumFixture.originalLegacy).every(([key,value])=>JSON.stringify(generalPreferencesView.getPatch().sdkRuntimePreferences[key])===JSON.stringify(value))');
  await evaluate('for(const [key,value] of [["allowedTools","Read\\nGlob"],["disallowedTools","Bash"]]){const field=document.querySelector("[data-sdk-preference="+key+"] textarea");field.value=value;field.dispatchEvent(new Event("input",{bubbles:true}));}document.querySelector("[data-sdk-setting=disableSkillShellExecution]").click();');
  for (const alias of ['advanced', 'maintenance']) {
    await evaluate(`openSettings(${JSON.stringify(alias)})`);
    await check('old settings alias keeps the same tool-rule draft in conversation: ' + alias, 'lastSettingsCat==="conversation"&&document.querySelector(".set-cat.active").dataset.cat==="conversation"&&mediumFixture.toolRuleNodes.every(node=>node.isConnected)&&generalPreferencesView.getPatch().sdkRuntimePreferences.allowedTools.join(",")==="Read,Glob"&&generalPreferencesView.getPatch().sdkRuntimePreferences.disallowedTools[0]==="Bash"&&generalPreferencesView.getPatch().sdkRuntimePreferences.disableSkillShellExecution===true&&mediumFixture.changes.length===0');
  }
  await check('project instructions, worktree, model turn cap and diagnostics have no settings entry', '!document.querySelector("[data-sdk-preference=maxTurns],[data-sdk-group=project-tools],[data-sdk-group=diagnostics],[data-sdk-preference=diagnostics],[data-general-row=sdkCleanupPeriodDays],.rgp-diagnostics,.rgp-history,[data-general-apply-runtime],[data-cat=maintenance]")');
  await evaluate(`openSettings('workspace')`);
  await check('workspace keeps environment controls without a removed project group', '!!document.querySelector(".set-cat[data-cat=workspace] [data-general-refresh]")&&!document.querySelector(".set-cat[data-cat=workspace] [data-sdk-preference]")');
  await evaluate('saveMainSettings()'); await waitFor('!settingsSaveBusy&&mediumFixture.changes.length===1');
  await check('one save persists all edited SDK groups while preserving every removed legacy field', 'mediumFixture.saved.sdkRuntimePreferences.autoCompact==="enabled"&&Object.entries(mediumFixture.originalLegacy).every(([key,value])=>JSON.stringify(mediumFixture.saved.sdkRuntimePreferences[key])===JSON.stringify(value))');
  await check('moved tool rules save with the unchanged preference keys and values', 'mediumFixture.saved.sdkRuntimePreferences.allowedTools.join(",")==="Read,Glob"&&mediumFixture.saved.sdkRuntimePreferences.disallowedTools[0]==="Bash"&&mediumFixture.saved.sdkRuntimePreferences.disableSkillShellExecution===true');
  await evaluate(`openSettings('advanced')`);
  await check('project settings controls are removed and unrelated saves retain their persisted values', '!document.querySelector("[data-general-row=sdkSettingSources],[data-general-row=sdkTrustedProjectIds],[data-sdk-preference=projectMcpApprovals]")&&mediumFixture.saved.sdkSettingSources==="local"&&mediumFixture.saved.sdkTrustedProjectIds[0]==="fixture-project"&&!Object.hasOwn(mediumFixture.changes[0].app,"sdkSettingSources")&&!Object.hasOwn(mediumFixture.changes[0].app,"sdkTrustedProjectIds")');
  await check('tool rule inputs use the shared Relay input style within conversation settings', '(()=>{const fields=[...document.querySelectorAll(".set-cat[data-cat=conversation] [data-sdk-group=tool-rules] textarea")];return fields.length===2&&fields.every(field=>field.classList.contains("provider-edit-inline-input")&&getComputedStyle(field).borderRadius==="8px");})()');
  await check('conversation tool rules do not include diagnostics or maintenance operations', '!document.querySelector("#toolRulesPreferencesSection .rgp-diagnostics,#toolRulesPreferencesSection .rgp-history,#toolRulesPreferencesSection [data-sdk-preference=diagnostics]")');
  await check('removed non-default preferences have a directly visible compatibility list', 'Object.keys(mediumFixture.originalLegacy).every(key=>document.querySelector("[data-sdk-compatibility="+key+"]"))&&!document.querySelector("[data-sdk-compatibility=customSystemPrompt]").textContent.includes("fixture legacy prompt")');
  await evaluate('document.querySelector("[data-sdk-reset=thinking]").click()');
  await check('resetting one compatibility override changes only that key and remains unsaved', 'generalPreferencesView.getPatch().sdkRuntimePreferences.thinking==="inherit"&&mediumFixture.saved.sdkRuntimePreferences.thinking==="adaptive"&&Object.entries(mediumFixture.originalLegacy).filter(([key])=>key!=="thinking").every(([key,value])=>JSON.stringify(generalPreferencesView.getPatch().sdkRuntimePreferences[key])===JSON.stringify(value))');
  await evaluate('saveMainSettings()');await waitFor('!settingsSaveBusy&&mediumFixture.changes.length===2');
  await check('compatibility reset persists without removing sibling overrides', 'mediumFixture.saved.sdkRuntimePreferences.thinking==="inherit"&&mediumFixture.saved.sdkRuntimePreferences.customSystemPrompt.static[0]==="fixture legacy prompt"&&mediumFixture.saved.sdkRuntimePreferences.skillBudget==="compact"');
  await evaluate('document.querySelector("[data-sdk-reset=skillBudget]").click()');
  await evaluate('const input=document.querySelector("[data-sdk-preference=allowedTools] textarea");input.value="Edit";input.dispatchEvent(new Event("input",{bubbles:true}));');
  await check('compatibility reset remains a draft until saving', 'generalPreferencesView.getPatch().sdkRuntimePreferences.skillBudget==="inherit"&&mediumFixture.saved.sdkRuntimePreferences.skillBudget==="compact"');
  await evaluate(`openSettings('workspace')`); await evaluate('document.getElementById("btnSettingsCancel").click()'); await waitFor('settingsFormLoaded&&Object.keys(generalPreferencesView.getPatch()).length===0');
  await evaluate(`openSettings('advanced')`);
  await check('cancel across settings menus preserves saved compatibility values', 'mediumFixture.saved.sdkRuntimePreferences.skillBudget==="compact"&&mediumFixture.saved.sdkRuntimePreferences.customSystemPrompt.static[0]==="fixture legacy prompt"&&!!document.querySelector("[data-sdk-reset=skillBudget]")&&mediumFixture.changes.length===2');
  await check('cancel restores moved tool rule inputs from saved values', 'document.querySelector("[data-sdk-preference=allowedTools] textarea").value==="Read\\nGlob"&&document.querySelector("[data-sdk-preference=disallowedTools] textarea").value==="Bash"&&document.querySelector("[data-sdk-setting=disableSkillShellExecution]").getAttribute("aria-checked")==="true"');
  for(const category of ['general','conversation','workspace','memory']) {
    await evaluate(`openSettings(${JSON.stringify(category)})`);await evaluate('document.getElementById("setContent").scrollTop=0;document.getAnimations().forEach(a=>{if(a.effect?.getComputedTiming().iterations!==Infinity)try{a.finish()}catch(_){}});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await new Promise(resolve=>setTimeout(resolve,240));
    await check('settings page has no horizontal overflow: '+category, '(()=>{const area=document.getElementById("setContent");return area.scrollWidth<=area.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;})()');
    await check('settings groups render directly with no disclosure: '+category, '(()=>{const page=document.querySelector(".set-cat.active");return !page.querySelector("details,summary,.sdk-settings-disclosure,.rgp-disclosure,.sdk-settings-body[inert]")&&[...page.querySelectorAll(".rgp-section,.sdk-settings-group,.sdk-history-controls")].filter(node=>!node.hidden).every(node=>node.getClientRects().length>0&&!node.closest("[inert]"));})()');
    if(['workspace','conversation'].includes(category)) fs.writeFileSync(path.join(out, 'retirement-settings-'+category+'.png'), (await win.webContents.capturePage()).toPNG());
  }
  for(const [category,theme,width,height] of [['conversation','light',1200,850],['conversation','dark',780,720],['workspace','light',780,720]]) {
    win.setSize(width,height);await evaluate(`openSettings(${JSON.stringify(category)});document.documentElement.dataset.theme=${JSON.stringify(theme)};document.getElementById("setContent").scrollTop=0`);
    await new Promise(resolve=>setTimeout(resolve,240));
    await layout(); await checkNavigation(width);
    await check('settings fit theme and compact window: '+category+' '+width,'(()=>{const area=document.getElementById("setContent");return area.scrollWidth<=area.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;})()');
    if (category === 'conversation') {
      await check('tool rules keep separation from scheduled tasks: '+width, '(()=>{const mount=document.getElementById("toolRulesPreferencesSection"),panel=mount.previousElementSibling;return mount.getBoundingClientRect().top-panel.getBoundingClientRect().bottom>=18;})()');
      await evaluate('document.querySelector("[data-sdk-group=tool-rules]").scrollIntoView({block:"start"})'); await layout();
      await check('tool rule fields fit inside the content column: '+width, '(()=>{const bounds=document.getElementById("setContent").getBoundingClientRect();return [...document.querySelectorAll("[data-sdk-group=tool-rules] textarea")].every(field=>{const rect=field.getBoundingClientRect();return rect.width>100&&rect.left>=bounds.left&&rect.right<=bounds.right;});})()');
    }
    fs.writeFileSync(path.join(out,'retirement-settings-'+category+'-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  win.setSize(1200,850);await evaluate('document.documentElement.dataset.theme="light"');
  await check('removed settings never read diagnostic details or scan native history', 'mediumFixture.historyCalls.length===0&&mediumFixture.diagnosticsCalls===0&&!document.querySelector("[data-sdk-history-action],[data-general-context-details],[data-general-apply-runtime]")');
  await evaluate('closeSettings(true);openPlugins("package")'); await waitFor('activeView==="plugins"&&!!document.querySelector(".sdk-plugin-item")');await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await check('plugin manager is visibly above the settings page', 'document.elementFromPoint(document.querySelector(".sdk-plugin-item").getBoundingClientRect().x+30,document.querySelector(".sdk-plugin-item").getBoundingClientRect().y+30)?.closest(".sdk-plugin-item") instanceof HTMLElement');
  await check('standard plugin appears beside existing resource categories', '!!document.querySelector("#pluginsTab-skill")&&!!document.querySelector("#pluginsTab-agent")&&!!document.querySelector("#pluginsTab-mcp")&&!!document.querySelector("#pluginsTab-package")');
  await evaluate('document.querySelector(".sdk-plugin-item [role=switch]").click()'); await waitFor('mediumFixture.pluginCalls.length===1');
  await check('plugin toggle persists only the selected plugin', 'mediumFixture.pluginCalls[0].id==="fixture-plugin"&&mediumFixture.pluginCalls[0].patch.enabled===true');
  await evaluate('document.querySelector(".sdk-plugin-config").open=true');
  await check('sensitive plugin config has no ordinary editable input', 'document.querySelector(".sdk-plugin-secret").textContent.includes("安全存储")&&!document.querySelector("input[aria-label=凭据]")');
  await evaluate('const field=document.querySelector("input[aria-label=显示名称]");field.value="新值";[...document.querySelectorAll(".sdk-plugin-config button")].find(x=>x.textContent==="保存配置").click()'); await waitFor('mediumFixture.pluginCalls.length===2');
  await check('schema form saves non-sensitive options without injecting a secret key', 'mediumFixture.pluginCalls[1].patch.options.label==="新值"&&!Object.hasOwn(mediumFixture.pluginCalls[1].patch.options,"secret")');
  await evaluate('document.querySelector(".sdk-plugin-config").open=true');await new Promise(resolve=>setTimeout(resolve,300));
  fs.writeFileSync(path.join(out, 'standard-plugin.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(860,740); await new Promise(resolve=>setTimeout(resolve,150)); await check('plugin UI adapts to a compact window', 'document.querySelector(".sdk-plugin-item").getBoundingClientRect().right<=innerWidth');
  await check('no renderer exceptions or model calls', 'uiFixture.errors.length===0&&!uiFixture.calls.includes("runClaude")'); report.ok = true;
}).catch(async error => { report.ok = false; report.errors.push(error.stack || String(error)); if (win) report.domError = await evaluate('document.querySelector(".settings-load-error")?.innerText || uiFixture.errors.join(";")'); console.error(error); }).finally(done);
