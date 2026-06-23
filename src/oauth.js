'use strict';
/**
 * ZCode OAuth credential writing + account snapshot
 *
 * Flow (CLI OAuth + system browser):
 *   1. oauthCli.ZaiAuthFlow.poll() gets {token, zaiAccessToken, refreshToken, user} after user login
 *      (token is the zcode JWT returned by CLI OAuth, with built-in billing query permissions)
 *   2. finishLogin(tokenSet) → writeOAuthCredentials encrypts and writes to disk
 *   3. manager.capture() creates account snapshot
 *   4. triggerBusinessLogin(zaiAccessToken) → POST api.z.ai/api/auth/z/login
 *      (reverse-engineered from ZCode app.asar ZaiProviderAdapter.exchangeToken:
 *        the client calls this endpoint immediately after token exchange using zai.access_token,
 *        the server initializes billing plan for the new user_id here; skipping this = no plan)
 *
 * This module is not responsible for login URL generation / network token exchange (those are in oauthCli.js).
 * Here we only keep: safely writing the exchanged token set to ZCode login state files + utility functions.
 */
const fs = require('fs');
const path = require('path');
const { CREDENTIALS_FILE, CONFIG_FILE } = require('./paths');
const { encrypt } = require('./zcodeCrypto');
const { extractFingerprint } = require('./fingerprint');
const manager = require('./manager');

// api.z.ai business login endpoint (reverse-engineered from ZCode client ZaiBusinessTokenResolver)
// ZCode client POSTs to this endpoint immediately after OAuth token exchange, server initializes new account billing plan here
const BUSINESS_LOGIN_URL = 'https://api.z.ai/api/auth/z/login';

// ===== Z.ai provider config (for disk-writing fields) =====
// Consistent with oauthBrowser.OAUTH; bigmodel entry removed (new flow only uses zai)
const PROVIDER = {
  id: 'zai',
  providerIds: ['builtin:zai-start-plan', 'builtin:zai-coding-plan', 'builtin:zai'],
};

/**
 * Write the token set exchanged by oauthBrowser to ZCode login state files, then capture account snapshot.
 *
 * @param {object} opts
 * @param {object} opts.tokenSet - oauthBrowser.exchangeToken() return value
 * @param {string} opts.tokenSet.token - zcode JWT (required)
 * @param {string} [opts.tokenSet.zaiAccessToken] - zai oauth access_token
 * @param {string} [opts.tokenSet.refreshToken] - zai refresh_token
 * @param {object} [opts.tokenSet.user] - user info (email/name/avatar...)
 * @param {string} [opts.label] - account custom name (uses email if empty)
 * @param {string} [opts.note='']
 * @param {boolean} [opts.overwrite=true]
 */
async function finishLogin({ tokenSet, label, note = '', overwrite = true } = {}) {
  if (!tokenSet || !tokenSet.token) throw new Error('Missing token (zcode JWT)');

  const userInfo = normalizeUserInfo(tokenSet.user || {});

  // Preserve original login state (snapshot to memory before writing), restore after capture — ensure new account doesn't affect currently logged-in account
  const prevCredentials = fs.existsSync(CREDENTIALS_FILE) ? fs.readFileSync(CREDENTIALS_FILE, 'utf8') : null;
  const prevConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;

  // Write new account token (capture snapshot needs to read latest login state from v2 directory)
  writeOAuthCredentials(tokenSet, userInfo);

  const captured = manager.capture({ label, note, overwrite });

  // Restore original login state: write back the credentials/config from v2 directory to pre-capture content
  // This way both ZCode client and tool frontend read the same "current account" (new account doesn't switch)
  if (prevCredentials !== null) fs.writeFileSync(CREDENTIALS_FILE, prevCredentials, 'utf8');
  if (prevConfig !== null) fs.writeFileSync(CONFIG_FILE, prevConfig, 'utf8');

  // Trigger server-side billing plan initialization:
  // Reverse-engineered from ZCode client ZaiProviderAdapter.exchangeToken() →
 //   businessTokenResolver.resolve(accessToken) →
 //     POST https://api.z.ai/api/auth/z/login {token: accessToken}
  // Server creates/initializes billing plan for new user_id when processing this request.
  // CLI OAuth flow only returns token, doesn't automatically call this endpoint, must be called manually.
 //
  // Strategy: quick check (~10s) returns result synchronously, while starting background long polling (~4min) to ensure plan is eventually initialized.
  // Server plan creation is an asynchronous process that may take a while.
  const billingReady = await triggerBusinessLogin(tokenSet.zaiAccessToken, tokenSet.token);

  // If quick check not ready, start background polling; UI-side [8s/20s/40s] retries will automatically get the result
  if (!billingReady && tokenSet.token) {
    const { buildBillingUrl, BILLING_CURRENT_URL } = require('./quota');
    const url = buildBillingUrl(BILLING_CURRENT_URL);
    const longDelays = [15000, 30000, 60000, 90000, 120000]; // 15s/30s/60s/90s/120s
    (async () => {
      for (const delay of longDelays) {
        await sleep(delay);
        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: { accept: 'application/json', authorization: 'Bearer ' + tokenSet.token },
          });
          if (!res.ok) continue;
          const json = await res.json();
          const plans = json && json.data && Array.isArray(json.data.plans) ? json.data.plans : [];
          if (plans.length > 0) break; // plan initialized, background polling ends
        } catch (_) {}
      }
    })();
  }

  return {
    userInfo,
    fingerprint: extractFingerprint(),
    account: captured.meta,
    created: captured.created,
    skipped: captured.skipped,
    billingReady,
  };
}

