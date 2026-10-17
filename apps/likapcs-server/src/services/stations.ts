import {
  billableSeconds,
  priceForSeconds,
  type ActiveSessionSummary,
  type BillingMode,
  type CreateStationRequest,
  type HardwareInfo,
  type PricingTerms,
  type StationDeviceSummary,
  type StationMaintenance,
  type StationPendingRequest,
  type StationStatus,
  type StationLook,
  type StationSummary,
  type UpdateStationRequest,
  wallpaperPath,
} from '@likapcs/shared';
import type { DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, conflict, notFound } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';

interface StationRow {
  id: string;
  look: StationLook | null;
  wallpaper_file: string | null;
  number: number;
  code: string;
  name: string;
  zone: string | null;
  notes: string | null;
  is_enabled: boolean;
  created_at: Date;
  updated_at: Date;
  device_id: string | null;
  device_machine_id: string | null;
  device_hostname: string | null;
  device_os_info: string | null;
  device_app_version: string | null;
  device_status: 'pending' | 'approved' | 'revoked' | 'rejected' | null;
  device_registered_at: Date | null;
  device_approved_at: Date | null;
  device_last_seen_at: Date | null;
  device_last_ip: string | null;
  device_hardware: HardwareInfo | null;
  session_id: string | null;
  session_customer_name: string | null;
  session_billing_mode: BillingMode | null;
  session_status: 'active' | 'paused' | null;
  session_started_at: Date | null;
  session_ends_at: Date | null;
  session_paused_at: Date | null;
  session_total_paused_seconds: number | null;
  session_quoted_price_cents: string | number | null;
  session_billing_terms: Record<string, unknown> | null;
  session_rate_cents_per_hour: string | number | null;
  maintenance_until: Date | null;
  maintenance_by: string | null;
  maintenance_by_name: string | null;
  archived_at: Date | null;
  archived_reason: string | null;
  archived_by_name: string | null;
  request_id: string | null;
  request_kind: 'start' | 'extend' | null;
  request_customer_id: string | null;
  request_customer_name: string | null;
  request_minutes: number | null;
  request_quick_minutes: number | null;
  request_package_id: string | null;
  request_package_name: string | null;
  request_requested_at: Date | null;
  session_paused_by: 'staff' | 'customer' | 'grace' | null;
  orders_pending: string | number;
  orders_open_count: string | number;
  orders_open_cents: string | number;
  awaiting_count: string | number;
  awaiting_cents: string | number;
}

