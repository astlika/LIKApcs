/**
 * Customer login on the gaming PCs + session requests (0.9.0).
 *
 * A customer registered by staff (Admin › Customers, username + PIN) signs in on the locked
 * screen of a PC and asks for time — a quick duration or one of the owner's packages; during
 * their prepaid session they can ask for an extension. The request is stored in
 * `session_requests`, shown live in the Admin (bell, PC tile) and answered by staff:
 *
 *   * approve → staff open the normal start / extend dialog pre-filled; `POST /sessions` or
 *     `POST /sessions/:id/extend` carries `requestId` and the sessions service marks the request
 *     `approved` in the SAME transaction as the session (see `approveInTransaction`). Payment is a
 *     staff decision (cash now / pay later); the PC only unlocks through the server's command.
 *   * reject → `rejected` with a short reason the customer sees on the PC.
 *
 * Requests never expire on their own. They stay `pending` until answered, cancelled by the
 * customer, or made moot by staff acting on the PC directly (session started / extended / ended,
 * device revoked) — then `cancelForStation` cancels them with a machine-readable reason.
 * At most one pending request per station (partial unique index).
 *
 * Security: the customer token is short-lived, in-memory and bound to the device that obtained
 * it; it may only CREATE requests. Everything the PC shows or cancels is authorised by the device
 * token and scoped to that PC's station. PINs are scrypt-hashed like staff passwords; wrong PINs
 * count towards a lockout (`security.max_failed_logins` / `security.lockout_minutes`).
 */
import type {
  ClientRequestOptions,
  CustomerLoginInput,
  CustomerLoginResponse,
  GamingPackageSummary,
  SessionQuoteRequest,
  SessionQuoteResponse,
  SessionRequest,
  SessionRequestCreate,
  SessionRequestListQuery,
  SessionRequestStatus,
  ServerRequestUpdate,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { verifyPassword } from '../security/password.js';
import { generateToken, hashToken } from '../security/tokens.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { AuthenticatedDevice } from './devices.js';
import type { SettingsService } from './settings.js';
import type { StationsService } from './stations.js';

/** How long a customer stays signed in on the PC without a new login. */
export const CUSTOMER_TOKEN_TTL_MS = 20 * 60_000;

/** Why the server cancelled a pending request (shown to the customer in their language). */
export type RequestCancelReason =
  | 'customer'
  | 'session_started'
  | 'session_extended'
  | 'session_ended'
  | 'device_revoked'
  | 'station_disabled';

interface RequestRow {
  id: string;
  station_id: string;
  station_code: string;
  station_name: string;
  device_id: string | null;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  customer_balance_due_cents: string;
  kind: 'start' | 'extend';
  minutes: number | null;
  package_id: string | null;
  package_name: string | null;
  package_minutes: number | null;
  session_id: string | null;
  status: SessionRequestStatus;
  reason: string | null;
  requested_at: Date;
  decided_at: Date | null;
  decided_by_name: string | null;
}

const SELECT = `
  SELECT r.id, r.station_id, s.code AS station_code, s.name AS station_name, r.device_id,
         r.customer_id, c.name AS customer_name, c.code AS customer_code, c.balance_due_cents AS customer_balance_due_cents,
         r.kind, r.minutes, r.package_id, p.name AS package_name, p.duration_minutes AS package_minutes,
         r.session_id, r.status, r.reason, r.requested_at, r.decided_at,
         COALESCE(NULLIF(u.full_name, ''), u.username) AS decided_by_name
    FROM session_requests r
    JOIN stations s ON s.id = r.station_id
    JOIN customers c ON c.id = r.customer_id
    LEFT JOIN gaming_packages p ON p.id = r.package_id
    LEFT JOIN users u ON u.id = r.decided_by`;

function toSummary(r: RequestRow): SessionRequest {
  return {
    id: r.id,
    stationId: r.station_id,
    stationCode: r.station_code,
    stationName: r.station_name,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerCode: r.customer_code,
    customerBalanceDueCents: Number(r.customer_balance_due_cents),
    kind: r.kind,
    minutes: r.minutes,
    packageId: r.package_id,
    packageName: r.package_name,
    durationMinutes: r.minutes ?? r.package_minutes ?? 0,
    sessionId: r.session_id,
    status: r.status,
    reason: r.reason,
    requestedAt: r.requested_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    decidedByName: r.decided_by_name,
  };
}

function toPush(r: SessionRequest): ServerRequestUpdate['request'] {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    reason: r.reason,
    decidedAt: r.decidedAt,
  };
}

