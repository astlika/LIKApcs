import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExpenseCategorySummary, ExpenseListResponse, PaymentMethod } from '@likapcs/shared';
import { api, errorText, money, parseEuroToCents, shortDate, todayIso } from '../api';
import { useLive } from '../useLive';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { METHOD_LABEL } from '../labels';
import { Btn, Choices, Empty, EuroInput, Field, Loading, Notice, QueryError, Sheet, Stat, cx } from '../components/ui';
import { useLang, useT, type TFunc } from '../i18n';

type Range = 'today' | 'week' | 'month';
const daysBack = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
};
const RANGE_FROM: Record<Range, () => string> = { today: todayIso, week: () => daysBack(6), month: () => daysBack(29) };
const RANGE_LABEL: Record<Range, string> = { today: 'Sot', week: '7 ditë', month: '30 ditë' };

/** Expenses: list, add, and void. A cash expense is taken from the open drawer automatically. */
export function Expenses({ canManage }: { canManage: boolean }) {
  const t = useT();
  const lang = useLang();
  const [range, setRange] = useState<Range>('week');
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<{ id: string; description: string } | null>(null);
  const from = RANGE_FROM[range]();
  const to = todayIso();
  const online = useOnline();
  const list = useLive(['expenses', range], () =>
    api<ExpenseListResponse>(`/expenses?${new URLSearchParams({ from, to, pageSize: '100' }).toString()}`),
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('Shpenzimet')}</h1>
        {canManage && (
          <Btn variant="ghost" className="small-btn" onClick={() => setAdding(true)} disabled={!online}>
            {t('+ Shpenzim')}
          </Btn>
        )}
      </div>

      <div className="chips" role="group" aria-label={t('Periudha')}>
        {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
          <button key={r} type="button" className={cx('chip', range === r && 'chip--on')} aria-pressed={range === r} onClick={() => setRange(r)}>
            {t(RANGE_LABEL[r])}
          </button>
        ))}
      </div>

      {list.isLoading && <Loading />}
      {list.error && <QueryError message={t('Shpenzimet nuk u ngarkuan.')} onRetry={() => void list.refetch()} />}
      {list.data && (
        <>
          <div className="card card--flat clock-grid">
            <Stat label={t('Totali')} value={money(list.data.totalCents)} />
            <Stat label={t('Numri')} value={String(list.data.total)} />
          </div>
          {list.data.items.length === 0 && <Empty>{t('Nuk ka shpenzime në këtë periudhë.')}</Empty>}
          <ul className="list">
            {list.data.items.map((e) => (
              <li key={e.id} className={cx('debt-row', e.voidedAt && 'muted')}>
                <span className="pc-row__main">
                  <strong>{e.description}</strong>
                  <span className="muted small">
                    {lang === 'en' ? e.categoryName.en : e.categoryName.sq} · {shortDate(e.expenseDate)} · {t(METHOD_LABEL[e.paymentMethod] ?? e.paymentMethod)}
                    {e.voidedAt ? ` · ${t('E anuluar')}` : ''}
                  </span>
                </span>
                <span className="row">
                  <strong>{money(e.amountCents)}</strong>
                  {canManage && !e.voidedAt && (
                    <button type="button" className="ghost small-btn" onClick={() => setVoiding({ id: e.id, description: e.description })} disabled={!online}>
                      {t('Anulo')}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {adding && <AddExpense onClose={() => setAdding(false)} />}
      {voiding && <VoidExpense expense={voiding} onClose={() => setVoiding(null)} />}
    </div>
  );
}

function AddExpense({ onClose }: { onClose: () => void }) {
  const t = useT();
  const lang = useLang();
  const notify = useNotify();
  const qc = useQueryClient();
  const categories = useLive(['expense-categories'], () => api<ExpenseCategorySummary[]>('/expenses/categories'));
  const [categoryCode, setCategoryCode] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [description, setDescription] = useState('');
  const cents = parseEuroToCents(amount) ?? 0;
  const cats = (categories.data ?? []).filter((c) => c.isActive);
  const valid = categoryCode !== '' && cents > 0 && description.trim().length > 0;

  const save = useMutation({
    mutationFn: () =>
      api('/expenses', {
        method: 'POST',
        body: {
          expenseDate: todayIso(),
          categoryCode,
          amountCents: cents,
          paymentMethod: method,
          description: description.trim(),
          // Cash leaves the open drawer; other methods do not touch it.
          fromDrawer: method === 'cash',
        },
      }),
    onSuccess: () => {
      notify(t('Shpenzimi u regjistrua.'));
      void qc.invalidateQueries({ queryKey: ['phone', 'expenses'] });
      void qc.invalidateQueries({ queryKey: ['phone', 'cash'] });
      onClose();
    },
  });

  return (
    <Sheet
      title={t('Shpenzim i ri')}
      onClose={onClose}
      footer={
        <>
          {save.isError && <Notice tone="danger">{errorText(save.error)}</Notice>}
          <Btn block onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {save.isPending ? t('Duke ruajtur…') : t('Ruaj shpenzimin')}
          </Btn>
        </>
      }
    >
      <Field label={t('Kategoria')}>
        <div className="chips" role="group" aria-label={t('Kategoria')}>
          {cats.map((c) => (
            <button key={c.code} type="button" className={cx('chip', categoryCode === c.code && 'chip--on')} aria-pressed={categoryCode === c.code} onClick={() => setCategoryCode(c.code)}>
              {lang === 'en' ? c.nameEn : c.nameSq}
            </button>
          ))}
        </div>
      </Field>
      <EuroInput label={t('Shuma')} value={amount} onChange={setAmount} />
      <Choices
        label={t('Mënyra e pagesës')}
        value={method}
        onChange={setMethod}
        options={[
          { value: 'cash', label: t('Para në dorë') },
          { value: 'card', label: t('Kartelë') },
          { value: 'bank_transfer', label: t('Transfer') },
        ]}
      />
      {method === 'cash' && <Notice tone="info">{t('Shuma merret nga arka e hapur.')}</Notice>}
      <Field label={t('Përshkrimi')}>
        <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder={t('p.sh. faturë e energjisë')} />
      </Field>
    </Sheet>
  );
}

function VoidExpense({ expense, onClose }: { expense: { id: string; description: string }; onClose: () => void }) {
  const t: TFunc = useT();
  const notify = useNotify();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const doVoid = useMutation({
    mutationFn: () => api(`/expenses/${expense.id}/void`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: () => {
      notify(t('Shpenzimi u anulua.'));
      void qc.invalidateQueries({ queryKey: ['phone', 'expenses'] });
      void qc.invalidateQueries({ queryKey: ['phone', 'cash'] });
      onClose();
    },
  });
  return (
    <Sheet
      title={t('Anulo shpenzimin')}
      onClose={onClose}
      footer={
        <>
          {doVoid.isError && <Notice tone="danger">{errorText(doVoid.error)}</Notice>}
          <Btn variant="danger" block onClick={() => doVoid.mutate()} disabled={reason.trim() === '' || doVoid.isPending}>
            {t('Po, anulo')}
          </Btn>
        </>
      }
    >
      <p>{expense.description}</p>
      <Field label={t('Arsyeja e anulimit')}>
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus />
      </Field>
    </Sheet>
  );
}

