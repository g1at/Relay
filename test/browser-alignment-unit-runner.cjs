'use strict';
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const files=fs.readdirSync(__dirname).filter(name=>/^(browser-.*|execution-modes|activity-stream)\.test\.js$/.test(name));
let failed=0;
for(const file of files) {
  const result=spawnSync(process.execPath,[path.join(__dirname,file)],{encoding:'utf8',timeout:60000});
  console.log(`\nFILE ${file}: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
  console.log((result.stdout || '').slice(-2500));
  if(result.status!==0) { failed++; console.error(result.stderr || result.error || `exit ${result.status}`); }
}
console.log(JSON.stringify({files:files.length,failed}));process.exitCode=failed?1:0;
