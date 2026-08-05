'use strict';

/**
 * Problem A — ShowBox catalog search + FebBox share-key resolution.
 *
 * See docs/CATALOG_DISCOVERY_RESEARCH.md for the full research trail.
 *
 * This uses exactly two plain, anonymous, unauthenticated HTTP endpoints on
 * `www.showbox.media`, both server-rendered for any ordinary web browser:
 *
 *  1. `GET /search?keyword=<title>` — a normal HTML search results page.
 *     Parsed with cheerio (already a dependency) to pull `/movie/m-...` and
 *     `/tv/t-...` result links. No JS execution, no crypto, no app
 *     credentials required — this is the same page a person would see.
 *  2. `GET /<matched result page>` — the movie/show detail page. The page's
 *     own inline `<script>` embeds a literal `$.ajax({url:'/index/share_link',
 *     data:{'id':<N>,'type':<1|2>}})` call (1=movie, 2=tv-show-level). We
 *     extract that literal `id`/`type` pair with a regex — it is static
 *     markup on a public page, not a derived/forged credential.
 *  3. `GET /index/share_link?id=<N>&type=<1|2>` — returns the FebBox share
 *     URL for that ShowBox entry as plain JSON.
 *
 * All three are live-tested (see docs/CATALOG_DISCOVERY_RESEARCH.md):
 * plain HTTP 200, no Cloudflare/CAPTCHA challenge, no interactive gate.
 *
 * Deliberately NOT used: ShowBox's mobile-app API (`mbpapi.shegu.net`),
 * which requires a reverse-engineered 3DES scheme and hardcoded keys
 * extracted from decompiling the official Android app. That scheme exists
 * to authenticate the app's own API traffic (the same crypto has been used
 * in an unrelated public write-up to attack the app's session/account
 * auth) — using it to mint requests is access-control circumvention, not a
 * plain public request, so it is excluded even though it also "works".
 *
 * For TV, `type=2` returns a share for the *entire show* (all seasons as
 * folders/files), not a single episode — Problems B/C (already built:
 * `resolver.resolveEpisode`) then list that share's files and match the
 * requested season/episode by filename. This is intentional: there is no
 * separate per-episode ShowBox id/share in this mechanism.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const stringSimilarity = require('string-similarity');
const { redactError } = require('../../security/redact');
const { catalogCache } = require('../../cache/ttlCache');
const { incrementCounter, timed, METRIC } = require('../../metrics/metrics');

const SHOWBOX_ORIGIN = 'https://www.showbox.media';
const FEBBOX_ORIGIN = 'https://www.febbox.com';
const ALLOWED_HOSTS = new Set(['www.showbox.media']);
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Separate TTLs per cached artifact — deliberately not one blended cache:
// search results churn fastest (ShowBox catalog changes), the chosen
// content id for a title is more stable, and share links are the most
// volatile (FebBox shares can be deleted/rotated independently of the
// underlying ShowBox entry). None of these ever hold a user token.
const SEARCH_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const CONTENT_ID_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const SHARE_LINK_TTL_MS = 2 * 60 * 60 * 1000; // 2h — shares are the most likely to go stale

function assertAllowedUrl(url) {
  const u = new URL(url);
  if (!ALLOWED_HOSTS.has(u.host)) {
    throw new Error(`Refusing to contact non-allowlisted host: ${u.host}`);
  }
  return u;
}

// ShowBox `type` param on /index/share_link: 1 = movie, 2 = tv show.
const BOX_TYPE = { movie: 1, tv: 2 };

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Free-text search against ShowBox's public HTML search page. Not a TMDB/
 * IMDb lookup by ID — results must be fuzzy-matched by the caller.
 * @returns {Promise<Array<{title:string, year:?number, tmdbType:'movie'|'tv', path:string}>>}
 */
