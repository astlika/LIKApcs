import {
  PERMISSIONS,
  type StaffUnlockInput,
  type StaffUnlockResponse,
  type StationSummary,
} from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';
import { AppError, conflict, forbidden } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { recordAudit } from './audit.js';
import type { AuthService } from './auth.js';
import type { AuthenticatedDevice } from './devices.js';
import type { SettingsService } from './settings.js';
import type { StationsService } from './stations.js';
import type { UsersService } from './users.js';

/**
 * Staff unlock ("maintenance") of a station PC.
 *
 * A staff member standing at a locked PC types their own LIKApcs username and password into the
 * client. The client forwards them (device-token authenticated, TLS/LAN) to the server, which:
 *   1. verifies the credentials with the normal lockout policy (`AuthService.verifyCredentials`),
 *   2. requires the `stations.unlock` permission,
 *   3. records a time-limited grant on the station (survives reconnects and server restarts),
 *   4. sends the `unlock` command to that very device.
 * The grant ends when it expires (the server sends `lock`), when staff lock the PC again, when an
 * Admin locks it, or when a customer session starts. Nothing here touches billing: a maintenance
 * unlock never creates a session.
 */
export class MaintenanceService {
  constructor(
    private readonly pool: DbPool,
    private readonly hub: RealtimeHub,
    private readonly stations: StationsService,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
  ) {}

  async unlockFromDevice(
    device: AuthenticatedDevice,
    input: StaffUnlockInput,
    ip: string | null,
  ): Promise<StaffUnlockResponse> {
    const stationId = device.station.id;
    const { userId } = await this.auth.verifyCredentials({
      username: input.username,
      password: input.password,
      ip,
      userAgent: 'LIKApcs-Client',
      clientApp: 'client',
    });
    const permissions = await this.users.getPermissions(userId);
    if (!permissions.includes(PERMISSIONS.STATIONS_UNLOCK)) {
      await recordAudit(
        this.pool,
        { userId, label: input.username, ip },
        {
          action: 'station.maintenance_unlock',
          entityType: 'station',
          entityId: stationId,
          details: { ok: false, reason: 'missing_permission', deviceId: device.id },
          severity: 'warning',
        },
      );
      throw forbidden('This account may not unlock station PCs');
    }

    const station = await this.stations.getById(stationId);
    if (!station.isEnabled) throw conflict('Station is disabled');
    if (station.activeSession) {
      throw new AppError(409, 'session_active', 'A customer session is running on this station');
    }
    if (!this.hub.isDeviceOnline(device.id)) {
      throw conflict('The client is not connected to the server yet — try again in a moment');
    }

    const minutes = input.minutes ?? (await this.settings.get('stations.maintenance_minutes'));
    const until = new Date(Date.now() + minutes * 60_000);
    const user = await this.users.getById(userId);
    const byName = user.fullName || user.username;
    await this.stations.grantMaintenance(stationId, until, { userId, name: byName });

    const result = await this.hub.sendCommand(
      device.id,
      'unlock',
      { reason: 'maintenance', until: until.toISOString(), byName },
      { timeoutMs: 15_000 },
    );
    if (!result.ok) {
      await this.stations.clearMaintenance(stationId);
      throw conflict(`The client did not confirm the unlock: ${result.error ?? 'unknown error'}`);
    }
    await recordAudit(
      this.pool,
      { userId, label: input.username, ip },
      {
        action: 'station.maintenance_unlock',
        entityType: 'station',
        entityId: stationId,
        details: { ok: true, minutes, until: until.toISOString(), deviceId: device.id },
      },
    );
    return { until: until.toISOString(), byName, minutes };
  }

  /** Staff pressed "Lock" on the PC: end the grant now (the client locks itself immediately). */
  async lockFromDevice(device: AuthenticatedDevice, ip: string | null): Promise<StationSummary> {
    const stationId = device.station.id;
    const had = await this.stations.clearMaintenance(stationId);
    if (had) {
      await recordAudit(
        this.pool,
        { userId: null, label: `device:${device.station.code}`, ip },
        { action: 'station.maintenance_lock', entityType: 'station', entityId: stationId },
      );
    }
    return this.stations.getById(stationId);
  }

  /**
   * Admin-side `lock`/`unlock` commands keep the grant in step: an Admin unlock is a maintenance
   * grant too (default duration, attributed to the Admin user), an Admin lock ends it.
   */
  async onAdminCommand(
    command: 'lock' | 'unlock',
    stationId: string,
    actor: { userId: string | null; label: string },
  ): Promise<{ until: string; byName: string } | null> {
    if (command === 'lock') {
      await this.stations.clearMaintenance(stationId);
      return null;
    }
    const minutes = await this.settings.get('stations.maintenance_minutes');
    const until = new Date(Date.now() + minutes * 60_000);
    await this.stations.grantMaintenance(stationId, until, {
      userId: actor.userId,
      name: actor.label,
    });
    return { until: until.toISOString(), byName: actor.label };
  }

  /** Periodic: locks PCs whose grant has run out. */
  async sweep(): Promise<void> {
    const expired = await this.stations.expiredMaintenance();
    for (const stationId of expired) {
      await this.stations.clearMaintenance(stationId);
      const presence = this.hub.listDevices().find((d) => d.stationId === stationId);
      if (presence) {
        const result = await this.hub.sendCommand(
          presence.deviceId,
          'lock',
          { reason: 'maintenance_expired' },
          { timeoutMs: 15_000 },
        );
        await recordAudit(
          this.pool,
          { userId: null, label: 'system', ip: null },
          {
            action: 'station.maintenance_expired',
            entityType: 'station',
            entityId: stationId,
            details: { ok: result.ok, error: result.error ?? null },
            severity: result.ok ? 'info' : 'warning',
          },
        );
      }
    }
  }
}
