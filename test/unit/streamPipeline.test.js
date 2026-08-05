'use strict';

// Full pipeline test: TMDB -> ShowBox discovery -> FebBox resolution,
// through the real HTTP route, proving the production playback
// architecture: 'direct' mode (default) never returns HLS, only
// live-validated direct MP4 links; 'experimental-hls' mode additionally
// returns FebBox's original, unmodified HLS URLs, clearly labeled and
// flagged notWebReady. No playlist rewriting/proxying of any kind.

process.env.CONFIG_SECRET = 'test-secret-at-least-16-chars';
process.env.TMDB_API_KEY = 'fake-tmdb-key';

const nock = require('nock');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { encodeConfigToken } = require('../../src/config/configToken');
const { catalogCache, playbackCache } = require('../../src/cache/ttlCache');

const SECRET = process.env.CONFIG_SECRET;

function mockDiscoveryChain() {
  nock('https://api.themoviedb.org')
    .get('/3/find/tt1375666')
    .query(true)
    .reply(200, { movie_results: [{ id: 27205, title: 'Inception', release_date: '2010-07-16' }], tv_results: [] });
  nock('https://api.themoviedb.org')
    .get('/3/movie/27205/alternative_titles')
    .query(true)
    .reply(200, { titles: [] });
  nock('https://www.showbox.media')
    .get('/search')
    .query({ keyword: 'Inception' })
    .reply(200, '<html><body><a href="/movie/m-inception-2010">Inception</a></body></html>');
  nock('https://www.showbox.media')
    .get('/movie/m-inception-2010')
    .reply(200, `<script>$.ajax({url:'/index/share_link',data:{'id':4059,'type':1}})</script>`);
  nock('https://www.showbox.media')
    .get('/index/share_link')
    .query({ id: '4059', type: '1' })
    .reply(200, { code: 1, msg: 'success', data: { link: 'https://www.febbox.com/share/Bp1Hw1MK' } });
  nock('https://www.febbox.com').get('/share/Bp1Hw1MK').reply(200, '<html>alive</html>');
}

function mockFebboxFileWithBothQualities() {
  nock('https://www.febbox.com')
    .get('/file/file_share_list')
    .query(true)
    .reply(200, { data: { file_list: [{ fid: 1, file_name: 'Inception.2010.mkv', is_dir: false }] } });
  nock('https://www.febbox.com')
    .get('/console/video_quality_list')
    .query((q) => q.fid === '1')
    .reply(200, {
      html:
        '<div class="file_quality" data-url="https://hls.shegu.net/master.m3u8?sign=raw" data-quality="720p"><p class="size">1.5 GB</p></div>' +
        '<div class="file_quality" data-url="https://usa7-a1.shegu.net/org.mp4" data-quality="ORG"><p class="size">3.6 GB</p></div>',
    });
  nock('https://usa7-a1.shegu.net').head('/org.mp4').reply(200, '', { 'content-type': 'video/mp4' });
}

describe('full stream pipeline: direct vs experimental-hls playback modes', () => {
  let app;
  beforeAll(() => {
    app = createApp();
  });
  afterEach(() => {
    nock.cleanAll();
    catalogCache.clear();
    playbackCache.clear();
  });

  test('direct mode (default): only the direct MP4 is returned, HLS is excluded entirely', async () => {
    mockDiscoveryChain();
    mockFebboxFileWithBothQualities();

    const token = encodeConfigToken({ febboxToken: 'sometoken12345', playbackMode: 'direct' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);

    expect(resp.status).toBe(200);
    expect(resp.body.streams).toHaveLength(1);
    const [stream] = resp.body.streams;
    expect(stream.url).toBe('https://usa7-a1.shegu.net/org.mp4');
    expect(stream.url).not.toMatch(/\.m3u8/);
    expect(stream.behaviorHints.notWebReady).toBe(false);
    expect(stream.behaviorHints.filename).toBe('Inception.2010.mkv');
    expect(stream.behaviorHints.videoSize).toBeGreaterThan(0);
    expect(stream.name).not.toMatch(/Experimental/);
  });

  test('"both" mode: direct MP4 still present first, plus the original unmodified HLS URL, clearly labeled', async () => {
    mockDiscoveryChain();
    mockFebboxFileWithBothQualities();

    // displayMode 'detailed' explicitly, since this test is about playback
    // MODE (direct vs HLS presence), not display formatting — kept stable
    // regardless of what the default displayMode is.
    const token = encodeConfigToken(
      { febboxToken: 'sometoken12345', playbackMode: 'both', displayMode: 'detailed' },
      SECRET
    );
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);

    expect(resp.status).toBe(200);
    expect(resp.body.streams).toHaveLength(2);

    const [direct, hls] = resp.body.streams;
    expect(direct.url).toBe('https://usa7-a1.shegu.net/org.mp4');
    expect(direct.behaviorHints.notWebReady).toBe(false);

    // The HLS URL must be exactly what FebBox returned — never rewritten,
    // never pointed at a proxy/playlist route of our own.
    expect(hls.url).toBe('https://hls.shegu.net/master.m3u8?sign=raw');
    expect(hls.behaviorHints.notWebReady).toBe(true);
    expect(hls.name).toContain('HLS');
    expect(hls.title).toMatch(/this stream may not work/i);
  });

  test('pure experimental-hls mode: HLS only, no direct link included', async () => {
    mockDiscoveryChain();
    mockFebboxFileWithBothQualities();

    const token = encodeConfigToken({ febboxToken: 'sometoken12345', playbackMode: 'experimental-hls' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);

    expect(resp.status).toBe(200);
    expect(resp.body.streams).toHaveLength(1);
    expect(resp.body.streams[0].url).toBe('https://hls.shegu.net/master.m3u8?sign=raw');
    expect(resp.body.streams[0].behaviorHints.notWebReady).toBe(true);
  });

  test('a config token with no playbackMode set defaults to direct (HLS excluded)', async () => {
    mockDiscoveryChain();
    mockFebboxFileWithBothQualities();

    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET); // no playbackMode field at all
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);
    expect(resp.body.streams).toHaveLength(1);
    expect(resp.body.streams[0].url).not.toMatch(/\.m3u8/);
  });

  test('direct and experimental-hls results are cached separately (never cross-served)', async () => {
    mockDiscoveryChain();
    mockFebboxFileWithBothQualities();
    const directToken = encodeConfigToken({ febboxToken: 'sometoken12345', playbackMode: 'direct' }, SECRET);
    const directResp = await request(app).get(`/${directToken}/stream/movie/tt1375666.json`);
    expect(directResp.body.streams).toHaveLength(1);

    // Second request, different mode, same title — must re-resolve (fresh
    // mocks required) rather than serving the cached direct-only result.
    mockDiscoveryChain();
    mockFebboxFileWithBothQualities();
    const bothToken = encodeConfigToken({ febboxToken: 'sometoken12345', playbackMode: 'both' }, SECRET);
    const bothResp = await request(app).get(`/${bothToken}/stream/movie/tt1375666.json`);
    expect(bothResp.body.streams).toHaveLength(2);
  });

  test('an invalid direct-link candidate (disallowed host) never reaches the client, even though the file has no other source', async () => {
    mockDiscoveryChain();
    nock('https://www.febbox.com')
      .get('/file/file_share_list')
      .query(true)
      .reply(200, { data: { file_list: [{ fid: 1, file_name: 'Inception.2010.mkv', is_dir: false }] } });
    nock('https://www.febbox.com')
      .get('/console/video_quality_list')
      .query((q) => q.fid === '1')
      .reply(200, {
        html: '<div class="file_quality" data-url="https://evil.example.com/org.mp4" data-quality="ORG"></div>',
      });

    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);
    expect(resp.status).toBe(200);
    expect(resp.body.streams).toEqual([]); // fails soft, never leaks the unvalidated URL
  });
});

