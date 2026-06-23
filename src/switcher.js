'use strict';
/**
 * Core switching: process detection / backup current / replace login state / rollback
 *
 * Safety strategy:
 *   1. Must close ZCode before switching (modifying credentials.json/config.json while running is unreliable, and the client will overwrite)
 *   2. Before replacing, back up the current two files to .last (for one-click rollback)
 *   3. Atomic write: write to .tmp first then rename, to avoid corrupted login state from partial writes
 */
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const { CREDENTIALS_FILE, CONFIG_FILE, findZCodeExe } = require('./paths');

// .last backup directory (needs to be written to a readable/writable user directory after packaging)
function resolveBackupDir() {
  if (process.env.ZCAS_DATA_DIR) {
    return path.join(process.env.ZCAS_DATA_DIR, '.last');
  }
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(app.getPath('userData'), '.last');
    }
  } catch (_) {}
  return path.join(__dirname, '..', '.last');
}
const BACKUP_DIR = resolveBackupDir();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Check if ZCode is running
 */
function isZCodeRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /NH /FO CSV', {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /"ZCode\.exe"/i.test(out);
  } catch (_) {
    return false;
  }
}

/**
 * Close ZCode (all processes). Wait up to waitMs.
 */
async function killZCode({ waitMs = 8000 } = {}) {
  if (!isZCodeRunning()) return true;
  try {
    execSync('taskkill /F /IM ZCode.exe', { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
  } catch (_) {
    // Continue waiting even if taskkill fails
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isZCodeRunning()) return true;
    await sleep(400);
  }
  return !isZCodeRunning();
}

/**
 * Launch ZCode
 */
function launchZCode() {
  const exe = findZCodeExe();
  if (!exe) throw new Error('ZCode.exe not found. Check the install path in paths.js (ZCODE_INSTALL_DIR)');
  // detached + independent stdio, to avoid blocking this tool's exit
  try {
    exec(`"${exe}"`, { windowsHide: false, detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (e) {
    throw new Error('Failed to launch ZCode: ' + e.message);
  }
}

/**
 * Sanitize config.json: disable providers that ZCode marked as not entitled.
 * ZCode sets enabled=true but systemDisabledReason="coding_plan_not_entitled"
 * during capture. After startup ZCode disables them. We replicate that
 * cleanup so saved snapshots don't contain stale enabled providers.
 */
function sanitizeConfig(configStr) {
  try {
    const cfg = JSON.parse(configStr);
    const providers = cfg && cfg.provider;
    if (!providers || typeof providers !== 'object') return configStr;

    let changed = false;
    for (const [pid, pdata] of Object.entries(providers)) {
      if (pdata && pdata.enabled && pdata.systemDisabledReason) {
        const reason = pdata.systemDisabledReason;
        if (reason.includes('not_entitled') || reason.includes('inactive')) {
          pdata.enabled = false;
          // Replace JWT apiKey with empty string for not-entitled providers
          if (pdata.options && pdata.options.apiKey && pdata.options.apiKey.startsWith('eyJ')) {
            pdata.options.apiKey = '';
          }
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(cfg) : configStr;
  } catch (_) {
    return configStr;
  }
}

/** Read a login state (content of two files) */
function readSnapshot() {
  return {
    credentials: fs.readFileSync(CREDENTIALS_FILE, 'utf8'),
    config: sanitizeConfig(fs.readFileSync(CONFIG_FILE, 'utf8')),
  };
}

/** Atomically write a login state: write to .tmp first then rename */
function writeSnapshot(snap) {
  atomicWrite(CREDENTIALS_FILE, snap.credentials);
  atomicWrite(CONFIG_FILE, snap.config);
}

function atomicWrite(filePath, content) {
  const tmp = filePath + '.zcas.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  // rename atomic (same disk)
  fs.renameSync(tmp, filePath);
}

/**
 * Switch to specified account snapshot
 * @param {{credentials:string, config:string}} target
 * @param {{restart?:boolean, force?:boolean}} opts
 *   - restart: automatically restart ZCode after switching (default true)
 *   - force: force kill even if ZCode is running (default true, otherwise switching is unreliable)
 */
async function switchTo(target, opts = {}) {
  const { restart = true, force = true } = opts;

  if (!target || !target.credentials || !target.config) {
    throw new Error('Target account snapshot is incomplete');
  }

  const running = isZCodeRunning();
  if (running && !force) {
    throw new Error('ZCode is running. Stop it first, or use --force');
  }

  // 1. Close ZCode
  if (running) {
    const ok = await killZCode();
    if (!ok) throw new Error('Shutdown timed out. Switch cancelled to prevent login state corruption');
  }

  // 2. Back up current login state to .last (for rollback)
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, 'credentials.json'), fs.readFileSync(CREDENTIALS_FILE, 'utf8'), 'utf8');
    fs.writeFileSync(path.join(BACKUP_DIR, 'config.json'), fs.readFileSync(CONFIG_FILE, 'utf8'), 'utf8');
  } catch (e) {
    throw new Error('Failed to backup current login state: ' + e.message);
  }

  // 3. Atomic replacement (sanitize config to remove stale not-entitled providers)
  try {
    target = { ...target, config: sanitizeConfig(target.config) };
    writeSnapshot(target);
    // Clear stale billing/quota caches so ZCode re-fetches from API with new account
    try {
      const cacheDir = require('./paths').ZCODE_V2_DIR;
      const caches = ['coding-plan-cache.json', 'bots-model-cache.v2.json'];
      for (const f of caches) {
        const p = path.join(cacheDir, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch (_) {}
  } catch (e) {
    // Replacement failed: attempt to restore from the just-backed-up .last
    try { restoreLast(); } catch (_) {}
    throw new Error('Failed to write login state; rolled back automatically: ' + e.message);
  }

  // 4. Restart
  let launched = false;
  if (restart) {
    try { launchZCode(); launched = true; } catch (e) {
      console.warn('⚠ Failed to launch ZCode (login state already switched): ' + e.message);
    }
  }

  return { restarted: launched, wasRunning: running };
}

/** Rollback to .last (login state before switching) */
async function rollback(opts = {}) {
  const { restart = true, force = true } = opts;
  if (!fs.existsSync(path.join(BACKUP_DIR, 'credentials.json'))) {
    throw new Error('No backup available for rollback (.last not found)');
  }
  if (isZCodeRunning() && !force) {
    throw new Error('ZCode is running. Stop it first, or use --force');
  }
  if (isZCodeRunning()) {
    const ok = await killZCode();
    if (!ok) throw new Error('ZCode shutdown timed out');
  }
  restoreLast();
  let launched = false;
  if (restart) { try { launchZCode(); launched = true; } catch (_) {} }
  return { restarted: launched };
}

function restoreLast() {
  const c = fs.readFileSync(path.join(BACKUP_DIR, 'credentials.json'), 'utf8');
  const g = fs.readFileSync(path.join(BACKUP_DIR, 'config.json'), 'utf8');
  atomicWrite(CREDENTIALS_FILE, c);
  atomicWrite(CONFIG_FILE, g);
}

/** Check if a rollbackable .last backup exists */
function hasLastBackup() {
  return fs.existsSync(path.join(BACKUP_DIR, 'credentials.json')) &&
         fs.existsSync(path.join(BACKUP_DIR, 'config.json'));
}

module.exports = {
  isZCodeRunning,
  killZCode,
  launchZCode,
  readSnapshot,
  writeSnapshot,
  switchTo,
  rollback,
  hasLastBackup,
  BACKUP_DIR,
};
