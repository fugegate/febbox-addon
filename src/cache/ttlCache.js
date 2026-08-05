'use strict';

/**
 * Minimal in-memory TTL cache. Optional Redis backend can be layered on top
 * later via REDIS_URL without changing call sites (same get/set/del shape).
 *
 * Security note: callers must NEVER pass a raw FebBox token as a cache key —
 * use configToken.hashToken() first. This module does not itself know what
 * a "token" looks like, so that responsibility sits with callers.
 */
class TtlCache {
  constructor({ maxEntries = 5000 } = {}) {
    this.store = new Map();
    this.maxEntries = maxEntries;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = null) {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      // Evict oldest (Map preserves insertion order).
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, {
      value,
      expiresAt: ttlMs === null ? null : Date.now() + ttlMs,
    });
  }

  del(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

// Two logically separate caches per docs/IMPLEMENTATION_PLAN.md §8:
// - catalog: public, title/tmdbId -> share key mappings, safe to share
// - playback: keyed by hashed-token+fid, short TTL, never cross-user
const catalogCache = new TtlCache({ maxEntries: 2000 });
const playbackCache = new TtlCache({ maxEntries: 5000 });

module.exports = { TtlCache, catalogCache, playbackCache };
