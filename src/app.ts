import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { WorkflowFailedError, type Client } from '@temporalio/client';
import type Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';
import { supplierRouter } from './suppliers/router';
import { SUPPLIER_PATHS } from './suppliers/paths';
import { findHotelsByPrice } from './cache/hotelCache';
import type { hotelOffersWorkflow } from './temporal/workflows';
import { SUPPLIERS, type BestOffer, type HotelOffersResult } from './types';

export interface AppDeps {
  redis: Redis;
  /** Returns the Temporal client, or null while it is still connecting. */
  getTemporal: () => Client | null;
  /** Base URL the health check uses to probe the suppliers. */
  supplierBaseUrl: string;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const CITY_PATTERN = /^[a-z][a-z .-]{0,49}$/;

function parseCity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Query parameter "city" is required');
  const city = value.trim().toLowerCase();
  if (!CITY_PATTERN.test(city)) throw new HttpError(400, 'Query parameter "city" is invalid');
  return city;
}

function parsePrice(name: string, value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const price = Number(value);
  if (typeof value !== 'string' || !Number.isFinite(price) || price < 0) {
    throw new HttpError(400, `Query parameter "${name}" must be a non-negative number`);
  }
  return price;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  // Request logging
  // Request ID (taken from X-Request-Id or generated) + access log
  app.use((req, res, next) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const start = Date.now();
    res.on('finish', () => {
      logger.info(
        { requestId, method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start },
        'request',
      );
    });
    next();
  });

  app.use(supplierRouter());

  /**
   * One workflow ID per city + USE_EXISTING conflict policy = request coalescing.
   * If 50 requests for "delhi" arrive together, they attach to the same running
   * workflow instead of calling the suppliers 50 times. Once it finishes, the next
   * request starts a new run (the default reuse policy allows that).
   */
  async function runWorkflow(city: string, requestId: string): Promise<HotelOffersResult> {
    const temporal = deps.getTemporal();
    if (!temporal) throw new HttpError(503, 'Temporal is not connected yet, try again shortly');
    try {
      return await temporal.workflow.execute<typeof hotelOffersWorkflow>('hotelOffersWorkflow', {
        taskQueue: config.taskQueue,
        workflowId: `hotel-offers-${city.replace(/[^a-z0-9]+/g, '-')}`,
        workflowIdConflictPolicy: 'USE_EXISTING',
        args: [{ city }],
        workflowExecutionTimeout: '30 seconds',
        memo: { requestId },
      });
    } catch (err) {
      if (err instanceof WorkflowFailedError) {
        const cause = err.cause as { type?: string; message?: string; details?: unknown[] } | undefined;
        if (cause?.type === 'AllSuppliersUnavailable') {
          throw new HttpError(502, 'All suppliers are unavailable', cause.details?.[0]);
        }
        throw new HttpError(502, cause?.message ?? 'Hotel workflow failed');
      }
      throw err;
    }
  }

  function setMetaHeaders(res: Response, source: 'workflow' | 'cache', result?: HotelOffersResult) {
    res.setHeader('X-Data-Source', source);
    const failed = result?.suppliers.filter((s) => !s.ok).map((s) => s.supplier) ?? [];
    if (failed.length) res.setHeader('X-Degraded-Suppliers', failed.join(', '));
  }

  /**
   * GET /api/hotels?city=delhi                         -> runs the workflow (fresh data, refreshes Redis)
   * GET /api/hotels?city=delhi&minPrice=..&maxPrice=.. -> filters in Redis; runs the workflow first on a cache miss
   */
  app.get('/api/hotels', async (req, res, next) => {
    try {
      const city = parseCity(req.query.city);
      const minPrice = parsePrice('minPrice', req.query.minPrice);
      const maxPrice = parsePrice('maxPrice', req.query.maxPrice);
      if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
        throw new HttpError(400, '"minPrice" cannot be greater than "maxPrice"');
      }

      const filtering = minPrice !== undefined || maxPrice !== undefined;
      if (!filtering) {
        const result = await runWorkflow(city, res.locals.requestId);
        setMetaHeaders(res, 'workflow', result);
        res.json(result.hotels);
        return;
      }

      const cached = await findHotelsByPrice(deps.redis, city, minPrice, maxPrice).catch((err) => {
        logger.warn({ city, error: String(err) }, 'Redis read failed, treating as cache miss');
        return null;
      });
      if (cached) {
        setMetaHeaders(res, 'cache');
        res.json(cached);
        return;
      }

      const result = await runWorkflow(city, res.locals.requestId);
      setMetaHeaders(res, 'workflow', result);
      let hotels: BestOffer[] | null = result.cached
        ? await findHotelsByPrice(deps.redis, city, minPrice, maxPrice).catch(() => null)
        : null;
      if (!hotels) {
        // Redis write failed inside the workflow; still answer correctly.
        logger.warn({ city }, 'Redis unavailable, filtering in memory');
        hotels = result.hotels.filter((h) => (minPrice ?? -Infinity) <= h.price && h.price <= (maxPrice ?? Infinity));
      }
      res.json(hotels);
    } catch (err) {
      next(err);
    }
  });

  /** Liveness probe for Docker/K8s: the process is up and serving HTTP. */
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** Health of both suppliers, Redis and Temporal. 200 when everything is up, 503 otherwise. */
  app.get('/health', async (_req, res) => {
    const probeSupplier = async (supplier: (typeof SUPPLIERS)[number]) => {
      const start = Date.now();
      try {
        const r = await fetch(`${deps.supplierBaseUrl}${SUPPLIER_PATHS[supplier]}`, { signal: AbortSignal.timeout(2000) });
        return { name: supplier, status: r.ok ? 'up' : 'down', httpStatus: r.status, latencyMs: Date.now() - start };
      } catch (err) {
        return { name: supplier, status: 'down', error: String(err), latencyMs: Date.now() - start };
      }
    };

    const checkRedis = async () => {
      try {
        return (await deps.redis.ping()) === 'PONG' ? 'up' : 'down';
      } catch {
        return 'down';
      }
    };

    const checkTemporal = async () => {
      const temporal = deps.getTemporal();
      if (!temporal) return 'down';
      try {
        await temporal.workflowService.getSystemInfo({});
        return 'up';
      } catch {
        return 'down';
      }
    };

    const [suppliers, redis, temporal] = await Promise.all([
      Promise.all(SUPPLIERS.map(probeSupplier)),
      checkRedis(),
      checkTemporal(),
    ]);
    const healthy = suppliers.every((s) => s.status === 'up') && redis === 'up' && temporal === 'up';
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      suppliers,
      dependencies: { redis, temporal },
    });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) {
        logger.warn({ requestId: res.locals.requestId, url: req.originalUrl, error: err.message, details: err.details }, 'request failed');
      }
      res.status(err.status).json({
        error: err.message,
        ...(err.details ? { details: err.details } : {}),
        requestId: res.locals.requestId,
      });
      return;
    }
    logger.error({ err, requestId: res.locals.requestId, url: req.originalUrl }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error', requestId: res.locals.requestId });
  });

  return app;
}
