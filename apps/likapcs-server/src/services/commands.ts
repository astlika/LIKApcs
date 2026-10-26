import type { Pool } from 'pg';
import {
  isNewerVersion,
  validateEndTasks,
  type Cs2StationCommand,
  type ClientUpdatePushResponse,
  type StationCommandRequest,
  type StationCommandResponse,
} from '@likapcs/shared';
import { AppError, conflict } from '../errors.js';
import type { DevicePresence, RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { MaintenanceService } from './maintenance.js';
import type { SettingsService } from './settings.js';
import { SERVER_VERSION } from '../version.js';

/** What the hub answers for one command: delivered and acked, or why it was not. */
type CommandOutcome = Awaited<ReturnType<RealtimeHub['sendCommand']>>;

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
    private readonly maintenance: MaintenanceService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * End Task (0.17.0): the programs a PC may be told to close — only the owner's list from the
   * settings, validated once more here (protected names never leave the server).
   */
  async endTasksList(): Promise<string[]> {
    const v = validateEndTasks(await this.settings.get('stations.end_tasks_exes'));
    return v.ok ? v.exes : [];
  }

  /**
   * Sends `tasks.end` to the PC of a station and marks the station's button as pressed
   * (`pending` until the PC reports what it closed). Used by the staff button and by the
   * automatic run at the end of a session.
   */
  async endTasks(
    stationId: string,
    trigger: 'manual' | 'auto',
    actor: AuditActor,
  ): Promise<StationCommandResponse> {
    const exes = await this.endTasksList();
    if (exes.length === 0)
      throw new AppError(
        409,
        'end_tasks_empty',
        'No programs are listed for End Task — add them in Settings › Stations',
      );
    const presence = this.onlineDeviceForStation(stationId);
    // The button is pressed *before* the command goes out. A fast PC answers in the same
    // millisecond the ack resolves, and its report must have the last word — a "pending" written
    // after it once left the desk staring at "Closing…" forever.
    this.hub.setTasksEnded(presence.deviceId, {
      at: new Date().toISOString(),
      status: 'pending',
      closed: [],
      notRunning: [],
      failed: [],
      trigger,
    });
    let result: CommandOutcome;
    try {
      result = await this.hub.sendCommand(
        presence.deviceId,
        'tasks.end',
        { exes },
        {
          timeoutMs: 15_000,
        },
      );
    } catch (err) {
      this.hub.setTasksEnded(presence.deviceId, null);
      throw err;
    }
    // The command never reached the PC (offline, timeout, refused): release the button again.
    if (!result.ok) this.hub.setTasksEnded(presence.deviceId, null);
    await recordAudit(this.pool, actor, {
      action: 'station.command.tasks.end',
      entityType: 'station',
      entityId: stationId,
      details: {
        deviceId: presence.deviceId,
        exes,
        trigger,
        ok: result.ok,
        error: result.error ?? null,
      },
      severity: result.ok ? 'info' : 'warning',
    });
    return {
      commandId: result.commandId,
      command: 'tasks.end',
      ok: result.ok,
      error: result.error,
    };
  }

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
    if (request.command === 'tasks.end') return this.endTasks(stationId, 'manual', actor);
    const presence = this.onlineDeviceForStation(stationId);
    const { command, ...rest } = request;
    let payload: Record<string, unknown> = rest;
    if (command === 'lock' || command === 'unlock') {
      // Keep the station's maintenance grant in step with what the PC is told.
      const grant = await this.maintenance.onAdminCommand(command, stationId, {
        userId: actor.userId ?? null,
        label: actor.label ?? 'admin',
      });
      if (grant) payload = { ...payload, reason: 'maintenance', ...grant };
    }
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

  /**
   * CS2 match server (0.24.0). Only the dedicated CS2 routes call this: the generic staff route
   * never accepts `cs2.*`, so the arguments and the URL always come from the server's own config.
   */
  async sendCs2(
    stationId: string,
    command: Cs2StationCommand,
    payload: Record<string, unknown>,
    actor: AuditActor,
  ): Promise<{ commandId: string; command: Cs2StationCommand; ok: boolean; error?: string }> {
    const presence = this.onlineDeviceForStation(stationId);
    const result = await this.hub.sendCommand(presence.deviceId, command, payload, {
      timeoutMs: command === 'cs2.install' ? 20_000 : 15_000,
    });
    await recordAudit(this.pool, actor, {
      action: `station.command.${command}`,
      entityType: 'station',
      entityId: stationId,
      // Never log the payload: it can contain the server and player passwords.
      details: { deviceId: presence.deviceId, ok: result.ok, error: result.error ?? null },
      severity: result.ok ? 'info' : 'warning',
    });
    return { commandId: result.commandId, command, ok: result.ok, error: result.error };
  }

  /** The address of the device of a station, or null when it is offline. */
  deviceAddressOf(stationId: string): string | null {
    const presence = this.hub.listDevices().find((d) => d.stationId === stationId);
    if (!presence?.ip) return null;
    return presence.ip.replace(/^::ffff:/, '');
  }

  isStationOnline(stationId: string): boolean {
    return this.hub.listDevices().some((d) => d.stationId === stationId);
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
