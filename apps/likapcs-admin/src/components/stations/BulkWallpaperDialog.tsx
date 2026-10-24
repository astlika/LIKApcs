/**
 * 0.23.0: one picture for several PCs, or for all of them: the lock-screen wallpaper of the app, or
 * the Windows desktop background. The server stores a copy per PC; a desktop wallpaper is applied
 * by each PC when it is online (at once if it is connected now, else on its next connection).
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon } from 'lucide-react';
import type { BulkWallpaperResult, StationSummary, WallpaperKind } from '@likapcs/shared';
import { ApiError, apiUpload } from '../../lib/api';
import { prepareProductImage } from '../../lib/images';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Button, Dialog, Kbd } from '../ui/primitives';

type Scope = 'selected' | 'all';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

export function BulkWallpaperDialog({
  stations,
  onClose,
  onDone,
}: {
  /** The selected PCs (the "selected" scope); "all" means every PC not archived. */
  stations: StationSummary[];
  onClose: () => void;
  onDone: (result: BulkWallpaperResult) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<WallpaperKind>('lock');
  const [scope, setScope] = useState<Scope>('selected');
  const [file, setFile] = useState<File | null>(null);

  const send = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no picture');
      // The desktop background is JPEG (Windows takes JPEG or PNG); the lock screen keeps WebP.
      const prepared = await prepareProductImage(file, 1920, kind === 'desktop' ? 'jpeg' : 'webp');
      return apiUpload<BulkWallpaperResult>(
        '/stations/wallpapers',
        prepared.blob,
        {
          kind,
          stations: scope === 'all' ? 'all' : stations.map((s) => s.id).join(','),
        },
        { method: 'PUT', contentType: prepared.contentType },
      );
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      onDone(result);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });

  const targetCount = scope === 'selected' ? stations.length : null;
  const ready = !!file && (scope === 'all' || stations.length > 0) && !send.isPending;

  const toggle = (active: boolean) => ({
    size: 'sm' as const,
    variant: active ? ('primary' as const) : ('default' as const),
    'aria-pressed': active,
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('map.wallpaperTitle', { n: targetCount ?? t('map.wallpaperScopeAll') })}
      description={t('map.wallpaperBody')}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            loading={send.isPending}
            disabled={!ready}
            onClick={() => send.mutate()}
            data-testid="bulk-wallpaper-confirm"
          >
            <ImageIcon size={14} /> {t('map.wallpaperConfirm')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div
          role="group"
          aria-label={t('map.wallpaperKindLock')}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          <Button
            {...toggle(kind === 'lock')}
            onClick={() => setKind('lock')}
            data-testid="bulk-wallpaper-kind-lock"
          >
            {t('map.wallpaperKindLock')}
          </Button>
          <Button
            {...toggle(kind === 'desktop')}
            onClick={() => setKind('desktop')}
            data-testid="bulk-wallpaper-kind-desktop"
          >
            {t('map.wallpaperKindDesktop')}
          </Button>
        </div>
        <div
          role="group"
          aria-label={t('map.wallpaperScopeSelected', { n: stations.length })}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          <Button
            {...toggle(scope === 'selected')}
            onClick={() => setScope('selected')}
            disabled={stations.length === 0}
            data-testid="bulk-wallpaper-scope-selected"
          >
            {t('map.wallpaperScopeSelected', { n: stations.length })}
          </Button>
          <Button
            {...toggle(scope === 'all')}
            onClick={() => setScope('all')}
            data-testid="bulk-wallpaper-scope-all"
          >
            {t('map.wallpaperScopeAll')}
          </Button>
        </div>
        <label className="btn btn--sm" style={{ alignSelf: 'flex-start' }}>
          {file ? file.name : t('map.wallpaperPick')}
          <input
            type="file"
            accept={ACCEPT}
            hidden
            data-testid="bulk-wallpaper-input"
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              e.target.value = '';
              setFile(picked);
            }}
          />
        </label>
        {!file && (
          <p className="muted" style={{ margin: 0 }}>
            {t('map.wallpaperNeedsPicture')}
          </p>
        )}
      </div>
    </Dialog>
  );
}
