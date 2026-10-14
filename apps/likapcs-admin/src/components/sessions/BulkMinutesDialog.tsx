/**
 * 0.18.0: "+ minutes" for every selected PC at once. Paid mode gives each live session its own
 * cash-paid extension at its quoted price (pricing rules can differ per station, so the estimate
 * is the sum of live quotes); gift mode (`sessions.gift`) adds free minutes — prepaid sessions
 * only, because end-pay/postpaid bill by elapsed time and "free" minutes there would silently
 * become money. The server applies it station by station and reports exactly what happened where.
 */
import { useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Plus } from 'lucide-react';
import {
  PERMISSIONS,
  type BulkMinutesResult,
  type GamingPackageSummary,
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
  const canGift = can(PERMISSIONS.SESSIONS_GIFT);
  const [gift, setGift] = useState(false);
  const [minutes, setMinutes] = useState('15');
  const [packageId, setPackageId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const minutesValue = Number.parseInt(minutes, 10);
  const minutesValid = Number.isInteger(minutesValue) && minutesValue > 0 && minutesValue <= 1440;
  const body = packageId ? { packageId } : minutesValid ? { minutes: minutesValue } : null;

  const packages = useQuery({
    queryKey: ['pricing', 'packages', 'available'],
    queryFn: () => api<GamingPackageSummary[]>('/pricing/packages'),
    staleTime: 30_000,
  });
  // Live estimate: one quote per selected PC — stations may price differently.
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
  const estimate = quotes.reduce((sum, q) => sum + (q.data?.priceCents ?? 0), 0);

  const apply = useMutation({
    mutationFn: () =>
      api<BulkMinutesResult>('/sessions/bulk-minutes', {
        method: 'POST',
        body: {
          stationIds: stations.map((s) => s.id),
          gift,
          ...(packageId ? { packageId } : { minutes: minutesValue }),
          reason: gift && reason.trim() ? reason.trim() : undefined,
        },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      onDone(result, gift);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const submit = () => {
    if (body && !apply.isPending) apply.mutate();
  };
  useEnterSubmits(submit);

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
            disabled={!body}
            onClick={submit}
            data-testid="bulk-minutes-confirm"
          >
            {gift ? <Gift size={14} /> : <Plus size={14} />}{' '}
            {gift ? t('map.bulkGiftApply') : t('map.bulkApply')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
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
