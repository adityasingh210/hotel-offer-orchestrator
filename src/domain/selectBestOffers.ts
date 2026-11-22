// Pure, deterministic logic. It is safe to import inside a Temporal workflow.
import type { BestOffer, SupplierHotels } from '../types';

/** "  The  Leela " and "the leela" are treated as the same hotel. */
export function normalizeHotelName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Dedupes hotels by name across suppliers and keeps the cheapest offer.
 * If two suppliers have the same price, the higher commission wins.
 * A hotel listed by only one supplier is kept as is.
 * The result is sorted by price ascending, then by name.
 */
export function selectBestOffers(results: SupplierHotels[]): BestOffer[] {
  const best = new Map<string, BestOffer>();

  for (const { supplier, hotels } of results) {
    for (const hotel of hotels) {
      if (!hotel?.name || !Number.isFinite(hotel.price) || hotel.price < 0) continue;

      const key = normalizeHotelName(hotel.name);
      const current = best.get(key);
      const isBetter =
        !current ||
        hotel.price < current.price ||
        (hotel.price === current.price && hotel.commissionPct > current.commissionPct);

      if (isBetter) {
        best.set(key, {
          name: hotel.name.trim(),
          price: hotel.price,
          supplier,
          commissionPct: hotel.commissionPct,
        });
      }
    }
  }

  return [...best.values()].sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}
