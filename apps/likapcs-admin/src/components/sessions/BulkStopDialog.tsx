/**
 * 0.19.4: "Ndalo" for every selected PC at once. Nothing is charged here: each running session is
 * stopped and its bill waits at the desk (postpaid and pay-at-the-end — "Pay all" on the PC),
 * prepaid time was already paid, and open orders stay open. The server reports each PC.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import type { BulkEndSessionsResult, StationSummary } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Button, Dialog, Kbd } from '../ui/primitives';

export function BulkStopDialog({
  stations,
  onClose,
  onDone,
}: {
  /** The selected PCs; only those with a running session are stopped. */
  stations: StationSummary[];
  onClose: () => void;
  /** The parent summarises the outcome in one toast and refreshes the map. */
  onDone: (result: BulkEndSessionsResult) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const running = stations.filter((s) => s.activeSession);
  const sessionIds = running.map((s) => s.activeSession!.id);

  const stop = useMutation({
    mutationFn: () =>
      api<BulkEndSessionsResult>('/sessions/bulk-end', {
        method: 'POST',
        body: { sessionIds },
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

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={t('map.stopTitle', { n: running.length })}
      description={t('map.stopBody')}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="danger"
            size="lg"
            loading={stop.isPending}
            disabled={running.length === 0}
            onClick={() => stop.mutate()}
            data-testid="bulk-stop-confirm"
          >
            <Square size={14} /> {t('map.stopConfirm', { n: running.length })}
          </Button>
        </>
      }
    >
      <ul className="bulk-bills" data-testid="bulk-stop-list">
        {running.map((s) => (
          <li key={s.id}>
            <strong>{s.code}</strong>{' '}
            <span className="faint">
              {t(
                s.activeSession!.billingMode === 'prepaid'
                  ? 'map.stopPrepaid'
                  : s.activeSession!.billingMode === 'endpay'
                    ? 'map.stopEndPay'
                    : 'map.stopPostpaid',
              )}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
