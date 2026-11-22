import { ApplicationFailure, Context } from '@temporalio/activity';
import type Redis from 'ioredis';
import type { BestOffer, SupplierHotel, SupplierName } from '../types';
import { SUPPLIER_PATHS } from '../suppliers/paths';
import { saveHotels } from '../cache/hotelCache';

export interface ActivityDeps {
  supplierBaseUrl: string;
  supplierTimeoutMs: number;
  redis: Redis;
  cacheTtlSeconds: number;
  partialCacheTtlSeconds: number;
}

function isSupplierHotel(value: unknown): value is SupplierHotel {
  const h = value as SupplierHotel;
  return (
    typeof h === 'object' &&
    h !== null &&
    typeof h.name === 'string' &&
    typeof h.price === 'number' &&
    typeof h.commissionPct === 'number'
  );
}

export function createActivities(deps: ActivityDeps) {
  return {
    /** Calls one supplier for a city. 5xx and network errors are retried; 4xx and bad payloads are not. */
    async fetchSupplierHotels(supplier: SupplierName, city: string): Promise<SupplierHotel[]> {
      const { log, info } = Context.current();
      const url = `${deps.supplierBaseUrl}${SUPPLIER_PATHS[supplier]}?city=${encodeURIComponent(city)}`;
      log.info('Calling supplier', { supplier, city, attempt: info.attempt });

      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(deps.supplierTimeoutMs) });
      } catch (err) {
        log.warn('Supplier request failed', { supplier, attempt: info.attempt, error: String(err) });
        throw new Error(`${supplier} request failed: ${String(err)}`);
      }

      if (res.status >= 400 && res.status < 500) {
        throw ApplicationFailure.nonRetryable(`${supplier} rejected the request (HTTP ${res.status})`, 'SupplierClientError');
      }
      if (!res.ok) {
        log.warn('Supplier returned an error', { supplier, status: res.status, attempt: info.attempt });
        throw new Error(`${supplier} returned HTTP ${res.status}`);
      }

      const body: unknown = await res.json().catch(() => null);
      if (!Array.isArray(body)) {
        throw ApplicationFailure.nonRetryable(`${supplier} returned an invalid payload`, 'SupplierBadPayload');
      }

      const hotels = body.filter(isSupplierHotel).filter((h) => !h.city || h.city.toLowerCase() === city);
      log.info('Supplier responded', { supplier, city, count: hotels.length });
      return hotels;
    },

    /** Saves the deduplicated list to Redis (sorted set scored by price). Partial lists get a shorter TTL. */
    async cacheHotels(city: string, hotels: BestOffer[], partial = false): Promise<void> {
      const ttl = partial ? Math.min(deps.partialCacheTtlSeconds, deps.cacheTtlSeconds) : deps.cacheTtlSeconds;
      await saveHotels(deps.redis, city, hotels, ttl);
      Context.current().log.info('Cached hotels in Redis', { city, count: hotels.length, ttl, partial });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
