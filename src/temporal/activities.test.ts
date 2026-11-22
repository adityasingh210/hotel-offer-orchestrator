// Activity tests with Temporal's MockActivityEnvironment (no Temporal server needed).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import type Redis from 'ioredis';
import { createActivities } from './activities';
import { findHotelsByPrice } from '../cache/hotelCache';
import { connectTestRedis } from '../test/helpers';

/** Supplier stub whose response is decided per test. */
let respond: (path: string) => { status: number; body: string } = () => ({ status: 200, body: '[]' });
let lastPath = '';

describe('activities', async () => {
  const redis = await connectTestRedis();
  let server: Server;
  let activities: ReturnType<typeof createActivities>;
  const env = new MockActivityEnvironment();

  before(async () => {
    server = createServer((req, res) => {
      lastPath = req.url ?? '';
      const { status, body } = respond(lastPath);
      res.writeHead(status, { 'content-type': 'application/json' }).end(body);
    }).listen(0);
    activities = createActivities({
      supplierBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      supplierTimeoutMs: 1000,
      redis: (redis ?? {}) as Redis,
      cacheTtlSeconds: 300,
      partialCacheTtlSeconds: 30,
    });
  });

  after(async () => {
    server.close();
    await redis?.quit();
  });

  test('fetchSupplierHotels calls the right supplier and keeps valid hotels for the city', async () => {
    respond = () => ({
      status: 200,
      body: JSON.stringify([
        { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
        { hotelId: 'b2', name: 'Elsewhere', price: 100, city: 'mumbai', commissionPct: 5 },
        { hotelId: 'b3', name: 'Broken', price: 'free', city: 'delhi', commissionPct: 5 },
      ]),
    });
    const hotels = await env.run(activities.fetchSupplierHotels, 'Supplier B', 'delhi');
    assert.equal(lastPath, '/supplierB/hotels?city=delhi');
    assert.deepEqual(hotels.map((h) => h.name), ['Holtin']);
  });

  test('a 5xx response throws a retryable error', async () => {
    respond = () => ({ status: 503, body: '{}' });
    await assert.rejects(env.run(activities.fetchSupplierHotels, 'Supplier A', 'delhi'), (err: Error) => {
      assert.ok(!(err instanceof ApplicationFailure && err.nonRetryable));
      assert.match(err.message, /HTTP 503/);
      return true;
    });
  });

  test('a 4xx response throws a non-retryable failure', async () => {
    respond = () => ({ status: 404, body: '{}' });
    await assert.rejects(env.run(activities.fetchSupplierHotels, 'Supplier A', 'delhi'), (err: Error) => {
      assert.ok(err instanceof ApplicationFailure && err.nonRetryable);
      assert.equal((err as ApplicationFailure).type, 'SupplierClientError');
      return true;
    });
  });

  test('an invalid payload throws a non-retryable failure', async () => {
    respond = () => ({ status: 200, body: '{"not":"an array"}' });
    await assert.rejects(env.run(activities.fetchSupplierHotels, 'Supplier A', 'delhi'), (err: Error) => {
      assert.ok(err instanceof ApplicationFailure && err.nonRetryable);
      return true;
    });
  });

  test('cacheHotels writes the list and uses a shorter TTL for partial results', { skip: redis ? false : 'Redis not reachable' }, async () => {
    const hotels = [{ name: 'Holtin', price: 5340, supplier: 'Supplier B' as const, commissionPct: 20 }];
    await env.run(activities.cacheHotels, 'testcity', hotels, false);
    assert.deepEqual(await findHotelsByPrice(redis!, 'testcity'), hotels);
    assert.ok((await redis!.ttl('hotels:testcity')) > 30);

    await env.run(activities.cacheHotels, 'testcity', hotels, true);
    assert.ok((await redis!.ttl('hotels:testcity')) <= 30);
    await redis!.del('hotels:testcity', 'hotels:testcity:meta');
  });
});
