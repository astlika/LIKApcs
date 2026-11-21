import type { QueryClient } from '@tanstack/react-query';
import { PRODUCT_THUMB_SIDE, type ProductThumbMissing } from '@likapcs/shared';
import { api, apiUpload, fileUrl } from './api';

/**
 * 0.37.0 — small copies of the product pictures.
 *
 * A product picture is up to 800 px on its longest side (larger when it came from a link), and
 * the till shows it 48 px wide. The browser has to decode the whole picture to draw that tile:
 * with a hundred products it is most of what opening the till costs on a slow PC. So every
 * picture gets a copy `PRODUCT_THUMB_SIDE` px on its longest side, and the tiles and lists show
 * that one. The server has no picture library, so the Admin makes the copies: for a new picture
 * right after it is saved, and for the pictures that were already there in the background, one
 * at a time while the PC is idle.
 */

/** The small copy of a picture; null when the browser cannot read the picture. */
export async function makeThumb(source: Blob): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    return null;
  }
  const scale = Math.min(1, PRODUCT_THUMB_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const encode = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  const webp = await encode('image/webp', 0.82);
  if (webp && webp.type === 'image/webp') return webp;
  // A browser without WebP encoding: PNG keeps a transparent background.
  return encode('image/png');
}

/** Waits until the page has nothing more urgent to do (at most 2 s). */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 2000 });
    } else {
      window.setTimeout(resolve, 200);
    }
  });
}

/** Pictures that could not be read in this session: not tried again until the next start. */
const unreadable = new Set<string>();
let running: Promise<number> | null = null;

async function run(queryClient: QueryClient): Promise<number> {
  const { items } = await api<{ items: ProductThumbMissing[] }>('/catalog/product-thumbs/missing');
  let made = 0;
  for (const item of items) {
    if (unreadable.has(item.image)) continue;
    await idle();
    try {
      const url = fileUrl(item.imageUrl);
      if (!url) continue;
      const response = await fetch(url);
      if (!response.ok) {
        unreadable.add(item.image);
        continue;
      }
      const thumb = await makeThumb(await response.blob());
      if (!thumb) {
        unreadable.add(item.image);
        continue;
      }
      await apiUpload(
        `/products/${item.id}/image/thumb`,
        thumb,
        { of: item.image },
        { method: 'PUT', contentType: thumb.type },
      );
      made += 1;
    } catch {
      // The picture was changed meanwhile, or the server is away: the next run takes it.
    }
  }
  if (made > 0) {
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    void queryClient.invalidateQueries({ queryKey: ['offers'] });
  }
  return made;
}

/**
 * Makes the small copies that are missing. Safe to call at any time and from several places: a
 * run that is already going is shared. Only for users who may manage products (the server
 * refuses everyone else). Resolves with how many copies were made; never rejects.
 */
export function backfillThumbs(queryClient: QueryClient): Promise<number> {
  running ??= run(queryClient)
    .catch(() => 0)
    .finally(() => {
      running = null;
    });
  return running;
}
