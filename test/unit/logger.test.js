'use strict';

const logger = require('../../src/logging/logger');

describe('logger', () => {
  let spy;
  beforeEach(() => {
    spy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  test('info() emits a single JSON line with ts/level/message and merged fields', () => {
    logger.info('test_event', { foo: 'bar', count: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('test_event');
    expect(parsed.foo).toBe('bar');
    expect(parsed.count).toBe(3);
    expect(typeof parsed.ts).toBe('string');
  });

  test('redacts token-shaped strings in logged fields', () => {
    logger.info('token_leak_check', { note: 'ui=abc123; something', url: 'https://x.com/a?token=SECRETVALUE' });
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(JSON.stringify(parsed)).not.toContain('abc123');
    expect(JSON.stringify(parsed)).not.toContain('SECRETVALUE');
  });

  test('error() writes to console.error, not console.log', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('boom', { code: 'X' });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