interface CustomerToken {
  customerId: string;
  deviceId: string;
  stationId: string;
  expiresAt: number;
}

/** What the service needs from the pricing side, injected to avoid a sessions ↔ requests cycle. */
export interface RequestPricing {
  quote: (req: SessionQuoteRequest) => Promise<SessionQuoteResponse>;
  availablePackages: (stationId: string) => Promise<GamingPackageSummary[]>;
}

export class SessionRequestsService {
  private readonly tokens = new Map<string, CustomerToken>();

  constructor(
    private readonly pool: DbPool,
    private readonly hub: RealtimeHub,
    private readonly settings: SettingsService,
    private readonly stations: StationsService,
    private readonly pricing: RequestPricing,
  ) {}

  // ─── Customer login (PC) ─────────────────────────────────────────────────────

  async login(
    device: AuthenticatedDevice,
    input: CustomerLoginInput,
    ip: string | null,
  ): Promise<CustomerLoginResponse> {
    if (!(await this.settings.get('requests.enabled')))
      throw new AppError(403, 'requests_disabled', 'Customer login is switched off');
    const row = await this.pool.query<{
      id: string;
      name: string;
      code: string;
      status: string;
      login_enabled: boolean;
      login_password_hash: string | null;
      login_failed_count: number;
      login_locked_until: Date | null;
      balance_due_cents: string;
      wallet_balance_cents: string;
    }>(
      `SELECT id, name, code, status, login_enabled, login_password_hash, login_failed_count, login_locked_until,
              balance_due_cents, wallet_balance_cents
         FROM customers WHERE lower(login_username) = lower($1)`,
      [input.username.trim()],
    );
    const customer = row.rows[0];
    const actor: AuditActor = { deviceId: device.id, label: `customer:${input.username}`, ip };
    const fail = async (reason: string, status = 401, code = 'invalid_credentials') => {
      await recordAudit(this.pool, actor, {
        action: 'customer.login',
        entityType: 'customer',
        entityId: customer?.id ?? null,
        details: { ok: false, reason, stationId: device.station.id },
        severity: 'warning',
      });
      throw new AppError(status, code, 'Wrong username or PIN');
    };
    if (!customer?.login_password_hash) {
      // Same cost as a real check so a missing username is not distinguishable by timing.
      await verifyPassword(input.password, DUMMY_HASH).catch(() => false);
      return fail('unknown_username');
    }
    if (customer.login_locked_until && customer.login_locked_until.getTime() > Date.now()) {
      await recordAudit(this.pool, actor, {
        action: 'customer.login',
        entityType: 'customer',
        entityId: customer.id,
        details: { ok: false, reason: 'locked', stationId: device.station.id },
        severity: 'warning',
      });
      throw new AppError(423, 'locked', 'Too many wrong attempts — try again in a few minutes', {
        until: customer.login_locked_until.toISOString(),
      });
    }
    const ok = await verifyPassword(input.password, customer.login_password_hash);
    if (!ok) {
      const max = await this.settings.get('security.max_failed_logins');
      const minutes = await this.settings.get('security.lockout_minutes');
      await this.pool.query(
        `UPDATE customers SET login_failed_count = login_failed_count + 1,
                login_locked_until = CASE WHEN login_failed_count + 1 >= $2
                                          THEN now() + make_interval(mins => $3) ELSE login_locked_until END
          WHERE id = $1`,
        [customer.id, max, minutes],
      );
      return fail('wrong_password');
    }
    if (!customer.login_enabled) return fail('login_disabled', 403, 'login_disabled');
    if (customer.status !== 'active') return fail(`customer_${customer.status}`, 403, 'blocked');

    await this.pool.query(
      `UPDATE customers SET login_failed_count = 0, login_locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [customer.id],
    );
    const token = generateToken(24);
    const expiresAt = Date.now() + CUSTOMER_TOKEN_TTL_MS;
    this.prune();
    this.tokens.set(hashToken(token), {
      customerId: customer.id,
      deviceId: device.id,
      stationId: device.station.id,
      expiresAt,
    });
    await recordAudit(this.pool, actor, {
      action: 'customer.login',
      entityType: 'customer',
      entityId: customer.id,
      details: { ok: true, stationId: device.station.id, stationCode: device.station.code },
    });
    return {
      customerToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      customer: {
        id: customer.id,
        name: customer.name,
        code: customer.code,
        walletBalanceCents: Number(customer.wallet_balance_cents),
        balanceDueCents: Number(customer.balance_due_cents),
      },
      pending: await this.pendingForStation(device.station.id),
    };
  }

  /** Resolves a customer token; it must have been issued to this very device. */
  private customerOf(device: AuthenticatedDevice, token: string | undefined): CustomerToken {
    this.prune();
    const entry = token ? this.tokens.get(hashToken(token)) : undefined;
    if (!entry || entry.deviceId !== device.id || entry.expiresAt < Date.now())
      throw unauthorized('Customer login required');
    return entry;
  }

  /** The signed-in customer behind a token (null when none / expired / another PC) — orders attach it. */
  customerIdOf(device: AuthenticatedDevice, token: string | undefined): string | null {
    try {
      return this.customerOf(device, token).customerId;
    } catch {
      return null;
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.tokens) if (entry.expiresAt < now) this.tokens.delete(key);
  }

  /** Signing out on the PC (also called when a request reaches a final state). */
  logout(token: string | undefined): void {
    if (token) this.tokens.delete(hashToken(token));
  }

  // ─── What can be requested on this PC ────────────────────────────────────────

  async options(device: AuthenticatedDevice): Promise<ClientRequestOptions> {
    const station = await this.stations.getById(device.station.id);
    const [quickMinutes, currency] = await Promise.all([
      this.settings.get('requests.quick_minutes'),
      this.settings.get('locale.currency'),
    ]);
    const live = station.activeSession;
    const kind: ClientRequestOptions['kind'] = !station.isEnabled
      ? 'none'
      : live
        ? live.billingMode !== 'postpaid' // prepaid / end pay: a fixed time that can be extended
          ? 'extend'
          : 'none'
        : 'start';
    const packages = (await this.pricing.availablePackages(station.id)).map((p) => ({
      id: p.id,
      name: p.name,
      durationMinutes: p.durationMinutes,
      priceCents: p.priceCents,
    }));
    const quickPrices: Record<string, number | null> = {};
    for (const minutes of quickMinutes) {
      quickPrices[String(minutes)] = await this.pricing
        .quote({ stationId: station.id, billingMode: 'prepaid', minutes })
        .then((q) => q.priceCents)
        .catch(() => null);
    }
    return {
      kind,
      sessionId: live?.id ?? null,
      quickMinutes,
      packages,
      quickPrices,
      currency,
      staffOnline: this.hub.adminCount() > 0,
    };
  }

  // ─── Create / cancel (PC) ────────────────────────────────────────────────────

  async create(
    device: AuthenticatedDevice,
    customerToken: string | undefined,
    input: SessionRequestCreate,
    ip: string | null,
  ): Promise<SessionRequest> {
    const who = this.customerOf(device, customerToken);
    if (!(await this.settings.get('requests.enabled')))
      throw new AppError(403, 'requests_disabled', 'Customer requests are switched off');
    const station = await this.stations.getById(device.station.id);
    if (!station.isEnabled) throw conflict('Station is disabled');
    const live = station.activeSession;
    if (input.kind === 'start' && live)
      throw new AppError(409, 'session_active', 'A session is already running on this PC');
    if (input.kind === 'extend' && (!live || live.billingMode === 'postpaid'))
      throw new AppError(409, 'no_session', 'There is no fixed-time session to extend on this PC');
    // Validates the package / duration for this station and rejects what cannot be priced.
    const quote = await this.pricing.quote({
      stationId: station.id,
      billingMode: 'prepaid',
      packageId: input.packageId,
      minutes: input.minutes,
    });
    if (input.minutes !== undefined) {
      const allowed = await this.settings.get('requests.quick_minutes');
      if (!allowed.includes(input.minutes))
        throw badRequest('Only the quick durations offered on the PC can be requested');
    }

    const id = await withTransaction(this.pool, async (client) => {
      const pending = await client.query(
        `SELECT 1 FROM session_requests WHERE station_id = $1 AND status = 'pending' FOR UPDATE`,
        [station.id],
      );
      if (pending.rowCount)
        throw new AppError(409, 'request_pending', 'A request is already waiting on this PC');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO session_requests (station_id, device_id, customer_id, kind, minutes, package_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          station.id,
          device.id,
          who.customerId,
          input.kind,
          input.packageId ? null : input.minutes,
          input.packageId ?? null,
          input.kind === 'extend' ? live!.id : null,
        ],
      );
      await recordAudit(
        client,
        { deviceId: device.id, label: `customer:${who.customerId}`, ip },
        {
          action: 'request.create',
          entityType: 'session_request',
          entityId: inserted.rows[0]!.id,
          details: {
            stationCode: station.code,
            kind: input.kind,
            minutes: quote.minutes,
            packageId: input.packageId ?? null,
            priceCents: quote.priceCents,
          },
        },
      );
      return inserted.rows[0]!.id;
    });
    const request = await this.getById(id);
    await this.announce(request);
    return request;
  }

  /** The customer withdrew the request on the PC (device-scoped: only this PC's request). */
  async cancelFromDevice(device: AuthenticatedDevice, id: string): Promise<SessionRequest> {
    const changed = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.station_id !== device.station.id) throw notFound('Request');
      if (row.status !== 'pending') return false;
      await this.finish(client, id, 'cancelled', 'customer', null);
      await recordAudit(
        client,
        { deviceId: device.id },
        { action: 'request.cancel', entityType: 'session_request', entityId: id },
      );
      return true;
    });
    const request = await this.getById(id);
    if (changed) await this.announce(request);
    return request;
  }

  /** Current state of a request made on this PC (after reconnects / when a push was missed). */
  async getForDevice(device: AuthenticatedDevice, id: string): Promise<SessionRequest> {
    const request = await this.getById(id);
    if (request.stationId !== device.station.id) throw notFound('Request');
    return request;
  }

  async pendingForStation(
    stationId: string,
    db: Queryable = this.pool,
  ): Promise<SessionRequest | null> {
    const r = await db.query<RequestRow>(
      `${SELECT} WHERE r.station_id = $1 AND r.status = 'pending'`,
      [stationId],
    );
    return r.rows[0] ? toSummary(r.rows[0]) : null;
  }

  // ─── Admin ───────────────────────────────────────────────────────────────────

  async list(query: SessionRequestListQuery): Promise<SessionRequest[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      where.push(`r.status = $${params.length}`);
    }
    if (query.stationId) {
      params.push(query.stationId);
      where.push(`r.station_id = $${params.length}`);
    }
    params.push(query.limit);
    const r = await this.pool.query<RequestRow>(
      `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (r.status = 'pending') DESC, r.requested_at DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(toSummary);
  }

  async getById(id: string, db: Queryable = this.pool): Promise<SessionRequest> {
    const r = await db.query<RequestRow>(`${SELECT} WHERE r.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Request');
    return toSummary(r.rows[0]);
  }

  async reject(id: string, actor: AuditActor, reason: string | null): Promise<SessionRequest> {
    await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'pending') throw conflict(`Request is already ${row.status}`);
      await this.finish(client, id, 'rejected', reason?.trim() || null, actor.userId ?? null);
      await recordAudit(client, actor, {
        action: 'request.reject',
        entityType: 'session_request',
        entityId: id,
        details: { stationId: row.station_id, customerId: row.customer_id, reason },
      });
    });
    const request = await this.getById(id);
    await this.announce(request);
    return request;
  }

  /**
   * Called by the sessions service INSIDE the start / extend transaction when the staff action
   * answers a request: the row is locked, must still be pending and must match the station (and
   * the session for extensions). Exactly once — a second approval attempt gets a 409.
   * Returns the request id so the caller can `announceApproved` after the commit.
   */
  async approveInTransaction(
    client: DbClient,
    requestId: string,
    expect: { kind: 'start' | 'extend'; stationId: string; sessionId: string },
    actor: AuditActor,
  ): Promise<void> {
    const row = await this.lock(client, requestId);
    if (row.status !== 'pending')
      throw new AppError(409, 'request_not_pending', `Request is already ${row.status}`);
    if (row.kind !== expect.kind || row.station_id !== expect.stationId)
      throw conflict('Request does not match this station / action');
    if (expect.kind === 'extend' && row.session_id && row.session_id !== expect.sessionId)
      throw conflict('Request belongs to another session');
    await client.query(
      `UPDATE session_requests SET status = 'approved', decided_at = now(), decided_by = $2, session_id = $3
        WHERE id = $1`,
      [requestId, actor.userId ?? null, expect.sessionId],
    );
    await recordAudit(client, actor, {
      action: 'request.approve',
      entityType: 'session_request',
      entityId: requestId,
      details: {
        stationId: row.station_id,
        customerId: row.customer_id,
        sessionId: expect.sessionId,
      },
    });
  }

  /** After the transaction that approved a request committed: tell the Admins and the PC. */
  async announceApproved(requestId: string): Promise<void> {
    await this.announce(await this.getById(requestId));
  }

  /**
   * Staff acted on the PC directly (started / extended / ended a session, revoked the device):
   * pending requests the action made moot are cancelled with a reason the PC can explain.
   * Runs inside the caller's transaction when a client is given; returns what to announce.
   */
  async cancelForStation(
    db: Queryable,
    stationId: string,
    kinds: ('start' | 'extend')[],
    reason: RequestCancelReason,
    actor: AuditActor,
  ): Promise<string[]> {
    const rows = await db.query<{ id: string }>(
      `UPDATE session_requests SET status = 'cancelled', reason = $3, decided_at = now(), decided_by = $4
        WHERE station_id = $1 AND status = 'pending' AND kind = ANY($2::text[]) RETURNING id`,
      [stationId, kinds, reason, actor.userId ?? null],
    );
    for (const { id } of rows.rows) {
      await recordAudit(db, actor, {
        action: 'request.cancel',
        entityType: 'session_request',
        entityId: id,
        details: { reason },
      });
    }
    return rows.rows.map((r) => r.id);
  }

  /** Announces requests cancelled by `cancelForStation` once their transaction committed. */
  async announceCancelled(ids: string[]): Promise<void> {
    for (const id of ids) await this.announce(await this.getById(id)).catch(() => undefined);
  }

  /** Outside a session transaction (PC revoked / station disabled): cancel + tell everyone. */
  async cancelAndAnnounce(
    stationId: string,
    reason: RequestCancelReason,
    actor: AuditActor,
  ): Promise<string[]> {
    const ids = await this.cancelForStation(
      this.pool,
      stationId,
      ['start', 'extend'],
      reason,
      actor,
    );
    await this.announceCancelled(ids);
    return ids;
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async lock(client: DbClient, id: string): Promise<RequestRow> {
    const r = await client.query<RequestRow>(`${SELECT} WHERE r.id = $1 FOR UPDATE OF r`, [id]);
    if (!r.rows[0]) throw notFound('Request');
    return r.rows[0];
  }

  private async finish(
    client: DbClient,
    id: string,
    status: 'rejected' | 'cancelled',
    reason: string | null,
    byUserId: string | null,
  ): Promise<void> {
    await client.query(
      `UPDATE session_requests SET status = $2, reason = $3, decided_at = now(), decided_by = $4 WHERE id = $1`,
      [id, status, reason, byUserId],
    );
  }

  /** Admins get the full request; the PC gets the facts it shows (never anything to act on). */
  private async announce(request: SessionRequest): Promise<void> {
    this.hub.broadcastToAdmins('request.changed', request);
    const presence = this.hub.listDevices().find((d) => d.stationId === request.stationId);
    if (presence && presence.socket.readyState === presence.socket.OPEN) {
      const message: ServerRequestUpdate = { type: 'server.request', request: toPush(request) };
      presence.socket.send(JSON.stringify(message));
    }
    await this.stations.broadcastStation(request.stationId);
  }
}

/** A valid scrypt hash of a random value — equalises the cost of a wrong username. */
const DUMMY_HASH =
  'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
