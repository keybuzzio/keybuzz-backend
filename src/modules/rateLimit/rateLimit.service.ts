/**
 * PH11-06C: Rate limiting and distributed locks (Redis-backed)
 */

import { getRedisClient } from '../../lib/redis.config';

/**
 * Acquire a distributed lock (SET NX EX)
 * Returns true if acquired, false if already locked
 */
export async function acquireLock(key: string, ttlSeconds = 60): Promise<boolean> {
  const redis = await getRedisClient();
  const lockKey = `lock:${key}`;
  
  // SET NX EX: set if not exists, with expiration
  const result = await redis.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
  
  if (result === 'OK') {
    console.log(`[Lock] Acquired: ${lockKey} (TTL ${ttlSeconds}s)`);
    return true;
  }
  
  console.log(`[Lock] Already locked: ${lockKey}`);
  return false;
}

/**
 * Release a distributed lock
 */
export async function releaseLock(key: string): Promise<void> {
  const redis = await getRedisClient();
  const lockKey = `lock:${key}`;
  
  await redis.del(lockKey);
  console.log(`[Lock] Released: ${lockKey}`);
}

/**
 * Check if rate limit is exceeded
 * Uses sliding window via INCR + EXPIRE
 * 
 * @param key - Rate limit key (e.g., "rl:email:tenant123")
 * @param maxCount - Max requests allowed in window
 * @param windowSeconds - Window duration
 * @returns true if allowed, false if rate limit exceeded
 */
export async function checkRateLimit(
  key: string,
  maxCount: number,
  windowSeconds: number
): Promise<boolean> {
  const redis = await getRedisClient();
  const rateLimitKey = `rl:${key}`;

  // Get current count
  const current = await redis.incr(rateLimitKey);

  // Set expiration on first increment
  if (current === 1) {
    await redis.expire(rateLimitKey, windowSeconds);
  }

  const allowed = current <= maxCount;

  if (!allowed) {
    console.warn(`[RateLimit] Exceeded: ${rateLimitKey} (${current}/${maxCount} in ${windowSeconds}s)`);
  }

  return allowed;
}

/**
 * Get current rate limit count
 */
export async function getRateLimitCount(key: string): Promise<number> {
  const redis = await getRedisClient();
  const rateLimitKey = `rl:${key}`;
  
  const count = await redis.get(rateLimitKey);
  return count ? parseInt(count, 10) : 0;
}

/**
 * Reset rate limit counter
 */
export async function resetRateLimit(key: string): Promise<void> {
  const redis = await getRedisClient();
  const rateLimitKey = `rl:${key}`;
  
  await redis.del(rateLimitKey);
  console.log(`[RateLimit] Reset: ${rateLimitKey}`);
}

// ---------------------------
// Predefined rate limit helpers
// ---------------------------

/**
 * Rate limit for Amazon polling (1 req/sec per tenant)
 */
export async function checkAmazonPollRateLimit(tenantId: string): Promise<boolean> {
  return checkRateLimit(`amazon:${tenantId}`, 1, 1);
}

/**
 * Rate limit for outbound emails per tenant (50/hour)
 */
export async function checkEmailTenantRateLimit(tenantId: string): Promise<boolean> {
  return checkRateLimit(`email:${tenantId}`, 50, 3600);
}

/**
 * Rate limit for outbound emails per ticket (5/hour)
 */
export async function checkEmailTicketRateLimit(ticketId: string): Promise<boolean> {
  return checkRateLimit(`email_ticket:${ticketId}`, 5, 3600);
}

