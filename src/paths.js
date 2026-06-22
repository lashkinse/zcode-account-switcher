'use strict';
/**
 * 路径常量
 *
 * ZCode 客户端的登录态文件（Windows）：
 *   %USERPROFILE%\.zcode\v2\credentials.json   -> 加密的 OAuth token（enc:v1:...）
 *   %USERPROFILE%\.zcode\v2\config.json        -> 每个 provider 的 apiKey JWT（明文，含 user_id）
 *   %APPDATA%\ZCode\ZCode.exe                  -> ZCode 客户端
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

// ZCode 数据目录
const ZCODE_V2_DIR = path.join(HOME, '.zcode', 'v2');

// 登录态文件（这两份构成一份完整账号快照）
const CREDENTIALS_FILE = path.join(ZCODE_V2_DIR, 'credentials.json');
const CONFIG_FILE = path.join(ZCODE_V2_DIR, 'config.json');

// ZCode 客户端安装目录候选（按优先级排列，首个存在的将被采用）
// 当前机器实测：C:\Program Files\ZCode\ZCode.exe
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';
const PROGRAM_FILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ZCODE_EXE_CANDIDATES = [
  path.join(PROGRAM_FILES, 'ZCode', 'ZCode.exe'),
  path.join(PROGRAM_FILES_X86, 'ZCode', 'ZCode.exe'),
  path.join(LOCAL_APPDATA, 'Programs', 'ZCode', 'ZCode.exe'),
  path.join(APPDATA, '..', 'Local', 'Programs', 'ZCode', 'ZCode.exe'),
  'D:\\Program Files\\ZCode\\ZCode.exe',
];

// 账号快照存储目录
// 打包后 __dirname 在只读的 asar 包内，账号数据必须存到可写的用户目录。
// 优先使用环境变量 ZCAS_DATA_DIR（测试/CI 用），否则：
//   - 打包模式（app.isPackaged=true）→ userData/accounts（%APPDATA%/ZCode Account Switcher/accounts）
//   - 开发/CLI 模式 → 项目根目录 accounts/（保持原有行为）
function resolveStoreDir() {
  if (process.env.ZCAS_DATA_DIR) {
    return path.join(process.env.ZCAS_DATA_DIR, 'accounts');
  }
  // 在 Electron 打包进程中才能访问 app.getPath
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(app.getPath('userData'), 'accounts');
    }
  } catch (_) {
    // 非 Electron 环境（CLI），忽略
  }
  // 开发或 CLI 模式：项目根目录 accounts/
  return path.join(__dirname, '..', 'accounts');
}
const STORE_DIR = resolveStoreDir();

/**
 * 找到 ZCode.exe 的实际路径
 */
function findZCodeExe() {
  for (const p of ZCODE_EXE_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

module.exports = {
  HOME,
  APPDATA,
  ZCODE_V2_DIR,
  CREDENTIALS_FILE,
  CONFIG_FILE,
  ZCODE_EXE_CANDIDATES,
  STORE_DIR,
  findZCodeExe,
};
