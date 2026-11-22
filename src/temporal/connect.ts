import { logger } from '../logger';

/** Retries a connect function so containers can start before Temporal is ready. */
export async function withRetry<T>(name: string, fn: () => Promise<T>, attempts = 30, delayMs = 2000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts) throw err;
      logger.warn({ attempt, error: String(err) }, `${name} not ready, retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
