'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createConversationWorkspaces } = require('../src/main/projects/conversation-workspaces');
const { createSdkRuntimeStorage } = require('../src/main/sdk/sdk-runtime-storage');
const { _buildOptions } = require('../src/main/sdk/claude-sdk');

const A='40000000-0000-4000-8000-000000000001',B='40000000-0000-4000-8000-000000000002';

test('real tool subprocesses keep project deliverables and per-conversation scratch separate', t => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'relay-file-locations-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const dataDir=path.join(base,'Relay data'),project=path.join(base,'selected project');fs.mkdirSync(project);
  const before={TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR};
  const store=createConversationWorkspaces({homeDir:base,registryPath:path.join(dataDir,'workspaces.json')});
  const storage=createSdkRuntimeStorage({dataDir});
  const output=[];
  for(const [id,label] of [[A,'first'],[B,'second']]) {
    const workspace=store.resolveWorkspace({conversationId:id,workingDir:project});
    const options=_buildOptions({cwd:workspace.cwd,validWorkingDir:workspace.cwd,scratchDir:workspace.scratchDir,
      permissionMode:'default',runtimeEnv:storage.apply({})},{});
    const script='const fs=require("fs"),os=require("os"),path=require("path");'+
      'const label=process.argv[1];fs.writeFileSync(path.join(os.tmpdir(),"stage.txt"),label);'+
      'fs.writeFileSync(path.join(process.cwd(),label+"-delivery.txt"),label);'+
      'process.stdout.write(JSON.stringify({cwd:process.cwd(),tmp:os.tmpdir(),sdkTmp:process.env.CLAUDE_CODE_TMPDIR}));';
    const result=cp.spawnSync(process.execPath,['-e',script,label],{cwd:options.cwd,env:options.env,encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
    const actual=JSON.parse(result.stdout);
    assert.equal(actual.cwd,project);assert.equal(actual.tmp,workspace.scratchDir);
    assert.equal(actual.sdkTmp,storage.tmpDir);assert.notEqual(actual.sdkTmp,actual.tmp);
    assert.equal(fs.readFileSync(path.join(actual.tmp,'stage.txt'),'utf8'),label);
    assert.ok(options.additionalDirectories.includes(workspace.scratchDir));
    assert.equal(options.permissionMode,'default');
    assert.match(JSON.stringify(options.systemPrompt),/Markdown/);
    output.push(actual);
  }
  assert.notEqual(output[0].tmp,output[1].tmp);
  assert.equal(fs.readFileSync(path.join(output[0].tmp,'stage.txt'),'utf8'),'first');
  assert.deepEqual(fs.readdirSync(project).sort(),['first-delivery.txt','second-delivery.txt']);
  assert.deepEqual({TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR},before);
  const reopened=createConversationWorkspaces({homeDir:base,registryPath:path.join(dataDir,'workspaces.json')}).resolveWorkspace({conversationId:A,workingDir:project});
  assert.equal(reopened.scratchDir,output[0].tmp);
});
