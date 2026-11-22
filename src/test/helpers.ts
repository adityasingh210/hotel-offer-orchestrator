import Redis from 'ioredis';

/** Connects to the test Redis, or returns null so Redis tests can be skipped. */
export async function connectTestRedis(): Promise<Redis | null> {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.ping();
    return redis;
  } catch {
    redis.disconnect();
    return null;
  }
}
