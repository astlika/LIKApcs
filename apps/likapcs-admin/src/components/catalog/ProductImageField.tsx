import { useEffect, useRef, useState } from 'react';
import { ImageIcon, Link2, Trash2, Upload } from 'lucide-react';
import { useI18n } from '../../i18n';
import { fileUrl } from '../../lib/api';
import { isSupportedImage, prepareProductImage } from '../../lib/images';
import { Button, Input } from '../ui/primitives';

/** What the dialog should do with the picture when the product is saved. */
export type PendingImage =
  | { kind: 'upload'; blob: Blob; contentType: string; previewUrl: string }
  | { kind: 'link'; url: string }
  | { kind: 'remove' }
  | null;

/**
 * Picture section of the product dialog. Picking a file or a link never talks to the server by
 * itself — the dialog applies the change together with the save (so a new product gets its
 * picture right after it exists, and Cancel really cancels).
 */
export function ProductImageField({
  currentUrl,
  pending,
  onChange,
  disabled,
}: {
  currentUrl: string | null;
  pending: PendingImage;
  onChange: (next: PendingImage) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(pending?.kind === 'link');
  const [link, setLink] = useState(pending?.kind === 'link' ? pending.url : '');
  const [error, setError] = useState<string | null>(null);

  // Release object URLs of previews we no longer show.
  const lastPreview = useRef<string | null>(null);
  useEffect(() => {
    const url = pending?.kind === 'upload' ? pending.previewUrl : null;
    if (lastPreview.current && lastPreview.current !== url)
      URL.revokeObjectURL(lastPreview.current);
    lastPreview.current = url;
  }, [pending]);
  useEffect(
    () => () => {
      if (lastPreview.current) URL.revokeObjectURL(lastPreview.current);
    },
    [],
  );

  const preview =
    pending?.kind === 'upload'
      ? pending.previewUrl
      : pending?.kind === 'remove'
        ? null
        : pending?.kind === 'link'
          ? pending.url
          : fileUrl(currentUrl);

  const pickFile = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!isSupportedImage(file)) {
      setError(t('products.imageInvalid'));
      return;
    }
    try {
      const prepared = await prepareProductImage(file);
      onChange({
        kind: 'upload',
        blob: prepared.blob,
        contentType: prepared.contentType,
        previewUrl: URL.createObjectURL(prepared.blob),
      });
      setLinkOpen(false);
    } catch {
      setError(t('products.imageInvalid'));
    }
  };

  return (
    <div className="product-image">
      <div className="product-image__preview" aria-hidden={!preview}>
        {preview ? (
          <img src={preview} alt="" onError={() => setError(t('products.imageInvalid'))} />
        ) : (
          <ImageIcon size={28} className="faint" />
        )}
      </div>
      <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            data-testid="product-image-file"
            onChange={(e) => {
              void pickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button size="sm" disabled={disabled} onClick={() => fileInput.current?.click()}>
            <Upload size={14} /> {t('products.imageUpload')}
          </Button>
          <Button size="sm" disabled={disabled} onClick={() => setLinkOpen((v) => !v)}>
            <Link2 size={14} /> {t('products.imageFromLink')}
          </Button>
          {(preview || currentUrl) && pending?.kind !== 'remove' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setLinkOpen(false);
                setLink('');
                onChange(currentUrl ? { kind: 'remove' } : null);
              }}
            >
              <Trash2 size={14} /> {t('products.imageRemove')}
            </Button>
          )}
        </div>
        {linkOpen && (
          <div className="row" style={{ gap: 8 }}>
            <Input
              value={link}
              placeholder={t('products.imageLinkPlaceholder')}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (/^https?:\/\//i.test(link.trim()))
                    onChange({ kind: 'link', url: link.trim() });
                }
              }}
              data-testid="product-image-link"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!/^https?:\/\//i.test(link.trim())}
              onClick={() => onChange({ kind: 'link', url: link.trim() })}
            >
              {t('products.imageLinkApply')}
            </Button>
          </div>
        )}
        <div className="faint" style={{ fontSize: 12 }}>
          {pending && pending.kind !== 'remove'
            ? t('products.imagePendingHint')
            : t('products.imageHint')}
        </div>
        {error && (
          <div className="text-danger" style={{ fontSize: 12 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

/** Small rounded thumbnail used in lists; falls back to a neutral placeholder. */
export function ProductThumb({
  url,
  size = 36,
  name,
}: {
  url: string | null;
  size?: number;
  name?: string;
}) {
  const src = fileUrl(url);
  return (
    <span
      className="product-thumb"
      style={{ width: size, height: size }}
      role={src ? 'img' : undefined}
      aria-label={src ? name : undefined}
    >
      {src ? <img src={src} alt="" loading="lazy" /> : <ImageIcon size={Math.round(size * 0.45)} />}
    </span>
  );
}
