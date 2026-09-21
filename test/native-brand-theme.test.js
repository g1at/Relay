'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createNativeBrandTheme, parseSystemDark } = require('../native-brand-theme');

test('Windows registry parser reads only the documented system color value', () => {
  assert.equal(parseSystemDark('    SystemUsesLightTheme    REG_DWORD    0x0\r\n'), true);
  assert.equal(parseSystemDark('    SystemUsesLightTheme    REG_DWORD    0x1\r\n'), false);
  for (const value of ['', 'AppsUseLightTheme REG_DWORD 0x0', 'SystemUsesLightTheme REG_SZ 0', 'SystemUsesLightTheme REG_DWORD 0x2']) assert.equal(parseSystemDark(value), null);
});

test('old Electron uses Windows shell theme, independently of application dark colors', async () => {
  const theme = { themeSource: 'system', shouldUseDarkColors: true }, calls = []; let light = 1, changes = 0;
  const model = createNativeBrandTheme({ nativeTheme: theme, platform: 'win32', systemRoot:'C:\\Windows', onChange:()=>changes++,
    execFile:(file,args,options,callback)=>{calls.push({file,args,options});callback(null,`SystemUsesLightTheme REG_DWORD 0x${light}`);} });
  assert.equal(model.usesLightArtwork(), false); await model.refresh(); assert.equal(model.usesLightArtwork(), false);
  light=0; await model.refresh(); assert.equal(model.usesLightArtwork(), true);
  theme.themeSource='dark'; assert.equal(model.usesLightArtwork(), false); await model.refresh(); assert.equal(calls.length, 2);
  theme.themeSource='light'; assert.equal(model.usesLightArtwork(), false);
  theme.themeSource='system'; assert.equal(model.usesLightArtwork(), true);
  assert.equal(changes, 2); assert.equal(calls[0].file,'C:\\Windows\\System32\\reg.exe');
  assert.deepEqual(calls[0].args.slice(-2),['/v','SystemUsesLightTheme']);
  assert.equal(calls[0].options.windowsHide,true); assert.equal(calls[0].options.timeout,1500);
});

test('new Electron uses its system-integrated color API without spawning a registry process', async () => {
  const theme={themeSource:'system',shouldUseDarkColors:false,shouldUseDarkColorsForSystemIntegratedUI:true};
  const model=createNativeBrandTheme({nativeTheme:theme,platform:'win32',execFile:()=>assert.fail('unnecessary read')});
  assert.equal(await model.refresh(),true);theme.themeSource='dark';assert.equal(model.usesLightArtwork(),false);
});

test('pending reads coalesce and late OS responses cannot override manual app theme', async () => {
  const theme={themeSource:'system'}, callbacks=[];let changes=0;
  const model=createNativeBrandTheme({nativeTheme:theme,platform:'win32',onChange:()=>changes++,execFile:(_f,_a,_o,cb)=>callbacks.push(cb)});
  const first=model.refresh(), second=model.refresh(); assert.equal(first,second);assert.equal(callbacks.length,1);
  theme.themeSource='dark';callbacks[0](null,'SystemUsesLightTheme REG_DWORD 0x0');await first;
  assert.equal(model.usesLightArtwork(),false);assert.equal(changes,1);
});

test('unreadable system colors fall back to master artwork and later refreshes recover', async () => {
  const theme={themeSource:'system'}, callbacks=[];
  const model=createNativeBrandTheme({nativeTheme:theme,platform:'win32',execFile:(_f,_a,_o,cb)=>callbacks.push(cb)});
  let pending=model.refresh();callbacks.shift()(null,'SystemUsesLightTheme REG_DWORD 0x0');await pending;assert.equal(model.usesLightArtwork(),true);
  pending=model.refresh();callbacks.shift()(Error('timeout'));await pending;assert.equal(model.usesLightArtwork(),false);
  pending=model.refresh();callbacks.shift()(null,'SystemUsesLightTheme REG_DWORD 0x0');await pending;assert.equal(model.usesLightArtwork(),true);
});

test('shutdown discards a late registry callback', async () => {
  let done,changes=0;const model=createNativeBrandTheme({nativeTheme:{themeSource:'system'},platform:'win32',onChange:()=>changes++,execFile:(_f,_a,_o,cb)=>{done=cb;}});
  const pending=model.refresh();model.dispose();done(null,'SystemUsesLightTheme REG_DWORD 0x0');await pending;assert.equal(changes,0);assert.equal(model.usesLightArtwork(),false);
});

test('non-Windows platforms use the system theme only when Relay follows the system', async () => {
  const theme={themeSource:'system',shouldUseDarkColors:true};
  const model=createNativeBrandTheme({nativeTheme:theme,platform:'darwin',execFile:()=>assert.fail('Windows-only read')});
  assert.equal(await model.refresh(),true);theme.themeSource='dark';assert.equal(model.usesLightArtwork(),false);
});
