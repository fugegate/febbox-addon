'use strict';

const nock = require('nock');
const { validateDirectUrl, isAllowedHost, hasPreferredExtension } = require('../../src/providers/febbox/urlValidate');

afterEach(() => nock.cleanAll());

describe('urlValidate', () => {
  test('isAllowedHost accepts febbox.com, its subdomains, and shegu.net subdomains', () => {
    expect(isAllowedHost('febbox.com')).toBe(true);
    expect(isAllowedHost('cdn.febbox.com')).toBe(true);
    expect(isAllowedHost('usa7-a3-01-1.shegu.net')).toBe(true);
    expect(isAllowedHost('evil.example.com')).toBe(false);
    expect(isAllowedHost('febbox.com.evil.example.com')).toBe(false);
    expect(isAllowedHost(null)).toBe(false);
  });

  test('hasPreferredExtension accepts mp4/m4v/webm/mkv (direct/progressive containers), rejects m3u8 (HLS)', () => {
    expect(hasPreferredExtension('https://cdn.febbox.com/x.mp4')).toBe(true);
    expect(hasPreferredExtension('https://cdn.febbox.com/x.mp4?sign=abc')).toBe(true);
    expect(hasPreferredExtension('https://cdn.febbox.com/x.m4v')).toBe(true);
    expect(hasPreferredExtension('https://cdn.febbox.com/x.webm')).toBe(true);
    // mkv is a real direct (non-HLS) container FebBox serves ORG links in
    // for many TV sources — confirmed live (Cape Fear S01E01) that
    // excluding it silently dropped an otherwise-valid direct link.
    expect(hasPreferredExtension('https://cdn.febbox.com/x.mkv')).toBe(true);
    expect(hasPreferredExtension('https://cdn.febbox.com/x.m3u8')).toBe(false);
  });

  test('validateDirectUrl rejects non-https URLs without making a request', async () => {
    const result = await validateDirectUrl('http://cdn.febbox.com/x.mp4');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('not_https');
  });

  test('validateDirectUrl rejects HLS (.m3u8) URLs without making a request', async () => {
    const result = await validateDirectUrl('https://hls.shegu.net/x.m3u8');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unsupported_extension');
  });

  test('validateDirectUrl rejects a disallowed host without making a request', async () => {
    const result = await validateDirectUrl('https://evil.example.com/x.mp4');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('host_not_allowed');
  });

  test('validateDirectUrl accepts a real video/mp4 response from an allowed host (HEAD)', async () => {
    nock('https://cdn.febbox.com').head('/x.mp4').reply(200, '', { 'content-type': 'video/mp4' });
    const result = await validateDirectUrl('https://cdn.febbox.com/x.mp4');
    expect(result.valid).toBe(true);
    expect(result.contentType).toBe('video/mp4');
  });

  test('validateDirectUrl falls back to a ranged GET when HEAD is unsupported', async () => {
    nock('https://cdn.febbox.com').head('/x.mp4').reply(405, '');
    nock('https://cdn.febbox.com')
      .get('/x.mp4')
      .matchHeader('range', 'bytes=0-1023')
      .reply(206, Buffer.alloc(1024), { 'content-type': 'video/mp4' });
    const result = await validateDirectUrl('https://cdn.febbox.com/x.mp4');
    expect(result.valid).toBe(true);
  });

  test('validateDirectUrl rejects a non-video Content-Type', async () => {
    nock('https://cdn.febbox.com').head('/x.mp4').reply(200, '', { 'content-type': 'text/html' });
    const result = await validateDirectUrl('https://cdn.febbox.com/x.mp4');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unexpected_content_type');
  });

  test('validateDirectUrl rejects when the upstream request fails/times out', async () => {
    nock('https://cdn.febbox.com').head('/x.mp4').replyWithError('boom');
    const result = await validateDirectUrl('https://cdn.febbox.com/x.mp4');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('request_failed');
  });

});
