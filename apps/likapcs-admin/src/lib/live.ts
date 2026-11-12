import type { LiveSale } from '@likapcs/shared';

/** Window event fired for every sale the server announces to this admin (live.view only). */
export const LIVE_SALE_EVENT = 'likapcs:live-sale';

export function emitLiveSale(sale: LiveSale): void {
  window.dispatchEvent(new CustomEvent<LiveSale>(LIVE_SALE_EVENT, { detail: sale }));
}

/** 1500 milli = "1.5"; whole numbers without decimals. */
export function qtyLabel(milli: number): string {
  return String(Number((milli / 1000).toFixed(3)));
}

/** "Coca-Cola 0.5L ×1" for a product line; a PC time line keeps its own label ("PC 01 · 1 orë"). */
export function itemLabel(item: LiveSale['items'][number]): string {
  return item.isTime ? item.name : `${item.name} ×${qtyLabel(item.quantityMilli)}`;
}
