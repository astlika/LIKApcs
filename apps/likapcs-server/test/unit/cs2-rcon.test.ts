import net from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';
import {
  RCON_TYPE,
  RconError,
  decodeRconPackets,
  encodeRconPacket,
  rconExec,
} from '../../src/services/cs2-rcon.js';

/**
 * A tiny Source RCON server: accepts one password, answers commands with a fixed text, and
 * (like the real server) sends an empty RESPONSE before the AUTH verdict.
 */
function fakeRconServer(password: string, answer: (cmd: string) => string) {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buf: Buffer = Buffer.alloc(0);
    let authed = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { packets, rest } = decodeRconPackets(buf);
      buf = Buffer.from(rest);
      for (const p of packets) {
        if (!authed && p.type === RCON_TYPE.AUTH) {
          socket.write(encodeRconPacket(p.id, RCON_TYPE.RESPONSE, ''));
          const ok = p.body === password;
          socket.write(encodeRconPacket(ok ? p.id : -1, RCON_TYPE.AUTH_RESPONSE, ''));
          authed = ok;
        } else if (authed && p.type === RCON_TYPE.EXEC) {
          socket.write(encodeRconPacket(p.id, RCON_TYPE.RESPONSE, answer(p.body)));
        } else if (authed && p.type === RCON_TYPE.RESPONSE) {
          // the empty marker packet: echo it back as an empty response (Source behaviour)
          socket.write(encodeRconPacket(p.id, RCON_TYPE.RESPONSE, ''));
        }
      }
    });
  });
  return new Promise<{ port: number; close: () => Promise<void>; sent: string[] }>((resolve) => {
    const sent: string[] = [];
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        sent,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

describe('RCON packets', () => {
  it('round-trips a packet and keeps partial data for later', () => {
    const full = encodeRconPacket(7, RCON_TYPE.EXEC, 'mp_warmup_end');
    const cut = full.subarray(0, full.length - 3);
    const first = decodeRconPackets(cut);
    expect(first.packets).toHaveLength(0);
    const second = decodeRconPackets(Buffer.concat([cut, full.subarray(full.length - 3)]));
    expect(second.packets).toEqual([{ id: 7, type: RCON_TYPE.EXEC, body: 'mp_warmup_end' }]);
    expect(second.rest.length).toBe(0);
  });

  it('refuses an impossible packet size', () => {
    const bad = Buffer.alloc(12);
    bad.writeInt32LE(3, 0);
    expect(() => decodeRconPackets(bad)).toThrow(/invalid RCON packet size/);
  });
});

describe('rconExec', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  it('logs in and returns the answer of the command', async () => {
    const srv = await fakeRconServer('secret', (cmd) => `ran: ${cmd}`);
    close = srv.close;
    const out = await rconExec({
      host: '127.0.0.1',
      port: srv.port,
      password: 'secret',
      command: 'mp_freezetime 3',
      timeoutMs: 2000,
    });
    expect(out).toBe('ran: mp_freezetime 3');
  });

  it('refuses a wrong password with auth_failed', async () => {
    const srv = await fakeRconServer('secret', () => 'nope');
    close = srv.close;
    const err = await rconExec({
      host: '127.0.0.1',
      port: srv.port,
      password: 'wrong',
      command: 'mp_warmup_end',
      timeoutMs: 2000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RconError);
    expect((err as RconError).code).toBe('auth_failed');
  });

  it('reports connect_failed when nothing listens', async () => {
    const probe = await fakeRconServer('x', () => '');
    const port = probe.port;
    await probe.close();
    const err = await rconExec({
      host: '127.0.0.1',
      port,
      password: 'x',
      command: 'status',
      timeoutMs: 2000,
    }).catch((e: unknown) => e);
    expect((err as RconError).code).toBe('connect_failed');
  });

  it('times out when the server never answers', async () => {
    const silent = net.createServer((socket) => socket.on('data', () => undefined));
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    const err = await rconExec({
      host: '127.0.0.1',
      port,
      password: 'x',
      command: 'status',
      timeoutMs: 300,
    }).catch((e: unknown) => e);
    silent.close();
    expect((err as RconError).code).toBe('timeout');
  });
});
