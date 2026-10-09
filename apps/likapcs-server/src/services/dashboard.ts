import type { DashboardSummary } from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';
import type { AuditQueryService } from './audit-query.js';
import type { SettingsService } from './settings.js';
import type { StationsService } from './stations.js';

/**
 * Dashboard figures are computed from the real transactional tables. Until the POS (Phase 2)
 * and gaming billing (Phase 3) write to them, the monetary figures are legitimately zero.
 *
 * Accounting definitions (see docs/architecture.md → "Financial definitions"):
 *   revenue            = completed sale totals (gross) in the period
 *   COGS               = cost snapshots of sold product lines
 *   gross profit       = revenue − refunds − COGS
 *   operating profit   = gross profit − operating expenses   (stock purchases are NOT expenses)
 */
export class DashboardService {
  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
    private readonly stations: StationsService,
    private readonly audit: AuditQueryService,
  ) {}

  async summary(date: string): Promise<DashboardSummary> {
    const timezone = await this.settings.get('locale.timezone');
    const params = [date, timezone];

    const [
      sales,
      lines,
      refunds,
      purchases,
      expenses,
      cash,
      pendingDevices,
      lowStock,
      stations,
      recentAudit,
    ] = await Promise.all([
      this.pool.query<{ total: number }>(
        `SELECT COALESCE(SUM(total_cents), 0)::bigint AS total FROM sales
            WHERE status IN ('completed', 'partially_refunded', 'refunded')
              AND completed_at >= ($1::date)::timestamp AT TIME ZONE $2
              AND completed_at <  ($1::date + 1)::timestamp AT TIME ZONE $2`,
        params,
      ),
      this.pool.query<{ product: number; gaming: number; cogs: number }>(
        `SELECT COALESCE(SUM(CASE WHEN si.product_id IS NOT NULL THEN si.line_total_cents END), 0)::bigint AS product,
                  COALESCE(SUM(CASE WHEN si.gaming_session_id IS NOT NULL THEN si.line_total_cents END), 0)::bigint AS gaming,
                  COALESCE(SUM(si.cost_cents), 0)::bigint AS cogs
             FROM sale_items si JOIN sales s ON s.id = si.sale_id
            WHERE s.status IN ('completed', 'partially_refunded', 'refunded')
              AND s.completed_at >= ($1::date)::timestamp AT TIME ZONE $2
              AND s.completed_at <  ($1::date + 1)::timestamp AT TIME ZONE $2`,
        params,
      ),
      this.pool.query<{ total: number }>(
        `SELECT COALESCE(SUM(total_cents), 0)::bigint AS total FROM refunds
            WHERE created_at >= ($1::date)::timestamp AT TIME ZONE $2
              AND created_at <  ($1::date + 1)::timestamp AT TIME ZONE $2`,
        params,
      ),
      this.pool.query<{ total: number }>(
        `SELECT COALESCE(SUM(pri.quantity_milli * pri.unit_cost_cents / 1000), 0)::bigint AS total
             FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id = pri.receipt_id
            WHERE pr.received_at >= ($1::date)::timestamp AT TIME ZONE $2
              AND pr.received_at <  ($1::date + 1)::timestamp AT TIME ZONE $2`,
        params,
      ),
      this.pool.query<{ total: number }>(
        'SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM expenses WHERE expense_date = $1::date AND voided_at IS NULL',
        [date],
      ),
      this.pool.query<{ balance: number | null }>(
        `SELECT (cs.opening_cents + COALESCE((SELECT SUM(amount_cents) FROM cash_movements cm WHERE cm.shift_id = cs.id AND cm.movement_type <> 'opening'), 0))::bigint AS balance
             FROM cash_shifts cs WHERE cs.status = 'open' ORDER BY cs.opened_at DESC LIMIT 1`,
      ),
      this.pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM station_devices WHERE status = 'pending'",
      ),
      this.pool.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM products WHERE is_active AND track_stock AND stock_milli <= min_stock_milli',
      ),
      this.stations.list(),
      this.audit.recent(8),
    ]);

    const revenueTotal = sales.rows[0]?.total ?? 0;
    const refundsTotal = refunds.rows[0]?.total ?? 0;
    const cogs = lines.rows[0]?.cogs ?? 0;
    const expensesTotal = expenses.rows[0]?.total ?? 0;
    const grossProfit = revenueTotal - refundsTotal - cogs;

    const enabled = stations.filter((s) => s.isEnabled);
    const counts = {
      total: stations.length,
      enabled: enabled.length,
      online: enabled.filter((s) => s.device?.online).length,
      available: enabled.filter((s) => s.status === 'available').length,
      occupied: enabled.filter((s) => s.status === 'occupied' || s.status === 'locked').length,
      paused: enabled.filter((s) => s.status === 'paused').length,
      offline: enabled.filter((s) => s.status === 'offline').length,
      activeSessions: enabled.filter((s) => s.activeSession !== null).length,
    };

    return {
      date,
      revenue: {
        totalCents: revenueTotal,
        productSalesCents: lines.rows[0]?.product ?? 0,
        gamingCents: lines.rows[0]?.gaming ?? 0,
        refundsCents: refundsTotal,
      },
      purchasesCents: purchases.rows[0]?.total ?? 0,
      expensesCents: expensesTotal,
      costOfGoodsSoldCents: cogs,
      grossProfitCents: grossProfit,
      operatingProfitCents: grossProfit - expensesTotal,
      cashRegisterBalanceCents: cash.rows[0]?.balance ?? null,
      stations: counts,
      pendingDevices: pendingDevices.rows[0]?.count ?? 0,
      lowStockProducts: lowStock.rows[0]?.count ?? 0,
      recentAudit,
    };
  }
}
