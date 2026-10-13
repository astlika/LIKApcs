/**
 * Row-lock ordering helpers.
 *
 * Every transaction that moves a customer's money (a sale on the tab, a balance spend, a session
 * bill, a repayment) must take the customer row `FOR UPDATE` as its FIRST lock. Without that two
 * concurrent transactions of the same customer deadlock: each `INSERT … customer_id` takes a
 * `FOR KEY SHARE` lock on the customer (foreign key), one of them then waits for the shared
 * receipt-number row (`document_sequences`) while the other waits to upgrade its own customer
 * lock to `FOR UPDATE` (`debts.open`, `wallet.spend`). Taking the strongest lock up front makes
 * such transactions queue behind each other instead of crossing — the queue is per customer, so
 * unrelated cashiers are not slowed down.
 *
 * Several customers (rare — a session attached to one customer paid for by another) are locked
 * in id order so that two transactions never take them in opposite orders.
 */
import type { DbClient } from './pool.js';

export async function lockCustomers(
  client: DbClient,
  ...customerIds: ReadonlyArray<string | null | undefined>
): Promise<void> {
  const ids = [...new Set(customerIds.filter((id): id is string => !!id))].sort();
  for (const id of ids) {
    // Unknown ids lock nothing; the caller reports the missing customer itself.
    await client.query('SELECT 1 FROM customers WHERE id = $1 FOR UPDATE', [id]);
  }
}
