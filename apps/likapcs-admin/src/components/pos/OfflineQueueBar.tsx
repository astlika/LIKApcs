/**
 * Punkti 4 (0.28.0): the offline queue of this PC, shown above the POS catalogue. It asks once
 * for this PC's number (e.g. PC2), then shows the sales still waiting for the server and the
 * failed ones (with the reason) to be removed after review.
 */
import { useState, useSyncExternalStore } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/primitives';
import { useToast } from '../../state/toast';
import {
  getOfflineSnapshot,
  removeFailedSale,
  setDeviceCode,
  subscribeOffline,
} from '../../lib/offline-sales';

export function OfflineQueueBar() {
  const { t } = useI18n();
  const toast = useToast();
  const snap = useSyncExternalStore(subscribeOffline, getOfflineSnapshot, getOfflineSnapshot);
  const [code, setCode] = useState('');

  if (!snap.deviceCode) {
    return (
      <div className="pos__offline" role="status">
        <span className="muted">{t('pos.offlineDeviceAsk')}</span>
        <input
          className="input"
          style={{ width: 120 }}
          placeholder="PC2"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label={t('pos.offlineDeviceLabel')}
        />
        <Button
          onClick={() => {
            if (!setDeviceCode(code)) toast.error(t('pos.offlineDeviceInvalid'));
          }}
        >
          {t('common.save')}
        </Button>
      </div>
    );
  }

  const pending = snap.queue.filter((q) => q.status === 'pending').length;
  const failed = snap.queue.filter((q) => q.status === 'failed');
  if (pending === 0 && failed.length === 0) return null;

  return (
    <div className="pos__offline" role="status">
      {pending > 0 && <strong>{t('pos.offlinePending', { count: pending })}</strong>}
      {failed.map((q) => (
        <div key={q.clientRequestId} className="pos__offline-row">
          <span>
            <strong>{q.localNumber}</strong> · {q.error ?? t('pos.offlineFailedUnknown')}
          </span>
          <Button variant="ghost" onClick={() => removeFailedSale(q.clientRequestId)}>
            {t('pos.offlineRemove')}
          </Button>
        </div>
      ))}
    </div>
  );
}
