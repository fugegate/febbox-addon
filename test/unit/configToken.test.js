'use strict';

const { encodeConfigToken, decodeConfigToken, hashToken } = require('../../src/config/configToken');

const SECRET = 'test-secret-at-least-16-chars';

describe('configToken', () => {
  test('round-trips a payload', () => {
    const token = encodeConfigToken({ febboxToken: 'abc123', quality: { max: '1080p' } }, SECRET);
    const decoded = decodeConfigToken(token, SECRET);
    expect(decoded.febboxToken).toBe('abc123');
    expect(decoded.quality.max).toBe('1080p');
    expect(typeof decoded.createdAt).toBe('number');
  });

  test('rejects tampered ciphertext', () => {
    const token = encodeConfigToken({ febboxToken: 'abc123' }, SECRET);
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(() => decodeConfigToken(tampered, SECRET)).toThrow();
  });

  test('rejects decoding with wrong secret', () => {
    const token = encodeConfigToken({ febboxToken: 'abc123' }, SECRET);
    expect(() => decodeConfigToken(token, 'a-completely-different-secret')).toThrow();
  });

  test('throws without a secret and no env var set', () => {
    const original = process.env.CONFIG_SECRET;
    delete process.env.CONFIG_SECRET;
    expect(() => encodeConfigToken({ febboxToken: 'abc' })).toThrow(/CONFIG_SECRET/);
    if (original) process.env.CONFIG_SECRET = original;
  });

  test('throws on empty febboxToken', () => {
    expect(() => encodeConfigToken({ febboxToken: '' }, SECRET)).toThrow();
  });

  test('does not embed the raw token in a recognizable way', () => {
    const token = encodeConfigToken({ febboxToken: 'super-secret-token-value' }, SECRET);
    expect(token).not.toContain('super-secret-token-value');
  });

  test('hashToken is deterministic and one-way-looking', () => {
    const h1 = hashToken('my-token');
    const h2 = hashToken('my-token');
    expect(h1).toBe(h2);
    expect(h1).not.toBe('my-token');
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });
});
