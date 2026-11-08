import { useEffect, useRef } from 'react';
import type { StationSummary } from '@likapcs/shared';
import { api } from './api';
import { useLive } from './useLive';
import { useNotify } from './notify';
import { translate } from './i18n';

/**
 * Watches the PCs while the phone is open: tells the operator when a PC drops offline, and when a
 * prepaid session has 5 minutes left (once per session). Renders nothing.
 */
export function PcAlerts({ enabled }: { enabled: boolean }) {
  const notify = useNotify();
  const { data } = useLive(['stations'], () => api<StationSummary[]>('/stations'));
  const wasOffline = useRef<Set<string> | null>(null);
  const warned = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled || !data) return;
    const offlineNow = new Set(data.filter((s) => s.isEnabled && s.status === 'offline').map((s) => s.id));
    if (wasOffline.current) {
      for (const s of data) {
        if (s.isEnabled && offlineNow.has(s.id) && !wasOffline.current.has(s.id)) {
          notify(translate('{name} u shkëput (offline).', { name: s.name }), 'err');
        }
      }
    }
    wasOffline.current = offlineNow;

    for (const s of data) {
      const session = s.activeSession;
      if (!session || session.billingMode !== 'prepaid' || session.status === 'paused') continue;
      const left = session.remainingSeconds;
      if (left !== null && left > 0 && left <= 300 && !warned.current.has(session.id)) {
        warned.current.add(session.id);
        notify(translate('{name}: mbeten 5 min.', { name: s.name }), 'info');
      }
    }
  }, [data, enabled, notify]);

  return null;
}
