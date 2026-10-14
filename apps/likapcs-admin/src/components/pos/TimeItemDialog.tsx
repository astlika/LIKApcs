/**
 * 0.19.0: PC time sold now at the till ("cart stations"). The desk picks a PC and minutes; the price
 * is the station's own quote (the server quotes it again when the sale is made). The PC starts later
 * from its station screen, redeeming this sale's credit — no second payment.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import type { SessionQuoteResponse, StationSummary } from '@likapcs/shared';
import { api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { Button, Dialog, Field, Input, Kbd, Select } from '../ui/primitives';

export interface TimeItemPick {
  stationId: string;
  stationCode: string;
  minutes: number;
  unitPriceCents: number;
}

const PRESETS = [30, 60, 90, 120];

export function TimeItemDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (item: TimeItemPick) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [stationPick, setStationPick] = useState('');
  const [minutesText, setMinutesText] = useState('60');
  const [error, setError] = useState<string | null>(null);

  const stations = useQuery({
    queryKey: ['stations'],
    queryFn: () => api<StationSummary[]>('/stations'),
  });
  const choices = (stations.data ?? []).filter((s) => s.isEnabled && !s.archived);
  const stationId = choices.some((s) => s.id === stationPick)
    ? stationPick
    : (choices[0]?.id ?? '');
  const station = choices.find((s) => s.id === stationId) ?? null;

  const minutes = Number.parseInt(minutesText, 10);
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;

  const quote = useQuery({
    queryKey: ['pos', 'time-quote', stationId, minutes],
    queryFn: () =>
      api<SessionQuoteResponse>('/sessions/quote', {
        method: 'POST',
        body: { stationId, billingMode: 'prepaid', minutes },
      }),
    enabled: Boolean(stationId) && valid,
    staleTime: 15_000,
    retry: false,
  });

  const submit = () => {
    if (!station || !valid) return setError(t('pos.timeItemInvalid'));
    if (!quote.data) return;
    onAdd({
      stationId: station.id,
      stationCode: station.code,
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
            disabled={!station || !valid || !quote.data}
            data-testid="time-item-add"
          >
            <Clock size={14} /> {t('pos.timeItemAdd')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        {choices.length === 0 && !stations.isPending && (
          <div className="muted">{t('pos.timeItemNoStations')}</div>
        )}
        <Field label={t('pos.timeItemStation')}>
          {(id) => (
            <Select
              id={id}
              value={stationId}
              onChange={(e) => {
                setStationPick(e.target.value);
                setError(null);
              }}
              data-testid="time-item-station"
            >
              {choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </Select>
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
                ? quoteError
                : valid && stationId
                  ? '…'
                  : '—'}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
