'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createTaskbarCompletionBadge, createNativeTaskbarOverlay, TASKBAR_FRAME_SIZES } = require('../taskbar-completion-badge');
function fixture() {
  const calls = [], errors = [];
  let focused = false, win = { isDestroyed: () => false, setOverlayIcon: (...args) => calls.push(args) };
  const badge = createTaskbarCompletionBadge({ getWindow: () => win, imageForCount: count => `image-${Math.min(count, 10)}`,
    isForeground: () => focused, onError: error => errors.push(error) });
  const end = (id, patch = {}, previous = { state: 'running' }) => badge.observe({ previous,
    run: { runId: id, state: 'succeeded', source: { type: 'conversation', conversationId: id }, ...patch } });
  return { badge, calls, errors, end, focus: value => { focused = value; }, window: value => { win = value; } };
}
test('background terminal tasks accumulate; repeated terminal frames never double count', () => {
  const f = fixture();f.end('a');f.end('a');f.end('b', { state: 'failed' });
  assert.equal(f.badge.count(), 2);assert.deepEqual(f.calls, [['image-1','1 个后台任务已结束'], ['image-2','2 个后台任务已结束']]);
  f.badge.clear();assert.deepEqual(f.calls.at(-1), [null,'']);
  f.end('a');assert.equal(f.badge.count(),0);
});
test('foreground results, pauses, cancellations, recovery and child runs produce no badge', () => {
  const f=fixture();f.focus(true);f.end('foreground');f.focus(false);
  for (const state of ['running','waiting_user','canceled','interrupted']) f.end(state,{state});
  f.end('child',{lineage:{parentRunId:'parent'}});
  f.end('internal',{source:{type:'skill-review'}});
  f.end('recovered',{},null);f.end('already-terminal',{}, {state:'succeeded'});
  assert.equal(f.badge.count(),0);assert.equal(f.calls.length,0);
});
test('chat, mini, image and scheduled tasks use the same terminal accounting', () => {
  const f=fixture();for(const type of ['conversation','mini','creation','schedule']) f.end(type,{source:{type,conversationId:type}});
  assert.equal(f.badge.count(),4);f.badge.clearConversation('mini');assert.equal(f.badge.count(),3);
  f.badge.clearConversation('other');assert.equal(f.badge.count(),3);f.badge.clear();assert.equal(f.badge.count(),0);
});
test('absent/destroyed taskbar windows and temporary overlay failures never break task completion', () => {
  const f=fixture();f.window(null);f.end('a');assert.equal(f.badge.count(),1);
  f.window({isDestroyed:()=>true});f.badge.refresh();assert.equal(f.calls.length,0);
  f.window({isDestroyed:()=>false,setOverlayIcon:()=>{throw Error('Explorer restarting');}});f.badge.refresh();assert.equal(f.errors.length,1);
  f.window({isDestroyed:()=>false,setOverlayIcon:(...args)=>f.calls.push(args)});f.badge.refresh();assert.deepEqual(f.calls.at(-1),['image-1','1 个后台任务已结束']);
});
test('large counts remain exact in accessibility text while the icon may cap at 9+', () => {
  const f=fixture();for(let i=0;i<24;i++)f.end(String(i));
  assert.equal(f.badge.count(),24);assert.deepEqual(f.calls.at(-1),['image-10','24 个后台任务已结束']);
});
test('packaged app includes the badge controller and all renderer artwork', () => {
  const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'),'utf8'));
  assert.ok(config.build.files.includes('taskbar-completion-badge.js'));
  assert.ok(config.build.files.includes('renderer/**/*'));
});

test('native count ICOs contain independently rasterized frames for every Windows DPI size', () => {
  const { BADGES, BADGE_SIZES } = require('../build/taskbar-badge-assets.cjs');
  for (const { name } of BADGES) {
    const ico = fs.readFileSync(path.join(__dirname, '../renderer/taskbar-badges', name + '.ico'));
    assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), BADGE_SIZES.length);
    let expectedOffset = 6 + BADGE_SIZES.length * 16;
    for (const [index, size] of BADGE_SIZES.entries()) {
      const entry = 6 + index * 16, offset = ico.readUInt32LE(entry + 12), length = ico.readUInt32LE(entry + 8);
      assert.equal(ico[entry] || 256, size); assert.equal(ico[entry + 1] || 256, size);
      assert.equal(offset, expectedOffset); assert.ok(length > 24 && offset + length <= ico.length);
      const png = ico.subarray(offset, offset + length);
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
      if (size <= 128) {
        const suffix = size === 16 ? '' : `@${size / 16}x`;
        assert.deepEqual(fs.readFileSync(path.join(__dirname, '../renderer/taskbar-badges', `${name}${suffix}.png`)), png);
      }
      expectedOffset += length;
    }
    assert.equal(expectedOffset, ico.length);
  }
});

