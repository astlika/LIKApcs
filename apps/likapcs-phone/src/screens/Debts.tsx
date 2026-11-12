import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DebtCustomerGroup, DebtSummary, Paginated, PaymentMethod } from '@likapcs/shared';
import { api, errorText, money, parseEuroToCents, shortDate, todayIso } from '../api';
import { METHOD_LABEL } from '../labels';
import { useLive } from '../useLive';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { Btn, Choices, EuroInput, Field, Loading, Notice, QueryError, Sheet, Stat, cx } from '../components/ui';

interface DebtsOverview {
  openCents: number;
  overdueCents: number;
  dueTodayCents: number;
  openCount: number;
  overdueCount: number;
}

const PAY_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer', 'other'];

/** Debts grouped by customer, oldest first. A payment can be the whole balance or a part. */
export function Debts({ canCollect }: { canCollect: boolean }) {
  const [search, setSearch] = useState('');
  const overview = useLive(['debts', 'overview'], () => api<DebtsOverview>('/debts/overview'));
  const groups = useLive(['debts', 'groups', search.trim()], () =>
    api<DebtCustomerGroup[]>(`/debts/by-customer${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`),
  );
  const [selected, setSelected] = useState<DebtCustomerGroup | null>(null);

  const today = todayIso();
  const rows = useMemo(
    () =>
      [...(groups.data ?? [])].sort((a, b) => {
        if (a.oldestDue === b.oldestDue) return b.totalCents - a.totalCents;
        if (!a.oldestDue) return 1;
        if (!b.oldestDue) return -1;
        return a.oldestDue < b.oldestDue ? -1 : 1;
      }),
    [groups.data],
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Borxhet</h1>
      </div>

      {overview.data && (
        <div className="grid-3">
          <Stat label="Të hapura" value={money(overview.data.openCents)} sub={`${overview.data.openCount} fatura`} />
          <Stat
            label="Të vonuara"
            tone={overview.data.overdueCents > 0 ? 'danger' : undefined}
            value={money(overview.data.overdueCents)}
            sub={`${overview.data.overdueCount} fatura`}
          />
          <Stat label="Sot" tone={overview.data.dueTodayCents > 0 ? 'warn' : undefined} value={money(overview.data.dueTodayCents)} sub="për t’u paguar" />
        </div>
      )}

      <input
        className="search"
        type="search"
        placeholder="Kërko klientin me emër ose telefon"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Kërko klientin"
      />

      {groups.isLoading && <Loading />}
      {groups.error && <QueryError message="Borxhet nuk u ngarkuan." onRetry={() => void groups.refetch()} />}
      {groups.data && rows.length === 0 && (
        <p className="empty">{search.trim() ? 'Asnjë klient me borxh për këtë kërkim.' : 'Nuk ka borxhe të hapura.'}</p>
      )}

      <ul className="list">
        {rows.map((g) => {
          const overdue = g.oldestDue !== null && g.oldestDue < today;
          return (
            <li key={g.customerId}>
              <button type="button" className="debt-row" onClick={() => setSelected(g)}>
                <span className="debt-row__main">
                  <strong>{g.name}</strong>
                  <span className="muted small">
                    {g.count} {g.count === 1 ? 'faturë' : 'fatura'}
                    {g.oldestDue ? ` · afati ${shortDate(g.oldestDue)}` : ''}
                  </span>
                </span>
                <span className="debt-row__side">
                  <strong className={cx(overdue && 'text-danger')}>{money(g.totalCents)}</strong>
                  {overdue && <span className="badge badge--danger">I vonuar</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {selected && (
        <DebtSheet
          group={selected}
          canCollect={canCollect}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function DebtSheet({ group, canCollect, onClose }: { group: DebtCustomerGroup; canCollect: boolean; onClose: () => void }) {
  const today = todayIso();
  const debts = useQuery({
    queryKey: ['phone', 'debts', 'customer', group.customerId],
    queryFn: () =>
      api<Paginated<DebtSummary>>(`/debts?${new URLSearchParams({ filter: 'open', customerId: group.customerId, pageSize: '100' }).toString()}`),
  });

  const total = group.totalCents;
  return (
    <Sheet title={group.name} onClose={onClose}>
      <p className="muted">
        {group.code ?? ''}
        {group.phone ? ` · ${group.phone}` : ''} · Gjithsej <strong>{money(total)}</strong>
      </p>

      {debts.isLoading && <Loading />}
      {debts.error && <Notice tone="danger">Faturat nuk u ngarkuan.</Notice>}

      {debts.data && (
        <ul className="invoice-list">
          {debts.data.items.map((d) => {
            const overdue = d.dueDate < today;
            return (
              <li key={d.id} className="invoice">
                <div className="row row--between">
                  <strong>{d.receiptNo ?? 'Borxh i hapur'}</strong>
                  <strong>{money(d.remainingCents)}</strong>
                </div>
                <span className="muted small block">
                  {d.itemsText ?? d.notes ?? 'Pa përshkrim'}
                </span>
                <span className="small row row--between">
                  <span className="muted">
                    Afati {shortDate(d.dueDate)}
                    {d.paidCents > 0 ? ` · paguar ${money(d.paidCents)}` : ''}
                  </span>
                  {overdue && <span className="text-danger">{d.overdueDays} ditë vonesë</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {canCollect ? (
        <PayDebt group={group} onDone={onClose} />
      ) : (
        <Notice tone="warn">Nuk keni leje për të arkëtuar borxhe nga telefoni.</Notice>
      )}
    </Sheet>
  );
}

/** Take money against a customer's debt. Full balance or part; the oldest invoices are settled first. */
function PayDebt({ group, onDone }: { group: DebtCustomerGroup; onDone: () => void }) {
  const notify = useNotify();
  const online = useOnline();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'full' | 'part'>('full');
  const [partText, setPartText] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [tenderedText, setTenderedText] = useState('');

  const total = group.totalCents;
  const partCents = parseEuroToCents(partText);
  const amount = mode === 'full' ? total : partCents;
  const amountOk = amount !== null && amount >= 1 && amount <= total;

  const tendered = method === 'cash' ? parseEuroToCents(tenderedText) : null;
  const change = amountOk && tendered !== null && tendered >= amount ? tendered - amount : null;
  const short = amountOk && tendered !== null && tendered < amount;

  const pay = useMutation({
    mutationFn: () => {
      if (amount === null || !amountOk) throw new Error('Shuma e pagesës nuk është e saktë.');
      return api<unknown>(`/customers/${group.customerId}/debts/pay`, {
        method: 'POST',
        body: {
          amountCents: amount,
          method,
          ...(tendered !== null && tendered >= amount ? { tenderedCents: tendered } : {}),
        },
      });
    },
    onSuccess: () => {
      const remaining = total - (amount ?? 0);
      notify(
        remaining > 0
          ? `U paguan ${money(amount)}. Mbetet ${money(remaining)}.`
          : `Borxhi i ${group.name} u mbyll.`,
      );
      void qc.invalidateQueries({ queryKey: ['phone', 'debts'] });
      onDone();
    },
  });

  if (total <= 0) return <Notice tone="ok">Ky klient nuk ka borxh.</Notice>;

  return (
    <div className="stack pay-box">
      <h3>Arkëto borxhin</h3>
      <Choices
        label="Shuma"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'full', label: 'E plotë' },
          { value: 'part', label: 'Pjesërisht' },
        ]}
      />
      {mode === 'part' && (
        <EuroInput label={`Shuma e pagesës (max ${money(total)})`} value={partText} onChange={setPartText} autoFocus />
      )}
      <Choices
        label="Metoda"
        value={method}
        onChange={setMethod}
        options={PAY_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] ?? m }))}
      />
      {method === 'cash' && (
        <Field label="Para të marra (opsionale, për kthimin)">
          <span className="euro-input">
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0,00"
              value={tenderedText}
              onChange={(e) => setTenderedText(e.target.value.replace(/[^\d.,]/g, ''))}
            />
            <span aria-hidden="true">€</span>
          </span>
        </Field>
      )}
      {change !== null && (
        <div className="total-row">
          <span>Kthimi</span>
          <strong>{money(change)}</strong>
        </div>
      )}
      {short && <Notice tone="warn">Paraja e marrë është më pak se shuma.</Notice>}
      {mode === 'part' && partCents !== null && partCents > total && <Notice tone="warn">Shuma është më e madhe se borxhi.</Notice>}
      <Notice tone="info">Pagesa zbatohet fillimisht te faturat më të vjetra.</Notice>
      {!online && <Notice tone="danger">Pa lidhje me serverin. Pagesa nuk mund të regjistrohet tani.</Notice>}
      {pay.isError && <Notice tone="danger">{errorText(pay.error)}</Notice>}
      <Btn block onClick={() => pay.mutate()} disabled={!online || pay.isPending || !amountOk || short}>
        {pay.isPending ? 'Duke regjistruar…' : `Arkëto ${money(amountOk ? amount : null)}`}
      </Btn>
    </div>
  );
}
