import type { SupplierHotel } from '../types';

// Static mock data. Several hotel names appear in both suppliers so the
// comparison is meaningful. "goa" (or any other city) returns no hotels.

export const supplierAHotels: SupplierHotel[] = [
  // delhi
  { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
  { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
  { hotelId: 'a3', name: 'Taj Palace', price: 12500, city: 'delhi', commissionPct: 15 },
  { hotelId: 'a4', name: 'The Leela', price: 11200, city: 'delhi', commissionPct: 12 },
  { hotelId: 'a5', name: 'Lemon Tree', price: 3200, city: 'delhi', commissionPct: 8 },
  { hotelId: 'a6', name: 'Hyatt Regency', price: 9800, city: 'delhi', commissionPct: 14 },
  // mumbai
  { hotelId: 'a7', name: 'Trident', price: 10400, city: 'mumbai', commissionPct: 12 },
  { hotelId: 'a8', name: 'Holtin', price: 7600, city: 'mumbai', commissionPct: 11 },
  { hotelId: 'a9', name: 'Ibis', price: 3900, city: 'mumbai', commissionPct: 7 },
  // bangalore
  { hotelId: 'a10', name: 'ITC Gardenia', price: 11800, city: 'bangalore', commissionPct: 16 },
  { hotelId: 'a11', name: 'Radison', price: 6400, city: 'bangalore', commissionPct: 13 },
];

export const supplierBHotels: SupplierHotel[] = [
  // delhi
  { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
  { hotelId: 'b2', name: 'Radison', price: 6100, city: 'delhi', commissionPct: 15 },
  { hotelId: 'b3', name: 'Taj Palace', price: 11999, city: 'delhi', commissionPct: 18 },
  { hotelId: 'b4', name: 'The Leela', price: 11200, city: 'delhi', commissionPct: 17 },
  { hotelId: 'b5', name: 'Bloomrooms', price: 2800, city: 'delhi', commissionPct: 9 },
  { hotelId: 'b6', name: 'Pride Plaza', price: 7400, city: 'delhi', commissionPct: 11 },
  // mumbai
  { hotelId: 'b7', name: 'Trident', price: 9950, city: 'mumbai', commissionPct: 14 },
  { hotelId: 'b8', name: 'Holtin', price: 7800, city: 'mumbai', commissionPct: 19 },
  { hotelId: 'b9', name: 'Sea Princess', price: 6700, city: 'mumbai', commissionPct: 10 },
  // bangalore
  { hotelId: 'b10', name: 'ITC Gardenia', price: 12100, city: 'bangalore', commissionPct: 14 },
  { hotelId: 'b11', name: 'Radison', price: 6250, city: 'bangalore', commissionPct: 12 },
];