const STATION_SELECT = `
  SELECT s.id, s.number, s.code, s.name, s.zone, s.notes, s.is_enabled, s.created_at, s.updated_at,
         s.look, s.wallpaper_file,
         d.id AS device_id, d.machine_id AS device_machine_id, d.hostname AS device_hostname,
         d.os_info AS device_os_info, d.app_version AS device_app_version, d.status AS device_status,
         d.registered_at AS device_registered_at, d.approved_at AS device_approved_at,
         d.last_seen_at AS device_last_seen_at, d.last_ip AS device_last_ip, d.hardware AS device_hardware,
         g.id AS session_id, COALESCE(g.customer_name, c.name) AS session_customer_name,
         g.billing_mode AS session_billing_mode, g.status AS session_status, g.started_at AS session_started_at,
         g.ends_at AS session_ends_at, g.paused_at AS session_paused_at, g.paused_by AS session_paused_by,
         g.total_paused_seconds AS session_total_paused_seconds, g.quoted_price_cents AS session_quoted_price_cents,
         g.billing_terms AS session_billing_terms, g.rate_cents_per_hour AS session_rate_cents_per_hour,
         s.maintenance_until, s.maintenance_by, s.maintenance_by_name,
         s.archived_at, s.archived_reason, ua.full_name AS archived_by_name,
         r.id AS request_id, r.kind AS request_kind, r.customer_id AS request_customer_id,
         rc.name AS request_customer_name, COALESCE(r.minutes, rp.duration_minutes) AS request_minutes,
         r.minutes AS request_quick_minutes, r.package_id AS request_package_id, rp.name AS request_package_name,
         r.requested_at AS request_requested_at,
         (SELECT COUNT(*)::int FROM station_orders o WHERE o.station_id = s.id AND o.status = 'pending') AS orders_pending,
         (SELECT COUNT(*)::int FROM station_orders o WHERE o.station_id = s.id AND o.status = 'accepted') AS orders_open_count,
         (SELECT COALESCE(SUM(o.total_cents), 0)::bigint FROM station_orders o
           WHERE o.station_id = s.id AND o.status = 'accepted') AS orders_open_cents,
         (SELECT COUNT(*)::int FROM gaming_sessions a WHERE a.station_id = s.id AND a.billing_mode IN ('endpay', 'postpaid')
           AND a.billed_at IS NULL AND a.status IN ('expired', 'completed')) AS awaiting_count,
         (SELECT COALESCE(SUM(COALESCE(a.final_price_cents, a.quoted_price_cents, 0)), 0)::bigint FROM gaming_sessions a
           WHERE a.station_id = s.id AND a.billing_mode IN ('endpay', 'postpaid') AND a.billed_at IS NULL
           AND a.status IN ('expired', 'completed')) AS awaiting_cents
    FROM stations s
    LEFT JOIN station_devices d ON d.station_id = s.id AND d.status = 'approved'
    LEFT JOIN gaming_sessions g ON g.station_id = s.id AND g.status IN ('active', 'paused')
    LEFT JOIN customers c ON c.id = g.customer_id
    LEFT JOIN session_requests r ON r.station_id = s.id AND r.status = 'pending'
    LEFT JOIN customers rc ON rc.id = r.customer_id
    LEFT JOIN gaming_packages rp ON rp.id = r.package_id
    LEFT JOIN users ua ON ua.id = s.archived_by`;

/** Live session summary for the station grid (server clock; the PC only mirrors it). */
function liveSessionOf(row: StationRow): ActiveSessionSummary | null {
  if (
    !row.session_id ||
    !row.session_status ||
    !row.session_started_at ||
    !row.session_billing_mode
  ) {
    return null;
  }
  const now = Date.now();
  const elapsed = billableSeconds({
    startedAt: row.session_started_at,
    endedAt: now,
    totalPausedSeconds: row.session_total_paused_seconds ?? 0,
    pausedAt: row.session_paused_at,
  });
  const t = (row.session_billing_terms ?? {}) as Partial<PricingTerms>;
  const terms: PricingTerms = {
    rateCentsPerHour: Number(t.rateCentsPerHour ?? row.session_rate_cents_per_hour ?? 0),
    billingIncrementMinutes: Number(t.billingIncrementMinutes ?? 1),
    minimumMinutes: Number(t.minimumMinutes ?? 0),
    minimumChargeCents: Number(t.minimumChargeCents ?? 0),
    roundingMode: t.roundingMode ?? 'up',
    roundingIncrementCents: Number(t.roundingIncrementCents ?? 1),
  };
  const reference = row.session_paused_at ? row.session_paused_at.getTime() : now;
  return {
    id: row.session_id,
    customerName: row.session_customer_name,
    billingMode: row.session_billing_mode,
    status: row.session_status,
    startedAt: row.session_started_at.toISOString(),
    endsAt: row.session_ends_at?.toISOString() ?? null,
    pausedAt: row.session_paused_at?.toISOString() ?? null,
    pausedBy: row.session_status === 'paused' ? row.session_paused_by : null,
    elapsedSeconds: elapsed,
    remainingSeconds: row.session_ends_at
      ? Math.max(0, Math.round((row.session_ends_at.getTime() - reference) / 1000))
      : null,
    // Prepaid: what was paid. End pay: what will be due. Postpaid: the running amount.
    currentPriceCents:
      row.session_billing_mode === 'postpaid'
        ? priceForSeconds(elapsed, terms)
        : Number(row.session_quoted_price_cents ?? 0),
  };
}

export function stationCodeFor(number: number): string {
  return `PC ${String(number).padStart(2, '0')}`;
}