test('main-process focus wiring clears the main badge; focusing mini only acknowledges its conversation', () => {
  const vm=require('node:vm'), {EventEmitter}=require('node:events');
  const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  const events=new EventEmitter(), overlays=[];
  const main={isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,isFocused:()=>false,setOverlayIcon:(...args)=>overlays.push(args)};
  const mini={isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false,isFocused:()=>false};
  const ctx=vm.createContext({app:events,createTaskbarCompletionBadge,createNativeTaskbarOverlay,fs,path,__dirname:path.resolve(__dirname,'..'),process:{platform:'win32'},
    mainWindow:main,miniHost:{getPanelWindow:()=>mini},miniChat:{getConversationId:()=> 'mini'},
    nativeImage:{createFromPath:file=>({file,isEmpty:()=>false,addRepresentation(){}})},console});
  vm.runInContext(source.slice(source.indexOf('const taskbarBadgeImages'),source.indexOf('function broadcastTaskLedgerChange')),ctx);
  const badge=vm.runInContext('taskbarCompletionBadge',ctx);
  const end=id=>badge.observe({previous:{state:'running'},run:{runId:id,state:'succeeded',source:{type:id==='mini'?'mini':'conversation',conversationId:id}}});
  end('chat');end('mini');assert.equal(badge.count(),2);assert.ok(overlays[1][0].file.endsWith(path.join('taskbar-badges','2.png')));
  events.emit('browser-window-focus',{},mini);assert.equal(badge.count(),1);
  events.emit('browser-window-focus',{},{});assert.equal(badge.count(),1);
  events.emit('browser-window-focus',{},main);assert.equal(badge.count(),0);assert.deepEqual(overlays.at(-1),[null,'']);
  main.isFocused=()=>true;end('visible');assert.equal(badge.count(),0);
});

test('native overlays receive physical DPI frames without resizing, including 9+ and clear', () => {
  let wanted = 32, loaded = 0;
  const calls = [], handle = Buffer.alloc(8, 1);
  const setter = createNativeTaskbarOverlay({
    assetDirectory: path.resolve(__dirname, '../renderer/taskbar-badges'),
    platform: 'win32', arch: 'x64',
    loadNative: file => {
      loaded++;
      assert.ok(file.endsWith(path.join('native', 'win32-x64.node')));
      return { getOverlaySize: value => { assert.equal(value, handle); return wanted; },
        setOverlayIcon: (...args) => calls.push(args) };
    },
  });
  const win = { getNativeWindowHandle: () => handle };
  for (const size of TASKBAR_FRAME_SIZES) {
    wanted = size;
    assert.equal(setter(win, 1, 'one'), true);
    assert.equal(calls.at(-1)[1].readUInt32BE(16), size);
    assert.equal(calls.at(-1)[1].readUInt32BE(20), size);
  }
  wanted = 36;
  setter(win, 20, '20 个后台任务已结束');
  assert.deepEqual(calls.at(-1)[1], fs.readFileSync(path.resolve(__dirname, '../renderer/taskbar-badges/9-plus@2.25x.png')));
  setter(win, 0, '');
  assert.equal(calls.at(-1)[1].length, 0);
  assert.equal(calls.at(-1)[2], '');
  assert.equal(loaded, 1);
});

