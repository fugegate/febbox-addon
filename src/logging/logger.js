'use strict';

/**
 * Minimal structured JSON logger. Every field passes through redactValue
 * (src/security/redact.js) before being serialized, so token/cookie/
 * signed-URL-shaped strings anywhere in the log payload are scrubbed —
 * this is the only logging path production code should use.
 */

const { redactValue } = require('../security/redact');

function log(level, message, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...redactValue(fields),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

module.exports = {
  info: (message, fields) => log('info', message, fields),
  warn: (message, fields) => log('warn', message, fields),
  error: (message, fields) => log('error', message, fields),
};
