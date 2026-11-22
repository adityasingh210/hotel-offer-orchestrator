import { Router } from 'express';
import type { SupplierHotel, SupplierName } from '../types';
import { supplierAHotels, supplierBHotels } from './mockData';
import { logger } from '../logger';
import { SUPPLIER_PATHS } from './paths';

type SupplierKey = 'supplierA' | 'supplierB';

interface MockSupplier {
  name: SupplierName;
  path: string;
  hotels: SupplierHotel[];
  up: boolean;
  delayMs: number;
}

/**
 * In-memory state for the mock suppliers. The "up" flag lets you simulate an
 * outage at runtime (see /admin/suppliers/:supplier/:state) or at startup with
 * SUPPLIER_A_DOWN=true / SUPPLIER_B_DOWN=true.
 */
export const mockSuppliers: Record<SupplierKey, MockSupplier> = {
  supplierA: {
    name: 'Supplier A',
    path: SUPPLIER_PATHS['Supplier A'],
    hotels: supplierAHotels,
    up: process.env.SUPPLIER_A_DOWN !== 'true',
    delayMs: Number(process.env.SUPPLIER_A_DELAY_MS ?? 0),
  },
  supplierB: {
    name: 'Supplier B',
    path: SUPPLIER_PATHS['Supplier B'],
    hotels: supplierBHotels,
    up: process.env.SUPPLIER_B_DOWN !== 'true',
    delayMs: Number(process.env.SUPPLIER_B_DELAY_MS ?? 0),
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function supplierRouter(): Router {
  const router = Router();

  for (const supplier of Object.values(mockSuppliers)) {
    // GET /supplierA/hotels and GET /supplierB/hotels (optional ?city=)
    router.get(supplier.path, async (req, res) => {
      if (supplier.delayMs > 0) await sleep(supplier.delayMs);
      if (!supplier.up) {
        res.status(503).json({ error: `${supplier.name} is unavailable` });
        return;
      }
      const city = typeof req.query.city === 'string' ? req.query.city.trim().toLowerCase() : undefined;
      res.json(city ? supplier.hotels.filter((h) => h.city === city) : supplier.hotels);
    });
  }

  // Simulate an outage: POST /admin/suppliers/supplierB/down, then .../up
  router.post('/admin/suppliers/:supplier/:state', (req, res) => {
    const supplier = mockSuppliers[req.params.supplier as SupplierKey];
    const { state } = req.params;
    if (!supplier || (state !== 'up' && state !== 'down')) {
      res.status(400).json({ error: 'Use /admin/suppliers/{supplierA|supplierB}/{up|down}' });
      return;
    }
    supplier.up = state === 'up';
    logger.warn({ supplier: supplier.name, up: supplier.up }, 'Mock supplier state changed');
    res.json({ supplier: supplier.name, up: supplier.up });
  });

  return router;
}
