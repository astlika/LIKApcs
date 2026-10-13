/**
 * Gaming sessions — the authoritative clock and bill for every station (Phase 3).
 *
 * Model
 *  • prepaid  : the customer buys minutes (a package or a quoted amount) and pays at the start;
 *               the sale is recorded immediately. Extensions are further sales. The session
 *               expires on the server clock; the PC only mirrors the countdown.
 *  • postpaid : the clock runs until staff stop it; the bill is computed once at the end from the
 *               terms frozen on the row (`billing_terms`) and recorded as one sale + payment inside
 *               the same transaction that marks the session billed (`billed_at`/`sale_id`).
 *  • pauses are excluded from billable time; a prepaid expiry is shifted by the paused duration.
 *  • a PC that disconnects during a session is given `stations.session_grace_seconds`; after that
 *    the session is paused automatically from the moment of the disconnect, so nobody pays for a
 *    dead machine. Staff resume it when the PC is back.
 *
 * Every transition is one database transaction with the session row locked (`FOR UPDATE`), is
 * appended to `session_events`, mirrored to the PC through an acknowledged command and pushed to
 * every Admin app (`session.changed` + `station.changed`).
 */
import { randomUUID } from 'node:crypto';
import {
  billableSeconds,
  priceForSeconds,
  quotePrepaidMinutes,
  splitInclusiveTax,
  type BillingMode,
  type CollectSessionRequest,
  type EndSessionRequest,
  type ExtendSessionRequest,
  type ClientSessionBilling,
  type PricingTerms,
  type SessionEventSummary,
  type SessionListQuery,
  type SessionQuoteRequest,
  type SessionQuoteResponse,
  type SessionSummary,
  type ClientAckSummary,
  type SalePaymentInput,
  type SessionMutationResponse,
  SESSION_STOP_CLOCK_GRACE_SECONDS,
  type SessionPaymentSummary,
  type StartSessionRequest,
  SaleMathError,
  settlePayments,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';
import { applyMovement } from './catalog.js';
import { nextDocumentNumber } from './documents.js';
import type { PricingService } from './pricing.js';
import type { RequestCancelReason, SessionRequestsService } from './requests.js';
import type { SettingsService } from './settings.js';
import type { CashService } from './cash.js';
import type { DebtsService } from './debts.js';
import type { WalletService } from './wallet.js';
import type { StationsService } from './stations.js';
import { lockCustomers } from '../db/locks.js';

interface SessionRow {
  id: string;
  station_id: string;
  station_code: string;
  station_name: string;
  device_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  billing_mode: BillingMode;
  status: SessionSummary['status'];
  rule_name: string | null;
  package_name: string | null;
  rate_cents_per_hour: string | number;
  billing_terms: Partial<PricingTerms> | null;
  planned_seconds: number | null;
  started_at: Date;
  ends_at: Date | null;
  paused_at: Date | null;
  paused_by: SessionSummary['pausedBy'];
  total_paused_seconds: number;
  ended_at: Date | null;
  end_reason: SessionSummary['endReason'];
  open_orders_cents: string | number;
  open_orders_count: string | number;
  billable_seconds: number | null;
  quoted_price_cents: string | number | null;
  discount_cents: string | number;
  final_price_cents: string | number | null;
  sale_id: string | null;
  receipt_no: string | null;
  billed_at: Date | null;
  created_by_name: string | null;
  notes: string | null;
  created_at: Date;
}

const SESSION_SELECT = `
  SELECT g.id, g.station_id, s.code AS station_code, s.name AS station_name, g.device_id, g.customer_id,
         COALESCE(g.customer_name, c.name) AS customer_name, g.billing_mode, g.status,
         r.name AS rule_name, p.name AS package_name, g.rate_cents_per_hour, g.billing_terms,
         g.planned_seconds, g.started_at, g.ends_at, g.paused_at, g.paused_by, g.total_paused_seconds, g.ended_at,
         g.end_reason, g.billable_seconds, g.quoted_price_cents, g.discount_cents, g.final_price_cents,
         g.sale_id, sa.receipt_no, g.billed_at, u.full_name AS created_by_name, g.notes, g.created_at,
         (SELECT COALESCE(SUM(o.total_cents), 0)::bigint FROM station_orders o
           WHERE o.session_id = g.id AND o.status = 'accepted') AS open_orders_cents,
         (SELECT COUNT(*)::int FROM station_orders o
           WHERE o.session_id = g.id AND o.status = 'accepted') AS open_orders_count
    FROM gaming_sessions g
    JOIN stations s ON s.id = g.station_id
    LEFT JOIN customers c ON c.id = g.customer_id
    LEFT JOIN pricing_rules r ON r.id = g.pricing_rule_id
    LEFT JOIN gaming_packages p ON p.id = g.package_id
    LEFT JOIN sales sa ON sa.id = g.sale_id
    LEFT JOIN users u ON u.id = g.created_by`;

export type SessionMutationResult = SessionMutationResponse;

/** One ordered product line that joins the session's sale (snapshot prices from the order). */
export interface OrderLineForSale {
  orderId: string;
  productId: string;
  name: string;
  quantityMilli: number;
  unitPriceCents: number;
  lineTotalCents: number;
  trackStock: boolean;
  allowNegative: boolean;
  unitCostCents: number;
}
export interface SessionOrdersHook {
  /** Locks and returns the lines of the session's accepted "on the bill" orders. */
  openLinesForSession(client: DbClient, sessionId: string): Promise<OrderLineForSale[]>;
  /** Marks those orders billed with the sale that settled them (same transaction). */
  markBilled(
    client: DbClient,
    orderIds: string[],
    saleId: string,
    actor: AuditActor,
  ): Promise<void>;
  /** After commit: tell the Admin and the PC. */
  announce(orderIds: string[]): Promise<void>;
}

export interface SessionActorContext extends AuditActor {
  permissions?: Set<string>;
}

/**
 * Money facts the PC may *display* (never decide): prepaid → the amount paid for the booked time;
 * postpaid → the terms plus a billable-seconds snapshot it counts on from. See ClientSessionBilling.
 */
export function clientBillingOf(session: SessionSummary): ClientSessionBilling {
  const prepaid = session.billingMode === 'prepaid';
  const endPay = session.billingMode === 'endpay';
  return {
    billingMode: session.billingMode,
    paidCents: prepaid ? (session.quotedPriceCents ?? 0) : 0,
    // End pay: the PC shows "pay at the end · amount" — the reserved amount, never a running one.
    dueCents: endPay ? (session.quotedPriceCents ?? 0) : 0,
    terms: session.billingMode === 'postpaid' ? session.terms : null,
    billableSeconds: session.billableSeconds,
    asOf: new Date().toISOString(),
  };
}

/** End pay, ended early: the used time is billed, never more than the reserved amount. */
export function endPayAmountCents(
  usedSeconds: number,
  terms: PricingTerms,
  reservedCents: number,
): number {
  return Math.min(priceForSeconds(usedSeconds, terms), reservedCents);
}

export function termsFromRow(row: SessionRow): PricingTerms {
  const t = row.billing_terms ?? {};
  return {
    rateCentsPerHour: Number(t.rateCentsPerHour ?? row.rate_cents_per_hour ?? 0),
    billingIncrementMinutes: Number(t.billingIncrementMinutes ?? 1),
    minimumMinutes: Number(t.minimumMinutes ?? 0),
    minimumChargeCents: Number(t.minimumChargeCents ?? 0),
    roundingMode: t.roundingMode ?? 'up',
    roundingIncrementCents: Number(t.roundingIncrementCents ?? 1),
  };
}

const MODE_WORDS: Record<BillingMode, string> = {
  prepaid: 'prepaid',
  postpaid: 'postpaid',
  endpay: 'pay at the end',
};

function describe(row: SessionRow, seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  const duration = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
  return `${row.station_code} · ${duration} (${MODE_WORDS[row.billing_mode] ?? row.billing_mode})`;
}

export class SessionsService {
  /** Stations whose device dropped while a session was live: stationId → disconnect time. */
  private readonly offlineSince = new Map<string, number>();
  private readonly warned = new Set<string>();
  private ticking = false;

  constructor(
    private readonly pool: DbPool,
    private readonly hub: RealtimeHub,
    private readonly settings: SettingsService,
    private readonly pricing: PricingService,
    private readonly stations: StationsService,
    private readonly cash: CashService,
    private readonly debts: DebtsService,
    private readonly wallet: WalletService,
    private readonly log: {
      info: (o: unknown, m?: string) => void;
      warn: (o: unknown, m?: string) => void;
      error: (o: unknown, m?: string) => void;
    },
  ) {
    hub.on('device.offline', ({ stationId, deviceId }) => {
      void this.onDeviceOffline(stationId, deviceId);
    });
    hub.on('device.online', (presence) => {
      void this.onDeviceOnline(presence.stationId, presence.deviceId);
    });
  }

  /** Customer session requests (0.9.0) — wired after construction (the requests service quotes through us). */
  private requests: SessionRequestsService | null = null;
  useRequests(requests: SessionRequestsService): void {
    this.requests = requests;
  }

  /** Orders from the PC (0.10.0): "on the bill" orders are settled inside the end transaction. */
  private orders: SessionOrdersHook | null = null;
  useOrders(orders: SessionOrdersHook): void {
    this.orders = orders;
  }

  /**
   * Inside a session transaction: answer the request this action approves, or cancel the pending
   * ones it made moot. Returns the ids to announce once the transaction committed.
   */
  private async settleRequests(
    client: DbClient,
    opts: {
      stationId: string;
      sessionId: string;
      approve?: { requestId: string; kind: 'start' | 'extend' } | null;
      cancel: { kinds: ('start' | 'extend')[]; reason: RequestCancelReason };
    },
    actor: SessionActorContext,
  ): Promise<{ approved: string | null; cancelled: string[] }> {
    if (!this.requests) return { approved: null, cancelled: [] };
    if (opts.approve) {
      await this.requests.approveInTransaction(
        client,
        opts.approve.requestId,
        { kind: opts.approve.kind, stationId: opts.stationId, sessionId: opts.sessionId },
        actor,
      );
    }
    const cancelled = await this.requests.cancelForStation(
      client,
      opts.stationId,
      opts.cancel.kinds,
      opts.cancel.reason,
      actor,
    );
    return { approved: opts.approve?.requestId ?? null, cancelled };
  }

  private async announceRequests(settled: { approved: string | null; cancelled: string[] }) {
    if (!this.requests) return;
    if (settled.approved) await this.requests.announceApproved(settled.approved);
    if (settled.cancelled.length) await this.requests.announceCancelled(settled.cancelled);
  }

  // ─── Mapping ─────────────────────────────────────────────────────────────────

  /** Customer pauses end by themselves after `sessions.pause_max_minutes` (cached each tick). */
  private pauseMaxMinutes = 15;

  mapRow(row: SessionRow, now: Date = new Date()): SessionSummary {
    const terms = termsFromRow(row);
    const autoResumeAt =
      row.status === 'paused' &&
      row.paused_by === 'customer' &&
      row.paused_at &&
      this.pauseMaxMinutes > 0
        ? new Date(row.paused_at.getTime() + this.pauseMaxMinutes * 60_000).toISOString()
        : null;
    const live = row.status === 'active' || row.status === 'paused';
    const seconds = live
      ? billableSeconds({
          startedAt: row.started_at,
          endedAt: now,
          totalPausedSeconds: row.total_paused_seconds,
          pausedAt: row.paused_at,
        })
      : (row.billable_seconds ?? 0);
    let currentPrice: number;
    if (!live) currentPrice = Number(row.final_price_cents ?? row.quoted_price_cents ?? 0);
    else if (row.billing_mode === 'postpaid') currentPrice = priceForSeconds(seconds, terms);
    // Prepaid: what was paid. End pay: what will be due (the reserved amount).
    else currentPrice = Number(row.quoted_price_cents ?? 0);
    const awaitingPayment =
      row.billing_mode === 'endpay' &&
      !live &&
      row.status !== 'cancelled' &&
      row.billed_at === null;
    return {
      id: row.id,
      stationId: row.station_id,
      stationCode: row.station_code,
      stationName: row.station_name,
      customerId: row.customer_id,
      customerName: row.customer_name,
      billingMode: row.billing_mode,
      status: row.status,
      ruleName: row.rule_name,
      packageName: row.package_name,
      rateCentsPerHour: terms.rateCentsPerHour,
      terms,
      plannedSeconds: row.planned_seconds,
      startedAt: row.started_at.toISOString(),
      endsAt: row.ends_at?.toISOString() ?? null,
      pausedAt: row.paused_at?.toISOString() ?? null,
      pausedBy: row.status === 'paused' ? row.paused_by : null,
      autoResumeAt,
      totalPausedSeconds: row.total_paused_seconds,
      endedAt: row.ended_at?.toISOString() ?? null,
      endReason: row.end_reason,
      billableSeconds: seconds,
      currentPriceCents: currentPrice,
      quotedPriceCents: row.quoted_price_cents === null ? null : Number(row.quoted_price_cents),
      discountCents: Number(row.discount_cents),
      finalPriceCents: row.final_price_cents === null ? null : Number(row.final_price_cents),
      saleId: row.sale_id,
      receiptNo: row.receipt_no,
      billedAt: row.billed_at?.toISOString() ?? null,
      createdByName: row.created_by_name,
      notes: row.notes,
      openOrdersCents: Number(row.open_orders_cents ?? 0),
      openOrdersCount: Number(row.open_orders_count ?? 0),
      awaitingPayment,
      createdAt: row.created_at.toISOString(),
    };
  }

  // ─── Reads ───────────────────────────────────────────────────────────────────

  async getById(id: string, db: Queryable = this.pool): Promise<SessionSummary> {
    const result = await db.query<SessionRow>(`${SESSION_SELECT} WHERE g.id = $1`, [id]);
    if (!result.rows[0]) throw notFound('Session');
    return this.mapRow(result.rows[0]);
  }

  async liveForStation(
    stationId: string,
    db: Queryable = this.pool,
  ): Promise<SessionSummary | null> {
    const result = await db.query<SessionRow>(
      `${SESSION_SELECT} WHERE g.station_id = $1 AND g.status IN ('active', 'paused')`,
      [stationId],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  /** The customer the PC is playing on right now (null: no live session or a walk-in). */
  async customerOfStation(stationId: string): Promise<string | null> {
    const r = await this.pool.query<{ customer_id: string | null }>(
      `SELECT customer_id FROM gaming_sessions WHERE station_id = $1 AND status IN ('active', 'paused') LIMIT 1`,
      [stationId],
    );
    return r.rows[0]?.customer_id ?? null;
  }

  async list(query: SessionListQuery): Promise<{ items: SessionSummary[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      where.push(`g.status = $${params.length}`);
    }
    if (query.stationId) {
      params.push(query.stationId);
      where.push(`g.station_id = $${params.length}`);
    }
    if (query.customerId) {
      params.push(query.customerId);
      where.push(`g.customer_id = $${params.length}`);
    }
    if (query.awaitingPayment)
      where.push(
        `g.billing_mode = 'endpay' AND g.billed_at IS NULL AND g.status IN ('expired', 'completed')`,
      );
    if (query.from) {
      params.push(query.from);
      where.push(`g.started_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`g.started_at < $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM gaming_sessions g ${clause}`,
      params,
    );
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await this.pool.query<SessionRow>(
      `${SESSION_SELECT} ${clause} ORDER BY g.started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const now = new Date();
    return {
      items: rows.rows.map((r) => this.mapRow(r, now)),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }

  async events(id: string): Promise<SessionEventSummary[]> {
    await this.getById(id);
    const result = await this.pool.query<{
      id: string;
      event_type: string;
      occurred_at: Date;
      actor_name: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT e.id, e.event_type, e.occurred_at, u.full_name AS actor_name, e.payload
         FROM session_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.session_id = $1 ORDER BY e.occurred_at, e.id`,
      [id],
    );
    return result.rows.map((r) => ({
      id: Number(r.id),
      eventType: r.event_type,
      occurredAt: r.occurred_at.toISOString(),
      actorName: r.actor_name,
      payload: r.payload,
    }));
  }

  /** What a prepaid/postpaid session on this station costs right now. */
  async quote(req: SessionQuoteRequest, at: Date = new Date()): Promise<SessionQuoteResponse> {
    const resolved = await this.pricing.resolveTerms(req.stationId, at);
    const base: SessionQuoteResponse = {
      billingMode: req.billingMode,
      minutes: null,
      priceCents: 0,
      rule: resolved.rule
        ? {
            id: resolved.rule.id,
            name: resolved.rule.name,
            rateCentsPerHour: resolved.rule.rateCentsPerHour,
          }
        : null,
      package: null,
      terms: resolved.terms,
    };
    if (req.billingMode === 'postpaid') return base;
    if (req.packageId) {
      const pkg = await this.pricing.getPackage(req.packageId);
      const clock = await this.clock(at);
      if (!this.pricing.packageAvailable(pkg, req.stationId, clock)) {
        throw badRequest('This package is not available for this station right now');
      }
      return {
        ...base,
        minutes: pkg.durationMinutes,
        priceCents: pkg.priceCents,
        package: { id: pkg.id, name: pkg.name },
      };
    }
    const minutes = req.minutes ?? 0;
    if (minutes <= 0) throw badRequest('minutes must be positive');
    if (!resolved.rule)
      throw badRequest('No pricing rule applies to this station right now — add one under Pricing');
    return { ...base, minutes, priceCents: quotePrepaidMinutes(minutes, resolved.terms) };
  }

  private async clock(at: Date) {
    const { localClock } = await import('@likapcs/shared');
    const { safeTimeZone } = await import('./pricing.js');
    return localClock(at, safeTimeZone(await this.settings.get('locale.timezone')));
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  async start(
    req: StartSessionRequest,
    actor: SessionActorContext,
  ): Promise<SessionMutationResult> {
    const now = new Date();
    if (req.clientRequestId) {
      const existing = await this.pool.query<{ id: string }>(
        'SELECT id FROM gaming_sessions WHERE client_request_id = $1',
        [req.clientRequestId],
      );
      if (existing.rows[0])
        return { session: await this.getById(existing.rows[0].id), client: null };
    }
    const station = await this.stations.getById(req.stationId);
    if (!station.isEnabled) throw conflict('Station is disabled');
    const quote = await this.quote(req, now);
    const plannedSeconds = quote.minutes ? quote.minutes * 60 : null;
    let payment: SessionPaymentSummary | null = null;
    let settled = { approved: null as string | null, cancelled: [] as string[] };

    const session = await withTransaction(this.pool, async (client) => {
      // Customer first (see db/locks.ts): several PCs started at once on one tab must queue, not
      // deadlock on the receipt number.
      await lockCustomers(client, req.customerId);
      const live = await client.query(
        'SELECT id FROM gaming_sessions WHERE station_id = $1 AND status IN ($2, $3) FOR UPDATE',
        [req.stationId, 'active', 'paused'],
      );
      if (live.rowCount) throw conflict('A session is already running on this station');
      // A customer session supersedes a staff maintenance unlock.
      await client.query(
        'UPDATE stations SET maintenance_until = NULL, maintenance_by = NULL, maintenance_by_name = NULL WHERE id = $1',
        [req.stationId],
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO gaming_sessions (station_id, device_id, customer_id, customer_name, billing_mode, status,
           pricing_rule_id, package_id, rate_cents_per_hour, billing_terms, planned_seconds, started_at, ends_at,
           quoted_price_cents, created_by, notes, client_request_id)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
        [
          req.stationId,
          station.device?.id ?? null,
          req.customerId ?? null,
          req.customerName || null,
          req.billingMode,
          quote.rule?.id ?? null,
          quote.package?.id ?? null,
          quote.terms.rateCentsPerHour,
          JSON.stringify(quote.terms),
          plannedSeconds,
          now,
          plannedSeconds ? new Date(now.getTime() + plannedSeconds * 1000) : null,
          // Prepaid: the amount paid. End pay: the amount due at the desk when the time ends.
          req.billingMode === 'postpaid' ? null : quote.priceCents,
          actor.userId ?? null,
          req.notes ?? null,
          req.clientRequestId ?? null,
        ],
      );
      const id = inserted.rows[0]!.id;
      await this.addEvent(client, id, 'created', actor, { billingMode: req.billingMode, quote });
      await this.addEvent(client, id, 'started', actor, {
        startedAt: now.toISOString(),
        plannedSeconds,
        // End pay (0.14.0): nothing is taken now; the figure is what the desk collects later.
        ...(req.billingMode === 'endpay' ? { dueCents: quote.priceCents, endPay: true } : {}),
      });
      if (req.billingMode === 'prepaid') {
        const sale = await this.recordSale(client, {
          sessionId: id,
          description: `${station.code} · ${quote.minutes} min (prepaid${quote.package ? `: ${quote.package.name}` : ''})`,
          priceCents: quote.priceCents,
          discountCents: 0,
          tenders: req,
          customerId: req.customerId ?? null,
          actor,
          at: now,
        });
        payment = sale.payment;
        await client.query(
          `UPDATE gaming_sessions SET sale_id = $2, billed_at = $3, final_price_cents = $4 WHERE id = $1 AND billed_at IS NULL`,
          [id, sale.saleId, now, quote.priceCents],
        );
        await this.addEvent(client, id, 'billed', actor, {
          saleId: sale.saleId,
          receiptNo: sale.receiptNo,
          amountCents: quote.priceCents,
          methods: sale.methods,
        });
      }
      await recordAudit(client, actor, {
        action: 'session.start',
        entityType: 'gaming_session',
        entityId: id,
        details: {
          stationCode: station.code,
          billingMode: req.billingMode,
          minutes: quote.minutes,
          priceCents: quote.priceCents,
          requestId: req.requestId ?? null,
        },
      });
      // A customer's start request is answered by this start (approved) — any other pending
      // start request on the PC is moot now; a pending extension cannot exist without a session.
      settled = await this.settleRequests(
        client,
        {
          stationId: req.stationId,
          sessionId: id,
          approve: req.requestId ? { requestId: req.requestId, kind: 'start' } : null,
          cancel: { kinds: ['start', 'extend'], reason: 'session_started' },
        },
        actor,
      );
      return this.getById(id, client);
    });
    await this.announceRequests(settled);

    const ack = await this.mirror(
      session,
      'session.start',
      {
        sessionId: session.id,
        startedAt: session.startedAt,
        endsAt: session.endsAt,
        billing: clientBillingOf(session),
      },
      actor,
    );
    await this.broadcast(session);
    return { session, client: ack, payment };
  }

  async pause(
    id: string,
    actor: SessionActorContext,
    at: Date = new Date(),
    systemReason?: 'grace' | 'customer',
  ): Promise<SessionMutationResult> {
    const pausedBy = systemReason ?? 'staff';
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'active') throw conflict(`Session is ${row.status}, not active`);
      const pausedAt = at < row.started_at ? row.started_at : at;
      await client.query(
        'UPDATE gaming_sessions SET status = $2, paused_at = $3, paused_by = $4, version = version + 1 WHERE id = $1',
        [id, 'paused', pausedAt, pausedBy],
      );
      await this.addEvent(client, id, systemReason === 'grace' ? 'grace_ended' : 'paused', actor, {
        pausedAt: pausedAt.toISOString(),
        reason: pausedBy,
      });
      return this.getById(id, client);
    });
    const remaining = session.endsAt
      ? Math.max(
          0,
          Math.round(
            (Date.parse(session.endsAt) - Date.parse(session.pausedAt ?? session.endsAt)) / 1000,
          ),
        )
      : null;
    const ack = await this.mirror(
      session,
      'session.pause',
      {
        sessionId: id,
        remainingSeconds: remaining,
        pausedBy: session.pausedBy,
        autoResumeAt: session.autoResumeAt,
      },
      actor,
    );
    await this.broadcast(session);
    return { session, client: ack };
  }

  async resume(
    id: string,
    actor: SessionActorContext,
    at: Date = new Date(),
    /** `customer` = pressed Resume on the PC; `auto` = the customer pause ran past its limit. */
    by: 'staff' | 'customer' | 'auto' = 'staff',
  ): Promise<SessionMutationResult> {
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'paused' || !row.paused_at)
        throw conflict(`Session is ${row.status}, not paused`);
      const pausedFor = Math.max(0, Math.floor((at.getTime() - row.paused_at.getTime()) / 1000));
      const endsAt = row.ends_at ? new Date(row.ends_at.getTime() + pausedFor * 1000) : null;
      await client.query(
        `UPDATE gaming_sessions SET status = 'active', paused_at = NULL, paused_by = NULL,
           total_paused_seconds = total_paused_seconds + $2, ends_at = $3, version = version + 1 WHERE id = $1`,
        [id, pausedFor, endsAt],
      );
      await this.addEvent(client, id, 'resumed', actor, {
        pausedForSeconds: pausedFor,
        endsAt: endsAt?.toISOString() ?? null,
        by,
      });
      return this.getById(id, client);
    });
    this.warned.forEach((k) => k.startsWith(`${id}:`) && this.warned.delete(k));
    const ack = await this.mirror(
      session,
      'session.resume',
      { sessionId: id, endsAt: session.endsAt, billing: clientBillingOf(session), by },
      actor,
    );
    await this.broadcast(session);
    return { session, client: ack };
  }

  async extend(
    id: string,
    req: ExtendSessionRequest,
    actor: SessionActorContext,
  ): Promise<SessionMutationResult> {
    const now = new Date();
    let payment: SessionPaymentSummary | null = null;
    let settled = { approved: null as string | null, cancelled: [] as string[] };
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      await lockCustomers(client, row.customer_id);
      if (row.billing_mode === 'postpaid')
        throw conflict(
          'Only prepaid / end-pay sessions can be extended; postpaid sessions run until stopped',
        );
      if (row.status !== 'active' && row.status !== 'paused')
        throw conflict(`Session is ${row.status}`);
      const endPay = row.billing_mode === 'endpay';
      if (req.clientRequestId) {
        const dup = await client.query(
          'SELECT 1 FROM session_events WHERE session_id = $1 AND event_type = $2 AND payload->>$3 = $4',
          [id, 'extended', 'clientRequestId', req.clientRequestId],
        );
        if (dup.rowCount) return this.getById(id, client);
      }
      const quote = await this.quote(
        {
          stationId: row.station_id,
          billingMode: 'prepaid',
          packageId: req.packageId,
          minutes: req.minutes,
        },
        now,
      );
      const extraSeconds = (quote.minutes ?? 0) * 60;
      // Prepaid: the extension is paid right now (a second sale). End pay: it is added to the
      // amount the desk collects when the time ends — no money moves here.
      const sale = endPay
        ? null
        : await this.recordSale(client, {
            sessionId: id,
            description: `${row.station_code} · +${quote.minutes} min (extension${quote.package ? `: ${quote.package.name}` : ''})`,
            priceCents: quote.priceCents,
            discountCents: 0,
            tenders: req,
            customerId: row.customer_id,
            actor,
            at: now,
          });
      payment = sale?.payment ?? null;
      await client.query(
        `UPDATE gaming_sessions SET planned_seconds = planned_seconds + $2, ends_at = ends_at + make_interval(secs => $2),
           quoted_price_cents = quoted_price_cents + $3, final_price_cents = final_price_cents + $3, version = version + 1
         WHERE id = $1`,
        [id, extraSeconds, quote.priceCents],
      );
      await this.addEvent(client, id, 'extended', actor, {
        minutes: quote.minutes,
        priceCents: quote.priceCents,
        saleId: sale?.saleId ?? null,
        receiptNo: sale?.receiptNo ?? null,
        deferred: endPay,
        clientRequestId: req.clientRequestId ?? null,
      });
      await recordAudit(client, actor, {
        action: 'session.extend',
        entityType: 'gaming_session',
        entityId: id,
        details: {
          minutes: quote.minutes,
          priceCents: quote.priceCents,
          requestId: req.requestId ?? null,
        },
      });
      settled = await this.settleRequests(
        client,
        {
          stationId: row.station_id,
          sessionId: id,
          approve: req.requestId ? { requestId: req.requestId, kind: 'extend' } : null,
          cancel: { kinds: ['extend'], reason: 'session_extended' },
        },
        actor,
      );
      return this.getById(id, client);
    });
    await this.announceRequests(settled);
    this.warned.forEach((k) => k.startsWith(`${id}:`) && this.warned.delete(k));
    const ack = await this.mirror(
      session,
      'session.extend',
      { sessionId: id, endsAt: session.endsAt, billing: clientBillingOf(session) },
      actor,
    );
    await this.broadcast(session);
    return { session, client: ack, payment };
  }

  /** Staff stop. Postpaid sessions are billed here, exactly once. */
  async end(
    id: string,
    req: EndSessionRequest,
    actor: SessionActorContext,
    at: Date = new Date(),
  ): Promise<SessionMutationResult> {
    let payment: SessionPaymentSummary | null = null;
    let settled = { approved: null as string | null, cancelled: [] as string[] };
    let billedOrders: string[] = [];
    const requestedAt = at;
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      await lockCustomers(client, row.customer_id, req.customerId);
      if (row.status !== 'active' && row.status !== 'paused')
        throw conflict(`Session already ${row.status}`);
      // Drinks / snacks ordered from the seat and accepted "on the bill" are settled right here,
      // on the same receipt as the time (postpaid) or on their own receipt (prepaid).
      const orderLines = this.orders ? await this.orders.openLinesForSession(client, id) : [];
      const orderIds = [...new Set(orderLines.map((l) => l.orderId))];
      // Staff may stop the clock when they open the checkout, within a bounded window: the price
      // the customer was told is the price billed, but the server decides how far back "now" goes.
      let at = requestedAt;
      if (req.stoppedSecondsAgo && row.billing_mode !== 'prepaid' && row.status === 'active') {
        const back = Math.min(req.stoppedSecondsAgo, SESSION_STOP_CLOCK_GRACE_SECONDS) * 1000;
        at = new Date(Math.max(row.started_at.getTime(), requestedAt.getTime() - back));
      }
      const seconds = billableSeconds({
        startedAt: row.started_at,
        endedAt: at,
        totalPausedSeconds: row.total_paused_seconds,
        pausedAt: row.paused_at,
      });
      if (req.customerId && req.customerId !== row.customer_id) {
        const found = await client.query<{ status: string }>(
          'SELECT status FROM customers WHERE id = $1',
          [req.customerId],
        );
        if (!found.rows[0] || found.rows[0].status === 'archived')
          throw badRequest('Customer not found');
        await client.query(
          'UPDATE gaming_sessions SET customer_id = $2, customer_name = NULL WHERE id = $1',
          [id, req.customerId],
        );
        row.customer_id = req.customerId;
      }
      if (row.billing_mode === 'postpaid') {
        if (row.billed_at) throw conflict('Session is already billed');
        const price = priceForSeconds(seconds, termsFromRow(row));
        if (req.discountCents > 0 && !actor.permissions?.has('pos.discount'))
          throw forbidden('Missing permission: pos.discount');
        if (req.discountCents > price) throw badRequest('Discount exceeds the price');
        const final = price - req.discountCents;
        const sale = await this.recordSale(client, {
          sessionId: id,
          description: describe(row, seconds),
          priceCents: price,
          discountCents: req.discountCents,
          tenders: req,
          customerId: row.customer_id,
          actor,
          at,
          orderLines,
        });
        payment = sale.payment;
        if (orderIds.length && this.orders) {
          await this.orders.markBilled(client, orderIds, sale.saleId, actor);
          billedOrders = orderIds;
        }
        const updated = await client.query(
          `UPDATE gaming_sessions SET status = 'completed', ended_at = $2, end_reason = 'stopped_by_staff', billable_seconds = $3,
             discount_cents = $4, final_price_cents = $5, sale_id = $6, billed_at = $2, paused_at = NULL, notes = COALESCE($7, notes),
             version = version + 1
           WHERE id = $1 AND billed_at IS NULL`,
          [id, at, seconds, req.discountCents, final, sale.saleId, req.notes ?? null],
        );
        if (updated.rowCount !== 1) throw conflict('Session was billed concurrently');
        await this.addEvent(client, id, 'stopped', actor, {
          endedAt: at.toISOString(),
          billableSeconds: seconds,
        });
        if (req.discountCents > 0)
          await this.addEvent(client, id, 'discount_applied', actor, {
            discountCents: req.discountCents,
          });
        await this.addEvent(client, id, 'billed', actor, {
          saleId: sale.saleId,
          receiptNo: sale.receiptNo,
          amountCents: final,
          methods: sale.methods,
        });
      } else if (row.billing_mode === 'endpay') {
        // Pay at the end (0.14.0), stopped by staff before the time ran out: the used time is
        // billed, capped at the reserved amount. With `payments` the money is taken right here
        // (one receipt, open orders included); without, the PC is freed now and the bill waits at
        // the desk ("awaiting payment") until `collect`.
        if (row.billed_at) throw conflict('Session is already billed');
        const reserved = Number(row.quoted_price_cents ?? 0);
        const price = endPayAmountCents(seconds, termsFromRow(row), reserved);
        if (req.discountCents > 0 && !actor.permissions?.has('pos.discount'))
          throw forbidden('Missing permission: pos.discount');
        if (req.discountCents > price) throw badRequest('Discount exceeds the price');
        const final = price - req.discountCents;
        if (req.payments) {
          const sale = await this.recordSale(client, {
            sessionId: id,
            description: describe(row, seconds),
            priceCents: price,
            discountCents: req.discountCents,
            tenders: req,
            customerId: row.customer_id,
            actor,
            at,
            orderLines,
          });
          payment = sale.payment;
          if (orderIds.length && this.orders) {
            await this.orders.markBilled(client, orderIds, sale.saleId, actor);
            billedOrders = orderIds;
          }
          const updated = await client.query(
            `UPDATE gaming_sessions SET status = 'completed', ended_at = $2, end_reason = 'stopped_by_staff', billable_seconds = $3,
               discount_cents = $4, final_price_cents = $5, sale_id = $6, billed_at = $2, paused_at = NULL, paused_by = NULL,
               notes = COALESCE($7, notes), version = version + 1
             WHERE id = $1 AND billed_at IS NULL`,
            [id, at, seconds, req.discountCents, final, sale.saleId, req.notes ?? null],
          );
          if (updated.rowCount !== 1) throw conflict('Session was billed concurrently');
          await this.addEvent(client, id, 'stopped', actor, {
            endedAt: at.toISOString(),
            billableSeconds: seconds,
            reservedCents: reserved,
          });
          if (req.discountCents > 0)
            await this.addEvent(client, id, 'discount_applied', actor, {
              discountCents: req.discountCents,
            });
          await this.addEvent(client, id, 'billed', actor, {
            saleId: sale.saleId,
            receiptNo: sale.receiptNo,
            amountCents: final,
            methods: sale.methods,
          });
        } else {
          await client.query(
            `UPDATE gaming_sessions SET status = 'completed', ended_at = $2, end_reason = 'stopped_by_staff', billable_seconds = $3,
               discount_cents = $4, final_price_cents = $5, paused_at = NULL, paused_by = NULL, notes = COALESCE($6, notes),
               version = version + 1
             WHERE id = $1 AND billed_at IS NULL`,
            [id, at, seconds, req.discountCents, final, req.notes ?? null],
          );
          await this.addEvent(client, id, 'stopped', actor, {
            endedAt: at.toISOString(),
            billableSeconds: seconds,
            reservedCents: reserved,
            awaitingPayment: true,
            dueCents: final,
          });
          if (req.discountCents > 0)
            await this.addEvent(client, id, 'discount_applied', actor, {
              discountCents: req.discountCents,
            });
        }
      } else {
        if (orderLines.length && this.orders) {
          // Prepaid time was paid at the start; only the orders are billed now.
          const sale = await this.recordSale(client, {
            sessionId: id,
            description: describe(row, seconds),
            priceCents: null,
            discountCents: 0,
            tenders: req,
            customerId: row.customer_id,
            actor,
            at,
            orderLines,
          });
          payment = sale.payment;
          await this.orders.markBilled(client, orderIds, sale.saleId, actor);
          billedOrders = orderIds;
          await this.addEvent(client, id, 'billed', actor, {
            saleId: sale.saleId,
            receiptNo: sale.receiptNo,
            amountCents: sale.payment.totalCents,
            methods: sale.methods,
            orders: orderIds.length,
          });
        }
        await client.query(
          `UPDATE gaming_sessions SET status = 'completed', ended_at = $2, end_reason = 'stopped_by_staff', billable_seconds = $3,
             paused_at = NULL, paused_by = NULL, notes = COALESCE($4, notes), version = version + 1 WHERE id = $1`,
          [id, at, seconds, req.notes ?? null],
        );
        await this.addEvent(client, id, 'stopped', actor, {
          endedAt: at.toISOString(),
          billableSeconds: seconds,
          unusedSeconds: Math.max(0, (row.planned_seconds ?? 0) - seconds),
        });
      }
      await recordAudit(client, actor, {
        action: 'session.end',
        entityType: 'gaming_session',
        entityId: id,
        details: { billableSeconds: seconds, billingMode: row.billing_mode },
      });
      settled = await this.settleRequests(
        client,
        {
          stationId: row.station_id,
          sessionId: id,
          cancel: { kinds: ['extend'], reason: 'session_ended' },
        },
        actor,
      );
      return this.getById(id, client);
    });
    await this.announceRequests(settled);
    if (billedOrders.length && this.orders) await this.orders.announce(billedOrders);
    const ack = await this.mirror(session, 'session.end', { sessionId: id }, actor);
    await this.broadcast(session);
    return { session, client: ack, payment };
  }

  /**
   * End pay (0.14.0): staff take the money for a session that has ended (ran out or was stopped
   * without payment). One receipt: the time (the amount due, minus an optional discount) plus
   * any orders still open on the bill. Exactly once — `billed_at` guards it.
   */
  async collect(
    id: string,
    req: CollectSessionRequest,
    actor: SessionActorContext,
    at: Date = new Date(),
  ): Promise<SessionMutationResult> {
    let payment: SessionPaymentSummary | null = null;
    let billedOrders: string[] = [];
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      await lockCustomers(client, row.customer_id, req.customerId);
      if (row.billing_mode !== 'endpay')
        throw conflict('Only pay-at-the-end sessions are collected at the desk');
      if (row.status === 'active' || row.status === 'paused')
        throw conflict('Session is still running — end it first');
      if (row.status === 'cancelled') throw conflict('Session was cancelled; nothing to collect');
      if (row.billed_at) throw conflict('Session is already paid');
      const orderLines = this.orders ? await this.orders.openLinesForSession(client, id) : [];
      const orderIds = [...new Set(orderLines.map((l) => l.orderId))];
      if (req.customerId && req.customerId !== row.customer_id) {
        const found = await client.query<{ status: string }>(
          'SELECT status FROM customers WHERE id = $1',
          [req.customerId],
        );
        if (!found.rows[0] || found.rows[0].status === 'archived')
          throw badRequest('Customer not found');
        await client.query(
          'UPDATE gaming_sessions SET customer_id = $2, customer_name = NULL WHERE id = $1',
          [id, req.customerId],
        );
        row.customer_id = req.customerId;
      }
      // The amount due was fixed when the session ended (used time capped at the reservation, or
      // the full reservation when it ran out); a discount already applied at the end stays.
      const due = Number(row.final_price_cents ?? row.quoted_price_cents ?? 0);
      if (req.discountCents > 0 && !actor.permissions?.has('pos.discount'))
        throw forbidden('Missing permission: pos.discount');
      if (req.discountCents > due) throw badRequest('Discount exceeds the amount due');
      const final = due - req.discountCents;
      const sale = await this.recordSale(client, {
        sessionId: id,
        description: describe(row, row.billable_seconds ?? 0),
        priceCents: due,
        discountCents: req.discountCents,
        tenders: req,
        customerId: row.customer_id,
        actor,
        at,
        orderLines,
      });
      payment = sale.payment;
      if (orderIds.length && this.orders) {
        await this.orders.markBilled(client, orderIds, sale.saleId, actor);
        billedOrders = orderIds;
      }
      const updated = await client.query(
        `UPDATE gaming_sessions SET discount_cents = discount_cents + $2, final_price_cents = $3, sale_id = $4, billed_at = $5,
           notes = COALESCE($6, notes), version = version + 1
         WHERE id = $1 AND billed_at IS NULL`,
        [id, req.discountCents, final, sale.saleId, at, req.notes ?? null],
      );
      if (updated.rowCount !== 1) throw conflict('Session was collected concurrently');
      if (req.discountCents > 0)
        await this.addEvent(client, id, 'discount_applied', actor, {
          discountCents: req.discountCents,
        });
      await this.addEvent(client, id, 'billed', actor, {
        saleId: sale.saleId,
        receiptNo: sale.receiptNo,
        amountCents: final,
        methods: sale.methods,
        collected: true,
        orders: orderIds.length,
      });
      await recordAudit(client, actor, {
        action: 'session.collect',
        entityType: 'gaming_session',
        entityId: id,
        details: {
          stationCode: row.station_code,
          amountCents: final,
          discountCents: req.discountCents,
          orders: orderIds.length,
        },
      });
      return this.getById(id, client);
    });
    if (billedOrders.length && this.orders) await this.orders.announce(billedOrders);
    await this.broadcast(session);
    return { session, client: null, payment };
  }

  /** Postpaid / end pay: stop without charging (wrong station, test, customer left immediately). */
  async cancel(
    id: string,
    actor: SessionActorContext,
    reason: string,
    at: Date = new Date(),
  ): Promise<SessionMutationResult> {
    let settled = { approved: null as string | null, cancelled: [] as string[] };
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      await lockCustomers(client, row.customer_id);
      if (row.status !== 'active' && row.status !== 'paused')
        throw conflict(`Session already ${row.status}`);
      // End pay (0.14.0) took no money, so it cancels like postpaid.
      if (row.billing_mode === 'prepaid')
        throw conflict('Prepaid sessions are already paid; refund them from the sale instead');
      await client.query(
        `UPDATE gaming_sessions SET status = 'cancelled', ended_at = $2, end_reason = 'cancelled', billable_seconds = 0,
           final_price_cents = 0, paused_at = NULL, notes = COALESCE(notes || E'\\n', '') || $3, version = version + 1 WHERE id = $1`,
        [id, at, `Cancelled: ${reason}`],
      );
      await this.addEvent(client, id, 'cancelled', actor, { reason });
      await recordAudit(client, actor, {
        action: 'session.cancel',
        entityType: 'gaming_session',
        entityId: id,
        details: { reason },
        severity: 'warning',
      });
      settled = await this.settleRequests(
        client,
        {
          stationId: row.station_id,
          sessionId: id,
          cancel: { kinds: ['extend'], reason: 'session_ended' },
        },
        actor,
      );
      return this.getById(id, client);
    });
    await this.announceRequests(settled);
    const ack = await this.mirror(session, 'session.end', { sessionId: id }, actor);
    await this.broadcast(session);
    return { session, client: ack };
  }

  /**
   * Prepaid / end-pay expiry — idempotent; ended exactly at `ends_at`, never at "now". An end-pay
   * session that runs out owes the full reserved amount: it is parked as "awaiting payment" (the
   * PC locks, the bill waits at the desk until `collect`).
   */
  async expire(
    id: string,
    actor: AuditActor = { label: 'system' },
  ): Promise<SessionSummary | null> {
    let settled = { approved: null as string | null, cancelled: [] as string[] };
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'active' || row.billing_mode === 'postpaid' || !row.ends_at) return null;
      if (row.ends_at.getTime() > Date.now()) return null;
      const seconds = billableSeconds({
        startedAt: row.started_at,
        endedAt: row.ends_at,
        totalPausedSeconds: row.total_paused_seconds,
        pausedAt: null,
      });
      const endPay = row.billing_mode === 'endpay';
      await client.query(
        `UPDATE gaming_sessions SET status = 'expired', ended_at = ends_at, end_reason = 'expired', billable_seconds = $2,
           final_price_cents = CASE WHEN billing_mode = 'endpay' THEN quoted_price_cents ELSE final_price_cents END,
           version = version + 1
         WHERE id = $1`,
        [id, seconds],
      );
      await this.addEvent(client, id, 'expired', actor, {
        endsAt: row.ends_at.toISOString(),
        ...(endPay ? { awaitingPayment: true, dueCents: Number(row.quoted_price_cents ?? 0) } : {}),
      });
      settled = await this.settleRequests(
        client,
        {
          stationId: row.station_id,
          sessionId: id,
          cancel: { kinds: ['extend'], reason: 'session_ended' },
        },
        actor,
      );
      return this.getById(id, client);
    });
    if (!session) return null;
    await this.announceRequests(settled);
    await this.mirror(session, 'session.end', { sessionId: id }, actor);
    await this.broadcast(session);
    return session;
  }

  // ─── Client reconciliation ───────────────────────────────────────────────────

  /** `session` field of server.welcome: what the PC must show right after (re)connecting. */
  async welcomePayload(stationId: string) {
    const live = await this.liveForStation(stationId);
    if (!live) return null;
    const remaining = live.endsAt
      ? Math.max(
          0,
          Math.round(
            (Date.parse(live.endsAt) - (live.pausedAt ? Date.parse(live.pausedAt) : Date.now())) /
              1000,
          ),
        )
      : null;
    return {
      id: live.id,
      status: live.status as 'active' | 'paused',
      startedAt: live.startedAt,
      endsAt: live.endsAt,
      pausedAt: live.pausedAt,
      pausedBy: live.pausedBy,
      autoResumeAt: live.autoResumeAt,
      remainingSeconds: remaining,
      billing: clientBillingOf(live),
    };
  }

  // ─── Pause / resume from the PC (0.10.0) ─────────────────────────────────────

  /** The customer pauses their own session at the PC (Settings › Stations › Customer pause). */
  async pauseFromDevice(stationId: string, deviceId: string): Promise<SessionSummary> {
    if (!(await this.settings.get('sessions.customer_pause')))
      throw new AppError(403, 'pause_disabled', 'Pausing from the PC is switched off');
    const live = await this.liveForStation(stationId);
    if (!live) throw new AppError(409, 'no_session', 'No session is running on this PC');
    if (live.status === 'paused') return live;
    const result = await this.pause(
      live.id,
      { deviceId, label: 'customer' },
      new Date(),
      'customer',
    );
    return result.session;
  }

  /** "Resume" pressed on the paused screen of the PC. */
  async resumeFromDevice(stationId: string, deviceId: string): Promise<SessionSummary> {
    if (!(await this.settings.get('sessions.customer_resume')))
      throw new AppError(403, 'resume_disabled', 'Resuming from the PC is switched off');
    const live = await this.liveForStation(stationId);
    if (!live) throw new AppError(409, 'no_session', 'No session is running on this PC');
    if (live.status === 'active') return live;
    const result = await this.resume(
      live.id,
      { deviceId, label: 'customer' },
      new Date(),
      'customer',
    );
    return result.session;
  }

  /** The PC says its prepaid time ran out: trust the server clock, expire only if really due. */
  async clientReportsExpired(sessionId: string, deviceId: string): Promise<void> {
    try {
      await this.expire(sessionId, { deviceId, label: 'client' });
    } catch (err) {
      this.log.warn({ err, sessionId }, 'client expiry report ignored');
    }
  }

  // ─── Background tick ─────────────────────────────────────────────────────────

  /** Runs every second: prepaid expiries, expiry warnings, grace handling for offline PCs. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.pool.query<{ id: string }>(
        `SELECT id FROM gaming_sessions WHERE status = 'active' AND billing_mode IN ('prepaid', 'endpay') AND ends_at <= $1`,
        [now],
      );
      for (const row of due.rows) await this.expire(row.id);

      const thresholds = await this.settings.get('stations.expiry_warning_minutes');
      if (thresholds.length) {
        const soon = await this.pool.query<{
          id: string;
          station_id: string;
          device_id: string | null;
          ends_at: Date;
        }>(
          `SELECT id, station_id, device_id, ends_at FROM gaming_sessions
            WHERE status = 'active' AND billing_mode IN ('prepaid', 'endpay') AND ends_at <= $1`,
          [new Date(now.getTime() + Math.max(...thresholds) * 60_000)],
        );
        const language = await this.settings.get('locale.default_language');
        for (const s of soon.rows) {
          const remaining = (s.ends_at.getTime() - now.getTime()) / 60_000;
          for (const minutes of thresholds) {
            const key = `${s.id}:${minutes}`;
            if (remaining > minutes || this.warned.has(key)) continue;
            this.warned.add(key);
            const text =
              language === 'sq'
                ? `Edhe ${minutes} minuta kohë`
                : `${minutes} minute${minutes === 1 ? '' : 's'} remaining`;
            const deviceId = s.device_id ?? (await this.deviceForStation(s.station_id));
            const ack = deviceId
              ? await this.hub.sendCommand(
                  deviceId,
                  'message.show',
                  { text, durationSeconds: 15 },
                  { timeoutMs: 5000 },
                )
              : null;
            await this.pool.query(
              `INSERT INTO session_events (session_id, event_type, payload) VALUES ($1, 'warning_sent', $2)`,
              [s.id, JSON.stringify({ minutes, delivered: ack?.ok ?? false })],
            );
          }
        }
      }

      // Customer pauses are bounded: past the limit the clock runs again (back-dated to the
      // deadline, so the watcher's own delay never costs the customer anything).
      this.pauseMaxMinutes = await this.settings.get('sessions.pause_max_minutes');
      if (this.pauseMaxMinutes > 0) {
        const overdue = await this.pool.query<{ id: string; paused_at: Date }>(
          `SELECT id, paused_at FROM gaming_sessions
            WHERE status = 'paused' AND paused_by = 'customer' AND paused_at <= $1`,
          [new Date(now.getTime() - this.pauseMaxMinutes * 60_000)],
        );
        for (const row of overdue.rows) {
          const deadline = new Date(row.paused_at.getTime() + this.pauseMaxMinutes * 60_000);
          await this.resume(row.id, { label: 'system' }, deadline, 'auto').catch((err) =>
            this.log.warn({ err, sessionId: row.id }, 'auto-resume failed'),
          );
        }
      }

      if (this.offlineSince.size) {
        const grace = (await this.settings.get('stations.session_grace_seconds')) * 1000;
        for (const [stationId, since] of this.offlineSince) {
          if (now.getTime() - since < grace) continue;
          const live = await this.liveForStation(stationId);
          this.offlineSince.delete(stationId);
          if (!live || live.status !== 'active') continue;
          await this.pause(live.id, { label: 'system' }, new Date(since), 'grace');
          this.log.warn(
            { sessionId: live.id, stationId },
            'session paused: client offline beyond grace period',
          );
        }
      }
    } catch (err) {
      this.log.error({ err }, 'session tick failed');
    } finally {
      this.ticking = false;
    }
  }

  private async onDeviceOffline(stationId: string, deviceId: string): Promise<void> {
    // Capture the disconnect time synchronously: the grace pause is back-dated to it so the
    // customer is never billed for time the PC was unreachable.
    const since = Date.now();
    try {
      const live = await this.liveForStation(stationId);
      if (!live || live.status !== 'active') return;
      this.offlineSince.set(stationId, since);
      await this.pool.query(
        `INSERT INTO session_events (session_id, event_type, actor_device_id, payload) VALUES ($1, 'grace_started', $2, $3)`,
        [
          live.id,
          deviceId,
          JSON.stringify({
            graceSeconds: await this.settings.get('stations.session_grace_seconds'),
          }),
        ],
      );
    } catch (err) {
      this.log.error({ err }, 'grace start failed');
    }
  }

  private async onDeviceOnline(stationId: string, deviceId: string): Promise<void> {
    const wasOffline = this.offlineSince.delete(stationId);
    try {
      const live = await this.liveForStation(stationId);
      if (!live) return;
      if (wasOffline) {
        await this.pool.query(
          `INSERT INTO session_events (session_id, event_type, actor_device_id, payload) VALUES ($1, 'client_reconnected', $2, '{}')`,
          [live.id, deviceId],
        );
      }
    } catch (err) {
      this.log.error({ err }, 'reconnect bookkeeping failed');
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async lock(client: DbClient, id: string): Promise<SessionRow> {
    const result = await client.query<SessionRow>(
      `${SESSION_SELECT} WHERE g.id = $1 FOR UPDATE OF g`,
      [id],
    );
    if (!result.rows[0]) throw notFound('Session');
    return result.rows[0];
  }

  private async addEvent(
    client: DbClient,
    sessionId: string,
    type: string,
    actor: AuditActor,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO session_events (session_id, event_type, actor_user_id, actor_device_id, payload) VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, type, actor.userId ?? null, actor.deviceId ?? null, JSON.stringify(payload)],
    );
  }

  /**
   * One completed sale with a single gaming line and its payment. Gaming prices are tax-inclusive
   * at the default rate (the quoted price is what the customer pays).
   */
  /**
   * Writes the sale that bills a session (one line, tax split out of the inclusive price) and
   * settles it with the given tenders — exactly like a POS sale: cash minus change goes into the
   * open shift, card/other count as non-cash, `credit` opens a debt on the session's customer.
   * `tenders.payments` wins over the single `paymentMethod` (turned into one exact tender).
   */
  private async recordSale(
    client: DbClient,
    input: {
      sessionId: string;
      description: string;
      /** Session line price; null = no session line (prepaid end that only bills the orders). */
      priceCents: number | null;
      discountCents: number;
      tenders: { paymentMethod: string; payments?: SalePaymentInput[] };
      customerId: string | null;
      actor: AuditActor & { permissions?: ReadonlySet<string> };
      at: Date;
      /** Ordered products settled on this receipt (0.10.0). */
      orderLines?: OrderLineForSale[];
    },
  ): Promise<{
    saleId: string;
    receiptNo: string;
    methods: string[];
    payment: SessionPaymentSummary;
  }> {
    const orderLines = input.orderLines ?? [];
    const ordersCents = orderLines.reduce((acc, l) => acc + l.lineTotalCents, 0);
    const sessionCents = input.priceCents ?? 0;
    const subtotal = sessionCents + ordersCents;
    const total = subtotal - input.discountCents;
    const payments: SalePaymentInput[] =
      total > 0
        ? (input.tenders.payments ?? [
            {
              method: input.tenders.paymentMethod as SalePaymentInput['method'],
              amountCents: total,
            },
          ])
        : [];
    let settled = { paidCents: 0, changeCents: 0 };
    if (total > 0) {
      try {
        settled = settlePayments(total, payments);
      } catch (err) {
        if (err instanceof SaleMathError) throw badRequest(err.message, { code: 'PAYMENT' });
        throw err;
      }
    }
    const rateBp = await this.settings.get('tax.default_rate_bp');
    const { tax } = splitInclusiveTax(total, rateBp);
    const receiptNo = await nextDocumentNumber(client, 'receipt', input.at);
    const sale = await client.query<{ id: string }>(
      `INSERT INTO sales (receipt_no, status, source, customer_id, cashier_user_id, subtotal_cents, discount_cents, tax_cents,
         total_cents, paid_cents, change_cents, discount_authorized_by, completed_at)
       VALUES ($1, 'completed', 'gaming', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        receiptNo,
        input.customerId,
        input.actor.userId,
        subtotal,
        input.discountCents,
        tax,
        total,
        settled.paidCents,
        settled.changeCents,
        input.discountCents > 0 ? input.actor.userId : null,
        input.at,
      ],
    );
    const saleId = sale.rows[0]!.id;
    let lineNo = 0;
    if (input.priceCents !== null) {
      lineNo += 1;
      await client.query(
        `INSERT INTO sale_items (sale_id, line_no, gaming_session_id, description, quantity_milli, unit_price_cents, discount_cents,
           tax_rate_bp, tax_cents, line_total_cents)
         VALUES ($1, $7, $2, $3, 1000, $4, 0, $5, $6, $4)`,
        [
          saleId,
          input.sessionId,
          input.description,
          input.priceCents,
          rateBp,
          splitInclusiveTax(input.priceCents, rateBp).tax,
          lineNo,
        ],
      );
    }
    // Ordered products: real sale lines (with cost) and real stock movements — the same facts
    // a POS sale writes, so reports and inventory see nothing special about an order.
    for (const line of orderLines) {
      lineNo += 1;
      await client.query(
        `INSERT INTO sale_items (sale_id, line_no, product_id, gaming_session_id, description, quantity_milli, unit_price_cents,
           discount_cents, tax_rate_bp, tax_cents, line_total_cents, cost_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11)`,
        [
          saleId,
          lineNo,
          line.productId,
          input.sessionId,
          line.name,
          line.quantityMilli,
          line.unitPriceCents,
          rateBp,
          splitInclusiveTax(line.lineTotalCents, rateBp).tax,
          line.lineTotalCents,
          Math.round((line.unitCostCents * line.quantityMilli) / 1000),
        ],
      );
    }
    const perProduct = new Map<string, OrderLineForSale & { qty: number }>();
    for (const line of orderLines) {
      const prev = perProduct.get(line.productId);
      perProduct.set(line.productId, { ...line, qty: (prev?.qty ?? 0) + line.quantityMilli });
    }
    for (const [productId, line] of [...perProduct.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      if (!line.trackStock) continue;
      await applyMovement(client, {
        productId,
        type: 'sale',
        delta: -line.qty,
        unitCostCents: line.unitCostCents,
        reason: null,
        referenceType: 'sale',
        referenceId: saleId,
        actorUserId: input.actor.userId ?? null,
        allowNegative: line.allowNegative,
      });
    }
    let creditCents = 0;
    let dueDate: string | null = null;
    if (total > 0) {
      const cashTendered = payments
        .filter((p) => p.method === 'cash')
        .reduce((acc, p) => acc + p.amountCents, 0);
      const shiftId = await this.cash.attachTender(client, {
        method: cashTendered > 0 ? 'cash' : (payments[0]?.method ?? 'other'),
        amountCents: cashTendered - settled.changeCents,
        type: 'sale',
        referenceType: 'sale',
        referenceId: saleId,
        reason: `${receiptNo} · ${input.description}`,
        actorUserId: input.actor.userId ?? null,
      });
      for (const [i, p] of payments.entries()) {
        await client.query(
          `INSERT INTO payments (kind, method, amount_cents, sale_id, customer_id, reference, shift_id, received_at, created_by)
           VALUES ('sale', $1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            p.method,
            p.amountCents,
            saleId,
            input.customerId,
            p.reference ?? null,
            shiftId,
            new Date(input.at.getTime() + i),
            input.actor.userId,
          ],
        );
      }
      const credit = payments.filter((p) => p.method === 'credit');
      if (credit.length) {
        creditCents = credit.reduce((acc, p) => acc + p.amountCents, 0);
        const debtId = await this.debts.open(client, {
          customerId: input.customerId,
          saleId,
          amountCents: creditCents,
          dueDate: credit.find((p) => p.dueDate)?.dueDate ?? null,
          notes: `${receiptNo} · ${input.description}`,
          actor: input.actor,
        });
        const d = await client.query<{ due_date: string }>(
          `SELECT to_char(due_date, 'YYYY-MM-DD') AS due_date FROM customer_debts WHERE id = $1`,
          [debtId],
        );
        dueDate = d.rows[0]?.due_date ?? null;
      }
      // Prepaid balance (0.11.0): the customer's wallet pays (part of) the bill.
      const fromWallet = payments
        .filter((p) => p.method === 'wallet')
        .reduce((acc, p) => acc + p.amountCents, 0);
      if (fromWallet > 0) {
        await this.wallet.spend(client, {
          customerId: input.customerId,
          amountCents: fromWallet,
          referenceType: 'sale',
          referenceId: saleId,
          note: `${receiptNo} · ${input.description}`,
          actor: input.actor,
        });
      }
      await client.query('UPDATE sales SET shift_id = $2 WHERE id = $1', [saleId, shiftId]);
    }
    return {
      saleId,
      receiptNo,
      methods: [...new Set(payments.map((p) => p.method))],
      payment: {
        saleId,
        receiptNo,
        totalCents: total,
        paidCents: settled.paidCents,
        changeCents: settled.changeCents,
        creditCents,
        dueDate,
      },
    };
  }

  private async deviceForStation(stationId: string): Promise<string | null> {
    const r = await this.pool.query<{ id: string }>(
      `SELECT id FROM station_devices WHERE station_id = $1 AND status = 'approved'`,
      [stationId],
    );
    return r.rows[0]?.id ?? null;
  }

  /** Send the mirrored command to the PC and log the outcome on the session. */
  private async mirror(
    session: SessionSummary,
    command:
      'session.start' | 'session.pause' | 'session.resume' | 'session.extend' | 'session.end',
    payload: Record<string, unknown>,
    actor: AuditActor,
  ): Promise<ClientAckSummary | null> {
    const deviceId = await this.deviceForStation(session.stationId);
    if (!deviceId || !this.hub.isDeviceOnline(deviceId)) {
      await this.pool.query(
        `INSERT INTO session_events (session_id, event_type, payload) VALUES ($1, 'client_timeout', $2)`,
        [session.id, JSON.stringify({ command, reason: 'client offline' })],
      );
      return null;
    }
    const commandId = randomUUID();
    const result = await this.hub.sendCommand(deviceId, command, payload, {
      timeoutMs: 8000,
      commandId,
    });
    await this.pool.query(
      `INSERT INTO session_events (session_id, event_type, actor_user_id, actor_device_id, command_id, payload) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        session.id,
        result.ok ? 'client_ack' : 'client_timeout',
        actor.userId ?? null,
        deviceId,
        commandId,
        JSON.stringify({ command, ok: result.ok, error: result.error ?? null }),
      ],
    );
    if (!result.ok)
      this.log.warn(
        { sessionId: session.id, command, error: result.error },
        'PC did not confirm session command',
      );
    return { commandId, command, ok: result.ok, error: result.error };
  }

  private async broadcast(session: SessionSummary): Promise<void> {
    this.hub.broadcastToAdmins('session.changed', session);
    await this.stations.broadcastStation(session.stationId);
  }
}
