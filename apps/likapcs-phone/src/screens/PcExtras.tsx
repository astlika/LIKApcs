import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BulkEndSessionsResult, BulkRemoveTimeResult, StationSummary } from '@likapcs/shared';
import { api, errorText } from '../api';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { Btn, Choices, Field, Notice, Sheet, cx } from '../components/ui';
import { useT, type TFunc } from '../i18n';

type StationCommand = 'lock' | 'unlock' | 'message.show' | 'power.restart' | 'power.shutdown';

/** Lock, unlock, message, restart and shut down one PC. Restart and shutdown ask twice. */
export function PcCommands({ station, canControl, canPower }: { station: StationSummary; canControl: boolean; canPower: boolean }) {
  const t = useT();
  const notify = useNotify();
  const qc = useQueryClient();
  const online = useOnline();
  const [power, setPower] = useState<'power.restart' | 'power.shutdown' | null>(null);
  const [messaging, setMessaging] = useState(false);
  const locked = station.status === 'locked';
  const reachable = station.status !== 'offline';

  const send = useMutation({
    mutationFn: (body: { command: StationCommand; text?: string; durationSeconds?: number }) =>
      api(`/stations/${station.id}/command`, { method: 'POST', body }),
    onSuccess: (_res, vars) => {
      const done: Record<StationCommand, string> = {
        lock: t('u kyç.'),
        unlock: t('u zhbllokua.'),
        'message.show': t('mesazhi u dërgua.'),
        'power.restart': t('po rinisët.'),
        'power.shutdown': t('po fiket.'),
      };
      notify(`${station.name}: ${done[vars.command]}`);
      setPower(null);
      void qc.invalidateQueries({ queryKey: ['phone', 'stations'] });
    },
    onError: (err) => notify(errorText(err), 'err'),
  });

  if (!canControl && !canPower) return null;
  return (
    <div className="stack-sm">
      <strong className="small muted">{t('Komandat e PC-së')}</strong>
      {!online && <Notice tone="danger">{t('Pa lidhje me serverin.')}</Notice>}
      <div className="grid-2">
        {canControl && (
          <Btn variant="ghost" onClick={() => send.mutate({ command: locked ? 'unlock' : 'lock' })} disabled={!online || !reachable || send.isPending}>
            {locked ? t('Zhbllokoje') : t('Kyçe')}
          </Btn>
        )}
        {canControl && (
          <Btn variant="ghost" onClick={() => setMessaging(true)} disabled={!online || !reachable}>
            {t('Dërgo mesazh')}
          </Btn>
        )}
      </div>
      {canPower && power === null && (
        <div className="grid-2">
          <Btn variant="ghost" onClick={() => setPower('power.restart')} disabled={!online || !reachable}>
            {t('Rinis')}
          </Btn>
          <Btn variant="danger" onClick={() => setPower('power.shutdown')} disabled={!online || !reachable}>
            {t('Fik')}
          </Btn>
        </div>
      )}
      {canPower && power !== null && (
        <div className="stack-sm">
          <Notice tone="warn">
            {power === 'power.shutdown'
              ? t('Fiket {name}? Përdoruesi humbet punën e pa ruajtur.', { name: station.name })
              : t('Rinisët {name}? Përdoruesi humbet punën e pa ruajtur.', { name: station.name })}
          </Notice>
          <div className="grid-2">
            <Btn variant="ghost" onClick={() => setPower(null)}>
              {t('Anulo')}
            </Btn>
            <Btn variant="danger" onClick={() => send.mutate({ command: power })} disabled={send.isPending}>
              {power === 'power.shutdown' ? t('Po, fike') : t('Po, rinis')}
            </Btn>
          </div>
        </div>
      )}
      {send.isError && <Notice tone="danger">{errorText(send.error)}</Notice>}
      {messaging && (
        <MessageSheet
          station={station}
          pending={send.isPending}
          onClose={() => setMessaging(false)}
          onSend={(text, durationSeconds) => send.mutate({ command: 'message.show', text, durationSeconds }, { onSuccess: () => setMessaging(false) })}
        />
      )}
    </div>
  );
}

