/**
 * "Waits at the desk" — the one definition every query shares.
 *
 * An ended pay-at-the-end session that has not been collected yet AND has something to collect:
 * money for its time, or orders still open on its bill. A session that owes nothing (stopped
 * within the first billing step, a free package) is simply over — "to collect" only ever lists
 * real money (0.19.0). `alias` is the SQL alias of `gaming_sessions` in the calling query.
 */
export const awaitingPaymentSql = (alias: string): string =>
  `(${alias}.billing_mode = 'endpay' AND ${alias}.billed_at IS NULL AND ${alias}.status IN ('expired', 'completed')
    AND (COALESCE(${alias}.final_price_cents, ${alias}.quoted_price_cents, 0) > 0
      OR EXISTS (SELECT 1 FROM station_orders ao WHERE ao.session_id = ${alias}.id AND ao.status = 'accepted')))`;
