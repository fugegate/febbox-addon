'use strict';

/**
 * Validates a resolved FebBox direct-link URL before it's ever handed to
 * Stremio, so a broken/wrong link never reaches a user as a "working"
 * stream option. Checks, in order:
 *  1. protocol is https
 *  2. path extension is one of the browser/Stremio-safe direct container
 *     types (mp4, m4v, webm) — HLS (.m3u8) is never valid here, this
 *     module is only used for the 'direct' playback path
 *  3. a HEAD (falling back to a minimal ranged GET, since some CDNs don't
 *     support HEAD) actually succeeds with a video-shaped Content-Type
 *  4. the *final* URL after redirects still resolves to an approved
 *     FebBox/CDN host — never trust a redirect to an arbitrary host
 *
 * This never proxies the video itself — at most one small HEAD/ranged
 * request is made per candidate URL to confirm it's real before offering
 * it, then Stremio (or the user's HTTP client) fetches the actual video
 * bytes directly from FebBox.
 */

const axios = require('axios');

// Real hosts observed serving FebBox video/CDN content during development
// and live verification (febbox.com itself, and its shegu.net CDN, which
// serves under many regional subdomains — e.g. usa7-as11.shegu.net,
// usa7-a3-01-1.shegu.net). Anything outside this allowlist is rejected,
// including if a redirect chain ends up pointing there.
const ALLOWED_HOST_SUFFIXES = ['febbox.com', 'shegu.net'];

// mkv is a legitimate direct/progressive (non-HLS) container FebBox serves
// ORG links in for many TV sources — excluding it was too narrow and
// silently dropped otherwise-valid direct links (confirmed live: a real
// FebBox ORG link ending in .mkv was rejected here, leaving zero playable
// streams for an episode that genuinely had one). mkv isn't natively
// playable by a plain HTML5 <video> tag, but that's exactly what
// behaviorHints.notWebReady (keyed on literal .mp4 in routes.js) already
// communicates to Stremio — this check is only about "is it a real direct
// link", not "is it web-playable".
const PREFERRED_EXTENSIONS = /\.(mp4|m4v|webm|mkv)(\?|$)/i;

function isAllowedHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

function hasPreferredExtension(url) {
  try {
    const u = new URL(url);
    return PREFERRED_EXTENSIONS.test(u.pathname);
  } catch (e) {
    return false;
  }
}

function looksLikeVideoContentType(contentType) {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith('video/') || ct === 'application/octet-stream'; // some CDNs serve mp4 as octet-stream
}

/** Extract the final URL's hostname after redirects, from an axios response. */
function finalHostOf(resp, fallbackUrl) {
  const responseUrl = resp && resp.request && resp.request.res && resp.request.res.responseUrl;
  try {
    return new URL(responseUrl || fallbackUrl).hostname;
  } catch (e) {
    return null;
  }
}

/**
 * @returns {Promise<{valid:boolean, reason?:string, contentType?:string}>}
 */
async function validateDirectUrl(url, { timeout = 6000 } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { valid: false, reason: 'unparsable_url' };
  }
  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'not_https' };
  }
  if (!hasPreferredExtension(url)) {
    return { valid: false, reason: 'unsupported_extension' };
  }
  if (!isAllowedHost(parsed.hostname)) {
    return { valid: false, reason: 'host_not_allowed' };
  }

  const axiosOpts = { timeout, maxRedirects: 5, validateStatus: () => true };

  try {
    let resp = await axios.head(url, axiosOpts);
    if (resp.status === 405 || resp.status === 501 || resp.status >= 400) {
      // HEAD unsupported/blocked by this CDN — fall back to a minimal ranged GET.
      resp = await axios.get(url, { ...axiosOpts, headers: { Range: 'bytes=0-1023' } });
    }
    if (!(resp.status >= 200 && resp.status < 400)) {
      return { valid: false, reason: `bad_status_${resp.status}` };
    }
    const finalHost = finalHostOf(resp, url);
    if (!isAllowedHost(finalHost)) {
      return { valid: false, reason: 'redirect_host_not_allowed' };
    }
    const contentType = resp.headers && resp.headers['content-type'];
    if (!looksLikeVideoContentType(contentType)) {
      return { valid: false, reason: `unexpected_content_type_${contentType || 'none'}` };
    }
    return { valid: true, contentType };
  } catch (err) {
    return { valid: false, reason: 'request_failed' };
  }
}

module.exports = { validateDirectUrl, isAllowedHost, hasPreferredExtension, ALLOWED_HOST_SUFFIXES };
