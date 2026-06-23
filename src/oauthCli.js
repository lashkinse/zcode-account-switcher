'use strict';
/**
 * ZCode OAuth login flow (ported from zcode2api's ZaiAuthFlow).
 *
 * Unlike Web OAuth (chat.z.ai/api/oauth/authorize), CLI OAuth uses an interface
 * specifically designed for third-party CLI tools on zcode.z.ai. The returned JWT
 * has billing query permissions built-in, so you can query quota without logging
 * into the ZCode client to "activate" it.
 *
 * Flow:
 *   1. init()  → POST /oauth/cli/init  → get { flow_id, authorize_url }
 *   2. User opens authorize_url in system browser to log in
 *   3. poll(flow_id) → poll until status=ready, get { token, zai.access_token, zai.refresh_token, user }
 *
 * The data structure returned by poll aligns exactly with the original oauthBrowser.exchangeToken(),
 * so the oauth.finishLogin() disk-writing logic can be reused as-is.
 *
 * poll_token: both init and poll requests must include Authorization: Bearer ***
 * Used to identify the same login flow (consistent with reference project).
 */
const crypto = require('crypto');

const API_BASE = 'https://zcode.z.ai/api/v1';

class ZaiAuthFlow {
  constructor(apiBase) {
    this.apiBase = apiBase || API_BASE;
    // poll_token: identifies the same login flow, required in both init and poll
    this.pollToken = crypto.randomBytes(32).toString('hex');
  }

  /**
   * Initiate the OAuth flow.
   * @returns {Promise<{flowId:string, authorizeUrl:string}>}
   */
  async init() {
    const res = await fetch(this.apiBase + '/oauth/cli/init', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.pollToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'zai' }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('OAuth init HTTP ' + res.status + ': ' + (t || '').slice(0, 200));
    }
    const json = await res.json();
    const data = (json && json.data) || {};
    const flowId = data.flow_id;
    const authorizeUrl = data.authorize_url;
    if (!flowId || !authorizeUrl) {
      throw new Error('Incomplete OAuth flow data returned');
    }
    return { flowId: flowId, authorizeUrl: authorizeUrl };
  }

  /**
   * Poll login status.
   * @param {string} flowId
   * @returns {Promise<{status:string, token?:string, zai?:object, user?:object}>}
   *   status: 'pending' | 'ready' | 'failed'
   *   When ready, includes token / zai.access_token / zai.refresh_token / user
   */
  async poll(flowId) {
    const res = await fetch(this.apiBase + '/oauth/cli/poll/' + flowId, {
      headers: { Authorization: 'Bearer ' + this.pollToken },
    });
    if (!res.ok) {
      throw new Error('OAuth poll HTTP ' + res.status);
    }
    const json = await res.json();
    return (json && json.data) || {};
  }
}

module.exports = { ZaiAuthFlow, API_BASE };
