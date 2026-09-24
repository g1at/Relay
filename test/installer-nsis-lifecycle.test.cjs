'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const production = fs.readFileSync(path.join(repo, 'build', 'installer.nsh'), 'utf8');
const install = fs.readFileSync(path.join(repo, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'installSection.nsh'), 'utf8');
const uninstall = fs.readFileSync(path.join(repo, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'uninstaller.nsh'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).build.nsis;
const macro = (name) => {
  const result = production.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`, 'i'));
  assert.ok(result, `${name} is provided`);
  return result[1].split(/\r?\n/).filter((line) => !line.trimStart().startsWith(';')).join('\n');
};

test('postflight returns to the stock silent updater relaunch path', () => {
  const hook = macro('customInstall');
  assert.doesNotMatch(hook, /\b(?:Quit|quitSuccess|HideWindow|Sleep|ExecShellAsUser)\b/);
  assert.match(hook, /IfFileExists "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/);
  assert.match(hook, /IfFileExists "\$INSTDIR\\resources\\app\.asar"/);
  assert.match(hook, /Call RelayUIFailure[\s\S]*SetErrorLevel 2[\s\S]*Abort/);
  const hookIndex = install.indexOf('!insertmacro customInstall');
  const relaunchIndex = install.indexOf('${if} ${isForceRun}', hookIndex);
  assert.ok(hookIndex >= 0 && relaunchIndex > hookIndex);
  assert.match(install.slice(relaunchIndex), /\$\{andIf\} \$\{Silent\}[\s\S]*!insertmacro doStartApp/);
});

test('uninstall failure aborts before shortcut and registry cleanup', () => {
  const hook = macro('customRemoveFiles');
  assert.match(hook, /StrCpy \$RelayTransactionAction "Remove"[\s\S]*Call un\.RelayRunTransaction/);
  assert.match(hook, /\$RelayTransactionCode != 0[\s\S]*Call un\.RelayRollbackTransactions[\s\S]*Call un\.RelayUIFailure[\s\S]*SetErrorLevel 2[\s\S]*Abort/);
  assert.doesNotMatch(hook, /DeleteRegKey|UninstShortcut|\$APPDATA|\$PROFILE/);
  const removeIndex = uninstall.indexOf('!insertmacro customRemoveFiles');
  assert.ok(removeIndex >= 0 && removeIndex < uninstall.indexOf('WinShell::UninstShortcut'));
  assert.ok(removeIndex < uninstall.indexOf('DeleteRegKey'));
});

test('uninstall leaves the installation working directory before removing files', () => {
  const hook = macro('customRemoveFiles');
  const change = hook.indexOf('SetOutPath "$PLUGINSDIR"');
  assert.ok(change > hook.indexOf('InitPluginsDir'));
  assert.ok(change < hook.indexOf('Call un.RelayRunTransaction'));
  assert.match(hook.slice(change, hook.indexOf('Call un.RelayRunTransaction')), /SetErrorLevel 2[\s\S]*Abort/);
  assert.doesNotMatch(hook, /Call un\.atomicRMDir|RMDir \/r/);
});

test('both assisted flows use a null-terminated known-folder copy before mode selection', () => {
  for (const name of ['customWelcomePage', 'customUnWelcomePage']) {
    assert.match(macro(name), /installer-safe-user-path\.nsh/);
  }
  const safe = fs.readFileSync(path.join(repo, 'build', 'installer-safe-user-path.nsh'), 'utf8');
  assert.match(safe, /lstrcpynW/);
  assert.doesNotMatch(safe, /&w\$\{NSIS_MAX_STRLEN\}/);
  assert.match(safe, /CoTaskMemFree/);
});

test('uninstall keeps user data by default and preserves explicit upstream opt-in', () => {
  assert.equal(config.deleteAppDataOnUninstall, false);
  assert.doesNotMatch(production, /!define\s+DELETE_APP_DATA_ON_UNINSTALL/);
  assert.match(uninstall, /\$\{GetOptions\} \$R0 "--delete-app-data"/);
  assert.match(macro('customUnInit'), /--delete-app-data[\s\S]*RelayUIDataPolicy "delete"/);
});

test('uninstall progress callbacks attach after the install-mode page has consumed MUI callbacks', () => {
  assert.match(production, /!macroundef MUI_UNPAGE_INSTFILES[\s\S]*!macro MUI_UNPAGE_INSTFILES[\s\S]*MUI_PAGE_CUSTOMFUNCTION_SHOW un\.RelayStyleInstallPage[\s\S]*MUI_PAGE_CUSTOMFUNCTION_LEAVE un\.RelayInstallPageDone[\s\S]*!insertmacro MUI_PAGEDECLARATION_INSTFILES/);
  assert.doesNotMatch(macro('customUnWelcomePage'), /MUI_PAGE_CUSTOMFUNCTION_(?:SHOW|LEAVE) un\.Relay(?:StyleInstallPage|InstallPageDone)/);
});

test('skin presentation preserves silent operation and stops animation on failure', () => {
  const ui = fs.readFileSync(path.join(repo, 'build', 'installer-ui.nsh'), 'utf8');
  const helper = (name) => {
    const match = ui.match(new RegExp(`Function \\$\\{RELAY_UI_PREFIX\\}${name}\\b([\\s\\S]*?)FunctionEnd`));
    assert.ok(match, `${name} helper exists`);
    return match[1];
  };
  const load = helper('RelayUILoadSkin');
  assert.match(load, /\$\{If\} \$\{Silent\}\s+Return[\s\S]*File[\s\S]*LoadLibraryW/);
  const failed = helper('RelayUIFailure');
  assert.match(failed, /SendMessage \$RelayProgress \$\{RELAY_PBM_SETMARQUEE\} 0 0/);
  assert.match(failed, /GetDlgItem \$0 \$HWNDPARENT 2[\s\S]*EnableWindow \$0 1/);
  assert.doesNotMatch(helper('RelayUIDestroy'), /FreeLibrary/);
  assert.match(production, /Function \.onGUIEnd\s+Call RelayRollbackTransactions\s+Call RelayUIDestroy/);
  assert.match(production, /Function un\.onGUIEnd\s+Call un\.RelayRollbackTransactions\s+Call un\.RelayUIDestroy/);
});

test('the bundled skin DLL matches the x86 NSIS host architecture', () => {
  const binary = fs.readFileSync(path.join(repo, 'build', 'installer-skin', 'relay-installer-skin.dll'));
  assert.equal(binary.toString('ascii', 0, 2), 'MZ');
  const pe = binary.readUInt32LE(0x3c);
  assert.equal(binary.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.equal(binary.readUInt16LE(pe + 4), 0x014c, 'NSIS runs as x86 even when the packaged Electron application is x64');
  assert.ok(binary.readUInt16LE(pe + 22) & 0x2000, 'the skin is a DLL, not a separate executable');
  const skinDir = path.join(repo, 'build', 'installer-skin');
  const manifest = JSON.parse(fs.readFileSync(path.join(skinDir, 'manifest.json'), 'utf8'));
  for (const name of ['relay-installer-skin.dll', 'relay-installer-skin.c', '../build-installer-skin.cjs']) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(skinDir, name))).digest('hex');
    assert.equal(manifest.files[name], digest, `${name}: the shipped DLL manifest matches its build inputs and output`);
  }
});
