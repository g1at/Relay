'use strict';

// Run with Electron. Only these renderer functions are loaded; all read/write APIs
// are in-memory fixtures and neither the Relay main process nor tasks are started.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, '.codex-tmp', 'settings-detail-smoke');
const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
const functionNames = [
  'setSettingsBackAction', 'preserveSettingsView', 'restoreSettingsView',
  'backToSettings', 'memoryMarkdownBody', 'renderManagedMarkdownEditor',
  'getMemoryPageHost', 'renderMemoryEditor', 'escapeHtml',
];
const functions = functionNames.map((name) => {
  const matcher = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const match = matcher.exec(source);
  if (!match) throw new Error(`Renderer function not found: ${name}`);
  const end = source.indexOf('\n}', match.index);
  if (end < 0) throw new Error(`Renderer function end not found: ${name}`);
  return source.slice(match.index, end + 2);
}).join('\n');
fs.mkdirSync(outputDir, { recursive: true });
app.setPath('userData', path.join(outputDir, 'profile'));
app.commandLine.appendSwitch('disable-gpu');
const timeout = setTimeout(() => app.exit(2), 20000);

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: /^https?:/i.test(details.url) });
  });
  const win = new BrowserWindow({
    width: 800, height: 700, show: false,
    webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>.hidden{display:none!important}.modal-footer{display:flex}</style><main id="settingsModal"><div id="settingsBody"></div><footer class="modal-footer"><button id="btnSettingsBack">返回</button><span id="settingsHint"></span><button id="btnSettingsCancel">取消</button><button id="btnSettingsSave">保存</button></footer></main></html>',
  ));
  await win.webContents.executeJavaScript(`
    window.$ = id => document.getElementById(id);
    window.modalBody = $('settingsBody');
    window.modalHint = $('settingsHint');
    window.btnSettingsSaveEl = $('btnSettingsSave');
    window.btnSettingsBackEl = $('btnSettingsBack');
    window.settingsFooterEl = btnSettingsSaveEl.closest('.modal-footer');
    window.activeSaveHandler = null;
    window.activeSettingsBackHandler = null;
    window.settingsViewSnapshot = null;
    window.lastSettingsCat = 'memory';
    // This focused harness verifies preserving an explicitly supplied footer
    // snapshot. Category footer policy is covered by the full renderer fixture.
    window.updateMainSettingsFooter = () => {};
    window.fixture = { toasts: [], writes: [], mainCalls: 0 };
    window.showToast = text => fixture.toasts.push(text);
    window.renderMarkdown = text => escapeHtml(text);
    window.escapeAttr = text => escapeHtml(text);
    window.loadSettingsForm = () => { throw new Error('Unexpected form reload'); };
    window.api = {
      data: {
        readItem: (kind,key) => fixture.read(kind,key),
        writeItem: (kind,key,content) => fixture.write(kind,key,content),
        revealItem: async () => ({ ok:true }),
      },
      memory: {
        read: key => fixture.read('memory',key),
        write: (key,content) => fixture.write('memory',key,content),
        revealFile: async () => ({ ok:true }),
      },
    };
    void 0;
  `);
  await win.webContents.executeJavaScript(functions);
  const results = await win.webContents.executeJavaScript(`(async () => {
    const results = {};
    const check = (name, value) => { results[name] = !!value; if (!value) throw new Error(name); };
    const defer = () => { let resolve; const promise = new Promise(done => { resolve=done; }); return {promise,resolve}; };
    function resetMain(footerDisplay = 'none') {
      settingsViewSnapshot = null;
      $('settingsModal').classList.remove('hidden');
      modalBody.innerHTML = '<div class="set-layout"><nav class="set-nav">设置导航</nav><div class="set-content" id="setContent"><input id="set-brandName" value="主表单未保存内容"><section class="set-cat active" data-cat="memory"><div id="memorySection"><div data-list>合成记忆列表</div></div></section></div></div>';
      fixture.mainInput = $('set-brandName');
      fixture.mainInput.addEventListener('input', () => { fixture.mainCalls++; });
      fixture.mainSave = async () => { fixture.mainCalls++; };
      fixture.mainBack = () => { fixture.mainCalls++; };
      activeSaveHandler = fixture.mainSave;
      setSettingsBackAction(fixture.mainBack);
      settingsFooterEl.style.display = footerDisplay;
      btnSettingsSaveEl.style.display = footerDisplay === 'none' ? 'none' : '';
      modalHint.textContent = '主表单草稿提示';
      fixture.read = async () => ({ ok:true,content:'# 合成详情内容' });
      fixture.write = async (kind,key,content) => { fixture.writes.push({kind,key,content});return {ok:true}; };
    }
    const editors = [
      ['agent', () => renderManagedMarkdownEditor('agent','synthetic-agent.md','合成 Agent')],
    ];
    for (const [kind, open] of editors) {
      resetMain();
      await open();
      check(kind+'DetailRestoresFooter',getComputedStyle(settingsFooterEl).display!=='none'&&btnSettingsBackEl.style.display!=='none');
      $('memViewToggle').click();
      check(kind+'EditSaveIsVisible',btnSettingsSaveEl.style.display!=='none'&&getComputedStyle(settingsFooterEl).display!=='none');
      $('dpEditor').value = '仍未保存的详情草稿';
      restoreSettingsView();
      check(kind+'ReturnRestoresMainNodesAndFooter',$('set-brandName')===fixture.mainInput&&fixture.mainInput.value==='主表单未保存内容'&&settingsFooterEl.style.display==='none'&&activeSaveHandler===fixture.mainSave&&activeSettingsBackHandler===fixture.mainBack&&modalHint.textContent==='主表单草稿提示');
      const callsBefore = fixture.mainCalls;
      fixture.mainInput.dispatchEvent(new Event('input'));
      check(kind+'ReturnKeepsSingleListener',fixture.mainCalls===callsBefore+1);

      resetMain('');
      const read = defer();
      fixture.read = () => read.promise;
      const loading = open();
      restoreSettingsView();
      read.resolve({ok:true,content:'迟到的旧详情'});
      await loading;
      check(kind+'LateReadCannotReplaceMainHandlers',$('set-brandName')===fixture.mainInput&&activeSaveHandler===fixture.mainSave&&activeSettingsBackHandler===fixture.mainBack&&btnSettingsSaveEl.style.display===''&&settingsFooterEl.style.display===''&&modalHint.textContent==='主表单草稿提示');

      resetMain('');
      await open();
      $('memViewToggle').click();
      $('dpEditor').value = '合成保存内容';
      const write = defer();
      fixture.write = (type,key,content) => {fixture.writes.push({type,key,content});return write.promise;};
      const saving = activeSaveHandler();
      restoreSettingsView();
      const toastCount = fixture.toasts.length;
      write.resolve({ok:true});
      await saving;
      check(kind+'LateWriteCannotReplaceMainUI',$('set-brandName')===fixture.mainInput&&activeSaveHandler===fixture.mainSave&&activeSettingsBackHandler===fixture.mainBack&&btnSettingsSaveEl.style.display===''&&settingsFooterEl.style.display===''&&modalHint.textContent==='主表单草稿提示'&&fixture.toasts.length===toastCount);

      resetMain();
      const hiddenRead = defer();
      fixture.read = () => hiddenRead.promise;
      const hiddenLoading = open();
      const editor = $('dpEditor');
      $('settingsModal').classList.add('hidden');
      hiddenRead.resolve({ok:true,content:'隐藏页面仍应完成读取'});
      await hiddenLoading;
      $('settingsModal').classList.remove('hidden');
      check(kind+'HiddenPageStillCompletesRead',$('dpEditor')===editor&&editor.value==='隐藏页面仍应完成读取'&&typeof activeSaveHandler==='function'&&activeSaveHandler!==fixture.mainSave);
      $('memViewToggle').click();
      editor.value = '隐藏页面正在保存';
      const hiddenWrite = defer();
      fixture.write = () => hiddenWrite.promise;
      const hiddenSaving = activeSaveHandler();
      $('settingsModal').classList.add('hidden');
      hiddenWrite.resolve({ok:true});
      await hiddenSaving;
      $('settingsModal').classList.remove('hidden');
      check(kind+'HiddenPageStillCompletesSave',$('dpEditor')===editor&&modalHint.textContent==='✓ 已保存'&&$('dpMemorySource').classList.contains('hidden'));
    }
    resetMain();
    await renderManagedMarkdownEditor('archivedSkill','synthetic-skill','归档技能');
    check('archivedSkillKeepsReadOnlyFooter',getComputedStyle(settingsFooterEl).display!=='none'&&!$('memViewToggle')&&btnSettingsSaveEl.style.display==='none'&&activeSaveHandler===null);
    resetMain();
    await renderMemoryEditor('MEMORY.md','记忆索引');
    check('memoryIndexKeepsReadOnlyLocalActions',getComputedStyle(settingsFooterEl).display==='none'&&!$('memViewToggle')&&$('dpEditor').readOnly&&!document.querySelector('[data-memory-save]')&&activeSaveHandler===fixture.mainSave&&!settingsViewSnapshot&&document.querySelector('[data-memory-back]'));
    resetMain();
    await renderMemoryEditor('synthetic-memory.md','合成记忆');
    check('memoryDetailKeepsTheMainFormAndNavigation',$('set-brandName')===fixture.mainInput&&document.querySelector('.set-nav')&&settingsViewSnapshot===null&&activeSaveHandler===fixture.mainSave&&activeSettingsBackHandler===fixture.mainBack&&getComputedStyle(settingsFooterEl).display==='none');
    $('memViewToggle').click();
    $('dpEditor').value='返回后仍保留的记忆草稿';$('dpEditor').dispatchEvent(new Event('input'));
    check('memoryEditingUsesLocalSaveActions',!document.querySelector('[data-memory-save]').hidden&&getComputedStyle(settingsFooterEl).display==='none');
    document.querySelector('[data-memory-back]').click();
    check('memoryBackOnlyRestoresTheList',$('set-brandName')===fixture.mainInput&&!document.querySelector('.memory-list-page').hidden&&document.querySelector('.memory-detail').hidden&&activeSaveHandler===fixture.mainSave&&modalHint.textContent==='主表单草稿提示');
    await renderMemoryEditor('synthetic-memory.md','合成记忆');
    check('memoryReopeningRetainsTheUnsavedDraft',$('dpEditor').value==='返回后仍保留的记忆草稿'&&!$('dpMemorySource').classList.contains('hidden'));
    document.querySelector('[data-memory-cancel]').click();
    check('memoryCancelRestoresTheSavedDocument',$('dpEditor').value==='# 合成详情内容'&&$('dpMemorySource').classList.contains('hidden'));
    resetMain();
    const memoryRead=defer();fixture.read=()=>memoryRead.promise;
    const reading=renderMemoryEditor('late-memory.md','旧记忆');
    document.querySelector('[data-memory-back]').click();
    fixture.read=async()=>({ok:true,content:'新的记忆正文'});
    await renderMemoryEditor('current-memory.md','当前记忆');
    memoryRead.resolve({ok:true,content:'迟到的记忆正文'});await reading;
    check('memoryLateReadCannotReplaceAnotherDocument',$('dpEditor').value==='新的记忆正文'&&$('set-brandName')===fixture.mainInput&&activeSaveHandler===fixture.mainSave&&modalHint.textContent==='主表单草稿提示');
    $('memViewToggle').click();$('dpEditor').value='异步保存的记忆';$('dpEditor').dispatchEvent(new Event('input'));
    const memoryWrite=defer();fixture.write=()=>memoryWrite.promise;
    document.querySelector('[data-memory-save]').click();
    document.querySelector('[data-memory-back]').click();
    await renderMemoryEditor('unrelated-memory.md','另一条记忆');
    memoryWrite.resolve({ok:true});await Promise.resolve();await Promise.resolve();
    check('memoryLateSaveDoesNotTouchTheNewDocumentOrGlobalFooter',$('dpEditor').value==='新的记忆正文'&&activeSaveHandler===fixture.mainSave&&activeSettingsBackHandler===fixture.mainBack&&modalHint.textContent==='主表单草稿提示'&&getComputedStyle(settingsFooterEl).display==='none');
    resetMain();
    const memoryHiddenRead=defer();fixture.read=()=>memoryHiddenRead.promise;
    const hiddenReading=renderMemoryEditor('hidden-memory.md','隐藏的记忆');
    $('settingsModal').classList.add('hidden');memoryHiddenRead.resolve({ok:true,content:'隐藏时读取完成'});await hiddenReading;
    $('settingsModal').classList.remove('hidden');
    check('memoryHiddenPageStillCompletesItsOwnRead',$('dpEditor').value==='隐藏时读取完成'&&activeSaveHandler===fixture.mainSave);
    $('memViewToggle').click();$('dpEditor').value='隐藏时保存完成';$('dpEditor').dispatchEvent(new Event('input'));
    const memoryHiddenWrite=defer();fixture.write=()=>memoryHiddenWrite.promise;
    document.querySelector('[data-memory-save]').click();$('settingsModal').classList.add('hidden');
    memoryHiddenWrite.resolve({ok:true});await Promise.resolve();await Promise.resolve();$('settingsModal').classList.remove('hidden');
    check('memoryHiddenPageStillCompletesItsOwnSave',$('dpMemorySource').classList.contains('hidden')&&document.querySelector('[data-memory-status]').textContent==='已保存'&&modalHint.textContent==='主表单草稿提示');
    return results;
  })()`);
  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  console.error(error.stack || error);
  clearTimeout(timeout);
  app.exit(1);
});
