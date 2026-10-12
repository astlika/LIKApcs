/**
 * Ads — what the customer PCs show while locked (Admin › Ads, `/ads`).
 *
 * The owner curates the slideshow: product ads (optionally with a promo price that the POS then
 * charges automatically — the server derives it, see `ACTIVE_PROMO_SQL`) and custom slides
 * (title, text, picture). Each ad has a badge, a text line, a colour theme, its own time on screen,
 * a schedule, an on/off switch and a manual order (drag, or the arrow buttons). Products come in
 * through a catalogue browser (search, categories, multi-select) — one product continues into the
 * details dialog (promo price…), several are added at once. The master switch
 * (`client.ads_enabled`) and the look (layout, interval, transition) stay under Settings › Client
 * screen; this page links there and switches the slideshow on by itself when the first ad lands.
 *
 * Every change is pushed to the PCs by the server (`server.display`) — no restart anywhere.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  Clock3,
  Copy,
  Film,
  GripVertical,
  ImageIcon,
  Megaphone,
  MonitorSmartphone,
  Package,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdBulkResult,
  AdInput,
  AdKind,
  AdPatch,
  AdStyle,
  AdSummary,
  AdTheme,
  CategorySummary,
  ProductSummary,
  SettingsMap,
  StationSummary,
} from '@likapcs/shared';
import {
  AD_DURATION_MAX_SECONDS,
  AD_DURATION_MIN_SECONDS,
  AD_STYLES,
  AD_THEMES,
  AD_VIDEO_MAX_BYTES,
  PERMISSIONS,
  parseMoneyInput,
} from '@likapcs/shared';
import { ProductImageField, type PendingImage } from '../components/catalog/ProductImageField';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  Segmented,
  Switch,
  Textarea,
} from '../components/ui/primitives';
import { useI18n } from '../i18n';
import { api, ApiError, apiUpload, fileUrl } from '../lib/api';
import { themeStyle } from '../lib/ad-themes';
import { useFormat } from '../lib/format';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';

const STATE_TONE: Record<
  AdSummary['state'],
  'success' | 'default' | 'info' | 'warning' | 'danger'
> = {
  live: 'success',
  disabled: 'default',
  scheduled: 'info',
  expired: 'warning',
  unavailable: 'danger',
  off_hours: 'info',
};

/** Theme swatches — the same two base tones the client uses (see client styles `.ads__theme--*`). */

