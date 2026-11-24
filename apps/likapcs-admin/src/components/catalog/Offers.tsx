/**
 * 0.36.0 — offers on the Products page: products and PC minutes sold together at one price.
 *
 * `OffersCard` lists the offers (on / off the till, change, delete); `OfferDialog` makes or
 * changes one in three fields: the products, the minutes, the price. Opened from a product
 * ("Bëje ofertë") it already holds that product — only the minutes and the price are left.
 *
 * 0.36.1: "Shto ofertë" sits in the page's header beside "Shto produkt". The form shows the stock
 * of every product picked and, as the price is typed, what one sale of the offer earns (its price
 * without VAT, less what the products cost to buy). The list shows the stock, the profit on one
 * and what each offer has sold so far.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Tags, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  OFFER_MAX_PRODUCTS,
  formatQuantity,
  multiplyByQuantity,
  offerDefaultName,
  parseMoneyInput,
  type OfferPreview,
  type OfferSummary,
  type ProductSummary,
} from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { unitPriceOf } from '../../lib/cart';
import { useFormat } from '../../lib/format';
import { useToast } from '../../state/toast';
import { OFFERS_KEY, offerContents, useOffers } from '../pos/Offers';
import { Badge, Button, ConfirmDialog, Dialog, Field, Input, Kbd, Switch } from '../ui/primitives';
import { ProductPicker } from './ProductPicker';

const MINUTE_PRESETS = [30, 60, 90, 120];

/** What the dialog opens with: an offer to change, or a product to make a new offer from. */
export type OfferDraft = { offer: OfferSummary } | { product: ProductSummary } | 'new';

interface DraftItem {
  productId: string;
  name: string;
  /** What one unit costs outside the offer, tax included. */
  unitPriceCents: number;
  /** What is on the shelf now; null when the product does not count its stock. */
  stockMilli: number | null;
  quantityText: string;
}

const quantityText = (quantityMilli: number): string =>
  quantityMilli % 1000 === 0 ? String(quantityMilli / 1000) : String(quantityMilli / 1000);

/** A typed quantity as milli-units (comma or dot); null when it is not a positive number. */
function parseQuantity(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0 || value > 1000) return null;
  const milli = Math.round(value * 1000);
  return milli >= 1 ? milli : null;
}

function itemsOf(draft: OfferDraft): DraftItem[] {
  if (draft === 'new') return [];
  if ('offer' in draft)
    return draft.offer.items.map((i) => ({
      productId: i.productId,
      name: i.name,
      unitPriceCents: i.unitPriceCents,
      stockMilli: i.stockMilli ?? null,
      quantityText: quantityText(i.quantityMilli),
    }));
  return [draftItemOf(draft.product)];
}

const draftItemOf = (p: ProductSummary): DraftItem => ({
  productId: p.id,
  name: p.name,
  unitPriceCents: unitPriceOf(p),
  stockMilli: p.trackStock ? p.stockMilli : null,
  quantityText: '1',
});

