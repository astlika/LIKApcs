/**
 * 0.35.0 — spoken time warnings on the PCs: the settings every PC receives, the owner's own
 * recordings (upload, replace, remove, served publicly), and what the server sends when a warning
 * is due or the time runs out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  VOICE_UPLOAD_MAX_BYTES,
  type LoginResponse,
  type RegisterDeviceResponse,
  type ServerToClientMessage,
  type SessionMutationResponse,
  type SettingsMap,
  type StationSummary,
  type VoiceCustomMap,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import { detectVoiceKind } from '../../src/services/voice.js';
import {
  authHeader,
  createTestContext,
  login,
  runSetup,
  sleep,
  type TestContext,
} from '../helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** A real recording: one of the built-in voices of the client. */
const MP3 = fs.readFileSync(path.resolve(here, '../../../likapcs-client/public/voice/sq-5.mp3'));
/** The smallest thing that is a WAV file: header, one silent sample. */
const WAV = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([38, 0, 0, 0]),
  Buffer.from('WAVEfmt '),
  Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0]),
  Buffer.from('data'),
  Buffer.from([2, 0, 0, 0, 0, 0]),
]);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

type Display = Extract<ServerToClientMessage, { type: 'server.display' }>;
type Command = Extract<ServerToClientMessage, { type: 'server.command' }>;

