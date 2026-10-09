import {
  billableSeconds,
  priceForSeconds,
  type ActiveSessionSummary,
  type CreateStationRequest,
  type PricingTerms,
  type StationDeviceSummary,
  type StationStatus,
  type StationSummary,
  type UpdateStationRequest,
} from '@likapcs/shared';
import type { DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';

interface StationRow {
  id: string;
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
  session_id: string | null;
  session_customer_name: string | null;
  session_billing_mode: 'prepaid' | 'postpaid' | null;
  session_status: 'active' | 'paused' | null;
  session_started_at: Date | null;
  session_ends_at: Date | null;
  session_paused_at: Date | null;
  session_total_paused_seconds: number | null;
  session_quoted_price_cents: string | number | null;
  session_billing_terms: Record<string, unknown> | null;
  session_rate_cents_per_hour: string | number | null;
}

const STATION_SELECT = `
  SELECT s.id, s.number, s.code, s.name, s.zone, s.notes, s.is_enabled, s.created_at, s.updated_at,
         d.id AS device_id, d.machine_id AS device_machine_id, d.hostname AS device_hostname,
         d.os_info AS device_os_info, d.app_version AS device_app_version, d.status AS device_status,
         d.registered_at AS device_registered_at, d.approved_at AS device_approved_at,
         d.last_seen_at AS device_last_seen_at, d.last_ip AS device_last_ip,
         g.id AS session_id, COALESCE(g.customer_name, c.name) AS session_customer_name,
         g.billing_mode AS session_billing_mode, g.status AS session_status, g.started_at AS session_started_at,
         g.ends_at AS session_ends_at, g.paused_at AS session_paused_at,
         g.total_paused_seconds AS session_total_paused_seconds, g.quoted_price_cents AS session_quoted_price_cents,
         g.billing_terms AS session_billing_terms, g.rate_cents_per_hour AS session_rate_cents_per_hour
    FROM stations s
    LEFT JOIN station_devices d ON d.station_id = s.id AND d.status = 'approved'
    LEFT JOIN gaming_sessions g ON g.station_id = s.id AND g.status IN ('active', 'paused')
    LEFT JOIN customers c ON c.id = g.customer_id`;

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
    elapsedSeconds: elapsed,
    remainingSeconds: row.session_ends_at
      ? Math.max(0, Math.round((row.session_ends_at.getTime() - reference) / 1000))
      : null,
    currentPriceCents:
      row.session_billing_mode === 'prepaid'
        ? Number(row.session_quoted_price_cents ?? 0)
        : priceForSeconds(elapsed, terms),
  };
}

export function stationCodeFor(number: number): string {
  return `PC ${String(number).padStart(2, '0')}`;
}

export class StationsService {
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
        }
      : null;

    const activeSession = liveSessionOf(row);
    let status: StationStatus;
    if (!row.is_enabled) status = 'disabled';
    else if (activeSession) status = activeSession.status === 'paused' ? 'paused' : 'occupied';
    else if (!device || !online) status = 'offline';
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
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async list(db: Queryable = this.pool): Promise<StationSummary[]> {
    const result = await db.query<StationRow>(`${STATION_SELECT} ORDER BY s.sort_order, s.number`);
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
  async remove(id: string, actor: AuditActor): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const station = await this.getById(id, client);
      const sessions = await client.query(
        'SELECT 1 FROM gaming_sessions WHERE station_id = $1 LIMIT 1',
        [id],
      );
      if (sessions.rowCount) {
        throw conflict(
          'This station has session history and cannot be deleted. Disable it instead.',
        );
      }
      if (station.device) {
        throw conflict('Revoke the assigned device before deleting the station.');
      }
      await client.query('DELETE FROM stations WHERE id = $1', [id]);
      await recordAudit(client, actor, {
        action: 'station.delete',
        entityType: 'station',
        entityId: id,
        details: { number: station.number, name: station.name },
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
