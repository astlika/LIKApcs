/**
 * 0.27.3: from the till, the desk adds products to a PC's bill. It picks the PC from a list of the
 * PCs with a session that is running, paused, or ended and still waiting for payment.
 */
import { useQuery } from '@tanstack/react-query';
import type { SessionSummary } from '@likapcs/shared';
import { api } from '../../lib/api';
import { useI18n } from '../../i18n';
import { AddToSessionDialog, type PcChoice } from '../sessions/AddToSessionDialog';
import { Alert, Dialog } from '../ui/primitives';

async function openSessions(): Promise<SessionSummary[]> {
  const [live, paused, waiting] = await Promise.all([
    api<{ items: SessionSummary[] }>('/sessions', { query: { status: 'active', pageSize: 200 } }),
    api<{ items: SessionSummary[] }>('/sessions', { query: { status: 'paused', pageSize: 200 } }),
    api<{ items: SessionSummary[] }>('/sessions', {
      query: { awaitingPayment: 'true', pageSize: 200 },
    }),
  ]);
  const byId = new Map<string, SessionSummary>();
  for (const s of [...live.items, ...paused.items, ...waiting.items]) byId.set(s.id, s);
  return [...byId.values()];
}

export function AddToPcDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const sessions = useQuery({
    queryKey: ['sessions', 'pos-add-to-pc'],
    queryFn: openSessions,
    staleTime: 5_000,
  });

  if (sessions.isPending) return null;

  const choices: PcChoice[] = (sessions.data ?? [])
    .map((s) => ({
      sessionId: s.id,
      label: s.customerName ? `${s.stationName} · ${s.customerName}` : s.stationName,
      billed: s.billedAt !== null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  if (choices.length === 0) {
    return (
      <Dialog open onClose={onClose} size="md" title={t('addItems.title')}>
        <Alert tone="info">{t('addItems.noPcs')}</Alert>
      </Dialog>
    );
  }

  return <AddToSessionDialog choices={choices} onClose={onClose} onDone={() => onDone()} />;
}
