'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appRoot } = require('../src/main/app/paths');
const { bundledClaudeVersion } = require('../src/main/sdk/sdk-runtime-version');

test('bundled CLI version is read from the SDK beside the application, not process cwd or package exports', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(appRoot, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
  assert.equal(bundledClaudeVersion(), metadata.claudeCodeVersion);
  assert.match(bundledClaudeVersion(), /^\d+\.\d+\.\d+$/);
});

test('unreadable, malformed or invalid SDK version metadata never invents a CLI version', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runtime-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadata = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json');
  assert.equal(bundledClaudeVersion(root), '');
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  for (const source of ['{', '{}', '{"claudeCodeVersion":283}', '{"claudeCodeVersion":"2.1.283 trailing"}']) {
    fs.writeFileSync(metadata, source);
    assert.equal(bundledClaudeVersion(root), '');
  }
  fs.writeFileSync(metadata, '{"claudeCodeVersion":"9.8.7","exports":{".":"./sdk.mjs"}}');
  assert.equal(bundledClaudeVersion(root), '9.8.7');
});
