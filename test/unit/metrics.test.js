'use strict';

const metrics = require('../../src/metrics/metrics');

beforeEach(() => metrics.reset());

describe('metrics', () => {
  test('incrementCounter accumulates and appears in snapshot', () => {
    metrics.incrementCounter(metrics.METRIC.DISCOVERY_SUCCESS);
    metrics.incrementCounter(metrics.METRIC.DISCOVERY_SUCCESS);
    metrics.incrementCounter(metrics.METRIC.DISCOVERY_MISS);
    const snap = metrics.snapshot();
    expect(snap.counters[metrics.METRIC.DISCOVERY_SUCCESS]).toBe(2);
    expect(snap.counters[metrics.METRIC.DISCOVERY_MISS]).toBe(1);
  });

  test('recordLatency tracks count/avg/min/max per stage', () => {
    metrics.recordLatency('tmdb_find', 100);
    metrics.recordLatency('tmdb_find', 300);
    const snap = metrics.snapshot();
    expect(snap.latency.tmdb_find).toEqual({ count: 2, avgMs: 200, minMs: 100, maxMs: 300 });
  });

  test('timed() records latency even when the wrapped function throws', async () => {
    await expect(
      metrics.timed('failing_stage', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const snap = metrics.snapshot();
    expect(snap.latency.failing_stage.count).toBe(1);
  });

  test('snapshot never includes secret-shaped keys — only counter/stage names', () => {
    metrics.incrementCounter(metrics.METRIC.PLAYBACK_RESOLUTION_SUCCESS);
    const snap = metrics.snapshot();
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toMatch(/ey[A-Za-z0-9_-]{10,}/); // no JWT-shaped substrings
    expect(serialized).not.toMatch(/ui=/i);
  });
});
