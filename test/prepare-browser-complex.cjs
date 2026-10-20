'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const url='https://cdn.jsdelivr.net/npm/ag-grid-community@33.3.2/dist/ag-grid-community.min.js';
const hash='644ea4e81bb9d92f515a0fd14160aebcda5a071bfb3392d72f8a370938fea930';
(async()=>{
 const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Test asset HTTP '+response.status);
 const bytes=Buffer.from(await response.arrayBuffer());if(crypto.createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error('Test asset integrity mismatch');
 const folder=path.join(__dirname,'../.codex-tmp/browser-complex-components');await fs.mkdir(folder,{recursive:true});
 await fs.writeFile(path.join(folder,'ag-grid-community-33.3.2.min.js'),bytes);console.log('Pinned AG Grid test component ready');
})().catch(error=>{console.error(error.message);process.exitCode=1});