export class StationsService {
  /**
   * Archive/delete take the PC off the station: the device must be revoked so it cannot keep a
   * socket (and so it can be paired again as new). DevicesService owns that logic; it is injected
   * here to keep the two services free of a circular import.
   */
  private revokeDevice: ((deviceId: string, actor: AuditActor) => Promise<unknown>) | null = null;
  useRevokeDevice(hook: (deviceId: string, actor: AuditActor) => Promise<unknown>): void {
    this.revokeDevice = hook;
  }

  constructor(
    private readonly pool: DbPool,
    private readonly hub: RealtimeHub,
  ) {}

  private mapRow(row: StationRow): StationSummary {
    const online = row.device_id ? this.hub.isDeviceOnline(row.device_id) : false;
    const device: StationDeviceSummary | null = row.device_id
      ? {
          id: row.device_id,
          stationId: row.id,
          machineId: row.device_machine_id ?? '',
          hostname: row.device_hostname,
          osInfo: row.device_os_info,
          appVersion: row.device_app_version,
          status: row.device_status ?? 'approved',
          registeredAt: row.device_registered_at?.toISOString() ?? row.created_at.toISOString(),
          approvedAt: row.device_approved_at?.toISOString() ?? null,
          lastSeenAt: row.device_last_seen_at?.toISOString() ?? null,
          lastIp: row.device_last_ip,
          online,
          hardware: row.device_hardware,
          metrics: this.hub.deviceMetrics(row.device_id),
          tasksEnded: this.hub.tasksEnded(row.device_id),
          widget: row.device_id ? this.hub.widgetReport(row.device_id) : null,
        }
      : null;

    const activeSession = liveSessionOf(row);
    const maintenance: StationMaintenance | null =
      row.maintenance_until && row.maintenance_until.getTime() > Date.now()
        ? {
            until: row.maintenance_until.toISOString(),
            byUserId: row.maintenance_by,
            byName: row.maintenance_by_name,
          }
        : null;
    const pendingRequest: StationPendingRequest | null =
      row.request_id && row.request_kind && row.request_requested_at
        ? {
            id: row.request_id,
            kind: row.request_kind,
            customerId: row.request_customer_id ?? '',
            customerName: row.request_customer_name ?? '',
            durationMinutes: row.request_minutes ?? 0,
            minutes: row.request_quick_minutes,
            packageId: row.request_package_id,
            packageName: row.request_package_name,
            requestedAt: row.request_requested_at.toISOString(),
          }
        : null;
    let status: StationStatus;
    if (!row.is_enabled) status = 'disabled';
    else if (activeSession) status = activeSession.status === 'paused' ? 'paused' : 'occupied';
    else if (!device || !online) status = 'offline';
    else if (maintenance) status = 'maintenance';
    else status = 'available';

    return {
      id: row.id,
      number: row.number,
      code: row.code,
      name: row.name,
      zone: row.zone,
      notes: row.notes,
      isEnabled: row.is_enabled,
      status,
      device,
      activeSession,
      maintenance,
      pendingRequest,
      orders: {
        pending: Number(row.orders_pending ?? 0),
        openCount: Number(row.orders_open_count ?? 0),
        openCents: Number(row.orders_open_cents ?? 0),
      },
      awaitingPayment: {
        count: Number(row.awaiting_count ?? 0),
        amountCents: Number(row.awaiting_cents ?? 0),
      },
      archived: row.archived_at
        ? {
            at: row.archived_at.toISOString(),
            reason: row.archived_reason,
            byName: row.archived_by_name,
          }
        : null,
      look: row.look ?? {},
      wallpaperUrl: row.wallpaper_file ? wallpaperPath(row.wallpaper_file) : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  // ─── Maintenance (staff unlock) grants ──────────────────────────────────────

  /** Records that the PC may stay unlocked without a session until `until`. */
  async grantMaintenance(
    stationId: string,
    until: Date,
    by: { userId: string | null; name: string },
    db: Queryable = this.pool,
  ): Promise<StationSummary> {
    const r = await db.query(
      `UPDATE stations SET maintenance_until = $2, maintenance_by = $3, maintenance_by_name = $4
        WHERE id = $1`,
      [stationId, until, by.userId, by.name],
    );
    if (!r.rowCount) throw notFound('Station');
    const station = await this.getById(stationId, db);
    this.hub.broadcastToAdmins('station.changed', station);
    return station;
  }

  /** Ends a maintenance grant (lock, session start, expiry). Returns false when there was none. */
  async clearMaintenance(stationId: string, db: Queryable = this.pool): Promise<boolean> {
    const r = await db.query(
      `UPDATE stations SET maintenance_until = NULL, maintenance_by = NULL, maintenance_by_name = NULL
        WHERE id = $1 AND maintenance_until IS NOT NULL`,
      [stationId],
    );
    if (!r.rowCount) return false;
    const station = await this.getById(stationId, db);
    this.hub.broadcastToAdmins('station.changed', station);
    return true;
  }

  /** Live grant for the client handshake (null when none or expired). */
  async maintenanceOf(stationId: string): Promise<{ until: string; byName: string | null } | null> {
    const r = await this.pool.query<{ until: Date; by_name: string | null }>(
      `SELECT maintenance_until AS until, maintenance_by_name AS by_name FROM stations
        WHERE id = $1 AND maintenance_until > now()`,
      [stationId],
    );
    const row = r.rows[0];
    return row ? { until: row.until.toISOString(), byName: row.by_name } : null;
  }

  /** Stations whose grant ran out but is still recorded; the caller locks the PCs. */
  async expiredMaintenance(db: Queryable = this.pool): Promise<string[]> {
    const r = await db.query<{ id: string }>(
      'SELECT id FROM stations WHERE maintenance_until IS NOT NULL AND maintenance_until <= now()',
    );
    return r.rows.map((x) => x.id);
  }

  /** Archived stations stay in the database (money history) but leave the floor by default. */
  async list(db: Queryable = this.pool, includeArchived = false): Promise<StationSummary[]> {
    const where = includeArchived ? '' : ' WHERE s.archived_at IS NULL';
    const result = await db.query<StationRow>(
      `${STATION_SELECT}${where} ORDER BY s.sort_order, s.number`,
    );
    return result.rows.map((r) => this.mapRow(r));
  }

  async getById(id: string, db: Queryable = this.pool): Promise<StationSummary> {
    const result = await db.query<StationRow>(`${STATION_SELECT} WHERE s.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) throw notFound('Station');
    return this.mapRow(row);
  }

  async create(input: CreateStationRequest, actor: AuditActor): Promise<StationSummary> {
    return withTransaction(this.pool, async (client) => {
      const clash = await client.query('SELECT 1 FROM stations WHERE number = $1', [input.number]);
      if (clash.rowCount)
        throw conflict(`Station number ${input.number} already exists`, { field: 'number' });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO stations (number, code, name, zone, notes, is_enabled, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $1) RETURNING id`,
        [
          input.number,
          stationCodeFor(input.number),
          input.name,
          input.zone ?? null,
          input.notes ?? null,
          input.isEnabled,
        ],
      );
      const id = inserted.rows[0]!.id;
      await recordAudit(client, actor, {
        action: 'station.create',
        entityType: 'station',
        entityId: id,
        details: { number: input.number, name: input.name },
      });
      const station = await this.getById(id, client);
      this.hub.broadcastToAdmins('station.changed', station);
      return station;
    });
  }

