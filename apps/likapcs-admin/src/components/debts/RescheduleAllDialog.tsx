/**
 * "Extend the due date for everything" — one new date for every open debt of a customer
 * (`POST /customers/:id/debts/reschedule`, `customers.manage`). Pre-filled with the default
 * credit period from today so one click + Enter is enough; quick chips for +7 / +14 / +30 days.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import type { DebtRescheduleAllResult } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useAppSettings } from '../../state/app-settings';
import { useToast } from '../../state/toast';
import { dueDateFromToday } from '../payments/TenderPanel';
import { Button, Dialog, Field, Input, Kbd, Textarea } from '../ui/primitives';

const QUICK_DAYS = [7, 14, 30] as const;

export function RescheduleAllDialog({
  customer,
  count,
  onClose,
  onDone,
}: {
  customer: { id: string; name: string };
  /** Open debts of the customer, when known (title only). */
  count?: number;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const defaultDays = useAppSettings()['pos.credit_default_days'];
  const [dueDate, setDueDate] = useState(() => dueDateFromToday(defaultDays));
  const [note, setNote] = useState('');

  const move = useMutation({
    mutationFn: () =>
      api<DebtRescheduleAllResult>(`/customers/${customer.id}/debts/reschedule`, {
        method: 'POST',
        body: { dueDate, notes: note.trim() || undefined },
      }),
    onSuccess: (r) => {
      toast.success(t('debts.rescheduledAll', { n: r.count, date: fmt.date(r.debts[0]!.dueDate) }));
      void queryClient.invalidateQueries({ queryKey: ['debts'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onDone?.();
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const submit = () => {
    if (dueDate && !move.isPending) move.mutate();
  };
  // Enter anywhere in the dialog (except the note) applies the date.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      submit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        count
          ? t('debts.extendAllTitleN', { name: customer.name, n: count })
          : t('debts.extendAllTitle', { name: customer.name })
      }
      description={t('debts.extendAllHint')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!dueDate}
            loading={move.isPending}
            onClick={submit}
            data-testid="debt-extend-all-confirm"
          >
            <CalendarClock size={14} /> {t('debts.extendAllConfirm')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('debts.newDue')}>
          {(id) => (
            <Input
              id={id}
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              autoFocus
              data-testid="debt-extend-all-date"
            />
          )}
        </Field>
        <div className="chips">
          {QUICK_DAYS.map((days) => (
            <button
              key={days}
              type="button"
              className="chip"
              aria-pressed={dueDate === dueDateFromToday(days)}
              onClick={() => setDueDate(dueDateFromToday(days))}
            >
              +{days} {t('debts.days')}
            </button>
          ))}
        </div>
        <Field label={t('common.notes')} optional>
          {(id) => (
            <Textarea id={id} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
