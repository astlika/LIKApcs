/**
 * 0.23.0: a fixed payment or a discount for every selected PC at once. Pay-at-the-end bills are
 * ended and collected with the discount that gives the wanted amount (a running session first
 * waits at the desk, like a bulk stop). Prepaid time was paid at the start, so it is skipped.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import {
  PERMISSIONS,
  parseMoneyInput,
  type BulkSettleRequest,
  type BulkSettleResult,
  type StationSummary,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { Button, Dialog, Field, Input, Kbd } from '../ui/primitives';

type Mode = 'fixed' | 'discount';
type Method = BulkSettleRequest['method'];
const METHODS: Method[] = ['cash', 'card', 'bank_transfer', 'other'];

export function BulkSettleDialog({
  stations,
  onClose,
  onDone,
}: {
  /** The selected PCs; only those with a running or waiting bill are settled. */
  stations: StationSummary[];
  onClose: () => void;
  onDone: (result: BulkSettleResult) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('fixed');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('cash');
  const { can } = useAuth();
  // 0.27.0: prepaid time is already paid; with pos.adjust_paid its price can still be changed.
  const canAdjustPaid = can(PERMISSIONS.POS_ADJUST_PAID);
  const amountCents = amount.trim() ? parseMoneyInput(amount) : null;
  const amountValid = amountCents !== null && amountCents >= 0;

  const billed = stations.filter(
    (s) => s.activeSession && (s.activeSession.billingMode !== 'prepaid' || canAdjustPaid),
  );
  const skipped = stations.filter((s) => s.activeSession && !billed.some((b) => b.id === s.id));
  const sessionIds = billed.map((s) => s.activeSession!.id);

  const settle = useMutation({
    mutationFn: () =>
      api<BulkSettleResult>('/sessions/bulk-settle', {
        method: 'POST',
        body: { sessionIds, mode, amountCents: amountCents ?? 0, method },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onDone(result);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });

  const ready = amountValid && sessionIds.length > 0 && !settle.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('map.settleTitle', { n: billed.length })}
      description={t('map.settleBody')}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            loading={settle.isPending}
            disabled={!ready}
            onClick={() => settle.mutate()}
            data-testid="bulk-settle-confirm"
          >
            <Wallet size={14} /> {t('map.settleConfirm', { n: billed.length })}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div role="group" aria-label={t('map.settleMode')} style={{ display: 'flex', gap: 8 }}>
          <Button
            size="sm"
            aria-pressed={mode === 'fixed'}
            variant={mode === 'fixed' ? 'primary' : 'default'}
            onClick={() => setMode('fixed')}
            data-testid="bulk-settle-mode-fixed"
          >
            {t('map.settleFixed')}
          </Button>
          <Button
            size="sm"
            aria-pressed={mode === 'discount'}
            variant={mode === 'discount' ? 'primary' : 'default'}
            onClick={() => setMode('discount')}
            data-testid="bulk-settle-mode-discount"
          >
            {t('map.settleDiscount')}
          </Button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {mode === 'fixed' ? t('map.settleFixedHint') : t('map.settleDiscountHint')}
        </p>
        {canAdjustPaid && (
          <Field label={t('adjustPrice.method')} hint={t('adjustPrice.hint')}>
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
        )}
        <Field
          label={mode === 'fixed' ? t('map.settleAmountFixed') : t('map.settleAmountDiscount')}
          error={amount.trim() && !amountValid ? t('common.invalid') : undefined}
        >
          {(id, invalid) => (
            <Input
              id={id}
              aria-invalid={invalid || undefined}
              inputMode="decimal"
              value={amount}
              placeholder="0.00"
              style={{ maxWidth: 200 }}
              data-testid="bulk-settle-amount"
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        <ul className="bulk-bills" data-testid="bulk-settle-list">
          {billed.map((s) => (
            <li key={s.id}>
              <strong>{s.code}</strong>{' '}
              <span className="faint">
                {s.activeSession?.billingMode === 'prepaid'
                  ? t('adjustPrice.paidLabel')
                  : t('map.settleWillBill')}
              </span>
            </li>
          ))}
          {skipped.map((s) => (
            <li key={s.id}>
              <strong>{s.code}</strong>{' '}
              <span className="faint">{t('map.settleSkippedPrepaid')}</span>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
