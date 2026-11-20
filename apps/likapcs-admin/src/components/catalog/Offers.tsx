/**
 * 0.36.0 — offers on the Products page: products and PC minutes sold together at one price.
 *
 * `OffersCard` lists the offers (on / off the till, change, delete); `OfferDialog` makes or
 * changes one in three fields: the products, the minutes, the price. Opened from a product
 * ("Bëje ofertë") it already holds that product — only the minutes and the price are left.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Tags, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import {
  OFFER_MAX_PRODUCTS,
  multiplyByQuantity,
  offerDefaultName,
  parseMoneyInput,
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
      quantityText: quantityText(i.quantityMilli),
    }));
  return [
    {
      productId: draft.product.id,
      name: draft.product.name,
      unitPriceCents: unitPriceOf(draft.product),
      quantityText: '1',
    },
  ];
}

export function OfferDialog({ draft, onClose }: { draft: OfferDraft; onClose: () => void }) {
  const { t } = useI18n();
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
    setItems((list) => [
      ...list,
      { productId: p.id, name: p.name, unitPriceCents: unitPriceOf(p), quantityText: '1' },
    ]);
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
                  <span className="offer-item__name">{item.name}</span>
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
            items.length > 0
              ? t('offers.priceHint', { amount: fmt.money(productsCents) })
              : undefined
          }
        >
          {(id) => (
            <Input
              id={id}
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

/** The offers, above the products. Hidden for who may not manage them while there are none. */
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
  if (list.length === 0 && !canManage) return null;
  return (
    <section className="card offers-card" data-testid="offers-card">
      <header className="offers-card__head">
        <div>
          <h2 className="offers-card__title">
            <Tags size={16} /> {t('offers.title')}
          </h2>
          <span className="faint">{t('offers.hint')}</span>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => onEdit('new')} data-testid="offer-new">
            <Plus size={14} /> {t('offers.add')}
          </Button>
        )}
      </header>
      {offers.isSuccess && list.length === 0 && <p className="muted">{t('offers.empty')}</p>}
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
