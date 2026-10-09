import dgram from 'node:dgram';
import os from 'node:os';
import { PROTOCOL_VERSION } from '@likapcs/shared';
import { DEFAULT_DISCOVERY_PORT } from './embedded/paths.js';
import { SERVER_VERSION } from './version.js';

/**
 * LAN discovery responder. Client PCs and secondary Admin PCs broadcast a tiny UDP datagram and the
 * server answers with where its HTTP/WebSocket API lives. The reply carries no secrets — pairing
 * still requires administrator approval in the Admin app.
 *
 * Request : "LIKAPCS_DISCOVER_V1"            (UDP → port 4701, broadcast or unicast)
 * Response: JSON {service, protocolVersion, version, installationId, name, port, urls[]}
 */
export const DISCOVERY_REQUEST = 'LIKAPCS_DISCOVER_V1';

export interface DiscoveryInfo {
  installationId: string;
  httpPort: number;
  /** Resolves the business name lazily so renames are reflected without restart. */
  getName: () => Promise<string>;
}

export interface DiscoveryResponse {
  service: 'likapcs';
  protocolVersion: number;
  version: string;
  installationId: string;
  name: string;
  port: number;
  urls: string[];
  ts: string;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

export class DiscoveryResponder {
  private socket: dgram.Socket | null = null;

  constructor(
    private readonly info: DiscoveryInfo,
    private readonly port = DEFAULT_DISCOVERY_PORT,
    private readonly log: {
      info: (o: object, m: string) => void;
      warn: (o: object, m: string) => void;
    } = {
      info: () => undefined,
      warn: () => undefined,
    },
  ) {}

  async start(): Promise<void> {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('message', (message, rinfo) => {
      if (!message.toString('utf8').startsWith(DISCOVERY_REQUEST)) return;
      void this.reply(socket, rinfo);
    });
    socket.on('error', (err) => this.log.warn({ err }, 'discovery socket error'));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.port, '0.0.0.0', () => {
        socket.off('error', reject);
        try {
          socket.setBroadcast(true);
        } catch {
          /* not needed for replies */
        }
        resolve();
      });
    });
    this.log.info({ port: this.port }, 'LAN discovery responder listening');
  }

  async buildResponse(): Promise<DiscoveryResponse> {
    const port = this.info.httpPort;
    return {
      service: 'likapcs',
      protocolVersion: PROTOCOL_VERSION,
      version: SERVER_VERSION,
      installationId: this.info.installationId,
      name: await this.info.getName().catch(() => 'LIKApcs'),
      port,
      urls: lanAddresses().map((ip) => `http://${ip}:${port}`),
      ts: new Date().toISOString(),
    };
  }

  private async reply(socket: dgram.Socket, rinfo: dgram.RemoteInfo): Promise<void> {
    try {
      const payload = Buffer.from(JSON.stringify(await this.buildResponse()));
      socket.send(payload, rinfo.port, rinfo.address);
    } catch (err) {
      this.log.warn({ err }, 'discovery reply failed');
    }
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
}

/** One-shot discovery from the requesting side (used by tests and the CLI). */
export function discoverServers(
  timeoutMs = 2000,
  port = DEFAULT_DISCOVERY_PORT,
  targets = ['255.255.255.255', '127.0.0.1'],
): Promise<DiscoveryResponse[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4' });
    const found = new Map<string, DiscoveryResponse>();
    const finish = () => {
      clearTimeout(timer);
      socket.close();
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('message', (message) => {
      try {
        const parsed = JSON.parse(message.toString('utf8')) as DiscoveryResponse;
        if (parsed.service === 'likapcs') found.set(parsed.installationId, parsed);
      } catch {
        /* ignore garbage */
      }
    });
    socket.on('error', finish);
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* ignore */
      }
      const payload = Buffer.from(DISCOVERY_REQUEST);
      for (const target of targets) socket.send(payload, port, target, () => undefined);
    });
  });
}
