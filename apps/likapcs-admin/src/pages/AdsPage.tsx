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
  Check,
  GripVertical,
  ImageIcon,
  Megaphone,
  Package,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import type {
  AdBulkResult,
  AdInput,
  AdKind,
  AdPatch,
  AdSummary,
  AdTheme,
  CategorySummary,
  ProductSummary,
  SettingsMap,
} from '@likapcs/shared';
import {
  AD_DURATION_MAX_SECONDS,
  AD_DURATION_MIN_SECONDS,
  AD_THEMES,
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
                  <span className="ads-row__when muted">{scheduleText(a)}</span>
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
              {selected ? <AdPreview ad={selected} /> : null}
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
function AdPreview({ ad }: { ad: AdSummary }) {
  const fmt = useFormat();
  const promo =
    ad.kind === 'product' &&
    ad.promoPriceCents !== null &&
    ad.productPriceCents !== null &&
    ad.promoPriceCents < ad.productPriceCents;
  const name = ad.kind === 'product' ? ad.productName : ad.title;
  const src = fileUrl(ad.imageUrl);
  return (
    <div
      className={`ad-preview ${src ? '' : 'ad-preview--text'}`}
      style={themeStyle(ad.theme)}
      data-testid="ad-preview"
      data-theme={ad.theme ?? 'midnight'}
    >
      {src ? <img src={src} alt="" draggable={false} /> : <div className="ad-preview__blank" />}
      {ad.badge && <span className="ad-preview__badge">{ad.badge}</span>}
      <div className="ad-preview__caption">
        <strong>{name}</strong>
        {ad.body && <span>{ad.body}</span>}
        {ad.kind === 'product' && ad.productPriceCents !== null && (
          <span className="ad-preview__price">
            {promo && <s>{fmt.money(ad.productPriceCents)}</s>}
            <b>{fmt.money(promo ? ad.promoPriceCents! : ad.productPriceCents)}</b>
          </span>
        )}
      </div>
    </div>
  );
}

function AdDialog({
  kind,
  ad,
  product: initialProduct,
  defaultIntervalSeconds,
  onClose,
  onSaved,
}: {
  kind: AdKind;
  ad: AdSummary | null;
  /** New product ad: the product chosen in the browser. */
  product: ProductSummary | null;
  defaultIntervalSeconds: number;
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
  });
  const [pendingImage, setPendingImage] = useState<PendingImage>(null);
  const [error, setError] = useState<string | null>(null);
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
    !durationInvalid;
  const discountPct =
    promoCents !== null && product && product.priceCents > 0 && promoCents < product.priceCents
      ? Math.round((1 - promoCents / product.priceCents) * 100)
      : null;

  useEffect(() => setError(null), [form]);

  const save = useMutation({
    mutationFn: async (): Promise<AdSummary> => {
      const common = {
        body: form.body.trim() || null,
        badge: form.badge.trim() || null,
        theme: form.theme === 'midnight' ? null : form.theme,
        durationSeconds,
        startsAt: startIso,
        endsAt: endIso,
        enabled: form.enabled,
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
