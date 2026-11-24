/**
 * 0.36.0 — offers at the till: products and PC minutes sold together at one price
 * ("Coca-Cola + 60 min").
 *
 * - `useOffers`: the offers on sale (the POS tiles, the Stations action).
 * - `OfferSellDialog`: the Stations page sells an offer for the selected PC right there.
 * - `announceOfferStarts`: says what happened to the minutes once the sale was paid.
 * - `announceOfferWaiting` (0.36.1): the POS sells an offer with one click — its minutes wait at
 *   the desk as paid time and are given when a PC is started or gets more time.
 *
 * The server opens an offer up into its products and its PC time; nothing here decides a price.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Tags } from 'lucide-react';
import { useState } from 'react';
import {
  PERMISSIONS,
  type CustomerSummary,
  type OfferStartResult,
  type OfferSummary,
  type ReceiptData,
  type SaleDetail,
  type StationSummary,
} from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { useEnterSubmits } from '../../lib/enter-submit';
import { useFormat } from '../../lib/format';
import { useAuth } from '../../state/auth';
import { useShiftGuard } from '../../state/shift-guard';
import { useToast } from '../../state/toast';
import { TenderPanel, useTender } from '../payments/TenderPanel';
import { Button, Dialog, Kbd, Loading } from '../ui/primitives';
import { SaleDoneDialog } from './SaleDoneDialog';

export const OFFERS_KEY = ['offers'] as const;

/** The offers on sale (or all of them, for the Products page). Empty for who may not see them. */
export function useOffers(scope: 'active' | 'all' = 'active') {
  const { can } = useAuth();
  const allowed = can(PERMISSIONS.POS_SELL) || can(PERMISSIONS.PRODUCTS_VIEW);
  return useQuery({
    queryKey: [...OFFERS_KEY, scope],
    queryFn: async () =>
      (
        await api<{ items: OfferSummary[] }>('/offers', {
          // 0.37.0: the till and the Stations page show neither the profit nor what an offer has
          // sold — they ask without them (the server then skips reading the offers' sale lines).
          query: scope === 'active' ? { active: true, money: false } : {},
        })
      ).items,
    enabled: allowed,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

const whole = (quantityMilli: number): string =>
  quantityMilli % 1000 === 0 ? String(quantityMilli / 1000) : (quantityMilli / 1000).toFixed(3);

/** What an offer holds, in words: "2× Coca-Cola · Tost · 60 min". */
export function offerContents(offer: OfferSummary): string {
  const parts = offer.items.map((i) =>
    i.quantityMilli === 1000 ? i.name : `${whole(i.quantityMilli)}× ${i.name}`,
  );
  if (offer.minutes > 0) parts.push(`${offer.minutes} min`);
  return parts.join(' · ');
}

type Translate = ReturnType<typeof useI18n>['t'];
type Toasts = ReturnType<typeof useToast>;

/** After a sale with an offer for a PC: one toast per PC — started, extended, or kept as paid. */
export function announceOfferStarts(
  starts: readonly OfferStartResult[] | undefined,
  toast: Toasts,
  t: Translate,
): void {
  for (const s of starts ?? []) {
    const vars = { pc: s.stationCode, minutes: s.minutes };
    if (s.result === 'started') toast.success(t('offers.started', vars));
    else if (s.result === 'extended') toast.success(t('offers.extended', vars));
    else toast.error(t('offers.kept', vars), t('offers.keptHint'));
  }
}

/** Query keys a sale with an offer changes: the PC it started, the stock, the money. */
const AFTER_OFFER_SALE = [
  ['stations'],
  ['sessions'],
  ['time-credits'],
  ['products'],
  ['sales'],
  ['cash'],
  ['dashboard'],
  [...OFFERS_KEY],
] as const;

export function refreshAfterOfferSale(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const key of AFTER_OFFER_SALE) void queryClient.invalidateQueries({ queryKey: [...key] });
}

/**
 * 0.36.1: an offer is sold with one click and nothing is asked. Its PC minutes wait at the desk
 * as paid time: say so once the sale is paid, so the cashier knows where they went.
 */
export function announceOfferWaiting(
  lines: readonly { offer: Pick<OfferSummary, 'minutes'>; quantityMilli: number }[],
  toast: Toasts,
  t: Translate,
): void {
  const timed = lines.filter((l) => l.offer.minutes > 0);
  if (timed.length === 0) return;
  const count = timed.reduce((n, l) => n + Math.round(l.quantityMilli / 1000), 0);
  const first = timed[0]!.offer.minutes;
  const sameMinutes = timed.every((l) => l.offer.minutes === first);
  toast.success(
    count === 1 || sameMinutes
      ? t(count === 1 ? 'offers.waitingOne' : 'offers.waitingMany', { minutes: first, n: count })
      : t('offers.waitingMixed', { n: count }),
    t('offers.waitingHint'),
  );
}

/**
 * The Stations page: an offer for the selected PC, sold on the spot — pick the offer, take the
 * money, and the PC starts (or its session gets the minutes) with the same answer.
 */
export function OfferSellDialog({
  station,
  onClose,
}: {
  station: Pick<StationSummary, 'id' | 'code' | 'name'>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  const offers = useOffers('active');
  // The action is about this PC: only offers that hold minutes (the others are sold at the POS).
  const list = (offers.data ?? []).filter((o) => o.minutes > 0);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked = list.find((o) => o.id === pickedId) ?? (list.length === 1 ? list[0]! : null);
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  // One id per chosen offer: pressing again after a lost answer never sells twice.
  const [requestIds] = useState(() => new Map<string, string>());
  const requestIdOf = (offerId: string): string => {
    const known = requestIds.get(offerId);
    if (known) return known;
    const made = crypto.randomUUID();
    requestIds.set(offerId, made);
    return made;
  };
  const total = picked?.priceCents ?? 0;
  const tender = useTender({ totalCents: total, customer });

  const sell = useMutation({
    mutationFn: async (offer: OfferSummary) => {
      const sale = await api<SaleDetail>('/sales', {
        method: 'POST',
        body: {
          items: [{ offerId: offer.id, stationId: station.id }],
          discountCents: 0,
          customerId: customer?.id ?? null,
          payments: tender.payments,
          clientRequestId: requestIdOf(offer.id),
        },
      });
      return { sale, receipt: await api<ReceiptData>(`/sales/${sale.id}/receipt`) };
    },
    onSuccess: ({ sale, receipt: data }) => {
      refreshAfterOfferSale(queryClient);
      announceOfferStarts(sale.offerStarts, toast, t);
      setReceipt(data);
    },
    onError: (err) => {
      if (picked && shiftGuard.handle(err, () => sell.mutate(picked))) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const ready = !!picked && picked.available && tender.covered && !sell.isPending;
  const submit = () => {
    if (ready && picked && !receipt) sell.mutate(picked);
  };
  useEnterSubmits(submit);

  if (receipt) return <SaleDoneDialog receipt={receipt} onFinish={onClose} />;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={t('offers.sellTitle', { pc: station.name })}
      description={t('offers.sellBody')}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            loading={sell.isPending}
            disabled={!ready}
            onClick={submit}
            data-testid="offer-sale-confirm"
          >
            <Tags size={14} /> {t('offers.sell', { amount: fmt.money(total) })} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack" data-testid="offer-sale">
        {offers.isLoading && <Loading />}
        {offers.isSuccess && list.length === 0 && <p className="muted">{t('offers.none')}</p>}
        {list.length > 0 && (
          <div className="offer-list" role="radiogroup" aria-label={t('offers.title')}>
            {list.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={picked?.id === o.id}
                className="offer-row"
                disabled={!o.available}
                onClick={() => setPickedId(o.id)}
                data-testid="offer-sale-item"
              >
                <span className="offer-row__text">
                  <strong>{o.name}</strong>
                  <span className="faint">
                    {o.available ? offerContents(o) : t('offers.unavailable')}
                  </span>
                </span>
                <strong className="num">{fmt.money(o.priceCents)}</strong>
              </button>
            ))}
          </div>
        )}
        {picked && (
          <TenderPanel
            key={picked.id}
            tender={tender}
            onSubmit={submit}
            onCustomerChange={setCustomer}
            testId="offer-sale"
          />
        )}
      </div>
    </Dialog>
  );
}
