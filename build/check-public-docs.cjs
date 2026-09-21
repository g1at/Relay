'use strict';
// Offline check: public entrypoints must work without private docs/design trees.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const marked = require('../renderer/vendor/marked.umd.js');
const root = path.resolve(__dirname, '..');
const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'assets/readme/README.md'];
const errors = [];
let links = 0;
for (const file of files) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) { errors.push(`${file}: missing document`); continue; }
  const tokens = marked.lexer(fs.readFileSync(absolute, 'utf8'));
  const headings = new Set();
  const counts = new Map();
  marked.walkTokens(tokens, token => {
    if (token.type !== 'heading') return;
    const base = token.text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/ /g, '-');
    const count = counts.get(base) || 0;
    headings.add(base + (count ? `-${count}` : '')); counts.set(base, count + 1);
  });
  const html = marked.parser(tokens);
  for (const match of html.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)) {
    const url = match[1];
    if (/^(?:https?:|mailto:)/i.test(url)) continue;
    links++;
    if (url.startsWith('#')) {
      if (!headings.has(decodeURIComponent(url.slice(1)))) errors.push(`${file}: missing heading ${url}`);
      continue;
    }
    const target = path.resolve(path.dirname(absolute), decodeURIComponent(url.split(/[?#]/)[0]));
    const relative = path.relative(root, target).replace(/\\/g, '/');
    if (relative.startsWith('../') || /^(?:docs|design|\.codex-tmp|website)(?:\/|$)/.test(relative)) errors.push(`${file}: private/outside link ${url}`);
    else if (!fs.existsSync(target)) errors.push(`${file}: missing link ${url}`);
  }
  for (const image of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt="[^"\s][^"]*"/.test(image[0])) errors.push(`${file}: image missing alt text`);
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets/readme/manifest.json'), 'utf8'));
for (const entry of manifest.screenshots) {
  if (!/^[a-z-]+\.png$/.test(entry.file)) { errors.push('Invalid screenshot filename'); continue; }
  const file = path.join(root, 'assets/readme', entry.file);
  if (!fs.existsSync(file)) { errors.push(`Missing screenshot: ${entry.file}`); continue; }
  const bytes = fs.readFileSync(file);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) errors.push(`Screenshot manifest differs: ${entry.file}`);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (pkg.license !== 'Apache-2.0' || lock.packages[''].license !== pkg.license) errors.push('Root license metadata differs');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Public documentation: ${files.length} pages, ${links} local links, ${manifest.screenshots.length} image hashes and license metadata verified.`);