/** `datetime-local` value (local time, minutes) ⇄ ISO instant. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function AdsPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canManage = can(PERMISSIONS.PRODUCTS_MANAGE);
  const canSettings = can(PERMISSIONS.SETTINGS_MANAGE);

  const ads = useQuery({
    queryKey: ['ads'],
    queryFn: () => api<{ items: AdSummary[] }>('/ads'),
    refetchInterval: 60_000,
  });
  const publicSettings = useQuery({
    queryKey: ['settings', 'public'],
    queryFn: () => api<Partial<SettingsMap>>('/settings/public', { auth: false }),
  });
  const slideshowOn = publicSettings.data?.['client.ads_enabled'] ?? false;
  const defaultStyle: AdStyle = publicSettings.data?.['client.ads_style'] ?? 'hero';
  const stations = useQuery({
    queryKey: ['stations'],
    queryFn: () => api<StationSummary[]>('/stations'),
    staleTime: 30_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['ads'] });
    void queryClient.invalidateQueries({ queryKey: ['products'] }); // promo prices on the POS tiles
  };
  const onError = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));

  const toggleSlideshow = useMutation({
    mutationFn: (enabled: boolean) =>
      api<SettingsMap>('/settings', { method: 'PATCH', body: { 'client.ads_enabled': enabled } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings'] }),
    onError,
  });
  const toggleAd = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<AdSummary>(`/ads/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: invalidate,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/ads/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      toast.success(t('ads.deleted'));
    },
    onError,
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api<{ items: AdSummary[] }>('/ads/order', { method: 'PUT', body: { ids } }),
    onSuccess: (data) => queryClient.setQueryData(['ads'], data),
    onError,
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api<AdSummary>(`/ads/${id}/duplicate`, { method: 'POST' }),
    onSuccess: (copy) => {
      invalidate();
      setSelectedId(copy.id);
      setDialog({ kind: 'custom', ad: copy });
      toast.success(t('ads.duplicated'));
    },
    onError,
  });
  // The first ads landing while the slideshow is off: switch it on, so "I added ads but the PCs
  // show nothing" cannot happen. Only for users allowed to change settings; told by a toast.
  const autoEnable = () => {
    if (slideshowOn || !canSettings || toggleSlideshow.isPending) return;
    toggleSlideshow.mutate(true, { onSuccess: () => toast.success(t('ads.autoEnabled')) });
  };
  const addAll = useMutation({
    mutationFn: () =>
      api<AdBulkResult>('/ads/products/all', { method: 'POST', body: { onlyWithPhoto: false } }),
    onSuccess: (r) => {
      invalidate();
      toast.success(r.created > 0 ? t('ads.addedAll', { n: r.created }) : t('ads.addedAllNone'));
      if (r.created > 0) autoEnable();
    },
    onError,
  });
  const addChosen = useMutation({
    mutationFn: (productIds: string[]) =>
      api<AdBulkResult>('/ads/products/bulk', { method: 'POST', body: { productIds } }),
    onSuccess: (r) => {
      invalidate();
      setBrowser(false);
      toast.success(r.created > 0 ? t('ads.addedAll', { n: r.created }) : t('ads.addedAllNone'));
      if (r.created > 0) autoEnable();
    },
    onError,
  });

  const [browser, setBrowser] = useState(false);
  const [dialog, setDialog] = useState<{
    kind: AdKind;
    ad: AdSummary | null;
    product?: ProductSummary;
  } | null>(null);
  const [deleting, setDeleting] = useState<AdSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const items = useMemo(() => ads.data?.items ?? [], [ads.data]);
  const selected =
    items.find((a) => a.id === selectedId) ??
    items.find((a) => a.state === 'live') ??
    items[0] ??
    null;
  const liveCount = items.filter((a) => a.state === 'live').length;

  const move = (id: string, delta: number) => {
    const ids = items.map((a) => a.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    reorder.mutate(ids);
  };
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = items.map((a) => a.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]!);
    reorder.mutate(ids);
    setDragId(null);
  };
  const allowDrop = (e: DragEvent) => {
    if (dragId) e.preventDefault();
  };

  const stateLabel = (a: AdSummary) => t(`ads.state.${a.state}` as 'ads.state.live');
  const scheduleText = (a: AdSummary) => {
    if (!a.startsAt && !a.endsAt) return t('ads.always');
    if (a.startsAt && a.endsAt) return `${fmt.dateTime(a.startsAt)} – ${fmt.dateTime(a.endsAt)}`;
    if (a.startsAt) return t('ads.from', { when: fmt.dateTime(a.startsAt) });
    return t('ads.until', { when: fmt.dateTime(a.endsAt) });
  };
  const weeklyText = (a: AdSummary) => {
    const parts: string[] = [];
    if (a.daysMask !== 127)
      parts.push(
        [0, 1, 2, 3, 4, 5, 6]
          .filter((d) => a.daysMask & (1 << d))
          .map((d) => t(`ads.dayShort.${DAYS[d]!}`))
          .join(' '),
      );
    if (a.timeFrom && a.timeTo) parts.push(`${a.timeFrom}–${a.timeTo}`);
    return parts.join(' · ');
  };

  return (
    <>
      <PageHeader
        title={t('ads.title')}
        subtitle={t('ads.subtitle')}
        actions={
          canManage ? (
            <>
              <Button
                onClick={() => addAll.mutate()}
                loading={addAll.isPending}
                data-testid="ads-add-all"
              >
                <Sparkles size={16} /> {t('ads.addAll')}
              </Button>
              <Button
                onClick={() => setDialog({ kind: 'custom', ad: null })}
                data-testid="ads-add-custom"
              >
                <ImageIcon size={16} /> {t('ads.addCustom')}
              </Button>
              <Button
                variant="primary"
                onClick={() => setBrowser(true)}
                data-testid="ads-add-product"
              >
                <Plus size={16} /> {t('ads.addProduct')}
              </Button>
            </>
          ) : undefined
        }
      />

      <div
        className={`ads-master ${slideshowOn ? '' : 'ads-master--off'}`}
        data-testid="ads-master"
        data-on={slideshowOn ? 'true' : 'false'}
      >
        <div className="ads-master__text">
          {slideshowOn ? <Megaphone size={18} /> : <AlertTriangle size={18} />}
          <div>
            <strong>{slideshowOn ? t('ads.masterOn') : t('ads.masterOff')}</strong>
            <span className="muted">
              {' '}
              {slideshowOn ? t('ads.masterOnHint', { n: liveCount }) : t('ads.masterOffHint')}
            </span>
          </div>
        </div>
        <div className="ads-master__actions">
          <Link to="/settings?tab=client" className="btn btn--ghost btn--sm">
            <Settings2 size={14} /> {t('ads.lookLink')}
          </Link>
          {canSettings && (
            <Switch
              checked={slideshowOn}
              disabled={toggleSlideshow.isPending}
              onChange={(v) => toggleSlideshow.mutate(v)}
              label={t('ads.masterSwitch')}
            />
          )}
        </div>
      </div>

      {ads.isLoading ? (
        <Loading />
      ) : ads.isError ? (
        <Alert tone="danger">{t('common.errorGeneric')}</Alert>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Megaphone size={28} />}
            title={t('ads.emptyTitle')}
            hint={t('ads.emptyHint')}
            action={
              canManage ? (
                <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
                  <Button variant="primary" onClick={() => setBrowser(true)}>
                    <Plus size={16} /> {t('ads.addProduct')}
                  </Button>
                  <Button onClick={() => addAll.mutate()} loading={addAll.isPending}>
                    <Sparkles size={16} /> {t('ads.addAll')}
                  </Button>
                </div>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="ads-layout">
          <Card flush className="ads-list-card">
            <ul className="ads-list" data-testid="ads-list">
              {items.map((a, index) => (
                <li
                  key={a.id}
                  className={`ads-row ${selected?.id === a.id ? 'is-selected' : ''} ${
                    dragId === a.id ? 'is-dragging' : ''
                  } ${a.state !== 'live' ? 'is-off' : ''}`}
                  data-testid="ad-row"
                  data-state={a.state}
                  draggable={canManage}
                  onDragStart={() => setDragId(a.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={allowDrop}
                  onDrop={() => dropOn(a.id)}
                  onClick={() => setSelectedId(a.id)}
                >
                  {canManage && (
                    <span className="ads-row__grip" title={t('ads.dragHint')}>
                      <GripVertical size={16} />
                    </span>
                  )}
                  <span className="ads-row__thumb" style={themeStyle(a.theme)}>
                    {a.imageUrl ? (
                      <img src={fileUrl(a.imageUrl) ?? ''} alt="" draggable={false} />
                    ) : a.kind === 'product' ? (
                      <Package size={18} />
                    ) : (
                      <ImageIcon size={18} />
                    )}
                  </span>
                  <span className="ads-row__main">
                    <span className="ads-row__name">
                      {a.kind === 'product' ? a.productName : a.title}
                      {a.badge && <Badge tone="accent">{a.badge}</Badge>}
                      {a.kind === 'product' && a.productInStock === false && (
                        <span title={t('ads.outOfStockHint')} data-testid="ad-out-of-stock">
                          <Badge tone="warning">{t('ads.outOfStock')}</Badge>
                        </span>
                      )}
                    </span>
                    <span className="ads-row__sub muted">
                      {a.kind === 'product'
                        ? a.body ||
                          `${t('ads.kindProduct')}${a.productSku ? ` · ${a.productSku}` : ''}`
                        : a.body || t('ads.kindCustom')}
                      {a.durationSeconds !== null && ` · ${a.durationSeconds} s`}
                    </span>
                  </span>
                  <span className="ads-row__price num">
                    {a.kind === 'product' && a.productPriceCents !== null ? (
                      a.promoPriceCents !== null && a.promoPriceCents < a.productPriceCents ? (
                        <>
                          <s className="muted">{fmt.money(a.productPriceCents)}</s>{' '}
                          <strong className="text-success">{fmt.money(a.promoPriceCents)}</strong>
                        </>
                      ) : (
                        fmt.money(a.productPriceCents)
                      )
                    ) : (
                      '—'
                    )}
                  </span>
                  <span className="ads-row__when muted">
                    {scheduleText(a)}
                    {weeklyText(a) && (
                      <span className="ads-row__weekly" data-testid="ad-weekly">
                        <CalendarDays size={11} /> {weeklyText(a)}
                      </span>
                    )}
                    <span className="ads-row__flags">
                      {a.stationIds.length > 0 && (
                        <Badge tone="default">
                          <MonitorSmartphone size={11} />{' '}
                          {t('ads.stationsSome', { n: a.stationIds.length })}
                        </Badge>
                      )}
                      {a.videoUrl && (
                        <Badge tone="default">
                          <Film size={11} /> {t('ads.video')}
                        </Badge>
                      )}
                      {a.weight > 1 && <Badge tone="accent">{a.weight}×</Badge>}
                    </span>
                  </span>
                  <span className="ads-row__state">
                    <Badge tone={STATE_TONE[a.state]} dot>
                      {stateLabel(a)}
                    </Badge>
                  </span>
                  <span className="ads-row__actions" onClick={(e) => e.stopPropagation()}>
                    {canManage && (
                      <>
                        <Switch
                          checked={a.enabled}
                          disabled={toggleAd.isPending}
                          onChange={(enabled) => toggleAd.mutate({ id: a.id, enabled })}
                        />
                        <Button
                          icon
                          size="sm"
                          variant="ghost"
                          aria-label={t('ads.moveUp')}
                          title={t('ads.moveUp')}
                          disabled={index === 0 || reorder.isPending}
                          onClick={() => move(a.id, -1)}
                        >
                          <ArrowUp size={14} />
                        </Button>
                        <Button
                          icon
                          size="sm"
                          variant="ghost"
                          aria-label={t('ads.moveDown')}
                          title={t('ads.moveDown')}
                          disabled={index === items.length - 1 || reorder.isPending}
                          onClick={() => move(a.id, 1)}
                        >
                          <ArrowDown size={14} />
                        </Button>
                        <Button
                          icon
                          size="sm"
                          variant="ghost"
                          aria-label={t('common.edit')}
                          title={t('common.edit')}
                          onClick={() => setDialog({ kind: a.kind, ad: a })}
                          data-testid="ad-edit"
                        >
                          <Pencil size={14} />
                        </Button>
                        <Button
                          icon
                          size="sm"
                          variant="ghost"
                          aria-label={t('ads.duplicate')}
                          title={t('ads.duplicate')}
                          disabled={duplicate.isPending}
                          onClick={() => duplicate.mutate(a.id)}
                          data-testid="ad-duplicate"
                        >
                          <Copy size={14} />
                        </Button>
                        <Button
                          icon
                          size="sm"
                          variant="ghost"
                          aria-label={t('common.delete')}
                          title={t('common.delete')}
                          onClick={() => setDeleting(a)}
                          data-testid="ad-delete"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <div className="ads-side">
            <Card title={t('ads.previewTitle')} subtitle={t('ads.previewHint')}>
              {selected ? <AdPreview ad={selected} defaultStyle={defaultStyle} /> : null}
              {selected && selected.state !== 'live' && (
                <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                  {t(`ads.stateHint.${selected.state}` as 'ads.stateHint.disabled')}
                </p>
              )}
            </Card>
            <Card title={t('ads.howTitle')}>
              <ul className="ads-how">
                <li>{t('ads.how1')}</li>
                <li>{t('ads.how2')}</li>
                <li>{t('ads.how3')}</li>
              </ul>
            </Card>
          </div>
        </div>
      )}

      {browser && (
        <ProductBrowserDialog
          advertised={new Set(items.map((a) => a.productId).filter((id): id is string => !!id))}
          busy={addChosen.isPending}
          onClose={() => setBrowser(false)}
          onAddMany={(ids) => addChosen.mutate(ids)}
          onPickOne={(product) => {
            setBrowser(false);
            setDialog({ kind: 'product', ad: null, product });
          }}
        />
      )}
      {dialog && (
        <AdDialog
          kind={dialog.kind}
          ad={dialog.ad}
          product={dialog.product ?? null}
          defaultIntervalSeconds={publicSettings.data?.['client.ads_interval_seconds'] ?? 8}
          defaultStyle={defaultStyle}
          stations={stations.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={(saved, created) => {
            invalidate();
            setSelectedId(saved.id);
            setDialog(null);
            if (created) autoEnable();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title={t('ads.deleteTitle')}
        body={t('ads.deleteBody', {
          name:
            deleting?.kind === 'product' ? (deleting.productName ?? '') : (deleting?.title ?? ''),
        })}
        confirmLabel={t('common.delete')}
        danger
        loading={remove.isPending}
      />
    </>
  );
}

/** How the slide reads on the PC (card layout): picture, badge, name, old → new price or text. */
/**
 * How the slide reads on a PC, in its style (poster / hero / split / banner) with the accent
 * colour and the call-to-action — a scaled mock of the client's slide, same class names idea.
 */
