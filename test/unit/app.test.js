'use strict';

process.env.CONFIG_SECRET = 'test-secret-at-least-16-chars';

const nock = require('nock');
const request = require('supertest');
const { createApp, sanitizePathForLogging } = require('../../src/app');
const { encodeConfigToken } = require('../../src/config/configToken');

const SECRET = process.env.CONFIG_SECRET;

describe('app routes', () => {
  let app;
  beforeAll(() => {
    app = createApp();
  });
  afterEach(() => nock.cleanAll());

  test('GET /:configToken/manifest.json returns a valid manifest', async () => {
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    const resp = await request(app).get(`/${token}/manifest.json`);
    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe('community.febboxaddon');
    expect(resp.body.types).toEqual(expect.arrayContaining(['movie', 'series']));
  });

  test('manifest reports configurationRequired:false for a valid config token (Stremio offers Install, not Configure)', async () => {
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    const resp = await request(app).get(`/${token}/manifest.json`);
    expect(resp.body.behaviorHints.configurationRequired).toBe(false);
    expect(resp.body.behaviorHints.configurable).toBe(true);
  });

  test('manifest reports configurationRequired:true for an invalid/malformed config token', async () => {
    const resp = await request(app).get('/not-a-real-config-token/manifest.json');
    expect(resp.status).toBe(200);
    expect(resp.body.behaviorHints.configurationRequired).toBe(true);
  });

  test('GET /:configToken/configure redirects to the config page root, not a 404', async () => {
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    const resp = await request(app).get(`/${token}/configure`).redirects(0);
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toBe('/');
  });

  test('GET /manifest.json (no config token) returns a generic manifest requiring configuration', async () => {
    const resp = await request(app).get('/manifest.json');
    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe('community.febboxaddon');
    expect(resp.body.behaviorHints.configurable).toBe(true);
    expect(resp.body.behaviorHints.configurationRequired).toBe(true);
  });

  test('GET /configure redirects to the config page root, not a 404', async () => {
    const resp = await request(app).get('/configure').redirects(0);
    expect(resp.status).toBe(302);
    expect(resp.headers.location).toBe('/');
  });

  test('stream route with malformed config token returns empty streams, not 500', async () => {
    const resp = await request(app).get('/not-a-real-config-token/stream/movie/tt1234567.json');
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ streams: [] });
  });

  test('stream route with invalid id returns empty streams', async () => {
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/not-an-imdb-id.json`);
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ streams: [] });
  });

  test('stream route for movie returns empty streams honestly when no TMDB_API_KEY is configured', async () => {
    // No TMDB_API_KEY set in this test process -> discovery can't run at
    // all (nothing to search for) -> fails soft to an empty stream list,
    // same as a genuine discovery miss would.
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/tt1234567.json`);
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ streams: [] });
  });

  test('GET /metrics returns counters and latency with no secret-shaped content', async () => {
    const resp = await request(app).get('/metrics');
    expect(resp.status).toBe(200);
    expect(resp.body).toHaveProperty('counters');
    expect(resp.body).toHaveProperty('latency');
    expect(JSON.stringify(resp.body)).not.toContain('sometoken12345');
  });

  test('stream route for unsupported type returns empty streams', async () => {
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/channel/tt1234567.json`);
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({ streams: [] });
  });

  test('POST /api/validate-token rejects missing token', async () => {
    const resp = await request(app).post('/api/validate-token').send({});
    expect(resp.status).toBe(400);
    expect(resp.body.isValid).toBe(false);
  });

  test('POST /api/validate-token reports invalid on FebBox 401', async () => {
    nock('https://www.febbox.com').get('/console/user_cards').query(true).reply(401, {});
    const resp = await request(app).post('/api/validate-token').send({ token: 'sometoken12345' });
    expect(resp.status).toBe(200);
    expect(resp.body.isValid).toBe(false);
  });

  test('POST /api/validate-token reports valid + quota on success', async () => {
    nock('https://www.febbox.com')
      .get('/console/user_cards')
      .query(true)
      .reply(200, { data: { flow: { traffic_limit_mb: 100, traffic_usage_mb: 10 } } });
    const resp = await request(app).post('/api/validate-token').send({ token: 'sometoken12345' });
    expect(resp.status).toBe(200);
    expect(resp.body.isValid).toBe(true);
    expect(resp.body.quota.remainingMB).toBe(90);
  });

  test('POST /api/create-config rejects malformed token', async () => {
    const resp = await request(app).post('/api/create-config').send({ token: 'x' });
    expect(resp.status).toBe(400);
  });

  test('POST /api/create-config issues a config token that does not contain the raw token', async () => {
    const resp = await request(app).post('/api/create-config').send({ token: 'sometoken12345' });
    expect(resp.status).toBe(200);
    expect(resp.body.configToken).toBeDefined();
    expect(resp.body.configToken).not.toContain('sometoken12345');
  });

  test('no /playlist proxy route remains registered', async () => {
    const resp = await request(app).get('/playlist/anything.m3u8');
    // No route matches this path shape at all now — plain Express 404,
    // not the dedicated playlist handler that used to exist here.
    expect(resp.status).toBe(404);
  });

  test('POST /api/create-config defaults playbackMode to direct and rejects invalid values', async () => {
    const resp = await request(app).post('/api/create-config').send({ token: 'sometoken12345' });
    expect(resp.body.playbackMode).toBe('direct');

    const respBad = await request(app)
      .post('/api/create-config')
      .send({ token: 'sometoken12345', playbackMode: 'proxy-everything' });
    expect(respBad.body.playbackMode).toBe('direct'); // invalid value silently falls back to the safe default

    const respGood = await request(app)
      .post('/api/create-config')
      .send({ token: 'sometoken12345', playbackMode: 'experimental-hls' });
    expect(respGood.body.playbackMode).toBe('experimental-hls');

    const respBoth = await request(app)
      .post('/api/create-config')
      .send({ token: 'sometoken12345', playbackMode: 'both' });
    expect(respBoth.body.playbackMode).toBe('both');
  });

  test('POST /api/create-config defaults displayMode to standard and rejects invalid values', async () => {
    const resp = await request(app).post('/api/create-config').send({ token: 'sometoken12345' });
    expect(resp.body.displayMode).toBe('standard');

    const respBad = await request(app)
      .post('/api/create-config')
      .send({ token: 'sometoken12345', displayMode: 'ultra-mega-mode' });
    expect(respBad.body.displayMode).toBe('standard');

    for (const mode of ['minimal', 'balanced', 'standard', 'detailed']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await request(app).post('/api/create-config').send({ token: 'sometoken12345', displayMode: mode });
      expect(r.body.displayMode).toBe(mode);
    }
  });

  test('GET /health reports ok and uptimeSeconds', async () => {
    const resp = await request(app).get('/health');
    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(typeof resp.body.uptimeSeconds).toBe('number');
  });

  test('manifest includes an absolute logo URL pointing at /assets/icon.png', async () => {
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    const resp = await request(app).get(`/${token}/manifest.json`);
    expect(resp.body.logo).toMatch(/^http:\/\/127\.0\.0\.1(:\d+)?\/assets\/icon\.png$/);
  });

  test('manifest logo is https behind a reverse proxy (X-Forwarded-Proto) — Render terminates TLS this way', async () => {
    // Render (and most PaaS) terminate TLS at a proxy and forward the
    // original Host header as-is, but protocol only via X-Forwarded-Proto
    // — reproduced live: the deployed instance returned "http://" in its
    // logo URL until `app.set('trust proxy', 1)` was added.
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    const resp = await request(app).get(`/${token}/manifest.json`).set('X-Forwarded-Proto', 'https');
    expect(resp.body.logo).toMatch(/^https:\/\/127\.0\.0\.1(:\d+)?\/assets\/icon\.png$/);
  });

  test('GET / serves the built React config app (run `npm run build` first — see web/)', async () => {
    const resp = await request(app).get('/');
    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('text/html');
    expect(resp.text).toContain('<div id="root">');
  });

  test('GET /assets/icon.png serves the icon', async () => {
    const resp = await request(app).get('/assets/icon.png');
    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('image/png');
  });

  test('sanitizePathForLogging replaces an opaque config-token segment with a placeholder', () => {
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    expect(sanitizePathForLogging(`/${token}/manifest.json`)).toBe('/<configToken>/manifest.json');
    expect(sanitizePathForLogging(`/${token}/stream/movie/tt1234567.json`)).toBe(
      '/<configToken>/stream/movie/tt1234567.json'
    );
    expect(sanitizePathForLogging('/health')).toBe('/health');
    expect(sanitizePathForLogging('/metrics')).toBe('/metrics');
  });

  test('request log line never contains the opaque config token, even though it is in the URL path', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const token = encodeConfigToken({ febboxToken: 'sometoken12345' }, SECRET);
    await request(app).get(`/${token}/manifest.json`);
    const loggedLines = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(loggedLines).not.toContain(token);
    logSpy.mockRestore();
  });

  test('no secret-shaped strings appear in any response body across routes', async () => {
    const token = encodeConfigToken({ febboxToken: 'super-secret-value-xyz' }, SECRET);
    const resp = await request(app).get(`/${token}/stream/movie/tt1234567.json`);
    const bodyStr = JSON.stringify(resp.body);
    expect(bodyStr).not.toContain('super-secret-value-xyz');
  });
});
