/**
 * PH11-06C: Redis configuration with auth support
 */

import Redis from 'ioredis';
import { getVaultSecret } from './vault';

let redisClient: Redis | null = null;

/**
 * Get Redis client with auth (singleton)
 */
export async function getRedisClient(): Promise<Redis> {
  if (redisClient && redisClient.status === 'ready') {
    return redisClient;
  }

  // Try REDIS_URL env var first (format: redis://:password@host:port)
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    redisClient = new Redis(redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      // Auth automatically handled by ioredis from URL
    });
  } else {
    // Fallback: build from parts (host, port, password)
    const host = process.env.REDIS_HOST || '10.0.0.10';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);

    // Try to get password from Vault
    let password: string | undefined;
    try {
      const secret = await getVaultSecret('secret/keybuzz/redis');
      password = (secret as { password?: string })?.password;
    } catch (err) {
      console.warn('[Redis] Could not fetch password from Vault, trying without auth:', err);
    }

    redisClient = new Redis({
      host,
      port,
      password,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      // If auth fails, Redis will respond NOAUTH and ioredis will throw
    });
  }

  // Wait for connection
  await redisClient.ping();
  console.log('[Redis] Connected successfully');

  return redisClient;
}

/**
 * Close Redis connection (cleanup)
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

