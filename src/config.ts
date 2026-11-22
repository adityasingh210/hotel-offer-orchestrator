function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: num(process.env.PORT, 3000),
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: process.env.TASK_QUEUE ?? 'hotel-offers',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // Where the worker reaches the mock supplier endpoints (served by the API).
  supplierBaseUrl: process.env.SUPPLIER_BASE_URL ?? 'http://localhost:3000',
  supplierTimeoutMs: num(process.env.SUPPLIER_TIMEOUT_MS, 3000),
  cacheTtlSeconds: num(process.env.CACHE_TTL_SECONDS, 300),
  // Partial results (a supplier was down) are cached for less time.
  partialCacheTtlSeconds: num(process.env.PARTIAL_CACHE_TTL_SECONDS, 30),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
