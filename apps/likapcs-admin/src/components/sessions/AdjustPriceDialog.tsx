/**
 * 0.27.0: change the price of a PC bill that is already paid. A lower price gives the difference
 * back (from the cash drawer for cash, or the card terminal); a higher one takes the difference in.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { parseMoneyInput, type AdjustPriceResult, type AdjustPriceRequest } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Alert, Button, Dialog, Field, Input } from '../ui/primitives';

type Mode = 'fixed' | 'discount';
type Method = AdjustPriceRequest['method'];
const METHODS: Method[] = ['cash', 'card', 'bank_transfer', 'other'];

export function AdjustPriceDialog({
  sessionId,
  stationCode,
  currentCents,
  paidCents,
  onClose,
  onDone,
}: {
  sessionId: string;
  stationCode: string;
  /** The bill's time price right now. */
  currentCents: number;
  /** What the customer has paid for the sale (net of refunds). */
  paidCents: number;
  onClose: () => void;
  onDone: (result: AdjustPriceResult) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('fixed');
  const [method, setMethod] = useState<Method>('cash');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const amountCents = amount.trim() ? parseMoneyInput(amount) : null;
  const amountValid = amountCents !== null && amountCents >= 0;
  const target =
    amountValid && amountCents !== null
      ? mode === 'fixed'
        ? amountCents
        : currentCents - amountCents
      : null;
  const delta = target === null ? null : target - currentCents;
  const valid = amountValid && target !== null && target >= 0 && delta !== 0;

  const save = useMutation({
    mutationFn: () =>
      api<AdjustPriceResult>(`/sessions/${sessionId}/adjust-price`, {
        method: 'POST',
        body: { mode, amountCents: amountCents ?? 0, method, reason: reason.trim() || undefined },
      }),
    onSuccess: (result) => {
      toast.success(t('adjustPrice.saved'));
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      onDone(result);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={`${t('adjustPrice.title')} · ${stationCode}`}
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
            data-testid="adjust-price-confirm"
          >
            <Wallet size={14} /> {t('adjustPrice.confirm')}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !save.isPending) save.mutate();
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          {t('adjustPrice.hint')}
        </p>
        <div className="grid grid--2">
          <div>
            <div className="faint">{t('adjustPrice.current')}</div>
            <strong>{fmt.money(currentCents)}</strong>
          </div>
          <div>
            <div className="faint">{t('adjustPrice.paid')}</div>
            <strong>{fmt.money(paidCents)}</strong>
          </div>
        </div>
        <div role="group" aria-label={t('map.settleMode')} style={{ display: 'flex', gap: 8 }}>
          <Button
            size="sm"
            aria-pressed={mode === 'fixed'}
            variant={mode === 'fixed' ? 'primary' : 'default'}
            onClick={() => setMode('fixed')}
          >
            {t('map.settleFixed')}
          </Button>
          <Button
            size="sm"
            aria-pressed={mode === 'discount'}
            variant={mode === 'discount' ? 'primary' : 'default'}
            onClick={() => setMode('discount')}
          >
            {t('map.settleDiscount')}
          </Button>
        </div>
        <Field
          label={mode === 'fixed' ? t('map.settleAmountFixed') : t('map.settleAmountDiscount')}
        >
          {(id) => (
            <Input
              id={id}
              inputMode="decimal"
              value={amount}
              placeholder="0.00"
              style={{ maxWidth: 200 }}
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        {target !== null && (
          <Alert tone={delta !== null && delta < 0 ? 'warning' : 'info'}>
            {t('adjustPrice.newPrice')}: <strong>{fmt.money(target)}</strong> ·{' '}
            {delta === 0 || delta === null
              ? t('adjustPrice.noChange')
              : delta < 0
                ? t('adjustPrice.giveBack', { amount: fmt.money(-delta) })
                : t('adjustPrice.takeIn', { amount: fmt.money(delta) })}
          </Alert>
        )}
        <Field label={t('adjustPrice.method')}>
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
        {delta !== null && delta < 0 && method === 'cash' && (
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            {t('adjustPrice.noShift')}
          </p>
        )}
        <Field label={t('adjustPrice.reason')}>
          {(id) => (
            <Input
              id={id}
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
