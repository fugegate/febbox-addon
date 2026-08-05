'use strict';

/**
 * Minimal in-memory production metrics. Counters and per-stage latency
 * histograms only — never anything token/user/title-shaped. Safe to expose
 * over an unauthenticated /metrics endpoint.
 */

const counters = new Map();
const latencies = new Map(); // stage -> { count, sumMs, minMs, maxMs }

function incrementCounter(name, by = 1) {
  counters.set(name, (counters.get(name) || 0) + by);
}

function recordLatency(stage, ms) {
  const existing = latencies.get(stage) || { count: 0, sumMs: 0, minMs: Infinity, maxMs: 0 };
  existing.count += 1;
  existing.sumMs += ms;
  existing.minMs = Math.min(existing.minMs, ms);
  existing.maxMs = Math.max(existing.maxMs, ms);
  latencies.set(stage, existing);
}

/** Wrap an async function, recording its latency under `stage` regardless of success/failure. */
async function timed(stage, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    recordLatency(stage, Date.now() - start);
  }
}

function snapshot() {
  const latencyOut = {};
  for (const [stage, v] of latencies.entries()) {
    latencyOut[stage] = {
      count: v.count,
      avgMs: Math.round(v.sumMs / v.count),
      minMs: v.minMs === Infinity ? null : v.minMs,
      maxMs: v.maxMs,
    };
  }
  return {
    counters: Object.fromEntries(counters),
    latency: latencyOut,
  };
}

function reset() {
  counters.clear();
  latencies.clear();
}

// Known counter names, centralized so call sites and docs/tests agree on spelling.
const METRIC = {
  DISCOVERY_SUCCESS: 'discovery_success',
  DISCOVERY_MISS: 'discovery_miss',
  STALE_SHARE: 'stale_share',
  FEBBOX_RATE_LIMITED: 'febbox_429',
  PLAYBACK_RESOLUTION_SUCCESS: 'playback_resolution_success',
  PLAYBACK_RESOLUTION_FAILURE: 'playback_resolution_failure',
};

module.exports = { incrementCounter, recordLatency, timed, snapshot, reset, METRIC };
