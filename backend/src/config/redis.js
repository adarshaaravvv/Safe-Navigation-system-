/**
 * Redis client — used for route score caching.
 * Gracefully degrades if Redis is unavailable.
 */

'use strict';

const { createClient } = require('redis');

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 3) return new Error('Redis reconnect limit reached');
      return Math.min(retries * 100, 1000);
    },
  },
});

client.on('error', (err) => {
  if (process.env.NODE_ENV !== 'test') {
    console.warn('Redis client error (falling back to no cache):', err.message);
  }
});

client.on('connect', () => console.log('✅ Redis connected'));
client.on('reconnecting', () => console.log('🔄 Redis reconnecting…'));

const TTL = parseInt(process.env.REDIS_TTL_SECONDS || '14400', 10); // 4hrs

/**
 * Get a cached value. Returns null if missing or Redis is down.
 */
async function get(key) {
  try {
    const val = await client.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

/**
 * Set a value with optional TTL.
 */
async function set(key, value, ttlSeconds = TTL) {
  try {
    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch {
    // Silent fail — no cache is acceptable
  }
}

/**
 * Delete one or more keys.
 */
async function del(...keys) {
  try {
    await client.del(...keys);
  } catch { /* silent */ }
}

/**
 * Delete all cache keys matching a pattern.
 * Used to invalidate route caches when new reviews arrive.
 */
async function invalidatePattern(pattern) {
  try {
    const keys = await client.keys(pattern);
    if (keys.length > 0) await client.del(...keys);
    return keys.length;
  } catch {
    return 0;
  }
}

module.exports = Object.assign(client, { get, set, del, invalidatePattern });
