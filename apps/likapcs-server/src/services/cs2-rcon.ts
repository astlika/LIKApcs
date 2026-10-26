import net from 'node:net';

/**
 * Source RCON (the protocol CS2 uses with `-usercon`). Only what the match panel needs: log in
 * with the RCON password, run one command, read its text answer, close. Every call has its own
 * short-lived TCP connection, so a dead server never leaves a socket behind.
 *
 * Packet layout (little endian): size(int32) id(int32) type(int32) body\0 \0
 * where `size` counts everything after itself.
 */

export const RCON_TYPE = { RESPONSE: 0, EXEC: 2, AUTH: 3, AUTH_RESPONSE: 2 } as const;
const AUTH_FAILED_ID = -1;

export interface RconPacket {
  id: number;
  type: number;
  body: string;
}

export function encodeRconPacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const size = 4 + 4 + payload.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  // two trailing NUL bytes are already zero
  return buf;
}

/**
 * Splits complete packets off the front of `buffer`. Returns the parsed packets and the bytes
 * that still wait for more data. Throws on an impossible size (protects against garbage).
 */
export function decodeRconPackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10 || size > 4096 + 10) throw new Error('invalid RCON packet size');
    if (buffer.length - offset - 4 < size) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const bodyEnd = offset + 4 + size - 2;
    const body = buffer.toString('utf8', offset + 12, bodyEnd);
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  command: string;
  timeoutMs?: number;
}

export class RconError extends Error {
  constructor(
    readonly code: 'timeout' | 'auth_failed' | 'connect_failed' | 'protocol',
    message: string,
  ) {
    super(message);
  }
}

/** Runs one RCON command and resolves with the server's text answer (may be empty). */
export function rconExec(opts: RconOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: opts.host, port: opts.port });
    let buffer: Buffer = Buffer.alloc(0);
    let authed = false;
    let settled = false;
    let answer = '';
    const AUTH_ID = 1;
    const EXEC_ID = 2;
    const finish = (err: RconError | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? '');
    };
    const timer = setTimeout(
      () => finish(new RconError('timeout', `RCON did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );

    socket.on('connect', () => {
      socket.write(encodeRconPacket(AUTH_ID, RCON_TYPE.AUTH, opts.password));
    });
    socket.on('error', () =>
      finish(new RconError('connect_failed', `cannot reach RCON at ${opts.host}:${opts.port}`)),
    );
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let decoded: { packets: RconPacket[]; rest: Buffer };
      try {
        decoded = decodeRconPackets(buffer);
      } catch {
        finish(new RconError('protocol', 'unexpected RCON answer'));
        return;
      }
      buffer = Buffer.from(decoded.rest);
      for (const packet of decoded.packets) {
        if (!authed) {
          // The server first echoes an empty RESPONSE, then answers AUTH with the verdict.
          if (packet.type !== RCON_TYPE.AUTH_RESPONSE) continue;
          if (packet.id === AUTH_FAILED_ID) {
            finish(new RconError('auth_failed', 'RCON password was refused'));
            return;
          }
          authed = true;
          socket.write(encodeRconPacket(EXEC_ID, RCON_TYPE.EXEC, opts.command));
          // A marker packet tells us the whole answer has arrived (RCON has no end-of-answer).
          socket.write(encodeRconPacket(EXEC_ID + 1, RCON_TYPE.RESPONSE, ''));
          continue;
        }
        if (packet.id === EXEC_ID && packet.type === RCON_TYPE.RESPONSE) {
          // The answer may come in several packets; keep collecting until the marker returns.
          answer += packet.body;
        }
        if (packet.id === EXEC_ID + 1) {
          finish(null, answer);
          return;
        }
      }
    });
  });
}