  async update(
    id: string,
    patch: UpdateStationRequest,
    actor: AuditActor,
  ): Promise<StationSummary> {
    return withTransaction(this.pool, async (client) => {
      const before = await this.getById(id, client);
      if (patch.number !== undefined && patch.number !== before.number) {
        const clash = await client.query('SELECT 1 FROM stations WHERE number = $1 AND id <> $2', [
          patch.number,
          id,
        ]);
        if (clash.rowCount)
          throw conflict(`Station number ${patch.number} already exists`, { field: 'number' });
      }
      await client.query(
        `UPDATE stations SET
           number = COALESCE($2, number),
           code = COALESCE($3, code),
           name = COALESCE($4, name),
           zone = CASE WHEN $5::boolean THEN $6 ELSE zone END,
           notes = CASE WHEN $7::boolean THEN $8 ELSE notes END,
           is_enabled = COALESCE($9, is_enabled),
           sort_order = COALESCE($2, sort_order)
         WHERE id = $1`,
        [
          id,
          patch.number ?? null,
          patch.number !== undefined ? stationCodeFor(patch.number) : null,
          patch.name ?? null,
          patch.zone !== undefined,
          patch.zone ?? null,
          patch.notes !== undefined,
          patch.notes ?? null,
          patch.isEnabled ?? null,
        ],
      );
      await recordAudit(client, actor, {
        action: 'station.update',
        entityType: 'station',
        entityId: id,
        details: { changes: patch },
      });
      const station = await this.getById(id, client);
      this.hub.broadcastToAdmins('station.changed', station);
      return station;
    });
  }

