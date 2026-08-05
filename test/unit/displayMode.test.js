'use strict';

const { resolutionLabel, buildCleanTitle, DISPLAY_MODE_VALUES, DEFAULT_DISPLAY_MODE } = require('../../src/stremio/displayMode');

describe('displayMode', () => {
  test('resolutionLabel maps 2160p to 4K, passes other resolutions through', () => {
    expect(resolutionLabel('2160p')).toBe('4K');
    expect(resolutionLabel('1080p')).toBe('1080p');
    expect(resolutionLabel('720p')).toBe('720p');
    expect(resolutionLabel(null)).toBe('Unknown');
  });

  test('resolutionLabel detects the real resolution from the filename for ORG-quality entries', () => {
    // ORG ("original") direct links are FebBox's own literal quality label
    // — it carries no resolution info by itself. Confirmed live: this was
    // showing as the meaningless "Original" for every direct stream
    // regardless of actual resolution until this fix.
    expect(resolutionLabel('ORG', 'Silo.S03E05.2160p.ATVP.WEB-DL.DDP5.1.Atmos.mkv')).toBe('4K');
    expect(resolutionLabel('ORG', 'Silo.S03E05.1080p.WEBRip.10Bit.DDP5.1.x265-NTb.mkv')).toBe('1080p');
    expect(resolutionLabel('ORG', 'Silo.S03E05.360p.WEBRip.x265.mkv')).toBe('360p');
  });

  test('resolutionLabel falls back to "Original" only when no resolution can be detected in the filename', () => {
    expect(resolutionLabel('ORG', 'Silo.S03E05.WEBRip.x265-NTb.mkv')).toBe('Original');
    expect(resolutionLabel('ORG', null)).toBe('Original');
    expect(resolutionLabel('ORG')).toBe('Original');
  });

  test('buildCleanTitle formats a series episode as "Title S00E00"', () => {
    expect(buildCleanTitle({ title: 'Silo', year: 2023, type: 'series', season: 2, episode: 5 })).toBe('Silo S02E05');
    expect(buildCleanTitle({ title: 'Silo', year: 2023, type: 'series', season: 10, episode: 12 })).toBe('Silo S10E12');
  });

  test('buildCleanTitle formats a movie as "Title (Year)"', () => {
    expect(buildCleanTitle({ title: 'The Odyssey', year: 2026, type: 'movie' })).toBe('The Odyssey (2026)');
  });

  test('buildCleanTitle degrades gracefully with missing title/year', () => {
    expect(buildCleanTitle({ title: null, year: null, type: 'movie' })).toBe('Unknown title');
    expect(buildCleanTitle({ title: 'Untitled', year: null, type: 'movie' })).toBe('Untitled');
  });

  test('DISPLAY_MODE_VALUES contains exactly the four documented modes, default is standard', () => {
    expect([...DISPLAY_MODE_VALUES].sort()).toEqual(['balanced', 'detailed', 'minimal', 'standard']);
    expect(DEFAULT_DISPLAY_MODE).toBe('standard');
  });
});
