/**
 * "Zbrit kohën" for every selected PC at once. The same minutes come off each running session; a
 * session that cannot give that much time (postpaid, too little left) is left as it is and the
 * server reports it. No money moves.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Minus } from 'lucide-react';
import type { BulkRemoveTimeResult, StationSummary } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Button, Dialog, Field, Input, Kbd } from '../ui/primitives';

export function BulkRemoveTimeDialog({
  stations,
  onClose,
  onDone,
}: {
  /** The selected PCs; only those with a running session are changed. */
  stations: StationSummary[];
  onClose: () => void;
  /** The parent summarises the outcome in one toast and refreshes the map. */
  onDone: (result: BulkRemoveTimeResult) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const running = stations.filter((s) => s.activeSession);
  const sessionIds = running.map((s) => s.activeSession!.id);
  const [minutes, setMinutes] = useState(5);
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 24 * 60;

  const remove = useMutation({
    mutationFn: () =>
      api<BulkRemoveTimeResult>('/sessions/bulk-remove-time', {
        method: 'POST',
        body: { sessionIds, minutes },
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      onDone(result);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('map.removeTimeTitle', { n: running.length })}
      description={t('map.removeTimeBody')}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            loading={remove.isPending}
            disabled={!valid || running.length === 0}
            onClick={() => remove.mutate()}
            data-testid="bulk-remove-time-confirm"
          >
            <Minus size={14} /> {t('map.removeTimeConfirm', { n: minutes })}
          </Button>
        </>
      }
    >
      {running.length === 0 ? (
        <p className="muted">{t('map.removeTimeNone')}</p>
      ) : (
        <Field label={t('map.removeTimeLabel')} error={valid ? undefined : t('common.invalid')}>
          {(id, invalid) => (
            <Input
              id={id}
              aria-invalid={invalid || undefined}
              type="number"
              min={1}
              value={String(minutes)}
              style={{ maxWidth: 160 }}
              data-testid="bulk-remove-time-minutes"
              onChange={(e) => setMinutes(Number.parseInt(e.target.value, 10) || 0)}
            />
          )}
        </Field>
      )}
    </Dialog>
  );
}
