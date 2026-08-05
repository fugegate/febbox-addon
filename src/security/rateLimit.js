'use strict';

/**
 * Minimal in-memory fixed-window rate limiter (no external dependency).
 * Good enough for a single self-hosted process; for multi-instance
 * deployments, front with a real reverse-proxy rate limiter.
 */
function createRateLimiter({ windowMs = 60000, max = 60 } = {}) {
  const hits = new Map(); // ip -> {count, resetAt}

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}

module.exports = { createRateLimiter };