  /** Deleting is only allowed for stations without history; otherwise disable them instead. */
  /**
   * Archive PC (0.17.0): the station leaves the floor and its device is revoked, so the same PC
   * can be paired again — as new, or under another name. Nothing is erased: the sessions, sales
   * and connection log stay, and the reason is kept on the row and in the audit log.
   */
  async archive(id: string, reason: string, actor: AuditActor): Promise<StationSummary> {
    const station = await withTransaction(this.pool, async (client) => {
      const current = await this.getById(id, client);
      if (current.activeSession)
        throw conflict('Stop the running session on this PC before archiving it.');
      if (current.archived) throw conflict('This station is already archived.');
      await client.query(
        `UPDATE stations SET archived_at = now(), archived_by = $2, archived_reason = $3
          WHERE id = $1`,
        [id, actor.userId ?? null, reason],
      );
      await recordAudit(client, actor, {
        action: 'station.archive',
        entityType: 'station',
        entityId: id,
        details: { number: current.number, name: current.name, reason },
        severity: 'warning',
      });
      return this.getById(id, client);
    });
    await this.revokeArchivedDevice(station, actor);
    this.hub.broadcastToAdmins('station.changed', station);
    return station;
  }

  async unarchive(id: string, actor: AuditActor): Promise<StationSummary> {
    const station = await withTransaction(this.pool, async (client) => {
      const current = await this.getById(id, client);
      if (!current.archived) throw conflict('This station is not archived.');
      await client.query(
        `UPDATE stations SET archived_at = NULL, archived_by = NULL, archived_reason = NULL
          WHERE id = $1`,
        [id],
      );
      await recordAudit(client, actor, {
        action: 'station.unarchive',
        entityType: 'station',
        entityId: id,
        details: { number: current.number, name: current.name },
      });
      return this.getById(id, client);
    });
    this.hub.broadcastToAdmins('station.changed', station);
    return station;
  }

  /** A PC of an archived station must not keep its socket — and must be pairable again. */
  private async revokeArchivedDevice(station: StationSummary, actor: AuditActor): Promise<void> {
    if (station.device?.status !== 'approved' || !this.revokeDevice) return;
    try {
      await this.revokeDevice(station.device.id, actor);
    } catch (err) {
      // Already revoked / gone in the meantime is fine; anything else must reach the caller.
      if (!(err instanceof AppError)) throw err;
    }
  }

  async remove(id: string, reason: string, actor: AuditActor): Promise<void> {
    const station = await this.getById(id);
    if (station.device?.status === 'approved') await this.revokeArchivedDevice(station, actor);
    await withTransaction(this.pool, async (client) => {
      const sessions = await client.query(
        'SELECT 1 FROM gaming_sessions WHERE station_id = $1 LIMIT 1',
        [id],
      );
      if (sessions.rowCount) {
        throw conflict(
          'This station has session history and cannot be deleted. Archive it instead — ' +
            'the PC can then be paired again and the history stays.',
        );
      }
      await client.query('DELETE FROM stations WHERE id = $1', [id]);
      await recordAudit(client, actor, {
        action: 'station.delete',
        entityType: 'station',
        entityId: id,
        details: { number: station.number, name: station.name, reason },
        severity: 'warning',
      });
      this.hub.broadcastToAdmins('station.changed', { ...station, deleted: true });
    });
  }

  async broadcastStation(id: string): Promise<void> {
    try {
      const station = await this.getById(id);
      this.hub.broadcastToAdmins('station.changed', station);
    } catch {
      /* station deleted meanwhile */
    }
  }
}
