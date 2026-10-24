/**
 * 0.20.0: one PC's own look (widget size, position, design, colour, ads on/off) and its
 * lock-screen wallpaper. Everything left on "House setting" follows Settings › Client screen.
 */
import type { WallpaperKind } from '@likapcs/shared';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CLIENT_WIDGET_POSITIONS,
  CLIENT_WIDGET_SIZES,
  CLIENT_WIDGET_STYLES,
  CLIENT_WIDGET_THEMES,
  PERMISSIONS,
  compactLook,
  type StationLook,
  type StationSummary,
} from '@likapcs/shared';
import { api, ApiError, apiUpload, fileUrl } from '../../lib/api';
import { prepareProductImage } from '../../lib/images';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { Button, Dialog, Field, Select } from '../ui/primitives';

const WALLPAPER_PATH: Record<WallpaperKind, string> = {
  lock: 'wallpaper',
  desktop: 'desktop-wallpaper',
};

const WALLPAPER_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif';

export function StationLookDialog({
  station,
  onClose,
}: {
  station: StationSummary;
  onClose: () => void;
}) {
  const { t, td } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = can(PERMISSIONS.STATIONS_MANAGE);
  // The dialog keeps its own copy of the station: wallpaper changes answer with the new station.
  const [current, setCurrent] = useState<StationSummary>(station);
  const [draft, setDraft] = useState<StationLook>(() => ({ ...station.look }));
  const [wallpaperBusy, setWallpaperBusy] = useState(false);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['stations'] });
  const failed = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));

  const save = useMutation({
    // The PATCH replaces the whole look; "House setting" fields are simply not sent.
    mutationFn: () =>
      api<StationSummary>(`/stations/${station.id}/look`, {
        method: 'PATCH',
        body: compactLook(draft),
      }),
    onSuccess: (updated) => {
      setCurrent(updated);
      toast.success(t('stations.look.saved'));
      refresh();
      onClose();
    },
    onError: failed,
  });

  const uploadWallpaper = async (file: File, kind: WallpaperKind = 'lock') => {
    setWallpaperBusy(true);
    try {
      // Phone photos are large; a 1920 px wallpaper is plenty for a PC screen. The desktop one is
      // JPEG (or PNG), the format Windows takes.
      const prepared = await prepareProductImage(file, 1920, kind === 'desktop' ? 'jpeg' : 'webp');
      const updated = await apiUpload<StationSummary>(
        `/stations/${station.id}/${WALLPAPER_PATH[kind]}`,
        prepared.blob,
        {},
        { method: 'PUT', contentType: prepared.contentType },
      );
      setCurrent(updated);
      toast.success(t('stations.look.wallpaperSaved'));
      refresh();
    } catch (err) {
      failed(err);
    } finally {
      setWallpaperBusy(false);
    }
  };

  const removeWallpaper = async (kind: WallpaperKind = 'lock') => {
    setWallpaperBusy(true);
    try {
      const updated = await api<StationSummary>(`/stations/${station.id}/${WALLPAPER_PATH[kind]}`, {
        method: 'DELETE',
      });
      setCurrent(updated);
      toast.success(t('stations.look.wallpaperRemoved'));
      refresh();
    } catch (err) {
      failed(err);
    } finally {
      setWallpaperBusy(false);
    }
  };

  const wallpaperSrc = fileUrl(current.wallpaperUrl);
  const desktopSrc = fileUrl(current.desktopWallpaperUrl);

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={`${t('stations.look.title')} · ${current.code}`}
      description={t('stations.look.hint')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {canManage && (
            <Button
              variant="primary"
              onClick={() => save.mutate()}
              disabled={save.isPending}
              data-testid="station-look-save"
            >
              {t('common.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <OverrideSelect
            label={t('stations.look.widgetSize')}
            value={draft.widgetSize}
            disabled={!canManage}
            options={CLIENT_WIDGET_SIZES.map((v) => ({
              value: v,
              label: t(`settings.client.size.${v}`),
            }))}
            houseLabel={t('stations.look.house')}
            onChange={(v) => setDraft((d) => ({ ...d, widgetSize: v }))}
          />
          <OverrideSelect
            label={t('stations.look.widgetPosition')}
            value={draft.widgetPosition}
            disabled={!canManage}
            options={CLIENT_WIDGET_POSITIONS.map((v) => ({
              value: v,
              label: t(`settings.client.position.${v}`),
            }))}
            houseLabel={t('stations.look.house')}
            onChange={(v) => setDraft((d) => ({ ...d, widgetPosition: v }))}
          />
          <OverrideSelect
            label={t('stations.look.widgetStyle')}
            value={draft.widgetStyle}
            disabled={!canManage}
            options={CLIENT_WIDGET_STYLES.map((v) => ({
              value: v,
              label: td(`settings.client.design.${v}.name`, v),
            }))}
            houseLabel={t('stations.look.house')}
            onChange={(v) => setDraft((d) => ({ ...d, widgetStyle: v }))}
          />
          <OverrideSelect
            label={t('stations.look.widgetTheme')}
            value={draft.widgetTheme}
            disabled={!canManage}
            options={CLIENT_WIDGET_THEMES.map((v) => ({
              value: v,
              label: t(`settings.client.theme.${v}`),
            }))}
            houseLabel={t('stations.look.house')}
            onChange={(v) => setDraft((d) => ({ ...d, widgetTheme: v }))}
          />
          <OverrideSelect
            label={t('stations.look.ads')}
            value={draft.adsEnabled === undefined ? null : draft.adsEnabled ? 'on' : 'off'}
            disabled={!canManage}
            options={[
              { value: 'on', label: t('stations.look.on') },
              { value: 'off', label: t('stations.look.off') },
            ]}
            houseLabel={t('stations.look.house')}
            onChange={(v) =>
              setDraft((d) => ({ ...d, adsEnabled: v === null ? null : v === 'on' }))
            }
          />
        </div>

        <Field label={t('stations.look.wallpaperTitle')} hint={t('stations.look.wallpaperHint')}>
          {() => (
            <div className="stack">
              <div
                className="look-wallpaper"
                data-testid="station-wallpaper-preview"
                style={wallpaperSrc ? { backgroundImage: `url("${wallpaperSrc}")` } : undefined}
              >
                {!wallpaperSrc && <span>{t('stations.look.none')}</span>}
              </div>
              {canManage && (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <label className="btn btn--sm" aria-disabled={wallpaperBusy}>
                    {wallpaperBusy ? t('stations.look.uploading') : t('stations.look.upload')}
                    <input
                      type="file"
                      accept={WALLPAPER_ACCEPT}
                      hidden
                      disabled={wallpaperBusy}
                      data-testid="station-wallpaper-input"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void uploadWallpaper(file);
                      }}
                    />
                  </label>
                  {wallpaperSrc && (
                    <Button onClick={() => void removeWallpaper()} disabled={wallpaperBusy}>
                      {t('stations.look.remove')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </Field>

        <Field label={t('stations.look.desktopTitle')} hint={t('stations.look.desktopHint')}>
          {() => (
            <div className="stack">
              <div
                className="look-wallpaper"
                data-testid="station-desktop-wallpaper-preview"
                style={desktopSrc ? { backgroundImage: `url("${desktopSrc}")` } : undefined}
              >
                {!desktopSrc && <span>{t('stations.look.none')}</span>}
              </div>
              {canManage && (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <label className="btn btn--sm" aria-disabled={wallpaperBusy}>
                    {wallpaperBusy ? t('stations.look.uploading') : t('stations.look.upload')}
                    <input
                      type="file"
                      accept={WALLPAPER_ACCEPT}
                      hidden
                      disabled={wallpaperBusy}
                      data-testid="station-desktop-wallpaper-input"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void uploadWallpaper(file, 'desktop');
                      }}
                    />
                  </label>
                  {desktopSrc && (
                    <Button
                      onClick={() => void removeWallpaper('desktop')}
                      disabled={wallpaperBusy}
                    >
                      {t('stations.look.remove')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </Field>
      </div>
    </Dialog>
  );
}

/** A select whose empty choice means "House setting" (the field is then not overridden). */
function OverrideSelect<T extends string>({
  label,
  value,
  options,
  houseLabel,
  disabled,
  onChange,
}: {
  label: string;
  value: T | null | undefined;
  options: { value: T; label: string }[];
  houseLabel: string;
  disabled: boolean;
  onChange: (value: T | null) => void;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <Select
          id={id}
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value;
            onChange(next === '' ? null : (options.find((o) => o.value === next)?.value ?? null));
          }}
        >
          <option value="">{houseLabel}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
