import type Redis from 'ioredis';
import type { BestOffer } from '../types';

/**
 * Redis layout per city:
 *   hotels:{city}        ZSET  member = JSON of the best offer, score = price
 *   hotels:{city}:meta   STRING JSON { updatedAt, count }  (marks the city as cached,
 *                               which matters because Redis drops empty sorted sets)
 * Both keys are written in one MULTI and share the same TTL.
 * Price filtering is done in Redis with ZRANGE ... BYSCORE.
 */
const listKey = (city: string) => `hotels:${city}`;
const metaKey = (city: string) => `hotels:${city}:meta`;

export async function saveHotels(redis: Redis, city: string, hotels: BestOffer[], ttlSeconds: number): Promise<void> {
  const tx = redis.multi().del(listKey(city));
  if (hotels.length > 0) {
    const args: (string | number)[] = [];
    for (const hotel of hotels) args.push(hotel.price, JSON.stringify(hotel));
    tx.zadd(listKey(city), ...args).expire(listKey(city), ttlSeconds);
  }
  tx.set(metaKey(city), JSON.stringify({ updatedAt: new Date().toISOString(), count: hotels.length }), 'EX', ttlSeconds);

  const results = await tx.exec();
  const failed = results?.find(([err]) => err);
  if (!results || failed) throw failed?.[0] ?? new Error('Redis transaction aborted');
}

/**
 * Returns hotels for the city whose price is within [min, max], cheapest first.
 * Returns null when the city is not cached (cache miss).
 */
export async function findHotelsByPrice(
  redis: Redis,
  city: string,
  min?: number,
  max?: number,
): Promise<BestOffer[] | null> {
  const results = await redis
    .multi()
    .get(metaKey(city))
    .zrange(listKey(city), min ?? '-inf', max ?? '+inf', 'BYSCORE')
    .exec();
  if (!results) throw new Error('Redis transaction aborted');
  const [[metaErr, meta], [rangeErr, members]] = results as [[Error | null, string | null], [Error | null, string[]]];
  if (metaErr || rangeErr) throw metaErr ?? rangeErr;

  if (!meta) return null;
  return members.map((m) => JSON.parse(m) as BestOffer);
}