describe('displayMode formatting (real TMDB title "Inception", 2010, via mocked discovery)', () => {
  let app;
  beforeAll(() => {
    app = createApp();
  });
  afterEach(() => {
    nock.cleanAll();
    catalogCache.clear();
    playbackCache.clear();
  });

  // Reflects real FebBox behavior (confirmed live): direct/original links
  // are always labeled data-quality="ORG" literally — the resolution
  // (2160p here) only ever appears in the filename, never in the quality
  // label itself.
  function mockOrgOnlyFile() {
    nock('https://www.febbox.com')
      .get('/file/file_share_list')
      .query(true)
      .reply(200, { data: { file_list: [{ fid: 1, file_name: 'Inception.2010.2160p.mkv', is_dir: false }] } });
    nock('https://www.febbox.com')
      .get('/console/video_quality_list')
      .query((q) => q.fid === '1')
      .reply(200, {
        html:
          '<div class="file_quality" data-url="https://usa7-a1.shegu.net/org.mp4" data-quality="ORG">' +
          '<p class="size">3.6 GB</p></div>',
      });
    nock('https://usa7-a1.shegu.net').head('/org.mp4').reply(200, '', { 'content-type': 'video/mp4' });
  }

  test('minimal: name is just the resolution, title is empty', async () => {
    mockDiscoveryChain();
    mockOrgOnlyFile();
    const token = encodeConfigToken({ febboxToken: 'sometoken12345', displayMode: 'minimal' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);
    expect(resp.body.streams).toHaveLength(1);
    expect(resp.body.streams[0].name).toBe('4K');
    expect(resp.body.streams[0].title).toBe('');
  });

  test('balanced: name is the clean title, title is just the resolution', async () => {
    mockDiscoveryChain();
    mockOrgOnlyFile();
    const token = encodeConfigToken({ febboxToken: 'sometoken12345', displayMode: 'balanced' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);
    expect(resp.body.streams[0].name).toBe('Inception (2010)');
    expect(resp.body.streams[0].title).toBe('4K');
  });

  test('standard (default): clean title as name, title adds size/codecs on top of the resolution — never the raw filename', async () => {
    mockDiscoveryChain();
    mockOrgOnlyFile();
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET); // no displayMode -> default
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);
    const s = resp.body.streams[0];
    expect(s.name).toBe('Inception (2010)');
    expect(s.title).toContain('4K');
    expect(s.title).toContain('3.6 GB');
    expect(s.title).not.toMatch(/inception\.2010/i); // raw filename must not leak into standard mode
  });

  test('detailed: unchanged raw-filename-forward format', async () => {
    mockDiscoveryChain();
    mockOrgOnlyFile();
    const token = encodeConfigToken({ febboxToken: 'sometoken12345', displayMode: 'detailed' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);
    const s = resp.body.streams[0];
    // 'detailed' mode's name is always "FebBox <literal quality>" — for a
    // direct/ORG link that's literally "ORG" (FebBox's own label, not a
    // resolution); the actual resolution only ever comes through via the
    // filename in the title line below, unchanged raw-filename behavior.
    expect(s.name).toBe('FebBox ORG');
    expect(s.title).toMatch(/Inception 2010 2160p/i);
    expect(s.title).toContain('3.6 GB');
  });

  test('an unrecognized displayMode value falls back to the default (standard), not detailed', async () => {
    mockDiscoveryChain();
    mockOrgOnlyFile();
    const token = encodeConfigToken({ febboxToken: 'sometoken12345', displayMode: 'ultra-mega-mode' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/tt1375666.json`);
    expect(resp.body.streams[0].name).toBe('Inception (2010)');
  });
});
