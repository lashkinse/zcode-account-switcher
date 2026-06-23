'use strict';
/**
 * Account snapshot health check
 *
 * Goal: before actual switching, use lightweight static checks to determine if an account snapshot is "complete / readable / likely usable".
 * Only local structure and field checks here, no active network access.
 */
const { decodeJwt } = require('./fingerprint');
const { decrypt, decryptJson, isEncrypted } = require('./zcodeCrypto');
const quota = require('./quota');

function validateSnapshot(snapshot, meta = {}) {
  const details = {
    hasCredentials: false,
    hasConfig: false,
    canParseCredentials: false,
    canParseConfig: false,
    hasTokens: false,
    canDecryptUserInfo: false,
    hasProviderApiKey: false,
    userId: meta.userId || null,
    provider: meta.provider || null,
  };
  const warnings = [];
  const errors = [];

  if (!snapshot || typeof snapshot !== 'object') {
    return finalize(details, warnings, ['Account snapshot is missing or has invalid format']);
  }

  details.hasCredentials = typeof snapshot.credentials === 'string' && snapshot.credentials.trim() !== '';
  details.hasConfig = typeof snapshot.config === 'string' && snapshot.config.trim() !== '';

  if (!details.hasCredentials) errors.push('Missing credentials login state');
  if (!details.hasConfig) errors.push('Missing config login state');
  if (!details.hasCredentials || !details.hasConfig) return finalize(details, warnings, errors);

  let credentials = null;
  let config = null;

  try {
    credentials = JSON.parse(snapshot.credentials);
    details.canParseCredentials = true;
  } catch (_) {
    errors.push('credentials.json is not valid JSON');
  }

  try {
    config = JSON.parse(snapshot.config);
    details.canParseConfig = true;
  } catch (_) {
    errors.push('config.json is not valid JSON');
  }

  if (!details.canParseCredentials || !details.canParseConfig) return finalize(details, warnings, errors);

  const tokens = quota.readCandidateTokensFromSnapshot(snapshot);
  details.hasTokens = tokens.length > 0;
  if (!details.hasTokens) {
    errors.push('No token found for login/query');
  }

  const providerInfo = extractProviderInfo(credentials, config);
  details.provider = details.provider || providerInfo.provider || null;
  details.hasProviderApiKey = !!providerInfo.apiKey;
  details.userId = details.userId || providerInfo.userId || null;

  if (!details.hasProviderApiKey) {
    warnings.push('No enabled provider apiKey found');
  }
  if (!details.userId) {
    warnings.push('Unable to extract stable user_id from snapshot');
  }

  const userInfoState = checkUserInfo(credentials, providerInfo.provider);
  details.canDecryptUserInfo = userInfoState.canDecryptUserInfo;
  if (userInfoState.warning) warnings.push(userInfoState.warning);

  return finalize(details, warnings, errors);
}

function extractProviderInfo(credentials, config) {
  const activeProvider = readActiveProvider(credentials);
  const providers = config && config.provider && typeof config.provider === 'object' ? config.provider : {};
  const candidates = [];

  for (const [id, p] of Object.entries(providers)) {
    const apiKey = p && p.options && p.options.apiKey;
    if (!apiKey || typeof apiKey !== 'string') continue;
    const payload = decodeJwt(apiKey);
    candidates.push({
      id,
      enabled: !!(p && p.enabled),
      apiKey,
      userId: payload && (payload.user_id || payload.sub),
    });
  }

  candidates.sort((a, b) => Number(b.enabled) - Number(a.enabled));
  const preferred = candidates[0] || null;

  return {
    provider: activeProvider || (preferred && preferred.id) || null,
    apiKey: preferred && preferred.apiKey,
    userId: preferred && preferred.userId,
  };
}

function readActiveProvider(credentials) {
  if (!credentials || typeof credentials !== 'object') return null;
  const value = credentials['oauth:active_provider'];
  if (!value) return null;
  try {
    if (isEncrypted(value)) {
      const plain = decrypt(value);
      return typeof plain === 'string' ? plain : null;
    }
  } catch (_) {}
  return typeof value === 'string' ? value : null;
}

function checkUserInfo(credentials, provider) {
  if (!credentials || typeof credentials !== 'object') {
    return { canDecryptUserInfo: false, warning: 'credentials structure is abnormal; cannot check user_info' };
  }

  const keys = [];
  if (provider) keys.push(`oauth:${provider}:user_info`);
  keys.push('oauth:zai:user_info', 'oauth:bigmodel:user_info');

  for (const key of keys) {
    const value = credentials[key];
    if (!value) continue;
    if (!isEncrypted(value)) return { canDecryptUserInfo: true };
    try {
      const data = decryptJson(value);
      if (data && typeof data === 'object') return { canDecryptUserInfo: true };
      return { canDecryptUserInfo: false, warning: 'user_info exists but decrypted content is not valid JSON' };
    } catch (_) {
      return { canDecryptUserInfo: false, warning: 'user_info cannot be decrypted on this machine' };
    }
  }

  return { canDecryptUserInfo: false, warning: 'user_info not found; UI info may be incomplete' };
}

function finalize(details, warnings, errors) {
  const status = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'healthy';
  const summary =
    status === 'healthy'
      ? 'Snapshot is complete and ready for normal use'
      : status === 'warning'
        ? warnings[0]
        : errors[0];
  return { status, summary, warnings, errors, details };
}

module.exports = {
  validateSnapshot,
};
