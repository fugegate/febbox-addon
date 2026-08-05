'use strict';

const { buildManifest } = require('./manifest');
const { decodeConfigToken, hashToken } = require('../config/configToken');
const { parseSeriesId, convertImdbToTmdb, getAlternativeTitles } = require('../metadata/tmdb');
const catalog = require('../providers/febbox/catalog');
const resolver = require('../providers/febbox/resolver');
const { getQuota } = require('../providers/febbox/client');
const { FebBoxError } = require('../providers/febbox/types');
const { redactError } = require('../security/redact');
const { playbackCache } = require('../cache/ttlCache');
const { incrementCounter, timed, METRIC } = require('../metrics/metrics');
const logger = require('../logging/logger');
const { DISPLAY_MODE, DEFAULT_DISPLAY_MODE, DISPLAY_MODE_VALUES, resolutionLabel, buildCleanTitle } = require('./displayMode');

const PLAYBACK_CACHE_TTL_MS = 5 * 60 * 1000; // FebBox direct links expire; keep this short

/**
 * Turn a raw release filename ("silo.s03e04.1080p.web.h264-group.mkv")
 * into something readable ("Silo S03E04 1080p Web H264-Group") for
 * display purposes only. behaviorHints.filename below keeps the
 * untouched original — AIOStreams and similar tools parse quality/
 * language/release-group tokens from that literal string, so it must
 * never be altered.
 */
