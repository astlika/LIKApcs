/**
 * Network addresses of the LIKApcs server, shown in Backups › Server and network.
 * The LAN addresses come from the machine itself; Tailscale (or any other) addresses are typed
 * by staff, because the server does not call the Tailscale CLI.
 */

export const REMOTE_ADDRESS_MAX_COUNT = 20;

export type ServerAddressSource = 'lan' | 'manual';

export interface ServerEndpoint {
  address: string;
  source: ServerAddressSource;
  /** Base URL of the API, e.g. `http://192.168.1.109:4700`. */
  api: string;
  /** Phone (PWA) URL, e.g. `http://192.168.1.109:4700/phone/`. */
  phone: string;
}

export interface ServerInfoResponse {
  version: string;
  startedAt: string;
  scheme: 'http' | 'https';
  bind: { host: string; port: number };
  discovery: { enabled: boolean; port: number };
  corsOrigins: string[];
  lanAddresses: string[];
  remoteAddresses: string[];
  endpoints: ServerEndpoint[];
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * True for an IPv6 literal (without brackets), in full or `::`-compressed form, with an optional
 * dotted IPv4 tail (`::ffff:192.168.1.1`). Written by hand: this module also runs in the browser,
 * where the `URL` type is not available to the compiler.
 */
export function isIPv6(value: string): boolean {
  if (!value.includes(':')) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const countGroups = (part: string): number | null => {
    if (part === '') return 0;
    const groups = part.split(':');
    let count = 0;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i] ?? '';
      if (i === groups.length - 1 && group.includes('.')) {
        const ipv4 = IPV4.exec(group);
        if (!ipv4 || !ipv4.slice(1).every((n) => Number(n) <= 255)) return null;
        count += 2;
      } else if (/^[0-9a-f]{1,4}$/i.test(group)) {
        count += 1;
      } else {
        return null;
      }
    }
    return count;
  };
  if (halves.length === 1) return countGroups(value) === 8;
  const left = countGroups(halves[0] ?? '');
  const right = countGroups(halves[1] ?? '');
  if (left === null || right === null) return false;
  return left + right < 8; // `::` stands for at least one group of zeros
}

/**
 * Normalizes an address typed by staff: IPv4, IPv6 (with or without brackets) or a host name such as
 * a Tailscale MagicDNS name. Returns null when the value is not a plain address (no scheme, path or port).
 */
export function normalizeRemoteAddress(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value || value.length > 253 || /[\s/]/.test(value)) return null;
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.includes(':')) return isIPv6(value) ? value : null;
  const ipv4 = IPV4.exec(value);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    return parts.every((n) => n >= 0 && n <= 255) ? value : null;
  }
  return HOSTNAME.test(value) ? value : null;
}

/** Base URL of the server at `address:port`. IPv6 literals are wrapped in brackets. */
export function serverBaseUrl(
  address: string,
  port: number,
  scheme: 'http' | 'https' = 'http',
): string {
  const host = address.includes(':') ? `[${address}]` : address;
  return `${scheme}://${host}:${port}`;
}

/** Every address the server can be reached on, with the API and phone URLs for each. */
export function buildServerEndpoints(input: {
  lanAddresses: string[];
  remoteAddresses: string[];
  port: number;
  scheme?: 'http' | 'https';
}): ServerEndpoint[] {
  const scheme = input.scheme ?? 'http';
  const seen = new Set<string>();
  const endpoints: ServerEndpoint[] = [];
  const add = (address: string, source: ServerAddressSource) => {
    if (seen.has(address)) return;
    seen.add(address);
    const api = serverBaseUrl(address, input.port, scheme);
    endpoints.push({ address, source, api, phone: `${api}/phone/` });
  };
  for (const address of input.lanAddresses) add(address, 'lan');
  for (const address of input.remoteAddresses) add(address, 'manual');
  return endpoints;
}
