export const SUPPLIERS = ['Supplier A', 'Supplier B'] as const;
export type SupplierName = (typeof SUPPLIERS)[number];

/** Shape returned by each supplier API. */
export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

/** Shape returned to the client: the best offer for one hotel. */
export interface BestOffer {
  name: string;
  price: number;
  supplier: SupplierName;
  commissionPct: number;
}

export interface SupplierHotels {
  supplier: SupplierName;
  hotels: SupplierHotel[];
}

export interface SupplierStatus {
  supplier: SupplierName;
  ok: boolean;
  count: number;
  error?: string;
}

export interface HotelOffersInput {
  city: string;
}

export interface HotelOffersResult {
  city: string;
  hotels: BestOffer[];
  suppliers: SupplierStatus[];
  cached: boolean;
}
