'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { appRoot } = require('../app/paths');

// Read the application-local SDK metadata directly: its package exports do not
// expose package.json, and a user's global Claude installation is unrelated.
// Keep this helper independent of Electron for ordinary Node test/worker hosts.
function bundledClaudeVersion(base = appRoot) {
  try {
    const file = path.join(base, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
    const version = JSON.parse(fs.readFileSync(file, 'utf8')).claudeCodeVersion;
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : '';
  } catch (_) { return ''; }
}

module.exports = { bundledClaudeVersion };