async function search(title, { timeout = 12000 } = {}) {
  if (!title || typeof title !== 'string') return [];
  const cacheKey = `sbsearch:${normalizeTitle(title)}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) return cached;

  const url = `${SHOWBOX_ORIGIN}/search`;
  assertAllowedUrl(url);
  let resp;
  try {
    resp = await timed('showbox_search', () =>
      axios.get(url, {
        params: { keyword: title },
        timeout,
        validateStatus: () => true,
        headers: { 'User-Agent': USER_AGENT },
      })
    );
  } catch (err) {
    return [];
  }
  if (resp.status !== 200 || typeof resp.data !== 'string') return [];

  const $ = cheerio.load(resp.data);
  const results = [];
  $('a[href^="/movie/"], a[href^="/tv/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/^\/(movie|tv)\/(m|t)-(.+?)-(\d{4})$/);
    if (!m) return;
    const [, kind, , slugTitle, yearStr] = m;
    if (results.some((r) => r.path === href)) return; // de-dupe repeated links to the same result
    results.push({
      title: slugTitle.replace(/-/g, ' '),
      year: Number(yearStr) || null,
      tmdbType: kind === 'tv' ? 'tv' : 'movie',
      path: href,
    });
  });
  catalogCache.set(cacheKey, results, SEARCH_TTL_MS);
  return results;
}

/**
 * Score a single ShowBox candidate against the caller's TMDB title/year.
 * Exported so callers (and the reliability test harness) can see the
 * confidence behind a match, not just the winning candidate.
 */
function computeMatchScore(candidateTitle, candidateYear, { title, year }) {
  const targetTitle = normalizeTitle(title);
  const normCandidate = normalizeTitle(candidateTitle);
  if (!normCandidate) return 0;
  let score = stringSimilarity.compareTwoStrings(targetTitle, normCandidate);
  if (year && candidateYear) {
    const diff = Math.abs(Number(candidateYear) - Number(year));
    if (diff === 0) {
      score += 0.15; // exact year match strongly boosts confidence
    } else if (diff === 1) {
      // Off-by-one is common and usually NOT a different film: ShowBox
      // often catalogs a title under its festival/production year while
      // TMDB reports the wide-release year (confirmed live: TMDB listed
      // a 2026 release that ShowBox had cataloged as 2025, and the
      // correct match was wrongly rejected by an earlier, harsher
      // version of this penalty before this was caught by manual
      // testing across several real titles). Small penalty only.
      score -= 0.05;
    } else {
      // Any larger mismatch penalizes heavily — remakes/sequels sharing
      // an identical title are exactly the case this must disambiguate.
      // -0.35 is deliberately harsh: it pushes even a perfect (1.0)
      // title-string match on the wrong year below MIN_SCORE, so a
      // same-titled wrong-year film cannot win over a correct match
      // found via a fallback (e.g. original-language) title query.
      score -= 0.35;
    }
  }
  return score;
}

// Require reasonably high title similarity before trusting a match — this
// is fuzzy matching against a free-text search, not an ID lookup, so false
// positives are the main risk. Shared by pickBestMatch and pickRankedMatches
// so "confidence above the strict threshold" means the same thing everywhere.
const MIN_SCORE = 0.72;

/**
 * Pick the best ShowBox search result for a given TMDB title/year/type.
 * Returns null if nothing clears the similarity threshold.
 */
function pickBestMatch(results, { title, year, tmdbType }) {
  const ranked = pickRankedMatches(results, { title, year, tmdbType });
  return ranked.length > 0 ? ranked[0].candidate : null;
}

/**
 * Rank all ShowBox search results that clear MIN_SCORE against the given
 * TMDB title/year/type, best first. Used so a caller can fall through to
 * the next-best candidate (e.g. when the top candidate's FebBox share
 * turns out to be dead/stale) without ever falling below the same
 * media-type + year + confidence bar a single-candidate match would need.
 * @returns {Array<{candidate:object, score:number}>}
 */
function pickRankedMatches(results, { title, year, tmdbType }) {
  if (!Array.isArray(results) || results.length === 0) return [];
  const wantType = tmdbType === 'tv' ? 'tv' : 'movie';
  const scored = [];
  for (const r of results) {
    if (!r || r.tmdbType !== wantType) continue; // media type must match
    const score = computeMatchScore(r.title, r.year, { title, year });
    if (score >= MIN_SCORE) scored.push({ candidate: r, score }); // year (via score) + confidence must clear the bar
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Fetch a ShowBox detail page and extract its literal
 * `{'id':N,'type':1|2}` share_link ajax params from the page's own markup.
 */
async function getShowboxIdAndType(path, { timeout = 12000 } = {}) {
  const cacheKey = `sbid:${path}`;
  const cached = catalogCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${SHOWBOX_ORIGIN}${path}`;
  assertAllowedUrl(url);
  let resp;
  try {
    resp = await timed('showbox_detail', () =>
      axios.get(url, {
        timeout,
        validateStatus: () => true,
        headers: { 'User-Agent': USER_AGENT },
      })
    );
  } catch (err) {
    return null;
  }
  if (resp.status !== 200 || typeof resp.data !== 'string') return null;
  const m = resp.data.match(/url:\s*'\/index\/share_link'[\s\S]{0,120}?data:\s*\{\s*'id':\s*(\d+)\s*,\s*'type':\s*(\d)\s*\}/);
  const result = m ? { showboxId: m[1], boxType: Number(m[2]) } : null;
  catalogCache.set(cacheKey, result, CONTENT_ID_TTL_MS);
  return result;
}