function cleanDisplayFilename(filename) {
  if (!filename) return '';
  return filename
    .replace(/\.[a-z0-9]{2,4}$/i, '') // drop the file extension
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HLS_WARNING = '⚠ This stream may not work';

/**
 * Builds the {name, title} pair for one stream per the user's chosen
 * displayMode — see displayMode.js for the exact spec of each level.
 * Purely cosmetic; never changes which URL/behaviorHints are offered.
 */
function formatNameAndTitle(s, { displayMode, cleanTitle }) {
  const res = resolutionLabel(s.quality, s.filename);
  const hlsTag = s.isHls ? ' · HLS' : '';

  if (displayMode === DISPLAY_MODE.MINIMAL) {
    return { name: res, title: '' };
  }
  if (displayMode === DISPLAY_MODE.BALANCED) {
    return { name: cleanTitle, title: res };
  }
  if (displayMode === DISPLAY_MODE.STANDARD) {
    const extras = [s.size, ...(s.codecs || [])].filter(Boolean).join(' · ');
    return {
      name: cleanTitle,
      title: [res + hlsTag, extras, s.isHls ? HLS_WARNING : null].filter(Boolean).join('\n'),
    };
  }
  // 'detailed' (default fallback for any unrecognized value): original raw-filename-forward format.
  return {
    name: `FebBox ${s.quality || ''}${hlsTag}`.trim(),
    title: [cleanDisplayFilename(s.filename), [s.size, ...(s.codecs || [])].filter(Boolean).join(' · '), s.isHls ? HLS_WARNING : null]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * Per the Stremio addon protocol (stream response docs): `notWebReady`
 * must be true for any URL that isn't a direct, HTTPS-playable MP4.
 * resolver.js tags each stream with `isHls` explicitly (true only for
 * unmodified FebBox HLS URLs returned in 'experimental-hls'/'both' mode —
 * see resolver.js's PLAYBACK_MODE doc comment), so that's used directly
 * rather than re-deriving it from the URL shape here.
 */
function toStreamObjects(streams, { displayMode = DEFAULT_DISPLAY_MODE, cleanTitle = '' } = {}) {
  return streams.map((s) => {
    const { name, title } = formatNameAndTitle(s, { displayMode, cleanTitle });
    return {
      name,
      title,
      url: s.url,
      behaviorHints: {
        filename: s.filename,
        bingeGroup: `febbox-${s.quality || 'unknown'}${s.isHls ? '-hls' : ''}`,
        notWebReady: Boolean(s.isHls),
        ...(s.videoSizeBytes ? { videoSize: s.videoSizeBytes } : {}),
      },
    };
  });
}

/**
 * GET /manifest.json — generic, unconfigured manifest.
 * Lets Stremio's catalog install flow work: this is the stable public URL
 * an addon listing points to. It always reports configurationRequired,
 * which makes Stremio show "Configure" and send the user to the config
 * page (served at `/`) to generate their own per-user manifest URL.
 */
function rootManifestHandler(req, res) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'application/json');
  res.json(buildManifest(false, baseUrl));
}

/** GET /:configToken/manifest.json */
function manifestHandler(req, res) {
  // The manifest itself carries no secrets, and we don't require the
  // FebBox token to already be *valid* here (that's checked at stream
  // time) — but we do check that configToken decodes at all, so Stremio
  // can be told "already configured" (behaviorHints.configurationRequired
  // = false) and offer "Install" directly instead of "Configure", which
  // would otherwise send the user to the bare config page and drop the
  // token already embedded in this URL.
  let isConfigured = false;
  try {
    const config = decodeConfigToken(req.params.configToken);
    isConfigured = Boolean(config && config.febboxToken);
  } catch (e) {
    isConfigured = false;
  }
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.setHeader('Content-Type', 'application/json');
  res.json(buildManifest(isConfigured, baseUrl));
}

/** GET /:configToken/stream/:type/:id.json */
async function streamHandler(req, res) {
  const { configToken, type, id } = req.params;
  let config;
  try {
    config = decodeConfigToken(configToken);
  } catch (e) {
    // Never leak why decoding failed beyond a generic message (avoid oracle
    // for token-forgery attempts); never log the raw configToken.
    return res.json({ streams: [] });
  }

  const febboxToken = config.febboxToken;
  const tokenHash = hashToken(febboxToken);
  const playbackMode = resolver.PLAYBACK_MODE_VALUES.has(config.playbackMode)
    ? config.playbackMode
    : resolver.DEFAULT_PLAYBACK_MODE;
  const displayMode = DISPLAY_MODE_VALUES.has(config.displayMode) ? config.displayMode : DEFAULT_DISPLAY_MODE;

  try {
    if (type !== 'movie' && type !== 'series') {
      return res.json({ streams: [] });
    }

    const cleanId = String(id || '').replace(/\.json$/, '');
    const { imdbId, season, episode } = parseSeriesId(cleanId);
    if (!imdbId || !imdbId.startsWith('tt')) {
      return res.json({ streams: [] });
    }

    // Catalog auto-discovery: IMDb id -> TMDB title/year (official TMDB
    // `find` endpoint) -> best-effort ShowBox search + share-link match
    // (see src/providers/febbox/catalog.js and
    // docs/CATALOG_DISCOVERY_RESEARCH.md). This is a fuzzy, reverse-engineered,
    // best-effort mechanism against an undocumented ShowBox API — it can
    // return no match (returns null, not an error) or, rarely, mismatch a
    // title. It fails soft to an empty stream list, never a 500.
    const tmdbApiKey = process.env.TMDB_API_KEY;
    let shareKey = null;
    let tmdbInfoOut = null; // captured for display-title formatting below, regardless of discovery outcome
    try {
      shareKey = await timed('discovery_total', async () => {
        const tmdbInfo = tmdbApiKey ? await convertImdbToTmdb(imdbId, type, tmdbApiKey) : null;
        tmdbInfoOut = tmdbInfo;
        if (!tmdbInfo) return null;
        // Fetch romanized/alternative titles up front — foreign-language
        // titles are often indexed on ShowBox under a non-English form
        // (see catalog.js resolveShareKeyForTitle doc comment). One extra
        // TMDB call per request; only used as a fallback if the primary
        // title search doesn't find a confident match.
        const altTitles = tmdbApiKey ? await getAlternativeTitles(tmdbInfo.tmdbId, tmdbInfo.tmdbType, tmdbApiKey) : [];
        return catalog.resolveShareKeyForTitle({ ...tmdbInfo, altTitles });
      });
    } catch (e) {
      shareKey = null; // best-effort: TMDB miss, ShowBox miss, or transient upstream error
    }
    // Note: catalog.resolveShareKeyForTitle already increments
    // discovery_success/discovery_miss internally (it's the only place that
    // knows *why* it succeeded or failed, e.g. after trying multiple
    // ranked candidates) — not duplicated here.

    if (!shareKey) {
      return res.json({ streams: [] });
    }

    // Clean human title for 'balanced'/'standard' display modes — built
    // from TMDB data (already fetched during discovery above), not the
    // raw release filename. Purely cosmetic, computed regardless of mode
    // so a cache hit can reuse the same formatting path.
    const cleanTitle = buildCleanTitle({
      title: tmdbInfoOut && tmdbInfoOut.title,
      year: tmdbInfoOut && tmdbInfoOut.year,
      type,
      season,
      episode,
    });

    // playbackMode is part of the cache key — direct-mode and
    // experimental-hls-mode results must never be served to a user who
    // configured the other. displayMode is NOT part of the key: it only
    // changes how the same underlying streams are formatted, applied
    // fresh below regardless of cache hit/miss.
    const cacheKey = `${tokenHash}:${shareKey}:${type}:${season || ''}:${episode || ''}:${playbackMode}`;
    const cached = playbackCache.get(cacheKey);
    if (cached) {
      incrementCounter(METRIC.PLAYBACK_RESOLUTION_SUCCESS);
      return res.json({ streams: toStreamObjects(cached, { displayMode, cleanTitle }) });
    }

    const streams = await timed('playback_resolution_total', () =>
      type === 'movie'
        ? resolver.resolveMovie({ token: febboxToken, shareKey, playbackMode })
        : resolver.resolveEpisode({ token: febboxToken, shareKey, season, episode, playbackMode })
    );

    playbackCache.set(cacheKey, streams, PLAYBACK_CACHE_TTL_MS);
    incrementCounter(METRIC.PLAYBACK_RESOLUTION_SUCCESS);
    return res.json({ streams: toStreamObjects(streams, { displayMode, cleanTitle }) });
  } catch (err) {
    incrementCounter(METRIC.PLAYBACK_RESOLUTION_FAILURE);
    const safe = redactError(err);
    // Auth/quota failures degrade to an empty stream list, not a 500 — the
    // Stremio client should never see a raw exception.
    if (err instanceof FebBoxError) {
      logger.error('stream_febbox_error', { code: err.code, message: safe.message });
    } else {
      logger.error('stream_unexpected_error', { message: safe.message });
    }
    return res.json({ streams: [] });
  }
}

/** POST /api/validate-token — replaces the dead febbox.andresdev.org check. */
async function validateTokenHandler(req, res) {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ isValid: false, message: 'FebBox token is required.' });
  }
  try {
    const quota = await getQuota({ token: token.trim() });
    return res.json({ isValid: true, quota });
  } catch (err) {
    const safe = redactError(err);
    if (err instanceof FebBoxError && err.code === 'AUTH_INVALID') {
      return res.json({ isValid: false, message: 'FebBox rejected this token.' });
    }
    return res.status(502).json({ isValid: false, message: `Could not validate token: ${safe.message}` });
  }
}

module.exports = { rootManifestHandler, manifestHandler, streamHandler, validateTokenHandler, toStreamObjects };
