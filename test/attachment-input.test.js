'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareAttachmentContent, snapshotAttachments, stripAttachmentImageData, MAX_IMAGE_BYTES } = require('../src/main/sdk/attachment-input');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const windowsPath = 'C:\\Users\\fixture\\AppData\\Roaming\\relay\\attachments\\截图 & example.png';
test('packaged Relay includes the shared attachment SDK input boundary', () => {
  const manifest = require('../package.json');
  assert.ok(manifest.build.files.includes('src/main/**/*.js') && fs.existsSync(path.join(__dirname, '../src/main/sdk/attachment-input.js')));
});
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-attachment-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic.png'); fs.writeFileSync(file, PNG);
  return file;
}

test('WSL message embeds host screenshot bytes and maps the path without changing history metadata', async t => {
  const file = fixture(t), reads = [];
  const hostFiles = [{ path: windowsPath, name: '截图 & example.png', ext: 'png' }];
  const original = JSON.stringify(hostFiles);
  const fileSystem = {
    stat: async value => { assert.equal(value, windowsPath); return fs.promises.stat(file); },
    readFile: async value => { reads.push(value); return fs.promises.readFile(file); },
  };
  const content = await prepareAttachmentContent('这是什么问题？', hostFiles, { environment: 'wsl', fileSystem });
  assert.equal(content[0].text.includes('/mnt/c/Users/fixture/AppData/Roaming/relay/attachments/截图 & example.png'), true);
  assert.equal(content[0].text.includes(windowsPath), false);
  assert.equal(content.filter(block => block.type === 'image').length, 1);
  assert.deepEqual(Buffer.from(content.at(-1).source.data, 'base64'), PNG);
  assert.equal(content.at(-1).source.media_type, 'image/png');
  assert.deepEqual(reads, [windowsPath]);
  assert.equal(JSON.stringify(hostFiles), original);
});

test('native message embeds real PNG bytes and retains native attachment paths', async t => {
  const file = fixture(t);
  const content = await prepareAttachmentContent('', [{ path: file }]);
  assert.equal(content[0].text.includes(file), true);
  assert.match(content[0].text, /请查看我上传的文件/);
  assert.deepEqual(Buffer.from(content.at(-1).source.data, 'base64'), PNG);
});

test('non-images and directories use environment paths without host reads or blanket directory grants', async () => {
  const content = await prepareAttachmentContent('读取文档', [{ path: 'D:\\项目 A\\说明.txt' }, { path: 'D:\\项目 A\\data.png', isDirectory: true }], {
    environment: 'wsl', fileSystem: { stat() { throw Error('must not read'); } },
  });
  assert.equal(content.length, 1);
  assert.match(content[0].text, /\/mnt\/d\/项目 A\/说明.txt/);
  assert.match(content[0].text, /\/mnt\/d\/项目 A\/data.png/);
  assert.match(content[0].text, /其余文件用 Read/);
});

test('unreadable, oversized or invalid image content keeps the Read fallback and never claims an image was embedded', async () => {
  for (const mode of ['missing', 'oversized', 'invalid']) {
    let reads = 0;
    const content = await prepareAttachmentContent('check', [{ path: windowsPath }], { environment: 'wsl', fileSystem: {
      async stat() {
        if (mode === 'missing') throw Error('fixture unreadable');
        return { isFile: () => true, size: mode === 'oversized' ? MAX_IMAGE_BYTES + 1 : 8 };
      },
      async readFile() { reads++; return Buffer.from('not-an-image'); },
    } });
    assert.equal(content.length, 1);
    assert.equal(content[0].text.includes('图片内容已随本条消息附上'), false);
    assert.equal(reads, mode === 'invalid' ? 1 : 0);
    assert.match(content[0].text, /\/mnt\/c\/Users\/fixture/);
  }
});

test('input accepts absolute paths only and snapshots files before asynchronous queuing', () => {
  const source = [{ path: windowsPath }, { path: '../private.png' }, { path: 'bad\npath.png' }, { path: 'C:relative.png' }];
  const snapshot = snapshotAttachments(source);
  source[0].path = 'changed';
  assert.deepEqual(snapshot, [{ path: windowsPath, isDirectory: false }]);
});

test('SDK user replays and Read image results never return base64 to renderer/history logging', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } };
  const original = { type: 'user', uuid: 'fixture-id', message: { role: 'user', content: [
    { type: 'text', text: '/mnt/c/fixture.png' }, image,
    { type: 'tool_result', tool_use_id: 'read-image', content: [image] },
  ] } };
  const clean = stripAttachmentImageData(original);
  assert.equal(clean.uuid, original.uuid);
  assert.equal(JSON.stringify(clean).includes(PNG.toString('base64')), false);
  assert.equal(original.message.content[1], image);
  assert.equal(clean.message.content[0].text, '/mnt/c/fixture.png');
  const result = { type: 'result', result: 'complete' };
  assert.equal(stripAttachmentImageData(result), result);
});
