/**
 * 0.23.0: the Windows desktop wallpaper this PC gets from the Admin (one PC, a group, or all).
 * The picture is downloaded from the server and set by the desktop app. Each picture is applied
 * once; when the Admin clears it, the wallpaper the PC had before is put back.
 */
import { isDesktopApp, restoreDesktopWallpaper, setDesktopWallpaper } from './native';

/** What was last applied: undefined = nothing yet this session, null = none. */
let applied: string | null | undefined;

function base64Of(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function applyDesktopWallpaper(url: string | null): Promise<void> {
  if (!isDesktopApp() || url === applied) return;
  try {
    if (url === null) {
      // Only a PC that had a wallpaper from the Admin gets its own one back.
      if (applied) await restoreDesktopWallpaper();
      applied = null;
      return;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    await setDesktopWallpaper(base64Of(await blob.arrayBuffer()), ext);
    applied = url;
  } catch (err) {
    // The next display message tries again; the PC keeps its current wallpaper meanwhile.
    console.warn('desktop wallpaper not applied', err);
  }
}
