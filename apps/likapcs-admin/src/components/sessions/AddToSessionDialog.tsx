/**
 * 0.27.1: the desk adds products to a PC's bill. Unbilled session (running, or ended but not yet
 * collected): the products go onto its bill and are paid with the time. Billed session (prepaid, or
 * already collected): the products are paid now, here, as a sale.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShoppingBag } from 'lucide-react';
import { parseMoneyInput, type ProductSummary, type StationOrder } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Alert, Button, Dialog, Field, Input } from '../ui/primitives';

type Method = 'cash' | 'card' | 'bank_transfer' | 'other';
const METHODS: Method[] = ['cash', 'card', 'bank_transfer', 'other'];

const priceOf = (p: ProductSummary) => p.promoPriceCents ?? p.sellingPriceCents;
const inStock = (p: ProductSummary) => !p.trackStock || p.allowNegativeStock || p.stockMilli > 0;

/** One PC the desk can add products to (0.27.3, the till picks it from a list). */
export interface PcChoice {
  sessionId: string;
  label: string;
  /** Prepaid or already collected: the products are paid now. */
  billed: boolean;
}

export function AddToSessionDialog({
  sessionId,
  billed: billedProp = false,
  choices,
  onClose,
  onDone,
}: {
  /** One PC, whose bill is already known. */
  sessionId?: string;
  /** Prepaid or already collected: the products are paid now. */
  billed?: boolean;
  /** Several PCs: the desk picks one from this list first. */
  choices?: PcChoice[];
  onClose: () => void;
  onDone: (order: StationOrder) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<Method>('cash');
  const [amount, setAmount] = useState('');
  const [pickedId, setPickedId] = useState(choices?.[0]?.sessionId ?? sessionId ?? '');
  const current: PcChoice | undefined = choices
    ? choices.find((c) => c.sessionId === pickedId)
    : sessionId
      ? { sessionId, label: '', billed: billedProp }
      : undefined;
  const targetId = current?.sessionId ?? '';
  const billed = current?.billed ?? false;

  const products = useQuery({
    queryKey: ['products', 'session-add', search],
    queryFn: () =>
      api<{ items: ProductSummary[]; total: number }>('/products', {
        query: { q: search || undefined, pageSize: 200 },
      }),
    staleTime: 15_000,
  });

  const lines = useMemo(
    () =>
      (products.data?.items ?? [])
        .filter((p) => (cart[p.id] ?? 0) > 0)
        .map((p) => ({ product: p, quantity: cart[p.id]!, total: priceOf(p) * cart[p.id]! })),
    [products.data, cart],
  );
  const total = lines.reduce((acc, l) => acc + l.total, 0);
  const amountCents = amount.trim() ? parseMoneyInput(amount) : null;
  const paidNow = billed ? (amountCents ?? total) : 0;
  const valid = lines.length > 0 && !!current && (!billed || paidNow >= total);

  const setQty = (id: string, qty: number) =>
    setCart((c) => ({ ...c, [id]: Math.max(0, Math.min(20, qty)) }));

  const save = useMutation({
    mutationFn: () =>
      api<StationOrder>(`/sessions/${targetId}/orders`, {
        method: 'POST',
        body: {
          items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
          ...(billed ? { payments: [{ method, amountCents: paidNow }] } : {}),
        },
      }),
    onSuccess: (order) => {
      toast.success(t('addItems.added'));
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onDone(order);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t('addItems.title')}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!valid || save.isPending}
            onClick={() => save.mutate()}
            data-testid="add-items-confirm"
          >
            <ShoppingBag size={14} /> {t('addItems.confirm')}
            {lines.length > 0 ? ` · ${fmt.money(total)}` : ''}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          {billed ? t('addItems.hintBilled') : t('addItems.hintOnBill')}
        </p>
        {choices && (
          <Field label={t('addItems.pickPc')}>
            {(id) => (
              <select
                id={id}
                className="input"
                value={pickedId}
                onChange={(e) => setPickedId(e.target.value)}
                data-testid="add-items-pc"
                style={{ maxWidth: 360 }}
              >
                {choices.map((c) => (
                  <option key={c.sessionId} value={c.sessionId}>
                    {c.label} · {c.billed ? t('addItems.tagPaid') : t('addItems.tagOnBill')}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label={t('addItems.search')}>
          {(id) => (
            <Input
              id={id}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="add-items-search"
            />
          )}
        </Field>
        <div style={{ maxHeight: 280, overflowY: 'auto' }} data-testid="add-items-list">
          {products.data?.items.length === 0 && <p className="muted">{t('addItems.empty')}</p>}
          {(products.data?.items ?? []).map((p) => {
            const qty = cart[p.id] ?? 0;
            const available = inStock(p);
            return (
              <div
                key={p.id}
                className="row row--between"
                style={{ padding: '6px 0', borderBottom: '1px solid var(--border, #eee)' }}
              >
                <div>
                  <strong>{p.name}</strong>{' '}
                  <span className="faint num">{fmt.money(priceOf(p))}</span>
                  {!available && <span className="faint"> · {t('addItems.outOfStock')}</span>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Button size="sm" disabled={qty === 0} onClick={() => setQty(p.id, qty - 1)}>
                    −
                  </Button>
                  <span className="num" style={{ minWidth: 24, textAlign: 'center' }}>
                    {qty}
                  </span>
                  <Button
                    size="sm"
                    disabled={!available || qty >= 20}
                    onClick={() => setQty(p.id, qty + 1)}
                  >
                    +
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="row row--between">
          <span className="muted">{t('addItems.total')}</span>
          <strong className="num" data-testid="add-items-total">
            {fmt.money(total)}
          </strong>
        </div>
        {billed && (
          <>
            <Field label={t('addItems.payMethod')}>
              {(id) => (
                <select
                  id={id}
                  className="input"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as Method)}
                  style={{ maxWidth: 240 }}
                >
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`adjustPrice.${m}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('addItems.amount')}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={amount}
                  placeholder={fmt.money(total)}
                  style={{ maxWidth: 200 }}
                  onChange={(e) => setAmount(e.target.value)}
                />
              )}
            </Field>
            {lines.length > 0 && paidNow < total && (
              <Alert tone="warning">{t('addItems.notEnough')}</Alert>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