export function AdPreview({
  ad,
  defaultStyle,
  overrides,
}: {
  ad: AdSummary;
  defaultStyle: AdStyle;
  /** Live values while editing (dialog), before they are saved. */
  overrides?: Partial<
    Pick<AdSummary, 'style' | 'accent' | 'cta' | 'badge' | 'title' | 'body' | 'theme'> & {
      imageUrl: string | null;
      videoUrl: string | null;
      promoPriceCents: number | null;
    }
  >;
}) {
  const fmt = useFormat();
  const { t } = useI18n();
  const a = { ...ad, ...overrides };
  const style: AdStyle = a.style ?? defaultStyle;
  const promo =
    a.kind === 'product' &&
    a.promoPriceCents !== null &&
    a.productPriceCents !== null &&
    a.promoPriceCents < a.productPriceCents;
  const name = a.kind === 'product' ? a.productName : a.title;
  const src = fileUrl(a.imageUrl);
  const video = a.videoUrl ? (fileUrl(a.videoUrl) ?? a.videoUrl) : null;
  const price =
    a.kind === 'product' && a.productPriceCents !== null ? (
      <span className="ad-prev__price" style={a.accent ? { background: a.accent } : undefined}>
        {promo && <s>{fmt.money(a.productPriceCents)}</s>}
        <b>{fmt.money(promo ? a.promoPriceCents! : a.productPriceCents)}</b>
      </span>
    ) : null;
  const media = video ? (
    <video className="ad-prev__media" src={video} muted autoPlay loop playsInline />
  ) : src ? (
    <img className="ad-prev__media" src={src} alt="" draggable={false} />
  ) : (
    <div className="ad-prev__media ad-prev__media--blank">
      {a.kind === 'product' ? <Package size={34} /> : <ImageIcon size={34} />}
    </div>
  );
  return (
    <div
      className={`ad-prev ad-prev--${style} ${src || video ? '' : 'ad-prev--nomedia'}`}
      style={themeStyle(a.theme)}
      data-testid="ad-preview"
      data-style={style}
      data-theme={a.theme ?? 'midnight'}
    >
      {media}
      {a.badge && (
        <span className="ad-prev__badge" style={a.accent ? { background: a.accent } : undefined}>
          {a.badge}
        </span>
      )}
      <div className="ad-prev__text">
        <strong className="ad-prev__name">{name}</strong>
        {a.body && <span className="ad-prev__body">{a.body}</span>}
        {price}
        {a.cta && <span className="ad-prev__cta">{a.cta}</span>}
      </div>
      <span className="ad-prev__style">{t(`ads.styles.${style}`)}</span>
    </div>
  );
}

