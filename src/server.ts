import { Client, Connection } from '@temporalio/client';
import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';
import { createApp } from './app';
import { withRetry } from './temporal/connect';

async function main() {
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
  redis.on('error', (err) => logger.error({ err: String(err) }, 'Redis error'));

  let temporal: Client | null = null;
  let connection: Connection | null = null;

  const app = createApp({
    redis,
    getTemporal: () => temporal,
    supplierBaseUrl: `http://127.0.0.1:${config.port}`,
  });

  const server = app.listen(config.port, () => logger.info({ port: config.port }, 'API listening'));

  // Connect to Temporal in the background so /health and the mock suppliers work right away.
  withRetry('Temporal', () => Connection.connect({ address: config.temporalAddress }))
    .then((conn) => {
      connection = conn;
      temporal = new Client({ connection: conn, namespace: config.temporalNamespace });
      logger.info({ temporal: config.temporalAddress }, 'Connected to Temporal');
    })
    .catch((err) => {
      logger.fatal({ err }, 'Could not connect to Temporal');
      process.exit(1);
    });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await redis.quit().catch(() => undefined);
      await connection?.close().catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'API crashed');
  process.exit(1);
});