export function OfferDialog({ draft, onClose }: { draft: OfferDraft; onClose: () => void }) {
  const { t, language } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const editing = draft !== 'new' && 'offer' in draft ? draft.offer : null;

  const [items, setItems] = useState<DraftItem[]>(() => itemsOf(draft));
  const [minutesText, setMinutesText] = useState(editing ? String(editing.minutes) : '60');
  const [priceText, setPriceText] = useState(editing ? (editing.priceCents / 100).toFixed(2) : '');
  // The name follows the products and the minutes until it is typed by hand.
  const [typedName, setTypedName] = useState<string | null>(editing ? editing.name : null);
  const [isActive, setIsActive] = useState(editing ? editing.isActive : true);
  const [error, setError] = useState<string | null>(null);
  const priceRef = useRef<HTMLInputElement>(null);

  const minutes = minutesText.trim() === '' ? 0 : Number.parseInt(minutesText, 10);
  const minutesOk = Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440;
  const quantities = items.map((i) => parseQuantity(i.quantityText));
  const quantitiesOk = quantities.every((q) => q !== null);
  const priceCents = priceText.trim() ? parseMoneyInput(priceText) : null;
  const autoName = offerDefaultName(
    items.map((i, k) => ({ name: i.name, quantityMilli: quantities[k] ?? 1000 })),
    minutesOk ? minutes : 0,
  );
  const name = (typedName ?? autoName).trim();
  const productsCents = items.reduce(
    (sum, i, k) => sum + multiplyByQuantity(i.unitPriceCents, quantities[k] ?? 1000),
    0,
  );
  // 0.36.1: the server prices and costs the offer as it stands in the form — the same sums a
  // sale will book — so the profit shown here is the profit the reports will show.
  const priceOk = priceCents !== null && priceCents >= 0 && priceCents <= 100_000_000;
  const previewBody =
    minutesOk && quantitiesOk && (items.length > 0 || minutes > 0)
      ? {
          priceCents: priceOk ? priceCents : 0,
          minutes,
          items: items.map((i, k) => ({ productId: i.productId, quantityMilli: quantities[k]! })),
        }
      : null;
  const preview = useQuery({
    queryKey: [...OFFERS_KEY, 'preview', previewBody],
    queryFn: () => api<OfferPreview>('/offers/preview', { method: 'POST', body: previewBody }),
    enabled: previewBody !== null,
    placeholderData: (prev) => prev,
    staleTime: 5_000,
  });
  const figures = previewBody ? preview.data : undefined;
  const profit = priceOk ? figures?.profit : undefined;
  const separatelyCents = figures ? figures.productsCents + figures.timeCents : productsCents;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name,
        priceCents,
        minutes,
        items: items.map((i, k) => ({ productId: i.productId, quantityMilli: quantities[k] })),
        isActive,
      };
      return editing
        ? api<OfferSummary>(`/offers/${editing.id}`, { method: 'PUT', body })
        : api<OfferSummary>('/offers', { method: 'POST', body });
    },
    onSuccess: () => {
      toast.success(t('offers.saved'));
      void queryClient.invalidateQueries({ queryKey: [...OFFERS_KEY] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const submit = () => {
    if (save.isPending) return;
    if (!minutesOk || !quantitiesOk || (items.length === 0 && minutes === 0))
      return setError(t('offers.needSomething'));
    if (priceCents === null || priceCents < 0) return setError(t('offers.needPrice'));
    if (!name) return setError(t('offers.needSomething'));
    setError(null);
    save.mutate();
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };
  const addProduct = (p: ProductSummary) => {
    setError(null);
    if (items.some((i) => i.productId === p.id)) return setError(t('offers.productTwice'));
    if (items.length >= OFFER_MAX_PRODUCTS)
      return setError(t('offers.maxProducts', { n: OFFER_MAX_PRODUCTS }));
    setItems((list) => [...list, draftItemOf(p)]);
    // The product is chosen: the price is what is left to type.
    if (!priceText.trim()) setTimeout(() => priceRef.current?.focus(), 0);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={editing ? t('offers.editTitle') : t('offers.newTitle')}
      description={t('offers.hint')}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={save.isPending}
            data-testid="offer-save"
          >
            {t('common.save')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack" data-testid="offer-form">
        <Field label={t('offers.products')}>
          {(id) => (
            <div className="stack" style={{ gap: 6 }}>
              {items.length === 0 && <span className="faint">{t('offers.noProducts')}</span>}
              {items.map((item, k) => (
                <div key={item.productId} className="offer-item" data-testid="offer-form-item">
                  <span className="offer-item__name">
                    {item.name}
                    <span
                      className={`offer-item__stock ${
                        item.stockMilli !== null && item.stockMilli <= 0 ? 'text-danger' : 'faint'
                      }`}
                      data-testid="offer-form-stock"
                    >
                      {item.stockMilli === null
                        ? t('offers.stockUntracked')
                        : t('offers.stock', { n: formatQuantity(item.stockMilli, language) })}
                    </span>
                  </span>
                  <span className="faint num">{fmt.money(item.unitPriceCents)}</span>
                  <Input
                    value={item.quantityText}
                    inputMode="decimal"
                    aria-label={t('offers.quantity')}
                    title={t('offers.quantity')}
                    className="offer-item__qty num"
                    onChange={(e) => {
                      const text = e.target.value.replace(/[^0-9.,]/g, '').slice(0, 7);
                      setItems((list) =>
                        list.map((x, n) => (n === k ? { ...x, quantityText: text } : x)),
                      );
                      setError(null);
                    }}
                    onKeyDown={onEnter}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon
                    aria-label={t('common.delete')}
                    title={t('common.delete')}
                    onClick={() => setItems((list) => list.filter((_, n) => n !== k))}
                  >
                    <X size={14} />
                  </Button>
                </div>
              ))}
              {items.length < OFFER_MAX_PRODUCTS && (
                <ProductPicker
                  id={id}
                  onPick={addProduct}
                  placeholder={t('offers.addProduct')}
                  autoFocus={items.length === 0}
                  browse
                  exclude={items.map((i) => i.productId)}
                  keepFocus={false}
                  meta={(p) => (
                    <span
                      className={`num ${p.trackStock && p.stockMilli <= 0 ? 'text-danger' : 'faint'}`}
                    >
                      {p.trackStock
                        ? t('offers.stock', { n: formatQuantity(p.stockMilli, language) })
                        : t('offers.stockUntracked')}
                    </span>
                  )}
                />
              )}
            </div>
          )}
        </Field>
        <Field label={t('offers.minutes')}>
          {(id) => (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <Input
                id={id}
                inputMode="numeric"
                value={minutesText}
                style={{ maxWidth: 90 }}
                className="num"
                onChange={(e) => {
                  setMinutesText(e.target.value.replace(/[^0-9]/g, '').slice(0, 4));
                  setError(null);
                }}
                onKeyDown={onEnter}
                data-testid="offer-form-minutes"
              />
              {MINUTE_PRESETS.map((m) => (
                <Button
                  key={m}
                  size="sm"
                  variant={minutes === m ? 'primary' : 'ghost'}
                  onClick={() => {
                    setMinutesText(String(m));
                    setError(null);
                  }}
                >
                  {m}
                </Button>
              ))}
              <Button
                size="sm"
                variant={minutes === 0 ? 'primary' : 'ghost'}
                onClick={() => {
                  setMinutesText('0');
                  setError(null);
                }}
              >
                {t('offers.noMinutes')}
              </Button>
            </div>
          )}
        </Field>
        <Field
          label={t('offers.price')}
          hint={
            separatelyCents > 0
              ? t('offers.separately', { amount: fmt.money(separatelyCents) })
              : undefined
          }
        >
          {(id) => (
            <Input
              id={id}
              ref={priceRef}
              inputMode="decimal"
              value={priceText}
              placeholder="0.00"
              style={{ maxWidth: 140 }}
              className="num"
              autoFocus={items.length > 0}
              onChange={(e) => {
                setPriceText(e.target.value);
                setError(null);
              }}
              onKeyDown={onEnter}
              data-testid="offer-form-price"
            />
          )}
        </Field>
        {profit && (
          <div className="offer-profit" data-testid="offer-profit">
            <div className="offer-profit__head">
              <span className="muted">{t('offers.profitTitle')}</span>
              <strong
                className={`num offer-profit__value ${
                  profit.profitCents >= 0 ? 'text-success' : 'text-danger'
                }`}
                data-testid="offer-profit-value"
              >
                {fmt.money(profit.profitCents)}
              </strong>
            </div>
            <div className="muted offer-profit__line">
              {profit.vatCents > 0
                ? t('offers.profitBreakdownVat', {
                    net: fmt.money(profit.netCents),
                    cost: fmt.money(profit.costCents),
                    vat: fmt.money(profit.vatCents),
                  })
                : t('offers.profitBreakdown', {
                    net: fmt.money(profit.netCents),
                    cost: fmt.money(profit.costCents),
                  })}
            </div>
            {profit.missingCost.length > 0 && (
              <div className="text-warning offer-profit__line" data-testid="offer-profit-nocost">
                {t('offers.profitMissingCost', { names: profit.missingCost.join(', ') })}
              </div>
            )}
          </div>
        )}
        <Field label={t('offers.name')} hint={t('offers.nameHint')} error={error ?? undefined}>
          {(id) => (
            <Input
              id={id}
              value={typedName ?? autoName}
              maxLength={80}
              onChange={(e) => {
                // Emptied by hand: the name follows the products and the minutes again.
                setTypedName(e.target.value === '' ? null : e.target.value);
                setError(null);
              }}
              onKeyDown={onEnter}
              data-testid="offer-form-name"
            />
          )}
        </Field>
        <Switch
          checked={isActive}
          onChange={setIsActive}
          label={isActive ? t('offers.active') : t('offers.inactive')}
          testId="offer-form-active"
        />
      </div>
    </Dialog>
  );
}

/**
 * The offers, above the products: each with its stock, what one sale of it earns and what it has
 * sold so far. Shown once there is an offer — a new one is added from the page's header
 * ("Shto ofertë", beside "Shto produkt").
 */
export function OffersCard({
  canManage,
  onEdit,
}: {
  canManage: boolean;
  onEdit: (draft: OfferDraft) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const offers = useOffers('all');
  const [deleting, setDeleting] = useState<OfferSummary | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [...OFFERS_KEY] });
  const failed = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));

  const setActive = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) =>
      api<OfferSummary>(`/offers/${v.id}`, { method: 'PATCH', body: { isActive: v.isActive } }),
    onSuccess: refresh,
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/offers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('offers.deleted'));
      setDeleting(null);
      refresh();
    },
    onError: failed,
  });

  const list = offers.data ?? [];
  if (list.length === 0) return null;
  return (
    <section className="card offers-card" data-testid="offers-card">
      <header className="offers-card__head">
        <div>
          <h2 className="offers-card__title">
            <Tags size={16} /> {t('offers.title')}
          </h2>
          <span className="faint">{t('offers.hint')}</span>
        </div>
      </header>
      {list.length > 0 && (
        <div className="offers-card__list">
          {list.map((o) => (
            <div
              key={o.id}
              className={`offers-card__row${o.isActive ? '' : ' offers-card__row--off'}`}
              data-testid="offer-row"
            >
              <div className="offers-card__text">
                <strong>{o.name}</strong>
                <span className="faint">{offerContents(o)}</span>
                <span className="offers-card__figures" data-testid="offer-figures">
                  {o.stockUnits !== null && o.stockUnits !== undefined && (
                    <span
                      className={o.stockUnits <= 0 ? 'text-danger' : undefined}
                      data-testid="offer-stock"
                    >
                      {t('offers.stockUnits', { n: o.stockUnits })}
                    </span>
                  )}
                  {o.profit && (
                    <span
                      className={o.profit.profitCents >= 0 ? 'text-success' : 'text-danger'}
                      title={
                        o.profit.missingCost.length > 0
                          ? t('offers.profitMissingCost', {
                              names: o.profit.missingCost.join(', '),
                            })
                          : undefined
                      }
                      data-testid="offer-profit-each"
                    >
                      {t('offers.profitEach', { amount: fmt.money(o.profit.profitCents) })}
                      {o.profit.missingCost.length > 0 && ' *'}
                    </span>
                  )}
                  {o.sold &&
                    (o.sold.count > 0 ? (
                      <>
                        <span data-testid="offer-sold">
                          {t('offers.soldCount', { n: o.sold.count })}
                        </span>
                        <span>
                          {t('offers.soldRevenue', { amount: fmt.money(o.sold.revenueCents) })}
                        </span>
                        <strong data-testid="offer-sold-profit">
                          {t('offers.soldProfit', { amount: fmt.money(o.sold.profitCents) })}
                        </strong>
                      </>
                    ) : (
                      <span className="faint" data-testid="offer-sold">
                        {t('offers.soldNone')}
                      </span>
                    ))}
                </span>
              </div>
              {o.isActive && !o.available && (
                <Badge tone="warning">{t('offers.unavailable')}</Badge>
              )}
              <strong className="num offers-card__price">{fmt.money(o.priceCents)}</strong>
              {canManage ? (
                <>
                  <Switch
                    checked={o.isActive}
                    onChange={(v) => setActive.mutate({ id: o.id, isActive: v })}
                    label={o.isActive ? t('offers.active') : t('offers.inactive')}
                    disabled={setActive.isPending}
                    testId="offer-active"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon
                    onClick={() => onEdit({ offer: o })}
                    aria-label={t('common.edit')}
                    title={t('common.edit')}
                    data-testid="offer-edit"
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon
                    onClick={() => setDeleting(o)}
                    aria-label={t('common.delete')}
                    title={t('common.delete')}
                    data-testid="offer-delete"
                  >
                    <Trash2 size={14} />
                  </Button>
                </>
              ) : (
                <Badge tone={o.isActive ? 'success' : undefined}>
                  {o.isActive ? t('offers.active') : t('offers.inactive')}
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        title={t('offers.deleteTitle')}
        body={t('offers.deleteBody', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.delete')}
        danger
      />
    </section>
  );
}
