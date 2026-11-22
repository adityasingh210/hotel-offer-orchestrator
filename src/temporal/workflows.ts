import { ApplicationFailure, log, proxyActivities } from '@temporalio/workflow';
import type { Activities } from './activities';
import { selectBestOffers } from '../domain/selectBestOffers';
import {
  SUPPLIERS,
  type HotelOffersInput,
  type HotelOffersResult,
  type SupplierHotels,
  type SupplierStatus,
} from '../types';

const { fetchSupplierHotels } = proxyActivities<Activities>({
  startToCloseTimeout: '5 seconds',
  retry: { maximumAttempts: 3, initialInterval: '300 ms', backoffCoefficient: 2, maximumInterval: '2 seconds' },
});

const { cacheHotels } = proxyActivities<Activities>({
  startToCloseTimeout: '5 seconds',
  retry: { maximumAttempts: 3, initialInterval: '200 ms' },
});

/**
 * 1. Call Supplier A and Supplier B in parallel.
 * 2. Dedupe by hotel name and keep the cheaper offer (or the only one).
 * 3. Save the list in Redis for price filtering.
 * One supplier failing is tolerated (partial result). Both failing fails the workflow.
 */
export async function hotelOffersWorkflow({ city }: HotelOffersInput): Promise<HotelOffersResult> {
  log.info('Hotel offers workflow started', { city });

  const settled = await Promise.allSettled(SUPPLIERS.map((supplier) => fetchSupplierHotels(supplier, city)));

  const successful: SupplierHotels[] = [];
  const statuses: SupplierStatus[] = settled.map((result, i) => {
    const supplier = SUPPLIERS[i];
    if (result.status === 'fulfilled') {
      successful.push({ supplier, hotels: result.value });
      return { supplier, ok: true, count: result.value.length };
    }
    const reason = result.reason as Error & { cause?: Error };
    const error = reason?.cause?.message ?? reason?.message ?? String(result.reason);
    log.warn('Supplier failed after retries, continuing without it', { supplier, error });
    return { supplier, ok: false, count: 0, error };
  });

  if (successful.length === 0) {
    throw ApplicationFailure.nonRetryable('All suppliers are unavailable', 'AllSuppliersUnavailable', statuses);
  }

  const hotels = selectBestOffers(successful);

  // A cache failure should not fail the request: the client still gets the list.
  let cached = true;
  try {
    await cacheHotels(city, hotels, successful.length < SUPPLIERS.length);
  } catch (err) {
    cached = false;
    log.error('Could not cache hotels in Redis', { city, error: String(err) });
  }

  log.info('Hotel offers workflow finished', { city, count: hotels.length, cached });
  return { city, hotels, suppliers: statuses, cached };
}
