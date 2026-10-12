/**
 * Ads — what the customer PCs show while locked (Admin › Ads, `/ads`).
 *
 * The owner curates the slideshow: product ads (optionally with a promo price that the POS then
 * charges automatically — the server derives it, see `ACTIVE_PROMO_SQL`) and custom slides
 * (title, text, picture). Each ad has a badge, a schedule, an on/off switch and a manual order
 * (drag, or the arrow buttons). The master switch (`client.ads_enabled`) and the look (layout,
 * interval, transition) stay under Settings › Client screen; this page links there.
 *
 * Every change is pushed to the PCs by the server (`server.display`) — no restart anywhere.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  ImageIcon,
  Megaphone,
  Package,
  Pencil,
  Plus,
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
  ProductSummary,
  SettingsMap,
} from '@likapcs/shared';
import { PERMISSIONS, parseMoneyInput } from '@likapcs/shared';
import { ProductImageField, type PendingImage } from '../components/catalog/ProductImageField';
import { ProductPicker } from '../components/catalog/ProductPicker';
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
  const addAll = useMutation({
    mutationFn: () => api<AdBulkResult>('/ads/products/all', { method: 'POST' }),
    onSuccess: (r) => {
      invalidate();
      toast.success(r.created > 0 ? t('ads.addedAll', { n: r.created }) : t('ads.addedAllNone'));
    },
    onError,
  });

  const [dialog, setDialog] = useState<{ kind: AdKind; ad: AdSummary | null } | null>(null);
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
                onClick={() => setDialog({ kind: 'product', ad: null })}
                data-testid="ads-add-product"
              >
                <Plus size={16} /> {t('ads.addProduct')}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="ads-master" data-testid="ads-master">
        <div className="ads-master__text">
          <Megaphone size={18} />
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
                  <Button
                    variant="primary"
                    onClick={() => setDialog({ kind: 'product', ad: null })}
                  >
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
                  <span className="ads-row__thumb">
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
                    </span>
                    <span className="ads-row__sub muted">
                      {a.kind === 'product'
                        ? `${t('ads.kindProduct')}${a.productSku ? ` · ${a.productSku}` : ''}`
                        : a.body || t('ads.kindCustom')}
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

      {dialog && (
        <AdDialog
          kind={dialog.kind}
          ad={dialog.ad}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            invalidate();
            setSelectedId(saved.id);
            setDialog(null);
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
    <div className={`ad-preview ${src ? '' : 'ad-preview--text'}`} data-testid="ad-preview">
      {src ? <img src={src} alt="" draggable={false} /> : <div className="ad-preview__blank" />}
      {ad.badge && <span className="ad-preview__badge">{ad.badge}</span>}
      <div className="ad-preview__caption">
        <strong>{name}</strong>
        {ad.kind === 'custom' && ad.body && <span>{ad.body}</span>}
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
  onClose,
  onSaved,
}: {
  kind: AdKind;
  ad: AdSummary | null;
  onClose: () => void;
  onSaved: (ad: AdSummary) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const [product, setProduct] = useState<{ id: string; name: string; priceCents: number } | null>(
    ad?.productId
      ? { id: ad.productId, name: ad.productName ?? '', priceCents: ad.productPriceCents ?? 0 }
      : null,
  );
  const [form, setForm] = useState({
    title: ad?.title ?? '',
    body: ad?.body ?? '',
    promo: ad?.promoPriceCents != null ? (ad.promoPriceCents / 100).toFixed(2) : '',
    badge: ad?.badge ?? '',
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
  const valid =
    !promoInvalid && !promoNotBelow && !windowInvalid && !titleMissing && !productMissing;
  const discountPct =
    promoCents !== null && product && product.priceCents > 0 && promoCents < product.priceCents
      ? Math.round((1 - promoCents / product.priceCents) * 100)
      : null;

  useEffect(() => setError(null), [form, product]);

  const save = useMutation({
    mutationFn: async (): Promise<AdSummary> => {
      const common = {
        body: kind === 'custom' ? form.body.trim() || null : null,
        badge: form.badge.trim() || null,
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
      onSaved(saved);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={
        ad ? t('ads.editTitle') : kind === 'product' ? t('ads.addProduct') : t('ads.addCustom')
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
        {kind === 'product' && (
          <Field label={t('ads.product')} className="span-2">
            {(id) =>
              product ? (
                <div className="ads-picked" data-testid="ad-picked-product">
                  <Package size={16} />
                  <strong>{product.name}</strong>
                  <span className="muted num">{fmt.money(product.priceCents)}</span>
                  {!ad && (
                    <Button size="sm" variant="ghost" onClick={() => setProduct(null)}>
                      {t('ads.changeProduct')}
                    </Button>
                  )}
                </div>
              ) : (
                <ProductPicker
                  id={id}
                  autoFocus
                  onPick={(p: ProductSummary) =>
                    setProduct({ id: p.id, name: p.name, priceCents: p.sellingPriceCents })
                  }
                />
              )
            }
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
        {kind === 'custom' && (
          <Field label={t('ads.bodyField')} hint={t('ads.bodyHint')} className="span-2" optional>
            {(id) => (
              <Textarea
                id={id}
                rows={3}
                maxLength={300}
                value={form.body}
                onChange={(e) => set('body', e.target.value)}
                data-testid="ad-body"
              />
            )}
          </Field>
        )}
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
