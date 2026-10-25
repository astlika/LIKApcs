/**
 * 0.20.0 — looks: each PC's own customer-screen overrides (widget size/position/style/theme, ads
 * on or off), its own lock-screen wallpaper, and the named layout presets. A PC always receives
 * the house settings with its own overrides applied, and changes reach only the PCs they touch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { LoginResponse, ServerToClientMessage, StationSummary } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, sleep, type TestContext } from '../helpers.js';

/** A 1×1 PNG: real bytes, so the upload's format sniffing accepts it. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('per-PC looks, wallpapers and layout presets', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let pc1: StationSummary;
  let pc2: StationSummary;
  /** Messages each fake PC received over its socket. */
  const sentTo = new Map<string, ServerToClientMessage[]>();

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
  ) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(owner.token),
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 ? null : r.json()) as T,
      }));

  /** Puts a fake PC on the hub: the realtime server would do this after the handshake. */
  const attachFakePc = (stationId: string): ServerToClientMessage[] => {
    const deviceId = randomUUID();
    const received: ServerToClientMessage[] = [];
    sentTo.set(deviceId, received);
    const socket = {
      readyState: 1,
      OPEN: 1,
      send: (data: string) => received.push(JSON.parse(data) as ServerToClientMessage),
      close: () => undefined,
    };
    ctx.app.hub.attachDevice({
      deviceId,
      stationId,
      machineId: `MACHINE-${deviceId}`,
      appVersion: '0.20.0',
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
    return received;
  };

  const displays = (received: ServerToClientMessage[]) =>
    received.filter(
      (m): m is Extract<ServerToClientMessage, { type: 'server.display' }> =>
        m.type === 'server.display',
    );

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    pc1 = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Hall 1' })).body;
    pc2 = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Hall 2' })).body;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('a PC without overrides gets the house look, with the default widget theme', async () => {
    const display = await ctx.app.services.looks.displayFor(
      pc1.id,
      await ctx.app.services.settings.getAll(),
    );
    expect(display.widgetTheme).toBe('indigo');
    expect(display.wallpaperUrl).toBeNull();
    expect(display.widgetStyle).toBe('detailed');
  });

  it('saves a PC look, shows it on the station and drops null overrides', async () => {
    const saved = await call<StationSummary>('PATCH', `/stations/${pc1.id}/look`, {
      widgetTheme: 'emerald',
      adsEnabled: false,
      widgetSize: null,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.look).toEqual({ widgetTheme: 'emerald', adsEnabled: false });
    const fetched = await call<StationSummary>('GET', `/stations/${pc1.id}`);
    expect(fetched.body.look).toEqual({ widgetTheme: 'emerald', adsEnabled: false });
  });

  it('rejects invalid looks: unknown keys, unknown values, wrong types', async () => {
    expect((await call('PATCH', `/stations/${pc1.id}/look`, { widgetTheme: 'neon' })).status).toBe(
      400,
    );
    expect((await call('PATCH', `/stations/${pc1.id}/look`, { widgetColour: 'red' })).status).toBe(
      400,
    );
    expect((await call('PATCH', `/stations/${pc1.id}/look`, { adsEnabled: 'no' })).status).toBe(
      400,
    );
    expect((await call('PATCH', `/stations/${pc1.id}/look`, { widgetSize: 'huge' })).status).toBe(
      400,
    );
    // Nothing changed.
    const fetched = await call<StationSummary>('GET', `/stations/${pc1.id}`);
    expect(fetched.body.look).toEqual({ widgetTheme: 'emerald', adsEnabled: false });
  });

  it('the PC receives its own display: overrides win, the rest follows the house', async () => {
    const all = await ctx.app.services.settings.getAll();
    const display = await ctx.app.services.looks.displayFor(pc1.id, all);
    expect(display.widgetTheme).toBe('emerald');
    expect(display.ads.enabled).toBe(false);
    // A PC with no override keeps the house values.
    const other = await ctx.app.services.looks.displayFor(pc2.id, all);
    expect(other.widgetTheme).toBe('indigo');
    expect(other.ads.enabled).toBe(all['client.ads_enabled']);
  });

  it('a house theme change reaches only the PCs without their own theme', async () => {
    const received1 = attachFakePc(pc1.id);
    const received2 = attachFakePc(pc2.id);
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: authHeader(owner.token),
      payload: { 'client.widget_theme': 'rose' },
    });
    expect(patched.statusCode).toBe(200);
    await sleep(100);
    const toPc1 = displays(received1);
    const toPc2 = displays(received2);
    expect(toPc1.at(-1)?.display.widgetTheme).toBe('emerald');
    expect(toPc2.at(-1)?.display.widgetTheme).toBe('rose');
  });

  it('a look change is pushed to that PC only', async () => {
    const received1 = attachFakePc(pc1.id); // fresh captures for this step
    const received2 = attachFakePc(pc2.id);
    const before1 = displays(received1).length;
    const before2 = displays(received2).length;
    const saved = await call<StationSummary>('PATCH', `/stations/${pc2.id}/look`, {
      widgetStyle: 'pill',
    });
    expect(saved.status).toBe(200);
    await sleep(50);
    expect(displays(received2).length).toBe(before2 + 1);
    expect(displays(received2).at(-1)?.display.widgetStyle).toBe('pill');
    expect(displays(received1).length).toBe(before1);
  });

  it('uploads a wallpaper, serves it publicly and replaces the old file', async () => {
    const wallpaperDir = ctx.app.services.looks.wallpapers.directory;
    const upload = (body: Buffer) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/stations/${pc2.id}/wallpaper`,
        headers: { ...authHeader(owner.token), 'content-type': 'image/png' },
        payload: body,
      });

    const first = await upload(PNG_1X1);
    expect(first.statusCode).toBe(200);
    const url1 = first.json<StationSummary>().wallpaperUrl!;
    expect(url1).toMatch(/^\/api\/v1\/files\/wallpapers\/[a-z0-9]{24}\.png$/);
    const name1 = path.basename(url1);
    expect(fs.existsSync(path.join(wallpaperDir, name1))).toBe(true);

    // Public and cacheable: the PC fetches it with a plain request.
    const file = await ctx.app.inject({ method: 'GET', url: url1 });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.equals(PNG_1X1)).toBe(true);

    // The PC's display carries the wallpaper, and the same wallpaper is pushed to it.
    const display = await ctx.app.services.looks.displayFor(
      pc2.id,
      await ctx.app.services.settings.getAll(),
    );
    expect(display.wallpaperUrl).toBe(url1);

    // A second upload replaces the first file.
    const second = await upload(PNG_1X1);
    expect(second.statusCode).toBe(200);
    const name2 = path.basename(second.json<StationSummary>().wallpaperUrl!);
    expect(name2).not.toBe(name1);
    expect(fs.existsSync(path.join(wallpaperDir, name1))).toBe(false);
    expect(fs.existsSync(path.join(wallpaperDir, name2))).toBe(true);
  });

  it('refuses anything that is not a picture, and names that are not ours', async () => {
    const wallpaperBefore = (await call<StationSummary>('GET', `/stations/${pc2.id}`)).body
      .wallpaperUrl;
    const junk = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/stations/${pc2.id}/wallpaper`,
      headers: { ...authHeader(owner.token), 'content-type': 'image/png' },
      payload: Buffer.from('definitely not a picture'),
    });
    expect(junk.statusCode).toBe(400);

    const wrongType = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/stations/${pc2.id}/wallpaper`,
      headers: { ...authHeader(owner.token), 'content-type': 'text/plain' },
      payload: PNG_1X1,
    });
    // Refused before anything is written (415 from the parser; a 400 when the body is not a picture).
    expect([400, 415]).toContain(wrongType.statusCode);
    expect((await call<StationSummary>('GET', `/stations/${pc2.id}`)).body.wallpaperUrl).toBe(
      wallpaperBefore,
    );

    const unknownStation = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/stations/${randomUUID()}/wallpaper`,
      headers: { ...authHeader(owner.token), 'content-type': 'image/png' },
      payload: PNG_1X1,
    });
    expect(unknownStation.statusCode).toBe(404);

    const notOurs = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/files/wallpapers/..%2Fsecret.png',
    });
    expect(notOurs.statusCode).toBe(404);
  });

  it('removes the wallpaper: the PC goes back to the plain background', async () => {
    const before = (await call<StationSummary>('GET', `/stations/${pc2.id}`)).body;
    expect(before.wallpaperUrl).not.toBeNull();
    const wallpaperDir = ctx.app.services.looks.wallpapers.directory;
    const name = path.basename(before.wallpaperUrl!);

    const cleared = await call<StationSummary>('DELETE', `/stations/${pc2.id}/wallpaper`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.wallpaperUrl).toBeNull();
    expect(fs.existsSync(path.join(wallpaperDir, name))).toBe(false);
    const display = await ctx.app.services.looks.displayFor(
      pc2.id,
      await ctx.app.services.settings.getAll(),
    );
    expect(display.wallpaperUrl).toBeNull();
  });

  it('keeps layout presets: create, list, rename, reject, delete', async () => {
    const created = await call<{ id: string; name: string; settings: Record<string, unknown> }>(
      'POST',
      '/client/layout-presets',
      {
        name: 'Minimal sky',
        settings: { 'client.widget_style': 'minimal', 'client.widget_theme': 'sky' },
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.settings).toEqual({
      'client.widget_style': 'minimal',
      'client.widget_theme': 'sky',
    });

    // Names are unique (case-insensitive is not required; exact duplicates are refused).
    const dup = await call('POST', '/client/layout-presets', {
      name: 'Minimal sky',
      settings: { 'client.widget_style': 'dot' },
    });
    expect(dup.status).toBe(409);

    // Only layout keys, each with a valid value, and at least one of them.
    expect(
      (
        await call('POST', '/client/layout-presets', {
          name: 'Bad key',
          settings: { 'business.name': 'Hacked' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/client/layout-presets', {
          name: 'Bad value',
          settings: { 'client.widget_theme': 'neon' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('POST', '/client/layout-presets', { name: 'Empty', settings: {} })).status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/client/layout-presets', {
          name: '   ',
          settings: { 'client.widget_style': 'dot' },
        })
      ).status,
    ).toBe(400);

    const listed = await call<Array<{ name: string }>>('GET', '/client/layout-presets');
    expect(listed.body.map((p) => p.name)).toEqual(['Minimal sky']);

    const renamed = await call<{ name: string }>(
      'PATCH',
      `/client/layout-presets/${created.body.id}`,
      {
        name: 'Sky (minimal)',
        settings: { 'client.widget_theme': 'sky' },
      },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Sky (minimal)');

    expect((await call('DELETE', `/client/layout-presets/${created.body.id}`)).status).toBe(204);
    expect((await call('DELETE', `/client/layout-presets/${created.body.id}`)).status).toBe(404);
  });

  it('applying a preset is a normal settings change, pushed to every PC', async () => {
    const preset = await call<{ id: string; settings: Record<string, unknown> }>(
      'POST',
      '/client/layout-presets',
      {
        name: 'Amber',
        settings: { 'client.widget_theme': 'amber', 'client.widget_size': 'small' },
      },
    );
    expect(preset.status).toBe(201);
    const received2 = attachFakePc(pc2.id);
    const applied = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: authHeader(owner.token),
      payload: preset.body.settings,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<Record<string, unknown>>()['client.widget_size']).toBe('small');
    await sleep(100);
    const last = displays(received2).at(-1)?.display;
    expect(last?.widgetSize).toBe('small');
    // pc2 has its own look (widgetStyle 'pill'), so the house theme shows through.
    expect(last?.widgetTheme).toBe('amber');
  });
});
