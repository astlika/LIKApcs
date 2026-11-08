import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CashShiftDetail, CashStatusResponse } from '@likapcs/shared';
import { api, errorText, money, parseEuroToCents, shortDate } from '../api';
import { useLive } from '../useLive';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { Btn, Choices, EuroInput, Field, Loading, Notice, QueryError, Sheet, Stat } from '../components/ui';
import { useT, type TFunc } from '../i18n';

/** The drawer: open and close the shift, add or take out cash. Money actions need the phone to be online. */
export function Cash({ canOpenClose, canMove }: { canOpenClose: boolean; canMove: boolean }) {
  const t = useT();
  const { data, error, isLoading, refetch } = useLive(['cash'], () => api<CashStatusResponse>('/cash/status'));
  const [sheet, setSheet] = useState<'move' | 'close' | null>(null);
  const online = useOnline();

  if (isLoading) return <Loading />;
  if (error || !data) return <QueryError message={t('Arka nuk u ngarkua.')} onRetry={() => void refetch()} />;

  const shift = data.current;
  const register = data.registers.find((r) => r.isActive);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{t('Arka')}</h1>
          <span className="muted small">{register?.name ?? t('Pa arkë aktive')}</span>
        </div>
      </div>

      {!online && <Notice tone="danger">{t('Pa lidhje me serverin. Veprimet me para janë të bllokuara.')}</Notice>}

      {!shift ? (
        <OpenShift registerId={register?.id} canOpen={canOpenClose} online={online} onDone={() => void refetch()} />
      ) : (
        <>
          <ShiftSummary shift={shift} />
          <div className="grid-2">
            <Btn variant="ghost" onClick={() => setSheet('move')} disabled={!canMove || !online}>
              {t('Depozitë / Tërheqje')}
            </Btn>
            <Btn variant="danger" onClick={() => setSheet('close')} disabled={!canOpenClose || !online}>
              {t('Mbyll turnin')}
            </Btn>
          </div>
          {!canMove && <Notice tone="warn">{t('Nuk keni leje për lëvizje parash.')}</Notice>}

          <div className="card card--flat stack-sm">
            <strong>{t('Lëvizjet e sotme')}</strong>
            {shift.movements.length === 0 && <span className="muted small">{t('Ende nuk ka lëvizje.')}</span>}
            <ul className="kv-list">
              {shift.movements.map((m) => (
                <li key={m.id} className="kv">
                  <span>
                    {m.reason ?? (m.type === 'deposit' ? t('Depozitë') : t('Tërheqje'))}
                    <small className="muted block">{shortDate(m.createdAt)}</small>
                  </span>
                  <strong className={m.amountCents < 0 ? 'neg' : 'pos'}>{money(m.amountCents)}</strong>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {sheet === 'move' && shift && <MoveSheet onClose={() => setSheet(null)} onDone={() => { setSheet(null); void refetch(); }} />}
      {sheet === 'close' && shift && <CloseSheet shift={shift} onClose={() => setSheet(null)} onDone={() => { setSheet(null); void refetch(); }} />}
    </div>
  );
}

function ShiftSummary({ shift }: { shift: CashShiftDetail }) {
  const t = useT();
  const totals = shift.totals;
  return (
    <div className="card stack-sm">
      <div className="row row--between">
        <span className="muted">{t('Turni u hap {date} · {name}', { date: shortDate(shift.openedAt), name: shift.openedBy.name })}</span>
        <span className="badge badge--ok">{t('I hapur')}</span>
      </div>
      <div className="clock-grid">
        <Stat label={t('Hapja')} value={money(totals.openingCents)} />
        <Stat label={t('Shitje në para')} value={money(totals.cashSalesCents)} />
        <Stat label={t('Borxhe të mbledhura')} value={money(totals.debtPaymentsCents)} />
        <Stat label={t('Shpenzime')} value={money(totals.expensesCents)} />
        <Stat label={t('Depozita')} value={money(totals.depositsCents)} />
        <Stat label={t('Tërheqje')} value={money(totals.withdrawalsCents)} />
      </div>
    </div>
  );
}

function OpenShift({
  registerId,
  canOpen,
  online,
  onDone,
}: {
  registerId?: string;
  canOpen: boolean;
  online: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const notify = useNotify();
  const [opening, setOpening] = useState('');
  const cents = parseEuroToCents(opening) ?? 0;
  const open = useMutation({
    mutationFn: () => api('/cash/shifts/open', { method: 'POST', body: { registerId, openingCents: cents } }),
    onSuccess: () => {
      notify(t('Turni u hap.'));
      onDone();
    },
  });
  return (
    <div className="card stack-sm">
      <strong>{t('Nuk ka turn të hapur')}</strong>
      <span className="muted small">{t('Hapni turnin me shumën që keni në arkë.')}</span>
      <EuroInput label={t('Para në fillim')} value={opening} onChange={setOpening} />
      {open.isError && <Notice tone="danger">{errorText(open.error)}</Notice>}
      {!canOpen && <Notice tone="warn">{t('Nuk keni leje për të hapur turnin.')}</Notice>}
      <Btn block onClick={() => open.mutate()} disabled={!canOpen || !online || open.isPending || opening === ''}>
        {open.isPending ? t('Duke hapur…') : t('Hap turnin')}
      </Btn>
    </div>
  );
}

function MoveSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const notify = useNotify();
  const qc = useQueryClient();
  const [type, setType] = useState<'deposit' | 'withdrawal'>('withdrawal');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const cents = parseEuroToCents(amount) ?? 0;
  const move = useMutation({
    mutationFn: () => api('/cash/movements', { method: 'POST', body: { type, amountCents: cents, reason: reason.trim() } }),
    onSuccess: () => {
      notify(type === 'deposit' ? t('Depozita u regjistrua.') : t('Tërheqja u regjistrua.'));
      void qc.invalidateQueries({ queryKey: ['phone', 'cash'] });
      onDone();
    },
  });
  const valid = cents > 0 && reason.trim().length > 0;
  return (
    <Sheet
      title={t('Lëvizje parash')}
      onClose={onClose}
      footer={
        <>
          {move.isError && <Notice tone="danger">{errorText(move.error)}</Notice>}
          <Btn block onClick={() => move.mutate()} disabled={!valid || move.isPending}>
            {t('Regjistro')}
          </Btn>
        </>
      }
    >
      <Choices
        label={t('Lloji')}
        value={type}
        onChange={setType}
        options={[
          { value: 'withdrawal', label: t('Tërheqje') },
          { value: 'deposit', label: t('Depozitë') },
        ]}
      />
      <EuroInput label={t('Shuma')} value={amount} onChange={setAmount} autoFocus />
      <Field label={t('Arsyeja')}>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder={t('p.sh. kthim i drekës')} />
      </Field>
    </Sheet>
  );
}

function CloseSheet({ shift, onClose, onDone }: { shift: CashShiftDetail; onClose: () => void; onDone: () => void }) {
  const t: TFunc = useT();
  const notify = useNotify();
  const qc = useQueryClient();
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [confirm, setConfirm] = useState(false);
  const cents = parseEuroToCents(counted) ?? 0;
  const close = useMutation({
    mutationFn: () =>
      api(`/cash/shifts/${shift.id}/close`, {
        method: 'POST',
        body: { countedCashCents: cents, notes: notes.trim() || undefined },
      }),
    onSuccess: () => {
      notify(t('Turni u mbyll.'));
      void qc.invalidateQueries({ queryKey: ['phone', 'cash'] });
      onDone();
    },
  });
  return (
    <Sheet
      title={t('Mbyll turnin')}
      onClose={onClose}
      footer={
        <>
          {close.isError && <Notice tone="danger">{errorText(close.error)}</Notice>}
          {!confirm ? (
            <Btn block onClick={() => setConfirm(true)} disabled={counted === ''}>
              {t('Vazhdo')}
            </Btn>
          ) : (
            <Btn variant="danger" block onClick={() => close.mutate()} disabled={close.isPending}>
              {close.isPending ? t('Duke mbyllur…') : t('Po, mbyll turnin')}
            </Btn>
          )}
        </>
      }
    >
      <EuroInput label={t('Para të numëruara në arkë')} value={counted} onChange={(v) => { setCounted(v); setConfirm(false); }} autoFocus />
      <Field label={t('Shënime (opsionale)')}>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      </Field>
      {confirm && (
        <Notice tone="warn">{t('Pasi të mbyllet, turni nuk hapet më. Kontrolloni shumën para se të vazhdoni.')}</Notice>
      )}
    </Sheet>
  );
}
