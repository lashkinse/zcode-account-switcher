'use strict';
/**
 * ZCode quota query
 *
 * Read tokens from current credentials/config, call ZCode billing API, return total/used/remaining overview.
 */
const fs = require('fs');
const { CREDENTIALS_FILE, CONFIG_FILE } = require('./paths');
const { decrypt, isEncrypted } = require('./zcodeCrypto');

const BILLING_CURRENT_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/current';
const BILLING_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';

// ZCode client sends app_version + platform parameters when requesting billing/current,
// the server routes to the correct billing plan version based on these parameters;
// when parameters are missing, the server may return empty plans (especially noticeable for new accounts).
const CLIENT_APP_VERSION = '4.1.10';
const CLIENT_PLATFORM = 'win32-x64';

function buildBillingUrl(baseUrl) {
  var url = new URL(baseUrl);
  url.searchParams.set('app_version', CLIENT_APP_VERSION);
  url.searchParams.set('platform', CLIENT_PLATFORM);
  return url.toString();
}

async function getQuotaOverview() {
  const tokens = readCandidateTokens();
  if (tokens.length === 0) throw new Error('No ZCode token found for quota query. Please sign in or switch accounts first.');
  return queryQuotaByTokens(tokens);
}

async function queryQuotaByToken(token) {
  return queryQuotaByTokens([token]);
}

async function queryQuotaByTokens(tokens) {
  let lastError = null;
  for (const token of tokens) {
    try {
      const current = await fetchBilling(buildBillingUrl(BILLING_CURRENT_URL), token);
      const balance = await fetchBilling(buildBillingUrl(BILLING_BALANCE_URL), token);
      const overview = normalizeQuota(current.data, balance.data);

      return {
        ...overview,
        refreshedAt: Date.now(),
        raw: { current: current.data, balance: balance.data },
      };
    } catch (e) {
      lastError = e;
      // 401/403 indicates this token is not applicable, try the next candidate token (no break)
    }
  }
  throw lastError || new Error('Quota query failed');
}

function getAccountQuota(id) {
  const manager = require('./manager');
  const snapshot = manager.load(id);
  const tokens = readCandidateTokensFromSnapshot(snapshot);
  if (tokens.length === 0) throw new Error('No quota token found in this account snapshot');
  return queryQuotaByTokens(tokens);
}

async function fetchBilling(url, token) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      authorization: 'Bearer ' + token,
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const msg = typeof data === 'object' && data ? (data.message || data.msg || data.error) : text;
    throw new Error(`Quota API HTTP ${response.status}: ${msg || response.statusText}`);
  }
  return { status: response.status, data };
}

function readBestToken() {
  return readCandidateTokens()[0] || null;
}

function readCandidateTokens() {
  const credentials = readJson(CREDENTIALS_FILE);
  const config = readJson(CONFIG_FILE);
  return readCandidateTokensFromObjects(credentials, config);
}

function readBestTokenFromSnapshot(snapshot) {
  if (!snapshot) return null;
  return readCandidateTokensFromSnapshot(snapshot)[0] || null;
}

function readCandidateTokensFromSnapshot(snapshot) {
  if (!snapshot) return [];
  return readCandidateTokensFromObjects(parseJsonText(snapshot.credentials), parseJsonText(snapshot.config));
}

function readCandidateTokensFromObjects(credentials, config) {
  const activeProvider = safeDecrypt(credentials && credentials['oauth:active_provider']) || 'zai';
  const tokens = [];
  const add = (value) => {
    const plain = safeDecrypt(value);
    if (plain && looksLikeToken(plain) && !tokens.includes(plain)) tokens.push(plain);
  };

  // Order matters: zcodejwttoken(data.token) is the correct token for calling zcode.z.ai/billing,
  // must be first; oauth:*:access_token is chat.z.ai's OAuth token, querying zcode billing with it returns 401.
  add(credentials && credentials.zcodejwttoken);
  add(credentials && credentials['oauth:zai:access_token']);
  add(credentials && credentials['oauth:bigmodel:access_token']);
  add(credentials && credentials[`oauth:${activeProvider}:access_token`]);

  const providers = config && config.provider && typeof config.provider === 'object' ? config.provider : {};
  for (const provider of Object.values(providers)) {
    const apiKey = provider && provider.options && provider.options.apiKey;
    if (apiKey && looksLikeToken(apiKey) && !tokens.includes(apiKey)) tokens.push(apiKey);
  }

  return tokens;
}

function safeDecrypt(value) {
  if (!value) return null;
  try { return isEncrypted(value) ? decrypt(value) : value; } catch (_) { return null; }
}

function looksLikeToken(value) {
  return typeof value === 'string' && value.trim().length > 20;
}

/**
 * Extract account plan tier from billing/current plans array (replicating ZCode client logic).
 * Reverse-engineering basis: ZCode app.asar out/host/index.js rz()/XN()/summarizeStartPlans().
 *
 * Matching rules (by priority, Max takes precedence over Pro to avoid ambiguity):
 *   - Has status=active and plan_id/name contains max   → "Max"
 *   - Has status=active and plan_id/name contains pro   → "Pro"
 *   - Has status=active and plan_id/name contains lite  → "Lite"
 *   - Has status=active and plan_id/name contains start → "Start Plan"
 *   - Otherwise returns null (free/coding plan, no paid tier)
 */