describe('spoken time warnings', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let pc: StationSummary;
  let uploadDir: string;
  let received: ServerToClientMessage[] = [];

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(token),
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      })
      .then((r) => ({ status: r.statusCode, body: r.json<T>() }));
  const upload = (slot: string, data: Buffer, name = 'zeri.mp3', token = owner.token) =>
    ctx.app
      .inject({
        method: 'PUT',
        url: `/api/v1/client/voice/${slot}?name=${encodeURIComponent(name)}`,
        headers: { ...authHeader(token), 'content-type': 'application/octet-stream' },
        payload: data,
      })
      .then((r) => ({
        status: r.statusCode,
        body: r.json<{
          custom: VoiceCustomMap;
          error?: { code: string; details?: { code?: string } };
        }>(),
      }));
  const displays = () => received.filter((m): m is Display => m.type === 'server.display');
  /** The push to the PCs follows a settings change a moment later. */
  const nextDisplay = async (): Promise<Display> => {
    for (let i = 0; i < 200 && displays().length === 0; i += 1) await sleep(10);
    const last = displays().at(-1);
    if (!last) throw new Error('the PC was not told');
    return last;
  };
  const commands = () => received.filter((m): m is Command => m.type === 'server.command');
  const voiceDir = () => path.join(ctx.config.uploadDir, 'voice');
  const filesOnDisk = () => (fs.existsSync(voiceDir()) ? fs.readdirSync(voiceDir()).sort() : []);

  beforeAll(async () => {
    uploadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'likapcs-voice-'));
    ctx = await createTestContext({ uploadDir });
    owner = await runSetup(ctx.app);
    const created = await call(owner.token, 'POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa Cashier',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    expect(created.status).toBe(201);
    cashier = await login(ctx.app, 'kasa', 'Cashier123');
    pc = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'Hall 1' })
    ).body;
    expect(
      (
        await call(owner.token, 'POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 600,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 1000 })).status,
    ).toBe(201);

    // A paired PC whose socket answers every command at once.
    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        machineId: 'VOICE-PC-1',
        hostname: 'PC-VOICE',
        appVersion: SERVER_VERSION,
        registrationSecret,
      },
    });
    const { registrationId } = reg.json<RegisterDeviceResponse>();
    expect(
      (await call(owner.token, 'POST', `/devices/${registrationId}/approve`, { stationId: pc.id }))
        .status,
    ).toBe(200);
    const socket = {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => {
        const message = JSON.parse(data) as ServerToClientMessage;
        received.push(message);
        if (message.type === 'server.command') {
          queueMicrotask(() =>
            ctx.app.hub.resolveAck(registrationId, message.commandId, { ok: true }),
          );
        }
      },
      close: () => undefined,
    };
    ctx.app.hub.attachDevice({
      deviceId: registrationId,
      stationId: pc.id,
      machineId: 'VOICE-PC-1',
      appVersion: SERVER_VERSION,
      ip: null,
      socket: socket as unknown as WebSocket,
      connectedAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastMetrics: null,
      lastMetricsAt: null,
      locked: null,
      seq: 0,
      pending: new Map(),
    });
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await ctx.close();
    await fs.promises.rm(uploadDir, { recursive: true, force: true });
  });

  it('is on from the start: Albanian voice, full volume, chime, no own recordings', async () => {
    const display = await ctx.app.services.looks.displayFor(
      pc.id,
      await ctx.app.services.settings.getAll(),
    );
    expect(display.voice).toEqual({
      enabled: true,
      language: 'sq',
      volume: 100,
      chime: true,
      custom: {},
    });
    // The countdown stays on the screen during a game unless the owner hides it.
    expect(display.widgetHideInGames).toBe(false);
  });

  it('tells every PC at once when the owner changes language or volume', async () => {
    received = [];
    const res = await call<SettingsMap>(owner.token, 'PATCH', '/settings', {
      'client.voice_language': 'en',
      'client.voice_volume': 60,
      'client.voice_chime': false,
    });
    expect(res.status).toBe(200);
    expect((await nextDisplay()).display.voice).toMatchObject({
      enabled: true,
      language: 'en',
      volume: 60,
      chime: false,
    });
    expect(
      (await call(owner.token, 'PATCH', '/settings', { 'client.voice_volume': 101 })).status,
    ).toBe(400);
    expect(
      (await call(owner.token, 'PATCH', '/settings', { 'client.voice_language': 'de' })).status,
    ).toBe(400);
    // A recording is named by the server only: no path, no foreign file name.
    expect(
      (
        await call(owner.token, 'PATCH', '/settings', {
          'client.voice_custom': { '5': { file: '../../secret.mp3', name: 'x' } },
        })
      ).status,
    ).toBe(400);
    await call(owner.token, 'PATCH', '/settings', {
      'client.voice_language': 'sq',
      'client.voice_volume': 100,
      'client.voice_chime': true,
    });
  });

  it('stores an own recording, serves it without a login and tells the PCs', async () => {
    received = [];
    const res = await upload('5', MP3, 'C:\\zerat\\pesë minuta.mp3');
    expect(res.status).toBe(200);
    const clip = res.body.custom['5']!;
    expect(clip.name).toBe('pesë minuta.mp3');
    expect(clip.file).toMatch(/^[0-9a-f]{24}\.mp3$/);
    expect(filesOnDisk()).toEqual([clip.file]);

    const file = await ctx.app.inject({ method: 'GET', url: `/api/v1/files/voice/${clip.file}` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('audio/mpeg');
    expect(file.headers['cache-control']).toContain('immutable');
    expect(file.rawPayload.equals(MP3)).toBe(true);

    expect((await nextDisplay()).display.voice?.custom).toEqual({
      '5': `/api/v1/files/voice/${clip.file}`,
    });
    const settings = (await call<SettingsMap>(owner.token, 'GET', '/settings')).body;
    expect(settings['client.voice_custom']).toEqual({ '5': clip });
  });

  it('replaces a recording: the old file is gone, the new one has a new address', async () => {
    const before = (await call<SettingsMap>(owner.token, 'GET', '/settings')).body[
      'client.voice_custom'
    ]['5']!;
    const res = await upload('5', WAV, 'i-ri.wav');
    expect(res.status).toBe(200);
    const clip = res.body.custom['5']!;
    expect(clip.file).toMatch(/\.wav$/);
    expect(clip.file).not.toBe(before.file);
    expect(filesOnDisk()).toEqual([clip.file]);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/v1/files/voice/${before.file}` }))
        .statusCode,
    ).toBe(404);
    const file = await ctx.app.inject({ method: 'GET', url: `/api/v1/files/voice/${clip.file}` });
    expect(file.headers['content-type']).toBe('audio/wav');

    // A second announcement keeps the first.
    const up = await upload('up', MP3, 'mbaroi.mp3');
    expect(up.status).toBe(200);
    expect(Object.keys(up.body.custom).sort()).toEqual(['5', 'up']);
    expect(filesOnDisk()).toHaveLength(2);
  });

  it('refuses what is not a recording, what is too large and an unknown announcement', async () => {
    const before = filesOnDisk();
    const picture = await upload('1', PNG, 'foto.png');
    expect(picture.status).toBe(400);
    expect(picture.body.error?.details?.code).toBe('VOICE_FORMAT');
    expect((await upload('1', Buffer.from('not audio at all'), 'x.txt')).status).toBe(400);
    expect((await upload('1', Buffer.alloc(0), 'bosh.mp3')).status).toBeGreaterThanOrEqual(400);
    const big = Buffer.concat([MP3.subarray(0, 4), Buffer.alloc(VOICE_UPLOAD_MAX_BYTES + 1024)]);
    expect((await upload('1', big, 'i-madh.mp3')).status).toBe(413);
    for (const slot of ['0', '121', 'abc', '5a']) {
      expect((await upload(slot, MP3)).status, slot).toBe(400);
    }
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/files/voice/..%2Fx.mp3' })).statusCode,
    ).toBe(404);
    expect(filesOnDisk()).toEqual(before);
  });

  it('only who manages the settings changes the recordings', async () => {
    const before = filesOnDisk();
    expect((await upload('1', MP3, 'x.mp3', cashier.token)).status).toBe(403);
    expect((await call(cashier.token, 'DELETE', '/client/voice/5')).status).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: 'PUT',
          url: '/api/v1/client/voice/1',
          headers: { 'content-type': 'application/octet-stream' },
          payload: MP3,
        })
      ).statusCode,
    ).toBe(401);
    expect(filesOnDisk()).toEqual(before);
  });

  it('removes a recording: the PC goes back to the built-in voice', async () => {
    received = [];
    const before = (await call<SettingsMap>(owner.token, 'GET', '/settings')).body[
      'client.voice_custom'
    ];
    const res = await call<{ custom: VoiceCustomMap }>(owner.token, 'DELETE', '/client/voice/5');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.custom)).toEqual(['up']);
    expect(filesOnDisk()).toEqual([before.up!.file]);
    expect((await nextDisplay()).display.voice?.custom).toEqual({
      up: `/api/v1/files/voice/${before.up!.file}`,
    });
    // Removing what is not there changes nothing.
    expect((await call(owner.token, 'DELETE', '/client/voice/5')).status).toBe(200);
  });

  it('recognises the audio formats by their bytes', () => {
    expect(detectVoiceKind(MP3.subarray(0, 16))).toBe('mp3');
    expect(detectVoiceKind(Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000'))).toBe(
      'mp3',
    );
    expect(detectVoiceKind(WAV.subarray(0, 16))).toBe('wav');
    expect(detectVoiceKind(Buffer.from('OggS\u0000\u0002'))).toBe('ogg');
    expect(
      detectVoiceKind(Buffer.from('\u0000\u0000\u0000\u0020ftypM4A \u0000\u0000', 'latin1')),
    ).toBe('m4a');
    expect(detectVoiceKind(PNG.subarray(0, 16))).toBeNull();
    expect(detectVoiceKind(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP', 'latin1'))).toBeNull();
    expect(detectVoiceKind(Buffer.alloc(0))).toBeNull();
  });

  it('sends each warning with the minutes to say, and says why the session ended', async () => {
    const t0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const plus = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: pc.id,
      billingMode: 'prepaid',
      minutes: 30,
      payments: [{ method: 'cash', amountCents: 300 }],
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);

    received = [];
    vi.setSystemTime(plus(20));
    await ctx.app.services.sessions.tick();
    expect(commands().filter((c) => c.command === 'message.show')).toHaveLength(0);

    vi.setSystemTime(plus(25));
    await ctx.app.services.sessions.tick();
    const five = commands().filter((c) => c.command === 'message.show');
    expect(five).toHaveLength(1);
    expect(five[0]!.payload).toEqual({
      text: '5 minutes remaining',
      durationSeconds: 15,
      announce: { minutes: 5 },
    });
    // The same minute is said once.
    await ctx.app.services.sessions.tick();
    expect(commands().filter((c) => c.command === 'message.show')).toHaveLength(1);

    vi.setSystemTime(plus(29));
    await ctx.app.services.sessions.tick();
    expect(
      commands()
        .filter((c) => c.command === 'message.show')
        .at(-1)!.payload,
    ).toMatchObject({
      announce: { minutes: 1 },
    });

    vi.setSystemTime(plus(30));
    await ctx.app.services.sessions.tick();
    const ended = commands().filter((c) => c.command === 'session.end');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.payload).toMatchObject({
      sessionId: started.body.session.id,
      reason: 'expired',
    });

    // Staff ending a session is not "your time is up".
    received = [];
    const second = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: pc.id,
      billingMode: 'prepaid',
      minutes: 30,
      payments: [{ method: 'cash', amountCents: 300 }],
    });
    expect(second.status).toBe(201);
    const stop = await call(owner.token, 'POST', `/sessions/${second.body.session.id}/end`, {});
    expect(stop.status).toBeLessThan(300);
    const byStaff = commands().filter((c) => c.command === 'session.end');
    expect(byStaff).toHaveLength(1);
    expect((byStaff[0]!.payload as { reason?: string }).reason).toBeUndefined();
    vi.useRealTimers();
  }, 60_000);
});
