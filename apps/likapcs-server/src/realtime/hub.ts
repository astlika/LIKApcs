import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import {
  WS_CLOSE_CODES,
  type AdminEventName,
  type ServerCommand,
  type ServerEvent,
  type StationCommand,
} from '@likapcs/shared';
import { newId } from '../security/tokens.js';

/**
 * In-memory registry of live WebSocket connections.
 *
 * It holds NO business state — gaming sessions, billing and device authorisation live in the
 * database. If the server restarts, clients simply reconnect and the hub is rebuilt.
 */

export interface DevicePresence {
  deviceId: string;
  stationId: string;
  machineId: string;
  appVersion: string;
  ip: string | null;
  socket: WebSocket;
  connectedAt: Date;
  lastHeartbeatAt: Date;
  lastMetrics: Record<string, unknown> | null;
  locked: boolean | null;
  /** Per-connection monotonically increasing command sequence (replay protection). */
  seq: number;
  pending: Map<string, PendingCommand>;
}

export interface PendingCommand {
  command: StationCommand;
  issuedAt: Date;
  resolve: (ack: { ok: boolean; error?: string }) => void;
  timer: NodeJS.Timeout;
}

export interface AdminPresence {
  socket: WebSocket;
  userId: string;
  username: string;
  connectedAt: Date;
}

export interface HubEvents {
  'device.online': [DevicePresence];
  'device.offline': [{ deviceId: string; stationId: string; reason: string }];
  'device.heartbeat': [DevicePresence];
}

export class RealtimeHub extends EventEmitter<HubEvents> {
  private readonly devices = new Map<string, DevicePresence>();
  private readonly admins = new Set<AdminPresence>();

  // ─── Devices ─────────────────────────────────────────────────────────────────
  attachDevice(presence: DevicePresence): void {
    const existing = this.devices.get(presence.deviceId);
    if (existing && existing.socket !== presence.socket) {
      // Same device opened a new connection (e.g. after a network blip) — drop the stale one quietly.
      existing.socket.close(
        WS_CLOSE_CODES.REPLACED_BY_NEW_CONNECTION,
        'replaced by a new connection',
      );
      this.devices.delete(existing.deviceId);
    }
    this.devices.set(presence.deviceId, presence);
    this.emit('device.online', presence);
  }

  detachDevice(deviceId: string, socket: WebSocket, reason: string): void {
    const existing = this.devices.get(deviceId);
    if (!existing || existing.socket !== socket) return; // already replaced by a newer connection
    for (const pending of existing.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'device disconnected' });
    }
    this.devices.delete(deviceId);
    this.emit('device.offline', { deviceId, stationId: existing.stationId, reason });
  }

  touchDevice(
    deviceId: string,
    metrics: Record<string, unknown> | null,
    locked: boolean | null,
  ): void {
    const presence = this.devices.get(deviceId);
    if (!presence) return;
    presence.lastHeartbeatAt = new Date();
    if (metrics) presence.lastMetrics = metrics;
    if (locked !== null) presence.locked = locked;
    this.emit('device.heartbeat', presence);
  }

  getDevice(deviceId: string): DevicePresence | undefined {
    return this.devices.get(deviceId);
  }

  isDeviceOnline(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  onlineDeviceIds(): Set<string> {
    return new Set(this.devices.keys());
  }

  listDevices(): DevicePresence[] {
    return [...this.devices.values()];
  }

  /**
   * Sends a command to a device and resolves with its acknowledgement.
   * Every command has a unique id and an expiry; the client must ack it exactly once.
   */
  sendCommand(
    deviceId: string,
    command: StationCommand,
    payload: Record<string, unknown>,
    options: { timeoutMs?: number; ttlMs?: number; commandId?: string } = {},
  ): Promise<{ ok: boolean; error?: string; commandId: string }> {
    const presence = this.devices.get(deviceId);
    const commandId = options.commandId ?? newId();
    if (!presence) return Promise.resolve({ ok: false, error: 'device offline', commandId });
    const now = new Date();
    presence.seq += 1;
    const message: ServerCommand = {
      type: 'server.command',
      commandId,
      seq: presence.seq,
      command,
      payload,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (options.ttlMs ?? 30_000)).toISOString(),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        presence.pending.delete(commandId);
        resolve({ ok: false, error: 'acknowledgement timeout', commandId });
      }, options.timeoutMs ?? 15_000);
      presence.pending.set(commandId, {
        command,
        issuedAt: now,
        timer,
        resolve: (ack) => resolve({ ...ack, commandId }),
      });
      presence.socket.send(JSON.stringify(message), (err) => {
        if (err) {
          clearTimeout(timer);
          presence.pending.delete(commandId);
          resolve({ ok: false, error: `send failed: ${err.message}`, commandId });
        }
      });
    });
  }

  /** Called by the client socket handler when an ack arrives. Duplicate acks are ignored. */
  resolveAck(deviceId: string, commandId: string, ack: { ok: boolean; error?: string }): boolean {
    const presence = this.devices.get(deviceId);
    const pending = presence?.pending.get(commandId);
    if (!presence || !pending) return false;
    clearTimeout(pending.timer);
    presence.pending.delete(commandId);
    pending.resolve(ack);
    return true;
  }

  // ─── Admins ──────────────────────────────────────────────────────────────────
  attachAdmin(presence: AdminPresence): void {
    this.admins.add(presence);
  }

  detachAdmin(presence: AdminPresence): void {
    this.admins.delete(presence);
  }

  adminCount(): number {
    return this.admins.size;
  }

  broadcastToAdmins<T>(event: AdminEventName, payload: T): void {
    const message: ServerEvent<T> = {
      type: 'server.event',
      event,
      payload,
      ts: new Date().toISOString(),
    };
    const data = JSON.stringify(message);
    for (const admin of this.admins) {
      if (admin.socket.readyState === admin.socket.OPEN) admin.socket.send(data);
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────
  /** Terminates connections whose heartbeat is older than `offlineAfterMs` (half-open sockets). */
  sweep(offlineAfterMs: number): void {
    const cutoff = Date.now() - offlineAfterMs;
    for (const presence of this.devices.values()) {
      if (presence.lastHeartbeatAt.getTime() < cutoff) {
        presence.socket.terminate();
        this.detachDevice(presence.deviceId, presence.socket, 'heartbeat timeout');
      }
    }
  }

  closeAll(code: number, reason: string): void {
    for (const presence of this.devices.values()) presence.socket.close(code, reason);
    for (const admin of this.admins) admin.socket.close(code, reason);
    this.devices.clear();
    this.admins.clear();
  }
}
