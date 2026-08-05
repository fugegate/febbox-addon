'use strict';

const { parseQualityFromLabel } = require('../providers/febbox/parser');

/**
 * Controls how much detail is shown per stream option in Stremio's stream
 * list. Purely cosmetic — never affects which streams are resolved/offered,
 * only how `name`/`title` are formatted in toStreamObjects (routes.js).
 *
 * - 'minimal': name is just the resolution ("4K"), no title/description at
 *   all.
 * - 'balanced': name is a clean release title ("Silo S02E05" /
 *   "The Odyssey (2026)"), title is just the resolution ("4K").
 * - 'standard' (default): same clean name as balanced, title adds quality
 *   metadata (HDR/size/audio codecs) alongside the resolution — but never
 *   the raw messy filename.
 * - 'detailed': the original raw-filename-forward format, unchanged.
 */
const DISPLAY_MODE = {
  MINIMAL: 'minimal',
  BALANCED: 'balanced',
  STANDARD: 'standard',
  DETAILED: 'detailed',
};
const DEFAULT_DISPLAY_MODE = DISPLAY_MODE.STANDARD;
const DISPLAY_MODE_VALUES = new Set(Object.values(DISPLAY_MODE));

/**
 * "2160p" -> "4K", everything else passes through as-is. For FebBox's
 * direct/original ("ORG") files, `quality` alone is just the literal
 * string "ORG" — it carries no resolution info on its own. The actual
 * resolution is almost always embedded in the release filename (e.g.
 * "Silo.S03E05.2160p...mkv"), so it's detected from there instead of
 * falling back to the meaningless label "Original" whenever possible.
 * @param {string} quality
 * @param {string} [filename] - the resolved file's original filename, used
 *   only to recover a resolution for ORG-quality entries.
 */
function resolutionLabel(quality, filename) {
  let effective = quality;
  if (quality === 'ORG' && filename) {
    const detected = parseQualityFromLabel(filename);
    if (detected !== 'ORG') effective = detected;
  }
  if (effective === '2160p') return '4K';
  if (effective === 'ORG') return 'Original'; // no resolution token found anywhere — last resort
  return effective || 'Unknown';
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Builds a clean, human title for the requested item — "Silo S02E05" for
 * an episode, "The Odyssey (2026)" for a movie — used by 'balanced' and
 * 'standard' modes instead of the raw release filename.
 * @param {{title:?string, year:?number, type:'movie'|'series', season:?number, episode:?number}} info
 */
function buildCleanTitle({ title, year, type, season, episode }) {
  const safeTitle = title || 'Unknown title';
  if (type === 'series' && season != null && episode != null) {
    return `${safeTitle} S${pad2(season)}E${pad2(episode)}`;
  }
  return year ? `${safeTitle} (${year})` : safeTitle;
}

module.exports = { DISPLAY_MODE, DEFAULT_DISPLAY_MODE, DISPLAY_MODE_VALUES, resolutionLabel, buildCleanTitle };
