/**
 * Wake-on-LAN helpers shared by the server (which sends the magic packets) and the Admin (which
 * shows whether a PC can be woken). Pure functions — no I/O here.
 *
 * A PC wakes from a magic packet only when three things line up: the BIOS/UEFI allows it (we can
 * neither read nor set that — see docs/wake-on-lan.md), the Windows adapter has "wake on magic
 * packet" on, and Fast startup is off (with it on, a "shut down" PC is hibernated and most boards
 * ignore the packet). The client reports the last two in `HardwareInfo`.
 */
import type { NetworkAdapterInfo } from './protocol.js';

/** The slice of `HardwareInfo` WoL cares about; both keys are absent in reports of 0.6.x clients. */
export interface WakeHardware {
  network?: NetworkAdapterInfo[] | null;
  fastStartup?: boolean | null;
}

export type WakeIssue =
  /** No physical adapter with a MAC address was ever reported — nothing to address the packet to. */
  | 'no_mac'
  /** Windows says the chosen adapter does not wake on magic packets. */
  | 'wol_off'
  /** Windows Fast startup is on. */
  | 'fast_startup'
  /** The adapter setting could not be read (older client, or Windows refused). */
  | 'wol_unknown';

export interface WakeReadiness {
  /** Adapter the magic packet will be addressed to, null when none qualifies. */
  adapter: NetworkAdapterInfo | null;
  mac: string | null;
  /** True when a MAC is known and no issue is reported — the best guess short of trying. */
  ready: boolean;
  issues: WakeIssue[];
}

/** The MAC bytes as a Buffer-free array; throws on malformed input (validated upstream). */
export function macToBytes(mac: string): number[] {
  const parts = mac.toUpperCase().replace(/-/g, ':').split(':');
  if (parts.length !== 6 || parts.some((p) => !/^[0-9A-F]{2}$/.test(p)))
    throw new Error(`invalid MAC address: ${mac}`);
  return parts.map((p) => parseInt(p, 16));
}

/** 6 × 0xFF followed by the MAC 16 times — the "magic packet" every WoL-capable NIC listens for. */
export function magicPacket(mac: string): Uint8Array {
  const bytes = macToBytes(mac);
  const out = new Uint8Array(6 + 16 * 6);
  out.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i += 1) out.set(bytes, 6 + i * 6);
  return out;
}

const WIRELESS =
  /wi-?fi|wireless|wlan|802\.11|bluetooth|virtual|vmware|hyper-v|vethernet|tap|tun|loopback/i;

/**
 * Picks the adapter to wake: the one that carried the PC's last connection when we know it,
 * otherwise a wired adapter that is up, otherwise any wired one, otherwise anything with a MAC.
 * Wi-Fi adapters almost never wake a PC, so they are the last resort.
 */
export function pickWakeAdapter(
  hardware: WakeHardware | null | undefined,
  lastIp: string | null | undefined,
): NetworkAdapterInfo | null {
  const adapters = (hardware?.network ?? []).filter((a) => !!a.mac);
  if (adapters.length === 0) return null;
  const byIp = lastIp ? adapters.find((a) => a.ipv4 && a.ipv4 === lastIp) : undefined;
  if (byIp) return byIp;
  const wired = adapters.filter((a) => !WIRELESS.test(`${a.name} ${a.description ?? ''}`));
  return wired.find((a) => a.up) ?? wired[0] ?? adapters.find((a) => a.up) ?? adapters[0] ?? null;
}

export function wakeReadiness(
  hardware: WakeHardware | null | undefined,
  lastIp: string | null | undefined,
): WakeReadiness {
  const adapter = pickWakeAdapter(hardware, lastIp);
  if (!adapter) return { adapter: null, mac: null, ready: false, issues: ['no_mac'] };
  const issues: WakeIssue[] = [];
  if (adapter.wakeOnMagicPacket === false) issues.push('wol_off');
  else if (adapter.wakeOnMagicPacket == null) issues.push('wol_unknown');
  if (hardware?.fastStartup === true) issues.push('fast_startup');
  return { adapter, mac: adapter.mac, ready: issues.length === 0, issues };
}
