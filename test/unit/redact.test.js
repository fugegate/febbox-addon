'use strict';

const { redactString, redactValue, redactError } = require('../../src/security/redact');

describe('redact', () => {
  test('redacts ui= cookie style params in a URL', () => {
    const out = redactString('https://febbox.com/x?ui=SECRETVALUE123&other=1');
    expect(out).not.toContain('SECRETVALUE123');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts Cookie header style values', () => {
    const out = redactString('Cookie: ui=abc123; other=1');
    expect(out).not.toContain('abc123');
  });

  test('redacts token= and config= query params', () => {
    const out = redactString('token=deadbeef&config=zzz');
    expect(out).not.toContain('deadbeef');
    expect(out).not.toContain('zzz');
  });

  test('deep redacts sensitive object keys', () => {
    const out = redactValue({ ui: 'secret', nested: { token: 'nope', ok: 'fine' } });
    expect(out.ui).toBe('[REDACTED]');
    expect(out.nested.token).toBe('[REDACTED]');
    expect(out.nested.ok).toBe('fine');
  });

  test('redactError strips secrets from message and stack', () => {
    const err = new Error('failed calling https://x/?ui=SUPERSECRET');
    const safe = redactError(err);
    expect(safe.message).not.toContain('SUPERSECRET');
  });

  test('leaves ordinary strings unchanged', () => {
    expect(redactString('hello world')).toBe('hello world');
  });
});
