/**
 * PC time sold at the till to a name, with no PC chosen (0.20.8). The name is the customer's (or
 * typed; empty means "Klient"). The price is the rule that applies to every PC right now — the
 * server quotes it again when the sale is made. After the sale a 4-digit PIN is shown once: at any
 * PC the customer types the name and the PIN, and the minutes start there.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { Button, Dialog, Field, Input, Kbd } from '../ui/primitives';

export interface TimeItemPick {
  /** Null: the name is the customer's, else "Klient" (decided by the server). */
  holderName: string | null;
  minutes: number;
  unitPriceCents: number;
}

interface TimeQuote {
  minutes: number;
  priceCents: number;
  rule: string | null;
  rateCentsPerHour: number | null;
}

const PRESETS = [30, 60, 90, 120];

export function TimeItemDialog({
  customerName,
  onClose,
  onAdd,
}: {
  customerName?: string | null;
  onClose: () => void;
  onAdd: (item: TimeItemPick) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [nameText, setNameText] = useState(customerName ?? '');
  const [minutesText, setMinutesText] = useState('60');
  const [error, setError] = useState<string | null>(null);

  const minutes = Number.parseInt(minutesText, 10);
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;

  const quote = useQuery({
    queryKey: ['pos', 'time-quote', minutes],
    queryFn: () => api<TimeQuote>('/sales/time-quote', { query: { minutes } }),
    enabled: valid,
    staleTime: 15_000,
    retry: false,
  });

  const submit = () => {
    if (!valid) return setError(t('pos.timeItemInvalid'));
    if (!quote.data) return;
    onAdd({
      holderName: nameText.trim() || null,
      minutes,
      unitPriceCents: quote.data.priceCents,
    });
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  const quoteError = quote.error instanceof Error ? quote.error.message : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('pos.timeItem')}
      description={t('pos.timeItemHint')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!valid || !quote.data}
            data-testid="time-item-add"
          >
            <Clock size={14} /> {t('pos.timeItemAdd')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('pos.timeItemName')}>
          {(id) => (
            <Input
              id={id}
              value={nameText}
              maxLength={80}
              placeholder={t('pos.timeItemNameHint')}
              onChange={(e) => {
                setNameText(e.target.value);
                setError(null);
              }}
              onKeyDown={onEnter}
              data-testid="time-item-name"
            />
          )}
        </Field>
        <Field label={t('pos.timeItemMinutes')} error={error ?? undefined}>
          {(id) => (
            <Input
              id={id}
              inputMode="numeric"
              value={minutesText}
              onChange={(e) => {
                setMinutesText(e.target.value.replace(/[^0-9]/g, '').slice(0, 4));
                setError(null);
              }}
              onKeyDown={onEnter}
              data-testid="time-item-minutes"
            />
          )}
        </Field>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={minutes === p ? 'primary' : 'ghost'}
              onClick={() => {
                setMinutesText(String(p));
                setError(null);
              }}
            >
              {p}
            </Button>
          ))}
        </div>
        <div className="row row--between" data-testid="time-item-quote">
          <span className="muted">{t('pos.timeItemQuote')}</span>
          <span className="num">
            {quote.data
              ? fmt.money(quote.data.priceCents)
              : quoteError
                ? t('pos.timeItemNoRule')
                : valid
                  ? '…'
                  : '—'}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
