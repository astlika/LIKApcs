import type { Pool } from 'pg';
import {
  isNewerVersion,
  type ClientUpdatePushResponse,
  type StationCommandRequest,
  type StationCommandResponse,
} from '@likapcs/shared';
import { conflict } from '../errors.js';
import type { DevicePresence, RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';
import { SERVER_VERSION } from '../version.js';

/** A policy decision for pushing `update.apply` to a connected client. */
export type UpdatePolicy = 'manual' | 'idle_only' | 'maintenance_window';

/** True when `HH:MM-HH:MM` (local server time) currently applies; windows may cross midnight. */
export function inMaintenanceWindow(window: string, now = new Date()): boolean {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!match) return false;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  const minutes = now.getHours() * 60 + now.getMinutes();
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/**
 * Decides whether a client that just connected should be told to update itself now.
 * `hasActiveSession` keeps idle-only updates away from paying customers.
 */
export function shouldPushUpdate(input: {
  clientVersion: string;
  serverVersion?: string;
  policy: UpdatePolicy;
  maintenanceWindow: string;
  hasActiveSession: boolean;
  now?: Date;
}): boolean {
  const server = input.serverVersion ?? SERVER_VERSION;
  if (!isNewerVersion(server, input.clientVersion)) return false;
  switch (input.policy) {
    case 'manual':
      return false;
    case 'idle_only':
      return !input.hasActiveSession;
    case 'maintenance_window':
      return !input.hasActiveSession && inMaintenanceWindow(input.maintenanceWindow, input.now);
  }
}

/**
 * Staff-initiated commands to client PCs. Everything goes through the realtime hub, which gives
 * every command a unique id + sequence number and waits for the client's single acknowledgement.
 */
export class CommandsService {
  constructor(
    private readonly pool: Pool,
    private readonly hub: RealtimeHub,
  ) {}

  private onlineDeviceForStation(stationId: string): DevicePresence {
    const presence = this.hub.listDevices().find((d) => d.stationId === stationId);
    if (!presence) throw conflict('No client is connected for this station', { stationId });
    return presence;
  }

  async sendToStation(
    stationId: string,
    request: StationCommandRequest,
    actor: AuditActor,
  ): Promise<StationCommandResponse> {
    const presence = this.onlineDeviceForStation(stationId);
    const { command, ...payload } = request;
    const result = await this.hub.sendCommand(presence.deviceId, command, payload, {
      // power actions need a longer window: the client acks before the OS acts, but the PC may be slow
      timeoutMs: command.startsWith('power.') ? 20_000 : 15_000,
    });
    await recordAudit(this.pool, actor, {
      action: `station.command.${command}`,
      entityType: 'station',
      entityId: stationId,
      details: { deviceId: presence.deviceId, payload, ok: result.ok, error: result.error ?? null },
      severity: result.ok ? 'info' : 'warning',
    });
    return { commandId: result.commandId, command, ok: result.ok, error: result.error };
  }

  /** Tells every online client running an older version than the server to update now. */
  async pushUpdateToOutdated(actor: AuditActor): Promise<ClientUpdatePushResponse> {
    const outdated = this.hub
      .listDevices()
      .filter((d) => isNewerVersion(SERVER_VERSION, d.appVersion));
    const results = await Promise.all(
      outdated.map(async (d) => {
        const r = await this.hub.sendCommand(d.deviceId, 'update.apply', {}, { timeoutMs: 15_000 });
        return { deviceId: d.deviceId, stationId: d.stationId, ok: r.ok, error: r.error };
      }),
    );
    await recordAudit(this.pool, actor, {
      action: 'clients.update_push',
      entityType: null,
      entityId: null,
      details: { outdated: outdated.length, sent: results.filter((r) => r.ok).length },
    });
    return { outdated: outdated.length, sent: results.filter((r) => r.ok).length, results };
  }
}
