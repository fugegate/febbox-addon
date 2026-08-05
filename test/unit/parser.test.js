'use strict';

const {
  parseQualityFromLabel,
  extractCodecDetails,
  parseSizeToBytes,
  sortStreamsByQuality,
  parseQualityListHtml,
  matchesEpisode,
} = require('../../src/providers/febbox/parser');

describe('parser', () => {
  test('parseQualityFromLabel handles common labels', () => {
    expect(parseQualityFromLabel('1080p BluRay')).toBe('1080p');
    expect(parseQualityFromLabel('4K UHD')).toBe('2160p');
    expect(parseQualityFromLabel('unknown')).toBe('ORG');
    expect(parseQualityFromLabel(null)).toBe('ORG');
  });

  test('extractCodecDetails finds codecs and audio tags', () => {
    const details = extractCodecDetails('Movie.2024.2160p.HDR10+.x265.Atmos');
    expect(details).toEqual(expect.arrayContaining(['HDR10+', 'H.265', 'Atmos']));
  });

  test('parseSizeToBytes parses GB/MB', () => {
    expect(parseSizeToBytes('1.5 GB')).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(parseSizeToBytes('unknown')).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('sortStreamsByQuality orders best quality first', () => {
    const sorted = sortStreamsByQuality([
      { quality: '720p', size: '1 GB' },
      { quality: '2160p', size: '5 GB' },
      { quality: '1080p', size: '2 GB' },
    ]);
    expect(sorted.map((s) => s.quality)).toEqual(['2160p', '1080p', '720p']);
  });

  test('parseQualityListHtml extracts data-url/data-quality from fixture', () => {
    const html = `
      <div class="file_quality" data-url="https://example.com/a.mp4" data-quality="1080p">
        <span class="name">movie.1080p.mkv</span>
        <span class="size">1.4 GB</span>
        <span class="speed"><span>10 MB/s</span></span>
      </div>
      <div class="file_quality" data-url="https://example.com/b.mp4" data-quality="720p">
        <span class="name">movie.720p.mkv</span>
      </div>
    `;
    const links = parseQualityListHtml(html);
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe('https://example.com/a.mp4');
    expect(links[0].quality).toBe('1080p');
    expect(links[0].size).toBe('1.4 GB');
  });

  test('parseQualityListHtml returns empty array for no matches', () => {
    expect(parseQualityListHtml('<div>nothing</div>')).toEqual([]);
    expect(parseQualityListHtml('')).toEqual([]);
  });

  test('matchesEpisode matches S01E02 style filenames', () => {
    expect(matchesEpisode('Show.S01E02.1080p.mkv', 1, 2)).toBe(true);
    expect(matchesEpisode('Show.S01E03.1080p.mkv', 1, 2)).toBe(false);
    expect(matchesEpisode('Show.1x02.mkv', 1, 2)).toBe(true);
  });
});
