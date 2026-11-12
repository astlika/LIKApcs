/**
 * 0.33.4 — the server's "not enough stock" answer, in the language of the till. The cart already
 * stops an addition beyond the stock; this is for the moment the stock changed in between (another
 * till sold the last one) and the server refuses the sale or the PC's bill.
 */
import { ApiError } from './api';

export interface StockShortage {
  productName: string;
  /** What is still free (never below zero). */
  availableMilli: number;
}

export function stockShortageOf(err: unknown): StockShortage | null {
  if (!(err instanceof ApiError)) return null;
  const details = (err.details ?? {}) as {
    code?: string;
    productName?: string;
    availableMilli?: number;
  };
  if (err.code !== 'out_of_stock' && details.code !== 'INSUFFICIENT_STOCK') return null;
  return {
    productName: details.productName ?? '',
    availableMilli: Math.max(0, Number(details.availableMilli ?? 0)),
  };
}

/** The title of the message: "Only 2 in stock: Cola." / "Cola is out of stock." */
export function stockShortageText(
  shortage: StockShortage,
  t: (key: 'pos.stockOnly' | 'pos.stockNone', vars: Record<string, string | number>) => string,
): string {
  return shortage.availableMilli > 0
    ? t('pos.stockOnly', { n: shortage.availableMilli / 1000, name: shortage.productName })
    : t('pos.stockNone', { name: shortage.productName });
}
