'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resourceEntries, mergeResources, ownedResource, resourceTarget } = require('../sdk-task-resources');

const event = { type: 'system', subtype: 'task_notification', task_id: 'task', output_file: '/tmp/result.txt',
  resource_links: [{ uri: 'report.md', name: 'Report' }, { uri: 'https://example.test/result' }] };
const context = { jobId: 'job', cwd: '/home/fixture/project', agentEnvironment: 'wsl', wslDistribution: 'Relay-Test' };
function target(uri, extra = {}, platform = 'win32') { return resourceTarget({ uri, ...extra }, platform); }

test('registration persists host-owned task environment and distro across history serialization', () => {
  const registered = resourceEntries({ ...event, agentEnvironment: 'native', wslDistribution: 'Spoof' }, context);
  const saved = JSON.parse(JSON.stringify(mergeResources([], registered)));
  assert.equal(saved.length, 3);
  assert.deepEqual(saved.map(item => item.wslDistribution), ['Relay-Test', 'Relay-Test', 'Relay-Test']);
  assert.equal(saved[0].agentEnvironment, 'wsl');
  const found = ownedResource(saved, { jobId: 'job', taskId: 'task', uri: '/tmp/result.txt', wslDistribution: 'Spoof' });
  assert.equal(found.wslDistribution, 'Relay-Test');
  assert.equal(resourceTarget(found, 'win32').path, '\\\\wsl.localhost\\Relay-Test\\tmp\\result.txt');
  assert.equal(ownedResource(saved, { jobId: 'other', taskId: 'task', uri: found.uri }), null);
  assert.equal(mergeResources(saved, registered).length, 3);
});

test('malformed resource entries cannot poison the registry and distro metadata never comes from events', () => {
  assert.deepEqual(resourceEntries(event, {}), []);
  const entries = resourceEntries({ ...event, resource_links: [null, {}, { uri: '' }, { uri: 'bad\0file' }, { uri: 'ok.txt' }] },
    { ...context, wslDistribution: '../Other' });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].wslDistribution, undefined);
  assert.throws(() => resourceTarget(entries[0], 'win32'), /发行版/);
  assert.equal(resourceEntries(event, { jobId: 'job' })[0].agentEnvironment, 'native');
});

test('native Linux paths and file URLs use POSIX resolution independently from the test host', () => {
  assert.equal(target('/tmp/a/../result.txt', {}, 'linux').path, '/tmp/result.txt');
  assert.equal(target('../result.md', { cwd: '/home/test/project' }, 'linux').path, '/home/test/result.md');
  assert.equal(target('file:///tmp/hello%20%E4%B8%96%E7%95%8C.txt', {}, 'linux').path, '/tmp/hello 世界.txt');
  assert.equal(target('file://localhost/tmp/result.txt', {}, 'linux').path, '/tmp/result.txt');
  assert.throws(() => target('file://remote/share/test.txt', {}, 'linux'));
  assert.throws(() => target('C:\\Users\\test.txt', {}, 'linux'));
  assert.throws(() => target('report.md', {}, 'linux'), /工作目录/);
});

test('native Windows resources support absolute, relative, file URL and existing share paths', () => {
  assert.equal(target('C:\\Users\\a b\\out.md').path, 'C:\\Users\\a b\\out.md');
  assert.equal(target('..\\out.md', { cwd: 'D:\\Task\\src' }).path, 'D:\\Task\\out.md');
  assert.equal(target('file:///D:/Task/hello%20world.md').path, 'D:\\Task\\hello world.md');
  assert.equal(target('file://localhost/D:/Task/out.md').path, 'D:\\Task\\out.md');
  assert.equal(target('file://files.example.test/share/out.md').path, '\\\\files.example.test\\share\\out.md');
  assert.equal(target('\\\\files.example.test\\share\\out.md').path, '\\\\files.example.test\\share\\out.md');
  assert.throws(() => target('/tmp/result.txt'), /路径/);
  assert.throws(() => target('\\result.txt', { cwd: 'D:\\Task' }));
});

test('WSL mounted paths preserve drive identity, including legacy resources and root paths', () => {
  for (const extra of [{}, context]) {
    assert.equal(target('/mnt/c/Users/a b/out.md', extra).path, 'C:\\Users\\a b\\out.md');
    assert.equal(target('/mnt/d', extra).path, 'D:\\');
  }
  assert.equal(target('file:///mnt/d/Task/out.md', context).path, 'D:\\Task\\out.md');
  assert.equal(target('../out.md', { ...context, cwd: 'D:\\Task\\src' }).path, 'D:\\Task\\out.md');
  assert.equal(target('C:\\Users\\out.txt', context).path, 'C:\\Users\\out.txt');
  assert.equal(target('/mnt/d/Task/out.md', context, 'linux').path, '/mnt/d/Task/out.md');
});

test('WSL native resources resolve in their saved distribution, not the current default or Windows cwd', () => {
  assert.equal(target('/tmp/report.txt', context).path, '\\\\wsl.localhost\\Relay-Test\\tmp\\report.txt');
  assert.equal(target('../report.md', context).path, '\\\\wsl.localhost\\Relay-Test\\home\\fixture\\report.md');
  assert.equal(target('file:///home/fixture/report%20one.md', context).path, '\\\\wsl.localhost\\Relay-Test\\home\\fixture\\report one.md');
  assert.equal(target('/tmp/a/../../../report.md', context).path, '\\\\wsl.localhost\\Relay-Test\\report.md');
  assert.equal(target('/tmp/report.txt', { ...context, wslDistribution: 'Relay-Other' }).path, '\\\\wsl.localhost\\Relay-Other\\tmp\\report.txt');
  assert.equal(target('/tmp/report.txt', context, 'linux').path, '/tmp/report.txt');
  assert.throws(() => target('/tmp/report.txt', { agentEnvironment: 'wsl' }), /发行版/);
  assert.throws(() => target('/tmp/report.txt', { ...context, wslDistribution: '\\\\other\\share' }), /发行版/);
});

test('invalid paths cannot escape into another WSL share, network host, Windows device or alternate stream', () => {
  for (const uri of ['', '\0bad', '/tmp/bad\nname', 'C:relative', '\\\\?\\C:\\secret', '\\\\.\\pipe\\test',
    'file:///tmp/a%2fb', 'file:///tmp/a%5cb', 'file:///tmp/a%00b', 'file:///tmp/a?query=1', 'file:///tmp/a#fragment',
    'file://user:password@remote/share/a', '/tmp/a\\..\\..\\Other\\secret', '//Other/share', '/tmp/file:stream']) {
    assert.throws(() => target(uri, context), uri);
  }
  for (const uri of ['C:\\file:stream', 'C:\\NUL', 'C:\\COM1.txt', 'C:\\trailing.']) assert.throws(() => target(uri), uri);
  assert.throws(() => target('output.txt', { ...context, cwd: '//Other/share' }));
});

test('web and protocol resources retain existing handling without file or credential leakage', () => {
  assert.deepEqual(target('https://example.test/a%20b'), { kind: 'url', url: 'https://example.test/a%20b' });
  assert.deepEqual(target('mcp://server/record'), { kind: 'resource', uri: 'mcp://server/record' });
  assert.deepEqual(target('javascript:alert(1)'), { kind: 'resource', uri: 'javascript:alert(1)' });
  assert.throws(() => target('https://user:password@example.test'));
});
