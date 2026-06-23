'use strict';
/**
 * Electron main process
 *
 * Responsibilities:
 *   1. Create the application window
 *   2. Bridge the renderer process ↔ verified backend modules (manager / switcher) via IPC
 *
 * Security: contextIsolation=true + limited preload API; the renderer process does not directly access Node.
 *
 * Note: If the app starts without a window, check whether the environment variable ELECTRON_RUN_AS_NODE is set to 1
 *      (this would cause electron to degrade to plain node). The startup script automatically clears it.
 */
const fs = require('fs');
const path = require('path');

// ===== Global error capture → write to log (for diagnosing startup crashes) =====
const LOG_FILE = path.join(__dirname, 'main.log');
function logErr(stage, e) {
  const line = `[${new Date().toISOString()}] ${stage}: ${e && e.stack ? e.stack : e}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (_) {}
}
process.on('uncaughtException', (e) => logErr('uncaughtException', e));
process.on('unhandledRejection', (e) => logErr('unhandledRejection', e));

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

// Path adaptation: in development src is in the parent directory ../src; after packaging electron-builder
// places src/ as extraResources under process.resourcesPath/app-src/
const isPacked = app.isPackaged;
const SRC_DIR = isPacked
  ? path.join(process.resourcesPath, 'app-src')
  : path.join(__dirname, '..', 'src');

// Reuse verified backend logic from src/ (compatible with both dev and packaged modes)
const manager = require(path.join(SRC_DIR, 'manager'));
const switcher = require(path.join(SRC_DIR, 'switcher'));
const oauth = require(path.join(SRC_DIR, 'oauth'));
const quota = require(path.join(SRC_DIR, 'quota'));
const { ZaiAuthFlow } = require(path.join(SRC_DIR, 'oauthCli'));

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL; // Provided by vite in dev mode
let mainWindow = null;

// General logging (info level, writes to main.log)
function logInfo(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (_) {}
}

function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeFileName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || `zcode-accounts-${timestampName()}`;
}

function exportDefaultName(accounts) {
  const first = accounts && accounts[0] && accounts[0].meta ? accounts[0].meta : null;
  const base = safeFileName(first?.email || first?.label || first?.id);
  const suffix = accounts.length > 1 ? `-and ${accounts.length} more` : '';
  return `${base}${suffix}.zcas.json`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1080,
    minHeight: 680,
    title: 'ZCode Account Switcher',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Preload requires path-related capabilities; sandbox must be off
    },
  });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist-renderer', 'index.html'));
  }

  // Capture renderer process console output and errors for diagnosing white screens / JS errors
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
    logInfo(`[renderer:${tag}] ${message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logErr('render-process-gone', new Error(JSON.stringify(details)));
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    logInfo(`[did-fail-load] ${code} ${desc}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    logInfo('[did-finish-load] renderer loaded');
  });

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ===== IPC handlers (all wrapped in try/catch, returning unified {ok, data?, error?} structure) =====

const wrap = async (fn, channel) => {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    logInfo(`[ipc:${channel || 'call'}] error: ${e && e.message ? e.message : e}`);
    return { ok: false, error: e.message || String(e) };
  }
};

// Push OAuth installation/operation progress to the renderer process (for AddAccountModal real-time display)
// Push the add-account flow events to the renderer process
function sendFlowEvent(event) {
  logInfo('[oauth-flow] ' + event.type + (event.message ? ': ' + event.message : ''));
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('oauth:flow-event', event);
    }
  } catch (_) {}
}

ipcMain.handle('account:status', async () =>
  wrap(() => {
    const cur = manager.current();
    const running = switcher.isZCodeRunning();
    const hasLast = switcher.hasLastBackup();
    return { current: cur, zcodeRunning: running, hasLastBackup: hasLast };
  }, 'status')
);

ipcMain.handle('account:list', async () => wrap(() => manager.list(), 'list'));

ipcMain.handle('account:capture', async (_evt, opts) =>
  wrap(() => manager.capture(opts || {}), 'capture')
);

ipcMain.handle('account:use', async (_evt, id) =>
  wrap(() => manager.use(id, { restart: true, force: true }), 'use')
);

ipcMain.handle('account:delete', async (_evt, id) =>
  wrap(() => ({ removed: manager.remove(id) }), 'delete')
);

ipcMain.handle('account:rename', async (_evt, id, label) =>
  wrap(() => manager.rename(id, label), 'rename')
);

ipcMain.handle('account:export', async (_evt, ids) =>
  wrap(async () => {
    const payload = manager.exportAccounts(ids);
    if (!payload.accounts.length) throw new Error('No accounts to export');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Account Snapshots',
      defaultPath: exportDefaultName(payload.accounts),
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { canceled: false, path: result.filePath, count: payload.accounts.length };
  }, 'export')
);

ipcMain.handle('account:import', async () =>
  wrap(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Account Snapshots',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
      ],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { canceled: true };

    const imported = [];
    const skipped = [];
    const files = [];
    for (const filePath of result.filePaths) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const payload = JSON.parse(raw);
        const r = manager.importAccounts(payload, { overwrite: false });
        imported.push(...(r.imported || []));
        skipped.push(...(r.skipped || []));
        files.push({ path: filePath, imported: r.imported?.length || 0, skipped: r.skipped?.length || 0 });
      } catch (e) {
        const reason = e && e.message ? e.message : String(e);
        skipped.push({ file: filePath, reason });
        files.push({ path: filePath, error: reason });
      }
    }
    return {
      canceled: false,
      path: result.filePaths[0],
      paths: result.filePaths,
      fileCount: result.filePaths.length,
      files,
      imported,
      skipped,
      count: imported.length,
    };
  }, 'import')
);
// ===== OAuth Add Account (CLI OAuth + system browser) =====
// Flow: init to get authorize URL → openExternal to open system browser → background poll for login
//   → detect ready → finishLogin writes to disk + snapshot.
// The frontend calls oauth-start once, receiving stage progress via oauth:flow-event events throughout.

// Active login flow + polling timer (module-level, preserved across requests)
let _loginFlow = null;   // { flow: ZaiAuthFlow, flowId: string }
let _pollTimer = null;   // setInterval handle

function stopOauthPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

ipcMain.handle('account:oauth-start', async (_evt, opts) => {
  const { label, note } = opts || {};
  try {
    // 1. Initiate the OAuth flow and get the authorize URL
    const flow = new ZaiAuthFlow();
    const { flowId, authorizeUrl } = await flow.init();
    _loginFlow = { flow, flowId };

    // 2. Open system browser (user logs in via their own browser, more friendly to risk control)
    sendFlowEvent({ type: 'browser-open', message: 'Opening system browser, please log in to your Z.ai account' });
    await shell.openExternal(authorizeUrl);
    sendFlowEvent({ type: 'waiting-login', message: 'Please log in via the browser window (supports email/password or phone number)' });

    // 3. Background polling for login completion (every 2s, consistent with reference project)
    stopOauthPolling();
    _pollTimer = setInterval(async () => {
      const current = _loginFlow;
      if (!current) return;
      try {
        const data = await current.flow.poll(current.flowId);

        if (data.status === 'failed') {
          stopOauthPolling();
          _loginFlow = null;
          sendFlowEvent({ type: 'error', message: 'Login failed or was cancelled' });
          return;
        }

        if (data.status === 'ready') {
          stopOauthPolling();
          _loginFlow = null;

          // Build the tokenSet structure required by oauth.finishLogin():
          //   { token, zaiAccessToken, refreshToken, user }
          // CLI OAuth poll returns align perfectly; disk-write logic can be reused as-is.
          const tokenSet = {
            token: data.token,
            zaiAccessToken: (data.zai && data.zai.access_token) || undefined,
            refreshToken: (data.zai && data.zai.refresh_token) || undefined,
            user: data.user || {},
          };

          try {
            sendFlowEvent({ type: 'exchanging', message: 'Login successful, saving account and initializing quota...' });
            const result = await oauth.finishLogin({ tokenSet, label, note: note || '', overwrite: true });
            logInfo('[oauth-start] finishLogin done, billingReady=' + result.billingReady);
            sendFlowEvent({
              type: 'saved',
              account: result.account,
              email: (result.userInfo && result.userInfo.email) || '',
              skipped: result.skipped,
              billingReady: result.billingReady,
            });
          } catch (e) {
            sendFlowEvent({ type: 'error', message: 'Failed to save account: ' + (e.message || e) });
          }
        }
        // Other statuses (pending) continue polling
      } catch (e) {
        // Single poll network jitter does not break the flow; retry on next tick
        logInfo('[oauth-start] poll error: ' + (e && e.message));
      }
    }, 2000);

    return { ok: true, authorizeUrl };
  } catch (e) {
    logInfo('[oauth-start] error: ' + (e && e.message));
    sendFlowEvent({ type: 'error', message: 'Failed to start login: ' + (e.message || e) });
    return { ok: false, error: e.message || String(e) };
  }
});

// Cancel login flow (stop polling; system browser is closed by user)
ipcMain.handle('account:oauth-cancel', async () =>
  wrap(() => {
    stopOauthPolling();
    _loginFlow = null;
    return { stopped: true };
  }, 'oauth-cancel')
);

ipcMain.handle('shell:open-external', async (_evt, url) =>
  wrap(() => shell.openExternal(url), 'open-external')
);

ipcMain.handle('account:quota', async () =>
  wrap(() => quota.getQuotaOverview(), 'quota')
);

ipcMain.handle('account:quota-one', async (_evt, id) =>
  wrap(() => quota.getAccountQuota(id), 'quota-one')
);

ipcMain.handle('account:quota-many', async (_evt, ids) =>
  wrap(async () => {
    const list = Array.isArray(ids) ? ids : [];
    const out = {};
    for (const id of list) {
      try {
        out[id] = { ok: true, data: await quota.getAccountQuota(id) };
      } catch (e) {
        out[id] = { ok: false, error: e.message || String(e) };
      }
    }
    return out;
  }, 'quota-many')
);

ipcMain.handle('account:rollback', async () =>
  wrap(() => switcher.rollback({ restart: true, force: true }), 'rollback')
);

// ===== Lifecycle =====
app.whenReady().then(() => {
  logInfo(`main start (electron ${process.versions.electron}, chrome ${process.versions.chrome})`);
  logInfo('backend modules loaded: manager, switcher');
  createWindow();
});

app.on('window-all-closed', () => {
  // Stop OAuth polling before exit (system browser is closed by user)
  stopOauthPolling();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopOauthPolling();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