/**
 * Trigger server-side billing plan initialization for new account.
 *
 * Reverse-engineered from ZCode client ZaiProviderAdapter.exchangeToken()
 * businessTokenResolver.resolve(accessToken)：
 *   POST https://api.z.ai/api/auth/z/login { token: <zai_oauth_access_token> }
 *
 * Server creates billing plan (ZCode Start Plan) for user_id when processing this request.
 * CLI OAuth flow doesn't automatically call this endpoint, must be called manually, otherwise new accounts will never have a plan.
 *
 * Server processes asynchronously: plan may not appear immediately in billing/current after successful POST,
 * needs to be combined with checkBillingReady polling. First POST failure (code:500) may also be due to
 * server delayed initialization, so multiple retries are needed.
 *
 * @param {string} zaiAccessToken  - zai OAuth access_token (zai.access_token from poll response)
 * @param {string} zcodeJwt        - zcode JWT (for subsequent billing status verification)
 * @returns {Promise<boolean>}     - whether billing plan is ready
 */
async function triggerBusinessLogin(zaiAccessToken, zcodeJwt) {
  // Regardless of whether zaiAccessToken is available, first check if billing already has a plan
  // (to avoid redundant POST overhead)
  if (await checkBillingReady(zcodeJwt, true)) return true;

  if (zaiAccessToken) {
    // Multiple POST retries, server may only start initialization upon receiving the first request
    const postDelays = [0, 3000, 10000]; // immediately, 3s, 10s
    for (let i = 0; i < postDelays.length; i++) {
      if (postDelays[i] > 0) await sleep(postDelays[i]);
      try {
        const res = await fetch(BUSINESS_LOGIN_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ token: zaiAccessToken }),
        });
        const json = await res.json().catch(() => null);
        if (json && (json.code === 0 || json.code === 200 || json.success === true)) {
          // POST succeeded, poll if billing is ready
          if (await checkBillingReady(zcodeJwt)) return true;
        }
      } catch (_) {
        // Network jitter doesn't interrupt the flow
      }
    }
  }

  // All POSTs failed or no access_token, still try to wait for billing auto-initialization
  // (server may asynchronously create plan at registration, or POST itself may have triggered delayed initialization)
  return checkBillingReady(zcodeJwt);
}

/**
 * Check if billing/current plans are ready, with progressive retries.
 *
 * Uses buildBillingUrl (with app_version + platform parameters) for querying, consistent with ZCode client.
 * Server billing plan creation is an asynchronous process that may take a while, so progressive retries are used:
 *   Fast polling (1s/3s/6s) → Wait for server processing (15s/30s/60s/90s) → Final check (120s)
 * Total wait time approximately 4 minutes.
 *
 * @param {string} zcodeJwt
 * @param {boolean} quickOnly - when true, only performs first 3 quick checks (used for initial plan detection)
 * @returns {Promise<boolean>}
 */
