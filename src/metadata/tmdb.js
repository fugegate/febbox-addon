'use strict';

const axios = require('axios');
const { catalogCache } = require('../cache/ttlCache');
const { timed } = require('../metrics/metrics');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// TMDB metadata (title/year/id, alternative titles) changes rarely once a
// title exists — a long TTL is safe and cuts real per-request latency/cost.
const TMDB_METADATA_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Convert an IMDb id (Stremio's native id format, `tt1234567[:season:episode]`)
 * to a TMDB id/type. Uses TMDB's official, documented `find` endpoint.
 */
async function convertImdbToTmdb(imdbId, expectedType, apiKey) {
  if (!imdbId || !imdbId.startsWith('tt') || !apiKey) return null;
  const cacheKey = `tmdb:find:${imdbId}:${expectedType}`;
  const cached = catalogCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${TMDB_BASE_URL}/find/${imdbId}`;
  try {
    const resp = await timed('tmdb_find', () =>
      axios.get(url, {
        params: { api_key: apiKey, external_source: 'imdb_id' },
        timeout: 10000,
        validateStatus: () => true,
      })
    );
    if (resp.status !== 200 || !resp.data) return null;
    const data = resp.data;
    const wantTv = expectedType === 'series' || expectedType === 'tv';
    const yearOf = (dateStr) => {
      const m = /^(\d{4})/.exec(dateStr || '');
      return m ? Number(m[1]) : null;
    };
    let result = null;
    if (wantTv && data.tv_results && data.tv_results.length > 0) {
      const r = data.tv_results[0];
      result = { tmdbId: String(r.id), tmdbType: 'tv', title: r.name || r.original_name, year: yearOf(r.first_air_date) };
    } else if (!wantTv && data.movie_results && data.movie_results.length > 0) {
      const r = data.movie_results[0];
      result = { tmdbId: String(r.id), tmdbType: 'movie', title: r.title || r.original_title, year: yearOf(r.release_date) };
    } else if (data.movie_results && data.movie_results.length > 0) {
      const r = data.movie_results[0];
      result = { tmdbId: String(r.id), tmdbType: 'movie', title: r.title || r.original_title, year: yearOf(r.release_date) };
    } else if (data.tv_results && data.tv_results.length > 0) {
      const r = data.tv_results[0];
      result = { tmdbId: String(r.id), tmdbType: 'tv', title: r.name || r.original_name, year: yearOf(r.first_air_date) };
    }
    if (result) catalogCache.set(cacheKey, result, TMDB_METADATA_TTL_MS);
    return result;
  } catch (e) {
    return null;
  }
}

/**
 * Fetch romanized/Latin-script alternative titles for a TMDB movie/tv
 * entry. ShowBox often indexes foreign-language titles by a romanized
 * form (e.g. "Gisaengchung") rather than the English release title
 * ("Parasite") — searching only the English title can structurally miss
 * these and let an unrelated same-named title win instead. Uses TMDB's
 * official, documented `alternative_titles` endpoint.
 * @returns {Promise<string[]>} deduped, ASCII-only alternative titles
 */
async function getAlternativeTitles(tmdbId, tmdbType, apiKey) {
  if (!tmdbId || !apiKey) return [];
  const cacheKey = `tmdb:alt:${tmdbId}:${tmdbType}`;
  const cached = catalogCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const kind = tmdbType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE_URL}/${kind}/${tmdbId}/alternative_titles`;
  try {
    const resp = await timed('tmdb_alt_titles', () =>
      axios.get(url, { params: { api_key: apiKey }, timeout: 10000, validateStatus: () => true })
    );
    if (resp.status !== 200 || !resp.data) return [];
    const raw = resp.data.titles || resp.data.results || [];
    const isAscii = (s) => /^[\x20-\x7E]+$/.test(s || '');
    const seen = new Set();
    const out = [];
    for (const t of raw) {
      const title = (t && t.title) || '';
      if (!isAscii(title)) continue; // skip non-Latin scripts, unmatchable by string-similarity anyway
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(title);
    }
    catalogCache.set(cacheKey, out, TMDB_METADATA_TTL_MS);
    return out;
  } catch (e) {
    return [];
  }
}

/** Parse a Stremio series id `tt1234567:1:2` into {imdbId, season, episode}. */
function parseSeriesId(stremioId) {
  const parts = String(stremioId || '').split(':');
  return {
    imdbId: parts[0],
    season: parts[1] ? Number(parts[1]) : null,
    episode: parts[2] ? Number(parts[2]) : null,
  };
}

module.exports = { convertImdbToTmdb, getAlternativeTitles, parseSeriesId };
