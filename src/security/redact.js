'use strict';

/**
 * Redaction helpers. FebBox `ui` tokens and our own encrypted config tokens
 * must never reach logs, error messages, or analytics in plaintext.
 *
 * These are deliberately conservative (over-redact rather than under-redact).
 */

const TOKEN_PARAM_RE = /(ui|cookie|token|config|febboxtoken|authorization)=([^&\s"'<>]+)/gi;
const BEARER_RE = /Bearer\s+[A-Za-z0-9\-_.]+/gi;
const COOKIE_HEADER_RE = /(^|;\s*)ui=[^;]+/gi;

/** Redact any secret-shaped substrings from a string. Safe on non-strings (returns as-is). */
function redactString(input) {
  if (typeof input !== 'string') return input;
  let out = input.replace(TOKEN_PARAM_RE, (_m, key) => `${key}=[REDACTED]`);
  out = out.replace(BEARER_RE, 'Bearer [REDACTED]');
  out = out.replace(COOKIE_HEADER_RE, (_m, pre) => `${pre}ui=[REDACTED]`);
  return out;
}

/** Deep-redact known-sensitive keys in an object/array, and scrub string values for secret shapes. */
function redactValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));

  const SENSITIVE_KEYS = new Set([
    'ui', 'cookie', 'token', 'febboxtoken', 'febbox_token', 'authorization',
    'config', 'configtoken', 'secret', 'password',
  ]);

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactValue(v, seen);
    }
  }
  return out;
}

/** Redact a URL, keeping the path but masking known secret query params. */
function redactUrl(url) {
  if (typeof url !== 'string') return url;
  return redactString(url);
}

/** Wrap an Error so its message/stack are redacted; preserves a `.raw` reference only in-memory (never logged). */
function redactError(err) {
  if (!err) return err;
  const message = redactString(err.message || String(err));
  const safe = new Error(message);
  safe.name = err.name || 'Error';
  safe.code = err.code;
  if (err.stack) safe.stack = redactString(err.stack);
  return safe;
}

module.exports = { redactString, redactValue, redactUrl, redactError };
