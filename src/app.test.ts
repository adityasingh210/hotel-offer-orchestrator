// API integration tests: real Express app + real Redis, Temporal client faked.
// The fake runs the same domain logic and Redis writes as the real workflow.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import type Redis from 'ioredis';
import type { Client } from '@temporalio/client';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure, RetryState } from '@temporalio/common';
import { createApp, type AppDeps } from './app';
import { mockSuppliers } from './suppliers/router';
import { selectBestOffers } from './domain/selectBestOffers';
import { saveHotels } from './cache/hotelCache';
import { connectTestRedis } from './test/helpers';
import { SUPPLIERS, type HotelOffersInput, type HotelOffersResult, type SupplierHotels } from './types';

const suppliersByName = { 'Supplier A': mockSuppliers.supplierA, 'Supplier B': mockSuppliers.supplierB };

function fakeTemporal(redis: Redis) {
  const calls: { workflowId: string; policy?: string }[] = [];
  const client = {
    workflow: {
      async execute(_wf: string, opts: { workflowId: string; workflowIdConflictPolicy?: string; args: [HotelOffersInput] }) {
        calls.push({ workflowId: opts.workflowId, policy: opts.workflowIdConflictPolicy });
        const { city } = opts.args[0];
        const successful: SupplierHotels[] = [];
        const statuses = SUPPLIERS.map((supplier) => {
          const s = suppliersByName[supplier];
          if (!s.up) return { supplier, ok: false, count: 0, error: 'HTTP 503' };
          const hotels = s.hotels.filter((h) => h.city === city);
          successful.push({ supplier, hotels });
          return { supplier, ok: true, count: hotels.length };
        });
        if (!successful.length) {
          throw new WorkflowFailedError(
            'Workflow execution failed',
            ApplicationFailure.nonRetryable('All suppliers are unavailable', 'AllSuppliersUnavailable', statuses),
            RetryState.NON_RETRYABLE_FAILURE,
          );
        }
        const hotels = selectBestOffers(successful);
        await saveHotels(redis, city, hotels, 60);
        return { city, hotels, suppliers: statuses, cached: true } satisfies HotelOffersResult;
      },
    },
    workflowService: { getSystemInfo: async () => ({}) },
  };
  return { client: client as unknown as Client, calls };
}

describe('API', async () => {
  const redis = await connectTestRedis();
  const skip = redis ? false : 'Redis not reachable (set REDIS_URL)';

  let server: Server;
  let deps: AppDeps;
  let temporal: ReturnType<typeof fakeTemporal>;

  before(async () => {
    if (!redis) return;
    temporal = fakeTemporal(redis);
    deps = { redis, getTemporal: () => temporal.client, supplierBaseUrl: '' };
    server = createApp(deps).listen(0);
    deps.supplierBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    if (!redis) return;
    mockSuppliers.supplierA.up = true;
    mockSuppliers.supplierB.up = true;
    temporal.calls.length = 0;
    const keys = await redis.keys('hotels:*');
    if (keys.length) await redis.del(...keys);
  });

  after(async () => {
    server?.close();
    await redis?.quit();
  });

  test('returns deduplicated best offers in the response format', { skip }, async () => {
    const res = await request(server).get('/api/hotels?city=Delhi').expect(200);
    const names = res.body.map((h: { name: string }) => h.name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(res.body.find((h: { name: string }) => h.name === 'Holtin'), {
      name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20,
    });
    assert.deepEqual(res.body.find((h: { name: string }) => h.name === 'Radison'), {
      name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13,
    });
    assert.equal(res.headers['x-data-source'], 'workflow');
    assert.ok(res.headers['x-request-id']);
  });

  test('uses one workflow ID per city with USE_EXISTING (request coalescing)', { skip }, async () => {
    await Promise.all([request(server).get('/api/hotels?city=delhi'), request(server).get('/api/hotels?city=delhi')]);
    assert.deepEqual(temporal.calls.map((c) => c.workflowId), ['hotel-offers-delhi', 'hotel-offers-delhi']);
    assert.ok(temporal.calls.every((c) => c.policy === 'USE_EXISTING'));
  });

  test('filters by price in Redis, serving from cache after the first run', { skip }, async () => {
    const first = await request(server).get('/api/hotels?city=delhi&minPrice=5000&maxPrice=8000').expect(200);
    assert.equal(first.headers['x-data-source'], 'workflow');
    assert.deepEqual(first.body.map((h: { price: number }) => h.price), [5340, 5900, 7400]);

    const second = await request(server).get('/api/hotels?city=delhi&maxPrice=3000').expect(200);
    assert.equal(second.headers['x-data-source'], 'cache');
    assert.deepEqual(second.body.map((h: { name: string }) => h.name), ['Bloomrooms']);
    assert.equal(temporal.calls.length, 1);
  });

  test('returns an empty list for a city with no hotels (and caches it)', { skip }, async () => {
    await request(server).get('/api/hotels?city=goa').expect(200, []);
    const filtered = await request(server).get('/api/hotels?city=goa&minPrice=1').expect(200, []);
    assert.equal(filtered.headers['x-data-source'], 'cache');
  });

  test('returns a partial result when one supplier is down', { skip }, async () => {
    mockSuppliers.supplierB.up = false;
    const res = await request(server).get('/api/hotels?city=delhi').expect(200);
    assert.ok(res.body.every((h: { supplier: string }) => h.supplier === 'Supplier A'));
    assert.equal(res.headers['x-degraded-suppliers'], 'Supplier B');
  });

  test('returns 502 when all suppliers are down', { skip }, async () => {
    mockSuppliers.supplierA.up = false;
    mockSuppliers.supplierB.up = false;
    const res = await request(server).get('/api/hotels?city=delhi').expect(502);
    assert.equal(res.body.error, 'All suppliers are unavailable');
    assert.equal(res.body.details.length, 2);
  });

  test('validates query parameters', { skip }, async () => {
    await request(server).get('/api/hotels').expect(400);
    await request(server).get('/api/hotels?city=').expect(400);
    await request(server).get('/api/hotels?city=d3lhi!').expect(400);
    await request(server).get('/api/hotels?city=delhi&minPrice=-1').expect(400);
    await request(server).get('/api/hotels?city=delhi&maxPrice=abc').expect(400);
    await request(server).get('/api/hotels?city=delhi&minPrice=9000&maxPrice=1000').expect(400);
    assert.equal(temporal.calls.length, 0);
  });

  test('returns 503 while Temporal is not connected', { skip }, async () => {
    const app = createApp({ ...deps, getTemporal: () => null });
    await request(app).get('/api/hotels?city=delhi').expect(503);
  });

  test('/health reports both suppliers and dependencies', { skip }, async () => {
    const ok = await request(server).get('/health').expect(200);
    assert.equal(ok.body.status, 'ok');
    assert.deepEqual(ok.body.suppliers.map((s: { status: string }) => s.status), ['up', 'up']);
    assert.deepEqual(ok.body.dependencies, { redis: 'up', temporal: 'up' });

    await request(server).post('/admin/suppliers/supplierA/down').expect(200);
    const degraded = await request(server).get('/health').expect(503);
    assert.equal(degraded.body.suppliers[0].status, 'down');
    await request(server).get('/health/live').expect(200);
  });

  test('mock supplier endpoints filter by city', { skip }, async () => {
    const res = await request(server).get('/supplierA/hotels?city=mumbai').expect(200);
    assert.ok(res.body.length > 0 && res.body.every((h: { city: string }) => h.city === 'mumbai'));
    await request(server).post('/admin/suppliers/supplierC/down').expect(400);
  });
});
