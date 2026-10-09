import {
  WS_CLOSE_CODES,
  type RegisterDeviceRequest,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type StationDeviceSummary,
} from '@likapcs/shared';
import type { DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { conflict, notFound, unauthorized } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { generateToken, hashToken } from '../security/tokens.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { StationsService } from './stations.js';

interface DeviceRow {
  id: string;
  station_id: string | null;
  machine_id: string;
  hostname: string | null;
  os_info: string | null;
  app_version: string | null;
  status: 'pending' | 'approved' | 'revoked' | 'rejected';
  registered_at: Date;
  approved_at: Date | null;
  last_seen_at: Date | null;
  last_ip: string | null;
}

export interface AuthenticatedDevice {
  id: string;
  machineId: string;
  station: { id: string; number: number; code: string; name: string; isEnabled: boolean };
}

const DEVICE_COLUMNS =
  'id, station_id, machine_id, hostname, os_info, app_version, status, registered_at, approved_at, last_seen_at, last_ip';

export class DevicesService {
  constructor(
    private readonly pool: DbPool,
    private readonly hub: RealtimeHub,
    private readonly stations: StationsService,
  ) {}

  private mapRow(row: DeviceRow): StationDeviceSummary {
    return {
      id: row.id,
      stationId: row.station_id,
      machineId: row.machine_id,
      hostname: row.hostname,
      osInfo: row.os_info,
      appVersion: row.app_version,
      status: row.status,
      registeredAt: row.registered_at.toISOString(),
      approvedAt: row.approved_at?.toISOString() ?? null,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      lastIp: row.last_ip,
      online: this.hub.isDeviceOnline(row.id),
    };
  }

  // ─── Client-facing registration flow ─────────────────────────────────────────
  /**
   * Step 1 (client): announce the machine. Creates/refreshes a PENDING record.
   * An already-approved machine gets `status: approved` but never a new token this way — the
   * administrator must explicitly re-issue the token or revoke the device first.
   */
  async register(input: RegisterDeviceRequest, ip: string | null): Promise<RegisterDeviceResponse> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM station_devices
          WHERE machine_id = $1 AND status IN ('pending', 'approved') FOR UPDATE`,
        [input.machineId],
      );
      const row = existing.rows[0];
      if (row?.status === 'approved') {
        // A reinstalled client has a fresh registration secret. Accepting it is safe only while no
        // token is outstanding (never collected, or an admin re-issued it); otherwise the holder of
        // the original credentials keeps exclusive access until staff explicitly re-issue.
        await client.query(
          `UPDATE station_devices
              SET hostname = $2, os_info = $3, app_version = $4, last_ip = $5,
                  registration_secret_hash = CASE WHEN token_collected_at IS NULL THEN $6
                                                  ELSE registration_secret_hash END
            WHERE id = $1`,
          [
            row.id,
            input.hostname,
            input.osInfo ?? null,
            input.appVersion,
            ip,
            hashToken(input.registrationSecret),
          ],
        );
        return { registrationId: row.id, status: 'approved' };
      }
      if (row) {
        await client.query(
          `UPDATE station_devices SET hostname = $2, os_info = $3, app_version = $4, last_ip = $5,
                  registration_secret_hash = $6, registered_at = now()
            WHERE id = $1`,
          [
            row.id,
            input.hostname,
            input.osInfo ?? null,
            input.appVersion,
            ip,
            hashToken(input.registrationSecret),
          ],
        );
        return { registrationId: row.id, status: 'pending' };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO station_devices (machine_id, hostname, os_info, app_version, last_ip, registration_secret_hash)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          input.machineId,
          input.hostname,
          input.osInfo ?? null,
          input.appVersion,
          ip,
          hashToken(input.registrationSecret),
        ],
      );
      const id = inserted.rows[0]!.id;
      await recordAudit(
        client,
        { deviceId: id, label: input.hostname, ip },
        {
          action: 'device.register',
          entityType: 'device',
          entityId: id,
          details: { machineId: input.machineId, hostname: input.hostname },
        },
      );
      const device = await this.getById(id, client);
      this.hub.broadcastToAdmins('device.registered', device);
      return { registrationId: id, status: 'pending' };
    });
  }

  /**
   * Step 2 (client, polling): once approved, the device token is handed out EXACTLY ONCE to the
   * holder of the registration secret. If the client loses it, an admin re-issues the token.
   */
  async poll(
    registrationId: string,
    registrationSecret: string,
  ): Promise<RegistrationPollResponse> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<{
        id: string;
        status: DeviceRow['status'];
        station_id: string | null;
        registration_secret_hash: string | null;
        token_collected_at: Date | null;
      }>(
        'SELECT id, status, station_id, registration_secret_hash, token_collected_at FROM station_devices WHERE id = $1 FOR UPDATE',
        [registrationId],
      );
      const row = result.rows[0];
      if (
        !row ||
        !row.registration_secret_hash ||
        row.registration_secret_hash !== hashToken(registrationSecret)
      ) {
        throw unauthorized('Unknown registration or invalid secret');
      }
      if (row.status !== 'approved' || !row.station_id) return { status: row.status };
      if (row.token_collected_at) return { status: 'approved' };

      const token = generateToken();
      await client.query(
        'UPDATE station_devices SET token_hash = $2, token_collected_at = now() WHERE id = $1',
        [row.id, hashToken(token)],
      );
      const station = await client.query<{
        id: string;
        number: number;
        code: string;
        name: string;
      }>('SELECT id, number, code, name FROM stations WHERE id = $1', [row.station_id]);
      await recordAudit(
        client,
        { deviceId: row.id },
        { action: 'device.token_collected', entityType: 'device', entityId: row.id },
      );
      return { status: 'approved', deviceToken: token, station: station.rows[0] };
    });
  }

  /** Resolves a device token for the WebSocket handshake. */
  async authenticate(token: string): Promise<AuthenticatedDevice | null> {
    if (!token || token.length < 16) return null;
    const result = await this.pool.query<{
      id: string;
      machine_id: string;
      station_id: string;
      number: number;
      code: string;
      name: string;
      is_enabled: boolean;
    }>(
      `SELECT d.id, d.machine_id, s.id AS station_id, s.number, s.code, s.name, s.is_enabled
         FROM station_devices d JOIN stations s ON s.id = d.station_id
        WHERE d.token_hash = $1 AND d.status = 'approved'`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      machineId: row.machine_id,
      station: {
        id: row.station_id,
        number: row.number,
        code: row.code,
        name: row.name,
        isEnabled: row.is_enabled,
      },
    };
  }

  // ─── Admin-facing management ─────────────────────────────────────────────────
  async list(status?: DeviceRow['status']): Promise<StationDeviceSummary[]> {
    const result = status
      ? await this.pool.query<DeviceRow>(
          `SELECT ${DEVICE_COLUMNS} FROM station_devices WHERE status = $1 ORDER BY registered_at DESC`,
          [status],
        )
      : await this.pool.query<DeviceRow>(
          `SELECT ${DEVICE_COLUMNS} FROM station_devices ORDER BY registered_at DESC`,
        );
    return result.rows.map((r) => this.mapRow(r));
  }

  async getById(id: string, db: Queryable = this.pool): Promise<StationDeviceSummary> {
    const result = await db.query<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM station_devices WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw notFound('Device');
    return this.mapRow(row);
  }

  async approve(
    deviceId: string,
    stationId: string,
    actor: AuditActor,
  ): Promise<StationDeviceSummary> {
    const device = await withTransaction(this.pool, async (client) => {
      const current = await client.query<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM station_devices WHERE id = $1 FOR UPDATE`,
        [deviceId],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Device');
      if (row.status !== 'pending')
        throw conflict(`Only pending devices can be approved (current status: ${row.status})`);
      const station = await client.query<{ id: string }>('SELECT id FROM stations WHERE id = $1', [
        stationId,
      ]);
      if (!station.rowCount) throw notFound('Station');
      const occupied = await client.query(
        'SELECT 1 FROM station_devices WHERE station_id = $1 AND status = $2 AND id <> $3',
        [stationId, 'approved', deviceId],
      );
      if (occupied.rowCount)
        throw conflict('This station already has an approved device. Revoke it first.');
      await client.query(
        `UPDATE station_devices SET status = 'approved', station_id = $2, approved_at = now(), approved_by = $3,
                token_hash = NULL, token_collected_at = NULL
          WHERE id = $1`,
        [deviceId, stationId, actor.userId ?? null],
      );
      await recordAudit(client, actor, {
        action: 'device.approve',
        entityType: 'device',
        entityId: deviceId,
        details: { stationId, machineId: row.machine_id, hostname: row.hostname },
        severity: 'warning',
      });
      return this.getById(deviceId, client);
    });
    this.hub.broadcastToAdmins('device.changed', device);
    await this.stations.broadcastStation(stationId);
    return device;
  }

  async reject(deviceId: string, actor: AuditActor): Promise<StationDeviceSummary> {
    const device = await withTransaction(this.pool, async (client) => {
      const current = await client.query<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM station_devices WHERE id = $1 FOR UPDATE`,
        [deviceId],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Device');
      if (row.status !== 'pending') throw conflict('Only pending devices can be rejected');
      await client.query(
        "UPDATE station_devices SET status = 'rejected', registration_secret_hash = NULL WHERE id = $1",
        [deviceId],
      );
      await recordAudit(client, actor, {
        action: 'device.reject',
        entityType: 'device',
        entityId: deviceId,
        details: { machineId: row.machine_id },
      });
      return this.getById(deviceId, client);
    });
    this.hub.broadcastToAdmins('device.changed', device);
    return device;
  }

  /** Revokes a device: its token stops working immediately and any live connection is closed. */
  async revoke(deviceId: string, actor: AuditActor): Promise<StationDeviceSummary> {
    const { device, stationId } = await withTransaction(this.pool, async (client) => {
      const current = await client.query<DeviceRow>(
        `SELECT ${DEVICE_COLUMNS} FROM station_devices WHERE id = $1 FOR UPDATE`,
        [deviceId],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Device');
      if (row.status === 'revoked') throw conflict('Device is already revoked');
      await client.query(
        `UPDATE station_devices SET status = 'revoked', token_hash = NULL, registration_secret_hash = NULL,
                revoked_at = now(), revoked_by = $2 WHERE id = $1`,
        [deviceId, actor.userId ?? null],
      );
      await recordAudit(client, actor, {
        action: 'device.revoke',
        entityType: 'device',
        entityId: deviceId,
        details: { machineId: row.machine_id, stationId: row.station_id },
        severity: 'warning',
      });
      return { device: await this.getById(deviceId, client), stationId: row.station_id };
    });
    const presence = this.hub.getDevice(deviceId);
    if (presence) presence.socket.close(WS_CLOSE_CODES.DEVICE_REVOKED, 'device revoked');
    this.hub.broadcastToAdmins('device.changed', device);
    if (stationId) await this.stations.broadcastStation(stationId);
    return device;
  }

  /** Lets an approved client that lost its token collect a new one with its registration secret. */
  async reissueToken(deviceId: string, actor: AuditActor): Promise<StationDeviceSummary> {
    const device = await withTransaction(this.pool, async (client) => {
      const current = await client.query<DeviceRow & { registration_secret_hash: string | null }>(
        `SELECT ${DEVICE_COLUMNS}, registration_secret_hash FROM station_devices WHERE id = $1 FOR UPDATE`,
        [deviceId],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Device');
      if (row.status !== 'approved')
        throw conflict('Only approved devices can receive a new token');
      await client.query(
        'UPDATE station_devices SET token_hash = NULL, token_collected_at = NULL WHERE id = $1',
        [deviceId],
      );
      await recordAudit(client, actor, {
        action: 'device.token_reissue',
        entityType: 'device',
        entityId: deviceId,
        severity: 'warning',
      });
      return this.getById(deviceId, client);
    });
    const presence = this.hub.getDevice(deviceId);
    if (presence) presence.socket.close(WS_CLOSE_CODES.DEVICE_REVOKED, 'token re-issued');
    this.hub.broadcastToAdmins('device.changed', device);
    return device;
  }

  // ─── Telemetry ───────────────────────────────────────────────────────────────
  async recordHeartbeat(
    deviceId: string,
    stationId: string,
    data: {
      appVersion: string;
      ip: string | null;
      locked: boolean | null;
      metrics: Record<string, unknown> | null;
      sessionId: string | null;
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE station_devices SET last_seen_at = now(), last_ip = $2, app_version = $3, last_heartbeat = $4::jsonb WHERE id = $1`,
      [
        deviceId,
        data.ip,
        data.appVersion,
        JSON.stringify({ locked: data.locked, metrics: data.metrics, sessionId: data.sessionId }),
      ],
    );
    await this.pool.query(
      'INSERT INTO station_heartbeats (device_id, station_id, app_version, session_id, locked, metrics) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
      [
        deviceId,
        stationId,
        data.appVersion,
        data.sessionId,
        data.locked,
        data.metrics ? JSON.stringify(data.metrics) : null,
      ],
    );
  }

  async logConnection(
    deviceId: string,
    stationId: string | null,
    event: 'connected' | 'disconnected' | 'timeout' | 'rejected' | 'error' | 'replaced',
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO station_connection_logs (device_id, station_id, event, details) VALUES ($1, $2, $3, $4::jsonb)',
      [deviceId, stationId, event, JSON.stringify(details)],
    );
  }

  async connectionLogs(stationId: string, limit = 100) {
    const result = await this.pool.query<{
      id: number;
      device_id: string;
      occurred_at: Date;
      event: string;
      details: Record<string, unknown>;
    }>(
      'SELECT id, device_id, occurred_at, event, details FROM station_connection_logs WHERE station_id = $1 ORDER BY occurred_at DESC LIMIT $2',
      [stationId, limit],
    );
    return result.rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      occurredAt: r.occurred_at.toISOString(),
      event: r.event,
      details: r.details,
    }));
  }

  async pruneHeartbeats(olderThanDays = 7): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM station_heartbeats WHERE received_at < now() - ($1 || ' days')::interval",
      [String(olderThanDays)],
    );
    return result.rowCount ?? 0;
  }
}
