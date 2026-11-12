/**
 * 0.23.0: the desktop wallpaper is downloaded once per picture, set through the desktop app, and
 * put back when the Admin clears it. Outside the desktop app nothing happens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  isDesktopApp: vi.fn(() => true),
  setDesktopWallpaper: vi.fn(async () => undefined),
  restoreDesktopWallpaper: vi.fn(async () => undefined),
}));
vi.mock('./native', () => native);

describe('applyDesktopWallpaper', () => {
  let applyDesktopWallpaper: (url: string | null) => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    native.setDesktopWallpaper.mockClear();
    native.restoreDesktopWallpaper.mockClear();
    native.isDesktopApp.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })),
      ),
    );
    ({ applyDesktopWallpaper } = await import('./desktop-wallpaper'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads a picture once, sets it as base64 with its type, and skips the same URL', async () => {
    await applyDesktopWallpaper('http://pc.local/api/v1/files/wallpapers/a.png');
    await applyDesktopWallpaper('http://pc.local/api/v1/files/wallpapers/a.png');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(native.setDesktopWallpaper).toHaveBeenCalledTimes(1);
    expect(native.setDesktopWallpaper).toHaveBeenCalledWith('iVBORw==', 'png');
  });

  it('puts the PC wallpaper back only when the Admin had set one', async () => {
    await applyDesktopWallpaper(null);
    expect(native.restoreDesktopWallpaper).not.toHaveBeenCalled();

    await applyDesktopWallpaper('http://pc.local/api/v1/files/wallpapers/a.png');
    await applyDesktopWallpaper(null);
    expect(native.restoreDesktopWallpaper).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside the desktop app', async () => {
    native.isDesktopApp.mockReturnValue(false);
    await applyDesktopWallpaper('http://pc.local/api/v1/files/wallpapers/a.png');
    expect(native.setDesktopWallpaper).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