function MessageSheet({
  station,
  pending,
  onClose,
  onSend,
}: {
  station: StationSummary;
  pending: boolean;
  onClose: () => void;
  onSend: (text: string, durationSeconds: number) => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [seconds, setSeconds] = useState(20);
  return (
    <Sheet
      title={t('Mesazh · {name}', { name: station.name })}
      onClose={onClose}
      footer={
        <Btn block onClick={() => onSend(text.trim(), seconds)} disabled={text.trim() === '' || pending}>
          {t('Dërgo')}
        </Btn>
      }
    >
      <Field label={t('Teksti')}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={300} rows={3} autoFocus />
      </Field>
      <Choices
        label={t('Sa sekonda shfaqet')}
        value={seconds}
        onChange={setSeconds}
        options={[
          { value: 10, label: t('10 s') },
          { value: 20, label: t('20 s') },
          { value: 60, label: t('1 min') },
        ]}
      />
    </Sheet>
  );
}

/** Add or remove minutes on several running prepaid PCs at once. */
export function BulkTimeSheet({ sessionIds, onClose, onDone }: { sessionIds: string[]; onClose: () => void; onDone: () => void }) {
  const t: TFunc = useT();
  const notify = useNotify();
  const qc = useQueryClient();
  const [minutes, setMinutes] = useState(15);
  const run = useMutation({
    mutationFn: () => api<BulkRemoveTimeResult>('/sessions/bulk-remove-time', { method: 'POST', body: { sessionIds, minutes } }),
    onSuccess: (res) => {
      notify(
        res.failed > 0
          ? t('U hoqën te {n}; dështuan {m}.', { n: res.removed, m: res.failed })
          : t('U hoqën {min} min te {n} PC.', { min: minutes, n: res.removed }),
        res.failed > 0 ? 'err' : 'ok',
      );
      void qc.invalidateQueries({ queryKey: ['phone', 'stations'] });
      onDone();
    },
    onError: (err) => notify(errorText(err), 'err'),
  });
  return (
    <Sheet
      title={t('Hiq kohë')}
      onClose={onClose}
      footer={
        <Btn variant="danger" block onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? t('Duke hequr…') : t('Hiq {min} min nga {n} PC', { min: minutes, n: sessionIds.length })}
        </Btn>
      }
    >
      <Choices
        label={t('Minuta')}
        value={minutes}
        onChange={setMinutes}
        options={[
          { value: 5, label: '5' },
          { value: 10, label: '10' },
          { value: 15, label: '15' },
          { value: 30, label: '30' },
          { value: 60, label: '60' },
        ]}
      />
      <p className="muted small">{t('Minutat hiqen nga koha e mbetur. Nuk kthehen para.')}</p>
    </Sheet>
  );
}

/** Ends the running sessions of the picked PCs. Two steps, because it stops work on every PC picked. */
export function BulkEndButton({ sessionIds, disabled }: { sessionIds: string[]; disabled: boolean }) {
  const t: TFunc = useT();
  const notify = useNotify();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: () => api<BulkEndSessionsResult>('/sessions/bulk-end', { method: 'POST', body: { sessionIds } }),
    onSuccess: (res) => {
      notify(
        res.failed > 0 ? t('U ndaluan {n}; dështuan {m}.', { n: res.ended, m: res.failed }) : t('U ndaluan {n} PC.', { n: res.ended }),
        res.failed > 0 ? 'err' : 'ok',
      );
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ['phone', 'stations'] });
    },
    onError: (err) => notify(errorText(err), 'err'),
  });
  if (!confirm) {
    return (
      <Btn variant="danger" onClick={() => setConfirm(true)} disabled={disabled || sessionIds.length === 0} className={cx('small-btn')}>
        {t('Ndalo ({n})', { n: sessionIds.length })}
      </Btn>
    );
  }
  return (
    <span className="row">
      <Btn variant="ghost" onClick={() => setConfirm(false)}>
        {t('Anulo')}
      </Btn>
      <Btn variant="danger" onClick={() => run.mutate()} disabled={run.isPending}>
        {run.isPending ? '…' : t('Po, ndalo')}
      </Btn>
    </span>
  );
}