function extractPlanTier(currentData) {
  const cur = unwrap(currentData);
  const plans = Array.isArray(cur && cur.plans) ? cur.plans : [];
  if (plans.length === 0) return null;

  const activePlans = plans.filter((p) => String(p && p.status || '').toLowerCase() === 'active');
  if (activePlans.length === 0) return null;

  const matchKey = (p, kw) => {
    const id = String((p && p.plan_id) || '').toLowerCase();
    const name = String((p && p.name) || '').toLowerCase();
    return id.includes(kw) || name.includes(kw);
  };

  if (activePlans.some((p) => matchKey(p, 'max'))) return { label: 'Max', tier: 'max' };
  if (activePlans.some((p) => matchKey(p, 'pro'))) return { label: 'Pro', tier: 'pro' };
  if (activePlans.some((p) => matchKey(p, 'lite'))) return { label: 'Lite', tier: 'lite' };
  if (activePlans.some((p) => matchKey(p, 'start-plan') || matchKey(p, 'start plan'))) return { label: 'Start Plan', tier: 'start' };
  return null;
}

function normalizeQuota(currentData, balanceData) {
  const current = unwrap(currentData);
  const balance = unwrap(balanceData);
  const pool = flattenNumbers({ current, balance });

  let total = sumNumbers(pool, ['total_units']) ?? firstNumber(pool, ['total', 'totalQuota', 'totalCredits', 'quotaTotal', 'amountTotal', 'creditTotal']);
  let used = sumNumbers(pool, ['used_units']) ?? firstNumber(pool, ['used', 'usedQuota', 'usedCredits', 'quotaUsed', 'amountUsed', 'consumed', 'totalUsed']);
  let remaining = sumNumbers(pool, ['remaining_units']) ?? firstNumber(pool, ['remaining', 'remain', 'balance', 'available', 'availableQuota', 'left', 'quotaRemaining']);

  if (total == null && used != null && remaining != null) total = used + remaining;
  if (used == null && total != null && remaining != null) used = Math.max(0, total - remaining);
  if (remaining == null && total != null && used != null) remaining = Math.max(0, total - used);

  const percentUsed = total && used != null ? clamp((used / total) * 100, 0, 100) : null;

  // Whether billing data is empty (both plans and balances are empty arrays → account has no plan data)
  const isEmpty = Array.isArray(current.plans) && current.plans.length === 0
    && Array.isArray(balance.balances) && balance.balances.length === 0;

  return {
    total: total ?? null,
    used: used ?? null,
    remaining: remaining ?? null,
    percentUsed,
    isEmpty,
    planTier: extractPlanTier(currentData),
    items: normalizeQuotaItems(balance),
    display: {
      total: formatQuota(total),
      used: formatQuota(used),
      remaining: formatQuota(remaining),
      percentUsed: percentUsed == null ? 'unknown' : percentUsed.toFixed(1) + '%',
    },
  };
}

function unwrap(data) {
  let cur = data;
  for (let i = 0; i < 4; i++) {
    if (!cur || typeof cur !== 'object') return cur;
    if (cur.data !== undefined) { cur = cur.data; continue; }
    if (cur.result !== undefined) { cur = cur.result; continue; }
    break;
  }
  return cur || {};
}

function flattenNumbers(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? prefix + '.' + key : key;
    const n = toNumber(value);
    if (n != null) out[p] = n;
    else if (value && typeof value === 'object') flattenNumbers(value, p, out);
  }
  return out;
}

function firstNumber(obj, keys) {
  for (const [path, value] of Object.entries(obj || {})) {
    const name = path.split('.').pop();
    if (keys.includes(name)) return value;
  }
  return null;
}

function sumNumbers(obj, keys) {
  let total = 0;
  let count = 0;
  for (const [path, value] of Object.entries(obj || {})) {
    const name = path.split('.').pop();
    if (keys.includes(name)) {
      total += value;
      count++;
    }
  }
  return count ? total : null;
}

function normalizeQuotaItems(balance) {
  const balances = balance && Array.isArray(balance.balances) ? balance.balances : [];
  return balances.map((item) => {
    const total = toNumber(item.total_units);
    const used = toNumber(item.used_units);
    const remaining = toNumber(item.remaining_units) ?? toNumber(item.available_units);
    return {
      name: item.show_name || item.name || item.entitlement_id || item.plan_id || 'unknown model',
      total,
      used,
      remaining,
      percentUsed: total && used != null ? clamp((used / total) * 100, 0, 100) : null,
      unit: item.unit_type || item.meter || 'quota',
      periodEnd: item.period_end || item.expires_at,
    };
  });
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function formatQuota(value) {
  if (value == null) return 'unknown';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function parseJsonText(text) {
  try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
}

module.exports = {
  BILLING_CURRENT_URL,
  BILLING_BALANCE_URL,
  buildBillingUrl,
  CLIENT_APP_VERSION,
  CLIENT_PLATFORM,
  getQuotaOverview,
  getAccountQuota,
  queryQuotaByToken,
  readBestToken,
  readCandidateTokens,
  readBestTokenFromSnapshot,
  readCandidateTokensFromSnapshot,
  normalizeQuota,
};
