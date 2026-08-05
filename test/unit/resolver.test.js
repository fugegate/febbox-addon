'use strict';

const nock = require('nock');
const resolver = require('../../src/providers/febbox/resolver');

const FEBBOX = 'https://www.febbox.com';

afterEach(() => nock.cleanAll());

/** Mock a successful HEAD validation for a direct-link URL (see urlValidate.js). */
function mockValidHead(url) {
  const u = new URL(url);
  nock(`${u.protocol}//${u.host}`)
    .head(u.pathname)
    .query(true)
    .reply(200, '', { 'content-type': 'video/mp4' });
}

describe('resolver', () => {
  test('resolveMovie resolves all video files in a flat share', async () => {
    nock(FEBBOX)
      .get('/file/file_share_list')
      .query((q) => q.parent_id === '0')
      .reply(200, {
        data: { file_list: [{ fid: 10, file_name: 'Movie.2024.1080p.mkv', is_dir: false }] },
      });
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '10')
      .reply(200, {
        html: '<div class="file_quality" data-url="https://cdn.febbox.com/x.mp4" data-quality="1080p"></div>',
      });
    mockValidHead('https://cdn.febbox.com/x.mp4');

    const streams = await resolver.resolveMovie({ token: 'sometoken12345', shareKey: 'abcd1234' });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('https://cdn.febbox.com/x.mp4');
    expect(streams[0].quality).toBe('1080p');
    expect(streams[0].isHls).toBe(false);
  });

  test('resolveMovie recurses into a single folder', async () => {
    nock(FEBBOX)
      .get('/file/file_share_list')
      .query((q) => q.parent_id === '0')
      .reply(200, { data: { file_list: [{ fid: 1, file_name: 'MovieFolder', is_dir: true }] } });
    nock(FEBBOX)
      .get('/file/file_share_list')
      .query((q) => q.parent_id === '1')
      .reply(200, { data: { file_list: [{ fid: 2, file_name: 'movie.mkv', is_dir: false }] } });
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '2')
      .reply(200, {
        html: '<div class="file_quality" data-url="https://cdn.febbox.com/y.mp4" data-quality="720p"></div>',
      });
    mockValidHead('https://cdn.febbox.com/y.mp4');

    const streams = await resolver.resolveMovie({ token: 'sometoken12345', shareKey: 'abcd1234' });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('https://cdn.febbox.com/y.mp4');
  });

  test('resolveMovie filters out HLS (.m3u8) sources by default, keeping only direct links', async () => {
    // Real FebBox behavior: transcoded qualities (1080p/720p/360p) are
    // HLS, "ORG" is the only direct link — HLS was confirmed to stall/
    // break seeking in Stremio's web client, so 'direct' mode (the
    // default) never surfaces HLS.
    nock(FEBBOX)
      .get('/file/file_share_list')
      .query((q) => q.parent_id === '0')
      .reply(200, { data: { file_list: [{ fid: 10, file_name: 'Movie.2024.mkv', is_dir: false }] } });
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '10')
      .reply(200, {
        html:
          '<div class="file_quality" data-url="https://hls.shegu.net/x.m3u8?sign=abc" data-quality="1080p"></div>' +
          '<div class="file_quality" data-url="https://usa7-a1.shegu.net/org.mp4" data-quality="ORG"></div>',
      });
    mockValidHead('https://usa7-a1.shegu.net/org.mp4');

    const streams = await resolver.resolveMovie({ token: 'sometoken12345', shareKey: 'abcd1234' });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('https://usa7-a1.shegu.net/org.mp4');
    expect(streams[0].quality).toBe('ORG');
    expect(streams[0].isHls).toBe(false);
  });

  test('resolveFileStreams includes HLS after direct links in "both" mode, unmodified', async () => {
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '77')
      .reply(200, {
        html:
          '<div class="file_quality" data-url="https://hls.shegu.net/x.m3u8?sign=abc" data-quality="1080p"></div>' +
          '<div class="file_quality" data-url="https://usa7-a1.shegu.net/org.mp4" data-quality="ORG"></div>',
      });
    mockValidHead('https://usa7-a1.shegu.net/org.mp4');

    const streams = await resolver.resolveFileStreams({
      token: 'sometoken12345',
      shareKey: 'abcd1234',
      fid: '77',
      fileName: 'x.mkv',
      playbackMode: resolver.PLAYBACK_MODE.BOTH,
    });
    // Direct first, then HLS — and the HLS URL is byte-for-byte what FebBox returned.
    expect(streams).toHaveLength(2);
    expect(streams[0].isHls).toBe(false);
    expect(streams[0].url).toBe('https://usa7-a1.shegu.net/org.mp4');
    expect(streams[1].isHls).toBe(true);
    expect(streams[1].url).toBe('https://hls.shegu.net/x.m3u8?sign=abc');
  });

  test('resolveFileStreams returns HLS only (no direct) in pure experimental-hls mode', async () => {
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '78')
      .reply(200, {
        html:
          '<div class="file_quality" data-url="https://hls.shegu.net/y.m3u8?sign=def" data-quality="720p"></div>' +
          '<div class="file_quality" data-url="https://usa7-a1.shegu.net/org2.mp4" data-quality="ORG"></div>',
      });
    // Note: no mockValidHead for org2.mp4 — direct candidates aren't even
    // checked in pure experimental-hls mode, so this must not be called.

    const streams = await resolver.resolveFileStreams({
      token: 'sometoken12345',
      shareKey: 'abcd1234',
      fid: '78',
      fileName: 'y.mkv',
      playbackMode: resolver.PLAYBACK_MODE.EXPERIMENTAL_HLS,
    });
    expect(streams).toHaveLength(1);
    expect(streams[0].isHls).toBe(true);
    expect(streams[0].url).toBe('https://hls.shegu.net/y.m3u8?sign=def');
  });

  test('resolveFileStreams includes an HEVC HLS rendition unfiltered (surfaced as-is, not blocked)', async () => {
    // HEVC is known to fail on some Stremio clients (black screen,
    // audio-only — github.com/Stremio/stremio-bugs #319, #644), but per
    // explicit product decision this addon still offers it under HLS
    // mode rather than hiding it.
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '79')
      .reply(200, {
        html:
          '<div class="file_quality" data-url="https://hls.shegu.net/hevc.m3u8?q=2160p" data-quality="2160p"></div>' +
          '<div class="file_quality" data-url="https://hls.shegu.net/avc.m3u8?q=1080p" data-quality="1080p"></div>',
      });

    const streams = await resolver.resolveFileStreams({
      token: 'sometoken12345',
      shareKey: 'abcd1234',
      fid: '79',
      fileName: 'z.mkv',
      playbackMode: resolver.PLAYBACK_MODE.EXPERIMENTAL_HLS,
    });
    expect(streams).toHaveLength(2);
    expect(streams.map((s) => s.quality).sort()).toEqual(['1080p', '2160p']);
  });

  test('resolveFileStreams throws NOT_FOUND when every source is HLS and mode is direct (no fallback to a broken stream)', async () => {
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '99')
      .reply(200, {
        html: '<div class="file_quality" data-url="https://hls.shegu.net/only.m3u8" data-quality="720p"></div>',
      });
    await expect(
      resolver.resolveFileStreams({ token: 'sometoken12345', shareKey: 'abcd1234', fid: '99', fileName: 'x.mkv' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('resolveFileStreams drops a direct link that fails validation (wrong host)', async () => {
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '55')
      .reply(200, {
        html: '<div class="file_quality" data-url="https://evil.example.com/x.mp4" data-quality="1080p"></div>',
      });
    // No HEAD mock needed — host allowlist check rejects before any request is made.
    await expect(
      resolver.resolveFileStreams({ token: 'sometoken12345', shareKey: 'abcd1234', fid: '55', fileName: 'x.mkv' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('resolveMovie throws NOT_FOUND when no video files exist', async () => {
    nock(FEBBOX).get('/file/file_share_list').query(true).reply(200, { data: { file_list: [] } });
    await expect(
      resolver.resolveMovie({ token: 'sometoken12345', shareKey: 'abcd1234' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('resolveEpisode filters by season/episode filename match', async () => {
    // Flat share, no "season N" folders — resolveEpisode's top-level probe
    // finds nothing to target and falls back to a full scan, which lists
    // the same (flat) file set again.
    nock(FEBBOX)
      .get('/file/file_share_list')
      .query(true)
      .times(2)
      .reply(200, {
        data: {
          file_list: [
            { fid: 1, file_name: 'Show.S01E01.mkv', is_dir: false },
            { fid: 2, file_name: 'Show.S01E02.mkv', is_dir: false },
          ],
        },
      });
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '2')
      .reply(200, {
        html: '<div class="file_quality" data-url="https://cdn.febbox.com/e2.mp4" data-quality="1080p"></div>',
      });
    mockValidHead('https://cdn.febbox.com/e2.mp4');

    const streams = await resolver.resolveEpisode({
      token: 'sometoken12345',
      shareKey: 'abcd1234',
      season: 1,
      episode: 2,
    });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('https://cdn.febbox.com/e2.mp4');
  });

  test('resolveEpisode throws NOT_FOUND when no episode matches', async () => {
    nock(FEBBOX)
      .get('/file/file_share_list')
      .query(true)
      .times(2)
      .reply(200, { data: { file_list: [{ fid: 1, file_name: 'Show.S01E01.mkv', is_dir: false }] } });
    await expect(
      resolver.resolveEpisode({ token: 'sometoken12345', shareKey: 'abcd1234', season: 5, episode: 5 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('resolveEpisode only recurses into the matching season folder, not siblings', async () => {
    nock(FEBBOX)
      .get('/file/file_share_list')
      .query((q) => q.parent_id === '0')
      .reply(200, {
        data: {
          file_list: [
            { fid: 100, file_name: 'season 2', is_dir: true },
            { fid: 101, file_name: 'season 1', is_dir: true },
          ],
        },
      });
    // Only season 1's folder should ever be listed — season 2's file_share_list
    // is deliberately NOT mocked, so nock would throw if it were called.
    nock(FEBBOX)
      .get('/file/file_share_list')
      .query((q) => q.parent_id === '101')
      .reply(200, {
        data: { file_list: [{ fid: 5, file_name: 'Show.S01E01.mkv', is_dir: false }] },
      });
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query((q) => q.fid === '5')
      .reply(200, {
        html: '<div class="file_quality" data-url="https://cdn.febbox.com/s1e1.mp4" data-quality="1080p"></div>',
      });
    mockValidHead('https://cdn.febbox.com/s1e1.mp4');

    const streams = await resolver.resolveEpisode({
      token: 'sometoken12345',
      shareKey: 'abcd1234',
      season: 1,
      episode: 1,
    });
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('https://cdn.febbox.com/s1e1.mp4');
  });

  test('extractShareKey parses full URLs and passes through bare keys', () => {
    expect(resolver.extractShareKey('https://www.febbox.com/share/cbaV67Kp')).toBe('cbaV67Kp');
    expect(resolver.extractShareKey('cbaV67Kp')).toBe('cbaV67Kp');
    expect(resolver.extractShareKey('not a url or key!!')).toBeNull();
  });

  test('isLikelyVideo filters by extension', () => {
    expect(resolver.isLikelyVideo('a.mkv')).toBe(true);
    expect(resolver.isLikelyVideo('a.srt')).toBe(false);
  });
});
