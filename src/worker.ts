import { NativeConnection, Runtime, Worker, makeTelemetryFilterString } from '@temporalio/worker';
import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';
import { createActivities } from './temporal/activities';
import { withRetry } from './temporal/connect';

async function main() {
  Runtime.install({
    telemetryOptions: { logging: { filter: makeTelemetryFilterString({ core: 'WARN' }) } },
  });

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  redis.on('error', (err) => logger.error({ err: String(err) }, 'Redis error'));

  const connection = await withRetry('Temporal', () => NativeConnection.connect({ address: config.temporalAddress }));

  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    workflowsPath: require.resolve('./temporal/workflows'),
    activities: createActivities({
      supplierBaseUrl: config.supplierBaseUrl,
      supplierTimeoutMs: config.supplierTimeoutMs,
      redis,
      cacheTtlSeconds: config.cacheTtlSeconds,
      partialCacheTtlSeconds: config.partialCacheTtlSeconds,
    }),
  });

  logger.info({ taskQueue: config.taskQueue, temporal: config.temporalAddress }, 'Worker started');
  await worker.run(); // resolves after SIGINT/SIGTERM shutdown
  await redis.quit();
  await connection.close();
  logger.info('Worker stopped');
}

main().catch((err) => {
  logger.fatal({ err }, 'Worker crashed');
  process.exit(1);
});