test('unsupported hosts and missing native addons retain the Electron fallback', () => {
  let loads = 0; const errors = [];
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'arm64']]) {
    const setter = createNativeTaskbarOverlay({ assetDirectory: '.', platform, arch, loadNative: () => { loads++; } });
    assert.equal(setter({ getNativeWindowHandle() {} }, 1, 'one'), false);
  }
  assert.equal(loads, 0);
  const setter = createNativeTaskbarOverlay({ assetDirectory: '.', platform: 'win32', arch: 'x64',
    loadNative: () => { loads++; throw Error('unavailable'); }, onError: e => errors.push(e) });
  assert.equal(setter({ getNativeWindowHandle() {} }, 1, 'one'), false);
  assert.equal(setter({ getNativeWindowHandle() {} }, 1, 'one'), false);
  assert.equal(loads, 1); assert.equal(errors.length, 1);
});

test('native API rejection cannot suppress completion or prevent acknowledgement', () => {
  const fallback = [], errors = [];
  const badge = createTaskbarCompletionBadge({
    getWindow: () => ({ isDestroyed: () => false, setOverlayIcon: (...args) => fallback.push(args) }),
    setOverlay: () => { throw Error('Explorer unavailable'); },
    imageForCount: count => 'fallback-' + count, onError: error => errors.push(error),
  });
  badge.observe({ previous: { state: 'running' },
    run: { runId: 'native-failure', state: 'succeeded', source: { type: 'conversation' } } });
  assert.deepEqual(fallback.at(-1), ['fallback-1', '1 个后台任务已结束']);
  badge.clear();
  assert.deepEqual(fallback.at(-1), [null, '']);
  assert.equal(errors.length, 2);
});

test('DPI changes redraw with the new frame and a pending repaint cannot revive an acknowledged badge', async () => {
  const { EventEmitter } = require('node:events');
  const win = new EventEmitter(), calls = [];
  let hook, unhooked = false;
  Object.assign(win, { isDestroyed: () => false,
    hookWindowMessage: (message, fn) => { assert.equal(message, 0x02e0); hook = fn; },
    unhookWindowMessage: message => { assert.equal(message, 0x02e0); unhooked = true; },
    setOverlayIcon: () => assert.fail('native overlay should handle this') });
  const badge = createTaskbarCompletionBadge({ getWindow: () => win,
    setOverlay: (_win, count) => { calls.push(count); return true; } });
  badge.observe({ previous: { state: 'running' },
    run: { runId: 'dpi', state: 'succeeded', source: { type: 'conversation' } } });
  hook(); win.emit('moved'); // Coalesce callbacks until window metrics update.
  assert.deepEqual(calls, [1]);
  await new Promise(setImmediate);
  assert.deepEqual(calls, [1, 1]);
  hook(); badge.clear();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [1, 1, 0]);
  badge.dispose();
  assert.equal(unhooked, true); assert.equal(win.listenerCount('moved'), 0);
  assert.equal(win.listenerCount('show'), 0);
});

test('the packaged native addon is explicitly unpacked for the operating-system loader', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(config.build.asarUnpack.includes('renderer/taskbar-badges/native/*.node'));
  const binary = fs.readFileSync(path.join(__dirname, '../renderer/taskbar-badges/native/win32-x64.node'));
  assert.equal(binary.subarray(0, 2).toString(), 'MZ');
  const pe = binary.readUInt32LE(0x3c);
  assert.equal(binary.readUInt16LE(pe + 4), 0x8664);
});

test('dispose forgets retained results and ignores late completion and queued repaint callbacks', async () => {
  const { EventEmitter } = require('node:events');
  const win = new EventEmitter(), calls = [];
  let foregroundChecks = 0;
  Object.assign(win, { isDestroyed: () => false, setOverlayIcon: (...args) => calls.push(args) });
  const badge = createTaskbarCompletionBadge({ getWindow: () => win, imageForCount: count => `image-${count}`,
    isForeground: () => { foregroundChecks++; return false; } });
  const end = runId => badge.observe({ previous: { state: 'running' }, run: { runId, state: 'succeeded', source: { type: 'conversation' } } });
  end('before-dispose'); win.emit('moved');
  const count = calls.length;
  badge.dispose(); badge.dispose(); end('after-dispose');
  badge.refresh(); win.emit('show'); await new Promise(setImmediate);
  assert.equal(badge.count(), 0);
  assert.equal(foregroundChecks, 1); assert.equal(calls.length, count);
  assert.equal(win.listenerCount('moved'), 0); assert.equal(win.listenerCount('show'), 0);
});
