/**
 * Wake-on-LAN (0.7.0): turns gaming PCs on from the Admin by sending the classic "magic packet"
 * (UDP, 6 × 0xFF + MAC × 16) to the PC's network card. The server is the only sender — it sits
 * on the same LAN as the PCs, while the Admin may be anywhere the server is reachable.
 *
 * What is sent, per PC, 3 times 150 ms apart (switches drop the odd UDP frame; NICs do not mind
 * duplicates): to the limited broadcast 255.255.255.255, to the directed broadcast of every IPv4
 * network the server is attached to, and unicast to the PC's last known IP (helps when the switch
 * still has the port in its ARP cache). Ports 9 ("discard") and 7 — both are conventional.
 *
 * Whether the PC actually starts depends on its BIOS/UEFI and Windows adapter settings; the
 * readiness shown in the Admin comes from `@likapcs/shared` `wakeReadiness()` over the hardware
 * facts the client reported. The server never refuses to send because of readiness — trying costs
 * nothing — but it does refuse for PCs that are online or have no MAC on record.
 */
import dgram from 'node:dgram';
import os from 'node:os';
import type { Pool } from 'pg';
import {
  magicPacket,
  wakeReadiness,
  type StationSummary,
  type StationWakeAllResponse,
  type StationWakeResponse,
} from '@likapcs/shared';
import { conflict } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { StationsService } from './stations.js';

export const WAKE_PORTS = [9, 7] as const;
const BURSTS = 3;
const BURST_GAP_MS = 150;

/** Directed broadcast address of an IPv4 interface (`ip | ~mask`). */
export function broadcastOf(address: string, netmask: string): string | null {
  const ip = address.split('.').map(Number);
  const mask = netmask.split('.').map(Number);
  if (ip.length !== 4 || mask.length !== 4 || [...ip, ...mask].some((n) => !Number.isInteger(n)))
    return null;
  return ip.map((octet, i) => (octet | (~mask[i]! & 0xff)) & 0xff).join('.');
}

/** Every distinct target a magic packet should go to for this PC. */
export function wakeTargets(lastIp: string | null, interfaces = os.networkInterfaces()): string[] {
  const targets = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      const bcast = broadcastOf(iface.address, iface.netmask);
      if (bcast) targets.add(bcast);
    }
  }
  if (lastIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(lastIp)) targets.add(lastIp);
  return [...targets];
}

export interface WakeSender {
  send(mac: string, targets: string[]): Promise<void>;
}

/** Real UDP sender; one socket per call, closed afterwards. */
export class UdpWakeSender implements WakeSender {
  constructor(private readonly ports: readonly number[] = WAKE_PORTS) {}

  async send(mac: string, targets: string[]): Promise<void> {
    const packet = magicPacket(mac);
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, () => {
          socket.setBroadcast(true);
          resolve();
        });
      });
      for (let burst = 0; burst < BURSTS; burst += 1) {
        if (burst > 0) await new Promise((r) => setTimeout(r, BURST_GAP_MS));
        await Promise.all(
          targets.flatMap((target) =>
            this.ports.map(
              (port) =>
                new Promise<void>((resolve) => {
                  // A refused/unroutable target must not fail the whole burst (e.g. an old last IP).
                  socket.send(packet, port, target, () => resolve());
                }),
            ),
          ),
        );
      }
    } finally {
      socket.close();
    }
  }
}

export class WakeService {
  constructor(
    private readonly pool: Pool,
    private readonly stations: StationsService,
    private readonly sender: WakeSender = new UdpWakeSender(),
  ) {}

  /** Why a station cannot be woken right now, or null when it can. */
  static blocker(station: StationSummary): 'online' | 'no_mac' | 'no_device' | null {
    if (!station.device) return 'no_device';
    if (station.device.online) return 'online';
    if (!wakeReadiness(station.device.hardware, station.device.lastIp).mac) return 'no_mac';
    return null;
  }

  async wake(stationId: string, actor: AuditActor): Promise<StationWakeResponse> {
    const station = await this.stations.getById(stationId);
    const blocker = WakeService.blocker(station);
    if (blocker === 'online')
      throw conflict(`${station.code} is already online`, { code: 'STATION_ONLINE' });
    if (blocker)
      throw conflict(`${station.code} has no network adapter on record — it must connect once`, {
        code: 'NO_MAC',
      });
    const result = await this.sendFor(station);
    await recordAudit(this.pool, actor, {
      action: 'station.wake',
      entityType: 'station',
      entityId: station.id,
      details: { mac: result.mac, targets: result.targets, warnings: result.warnings },
    });
    return result;
  }

  /** Wakes every offline PC with a known MAC; reports the ones it had to skip. */
  async wakeAll(actor: AuditActor): Promise<StationWakeAllResponse> {
    const stations = (await this.stations.list()).filter((s) => s.isEnabled);
    const sent: StationWakeResponse[] = [];
    const skipped: StationWakeAllResponse['skipped'] = [];
    for (const station of stations) {
      const blocker = WakeService.blocker(station);
      if (blocker) {
        skipped.push({ stationId: station.id, code: station.code, reason: blocker });
        continue;
      }
      sent.push(await this.sendFor(station));
    }
    await recordAudit(this.pool, actor, {
      action: 'station.wake_all',
      entityType: 'station',
      entityId: null,
      details: { sent: sent.map((s) => s.code), skipped },
    });
    return { sent, skipped };
  }

  private async sendFor(station: StationSummary): Promise<StationWakeResponse> {
    const device = station.device!;
    const readiness = wakeReadiness(device.hardware, device.lastIp);
    const mac = readiness.mac!;
    const targets = wakeTargets(device.lastIp);
    await this.sender.send(mac, targets);
    return { stationId: station.id, code: station.code, mac, targets, warnings: readiness.issues };
  }
}
