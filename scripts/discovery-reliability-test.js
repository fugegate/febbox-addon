'use strict';

/**
 * Live discovery reliability test across a fixed set of real titles:
 * movies, TV episodes across different shows, same-title remakes, and
 * foreign-language titles. Prints only sanitized fields — no tokens,
 * share keys, full playback URLs, cookies, or signed query strings.
 *
 * Requires FEBBOX_UI_TOKEN and TMDB_API_KEY as env vars. Never logs them.
 *
 *   FEBBOX_UI_TOKEN=<token> TMDB_API_KEY=<key> node scripts/discovery-reliability-test.js
 */

const https = require('https');
const { URL } = require('url');

const token = process.env.FEBBOX_UI_TOKEN;
const tmdbKey = process.env.TMDB_API_KEY;

if (!token || !tmdbKey) {
  console.error('FEBBOX_UI_TOKEN and TMDB_API_KEY must both be set.');
  process.exit(1);
}

const tmdb = require('../src/metadata/tmdb');
const catalog = require('../src/providers/febbox/catalog');
const resolver = require('../src/providers/febbox/resolver');

function probe(rawUrl) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      return resolve(null);
    }
    const req = https.request(
      u,
      { method: 'GET', headers: { Range: 'bytes=0-1023' }, timeout: 15000 },
      (res) => {
        res.destroy();
        resolve(res.statusCode);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Test set. Season/episode only set for series cases.
const CASES = [
  // 8 movies
  { imdbId: 'tt1375666', kind: 'movie', label: 'movie-1' },
  { imdbId: 'tt0468569', kind: 'movie', label: 'movie-2' },
  { imdbId: 'tt0111161', kind: 'movie', label: 'movie-3' },
  { imdbId: 'tt0137523', kind: 'movie', label: 'movie-4' },
  { imdbId: 'tt0109830', kind: 'movie', label: 'movie-5' },
  { imdbId: 'tt0133093', kind: 'movie', label: 'movie-6' },
  { imdbId: 'tt0110912', kind: 'movie', label: 'movie-7' },
  { imdbId: 'tt0068646', kind: 'movie', label: 'movie-8' },
  // 8 TV episodes across different shows
  { imdbId: 'tt0903747', kind: 'series', season: 1, episode: 1, label: 'tv-1' },
  { imdbId: 'tt0944947', kind: 'series', season: 1, episode: 1, label: 'tv-2' },
  { imdbId: 'tt2861424', kind: 'series', season: 1, episode: 1, label: 'tv-3' },
  { imdbId: 'tt1520211', kind: 'series', season: 1, episode: 1, label: 'tv-4' },
  { imdbId: 'tt0108778', kind: 'series', season: 1, episode: 1, label: 'tv-5' },
  { imdbId: 'tt0386676', kind: 'series', season: 1, episode: 1, label: 'tv-6' },
  { imdbId: 'tt4574334', kind: 'series', season: 1, episode: 1, label: 'tv-7' },
  { imdbId: 'tt0417299', kind: 'series', season: 1, episode: 1, label: 'tv-8' },
  // 2 remakes with identical/similar titles (same-title, different year)
  { imdbId: 'tt0110357', kind: 'movie', label: 'remake-1a (Lion King 1994)' },
  { imdbId: 'tt6105098', kind: 'movie', label: 'remake-1b (Lion King 2019)' },
  // 2 foreign-language titles
  { imdbId: 'tt6751668', kind: 'movie', label: 'foreign-1 (Parasite, ko)' },
  { imdbId: 'tt1675434', kind: 'movie', label: 'foreign-2 (Intouchables, fr)' },
];

async function runCase(c) {
  const row = {
    label: c.label,
    requestedId: c.season ? `${c.imdbId}:${c.season}:${c.episode}` : c.imdbId,
    expected: null,
    matched: null,
    score: null,
    shareFound: false,
    filesFound: 0,
    episodeIsolated: c.season ? false : 'n/a',
    probeStatus: null,
    verdict: 'FAIL',
  };

  const tmdbType = c.kind === 'series' ? 'series' : 'movie';
  const tmdbInfo = await tmdb.convertImdbToTmdb(c.imdbId, tmdbType, tmdbKey);
  if (!tmdbInfo) {
    row.expected = 'TMDB_LOOKUP_FAILED';
    return row;
  }
  row.expected = `${tmdbInfo.title} (${tmdbInfo.year}, ${tmdbInfo.tmdbType})`;

  const altTitles = await tmdb.getAlternativeTitles(tmdbInfo.tmdbId, tmdbInfo.tmdbType, tmdbKey);
  const queries = [tmdbInfo.title, ...altTitles.filter((t) => t && t !== tmdbInfo.title)];
  let match = null;
  let matchedQuery = null;
  for (const query of queries) {
    // eslint-disable-next-line no-await-in-loop
    const results = await catalog.search(query);
    const candidate = catalog.pickBestMatch(results, { title: query, year: tmdbInfo.year, tmdbType: tmdbInfo.tmdbType });
    if (candidate) {
      match = candidate;
      matchedQuery = query;
      break;
    }
  }
  if (!match) {
    row.matched = 'NO_MATCH';
    return row;
  }
  const score = catalog.computeMatchScore(match.title, match.year, { title: matchedQuery, year: tmdbInfo.year });
  row.matched = `${match.title} (${match.year}, ${match.tmdbType})${matchedQuery !== tmdbInfo.title ? ` [via alt title "${matchedQuery}"]` : ''}`;
  row.score = Number(score.toFixed(3));

  const idInfo = await catalog.getShowboxIdAndType(match.path);
  if (!idInfo) {
    row.error = 'NO_ID_ON_DETAIL_PAGE';
    return row;
  }
  const shareKey = await catalog.getFebBoxShareKey(idInfo.showboxId, idInfo.boxType);
  if (!shareKey) {
    row.error = 'SHARE_LINK_FAILED';
    return row;
  }
  row.shareFound = true;

  const withRetry = async (fn) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await fn();
      } catch (err) {
        if (err.code === 'RATE_LIMITED' && attempt < 3) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 12000 * attempt)); // back off hard: 12s, then 24s
          continue;
        }
        throw err;
      }
    }
  };

  try {
    if (c.kind === 'movie') {
      const files = await withRetry(() => resolver.listAllFiles({ token, shareKey }));
      const videoFiles = files.filter((f) => resolver.isLikelyVideo(f.name));
      row.filesFound = videoFiles.length;
      if (videoFiles.length === 0) return row;
      const streams = await withRetry(() => resolver.resolveMovie({ token, shareKey }));
      if (streams.length === 0) return row;
      row.probeStatus = await probe(streams[0].url);
    } else {
      // Note: deliberately NOT doing a separate full-recursive listAllFiles()
      // call here just to report a count — resolveEpisode() already lists
      // only the matching season's folder internally (see resolver.js), and
      // duplicating a full-show scan on top of that is exactly the kind of
      // avoidable request volume that was tripping FebBox's rate limiting
      // during earlier runs of this harness on large multi-season shows.
      const streams = await withRetry(() => resolver.resolveEpisode({ token, shareKey, season: c.season, episode: c.episode }));
      const seasonEpRegex = new RegExp(`s0*${c.season}e0*${c.episode}\\b`, 'i');
      row.episodeIsolated = streams.length > 0 && streams.every((s) => seasonEpRegex.test(s.filename || ''));
      row.filesFound = new Set(streams.map((s) => s.filename)).size; // distinct matched episode files (not whole-show count)
      if (streams.length === 0) return row;
      row.probeStatus = await probe(streams[0].url);
    }
  } catch (err) {
    row.error = err.code || 'ERROR';
    return row;
  }

  const titleOk = row.score !== null && row.score >= 0.72;
  const probeOk = row.probeStatus && row.probeStatus < 400;
  const episodeOk = c.season ? row.episodeIsolated === true : true;
  row.verdict = titleOk && row.shareFound && row.filesFound > 0 && probeOk && episodeOk ? 'PASS' : 'FAIL';
  return row;
}

async function main() {
  const rows = [];
  for (const c of CASES) {
    // Sequential, with a pause between cases — avoid hammering
    // showbox.media/febbox.com (each case makes 4-6 requests across two
    // hosts) and avoid transient failures being misread as bad matches.
    // eslint-disable-next-line no-await-in-loop
    const row = await runCase(c);
    rows.push(row);
    console.log(
      `[${row.label}] req=${row.requestedId} expected="${row.expected}" matched="${row.matched}" ` +
      `score=${row.score} shareFound=${row.shareFound} filesFound=${row.filesFound} ` +
      `episodeIsolated=${row.episodeIsolated} probeStatus=${row.probeStatus}` +
      `${row.error ? ` error=${row.error}` : ''} verdict=${row.verdict}`
    );
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 6000));
  }

  const failed = rows.filter((r) => r.verdict === 'FAIL');
  console.log('');
  console.log(`SUMMARY: ${rows.length - failed.length}/${rows.length} passed`);
  if (failed.length > 0) {
    console.log('FAILED CASES:', failed.map((r) => r.label).join(', '));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('FATAL:', err.code || err.message);
  process.exitCode = 1;
});
