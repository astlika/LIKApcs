/**
 * 0.40.0 — the products on a PC's bill, each with the time it was put there.
 *
 * A customer who plays takes a drink, later something to eat; all of it is paid at the end. When
 * the bill is questioned ("I did not take that"), the desk reads the time next to the product and
 * looks at the camera recording of that minute. This module turns the orders of one session
 * (`GET /orders?sessionId=`) into that list; the components only draw it.
 */
import type { StationOrder } from '@likapcs/shared';

/** One product line of a PC's bill. */
export interface BillLine {
  key: string;
  orderId: string;
  orderNumber: number;
  name: string;
  quantityMilli: number;
  lineTotalCents: number;
  /**
   * When the product came onto the bill: the desk added it, or accepted what the customer sent
   * from the PC (that is when it is brought to the seat).
   */
  addedAt: string;
  /** When the customer sent it from the PC; null when the desk added it. */
  requestedAt: string | null;
  /** Who added or accepted it. */
  byName: string | null;
  /** Already paid: on the receipt `receiptNo`. */
  paid: boolean;
  receiptNo: string | null;
}

export interface SessionBill {
  /** On the bill, not paid yet — what the PC still owes for products. Oldest first. */
  open: BillLine[];
  /** Paid already (with the bill in parts, or at once at the desk). Oldest first. */
  paid: BillLine[];
  openCents: number;
  paidCents: number;
}

/** 2000 → "2", 1500 → "1.5": a quantity in thousandths, without trailing zeros. */
export function quantityText(quantityMilli: number): string {
  return String(Math.round(quantityMilli) / 1000);
}

/** The moment an order's products count as taken. */
export function orderAddedAt(order: Pick<StationOrder, 'decidedAt' | 'requestedAt'>): string {
  return order.decidedAt ?? order.requestedAt;
}

/**
 * The bill of one session from its orders. Only what the customer got is listed: an order that
 * still waits for the desk is not on the bill yet, and a rejected, cancelled or written-off one
 * never was (or no longer is).
 */
export function sessionBill(orders: readonly StationOrder[]): SessionBill {
  const open: BillLine[] = [];
  const paid: BillLine[] = [];
  for (const order of orders) {
    const isOpen = order.status === 'accepted';
    const isPaid = order.status === 'paid' || order.status === 'billed';
    if (!isOpen && !isPaid) continue;
    for (const item of order.items) {
      (isOpen ? open : paid).push({
        key: `${order.id}:${item.id}`,
        orderId: order.id,
        orderNumber: order.number,
        name: item.name,
        quantityMilli: item.quantityMilli,
        lineTotalCents: item.lineTotalCents,
        addedAt: orderAddedAt(order),
        requestedAt: order.fromDevice ? order.requestedAt : null,
        byName: order.decidedByName,
        paid: isPaid,
        receiptNo: order.receiptNo,
      });
    }
  }
  // Oldest first, as the evening went. Lines of one order keep the order they were entered in.
  const byTime = (a: BillLine, b: BillLine) =>
    Date.parse(a.addedAt) - Date.parse(b.addedAt) || a.orderNumber - b.orderNumber;
  open.sort(byTime);
  paid.sort(byTime);
  const sum = (lines: BillLine[]) => lines.reduce((acc, l) => acc + l.lineTotalCents, 0);
  return { open, paid, openCents: sum(open), paidCents: sum(paid) };
}
