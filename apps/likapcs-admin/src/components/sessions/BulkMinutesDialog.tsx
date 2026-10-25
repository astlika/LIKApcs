/**
 * 0.18.0: "+ minutes" for every selected PC at once. 0.18.1: paid mode is ONE tender step for the
 * whole batch — the prepaid bills (each PC quoted by its own pricing rule) are paid with one
 * tender panel, and the server splits it across the bills (`allocatePayments`). End-pay sessions
 * in the selection get their time added to the bill collected at their end (nothing taken now).
 * Gift mode (`stations.gift`, owner/admin) adds free minutes to prepaid and end-pay sessions —
 * the gift never raises the bill (end-pay bills are capped at the reserved amount).
 * The server applies it station by station and reports exactly what happened where.
 */
import { useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Gift, Plus } from 'lucide-react';
import {
  PERMISSIONS,
  type BulkMinutesResult,
  type GamingPackageSummary,
  type SalePaymentInput,
  type SessionQuoteResponse,
  type StationSummary,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useEnterSubmits } from '../../lib/enter-submit';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { Button, Dialog, Field, Input, Kbd } from '../ui/primitives';
import { bulkEligibility } from '../../lib/bulk-eligibility';
import { TenderPanel, useTender } from '../payments/TenderPanel';

function BulkPreview({ stations }: { stations: StationSummary[] }) {
  const { t } = useI18n();
  const { will, wont } = bulkEligibility(stations);
  return (
    <div className="bulk-preview" data-testid="bulk-preview">
      <div>
        <strong>{t('map.bulkWillGet', { n: will.length })}</strong>{' '}
        <span>{will.map((s) => s.code).join(', ') || '—'}</span>
      </div>
      {wont.length > 0 && (
        <div className="faint">
          <strong>{t('map.bulkWontGet', { n: wont.length })}</strong>{' '}
          <span>
            {wont
              .map(
                (w) =>
                  `${w.station.code} (${t(w.reason === 'postpaid' ? 'map.skipPostpaid' : 'map.skipNoSession')})`,
              )
              .join(', ')}
          </span>
        </div>
      )}
    </div>
  );
}

