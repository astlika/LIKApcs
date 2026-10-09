/**
 * Gap-free document numbers (receipts, invoices, refunds, purchases) per period.
 * Must be called inside the transaction that creates the document: the row lock taken by the
 * UPDATE serialises concurrent cashiers, and a rolled-back transaction releases the number.
 */
import type { DbClient } from '../db/pool.js';

export type DocumentKind = 'receipt' | 'invoice' | 'purchase' | 'refund';

export async function nextDocumentNumber(
  client: DbClient,
  kind: DocumentKind,
  at: Date = new Date(),
): Promise<string> {
  const period = String(at.getFullYear());
  const prefix = { receipt: 'R', invoice: 'F', purchase: 'B', refund: 'K' }[kind];
  const result = await client.query<{ next_value: string; prefix: string }>(
    `INSERT INTO document_sequences (kind, period, prefix, next_value)
       VALUES ($1, $2, $3, 2)
     ON CONFLICT (kind, period) DO UPDATE SET next_value = document_sequences.next_value + 1
     RETURNING next_value, prefix`,
    [kind, period, prefix],
  );
  const row = result.rows[0]!;
  const value = Number(row.next_value) - 1;
  return `${row.prefix || prefix}-${period}-${String(value).padStart(6, '0')}`;
}
