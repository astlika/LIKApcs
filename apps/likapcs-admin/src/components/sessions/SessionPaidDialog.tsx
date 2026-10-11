/**
 * After a session bill was paid (prepaid start / extension, postpaid end) this shows the same
 * "done" dialog as the POS — change due, pay-later note, receipt preview, Print / Finish with the
 * auto-finish countdown — using the receipt of the session's sale. Readable with stations.control
 * alone (`GET /sessions/:id/receipt`), so a station operator without POS rights still gets it.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReceiptData, SessionPaymentSummary } from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { SaleDoneDialog } from '../pos/SaleDoneDialog';
import { Alert, Button, Dialog, Loading } from '../ui/primitives';

export interface SessionPaid {
  sessionId: string;
  payment: SessionPaymentSummary;
}

export function SessionPaidDialog({ paid, onFinish }: { paid: SessionPaid; onFinish: () => void }) {
  const { t } = useI18n();
  const receipt = useQuery({
    queryKey: ['sessions', paid.sessionId, 'receipt', paid.payment.saleId],
    queryFn: () => api<ReceiptData>(`/sessions/${paid.sessionId}/receipt`),
    staleTime: Infinity,
  });
  if (receipt.data) {
    return (
      <SaleDoneDialog
        receipt={receipt.data}
        onFinish={onFinish}
        title={t('sessions.paidTitle')}
        testId="session"
        variant="session"
      />
    );
  }
  return (
    <Dialog
      open
      onClose={onFinish}
      title={t('sessions.paidTitle')}
      description={paid.payment.receiptNo}
      size="sm"
      footer={<Button onClick={onFinish}>{t('common.close')}</Button>}
    >
      {receipt.isError ? (
        <Alert tone="danger">
          {receipt.error instanceof ApiError ? receipt.error.message : t('common.errorGeneric')}
        </Alert>
      ) : (
        <Loading />
      )}
    </Dialog>
  );
}
