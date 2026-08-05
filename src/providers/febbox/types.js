'use strict';

/**
 * @typedef {Object} FebBoxFile
 * @property {string} fid
 * @property {string} name
 * @property {boolean} isDir
 * @property {string} [size]
 *
 * @typedef {Object} FebBoxQualityLink
 * @property {string} url
 * @property {string} quality
 * @property {string} [name]
 * @property {string} [size]
 * @property {string} [speed]
 *
 * @typedef {'AUTH_INVALID'|'QUOTA_EXCEEDED'|'UPSTREAM_TIMEOUT'|'UPSTREAM_ERROR'|'NOT_FOUND'|'RATE_LIMITED'} FebBoxErrorCode
 */

class FebBoxError extends Error {
  /** @param {string} message @param {FebBoxErrorCode} code */
  constructor(message, code) {
    super(message);
    this.name = 'FebBoxError';
    this.code = code || 'UPSTREAM_ERROR';
  }
}

module.exports = { FebBoxError };
