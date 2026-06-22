'use strict';
/**
 * 切换核心：进程检测 / 备份当前 / 替换登录态 / 回滚
 *
 * 安全策略：
 *   1. 切换前必须关闭 ZCode（运行中改 credentials.json/config.json 不可靠，且客户端会回写）
 *   2. 替换前先把当前两份文件备份到 .last（用于一键回滚）
 *   3. 原子写：先写 .tmp 再 rename，避免半写状态损坏登录态
 */
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const { CREDENTIALS_FILE, CONFIG_FILE, findZCodeExe } = require('./paths');

// .last 备份目录（打包后需写到可读写的用户目录）
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
 * 检测 ZCode 是否在运行
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
 * 关闭 ZCode（所有进程）。等待最多 waitMs。
 */
async function killZCode({ waitMs = 8000 } = {}) {
  if (!isZCodeRunning()) return true;
  try {
    execSync('taskkill /F /IM ZCode.exe', { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
  } catch (_) {
    // 即使 taskkill 失败也继续等
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isZCodeRunning()) return true;
    await sleep(400);
  }
  return !isZCodeRunning();
}

/**
 * 启动 ZCode
 */
function launchZCode() {
  const exe = findZCodeExe();
  if (!exe) throw new Error('找不到 ZCode.exe，请确认安装路径（paths.js 里 ZCODE_INSTALL_DIR）');
  // detached + 独立 stdio，避免阻塞本工具退出
  try {
    exec(`"${exe}"`, { windowsHide: false, detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (e) {
    throw new Error('启动 ZCode 失败: ' + e.message);
  }
}

/** 读取一份登录态（两个文件内容） */
function readSnapshot() {
  return {
    credentials: fs.readFileSync(CREDENTIALS_FILE, 'utf8'),
    config: fs.readFileSync(CONFIG_FILE, 'utf8'),
  };
}

/** 原子写入一份登录态：先 .tmp 再 rename */
function writeSnapshot(snap) {
  atomicWrite(CREDENTIALS_FILE, snap.credentials);
  atomicWrite(CONFIG_FILE, snap.config);
}

function atomicWrite(filePath, content) {
  const tmp = filePath + '.zcas.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  // rename 原子（同盘）
  fs.renameSync(tmp, filePath);
}

/**
 * 切换到指定账号快照
 * @param {{credentials:string, config:string}} target
 * @param {{restart?:boolean, force?:boolean}} opts
 *   - restart: 切换后自动重启 ZCode（默认 true）
 *   - force:   即使 ZCode 在运行也强制 kill（默认 true，否则切换不可靠）
 */
async function switchTo(target, opts = {}) {
  const { restart = true, force = true } = opts;

  if (!target || !target.credentials || !target.config) {
    throw new Error('目标账号快照不完整');
  }

  const running = isZCodeRunning();
  if (running && !force) {
    throw new Error('ZCode 正在运行，请先关闭，或使用 --force 强制切换');
  }

  // 1. 关闭 ZCode
  if (running) {
    const ok = await killZCode();
    if (!ok) throw new Error('关闭 ZCode 超时，已取消切换（避免登录态损坏）');
  }

  // 2. 备份当前登录态到 .last（用于回滚）
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, 'credentials.json'), fs.readFileSync(CREDENTIALS_FILE, 'utf8'), 'utf8');
    fs.writeFileSync(path.join(BACKUP_DIR, 'config.json'), fs.readFileSync(CONFIG_FILE, 'utf8'), 'utf8');
  } catch (e) {
    throw new Error('备份当前登录态失败: ' + e.message);
  }

  // 3. 原子替换
  try {
    writeSnapshot(target);
  } catch (e) {
    // 替换失败：尝试用刚备份的 .last 恢复
    try { restoreLast(); } catch (_) {}
    throw new Error('写入登录态失败，已自动回滚: ' + e.message);
  }

  // 4. 重启
  let launched = false;
  if (restart) {
    try { launchZCode(); launched = true; } catch (e) {
      console.warn('⚠ 启动 ZCode 失败（登录态已切换）: ' + e.message);
    }
  }

  return { restarted: launched, wasRunning: running };
}

/** 回滚到 .last（切换前的登录态） */
async function rollback(opts = {}) {
  const { restart = true, force = true } = opts;
  if (!fs.existsSync(path.join(BACKUP_DIR, 'credentials.json'))) {
    throw new Error('没有可回滚的备份（.last 不存在）');
  }
  if (isZCodeRunning() && !force) {
    throw new Error('ZCode 正在运行，请先关闭，或使用 --force');
  }
  if (isZCodeRunning()) {
    const ok = await killZCode();
    if (!ok) throw new Error('关闭 ZCode 超时');
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

/** 是否存在可回滚的 .last 备份 */
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
