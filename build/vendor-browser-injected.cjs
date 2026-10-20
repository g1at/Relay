'use strict';
// Run explicitly with a trusted extracted playwright-core@1.62.1 package directory.
// No package execution, downloads or browser installations are performed.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const packageRoot = path.resolve(process.argv[2] || 'node_modules/playwright-core');
const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));
if(metadata.name !== 'playwright-core' || metadata.version !== '1.62.1') throw new Error('Expected official playwright-core@1.62.1');
const bundle = fs.readFileSync(path.join(packageRoot,'lib/coreBundle.js'),'utf8');
const section = bundle.slice(bundle.indexOf('// packages/playwright-core/src/generated/injectedScriptSource.ts'));
const assignment = section.split('\n').find(line=>/^\s*source\d+ = /.test(line));
if(!assignment) throw new Error('Unsupported upstream bundle layout');
const literal = assignment.trim().replace(/^source\d+ = /,'');
const source = vm.runInNewContext(literal, Object.create(null), {timeout:1000});
if(typeof source !== 'string' || !source.includes('InjectedScript')) throw new Error('Missing injected script');
const root=path.join(__dirname,'..'), out=path.join(root,'src/main/browser/vendor/playwright-injected.js');
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out, '// Playwright 1.62.1 injected script. Copyright Microsoft Corporation. Apache-2.0.\n// Generated from the official playwright-core package; see licenses/playwright-LICENSE.\n\'use strict\';\nmodule.exports = '+literal+'\n');
fs.copyFileSync(path.join(packageRoot,'LICENSE'),path.join(root,'licenses/playwright-LICENSE'));
fs.copyFileSync(path.join(packageRoot,'NOTICE'),path.join(root,'licenses/playwright-NOTICE'));
console.log(JSON.stringify({version:metadata.version,sha256:crypto.createHash('sha256').update(source).digest('hex'),bytes:Buffer.byteLength(source)}));
