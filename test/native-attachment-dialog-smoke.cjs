'use strict';

// Real Windows Electron, BrowserWindow, production preload and IPC registration.
// System dialog responses are synthetic: no real system modal is opened and
// no pointer or keyboard input is sent. Appearance and latency are not covered.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerNativeAttachmentDialog, CHANNEL } = require('../src/main/app/native-attachment-dialog');

const out = path.resolve(__dirname, '../.codex-tmp/electron-attachment-validation');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'profile'));
app.commandLine.appendSwitch('disable-gpu');

const checks = {}, errors = [], calls = [], responses = [];
let window, registration, lastMainCompletion, step = 'starting';
const evidence = {
  runtime: 'Windows Electron with hidden BrowserWindow, production preload and real ipcMain',
  dialogResults: 'Synthetic controlled showOpenDialog responses',
  systemDialogShown: false,
  systemDialogPointerTested: false,
  systemDialogLatencyMeasured: false,
};
function save() {
  fs.writeFileSync(path.join(out, 'native-result.json'), JSON.stringify({
    step, checks, errors, evidence,
    dialogCalls: calls.map(({ settings }) => settings),
    limitations: ['No real system dialog was opened or clicked; native appearance and opening latency are not covered.'],
  }, null, 2));
}
function check(name, condition) {
  step = name;
  checks[name] = !!condition;
  save();
  console.log(name + ': ' + checks[name]);
  if (!checks[name]) throw new Error(name);
}
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
function nextResponse(value) { responses.push(() => Promise.resolve(value)); }
function invoke(input) {
  const argument = input === undefined ? 'undefined' : JSON.stringify(input);
  return window.webContents.executeJavaScript(`window.api.openAttachmentDialog(${argument}).then(
    items => ({ ok: true, items }), error => ({ ok: false, error: String(error.message || error) })
  )`);
}
function dispose() {
  registration?.dispose();
  registration = null;
  if (window && !window.isDestroyed()) window.destroy();
}
const timer = setTimeout(() => {
  errors.push('Timeout: ' + step);
  dispose();
  save();
  app.exit(1);
}, 45000);

