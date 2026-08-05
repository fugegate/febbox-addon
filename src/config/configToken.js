'use strict';

const crypto = require('crypto');

/**
 * Opaque, encrypted, per-user addon configuration token.
 *
 * Encodes { febboxToken, quality prefs, createdAt } as AES-256-GCM
 * ciphertext, base64url-encoded, so the raw FebBox `ui` token is never
 * embedded in a Stremio manifest URL in plaintext.
 *
 * Security rules (see CLAUDE.md / docs/SECURITY.md):
 * - CONFIG_SECRET must be set; missing secret fails loudly (throws), never
 *   falls back to a hardcoded/default key.
 * - Uses authenticated encryption (GCM) so the token cannot be tampered with
 *   or forged without the server secret.
 * - Decrypted payloads must never be logged by callers.
 */

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM

function getKey(secretOverride) {
  const secret = secretOverride || process.env.CONFIG_SECRET;
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    throw new Error(
      'CONFIG_SECRET is not set (or is too short, need >=16 chars). ' +
      'Refusing to encrypt/decrypt config tokens without a real server secret. ' +
      'Set CONFIG_SECRET in your environment (see .env.example).'
    );
  }
  // Derive a 32-byte key deterministically from the provided secret.
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * @param {{febboxToken: string, quality?: object, [k:string]: any}} payload
 * @param {string} [secretOverride] for tests only
 * @returns {string} opaque url-safe token
 */
function encodeConfigToken(payload, secretOverride) {
  if (!payload || typeof payload.febboxToken !== 'string' || !payload.febboxToken.trim()) {
    throw new Error('encodeConfigToken requires a non-empty payload.febboxToken');
  }
  const key = getKey(secretOverride);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const body = JSON.stringify({ ...payload, createdAt: payload.createdAt || Date.now() });
  const ciphertext = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // pack: iv | authTag | ciphertext
  const packed = Buffer.concat([iv, authTag, ciphertext]);
  return base64url(packed);
}

/**
 * @param {string} token opaque token from encodeConfigToken
 * @param {string} [secretOverride] for tests only
 * @returns {{febboxToken: string, quality?: object, createdAt: number}}
 */
function decodeConfigToken(token, secretOverride) {
  if (!token || typeof token !== 'string') {
    throw new Error('Invalid config token');
  }
  const key = getKey(secretOverride);
  let packed;
  try {
    packed = fromBase64url(token);
  } catch (e) {
    throw new Error('Malformed config token');
  }
  if (packed.length < IV_LENGTH + 16) {
    throw new Error('Malformed config token');
  }
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = packed.subarray(IV_LENGTH + 16);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    // Auth tag mismatch, tampered/forged token, or wrong secret.
    throw new Error('Invalid or tampered config token');
  }

  const parsed = JSON.parse(plaintext.toString('utf8'));
  if (!parsed || typeof parsed.febboxToken !== 'string') {
    throw new Error('Invalid config token payload');
  }
  return parsed;
}

/** SHA-256 hash of a token, for use as a non-reversible cache key. Never store/log the raw token. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

module.exports = { encodeConfigToken, decodeConfigToken, hashToken };
