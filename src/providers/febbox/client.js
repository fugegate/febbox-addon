'use strict';

const axios = require('axios');
const { toCookieHeader, isPlausibleToken } = require('./auth');
const { FebBoxError } = require('./types');
const { redactError } = require('../../security/redact');
const { incrementCounter, METRIC } = require('../../metrics/metrics');

// SSRF hardening: this client only ever talks to a fixed, hardcoded allowlist
// of first-party FebBox hosts. No user input ever selects the outbound host.
const FEBBOX_ORIGIN = 'https://www.febbox.com';
const ALLOWED_HOSTS = new Set(['www.febbox.com']);

const DEFAULT_TIMEOUT_MS = 12000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function assertAllowedUrl(url) {
  const u = new URL(url);
  if (!ALLOWED_HOSTS.has(u.host)) {
    throw new Error(`Refusing to contact non-allowlisted host: ${u.host}`);
  }
  return u;
}

/**
 * Perform a GET against a fixed FebBox path with retry-on-transient-error only.
 * Never retries on 401/403/429 (would look like credential stuffing / hammer quota).
 */
async function febboxGet(path, { token, shareKey, params, headers, timeout } = {}) {
  const url = `${FEBBOX_ORIGIN}${path}`;
  assertAllowedUrl(url);
  if (token && !isPlausibleToken(token)) {
    throw new FebBoxError('Malformed FebBox token', 'AUTH_INVALID');
  }

  const reqHeaders = {
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    ...(shareKey ? { Referer: `${FEBBOX_ORIGIN}/share/${shareKey}` } : {}),
    ...(token ? { Cookie: toCookieHeader(token) } : {}),
    ...headers,
  };

  const maxAttempts = 3; // 1 initial + 2 retries
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.get(url, {
        params,
        headers: reqHeaders,
        timeout: timeout || DEFAULT_TIMEOUT_MS,
        validateStatus: () => true,
        maxRedirects: 3,
      });
      return classifyResponse(resp);
    } catch (err) {
      lastErr = err;
      const transient = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNRESET' || err.code === 'ENOTFOUND';
      if (!transient || attempt === maxAttempts) {
        throw toFebBoxError(err);
      }
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw toFebBoxError(lastErr);
}

function classifyResponse(resp) {
  if (resp.status === 401 || resp.status === 403) {
    throw new FebBoxError('FebBox rejected the token (unauthorized)', 'AUTH_INVALID');
  }
  if (resp.status === 429) {
    incrementCounter(METRIC.FEBBOX_RATE_LIMITED);
    throw new FebBoxError('FebBox rate-limited this request', 'RATE_LIMITED');
  }
  if (resp.status === 404) {
    throw new FebBoxError('FebBox resource not found', 'NOT_FOUND');
  }
  if (resp.status >= 500) {
    throw new FebBoxError(`FebBox upstream error (status ${resp.status})`, 'UPSTREAM_ERROR');
  }
  if (resp.status !== 200) {
    throw new FebBoxError(`Unexpected FebBox status ${resp.status}`, 'UPSTREAM_ERROR');
  }
  return resp.data;
}

function toFebBoxError(err) {
  if (err instanceof FebBoxError) return err;
  const safe = redactError(err);
  if (err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
    return new FebBoxError(`FebBox request timed out: ${safe.message}`, 'UPSTREAM_TIMEOUT');
  }
  return new FebBoxError(`FebBox request failed: ${safe.message}`, 'UPSTREAM_ERROR');
}

/** GET /file/file_share_list — list files/folders in a share. Problem B. */
async function listShareFiles({ token, shareKey, parentId = 0 }) {
  if (!shareKey) throw new FebBoxError('shareKey is required', 'NOT_FOUND');
  const data = await febboxGet('/file/file_share_list', {
    token,
    shareKey,
    params: { share_key: shareKey, pwd: '', parent_id: parentId, is_html: 0 },
  });
  const list = data && data.data && Array.isArray(data.data.file_list) ? data.data.file_list : [];
  return list.map((f) => ({
    fid: String(f.fid),
    name: f.file_name || f.name || '',
    isDir: Boolean(f.is_dir) || f.type === 'folder',
    size: f.size || null,
    raw: undefined, // never keep raw upstream blobs around beyond mapping
  }));
}

/** GET /console/video_quality_list — resolve a file to direct quality links. Problem C. */
async function getVideoQualityLinks({ token, shareKey, fid }) {
  if (!fid) throw new FebBoxError('fid is required', 'NOT_FOUND');
  const data = await febboxGet('/console/video_quality_list', {
    token,
    shareKey,
    params: { fid },
  });
  const html = data && typeof data.html === 'string' ? data.html : '';
  return html;
}

/** GET /console/user_cards — account quota lookup. */
async function getQuota({ token }) {
  const data = await febboxGet('/console/user_cards', { token });
  const flow = data && data.data && data.data.flow;
  if (!flow) {
    throw new FebBoxError('Unexpected quota response shape', 'UPSTREAM_ERROR');
  }
  const limitMB = Number(flow.traffic_limit_mb) || 0;
  const usageMB = Number(flow.traffic_usage_mb) || 0;
  return {
    limitMB,
    usageMB,
    remainingMB: limitMB - usageMB,
    isVip: Boolean(flow.is_vip),
  };
}

module.exports = { listShareFiles, getVideoQualityLinks, getQuota, FEBBOX_ORIGIN };