async function checkBillingReady(zcodeJwt, quickOnly = false) {
  if (!zcodeJwt) return false;
  const { buildBillingUrl, BILLING_CURRENT_URL } = require('./quota');
  const url = buildBillingUrl(BILLING_CURRENT_URL);
  const delays = quickOnly
    ? [500, 2000, 5000]                       // Quick check mode: wait ~7.5s only
    : [1000, 3000, 6000, 15000, 30000, 60000, 90000, 120000]; // Full mode: progressive wait ~4min
  for (const delay of delays) {
    await sleep(delay);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: 'Bearer ' + zcodeJwt },
      });
      if (!res.ok) continue;
      const json = await res.json();
      const plans = json && json.data && Array.isArray(json.data.plans) ? json.data.plans : [];
      if (plans.length > 0) return true;
    } catch (_) {
      // Network jitter doesn't interrupt retries
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Write the token set encrypted to credentials.json + config.json.
 *
 * Disk-written fields (consistent with ZCode client real structure):
 *   credentials.json:
 *     oauth:active_provider          = enc(zai)
 *     oauth:zai:access_token         = enc(zaiAccessToken)
 *     oauth:zai:refresh_token        = enc(refreshToken)
 *     oauth:zai:user_info            = enc(user JSON)
 *     zcodejwttoken                  = enc(token)            ← JWT for API calls
 *   config.json:
 *     provider[builtin:zai-*].options.apiKey = token(plaintext JWT, contains user_id)
 */
function writeOAuthCredentials(tokenSet, userInfo = {}) {
  backupCurrentLoginState('oauth');

  const credentials = readJsonIfExists(CREDENTIALS_FILE, {});
  const config = readJsonIfExists(CONFIG_FILE, {});

  const zcodeJwtToken = tokenSet.token;          // JWT for API calls
  const accessToken = tokenSet.zaiAccessToken;    // zai oauth access_token
  const refreshToken = tokenSet.refreshToken;

  credentials['oauth:active_provider'] = encrypt(PROVIDER.id);
  if (accessToken) credentials[`oauth:${PROVIDER.id}:access_token`] = encrypt(accessToken);
  if (refreshToken) credentials[`oauth:${PROVIDER.id}:refresh_token`] = encrypt(refreshToken);
  if (zcodeJwtToken) credentials.zcodejwttoken = encrypt(zcodeJwtToken);
  credentials[`oauth:${PROVIDER.id}:user_info`] = encrypt(JSON.stringify(userInfo || {}));

  if (!config.provider || typeof config.provider !== 'object') config.provider = {};
  if (zcodeJwtToken) updateConfigProviders(config, PROVIDER, zcodeJwtToken);

  atomicWriteJson(CREDENTIALS_FILE, credentials);
  atomicWriteJson(CONFIG_FILE, config);

  return { credentialsFile: CREDENTIALS_FILE, configFile: CONFIG_FILE };
}

/**
 * Write zai's apiKey (JWT) to config.json for all zai provider slots, and disable other providers.
 */
function updateConfigProviders(config, provider, apiKey) {
  for (const id of provider.providerIds) {
    if (!config.provider[id] || typeof config.provider[id] !== 'object') {
      config.provider[id] = { enabled: true, options: {} };
    }
    if (!config.provider[id].options || typeof config.provider[id].options !== 'object') {
      config.provider[id].options = {};
    }
    config.provider[id].enabled = true;
    config.provider[id].options.apiKey = apiKey;
  }
}

// ===== Utility functions =====

/** Normalize oauthBrowser-returned user object to standard userInfo */
function normalizeUserInfo(user) {
  const u = user || {};
  return {
    email: u.email || u.mail || '',
    name: u.name || u.username || u.nickName || u.displayName || '',
    avatar: u.avatar || u.avatarUrl || u.picture || '',
    user_id: u.user_id || u.userId || u.id || u.customerNumber || u.sub || '',
  };
}

function resolveOauthBackupDir() {
  if (process.env.ZCAS_DATA_DIR) return path.join(process.env.ZCAS_DATA_DIR, '.last');
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.join(app.getPath('userData'), '.last');
  } catch (_) {}
  return path.join(__dirname, '..', '.last');
}

function backupCurrentLoginState(reason = 'backup') {
  const dir = path.join(resolveOauthBackupDir(), reason + '-' + timestamp());
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(CREDENTIALS_FILE)) fs.copyFileSync(CREDENTIALS_FILE, path.join(dir, 'credentials.json'));
  if (fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_FILE, path.join(dir, 'config.json'));
  return dir;
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error('Failed to read JSON ' + filePath + ': ' + e.message);
  }
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.zcas.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = {
  PROVIDER,
  finishLogin,
  writeOAuthCredentials,
  updateConfigProviders,
  normalizeUserInfo,
};
