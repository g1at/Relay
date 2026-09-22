'use strict';
// Real Electron theme overrides are process-local. The Windows theme is read,
// never changed; all app data and windows belong to this isolated fixture.
const { app, BrowserWindow, nativeTheme, nativeImage } = require('electron');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),output=process.env.RELAY_SMOKE_OUTPUT || path.join(root,'.codex-tmp/native-brand-theme-smoke');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
const report={checks:{},observed:{},errors:[]};
const save=()=>fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));
const timer=setTimeout(()=>{report.errors.push('timeout');save();app.exit(1);},15000);
let win,context;
const check=(name,ok)=>{report.checks[name]=!!ok;save();if(!ok)throw Error(name);};
app.whenReady().then(async()=>{
  win=new BrowserWindow({show:false,width:360,height:240,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await win.loadURL('data:text/html,<title>Isolated native icon test</title>');
  const source=fs.readFileSync(path.join(root,'src/main/app/application-windows.js'),'utf8').replace(/^  /gm, ''),begin=source.indexOf('function resolveNativeIcon('),end=source.indexOf('// ── 系统托盘',begin);
  const trayImages=[];
  context=vm.createContext({app,process,path,fs,appRoot:root,nativeImage,nativeTheme,BrowserWindow,console,
    tray:{isDestroyed:()=>false,setImage:image=>trayImages.push(image)},
    require:name=>{if(name!=='./native-brand-theme')throw Error('Unexpected fixture import');return require('../src/main/app/native-brand-theme');}});
  vm.runInContext(source.slice(begin,end),context);
  for(const theme of ['dark','light']){
    nativeTheme.themeSource=theme;
    context.updateNativeBrandTheme();
    check(theme+'UsesMasterArtwork',context.currentAppIcon()===path.join(root,'build/icon.ico'));
    check(theme+'ArtworkDecodes',trayImages.length>0&&!trayImages.at(-1).isEmpty());
  }
  nativeTheme.themeSource='system';await vm.runInContext('nativeBrandTheme.refresh()',context);context.refreshNativeBrandIcons();
  const systemIcon=context.currentAppIcon();
  report.observed={electron:process.versions.electron,themeSource:nativeTheme.themeSource,
    applicationDark:nativeTheme.shouldUseDarkColors,
    hasIndependentNativeApi:typeof nativeTheme.shouldUseDarkColorsForSystemIntegratedUI==='boolean',
    selectedSystemIcon:path.basename(systemIcon)};
  check('SystemModeUsesOneApprovedNativeAsset',['icon.ico','icon-dark.ico'].includes(path.basename(systemIcon)));
  nativeTheme.themeSource='dark';context.updateNativeBrandTheme();
  check('ManualDarkImmediatelyRestoresMasterEvenAfterSystemMode',context.currentAppIcon()===path.join(root,'build/icon.ico'));
  check('NoEmptyTrayArtwork',trayImages.every(image=>!image.isEmpty()));
  save();
}).catch(error=>{report.errors.push(error.stack);save();process.exitCode=1;}).finally(()=>{
  clearTimeout(timer);if(context)vm.runInContext('nativeBrandTheme.dispose()',context);win?.destroy();app.exit(process.exitCode||0);
});
