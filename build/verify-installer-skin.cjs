'use strict';

// Packaging uses the checked-in native resource; end users need no compiler.
// Refuse a stale/missing binary when the skin source or its build recipe changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function verifyInstallerSkin(directory = path.join(__dirname, 'installer-skin')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || manifest.architecture !== 'i386' || manifest.callingConvention !== 'stdcall') {
    throw new Error('安装皮肤必须使用 NSIS 所需的 i386 / stdcall 构建。');
  }
  // Fixed allowlist, never interpret arbitrary paths from a metadata file.
  for (const file of ['relay-installer-skin.c', '../build-installer-skin.cjs', 'relay-installer-skin.dll']) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex');
    if (digest !== manifest.files?.[file]) throw new Error(`安装皮肤构建资源已变化：${file}`);
  }
  const dll = fs.readFileSync(path.join(directory, 'relay-installer-skin.dll'));
  if (dll.length < 64 || dll.readUInt16LE(0) !== 0x5a4d) throw new Error('安装皮肤不是有效的 Windows DLL。');
  const pe = dll.readUInt32LE(0x3c);
  if (pe > dll.length - 24 || dll.readUInt32LE(pe) !== 0x4550 || dll.readUInt16LE(pe + 4) !== 0x14c
    || !(dll.readUInt16LE(pe + 22) & 0x2000)) throw new Error('安装皮肤的 PE 架构或 DLL 类型不正确。');
  return { size: dll.length, architecture: manifest.architecture };
}

if (require.main === module) {
  try {
    const result = verifyInstallerSkin();
    console.log(`Relay 安装皮肤校验通过：${result.architecture}，${result.size} 字节。`);
  } catch (error) {
    console.error(`${error.message}\n请在 Windows 开发环境运行 npm run build:installer-skin，然后重新打包。`);
    process.exitCode = 1;
  }
}

module.exports = { verifyInstallerSkin };