type PendingVideo =
  | { kind: 'upload'; file: File; previewUrl: string }
  | { kind: 'link'; url: string }
  | { kind: 'remove' }
  | null;

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

function AdDialog({
  kind,
  ad,
  product: initialProduct,
  defaultIntervalSeconds,
  defaultStyle,
  stations,
  onClose,
  onSaved,
}: {
  kind: AdKind;
  ad: AdSummary | null;
  /** New product ad: the product chosen in the browser. */
  product: ProductSummary | null;
  defaultIntervalSeconds: number;
  defaultStyle: AdStyle;
  stations: StationSummary[];
  onClose: () => void;
  onSaved: (ad: AdSummary, created: boolean) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const product = ad?.productId
    ? { id: ad.productId, name: ad.productName ?? '', priceCents: ad.productPriceCents ?? 0 }
    : initialProduct
      ? {
          id: initialProduct.id,
          name: initialProduct.name,
          priceCents: initialProduct.sellingPriceCents,
        }
      : null;
  const [form, setForm] = useState({
    title: ad?.title ?? '',
    body: ad?.body ?? '',
    promo: ad?.promoPriceCents != null ? (ad.promoPriceCents / 100).toFixed(2) : '',
    badge: ad?.badge ?? '',
    theme: (ad?.theme ?? 'midnight') as AdTheme,
    duration: ad?.durationSeconds != null ? String(ad.durationSeconds) : '',
    startsAt: toLocalInput(ad?.startsAt ?? null),
    endsAt: toLocalInput(ad?.endsAt ?? null),
    enabled: ad?.enabled ?? true,
    // 0.10.0
    style: (ad?.style ?? '') as AdStyle | '',
    accent: ad?.accent ?? '',
    cta: ad?.cta ?? '',
    weight: (ad?.weight ?? 1) as 1 | 2 | 3,
    daysMask: ad?.daysMask ?? 127,
    timeFrom: ad?.timeFrom ?? '',
    timeTo: ad?.timeTo ?? '',
    stationIds: ad?.stationIds ?? ([] as string[]),
  });
  const [pendingImage, setPendingImage] = useState<PendingImage>(null);
  const [pendingVideo, setPendingVideo] = useState<PendingVideo>(null);
  const [videoLink, setVideoLink] = useState('');
  const videoInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const videoMb = Math.round(AD_VIDEO_MAX_BYTES / 1024 / 1024);
  const currentVideo =
    pendingVideo?.kind === 'remove'
      ? null
      : pendingVideo?.kind === 'link'
        ? pendingVideo.url
        : pendingVideo?.kind === 'upload'
          ? pendingVideo.previewUrl
          : (ad?.videoUrl ?? null);
  const pickVideo = (file: File | null) => {
    if (!file) return;
    if (!['video/mp4', 'video/webm'].includes(file.type)) {
      setError(t('ads.videoBadType'));
      return;
    }
    if (file.size > AD_VIDEO_MAX_BYTES) {
      setError(t('ads.videoTooLarge', { mb: videoMb }));
      return;
    }
    setPendingVideo({ kind: 'upload', file, previewUrl: URL.createObjectURL(file) });
  };
  const hoursInvalid =
    (form.timeFrom === '') !== (form.timeTo === '') ||
    (form.timeFrom !== '' && form.timeFrom === form.timeTo);
  const videoLinkInvalid = videoLink.trim() !== '' && !/^https?:\/\/\S+$/i.test(videoLink.trim());
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const promoCents = form.promo.trim() ? parseMoneyInput(form.promo) : null;
  const promoInvalid = form.promo.trim() !== '' && promoCents === null;
  const promoNotBelow =
    promoCents !== null &&
    product !== null &&
    product.priceCents > 0 &&
    promoCents >= product.priceCents;
  const startIso = fromLocalInput(form.startsAt);
  const endIso = fromLocalInput(form.endsAt);
  const windowInvalid = Boolean(startIso && endIso && new Date(endIso) <= new Date(startIso));
  const titleMissing = kind === 'custom' && form.title.trim().length === 0;
  const productMissing = kind === 'product' && product === null;
  const durationSeconds = form.duration.trim() === '' ? null : Number(form.duration);
  const durationInvalid =
    durationSeconds !== null &&
    (!Number.isInteger(durationSeconds) ||
      durationSeconds < AD_DURATION_MIN_SECONDS ||
      durationSeconds > AD_DURATION_MAX_SECONDS);
  const valid =
    !promoInvalid &&
    !promoNotBelow &&
    !windowInvalid &&
    !titleMissing &&
    !productMissing &&
    !durationInvalid &&
    !hoursInvalid &&
    !videoLinkInvalid &&
    form.daysMask > 0;
  const discountPct =
    promoCents !== null && product && product.priceCents > 0 && promoCents < product.priceCents
      ? Math.round((1 - promoCents / product.priceCents) * 100)
      : null;

  useEffect(() => setError(null), [form]);
  useEffect(
    () => () => {
      if (pendingVideo?.kind === 'upload') URL.revokeObjectURL(pendingVideo.previewUrl);
    },
    [pendingVideo],
  );

  const save = useMutation({
    mutationFn: async (): Promise<AdSummary> => {
      const link = videoLink.trim();
      const common = {
        body: form.body.trim() || null,
        badge: form.badge.trim() || null,
        theme: form.theme === 'midnight' ? null : form.theme,
        durationSeconds,
        startsAt: startIso,
        endsAt: endIso,
        enabled: form.enabled,
        style: form.style || null,
        accent: form.accent || null,
        cta: form.cta.trim() || null,
        weight: form.weight,
        daysMask: form.daysMask,
        timeFrom: form.timeFrom || null,
        timeTo: form.timeTo || null,
        stationIds: form.stationIds,
        // A link replaces an upload; "remove" clears both; otherwise the upload (if any) follows.
        ...(link ? { videoUrl: link } : pendingVideo?.kind === 'remove' ? { videoUrl: null } : {}),
      };
      let saved: AdSummary;
      if (ad) {
        const patch: AdPatch = {
          ...common,
          ...(kind === 'custom' ? { title: form.title.trim() } : {}),
          ...(kind === 'product' ? { promoPriceCents: promoCents } : {}),
        };
        saved = await api<AdSummary>(`/ads/${ad.id}`, { method: 'PATCH', body: patch });
      } else {
        const input: AdInput = {
          kind,
          ...common,
          ...(kind === 'custom' ? { title: form.title.trim() } : {}),
          ...(kind === 'product' ? { productId: product!.id, promoPriceCents: promoCents } : {}),
        };
        saved = await api<AdSummary>('/ads', { method: 'POST', body: input });
      }
      if (pendingVideo?.kind === 'upload' && !link) {
        saved = await apiUpload<AdSummary>(
          `/ads/${saved.id}/video`,
          pendingVideo.file,
          {},
          {
            method: 'PUT',
            contentType: pendingVideo.file.type,
          },
        );
      }
      if (kind === 'custom' && pendingImage) {
        if (pendingImage.kind === 'upload') {
          saved = await apiUpload<AdSummary>(
            `/ads/${saved.id}/image`,
            pendingImage.blob,
            {},
            {
              method: 'PUT',
              contentType: pendingImage.contentType,
            },
          );
        } else if (pendingImage.kind === 'link') {
          saved = await api<AdSummary>(`/ads/${saved.id}/image/from-url`, {
            method: 'POST',
            body: { url: pendingImage.url },
          });
        } else {
          saved = await api<AdSummary>(`/ads/${saved.id}/image`, { method: 'DELETE' });
        }
      }
      return saved;
    },
    onSuccess: (saved) => {
      toast.success(t('ads.saved'));
      onSaved(saved, ad === null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={
        ad
          ? t('ads.editTitle')
          : kind === 'product'
            ? t('ads.productDialogTitle')
            : t('ads.addCustom')
      }
      description={kind === 'product' ? t('ads.productDialogHint') : t('ads.customDialogHint')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={save.isPending}
            onClick={() => save.mutate()}
            data-testid="ad-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !save.isPending) save.mutate();
        }}
      >
        {kind === 'product' && product && (
          <Field label={t('ads.product')} className="span-2">
            {() => (
              <div className="ads-picked" data-testid="ad-picked-product">
                <Package size={16} />
                <strong>{product.name}</strong>
                <span className="muted num">{fmt.money(product.priceCents)}</span>
              </div>
            )}
          </Field>
        )}
        {kind === 'product' && (
          <Field
            label={t('ads.promoPrice')}
            hint={
              promoNotBelow
                ? undefined
                : discountPct !== null
                  ? t('ads.promoPct', { pct: discountPct })
                  : t('ads.promoHint')
            }
            error={
              promoInvalid
                ? t('common.invalid')
                : promoNotBelow
                  ? t('ads.promoNotBelow', { price: fmt.money(product?.priceCents ?? 0) })
                  : undefined
            }
          >
            {(id, invalid) => (
              <Input
                id={id}
                autoFocus
                className="num"
                inputMode="decimal"
                placeholder="0.00"
                aria-invalid={invalid || undefined}
                value={form.promo}
                onChange={(e) => set('promo', e.target.value)}
                data-testid="ad-promo"
              />
            )}
          </Field>
        )}
        {kind === 'custom' && (
          <Field
            label={t('ads.titleField')}
            className="span-2"
            error={titleMissing && form.title !== '' ? t('common.required') : undefined}
          >
            {(id) => (
              <Input
                id={id}
                autoFocus
                maxLength={80}
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                data-testid="ad-title"
              />
            )}
          </Field>
        )}
        <Field
          label={t('ads.bodyField')}
          hint={kind === 'custom' ? t('ads.bodyHint') : t('ads.productBodyHint')}
          className="span-2"
          optional
        >
          {(id) =>
            kind === 'custom' ? (
              <Textarea
                id={id}
                rows={3}
                maxLength={300}
                value={form.body}
                onChange={(e) => set('body', e.target.value)}
                data-testid="ad-body"
              />
            ) : (
              <Input
                id={id}
                maxLength={120}
                value={form.body}
                onChange={(e) => set('body', e.target.value)}
                data-testid="ad-body"
              />
            )
          }
        </Field>
        <Field label={t('ads.theme')} hint={t('ads.themeHint')} className="span-2">
          {() => (
            <div className="ad-themes" role="radiogroup" data-testid="ad-themes">
              {AD_THEMES.map((theme) => (
                <button
                  key={theme}
                  type="button"
                  role="radio"
                  aria-checked={form.theme === theme}
                  className={`ad-theme ${form.theme === theme ? 'is-on' : ''}`}
                  title={t(`ads.themes.${theme}`)}
                  onClick={() => set('theme', theme)}
                  data-testid={`ad-theme-${theme}`}
                >
                  <span className="ad-theme__swatch" style={themeStyle(theme)}>
                    {form.theme === theme && <Check size={14} />}
                  </span>
                  <span className="ad-theme__label">{t(`ads.themes.${theme}`)}</span>
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field
          label={t('ads.style')}
          hint={t('ads.styleHint', { style: t(`ads.styles.${defaultStyle}`) })}
          className="span-2"
        >
          {() => (
            <div className="ad-styles" role="radiogroup" data-testid="ad-styles">
              {(['', ...AD_STYLES] as const).map((st) => (
                <button
                  key={st || 'default'}
                  type="button"
                  role="radio"
                  aria-checked={form.style === st}
                  className={`ad-style ${form.style === st ? 'is-on' : ''}`}
                  title={st ? t(`ads.styleHints.${st}`) : t(`ads.styleHints.${defaultStyle}`)}
                  onClick={() => set('style', st)}
                  data-testid={`ad-style-${st || 'default'}`}
                >
                  <span className={`ad-style__thumb ad-style__thumb--${st || defaultStyle}`}>
                    <i />
                    <b />
                  </span>
                  <span className="ad-style__label">
                    {st ? t(`ads.styles.${st}`) : t('ads.styleDefault')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label={t('ads.accent')} hint={t('ads.accentHint')} optional>
          {(id) => (
            <div className="row" style={{ gap: 8 }}>
              <input
                id={id}
                type="color"
                className="ad-accent"
                value={form.accent || '#f59e0b'}
                onChange={(e) => set('accent', e.target.value)}
                data-testid="ad-accent"
              />
              <Input
                value={form.accent}
                placeholder="#RRGGBB"
                maxLength={7}
                style={{ maxWidth: 120 }}
                onChange={(e) => set('accent', e.target.value.trim())}
              />
              {form.accent && (
                <Button size="sm" variant="ghost" onClick={() => set('accent', '')}>
                  {t('ads.accentReset')}
                </Button>
              )}
            </div>
          )}
        </Field>
        <Field label={t('ads.cta')} hint={t('ads.ctaHint')} optional>
          {(id) => (
            <Input
              id={id}
              maxLength={60}
              placeholder={t('ads.ctaDefault')}
              value={form.cta}
              onChange={(e) => set('cta', e.target.value)}
              data-testid="ad-cta"
            />
          )}
        </Field>
        <Field label={t('ads.weight')} hint={t('ads.weightHint')}>
          {() => (
            <Segmented
              value={String(form.weight) as '1' | '2' | '3'}
              options={([1, 2, 3] as const).map((w) => ({
                value: String(w) as '1' | '2' | '3',
                label: t(`ads.weights.w${w}`),
              }))}
              onChange={(v) => set('weight', Number(v) as 1 | 2 | 3)}
              testId="ad-weight"
            />
          )}
        </Field>
        <Field
          label={t('ads.duration')}
          hint={t('ads.durationHint', { n: defaultIntervalSeconds })}
          optional
          error={durationInvalid ? t('common.invalid') : undefined}
        >
          {(id, invalid) => (
            <Input
              id={id}
              className="num"
              inputMode="numeric"
              placeholder={String(defaultIntervalSeconds)}
              aria-invalid={invalid || undefined}
              value={form.duration}
              onChange={(e) => set('duration', e.target.value)}
              data-testid="ad-duration"
            />
          )}
        </Field>
        <Field label={t('ads.badge')} hint={t('ads.badgeHint')} optional>
          {(id) => (
            <Input
              id={id}
              maxLength={16}
              placeholder="-20%"
              value={form.badge}
              onChange={(e) => set('badge', e.target.value)}
              data-testid="ad-badge"
            />
          )}
        </Field>
        <Field label={t('ads.enabled')}>
          {() => (
            <div style={{ paddingTop: 6 }}>
              <Switch
                checked={form.enabled}
                onChange={(v) => set('enabled', v)}
                label={form.enabled ? t('ads.enabledOn') : t('ads.enabledOff')}
              />
            </div>
          )}
        </Field>
        <Field label={t('ads.startsAt')} hint={t('ads.scheduleHint')} optional>
          {(id) => (
            <Input
              id={id}
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => set('startsAt', e.target.value)}
            />
          )}
        </Field>
        <Field
          label={t('ads.endsAt')}
          optional
          error={windowInvalid ? t('ads.windowInvalid') : undefined}
        >
          {(id, invalid) => (
            <Input
              id={id}
              type="datetime-local"
              aria-invalid={invalid || undefined}
              value={form.endsAt}
              onChange={(e) => set('endsAt', e.target.value)}
            />
          )}
        </Field>
        <Field label={t('ads.days')} hint={t('ads.daysHint')} className="span-2">
          {() => (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} data-testid="ad-days">
              {DAYS.map((name, d) => {
                const on = (form.daysMask & (1 << d)) !== 0;
                return (
                  <button
                    key={name}
                    type="button"
                    className="chip"
                    aria-pressed={on}
                    onClick={() =>
                      set('daysMask', on ? form.daysMask & ~(1 << d) : form.daysMask | (1 << d))
                    }
                    data-testid={`ad-day-${d}`}
                  >
                    {t(`ads.dayShort.${name}`)}
                  </button>
                );
              })}
              <button
                type="button"
                className="chip"
                aria-pressed={form.daysMask === 127}
                onClick={() => set('daysMask', 127)}
              >
                {t('ads.daysAll')}
              </button>
            </div>
          )}
        </Field>
        <Field
          label={t('ads.hours')}
          hint={t('ads.hoursHint')}
          className="span-2"
          optional
          error={hoursInvalid ? t('ads.hoursInvalid') : undefined}
        >
          {() => (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Clock3 size={14} className="muted" />
              <span className="muted">{t('ads.hoursFrom')}</span>
              <Input
                type="time"
                value={form.timeFrom}
                onChange={(e) => set('timeFrom', e.target.value)}
                style={{ maxWidth: 130 }}
                data-testid="ad-time-from"
              />
              <span className="muted">{t('ads.hoursTo')}</span>
              <Input
                type="time"
                value={form.timeTo}
                onChange={(e) => set('timeTo', e.target.value)}
                style={{ maxWidth: 130 }}
                data-testid="ad-time-to"
              />
              {(form.timeFrom || form.timeTo) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    set('timeFrom', '');
                    set('timeTo', '');
                  }}
                >
                  {t('ads.hoursAllDay')}
                </Button>
              )}
            </div>
          )}
        </Field>
        {stations.length > 0 && (
          <Field label={t('ads.stations')} hint={t('ads.stationsHint')} className="span-2">
            {() => (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} data-testid="ad-stations">
                <button
                  type="button"
                  className="chip"
                  aria-pressed={form.stationIds.length === 0}
                  onClick={() => set('stationIds', [])}
                >
                  {t('ads.stationsAll')}
                </button>
                {stations.map((st) => {
                  const on = form.stationIds.includes(st.id);
                  return (
                    <button
                      key={st.id}
                      type="button"
                      className="chip"
                      aria-pressed={on}
                      onClick={() =>
                        set(
                          'stationIds',
                          on
                            ? form.stationIds.filter((x) => x !== st.id)
                            : [...form.stationIds, st.id],
                        )
                      }
                      data-testid={`ad-station-${st.code}`}
                    >
                      {st.code}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>
        )}
        <Field
          label={t('ads.video')}
          hint={t('ads.videoHint', { mb: videoMb })}
          className="span-2"
          optional
          error={videoLinkInvalid ? t('common.invalid') : undefined}
        >
          {() => (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <input
                  ref={videoInput}
                  type="file"
                  accept="video/mp4,video/webm"
                  hidden
                  onChange={(e) => {
                    pickVideo(e.target.files?.[0] ?? null);
                    e.target.value = '';
                  }}
                  data-testid="ad-video-file"
                />
                <Button
                  size="sm"
                  onClick={() => videoInput.current?.click()}
                  disabled={save.isPending}
                >
                  <Upload size={14} /> {t('ads.videoUpload')}
                </Button>
                <Input
                  value={videoLink}
                  placeholder={t('ads.videoLinkPlaceholder')}
                  onChange={(e) => setVideoLink(e.target.value)}
                  style={{ flex: 1, minWidth: 220 }}
                  data-testid="ad-video-link"
                />
                {currentVideo && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPendingVideo({ kind: 'remove' });
                      setVideoLink('');
                    }}
                    data-testid="ad-video-remove"
                  >
                    <X size={14} /> {t('ads.videoRemove')}
                  </Button>
                )}
              </div>
              {currentVideo && (
                <div className="ad-video-current" data-testid="ad-video-current">
                  <Film size={14} />
                  <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {pendingVideo?.kind === 'upload'
                      ? `${pendingVideo.file.name} · ${t('ads.videoPending')}`
                      : currentVideo}
                  </span>
                </div>
              )}
            </div>
          )}
        </Field>
        {kind === 'custom' && (
          <div className="span-2">
            <ProductImageField
              currentUrl={ad?.imageUrl ?? null}
              pending={pendingImage}
              onChange={setPendingImage}
              disabled={save.isPending}
            />
          </div>
        )}
        <div className="span-2">
          <AdPreview
            ad={
              ad ?? {
                id: 'new',
                kind,
                productId: product?.id ?? null,
                productName: product?.name ?? null,
                productSku: null,
                productPriceCents: product?.priceCents ?? null,
                productInStock: true,
                productActive: true,
                promoPriceCents: null,
                title: null,
                body: null,
                imageUrl: initialProduct?.imageUrl ?? null,
                badge: null,
                theme: null,
                durationSeconds: null,
                startsAt: null,
                endsAt: null,
                enabled: true,
                sortOrder: 0,
                state: 'live',
                style: null,
                accent: null,
                cta: null,
                daysMask: 127,
                timeFrom: null,
                timeTo: null,
                weight: 1,
                stationIds: [],
                videoUrl: null,
                createdAt: '',
                updatedAt: '',
              }
            }
            defaultStyle={defaultStyle}
            overrides={{
              style: form.style || null,
              accent: form.accent || null,
              cta: form.cta.trim() || null,
              badge: form.badge.trim() || null,
              title: kind === 'custom' ? form.title.trim() || null : undefined,
              body: form.body.trim() || null,
              theme: form.theme === 'midnight' ? null : form.theme,
              promoPriceCents: promoCents,
              videoUrl: videoLink.trim() || currentVideo,
              imageUrl:
                pendingImage?.kind === 'upload'
                  ? pendingImage.previewUrl
                  : pendingImage?.kind === 'link'
                    ? pendingImage.url
                    : pendingImage?.kind === 'remove'
                      ? null
                      : (ad?.imageUrl ?? initialProduct?.imageUrl ?? null),
            }}
          />
        </div>
        {error && (
          <div className="span-2">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Catalogue browser for new product ads: every active product (search, category chips,
 * tick boxes). One ticked product continues into the details dialog (promo price, look…);
 * several are added at once at their regular price. Products that already have an ad are shown
 * but cannot be ticked twice.
 */
function ProductBrowserDialog({
  advertised,
  busy,
  onClose,
  onAddMany,
  onPickOne,
}: {
  advertised: Set<string>;
  busy: boolean;
  onClose: () => void;
  onAddMany: (productIds: string[]) => void;
  onPickOne: (product: ProductSummary) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const products = useQuery({
    queryKey: ['products', 'ads-browser'],
    queryFn: () =>
      api<{ items: ProductSummary[]; total: number }>('/products', {
        query: { active: 'active', pageSize: 500 },
      }),
    staleTime: 10_000,
  });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<CategorySummary[]>('/catalog/categories'),
    staleTime: 60_000,
  });
  const all = useMemo(() => products.data?.items ?? [], [products.data]);
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      all.filter(
        (p) =>
          (categoryId === null || p.categoryId === categoryId) &&
          (needle === '' ||
            p.name.toLowerCase().includes(needle) ||
            p.sku.toLowerCase().includes(needle) ||
            p.barcodes.some((b) => b.barcode.includes(needle))),
      ),
    [all, categoryId, needle],
  );
  const usedCategories = useMemo(() => {
    const ids = new Set(all.map((p) => p.categoryId).filter((id): id is string => !!id));
    return (categories.data ?? []).filter((c) => ids.has(c.id));
  }, [all, categories.data]);
  const pickedSet = new Set(picked);
  const toggle = (p: ProductSummary) => {
    if (advertised.has(p.id)) return;
    setPicked((cur) => (cur.includes(p.id) ? cur.filter((id) => id !== p.id) : [...cur, p.id]));
  };
  const selectShown = () =>
    setPicked((cur) => [
      ...cur,
      ...shown.filter((p) => !advertised.has(p.id) && !cur.includes(p.id)).map((p) => p.id),
    ]);
  const one = picked.length === 1 ? all.find((p) => p.id === picked[0]) : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('ads.browserTitle')}
      description={t('ads.browserHint')}
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto' }} data-testid="browser-count">
            {t('ads.browserSelected', { n: picked.length })}
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          {one ? (
            <Button variant="primary" onClick={() => onPickOne(one)} data-testid="browser-next">
              {t('ads.browserNext')}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={picked.length === 0}
              loading={busy}
              onClick={() => onAddMany(picked)}
              data-testid="browser-add"
            >
              {t('ads.browserAdd', { n: picked.length })}
            </Button>
          )}
        </>
      }
    >
      <div className="ads-browser" data-testid="ads-browser">
        <div className="ads-browser__bar">
          <div className="customer-picker" style={{ flex: 1 }}>
            <Search size={14} className="customer-picker__icon" aria-hidden />
            <input
              className="input customer-picker__input"
              autoFocus
              placeholder={t('ads.browserSearch')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="browser-search"
            />
          </div>
          <Button size="sm" variant="ghost" onClick={selectShown} disabled={shown.length === 0}>
            {t('ads.browserSelectShown')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPicked([])}
            disabled={picked.length === 0}
          >
            {t('ads.browserClear')}
          </Button>
        </div>
        {usedCategories.length > 0 && (
          <div className="ads-browser__cats">
            <button
              type="button"
              className="chip"
              aria-pressed={categoryId === null}
              onClick={() => setCategoryId(null)}
            >
              {t('ads.browserAll')}
            </button>
            {usedCategories.map((c) => (
              <button
                key={c.id}
                type="button"
                className="chip"
                aria-pressed={categoryId === c.id}
                onClick={() => setCategoryId(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
        {products.isLoading ? (
          <Loading />
        ) : products.isError ? (
          <Alert tone="danger">{t('common.errorGeneric')}</Alert>
        ) : all.length === 0 ? (
          <EmptyState icon={<Package size={24} />} title={t('ads.browserNone')} />
        ) : shown.length === 0 ? (
          <EmptyState icon={<Search size={24} />} title={t('ads.browserEmpty')} />
        ) : (
          <ul className="ads-browser__list" data-testid="browser-list">
            {shown.map((p) => {
              const already = advertised.has(p.id);
              const on = pickedSet.has(p.id);
              const src = fileUrl(p.imageUrl);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`ads-browser__item ${on ? 'is-on' : ''} ${already ? 'is-used' : ''}`}
                    onClick={() => toggle(p)}
                    disabled={already}
                    aria-pressed={on}
                    data-testid="browser-item"
                    data-product={p.id}
                    data-state={already ? 'used' : on ? 'on' : 'off'}
                  >
                    <span className={`ads-browser__check ${on ? 'is-on' : ''}`} aria-hidden>
                      {on && <Check size={14} />}
                    </span>
                    <span className="ads-browser__thumb">
                      {src ? <img src={src} alt="" draggable={false} /> : <Package size={16} />}
                    </span>
                    <span className="ads-browser__main">
                      <span className="ads-browser__name">{p.name}</span>
                      <span className="ads-browser__sub muted">
                        {p.sku}
                        {p.categoryName ? ` · ${p.categoryName}` : ''}
                        {!p.imageUrl && ` · ${t('ads.browserNoPhoto')}`}
                      </span>
                    </span>
                    <span className="ads-browser__tags">
                      {already && <Badge tone="info">{t('ads.browserAlready')}</Badge>}
                      {p.trackStock && p.stockMilli <= 0 && (
                        <Badge tone="warning">{t('ads.browserOutOfStock')}</Badge>
                      )}
                    </span>
                    <span className="ads-browser__price num">
                      {p.promoPriceCents !== null ? (
                        <>
                          <s className="muted">{fmt.money(p.sellingPriceCents)}</s>{' '}
                          <strong className="text-success">{fmt.money(p.promoPriceCents)}</strong>
                        </>
                      ) : (
                        fmt.money(p.sellingPriceCents)
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
