// Workflow tests on Temporal's time-skipping test server, with mocked activities.
// The SDK downloads the test server binary on first run, so these tests only run
// when TEMPORAL_TESTS=1 (CI sets it).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { hotelOffersWorkflow } from './workflows';
import type { Activities } from './activities';
import type { BestOffer, SupplierHotel, SupplierName } from '../types';

const hotel = (name: string, price: number, commissionPct = 10): SupplierHotel => ({
  hotelId: `${name}-${price}`, name, price, city: 'delhi', commissionPct,
});

const data: Record<SupplierName, SupplierHotel[]> = {
  'Supplier A': [hotel('Holtin', 6000), hotel('Radison', 5900, 13)],
  'Supplier B': [hotel('Holtin', 5340, 20), hotel('Radison', 6100)],
};

describe('hotelOffersWorkflow', { skip: process.env.TEMPORAL_TESTS === '1' ? false : 'set TEMPORAL_TESTS=1 to run' }, () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: WorkflowBundleWithSourceMap;

  before(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    workflowBundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
  });

  after(async () => {
    await env?.teardown();
  });

  async function run(down: SupplierName[] = [], cacheFails = false) {
    const cached: { hotels: BestOffer[]; partial: boolean }[] = [];
    const activities: Activities = {
      async fetchSupplierHotels(supplier) {
        if (down.includes(supplier)) throw ApplicationFailure.nonRetryable(`${supplier} returned HTTP 503`);
        return data[supplier];
      },
      async cacheHotels(_city, hotels, partial = false) {
        if (cacheFails) throw ApplicationFailure.nonRetryable('Redis down');
        cached.push({ hotels, partial });
      },
    };
    const taskQueue = `test-${randomUUID()}`;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle, activities });
    const result = await worker.runUntil(
      env.client.workflow.execute(hotelOffersWorkflow, { taskQueue, workflowId: randomUUID(), args: [{ city: 'delhi' }] }),
    );
    return { result, cached };
  }

  test('picks the cheaper offer per hotel and caches the full list', async () => {
    const { result, cached } = await run();
    assert.deepEqual(result.hotels, [
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
    ]);
    assert.equal(result.cached, true);
    assert.deepEqual(cached.map((c) => c.partial), [false]);
  });

  test('continues with one supplier when the other fails', async () => {
    const { result, cached } = await run(['Supplier B']);
    assert.ok(result.hotels.every((h) => h.supplier === 'Supplier A'));
    assert.deepEqual(result.suppliers.map((s) => s.ok), [true, false]);
    assert.deepEqual(cached.map((c) => c.partial), [true]);
  });

  test('fails with AllSuppliersUnavailable when both suppliers fail', async () => {
    await assert.rejects(run(['Supplier A', 'Supplier B']), (err: unknown) => {
      assert.ok(err instanceof WorkflowFailedError);
      assert.equal((err.cause as ApplicationFailure).type, 'AllSuppliersUnavailable');
      return true;
    });
  });

  test('still returns hotels when caching fails', async () => {
    const { result } = await run([], true);
    assert.equal(result.cached, false);
    assert.equal(result.hotels.length, 2);
  });
});
