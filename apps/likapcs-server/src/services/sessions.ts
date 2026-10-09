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
  type EndSessionRequest,
  type ExtendSessionRequest,
  type PricingTerms,
  type SessionEventSummary,
  type SessionListQuery,
  type SessionQuoteRequest,
  type SessionQuoteResponse,
  type SessionSummary,
  type ClientAckSummary,
  type SessionMutationResponse,
  type StartSessionRequest,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';
import { nextDocumentNumber } from './documents.js';
import type { PricingService } from './pricing.js';
import type { SettingsService } from './settings.js';
import type { StationsService } from './stations.js';

interface SessionRow {
  id: string;
  station_id: string;
  station_code: string;
  station_name: string;
  device_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  billing_mode: 'prepaid' | 'postpaid';
  status: SessionSummary['status'];
  rule_name: string | null;
  package_name: string | null;
  rate_cents_per_hour: string | number;
  billing_terms: Partial<PricingTerms> | null;
  planned_seconds: number | null;
  started_at: Date;
  ends_at: Date | null;
  paused_at: Date | null;
  total_paused_seconds: number;
  ended_at: Date | null;
  end_reason: SessionSummary['endReason'];
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
         g.planned_seconds, g.started_at, g.ends_at, g.paused_at, g.total_paused_seconds, g.ended_at,
         g.end_reason, g.billable_seconds, g.quoted_price_cents, g.discount_cents, g.final_price_cents,
         g.sale_id, sa.receipt_no, g.billed_at, u.full_name AS created_by_name, g.notes, g.created_at
    FROM gaming_sessions g
    JOIN stations s ON s.id = g.station_id
    LEFT JOIN customers c ON c.id = g.customer_id
    LEFT JOIN pricing_rules r ON r.id = g.pricing_rule_id
    LEFT JOIN gaming_packages p ON p.id = g.package_id
    LEFT JOIN sales sa ON sa.id = g.sale_id
    LEFT JOIN users u ON u.id = g.created_by`;

export type SessionMutationResult = SessionMutationResponse;

export interface SessionActorContext extends AuditActor {
  permissions?: Set<string>;
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

function describe(row: SessionRow, seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  const duration = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
  return `${row.station_code} · ${duration} (${row.billing_mode})`;
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

  // ─── Mapping ─────────────────────────────────────────────────────────────────

  mapRow(row: SessionRow, now: Date = new Date()): SessionSummary {
    const terms = termsFromRow(row);
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
    else if (row.billing_mode === 'prepaid') currentPrice = Number(row.quoted_price_cents ?? 0);
    else currentPrice = priceForSeconds(seconds, terms);
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

    const session = await withTransaction(this.pool, async (client) => {
      const live = await client.query(
        'SELECT id FROM gaming_sessions WHERE station_id = $1 AND status IN ($2, $3) FOR UPDATE',
        [req.stationId, 'active', 'paused'],
      );
      if (live.rowCount) throw conflict('A session is already running on this station');
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
          req.billingMode === 'prepaid' ? quote.priceCents : null,
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
      });
      if (req.billingMode === 'prepaid') {
        const sale = await this.recordSale(client, {
          sessionId: id,
          description: `${station.code} · ${quote.minutes} min (prepaid${quote.package ? `: ${quote.package.name}` : ''})`,
          priceCents: quote.priceCents,
          discountCents: 0,
          paymentMethod: req.paymentMethod,
          customerId: req.customerId ?? null,
          actor,
          at: now,
        });
        await client.query(
          `UPDATE gaming_sessions SET sale_id = $2, billed_at = $3, final_price_cents = $4 WHERE id = $1 AND billed_at IS NULL`,
          [id, sale.saleId, now, quote.priceCents],
        );
        await this.addEvent(client, id, 'billed', actor, {
          saleId: sale.saleId,
          receiptNo: sale.receiptNo,
          amountCents: quote.priceCents,
          paymentMethod: req.paymentMethod,
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
        },
      });
      return this.getById(id, client);
    });

    const ack = await this.mirror(
      session,
      'session.start',
      {
        sessionId: session.id,
        startedAt: session.startedAt,
        endsAt: session.endsAt,
      },
      actor,
    );
    await this.broadcast(session);
    return { session, client: ack };
  }

  async pause(
    id: string,
    actor: SessionActorContext,
    at: Date = new Date(),
    systemReason?: 'grace',
  ): Promise<SessionMutationResult> {
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'active') throw conflict(`Session is ${row.status}, not active`);
      const pausedAt = at < row.started_at ? row.started_at : at;
      await client.query(
        'UPDATE gaming_sessions SET status = $2, paused_at = $3, version = version + 1 WHERE id = $1',
        [id, 'paused', pausedAt],
      );
      await this.addEvent(client, id, systemReason === 'grace' ? 'grace_ended' : 'paused', actor, {
        pausedAt: pausedAt.toISOString(),
        reason: systemReason ?? 'staff',
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
      { sessionId: id, remainingSeconds: remaining },
      actor,
    );
    await this.broadcast(session);
    return { session, client: ack };
  }

  async resume(
    id: string,
    actor: SessionActorContext,
    at: Date = new Date(),
  ): Promise<SessionMutationResult> {
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'paused' || !row.paused_at)
        throw conflict(`Session is ${row.status}, not paused`);
      const pausedFor = Math.max(0, Math.floor((at.getTime() - row.paused_at.getTime()) / 1000));
      const endsAt = row.ends_at ? new Date(row.ends_at.getTime() + pausedFor * 1000) : null;
      await client.query(
        `UPDATE gaming_sessions SET status = 'active', paused_at = NULL, total_paused_seconds = total_paused_seconds + $2,
           ends_at = $3, version = version + 1 WHERE id = $1`,
        [id, pausedFor, endsAt],
      );
      await this.addEvent(client, id, 'resumed', actor, {
        pausedForSeconds: pausedFor,
        endsAt: endsAt?.toISOString() ?? null,
      });
      return this.getById(id, client);
    });
    this.warned.forEach((k) => k.startsWith(`${id}:`) && this.warned.delete(k));
    const ack = await this.mirror(
      session,
      'session.resume',
      { sessionId: id, endsAt: session.endsAt },
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
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.billing_mode !== 'prepaid')
        throw conflict(
          'Only prepaid sessions can be extended; postpaid sessions run until stopped',
        );
      if (row.status !== 'active' && row.status !== 'paused')
        throw conflict(`Session is ${row.status}`);
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
      const sale = await this.recordSale(client, {
        sessionId: id,
        description: `${row.station_code} · +${quote.minutes} min (extension${quote.package ? `: ${quote.package.name}` : ''})`,
        priceCents: quote.priceCents,
        discountCents: 0,
        paymentMethod: req.paymentMethod,
        customerId: row.customer_id,
        actor,
        at: now,
      });
      await client.query(
        `UPDATE gaming_sessions SET planned_seconds = planned_seconds + $2, ends_at = ends_at + make_interval(secs => $2),
           quoted_price_cents = quoted_price_cents + $3, final_price_cents = final_price_cents + $3, version = version + 1
         WHERE id = $1`,
        [id, extraSeconds, quote.priceCents],
      );
      await this.addEvent(client, id, 'extended', actor, {
        minutes: quote.minutes,
        priceCents: quote.priceCents,
        saleId: sale.saleId,
        receiptNo: sale.receiptNo,
        clientRequestId: req.clientRequestId ?? null,
      });
      await recordAudit(client, actor, {
        action: 'session.extend',
        entityType: 'gaming_session',
        entityId: id,
        details: { minutes: quote.minutes, priceCents: quote.priceCents },
      });
      return this.getById(id, client);
    });
    this.warned.forEach((k) => k.startsWith(`${id}:`) && this.warned.delete(k));
    const ack = await this.mirror(
      session,
      'session.extend',
      { sessionId: id, endsAt: session.endsAt },
      actor,
    );
    await this.broadcast(session);
    return { session, client: ack };
  }

  /** Staff stop. Postpaid sessions are billed here, exactly once. */
  async end(
    id: string,
    req: EndSessionRequest,
    actor: SessionActorContext,
    at: Date = new Date(),
  ): Promise<SessionMutationResult> {
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'active' && row.status !== 'paused')
        throw conflict(`Session already ${row.status}`);
      const seconds = billableSeconds({
        startedAt: row.started_at,
        endedAt: at,
        totalPausedSeconds: row.total_paused_seconds,
        pausedAt: row.paused_at,
      });
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
          paymentMethod: req.paymentMethod,
          customerId: row.customer_id,
          actor,
          at,
        });
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
          paymentMethod: req.paymentMethod,
        });
      } else {
        await client.query(
          `UPDATE gaming_sessions SET status = 'completed', ended_at = $2, end_reason = 'stopped_by_staff', billable_seconds = $3,
             paused_at = NULL, notes = COALESCE($4, notes), version = version + 1 WHERE id = $1`,
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
      return this.getById(id, client);
    });
    const ack = await this.mirror(session, 'session.end', { sessionId: id }, actor);
    await this.broadcast(session);
    return { session, client: ack };
  }

  /** Postpaid only: stop without charging (wrong station, test, customer left immediately). */
  async cancel(
    id: string,
    actor: SessionActorContext,
    reason: string,
    at: Date = new Date(),
  ): Promise<SessionMutationResult> {
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'active' && row.status !== 'paused')
        throw conflict(`Session already ${row.status}`);
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
      return this.getById(id, client);
    });
    const ack = await this.mirror(session, 'session.end', { sessionId: id }, actor);
    await this.broadcast(session);
    return { session, client: ack };
  }

  /** Prepaid expiry — idempotent; ended exactly at `ends_at`, never at "now". */
  async expire(
    id: string,
    actor: AuditActor = { label: 'system' },
  ): Promise<SessionSummary | null> {
    const session = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'active' || row.billing_mode !== 'prepaid' || !row.ends_at) return null;
      if (row.ends_at.getTime() > Date.now()) return null;
      const seconds = billableSeconds({
        startedAt: row.started_at,
        endedAt: row.ends_at,
        totalPausedSeconds: row.total_paused_seconds,
        pausedAt: null,
      });
      await client.query(
        `UPDATE gaming_sessions SET status = 'expired', ended_at = ends_at, end_reason = 'expired', billable_seconds = $2, version = version + 1 WHERE id = $1`,
        [id, seconds],
      );
      await this.addEvent(client, id, 'expired', actor, { endsAt: row.ends_at.toISOString() });
      return this.getById(id, client);
    });
    if (!session) return null;
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
      remainingSeconds: remaining,
    };
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
        `SELECT id FROM gaming_sessions WHERE status = 'active' AND billing_mode = 'prepaid' AND ends_at <= $1`,
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
            WHERE status = 'active' AND billing_mode = 'prepaid' AND ends_at <= $1`,
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
  private async recordSale(
    client: DbClient,
    input: {
      sessionId: string;
      description: string;
      priceCents: number;
      discountCents: number;
      paymentMethod: string;
      customerId: string | null;
      actor: AuditActor;
      at: Date;
    },
  ): Promise<{ saleId: string; receiptNo: string }> {
    const total = input.priceCents - input.discountCents;
    const rateBp = await this.settings.get('tax.default_rate_bp');
    const { tax } = splitInclusiveTax(total, rateBp);
    const receiptNo = await nextDocumentNumber(client, 'receipt', input.at);
    const sale = await client.query<{ id: string }>(
      `INSERT INTO sales (receipt_no, status, source, customer_id, cashier_user_id, subtotal_cents, discount_cents, tax_cents,
         total_cents, paid_cents, change_cents, discount_authorized_by, completed_at)
       VALUES ($1, 'completed', 'gaming', $2, $3, $4, $5, $6, $7, $7, 0, $8, $9) RETURNING id`,
      [
        receiptNo,
        input.customerId,
        input.actor.userId,
        input.priceCents,
        input.discountCents,
        tax,
        total,
        input.discountCents > 0 ? input.actor.userId : null,
        input.at,
      ],
    );
    const saleId = sale.rows[0]!.id;
    await client.query(
      `INSERT INTO sale_items (sale_id, line_no, gaming_session_id, description, quantity_milli, unit_price_cents, discount_cents,
         tax_rate_bp, tax_cents, line_total_cents)
       VALUES ($1, 1, $2, $3, 1000, $4, 0, $5, $6, $4)`,
      [
        saleId,
        input.sessionId,
        input.description,
        input.priceCents,
        rateBp,
        splitInclusiveTax(input.priceCents, rateBp).tax,
      ],
    );
    if (total > 0) {
      await client.query(
        `INSERT INTO payments (kind, method, amount_cents, sale_id, customer_id, received_at, created_by)
         VALUES ('sale', $1, $2, $3, $4, $5, $6)`,
        [input.paymentMethod, total, saleId, input.customerId, input.at, input.actor.userId],
      );
    }
    return { saleId, receiptNo };
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
