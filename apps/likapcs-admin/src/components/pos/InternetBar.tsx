/**
 * 0.36.0 — the internet packages, always in sight: a slim bar pinned to the bottom of the POS and
 * of the Stations page. At most `INTERNET_BAR_MAX` packages (the owner picks which, in Products),
 * each a button with its name and price — nothing else, and never a code: a code exists for the
 * customer only once it is paid.
 *
 * On the POS a click puts the package in the cart. Anywhere else it opens a small sale right
 * there (quantity, tender), and the code shows in the same "done" window as at the POS.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Wifi } from 'lucide-react';
import { useState } from 'react';
import {
  INTERNET_BAR_MAX,
  PERMISSIONS,
  type CustomerSummary,
  type InternetAccessPackageSummary,
  type ReceiptData,
  type SaleDetail,
} from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { useEnterSubmits } from '../../lib/enter-submit';
import { useFormat } from '../../lib/format';
import { useAuth } from '../../state/auth';
import { useShiftGuard } from '../../state/shift-guard';
import { useToast } from '../../state/toast';
import { TenderPanel, useTender } from '../payments/TenderPanel';
import { Button, Dialog, Kbd } from '../ui/primitives';
import { SaleDoneDialog } from './SaleDoneDialog';

export const INTERNET_PACKAGES_KEY = ['internet-access', 'packages'] as const;

/** The packages the bar shows: the server's choice; an older server gets the first ones. */
export function barPackages(items: InternetAccessPackageSummary[]): InternetAccessPackageSummary[] {
  const active = items.filter((p) => p.product.isActive);
  const flagged = active.some((p) => p.inBar !== undefined);
  return (flagged ? active.filter((p) => p.inBar) : active).slice(0, INTERNET_BAR_MAX);
}

export function InternetBar({
  onPick,
  pinned = false,
}: {
  /** The POS: the package goes into the cart. Without it the bar sells by itself. */
  onPick?: (pkg: InternetAccessPackageSummary) => void;
  /** Stick to the bottom of a scrolling page (the Stations page). */
  pinned?: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const allowed = can(PERMISSIONS.POS_SELL) && can(PERMISSIONS.PRODUCTS_VIEW);
  const packages = useQuery({
    queryKey: INTERNET_PACKAGES_KEY,
    queryFn: () => api<{ items: InternetAccessPackageSummary[] }>('/internet-access/packages'),
    enabled: allowed,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const [selling, setSelling] = useState<InternetAccessPackageSummary | null>(null);
  const shown = barPackages(packages.data?.items ?? []);
  if (!allowed || shown.length === 0) return null;
  return (
    <>
      <div
        className={`inet-bar ${pinned ? 'inet-bar--pinned' : ''}`}
        role="region"
        aria-label={t('internet.barTitle')}
        data-testid="internet-bar"
      >
        <span className="inet-bar__title">
          <Wifi size={15} /> {t('internet.barTitle')}
        </span>
        {shown.map((pkg) => {
          const none = pkg.availableCodes <= 0;
          return (
            <button
              key={pkg.product.id}
              type="button"
              className="inet-bar__item"
              disabled={none}
              title={none ? t('internet.barNoCodes') : undefined}
              onClick={() => (onPick ? onPick(pkg) : setSelling(pkg))}
              data-testid="internet-bar-item"
            >
              <span className="inet-bar__name">{pkg.product.name}</span>
              <strong className="num">
                {none ? t('internet.barNoCodes') : fmt.money(pkg.product.sellingPriceCents)}
              </strong>
            </button>
          );
        })}
      </div>
      {selling && <InternetSaleDialog pkg={selling} onClose={() => setSelling(null)} />}
    </>
  );
}

/** One package, sold on the spot: quantity, tender, and the code once it is paid. */
function InternetSaleDialog({
  pkg,
  onClose,
}: {
  pkg: InternetAccessPackageSummary;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  const max = Math.max(1, Math.min(10, pkg.availableCodes));
  const [quantity, setQuantity] = useState(1);
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  // One id for the whole window: pressing again after a lost answer never sells twice.
  const [requestId] = useState(() => crypto.randomUUID());
  const total = pkg.product.sellingPriceCents * quantity;
  const tender = useTender({ totalCents: total, customer });

  const sell = useMutation({
    mutationFn: async () => {
      const sale = await api<SaleDetail>('/sales', {
        method: 'POST',
        body: {
          items: [{ productId: pkg.product.id, quantityMilli: quantity * 1000, discountCents: 0 }],
          discountCents: 0,
          customerId: customer?.id ?? null,
          payments: tender.payments,
          clientRequestId: requestId,
          // This window shows the codes the sale hands out (the server refuses a till that cannot).
          accessCodes: true,
        },
      });
      return api<ReceiptData>(`/sales/${sale.id}/receipt`);
    },
    onSuccess: (data) => {
      for (const key of [['internet-access'], ['products'], ['sales'], ['cash'], ['dashboard']])
        void queryClient.invalidateQueries({ queryKey: key });
      setReceipt(data);
    },
    onError: (err) => {
      if (shiftGuard.handle(err, () => sell.mutate())) return;
      toast.error(
        err instanceof ApiError
          ? err.status === 0
            ? t('pos.internetRetry')
            : err.message
          : t('common.errorGeneric'),
      );
    },
  });
  const ready = tender.covered && !sell.isPending;
  const submit = () => {
    if (ready && !receipt) sell.mutate();
  };
  useEnterSubmits(submit);

  if (receipt) return <SaleDoneDialog receipt={receipt} onFinish={onClose} />;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={t('internet.barSellTitle', { name: pkg.product.name })}
      description={t('internet.barSellBody')}
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
            data-testid="internet-sale-confirm"
          >
            <Wifi size={14} /> {t('internet.barSell', { amount: fmt.money(total) })}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack" data-testid="internet-sale">
        {max > 1 && (
          <div className="inet-qty" role="group" aria-label={t('internet.barQuantity')}>
            <span className="muted">{t('internet.barQuantity')}</span>
            {Array.from({ length: Math.min(max, 5) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                className="chip"
                aria-pressed={quantity === n}
                onClick={() => setQuantity(n)}
                data-testid="internet-sale-qty"
              >
                {n}
              </button>
            ))}
          </div>
        )}
        <div className="quote">
          <div className="quote__row quote__row--total">
            <span>
              {quantity}× {pkg.product.name}
            </span>
            <strong className="num" data-testid="internet-sale-total">
              {fmt.money(total)}
            </strong>
          </div>
        </div>
        <TenderPanel
          tender={tender}
          onSubmit={submit}
          onCustomerChange={setCustomer}
          testId="internet-sale"
        />
      </div>
    </Dialog>
  );
}