export function BulkMinutesDialog({
  stations,
  onClose,
  onDone,
}: {
  stations: StationSummary[];
  onClose: () => void;
  /** The parent summarises the per-PC outcome in one toast and refreshes the map. */
  onDone: (result: BulkMinutesResult, gift: boolean) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canGift = can(PERMISSIONS.STATIONS_GIFT);
  const [gift, setGift] = useState(false);
  const [minutes, setMinutes] = useState('15');
  const [packageId, setPackageId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  // Set when the batch has prepaid bills to pay: the tender step replaces the form.
  const [pending, setPending] = useState(false);

  const minutesValue = Number.parseInt(minutes, 10);
  const minutesValid = Number.isInteger(minutesValue) && minutesValue > 0 && minutesValue <= 1440;
  const body = packageId ? { packageId } : minutesValid ? { minutes: minutesValue } : null;

  const packages = useQuery({
    queryKey: ['pricing', 'packages', 'available'],
    queryFn: () => api<GamingPackageSummary[]>('/pricing/packages'),
    staleTime: 30_000,
  });
  // One quote per selected PC — stations may price differently.
  const quotes = useQueries({
    queries: stations.map((s) => ({
      queryKey: ['sessions', 'quote', s.id, body],
      queryFn: () =>
        api<SessionQuoteResponse>('/sessions/quote', {
          method: 'POST',
          body: { stationId: s.id, billingMode: 'prepaid', ...body },
        }),
      enabled: body !== null && !gift,
      staleTime: 30_000,
    })),
  });
  // Only prepaid sessions pay now; end-pay sessions take nothing now (their time joins the bill).
  const bills = stations.flatMap((s, i) => {
    const cents = quotes[i]?.data?.priceCents ?? 0;
    return s.activeSession?.billingMode === 'prepaid' && cents > 0 ? [{ code: s.code, cents }] : [];
  });
  const estimate = bills.reduce((sum, b) => sum + b.cents, 0);
  const quotesLoading = !gift && body !== null && quotes.some((q) => q.isFetching);

  const apply = useMutation({
    mutationFn: (payments: SalePaymentInput[] | undefined) =>
      api<BulkMinutesResult>('/sessions/bulk-minutes', {
        method: 'POST',
        body: {
          stationIds: stations.map((s) => s.id),
          gift,
          ...(packageId ? { packageId } : { minutes: minutesValue }),
          reason: gift && reason.trim() ? reason.trim() : undefined,
          ...(payments ? { payments } : {}),
        },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      onDone(result, gift);
    },
    onError: (err) => {
      setPending(false);
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });

  const choose = () => {
    if (!body || apply.isPending || quotesLoading || pending) return;
    if (gift || estimate <= 0) {
      apply.mutate(gift ? undefined : []);
      return;
    }
    setPending(true);
  };
  useEnterSubmits(choose);

  if (pending) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('map.bulkTitle', { n: stations.length })}
        description={t('map.bulkTenderHint')}
        size="md"
      >
        <ul className="bulk-bills" data-testid="bulk-minutes-bills">
          {bills.map((b) => (
            <li key={b.code}>
              <span>{b.code}</span>
              <strong>{fmt.money(b.cents)}</strong>
            </li>
          ))}
        </ul>
        <BulkMinutesTender
          totalCents={estimate}
          busy={apply.isPending}
          onBack={() => setPending(false)}
          onConfirm={(payments) => apply.mutate(payments)}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={gift ? t('map.bulkGiftTitle') : t('map.bulkTitle', { n: stations.length })}
      description={t('map.bulkBody')}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            loading={apply.isPending}
            disabled={!body || quotesLoading}
            onClick={choose}
            data-testid="bulk-minutes-confirm"
          >
            {gift ? <Gift size={14} /> : <Plus size={14} />}{' '}
            {gift ? t('map.bulkGiftApply') : t('map.bulkApply')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <BulkPreview stations={stations} />
        <div className="chips">
          {(packages.data ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              className="chip"
              aria-pressed={packageId === p.id}
              onClick={() => setPackageId(p.id)}
            >
              <strong>{p.name}</strong> · {p.durationMinutes} min · {fmt.money(p.priceCents)}
            </button>
          ))}
          {[5, 15, 30, 60].map((m) => (
            <button
              key={m}
              type="button"
              className="chip"
              aria-pressed={packageId === null && minutes === String(m)}
              onClick={() => {
                setPackageId(null);
                setMinutes(String(m));
              }}
            >
              {m} min
            </button>
          ))}
        </div>
        <Field label={t('sessions.customMinutes')}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={1440}
              value={minutes}
              style={{ maxWidth: 160 }}
              onChange={(e) => {
                setPackageId(null);
                setMinutes(e.target.value);
              }}
              data-testid="bulk-minutes-input"
            />
          )}
        </Field>
        {canGift && (
          <label
            className="row"
            style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}
            data-testid="bulk-gift-toggle"
          >
            <input type="checkbox" checked={gift} onChange={(e) => setGift(e.target.checked)} />
            <Gift size={14} />
            <strong>{t('map.bulkGift')}</strong>
            <span className="faint" style={{ fontSize: 12 }}>
              {t('map.bulkGiftHint')}
            </span>
          </label>
        )}
        {gift && (
          <Field label={t('sessions.giftReason')}>
            {(id) => (
              <Input
                id={id}
                value={reason}
                maxLength={200}
                placeholder={t('sessions.giftReasonPlaceholder')}
                onChange={(e) => setReason(e.target.value)}
                data-testid="bulk-gift-reason"
              />
            )}
          </Field>
        )}
        <div className="quote">
          <div className="quote__row quote__row--total">
            <span>{gift ? t('map.bulkGiftTotal') : t('map.bulkEstimate')}</span>
            <strong className="num" data-testid="bulk-estimate">
              {fmt.money(gift ? 0 : estimate)}
            </strong>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** The single tender step of a batch: one amount, split across the bills by the server. */
function BulkMinutesTender({
  totalCents,
  busy,
  onBack,
  onConfirm,
}: {
  totalCents: number;
  busy: boolean;
  onBack: () => void;
  onConfirm: (payments: SalePaymentInput[]) => void;
}) {
  const { t } = useI18n();
  // Pay-later and balance need a named customer per bill; a batch of PCs takes cash, card or split.
  const tender = useTender({
    totalCents,
    customer: null,
    allowCredit: false,
    allowWallet: false,
  });
  const submit = () => {
    if (tender.covered && !busy) onConfirm(tender.payments);
  };
  useEnterSubmits(submit);
  return (
    <div className="stack">
      <TenderPanel tender={tender} onSubmit={submit} testId="bulk-minutes" />
      <div className="row row--between" style={{ marginTop: 4 }}>
        <Button onClick={onBack}>
          <ArrowLeft size={14} /> {t('common.back')}
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={!tender.covered}
          loading={busy}
          onClick={submit}
          data-testid="bulk-minutes-pay"
        >
          <Plus size={14} /> {t('map.bulkApply')} <Kbd>Enter</Kbd>
        </Button>
      </div>
    </div>
  );
}
