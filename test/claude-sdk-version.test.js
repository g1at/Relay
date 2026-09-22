'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const relayPackage = require('../package.json');
const sdkPackage = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
  'utf8',
));
const { bundledClaudeVersion, bundledExecutable, _buildOptions } = require('../src/main/sdk/claude-sdk');

test('Relay pins Claude Agent SDK and bundled Claude Code to the reviewed release', () => {
  assert.equal(relayPackage.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.266');
  assert.equal(sdkPackage.version, '0.3.266');
  assert.equal(sdkPackage.claudeCodeVersion, '2.1.266');
  assert.equal(bundledClaudeVersion(), '2.1.266');
});

test('installed platform runtime resolves to an existing executable', (t) => {
  const nativePackage = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`);
  const windowsExecutable = path.join(__dirname, '../node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe');
  if (process.platform !== 'win32' && !fs.existsSync(nativePackage) && fs.existsSync(windowsExecutable)) {
    t.skip('This is a Windows dependency tree shared with WSL; executable resolution is verified using Windows Node.');
    return;
  }
  const executable = bundledExecutable();
  assert.ok(executable, '应能定位 SDK 随包运行时');
  assert.equal(fs.existsSync(path.resolve(executable)), true);
});

test('常驻会话为显式权限热切换保留安全门但默认不放宽权限', () => {
  const options = _buildOptions({ cwd: process.cwd(), permissionMode: 'default' }, {});
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.allowDangerouslySkipPermissions, true);
});

test('定时任务权限在 SDK 最后一跳保持自动执行且不等待交互', () => {
  const options = _buildOptions({
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
    disallowAskUserQuestion: true,
    canUseTool: null,
  }, {});
  assert.equal(options.permissionMode, 'bypassPermissions');
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(options.disallowedTools, ['AskUserQuestion']);
  assert.equal(Object.hasOwn(options, 'canUseTool'), false);
});
