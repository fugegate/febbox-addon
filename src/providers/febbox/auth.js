'use strict';

/**
 * FebBox `ui` token normalization and shape validation.
 * Never logs the token itself.
 */

/** Strip a `ui=` prefix if present, trim whitespace. */
function normalizeToken(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.trim();
  if (t.toLowerCase().startsWith('ui=')) t = t.slice(3);
  return t.trim();
}

/** Basic shape check: FebBox `ui` cookie values are opaque alphanumeric-ish strings. */
function isPlausibleToken(token) {
  if (typeof token !== 'string') return false;
  const t = token.trim();
  if (t.length < 8 || t.length > 512) return false;
  // Reject whitespace/control chars and header-injection risk chars.
  if (/[\r\n\t]/.test(t)) return false;
  return true;
}

/** Build the Cookie header value FebBox expects. */
function toCookieHeader(token) {
  return `ui=${normalizeToken(token)}`;
}

module.exports = { normalizeToken, isPlausibleToken, toCookieHeader };
