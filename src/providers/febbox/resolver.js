'use strict';

const client = require('./client');
const { parseQualityListHtml, extractCodecDetails, sortStreamsByQuality, parseSizeToBytes, matchesEpisode } = require('./parser');
const { FebBoxError } = require('./types');
const { validateDirectUrl } = require('./urlValidate');

/**
 * Playback modes:
 * - 'direct' (default): only FebBox's direct, non-HLS "ORG" links are
 *   returned, each verified live (protocol/extension/Content-Type/host)
 *   before being offered. Confirmed to play and seek correctly in
 *   Stremio's web client.
 * - 'experimental-hls' (opt-in): only FebBox's transcoded HLS quality
 *   tiers (1080p/720p/360p/2160p) are returned — original, UNMODIFIED
 *   .m3u8 URLs, never rewritten, proxied, or transcoded. Confirmed via
 *   manual testing in Stremio's web client to stall or seek incorrectly
 *   (Stremio's local HLS engine appears to assume a ~4s segment duration
 *   when estimating seek targets; FebBox's real segments are ~10.4s,
 *   causing it to request segment indices far past the end of the
 *   stream). Not something this addon can fix without proxying/
 *   re-transcoding video, which is explicitly out of scope.
 * - 'both' (opt-in): direct links AND HLS tiers together, direct ones
 *   listed first. For users who want the safer direct option available
 *   but also want to try the (more, smaller-file-size) HLS quality tiers.
 */
const PLAYBACK_MODE = { DIRECT: 'direct', EXPERIMENTAL_HLS: 'experimental-hls', BOTH: 'both' };
const DEFAULT_PLAYBACK_MODE = PLAYBACK_MODE.DIRECT;
const PLAYBACK_MODE_VALUES = new Set(Object.values(PLAYBACK_MODE));
const INCLUDES_DIRECT = new Set([PLAYBACK_MODE.DIRECT, PLAYBACK_MODE.BOTH]);
const INCLUDES_HLS = new Set([PLAYBACK_MODE.EXPERIMENTAL_HLS, PLAYBACK_MODE.BOTH]);

const MAX_RECURSION_DEPTH = 4; // guard against pathological folder nesting
const REQUEST_SPACING_MS = 250; // small pacing between sequential FebBox calls to avoid tripping burst rate limits

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Recursively list files under a share, up to MAX_RECURSION_DEPTH.
 * @returns {Promise<Array<{fid:string,name:string,isDir:boolean,size:?string}>>}
 */
async function listAllFiles({ token, shareKey }, parentId = 0, depth = 0) {
  if (depth > MAX_RECURSION_DEPTH) return [];
  const entries = await client.listShareFiles({ token, shareKey, parentId });
  let all = [];
  for (const entry of entries) {
    if (entry.isDir) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(REQUEST_SPACING_MS);
      // eslint-disable-next-line no-await-in-loop
      all = all.concat(await listAllFiles({ token, shareKey }, entry.fid, depth + 1));
    } else {
      all.push(entry);
    }
  }
  return all;
}

/**
 * List only the top-level entries of a share (one request, no recursion).
 */
async function listTopLevel({ token, shareKey }) {
  return client.listShareFiles({ token, shareKey, parentId: 0 });
}

function isHlsUrl(url) {
  return /\.m3u8(\?|$)/i.test(url || '');
}

function toStream(l, fileName, { isHls }) {
  const sizeBytes = parseSizeToBytes(l.size);
  return {
    url: l.url,
    quality: l.quality,
    size: l.size,
    videoSizeBytes: Number.isFinite(sizeBytes) && sizeBytes < Number.MAX_SAFE_INTEGER ? sizeBytes : undefined,
    codecs: extractCodecDetails(fileName || l.name || ''),
    filename: fileName || l.name || 'video',
    provider: 'FebBox',
    isHls,
  };
}

/** Direct entries first (in quality order), HLS entries (if any) after. */
function sortWithDirectFirst(streams) {
  const direct = sortStreamsByQuality(streams.filter((s) => !s.isHls));
  const hls = sortStreamsByQuality(streams.filter((s) => s.isHls));
  return [...direct, ...hls];
}

/**
 * Resolve a single file id to a list of quality-labeled stream objects.
 * Direct (non-HLS) links are validated live (see urlValidate.js) before
 * being included — a link that fails validation is dropped rather than
 * offered as a working stream. Which link types are included at all
 * depends on `playbackMode` — see the PLAYBACK_MODE doc comment above.
 */
