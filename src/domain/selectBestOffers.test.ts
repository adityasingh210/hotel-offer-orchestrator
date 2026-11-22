import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBestOffers } from './selectBestOffers';
import type { SupplierHotel } from '../types';

const h = (name: string, price: number, commissionPct = 10): SupplierHotel => ({
  hotelId: name,
  name,
  price,
  city: 'delhi',
  commissionPct,
});

test('keeps the cheaper offer when both suppliers list a hotel', () => {
  const result = selectBestOffers([
    { supplier: 'Supplier A', hotels: [h('Holtin', 6000)] },
    { supplier: 'Supplier B', hotels: [h('Holtin', 5340, 20)] },
  ]);
  assert.deepEqual(result, [{ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 }]);
});

test('keeps hotels that only one supplier returns', () => {
  const result = selectBestOffers([
    { supplier: 'Supplier A', hotels: [h('Radison', 5900, 13)] },
    { supplier: 'Supplier B', hotels: [h('Taj', 9000)] },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => r.supplier), ['Supplier A', 'Supplier B']);
});

test('dedupes names regardless of case and spacing', () => {
  const result = selectBestOffers([
    { supplier: 'Supplier A', hotels: [h('The  Leela', 8000)] },
    { supplier: 'Supplier B', hotels: [h(' the leela ', 7900)] },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].supplier, 'Supplier B');
});

test('breaks a price tie with the higher commission', () => {
  const result = selectBestOffers([
    { supplier: 'Supplier A', hotels: [h('Hyatt', 7000, 12)] },
    { supplier: 'Supplier B', hotels: [h('Hyatt', 7000, 18)] },
  ]);
  assert.equal(result[0].supplier, 'Supplier B');
});

test('sorts by price and skips invalid entries', () => {
  const result = selectBestOffers([
    { supplier: 'Supplier A', hotels: [h('B', 300), h('A', 100), h('Bad', Number.NaN), h('Neg', -5)] },
  ]);
  assert.deepEqual(result.map((r) => r.name), ['A', 'B']);
});

test('returns an empty list when nothing is found', () => {
  assert.deepEqual(selectBestOffers([{ supplier: 'Supplier A', hotels: [] }]), []);
});