/**
 * Given a ShowBox internal id + box type, fetch the FebBox share URL and
 * return just the share key (last path segment). Cached with a shorter TTL
 * than the content id — share links are the part most likely to rotate or
 * go stale independently of the underlying ShowBox entry.
 */
async function getFebBoxShareKey(showboxId, boxType, { timeout = 12000, skipCache = false } = {}) {
  const cacheKey = `sblink:${showboxId}:${boxType}`;
  if (!skipCache) {
    const cached = catalogCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const url = `${SHOWBOX_ORIGIN}/index/share_link`;
  assertAllowedUrl(url);
  let resp;
  try {
    resp = await timed('showbox_share_link', () =>
      axios.get(url, {
        params: { id: showboxId, type: boxType },
        timeout,
        validateStatus: () => true,
        headers: { 'User-Agent': USER_AGENT, 'X-Requested-With': 'XMLHttpRequest' },
      })
    );
  } catch (err) {
    return null;
  }
  if (resp.status !== 200 || !resp.data || resp.data.code !== 1) return null;
  const link = resp.data.data && resp.data.data.link;
  if (!link || typeof link !== 'string') return null;
  const key = link.split('/').filter(Boolean).pop() || null;
  catalogCache.set(cacheKey, key, SHARE_LINK_TTL_MS);
  return key;
}

/**
 * Check whether a FebBox share is still alive — a lightweight, anonymous
 * (no token) GET of the share's own public page. FebBox shares can be
 * deleted or rotated independently of the ShowBox entry that pointed at
 * them; `share_link` returning 200 only proves ShowBox still has a share
 * key on file, not that the share itself still resolves.
 */
async function isShareAlive(shareKey, { timeout = 8000 } = {}) {
  if (!shareKey) return false;
  const url = `${FEBBOX_ORIGIN}/share/${encodeURIComponent(shareKey)}`;
  try {
    const resp = await timed('febbox_share_liveness', () =>
      axios.get(url, { timeout, validateStatus: () => true, headers: { 'User-Agent': USER_AGENT } })
    );
    return resp.status === 200;
  } catch (err) {
    return false;
  }
}

/**
 * Resolve a FebBox share key for a TMDB-identified title.
 *
 * Foreign-language titles are frequently indexed on ShowBox under a
 * romanized/original title rather than the English TMDB title (e.g.
 * "Gisaengchung" rather than "Parasite") — searching only the English
 * title can structurally fail to find the right entry and let an
 * unrelated same-named title win instead. If the primary title search
 * finds no confident match, each of `tmdbInfo.altTitles` (if supplied) is
 * tried in turn as a fallback query.
 *
 * Within each query, candidates are tried in ranked order (best score
 * first) rather than stopping at the single best match: if the top
 * candidate's FebBox share turns out to be dead or stale
 * (`isShareAlive` fails), the next candidate is tried — but ONLY among
 * candidates that already cleared `pickRankedMatches`' bar, meaning media
 * type already matched, year already matched (within the scoring
 * tolerance), and confidence was already above `MIN_SCORE`. A dead top
 * share never causes a fall-through to a lower-confidence or wrong-type/
 * wrong-year candidate — it only tries the next candidate that was
 * already independently confident enough to win on its own.
 *
 * @param {{tmdbId:string, tmdbType:'movie'|'tv', title:string, year:?number, altTitles?:string[]}} tmdbInfo
 * @returns {Promise<?string>} FebBox share key, or null if no confident, live match was found.
 */
async function resolveShareKeyForTitle(tmdbInfo) {
  if (!tmdbInfo || !tmdbInfo.title) return null;
  try {
    const queries = [tmdbInfo.title, ...((tmdbInfo.altTitles || []).filter((t) => t && t !== tmdbInfo.title))];
    for (const query of queries) {
      // eslint-disable-next-line no-await-in-loop
      const results = await search(query);
      // Score against the query variant itself (English title, or the
      // romanized/alternative title on later fallback passes) — a
      // foreign-film ShowBox entry is titled in its own script/romanization,
      // not the canonical English TMDB title, so scoring against the fixed
      // English title would always fail to match it. Year is still taken
      // from canonical TMDB data, which doesn't vary by title variant.
      const ranked = pickRankedMatches(results, { title: query, year: tmdbInfo.year, tmdbType: tmdbInfo.tmdbType });

      for (const { candidate } of ranked) {
        // eslint-disable-next-line no-await-in-loop
        const idInfo = await getShowboxIdAndType(candidate.path);
        if (!idInfo) continue;
        // eslint-disable-next-line no-await-in-loop
        let shareKey = await getFebBoxShareKey(idInfo.showboxId, idInfo.boxType);
        if (!shareKey) continue;
        // eslint-disable-next-line no-await-in-loop
        let alive = await isShareAlive(shareKey);
        if (!alive) {
          // Cached share_link result may itself be stale (FebBox rotated
          // the share since we cached it) — evict and re-fetch once
          // before giving up on this candidate entirely.
          incrementCounter(METRIC.STALE_SHARE);
          catalogCache.del(`sblink:${idInfo.showboxId}:${idInfo.boxType}`);
          // eslint-disable-next-line no-await-in-loop
          shareKey = await getFebBoxShareKey(idInfo.showboxId, idInfo.boxType, { skipCache: true });
          if (shareKey) {
            // eslint-disable-next-line no-await-in-loop
            alive = await isShareAlive(shareKey);
          }
        }
        if (shareKey && alive) {
          incrementCounter(METRIC.DISCOVERY_SUCCESS);
          return shareKey;
        }
        // This candidate is dead even after a refresh attempt — fall
        // through to the next ranked candidate (still same type/year/
        // confidence bar), not a lower-confidence guess.
      }
    }
    incrementCounter(METRIC.DISCOVERY_MISS);
    return null;
  } catch (err) {
    redactError(err);
    incrementCounter(METRIC.DISCOVERY_MISS);
    return null;
  }
}

module.exports = {
  search,
  pickBestMatch,
  pickRankedMatches,
  computeMatchScore,
  getShowboxIdAndType,
  getFebBoxShareKey,
  isShareAlive,
  resolveShareKeyForTitle,
  BOX_TYPE,
};
