import type {
  CreateStationRequest,
  StationDeviceSummary,
  StationStatus,
  StationSummary,
  UpdateStationRequest,
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
}

const STATION_SELECT = `
  SELECT s.id, s.number, s.code, s.name, s.zone, s.notes, s.is_enabled, s.created_at, s.updated_at,
         d.id AS device_id, d.machine_id AS device_machine_id, d.hostname AS device_hostname,
         d.os_info AS device_os_info, d.app_version AS device_app_version, d.status AS device_status,
         d.registered_at AS device_registered_at, d.approved_at AS device_approved_at,
         d.last_seen_at AS device_last_seen_at, d.last_ip AS device_last_ip
    FROM stations s
    LEFT JOIN station_devices d ON d.station_id = s.id AND d.status = 'approved'`;

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

    // Session-driven statuses (occupied / paused / locked) are introduced in Phase 3.
    let status: StationStatus;
    if (!row.is_enabled) status = 'disabled';
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
      activeSession: null,
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
