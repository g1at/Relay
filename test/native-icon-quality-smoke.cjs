'use strict';
// Local ICO artwork and an isolated, hidden HWND only. Never starts Relay or
// inspects/changes another application's icon or the user's shell settings.
const { app, BrowserWindow, nativeImage, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path'), { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { ICON_SIZES } = require('../build/logo-assets.cjs');
const root = path.resolve(__dirname, '..');
const outputArgument = process.argv.find(value => value.startsWith('--output-dir='));
const output = outputArgument ? path.resolve(outputArgument.slice('--output-dir='.length)) : path.join(root, '.codex-tmp/native-icon-quality');
const compareEnlargement = process.argv.includes('--compare-enlargement');
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'));
app.setAppUserModelId('relay.fixture.native-icon-quality'); app.commandLine.appendSwitch('disable-gpu');
const report = { checks: {}, errors: [], frames: {}, native: [] }; let win;
const timeout = setTimeout(() => finish(1), 40000);
function check(name, value) { report.checks[name] = !!value; if (!value) throw Error(name); console.log(name + ': true'); }
function finish(code) { clearTimeout(timeout); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); win?.destroy(); app.exit(code); }
function readFrames(file) {
  const bytes = fs.readFileSync(file), frames = new Map();
  for (let i = 0; i < bytes.readUInt16LE(4); i++) {
    const entry = 6 + i * 16, size = bytes[entry] || 256, length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12);
    frames.set(size, bytes.subarray(offset, offset + length));
  }
  return frames;
}
function pixels(frame) {
  const image = nativeImage.createFromBuffer(frame), size = image.getSize().width, data = image.toBitmap();
  const levels = new Set(); let partial = 0, opaque = 0, edgePixels = 0, opaqueEdgePixels = 0, coverage = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const alpha = data[(y * size + x) * 4 + 3]; levels.add(alpha); partial += alpha > 0 && alpha < 255; opaque += alpha === 255; coverage += alpha / 255;
    if (!x || !y || x === size - 1 || y === size - 1) { edgePixels += alpha > 0; opaqueEdgePixels += alpha === 255; }
  }
  return { size, partial, coverage, alphaHash: createHash('sha256').update(Buffer.from(data.filter((_, index) => index % 4 === 3))).digest('hex'), alphaLevels: levels.size, opaque, edgePixels, opaqueEdgePixels, transparentCorners: [0, size - 1, size * (size - 1), size * size - 1].every(index => data[index * 4 + 3] === 0) };
}
const probe = `param([string]$IconFile,[long]$WindowHandle)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RelayIconProbe {
 [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public int fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
 [StructLayout(LayoutKind.Sequential)] struct BITMAP { public int type,width,height,widthBytes; public ushort planes,bits; public IntPtr pixels; }
 [StructLayout(LayoutKind.Sequential)] struct INFO { public uint size; public int width,height; public ushort planes,bitCount; public uint compression,imageSize; public int x,y; public uint used,important,colors; }
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr instance,string file,uint type,int cx,int cy,uint flags);
 [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
 [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon,out ICONINFO info);
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd,uint msg,IntPtr wparam,IntPtr lparam);
 [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
 [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd,IntPtr dc);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)] static extern int GetObject(IntPtr obj,int size,out BITMAP value);
 [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc,IntPtr bitmap,uint start,uint lines,byte[] pixels,ref INFO info,uint usage);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
 public class Result { public int Requested,Width,Height,Partial; public string AlphaHash; }
 static Result Inspect(IntPtr icon,int requested) {
   if(icon==IntPtr.Zero) throw new Exception("No HICON"); ICONINFO info; if(!GetIconInfo(icon,out info)) throw new Exception("GetIconInfo failed");
   try { BITMAP bitmap; if(GetObject(info.hbmColor,Marshal.SizeOf(typeof(BITMAP)),out bitmap)==0) throw new Exception("GetObject failed");
     INFO dib=new INFO(); dib.size=40; dib.width=bitmap.width; dib.height=-bitmap.height; dib.planes=1; dib.bitCount=32;
     byte[] bytes=new byte[bitmap.width*bitmap.height*4]; IntPtr dc=GetDC(IntPtr.Zero);
     try { if(GetDIBits(dc,info.hbmColor,0,(uint)bitmap.height,bytes,ref dib,0)==0) throw new Exception("GetDIBits failed"); } finally { ReleaseDC(IntPtr.Zero,dc); }
     int partial=0; for(int i=3;i<bytes.Length;i+=4) if(bytes[i]>0 && bytes[i]<255) partial++;
     byte[] alpha=new byte[bytes.Length/4];for(int i=0;i<alpha.Length;i++)alpha[i]=bytes[i*4+3];string hash;using(var sha=System.Security.Cryptography.SHA256.Create()){hash=BitConverter.ToString(sha.ComputeHash(alpha)).Replace("-","").ToLowerInvariant();}
     return new Result {Requested=requested,Width=bitmap.width,Height=bitmap.height,Partial=partial,AlphaHash=hash};
   } finally { if(info.hbmColor!=IntPtr.Zero) DeleteObject(info.hbmColor); if(info.hbmMask!=IntPtr.Zero) DeleteObject(info.hbmMask); }
 }
 public static Result File(string file,int size) {IntPtr icon=LoadImage(IntPtr.Zero,file,1,size,size,16);try{return Inspect(icon,size);}finally{if(icon!=IntPtr.Zero)DestroyIcon(icon);}}
 public static Result Window(long hwnd,int kind) {return Inspect(SendMessage(new IntPtr(hwnd),0x7f,new IntPtr(kind),IntPtr.Zero),kind);}
}
'@
$sizes=@(${ICON_SIZES.join(',')})
$frames=@($sizes | ForEach-Object { [RelayIconProbe]::File($IconFile,$_) })
$window=@([RelayIconProbe]::Window($WindowHandle,0),[RelayIconProbe]::Window($WindowHandle,1))
@{frames=$frames;window=$window}|ConvertTo-Json -Depth 5 -Compress
`;
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 420, height: 180, icon: path.join(root, 'build/icon.ico'), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:"><title>Relay icon fixture</title>');
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), probeFile = path.join(output, 'probe.ps1');
  fs.writeFileSync(probeFile, probe); report.display = screen.getDisplayMatching(win.getBounds()).scaleFactor;
  const comparison = [];
  for (const suffix of ['', '-dark']) {
    const file = path.join(root, `build/icon${suffix}.ico`), frames = readFrames(file), stats = [...frames].map(([size, frame]) => ({ ...pixels(frame), requested: size }));
    report.frames[suffix || 'light'] = stats;
    check(`Every${suffix || '-light'}FrameHasItsExactSizeWithoutClippedOpaqueEdges`, stats.length === ICON_SIZES.length && stats.every(item => item.size === item.requested && item.opaqueEdgePixels === 0 && item.transparentCorners));
    check(`Every${suffix || '-light'}FrameHasTrueAntialiasedEdgesAndSolidInteriors`, stats.every(item => item.partial >= item.size * 3 && item.alphaLevels >= 30 && item.opaque > item.size));
    const loaded = nativeImage.createFromPath(file); check(`WindowsNativeImageLoads${suffix || '-light'}Ico`, !loaded.isEmpty());
    win.setIcon(file);
    const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probeFile, '-IconFile', file, '-WindowHandle', win.getNativeWindowHandle().readBigUInt64LE().toString()], { windowsHide: true, timeout: 12000 });
    const result = JSON.parse(stdout); report.native.push({ suffix, loadedSize: loaded.getSize(), loadedScales: loaded.getScaleFactors(), ...result });
    check(`Win32LoadsEach${suffix || '-light'}DpiFrameWithoutLosingAntialiasing`, result.frames.every(item => item.Width === item.Requested && item.Height === item.Requested && item.AlphaHash === stats.find(frame => frame.size === item.Width)?.alphaHash));
    check(`ActualBrowserWindow${suffix || '-light'}SmallAndLargeHiconsRetainAntialiasing`, result.window.length === 2 && result.window.every(item => item.Width >= 16 && item.AlphaHash === stats.find(frame => frame.size === item.Width)?.alphaHash));
    const beforeFile = path.join(output, 'before', `icon${suffix}.ico`);
    if (fs.existsSync(beforeFile)) {
      const before = readFrames(beforeFile); report.frames['before' + suffix] = [...before].map(([, frame]) => pixels(frame));
      for (const size of [16, 24, 32, 48, 64]) comparison.push({ size, suffix, before: before.get(size).toString('base64'), after: frames.get(size).toString('base64') });
      if (compareEnlargement) {
        check(`Every${suffix || '-light'}FrameEnlargesArtworkWithoutChangingItsCanvasSize`, ICON_SIZES.every(size => {
          const ratio = pixels(frames.get(size)).coverage / pixels(before.get(size)).coverage;
          return ratio > 1.16 && ratio < 1.21 && pixels(frames.get(size)).size === pixels(before.get(size)).size;
        }));
      } else check(`Small${suffix || '-light'}EdgesImproveOverCapturedPreviousAssets`, [16, 24, 32].every(size => pixels(frames.get(size)).partial > pixels(before.get(size)).partial * 4));
    }
  }
  const png = await win.webContents.executeJavaScript(`(async()=>{
    const rows=${JSON.stringify(comparison)};
    const canvas=document.createElement('canvas');canvas.width=900;canvas.height=rows.length*160+48;const c=canvas.getContext('2d');
    c.fillStyle='#e8e8eb';c.fillRect(0,0,canvas.width,canvas.height);c.fillStyle='#17191d';c.font='16px Segoe UI';c.fillText('Previous frame',220,28);c.fillText(${JSON.stringify(compareEnlargement ? 'Enlarged native artwork' : '8x area-sampled frame')},550,28);
    for(let i=0;i<rows.length;i++){const row=rows[i],y=48+i*160,bg=row.suffix?'#202124':'#fafafa';c.fillStyle=bg;c.fillRect(0,y,900,160);c.fillStyle=row.suffix?'#f4f7fa':'#17191d';c.fillText(row.size+'px / '+(row.suffix?'dark':'light'),16,y+28);
      const images=await Promise.all([row.before,row.after].map(async data=>{const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();return image}));
      for(let j=0;j<2;j++){const x=210+j*330;c.imageSmoothingEnabled=false;c.drawImage(images[j],x,y+39,112,112);c.drawImage(images[j],x+130,y+72,row.size,row.size);}}
    return canvas.toDataURL('image/png').split(',')[1];})()`);
  fs.writeFileSync(path.join(output, 'before-after.png'), Buffer.from(png, 'base64'));
  finish(0);
}).catch(error => { report.errors.push(String(error.stack || error)); console.error(error); finish(1); });
