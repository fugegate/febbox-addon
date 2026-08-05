'use strict';

const cheerio = require('cheerio');

/** Parse a normalized quality label ("1080p", "720p", ...) from free text. Ported from server.js. */
function parseQualityFromLabel(label) {
  if (!label) return 'ORG';
  const l = String(label).toLowerCase();
  if (l.includes('2160p') || l.includes('2160') || l.includes('4k') || l.includes('uhd')) return '2160p';
  if (l.includes('1080p') || l.includes('1080')) return '1080p';
  if (l.includes('720p') || l.includes('720')) return '720p';
  if (l.includes('480p') || l.includes('480')) return '480p';
  if (l.includes('360p') || l.includes('360')) return '360p';
  if (l.includes('hd')) return '720p';
  if (l.includes('sd')) return '480p';
  return 'ORG';
}

/** Extract codec/audio tags from a filename or version string. Ported from server.js. */
function extractCodecDetails(text) {
  if (!text || typeof text !== 'string') return [];
  const details = new Set();
  const l = text.toLowerCase();

  if (l.includes('dolby vision') || l.includes('dovi') || l.includes('.dv.')) details.add('DV');
  if (l.includes('hdr10+') || l.includes('hdr10plus')) details.add('HDR10+');
  else if (l.includes('hdr')) details.add('HDR');
  if (l.includes('sdr')) details.add('SDR');

  if (l.includes('av1')) details.add('AV1');
  else if (l.includes('h265') || l.includes('x265') || l.includes('hevc')) details.add('H.265');
  else if (l.includes('h264') || l.includes('x264') || l.includes('avc')) details.add('H.264');

  if (l.includes('atmos')) details.add('Atmos');
  if (l.includes('truehd') || l.includes('true-hd')) details.add('TrueHD');
  if (l.includes('dts-hd ma') || l.includes('dtshdma')) details.add('DTS-HD MA');
  else if (l.includes('dts-hd')) details.add('DTS-HD');
  else if (l.includes('dts')) details.add('DTS');

  if (l.includes('eac3') || l.includes('e-ac-3') || l.includes('dd+') || l.includes('ddplus')) details.add('EAC3');
  else if (l.includes('ac3') || (l.includes('dd') && !l.includes('dd+'))) details.add('AC3');

  if (l.includes('aac')) details.add('AAC');
  if (l.includes('opus')) details.add('Opus');
  if (l.includes('mp3')) details.add('MP3');

  if (l.includes('10bit') || l.includes('10-bit')) details.add('10-bit');
  else if (l.includes('8bit') || l.includes('8-bit')) details.add('8-bit');

  return Array.from(details);
}

/** Parse a human size string ("1.2 GB") to bytes, MAX_SAFE_INTEGER if unknown (sorts last). */
function parseSizeToBytes(sizeString) {
  if (!sizeString || typeof sizeString !== 'string') return Number.MAX_SAFE_INTEGER;
  const s = sizeString.toLowerCase();
  if (s.includes('unknown') || s.includes('n/a')) return Number.MAX_SAFE_INTEGER;
  const units = { gb: 1024 ** 3, mb: 1024 ** 2, kb: 1024, b: 1 };
  const match = s.match(/([\d.]+)\s*(gb|mb|kb|b)/);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = units[match[2]];
    if (!Number.isNaN(value) && unit) return Math.floor(value * unit);
  }
  return Number.MAX_SAFE_INTEGER;
}

const QUALITY_ORDER = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3, '360p': 4, ORG: 5 };

/** Sort streams best-quality (and largest size) first. */
function sortStreamsByQuality(streams) {
  return [...streams].sort((a, b) => {
    const oa = QUALITY_ORDER[a.quality] ?? 10;
    const ob = QUALITY_ORDER[b.quality] ?? 10;
    if (oa !== ob) return oa - ob;
    return parseSizeToBytes(b.size) - parseSizeToBytes(a.size);
  });
}

/**
 * Parse the `.file_quality` HTML fragment returned by
 * /console/video_quality_list into structured link objects. Problem C.
 * @param {string} html
 * @returns {Array<{url:string, quality:string, name?:string, size?:string, speed?:string}>}
 */
function parseQualityListHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const $ = cheerio.load(html);
  const out = [];
  $('.file_quality').each((_, el) => {
    const $el = $(el);
    const url = $el.attr('data-url');
    if (!url) return;
    out.push({
      url,
      quality: parseQualityFromLabel($el.attr('data-quality') || $el.find('.name').text()),
      name: $el.find('.name').text().trim() || undefined,
      size: $el.find('.size').text().trim() || undefined,
      speed: $el.find('.speed span').text().trim() || undefined,
    });
  });
  return out;
}

/** Match a filename against a season/episode pattern (S01E02, 1x02). Ported/simplified from addon.js conventions. */
function matchesEpisode(filename, season, episode) {
  if (!filename || season == null || episode == null) return false;
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const patterns = [
    new RegExp(`s${s}e${e}`, 'i'),
    new RegExp(`\\b${Number(season)}x${e}\\b`, 'i'),
    new RegExp(`season\\s*${Number(season)}.*episode\\s*${Number(episode)}`, 'i'),
  ];
  return patterns.some((re) => re.test(filename));
}

module.exports = {
  parseQualityFromLabel,
  extractCodecDetails,
  parseSizeToBytes,
  sortStreamsByQuality,
  parseQualityListHtml,
  matchesEpisode,
};
