'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const { rootManifestHandler, manifestHandler, streamHandler, validateTokenHandler } = require('../stremio/routes');
const { encodeConfigToken } = require('../config/configToken');
const { createRateLimiter } = require('../security/rateLimit');
const { redactError } = require('../security/redact');
const { normalizeToken, isPlausibleToken } = require('../providers/febbox/auth');
const { DEFAULT_PLAYBACK_MODE, PLAYBACK_MODE_VALUES } = require('../providers/febbox/resolver');
const { DEFAULT_DISPLAY_MODE, DISPLAY_MODE_VALUES } = require('../stremio/displayMode');
const metrics = require('../metrics/metrics');
const logger = require('../logging/logger');

/**
 * Fail loudly at startup rather than silently degrading — a misconfigured
 * deployment should never come up half-working. Only CONFIG_SECRET is
 * strictly required; everything else is optional and logged as a warning
 * so the operator knows what's disabled (e.g. no TMDB_API_KEY means
 * catalog discovery can't run, but the process should still start).
 */
function validateStartupEnvironment() {
  if (!process.env.CONFIG_SECRET || process.env.CONFIG_SECRET.length < 16) {
    throw new Error(
      'CONFIG_SECRET env var is missing or shorter than 16 characters. ' +
      'Set it before starting the server (see .env.example). Refusing to start.'
    );
  }
  if (!process.env.TMDB_API_KEY) {
    logger.warn('startup: TMDB_API_KEY not set — catalog discovery (IMDb/TMDB -> stream) will not work; ' +
      'only direct share-key based lookups would function, and no route currently exposes that.');
  }
  const port = Number(process.env.PORT);
  if (process.env.PORT && (!Number.isInteger(port) || port <= 0)) {
    throw new Error(`PORT env var is set but not a valid positive integer: "${process.env.PORT}"`);
  }
}

/** Replace an opaque config-token path segment (>=20 url-safe chars) with a placeholder before logging. */
function sanitizePathForLogging(reqPath) {
  return String(reqPath || '')
    .split('/')
    .map((segment) => (/^[A-Za-z0-9_-]{20,}$/.test(segment) ? '<configToken>' : segment))
    .join('/');
}

function createApp() {
  validateStartupEnvironment();

  const app = express();
  app.disable('x-powered-by');
  // Trust the first hop's X-Forwarded-Proto/Host (Render, and most PaaS,
  // terminate TLS at a reverse proxy and forward plain HTTP internally).
  // Without this, req.protocol always reports "http" behind such a proxy,
  // which leaks into the manifest logo URL (built from
  // req.protocol+req.get('host')) — it would end up wrong (http instead
  // of https) in production. Value `1` trusts exactly one hop.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));

  // Strict CORS: Stremio clients and the config page only; no wildcard reflect
  // of arbitrary origins for credentialed routes.
  app.use(
    cors({
      origin: true, // Stremio apps call from many local/desktop origins; no cookies are used cross-origin
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
    })
  );

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Sanitized structured request log — path/method/status/duration only.
  // Never logs query strings or headers (which is exactly where a config
  // token, a signed FebBox URL, or a token param could otherwise leak).
  // The path itself needs one extra step: routes like
  // /:configToken/manifest.json put our own opaque (encrypted, but still
  // sensitive) config token directly in the URL path, so the first
  // token-shaped path segment is replaced with a placeholder before
  // logging. Every field also still passes through the logger's own
  // redaction pass as defense in depth.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        path: sanitizePathForLogging(req.path),
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  const apiLimiter = createRateLimiter({ windowMs: 60000, max: 30 });
  const streamLimiter = createRateLimiter({ windowMs: 60000, max: 120 });

  const startedAt = Date.now();
  app.get('/health', (req, res) =>
    res.json({ ok: true, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) })
  );

  // Production metrics: counters + per-stage latency only, never anything
  // token/user/title-shaped — safe to leave unauthenticated.
  app.get('/metrics', (req, res) => res.json(metrics.snapshot()));

  app.use('/assets', express.static(path.join(__dirname, '..', '..', 'views', 'assets'), { maxAge: '1d' }));

  // Config page: a real built React app (see web/), not a static HTML
  // file with inline script. `web/vite.config.js` builds into
  // views/public with its JS/CSS under /app-assets (deliberately not
  // /assets, which is already the icon's static route above). This
  // static mount serves index.html at '/' automatically.
  const webAppDir = path.join(__dirname, '..', '..', 'views', 'public');
  app.use(express.static(webAppDir, { maxAge: '1h', index: 'index.html' }));

  // Generic, unconfigured manifest — the stable public URL for catalog
  // listings and first-time installs. Always configurationRequired, so
  // Stremio sends the user to `/configure` (below) instead of installing
  // directly with no FebBox token.
  app.get('/manifest.json', rootManifestHandler);
  app.get('/configure', (req, res) => res.redirect(302, '/'));

  app.post('/api/validate-token', apiLimiter, validateTokenHandler);

  app.post('/api/create-config', apiLimiter, (req, res) => {
    const raw = req.body && req.body.token;
    const token = normalizeToken(raw || '');
    if (!isPlausibleToken(token)) {
      return res.status(400).json({ error: 'Invalid FebBox token format.' });
    }
    const requestedMode = req.body && req.body.playbackMode;
    const playbackMode = PLAYBACK_MODE_VALUES.has(requestedMode) ? requestedMode : DEFAULT_PLAYBACK_MODE;
    const requestedDisplayMode = req.body && req.body.displayMode;
    const displayMode = DISPLAY_MODE_VALUES.has(requestedDisplayMode) ? requestedDisplayMode : DEFAULT_DISPLAY_MODE;
    try {
      const configToken = encodeConfigToken({ febboxToken: token, quality: req.body.quality || {}, playbackMode, displayMode });
      res.json({ configToken, playbackMode, displayMode });
    } catch (err) {
      const safe = redactError(err);
      res.status(500).json({ error: safe.message });
    }
  });

  app.get('/:configToken/manifest.json', manifestHandler);
  app.get('/:configToken/stream/:type/:id.json', streamLimiter, streamHandler);

  // Safety net: some Stremio clients navigate to `<manifestUrl-without-
  // /manifest.json>/configure` when they believe configuration is still
  // required (e.g. a stale/cached copy of an older manifest fetched
  // before configurationRequired was fixed to report false for a valid
  // token). There's no per-token configure flow — this just sends the
  // user to the same config page as `/`, rather than a bare 404.
  app.get('/:configToken/configure', (req, res) => res.redirect(302, '/'));

  // Generic error handler: never leak stack traces / raw error text that
  // might contain secret-shaped strings picked up from upstream.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const safe = redactError(err);
    logger.error('unhandled_error', { message: safe.message, path: sanitizePathForLogging(req.path) });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp, sanitizePathForLogging };