app.whenReady().then(async () => {
  check('runsOnWindows', process.platform === 'win32');
  check('electronExposesStandardOpenDialogAPI', typeof dialog.showOpenDialog === 'function');
  const location = path.join(out, "合成附件 '中文' $资料");
  fs.mkdirSync(location, { recursive: true });
  const firstFile = path.join(location, 'sample 中文.txt');
  const secondFile = path.join(location, 'other.MD');
  fs.writeFileSync(firstFile, 'Synthetic attachment fixture.');
  fs.writeFileSync(secondFile, '# Synthetic second attachment');
  const page = path.join(out, 'fixture.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>Relay attachment IPC fixture</title><p>Synthetic attachment IPC fixture</p>');
  window = new BrowserWindow({
    width: 640, height: 480, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.resolve(__dirname, '../preload.js'),
    },
  });
  window.webContents.on('preload-error', (_event, _path, error) => errors.push('Preload: ' + error.message));
  await window.loadFile(page);
  check('productionPreloadExposesAttachmentIPC', await window.webContents.executeJavaScript('typeof window.api.openAttachmentDialog === "function"'));
  check('fixtureWindowRemainsHidden', !window.isVisible());
  registration = registerNativeAttachmentDialog({
    // The wrapper observes settlement only; real ipcMain still creates and
    // authenticates every sender event received from the production preload.
    ipcMain: {
      handle(name, handler) {
        ipcMain.handle(name, async (...args) => {
          const completion = deferred();
          lastMainCompletion = completion.promise;
          try {
            const items = await handler(...args);
            completion.resolve({ ok: true, items });
            return items;
          } catch (error) {
            completion.resolve({ ok: false, code: error.code, error: error.message });
            throw error;
          }
        });
      },
      removeHandler: name => ipcMain.removeHandler(name),
    },
    getWindow: () => window,
    rendererURL: pathToFileURL(page).href,
    dialog: {
      showOpenDialog(owner, settings) {
        calls.push({ owner, settings });
        const response = responses.shift();
        if (!response) throw new Error('Unexpected synthetic dialog invocation');
        return response();
      },
    },
  });

  nextResponse({ canceled: false, filePaths: [firstFile, secondFile] });
  let result = await invoke();
  check('defaultEntryRequestsStandardFileMultiSelect', calls.length === 1 && calls[0].settings.properties.includes('openFile') && calls[0].settings.properties.includes('multiSelections') && !calls[0].settings.properties.includes('openDirectory'));
  check('dialogReceivesActualParentBrowserWindow', calls[0].owner === window);
  check('syntheticMultiFileResultGetsRealMetadata', result.ok && result.items.length === 2 && result.items[0].path === fs.realpathSync(firstFile) && result.items[0].size === fs.statSync(firstFile).size && !result.items[0].isDirectory && result.items[1].ext === 'md');

  nextResponse({ canceled: false, filePaths: [location] });
  result = await invoke({ kind: 'folders', defaultPath: location });
  const folderCall = calls.at(-1);
  check('folderEntryDirectlyRequestsStandardDirectoryDialog', folderCall.settings.properties.includes('openDirectory') && !folderCall.settings.properties.includes('openFile'));
  check('unicodeDefaultPathStaysAnAPIOption', folderCall.settings.defaultPath === location);
  check('syntheticDirectoryResultGetsRealDirectoryMetadata', result.ok && result.items.length === 1 && result.items[0].path === fs.realpathSync(location) && result.items[0].isDirectory === true && result.items[0].ext === 'folder' && result.items[0].size === 0);

  nextResponse({ canceled: true, filePaths: [path.join(location, 'must-not-be-statted')] });
  result = await invoke({ kind: 'files' });
  check('syntheticCancelReturnsEmptyWithoutReadingSelection', result.ok && result.items.length === 0);
  const callsBeforeInvalid = calls.length;
  result = await invoke({ kind: 'invalid' });
  check('invalidKindCannotOpenAStandardDialog', !result.ok && calls.length === callsBeforeInvalid);

  const entered = deferred(), selection = deferred();
  responses.push(() => { entered.resolve(); return selection.promise; });
  const firstPending = invoke({ kind: 'files' });
  await entered.promise;
  const callsBeforeSecond = calls.length;
  result = await invoke({ kind: 'folders' });
  check('concurrentInvocationCannotReplaceFirstSelection', !result.ok && calls.length === callsBeforeSecond);
  selection.resolve({ canceled: false, filePaths: [secondFile] });
  result = await firstPending;
  check('firstPendingSelectionRetainsItsResult', result.ok && result.items.length === 1 && result.items[0].path === fs.realpathSync(secondFile));

  responses.push(() => Promise.reject(new Error('Synthetic system dialog failure')));
  result = await invoke({ kind: 'files' });
  check('dialogFailureIsReportedThroughRealIPC', !result.ok && result.error.includes('Synthetic system dialog failure'));
  nextResponse({ canceled: false, filePaths: [firstFile] });
  result = await invoke({ kind: 'files' });
  check('dialogFailureReleasesTheInvocationGuard', result.ok && result.items.length === 1);
  nextResponse({ canceled: false, filePaths: [firstFile, path.join(location, 'deleted-before-stat')] });
  result = await invoke({ kind: 'files' });
  check('missingSelectionFailsWithoutPartialMetadata', !result.ok && !('items' in result));

  // Same webContents and preload, but an untrusted document URL. This exercises
  // the real Electron IPC event instead of manufacturing a sender in Node.
  const untrustedPage = path.join(out, 'untrusted.html');
  fs.writeFileSync(untrustedPage, '<!doctype html><meta charset="utf-8"><title>Untrusted fixture document</title>');
  await window.loadFile(untrustedPage);
  const callsBeforeUntrusted = calls.length;
  result = await invoke({ kind: 'files' });
  check('untrustedDocumentCannotInvokeNativeAttachmentIPC', !result.ok && calls.length === callsBeforeUntrusted);
  await window.loadFile(page);

  const lateEntered = deferred(), lateSelection = deferred();
  responses.push(() => { lateEntered.resolve(); return lateSelection.promise; });
  // A promise in a destroyed renderer context need not settle. Observe the
  // real main-process handler outcome instead of awaiting that old context.
  void invoke({ kind: 'files' }).catch(() => {});
  await lateEntered.promise;
  const latePending = lastMainCompletion;
  await window.loadFile(untrustedPage);
  lateSelection.resolve({ canceled: false, filePaths: [firstFile] });
  const lateResult = await latePending;
  check('navigationCannotDeliverLateAttachmentsToAnotherDocument', !lateResult.ok && lateResult.code === 'DIALOG_ABORTED');
  await window.loadFile(page);
  nextResponse({ canceled: true, filePaths: [] });
  result = await invoke({ kind: 'folders' });
  check('navigationCleanupAllowsTheOriginalPageToOpenAgain', result.ok && result.items.length === 0);
  check('systemDialogResponsesAllConsumed', responses.length === 0);
  check('fixtureHasNoPreloadErrors', errors.length === 0);

  registration.dispose();
  registration = null;
  const callsBeforeDispose = calls.length;
  result = await invoke({ kind: 'files' });
  check('disposeRemovesActualIPCHandler', !result.ok && result.error.includes(CHANNEL) && calls.length === callsBeforeDispose);
  window.destroy();
  check('fixtureClosesWithoutStartingRelay', window.isDestroyed());
  clearTimeout(timer);
  save();
  app.exit(0);
}).catch(error => {
  errors.push(String(error.stack || error));
  dispose();
  save();
  console.error(error);
  clearTimeout(timer);
  app.exit(1);
});
