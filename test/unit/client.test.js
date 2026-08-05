'use strict';

const nock = require('nock');
const client = require('../../src/providers/febbox/client');
const { FebBoxError } = require('../../src/providers/febbox/types');

const FEBBOX = 'https://www.febbox.com';

afterEach(() => {
  nock.cleanAll();
});

describe('febbox client', () => {
  test('listShareFiles parses file_share_list response', async () => {
    nock(FEBBOX)
      .get('/file/file_share_list')
      .query(true)
      .reply(200, { data: { file_list: [{ fid: 1, file_name: 'a.mkv', is_dir: false, size: '1 GB' }] } });

    const files = await client.listShareFiles({ token: 'sometoken12345', shareKey: 'abcd1234' });
    expect(files).toEqual([{ fid: '1', name: 'a.mkv', isDir: false, size: '1 GB', raw: undefined }]);
  });

  test('getVideoQualityLinks returns raw html field', async () => {
    nock(FEBBOX)
      .get('/console/video_quality_list')
      .query(true)
      .reply(200, { html: '<div class="file_quality" data-url="https://x/y.mp4"></div>' });

    const html = await client.getVideoQualityLinks({ token: 'sometoken12345', shareKey: 'abcd', fid: '1' });
    expect(html).toContain('file_quality');
  });

  test('getQuota parses flow data', async () => {
    nock(FEBBOX)
      .get('/console/user_cards')
      .query(true)
      .reply(200, { data: { flow: { traffic_limit_mb: 1000, traffic_usage_mb: 200, is_vip: true } } });

    const quota = await client.getQuota({ token: 'sometoken12345' });
    expect(quota).toEqual({ limitMB: 1000, usageMB: 200, remainingMB: 800, isVip: true });
  });

  test('classifies 401 as AUTH_INVALID', async () => {
    nock(FEBBOX).get('/console/user_cards').query(true).reply(401, {});
    await expect(client.getQuota({ token: 'sometoken12345' })).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  test('classifies 429 as RATE_LIMITED', async () => {
    nock(FEBBOX).get('/console/user_cards').query(true).reply(429, {});
    await expect(client.getQuota({ token: 'sometoken12345' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  test('classifies 500 as UPSTREAM_ERROR', async () => {
    nock(FEBBOX).get('/console/user_cards').query(true).reply(500, {});
    await expect(client.getQuota({ token: 'sometoken12345' })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  test('rejects malformed tokens before making a request', async () => {
    await expect(client.getQuota({ token: 'bad tok\nen' })).rejects.toBeInstanceOf(FebBoxError);
  });

  test('all outbound requests target the fixed FebBox origin only', () => {
    expect(client.FEBBOX_ORIGIN).toBe('https://www.febbox.com');
  });
});
