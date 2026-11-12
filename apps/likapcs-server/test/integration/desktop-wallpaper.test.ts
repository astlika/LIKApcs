/**
 * 0.23.0: the Windows desktop wallpaper of a PC, and one picture for several PCs or all of them
 * (lock screen or desktop). Desktop pictures must be JPEG or PNG. Each PC keeps its own copy, and
 * the lock-screen wallpaper is not changed by a desktop upload.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BulkWallpaperResult, LoginResponse, StationSummary } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

/** A 1×1 PNG: real bytes, so the upload's format sniffing accepts it. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('desktop wallpaper and bulk wallpapers', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  const ids: string[] = [];
  const H = () => authHeader(owner.token);

  const send = (method: 'PUT' | 'DELETE', url: string, body?: Buffer, contentType = 'image/png') =>
    ctx.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { ...H(), ...(body ? { 'content-type': contentType } : {}) },
      payload: body,
    });
  const station = async (id: string) =>
    (
      await ctx.app.inject({ method: 'GET', url: `/api/v1/stations/${id}`, headers: H() })
    ).json<StationSummary>();

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    for (let n = 1; n <= 3; n += 1) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/stations',
        headers: H(),
        payload: { number: n, name: `Arena ${n}` },
      });
      ids.push(res.json<StationSummary>().id);
    }
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('sets the desktop wallpaper of one PC, not its lock-screen wallpaper', async () => {
    const res = await send('PUT', `/stations/${ids[0]}/desktop-wallpaper`, PNG_1X1);
    expect(res.statusCode).toBe(200);
    const body = res.json<StationSummary>();
    expect(body.desktopWallpaperUrl).toMatch(/^\/api\/v1\/files\/wallpapers\/[a-z0-9]{24}\.png$/);
    expect(body.wallpaperUrl).toBeNull();

    // The PC's display carries it, so the desktop app can apply it.
    const all = await ctx.app.services.settings.getAll();
    const display = await ctx.app.services.looks.displayFor(ids[0]!, all);
    expect(display.desktopWallpaperUrl).toBe(body.desktopWallpaperUrl);
  });

  it('refuses a desktop picture that is not JPEG or PNG', async () => {
    const res = await send('PUT', `/stations/${ids[0]}/desktop-wallpaper`, PNG_1X1, 'image/webp');
    expect(res.statusCode).toBe(415);
  });

  it('a bulk lock-screen wallpaper goes to all PCs, each with its own copy', async () => {
    const res = await send('PUT', '/stations/wallpapers?kind=lock&stations=all', PNG_1X1);
    expect(res.statusCode).toBe(200);
    expect(res.json<BulkWallpaperResult>()).toMatchObject({ kind: 'lock', updated: 3 });
    const urls = await Promise.all(ids.map(async (id) => (await station(id)).wallpaperUrl));
    expect(new Set(urls).size).toBe(3);
    for (const url of urls) expect(url).toMatch(/\/api\/v1\/files\/wallpapers\//);
  });

  it('a bulk desktop wallpaper goes only to the listed PCs', async () => {
    const res = await send(
      'PUT',
      `/stations/wallpapers?kind=desktop&stations=${ids[1]},${ids[2]}`,
      PNG_1X1,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<BulkWallpaperResult>()).toMatchObject({ kind: 'desktop', updated: 2 });
    expect((await station(ids[1]!)).desktopWallpaperUrl).toBeTruthy();
    expect((await station(ids[2]!)).desktopWallpaperUrl).toBeTruthy();
    // PC 1 keeps the desktop wallpaper it got before.
    expect((await station(ids[0]!)).desktopWallpaperUrl).toBeTruthy();
  });

  it('refuses a bulk desktop picture that is not JPEG or PNG, and unknown PCs', async () => {
    const webp = await send(
      'PUT',
      '/stations/wallpapers?kind=desktop&stations=all',
      PNG_1X1,
      'image/webp',
    );
    expect(webp.statusCode).toBe(415);
    const unknown = await send(
      'PUT',
      '/stations/wallpapers?kind=lock&stations=00000000-0000-4000-8000-000000000000',
      PNG_1X1,
    );
    expect(unknown.statusCode).toBe(404);
  });

  it('clears the desktop wallpaper of one PC', async () => {
    const res = await send('DELETE', `/stations/${ids[0]}/desktop-wallpaper`);
    expect(res.statusCode).toBe(200);
    expect(res.json<StationSummary>().desktopWallpaperUrl).toBeNull();
  });
});