async function resolveFileStreams({ token, shareKey, fid, fileName, playbackMode = DEFAULT_PLAYBACK_MODE }) {
  const html = await client.getVideoQualityLinks({ token, shareKey, fid });
  const allLinks = parseQualityListHtml(html);
  const directCandidates = allLinks.filter((l) => !isHlsUrl(l.url));
  const hlsCandidates = allLinks.filter((l) => isHlsUrl(l.url));

  const streams = [];
  if (INCLUDES_DIRECT.has(playbackMode)) {
    for (const l of directCandidates) {
      // eslint-disable-next-line no-await-in-loop
      const check = await validateDirectUrl(l.url);
      if (check.valid) streams.push(toStream(l, fileName, { isHls: false }));
    }
  }

  if (INCLUDES_HLS.has(playbackMode)) {
    // Note: HLS entries (including HEVC-coded renditions like 2160p) are
    // offered as-is, unfiltered — HEVC is known to fail on some Stremio
    // clients (black screen, audio-only), but per explicit product
    // decision the quality option is still surfaced rather than hidden.
    for (const l of hlsCandidates) {
      streams.push(toStream(l, fileName, { isHls: true }));
    }
  }

  if (streams.length === 0) {
    throw new FebBoxError('No playable sources returned for this file', 'NOT_FOUND');
  }
  return sortWithDirectFirst(streams);
}

/**
 * Movie: a share is expected to directly contain (or contain a single top
 * level folder with) one or more video files. We take all non-dir files
 * found and resolve each to quality links, then merge/sort.
 */
async function resolveMovie({ token, shareKey, playbackMode = DEFAULT_PLAYBACK_MODE }) {
  const files = await listAllFiles({ token, shareKey });
  const videoFiles = files.filter((f) => isLikelyVideo(f.name));
  if (videoFiles.length === 0) {
    throw new FebBoxError('No video files found in this FebBox share', 'NOT_FOUND');
  }
  const results = [];
  for (const f of videoFiles) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const streams = await resolveFileStreams({ token, shareKey, fid: f.fid, fileName: f.name, playbackMode });
      results.push(...streams);
    } catch (err) {
      // Skip files that fail to resolve individually; don't fail the whole request.
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(REQUEST_SPACING_MS);
  }
  return sortWithDirectFirst(results);
}

const SEASON_FOLDER_RE = /season[^0-9]{0,3}0*(\d+)\b/i;

/**
 * Series: find the requested season's file(s) and resolve the matching
 * episode. Rather than recursively listing every season's files just to
 * discard everything but one episode (expensive and rate-limit-prone on
 * large shows), this first lists only the share's top level: if a
 * `season N` folder matching the request is found, only that folder is
 * recursed into. Falls back to a full recursive scan (previous behaviour)
 * when the share doesn't use recognizable season folders (flat share, or
 * unusual naming) so nothing regresses.
 */
async function resolveEpisode({ token, shareKey, season, episode, playbackMode = DEFAULT_PLAYBACK_MODE }) {
  const top = await listTopLevel({ token, shareKey });
  const seasonFolder = top.find((e) => {
    if (!e.isDir) return false;
    const m = SEASON_FOLDER_RE.exec(e.name || '');
    return m && Number(m[1]) === Number(season);
  });

  let videoFiles;
  if (seasonFolder) {
    const files = await listAllFiles({ token, shareKey }, seasonFolder.fid, 1);
    videoFiles = files.filter((f) => isLikelyVideo(f.name));
  } else {
    // No recognizable season folder — fall back to a full scan (covers
    // flat shares, single-season shows with files at top level, etc.)
    const files = await listAllFiles({ token, shareKey });
    videoFiles = files.filter((f) => isLikelyVideo(f.name));
  }

  const matches = videoFiles.filter((f) => matchesEpisode(f.name, season, episode));
  if (matches.length === 0) {
    throw new FebBoxError(
      `No files matching S${season}E${episode} found in this FebBox share`,
      'NOT_FOUND'
    );
  }
  const results = [];
  for (const f of matches) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const streams = await resolveFileStreams({ token, shareKey, fid: f.fid, fileName: f.name, playbackMode });
      results.push(...streams);
    } catch (err) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(REQUEST_SPACING_MS);
  }
  return sortWithDirectFirst(results);
}

function isLikelyVideo(name) {
  return /\.(mp4|mkv|avi|mov|webm|m3u8|ts)$/i.test(String(name || ''));
}

/** Extract a share key from a full FebBox share URL, or pass through if already a key. */
function extractShareKey(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  const m = trimmed.match(/febbox\.com\/share\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{4,40}$/.test(trimmed)) return trimmed;
  return null;
}

module.exports = {
  resolveMovie,
  resolveEpisode,
  resolveFileStreams,
  listAllFiles,
  extractShareKey,
  isLikelyVideo,
  isHlsUrl,
  sortWithDirectFirst,
  PLAYBACK_MODE,
  DEFAULT_PLAYBACK_MODE,
  PLAYBACK_MODE_VALUES,
};
