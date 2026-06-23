'use strict';
/**
 * Path constants
 *
 * ZCode client login state files (Windows):
 *   %USERPROFILE%\.zcode\v2\credentials.json   -> encrypted OAuth token (enc:v1:...)
 *   %USERPROFILE%\.zcode\v2\config.json        -> each provider's apiKey JWT (plaintext, contains user_id)
 *   %APPDATA%\ZCode\ZCode.exe                  -> ZCode client
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

// ZCode data directory
const ZCODE_V2_DIR = path.join(HOME, '.zcode', 'v2');

// Login state files (these two form a complete account snapshot)
const CREDENTIALS_FILE = path.join(ZCODE_V2_DIR, 'credentials.json');
const CONFIG_FILE = path.join(ZCODE_V2_DIR, 'config.json');

// ZCode client installation directory candidates (in priority order, the first existing one will be used)
// Tested on current machine: C:\Program Files\ZCode\ZCode.exe
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

// Account snapshot storage directory
// After packaging, __dirname is inside the read-only asar package, account data must be stored in a writable user directory.
// Prioritize environment variable ZCAS_DATA_DIR (for testing/CI), otherwise:
//   - Packaged mode (app.isPackaged=true) → userData/accounts (%APPDATA%/ZCode Account Switcher/accounts)
//   - Dev/CLI mode → project root accounts/ (preserves original behavior)
function resolveStoreDir() {
  if (process.env.ZCAS_DATA_DIR) {
    return path.join(process.env.ZCAS_DATA_DIR, 'accounts');
  }
  // Can only access app.getPath in Electron packaged process
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(app.getPath('userData'), 'accounts');
    }
  } catch (_) {
    // Non-Electron environment (CLI), ignore
  }
  // Dev or CLI mode: project root accounts/
  return path.join(__dirname, '..', 'accounts');
}
const STORE_DIR = resolveStoreDir();

/**
 * Find the actual path of ZCode.exe
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
