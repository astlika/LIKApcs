/**
 * Client-side preparation of product pictures. Phone photos are several MB; the POS only needs a
 * small tile, so pictures are scaled down (longest side `maxSide`) and re-encoded before upload —
 * fast over Wi-Fi, small on disk, instant on the POS grid.
 */

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export function isSupportedImage(file: File): boolean {
  return IMAGE_MIME_TYPES.includes(file.type) || /\.(jpe?g|png|webp|gif)$/i.test(file.name);
}

export async function prepareProductImage(
  file: File,
  maxSide = 800,
): Promise<{ blob: Blob; contentType: string }> {
  // Animated GIFs would lose their animation on a canvas; small ones go up unchanged.
  if (file.type === 'image/gif' && file.size <= 1024 * 1024) {
    return { blob: file, contentType: 'image/gif' };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('unsupported_image');
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  if (scale === 1 && file.size <= 300 * 1024 && file.type !== 'image/gif') {
    bitmap.close();
    return { blob: file, contentType: file.type || 'image/jpeg' };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('unsupported_image');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.86),
  );
  if (blob && blob.type === 'image/webp') return { blob, contentType: 'image/webp' };
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('unsupported_image');
  return { blob: png, contentType: 'image/png' };
}
