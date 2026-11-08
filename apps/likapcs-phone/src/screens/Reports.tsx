import { useState, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { CashBookReport, ProfitReport, ReportBucket, SalesReport } from '@likapcs/shared';
import { api, downloadFile, duration, errorText, money, shortDate } from '../api';
import { useNotify } from '../notify';
import { METHOD_LABEL } from '../labels';
import { Empty, Loading, QueryError, cx } from '../components/ui';

type Tab = 'sales' | 'cash' | 'profit';
type Preset = 'today' | 'week' | 'month';

const isoOf = (d: Date) => d.toLocaleDateString('sv-SE');

/** The period shown by the presets: today, the last 7 days, or the current month. */
function rangeOf(preset: Preset): { from: string; to: string } {
  const now = new Date();
  if (preset === 'today') return { from: isoOf(now), to: isoOf(now) };
  if (preset === 'week') {
    const from = new Date(now);
    from.setDate(now.getDate() - 6);
    return { from: isoOf(from), to: isoOf(now) };
  }
  return { from: isoOf(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoOf(now) };
}

const pct = (bp: number | null | undefined) => (bp === null || bp === undefined ? '—' : `${(bp / 100).toFixed(1)} %`);
const when = (iso: string) =>
  new Date(iso).toLocaleString('sq-AL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Reports for the phone: sales, the cash book and profit. Read only. Needs «Raportet». */
export function Reports({ canProfit }: { canProfit: boolean }) {
  const [tab, setTab] = useState<Tab>('sales');
  const [preset, setPreset] = useState<Preset | 'custom'>('today');
  const [range, setRange] = useState(() => rangeOf('today'));
  const invalid = range.from > range.to;

  const pick = (p: Preset) => {
    setPreset(p);
    setRange(rangeOf(p));
  };
  const query = `from=${range.from}&to=${range.to}`;

  const sales = useQuery({
    queryKey: ['phone', 'report', 'sales', range.from, range.to],
    queryFn: () => api<SalesReport>(`/reports/sales?${query}`),
    enabled: tab === 'sales' && !invalid,
  });
  const cash = useQuery({
    queryKey: ['phone', 'report', 'cash', range.from, range.to],
    queryFn: () => api<CashBookReport>(`/reports/cash-book?${query}`),
    enabled: tab === 'cash' && !invalid,
  });
  const profit = useQuery({
    queryKey: ['phone', 'report', 'profit', range.from, range.to],
    queryFn: () => api<ProfitReport>(`/reports/profit?${query}`),
    enabled: tab === 'profit' && canProfit && !invalid,
  });

  const tabs: { id: Tab; label: string }[] = [
    { id: 'sales', label: 'Shitjet' },
    { id: 'cash', label: 'Arka' },
    ...(canProfit ? [{ id: 'profit' as Tab, label: 'Fitimi' }] : []),
  ];

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Raportet</h1>
      </div>
      <ExportRow from={range.from} to={range.to} disabled={invalid} canProfit={canProfit} />

      <div className="chips" role="group" aria-label="Periudha">
        {(
          [
            ['today', 'Sot'],
            ['week', '7 ditët e fundit'],
            ['month', 'Këtë muaj'],
          ] as [Preset, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" className={cx('chip', preset === id && 'chip--on')} aria-pressed={preset === id} onClick={() => pick(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="date-row">
        <label className="field">
          <span className="field__label">Nga</span>
          <input
            type="date"
            value={range.from}
            onChange={(e) => {
              setPreset('custom');
              setRange((r) => ({ ...r, from: e.target.value }));
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">Deri</span>
          <input
            type="date"
            value={range.to}
            onChange={(e) => {
              setPreset('custom');
              setRange((r) => ({ ...r, to: e.target.value }));
            }}
          />
        </label>
      </div>
      {invalid && <p className="text-danger small">Data «nga» duhet të jetë para datës «deri».</p>}

      <div className="chips" role="tablist" aria-label="Lloji i raportit">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cx('chip', tab === t.id && 'chip--on')} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'sales' && <SalesView q={sales} />}
      {tab === 'cash' && <CashView q={cash} />}
      {tab === 'profit' && canProfit && <ProfitView q={profit} />}
    </div>
  );
}

type Q<T> = UseQueryResult<T, Error>;

function Wait<T>({ q, children, what }: { q: Q<T>; children: (d: T) => ReactNode; what: string }) {
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <QueryError message={`${what} nuk u ngarkua.`} onRetry={() => void q.refetch()} />;
  return children(q.data);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="stack-sm report-section">
      <h2>{title}</h2>
      <div className="card">{children}</div>
    </section>
  );
}

/** A list of amounts with a bar for each row (the largest row is full). */
function Buckets({ rows, label = (r: ReportBucket) => r.label ?? r.key }: { rows: ReportBucket[]; label?: (r: ReportBucket) => string }) {
  if (rows.length === 0) return <p className="muted small">Asnjë e dhënë.</p>;
  const max = Math.max(1, ...rows.map((r) => r.amountCents));
  return (
    <ul className="list">
      {rows.map((r) => (
        <li key={r.key} className="bar-row">
          <span>{label(r)}</span>
          <strong>{money(r.amountCents)}</strong>
          <span className="bar-row__track" aria-hidden="true">
            <span className="bar-row__fill" style={{ width: `${(r.amountCents / max) * 100}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function SalesView({ q }: { q: Q<SalesReport> }) {
  return (
    <Wait q={q} what="Raporti i shitjeve">
      {(r) => (
        <>
          <div className="grid-2">
            <div className="stat">
              <span className="muted small">Shitje (bruto)</span>
              <strong>{money(r.sales.grossCents)}</strong>
              <span className="muted small">{r.sales.count} shitje</span>
            </div>
            <div className="stat">
              <span className="muted small">Mesatarja</span>
              <strong>{money(r.sales.averageCents)}</strong>
            </div>
            <div className="stat">
              <span className="muted small">Zbritje</span>
              <strong>{money(r.sales.discountCents)}</strong>
            </div>
            <div className="stat">
              <span className="muted small">Kthime</span>
              <strong>{money(r.sales.refundedCents)}</strong>
              <span className="muted small">{r.sales.refundsCount} kthime</span>
            </div>
          </div>

          <Section title="Sipas mënyrës së pagesës">
            <Buckets rows={r.byMethod} label={(b) => METHOD_LABEL[b.key] ?? b.label ?? b.key} />
          </Section>

          <Section title="Ditët">
            {r.byDay.length === 0 ? (
              <Empty>Nuk ka shitje në këtë periudhë.</Empty>
            ) : (
              <Buckets
                rows={r.byDay.map((d) => ({ key: d.date, label: shortDate(d.date), count: d.count, amountCents: d.amountCents }))}
              />
            )}
          </Section>

          <Section title="Produktet më të shitura">
            {r.topProducts.length === 0 ? (
              <p className="muted small">Asnjë produkt.</p>
            ) : (
              <ul className="list">
                {r.topProducts.map((p) => (
                  <li key={p.productId} className="kv">
                    <span>
                      {p.name}
                      <span className="block small muted">{(p.quantityMilli / 1000).toLocaleString('sq-AL')} copë</span>
                    </span>
                    <strong>{money(p.amountCents)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="PC-të">
            <div className="kv">
              <span>Sesione</span>
              <strong>{r.gaming.sessionsCount}</strong>
            </div>
            <div className="kv">
              <span>Minuta të faturuara</span>
              <strong>{duration(r.gaming.billedMinutes * 60)}</strong>
            </div>
            <div className="kv">
              <span>Shuma</span>
              <strong>{money(r.gaming.amountCents)}</strong>
            </div>
            {r.gaming.byStation.map((s) => (
              <div key={s.stationId} className="kv">
                <span>
                  {s.name}
                  <span className="block small muted">{duration(s.minutes * 60)} · {s.sessions} sesione</span>
                </span>
                <strong>{money(s.amountCents)}</strong>
              </div>
            ))}
          </Section>

          <Section title="Shpenzimet">
            <div className="kv">
              <span>Gjithsej ({r.expenses.count})</span>
              <strong>{money(r.expenses.totalCents)}</strong>
            </div>
            <Buckets rows={r.expenses.byCategory} />
          </Section>

          <Section title="Stafi">
            <Buckets rows={r.byEmployee} />
          </Section>
        </>
      )}
    </Wait>
  );
}

function CashView({ q }: { q: Q<CashBookReport> }) {
  return (
    <Wait q={q} what="Arka">
      {(r) => (
        <>
          <Section title="Përmbledhja">
            <div className="kv">
              <span>Turne</span>
              <strong>
                {r.totals.shiftsCount}
                {r.totals.openShiftsCount > 0 ? ` (${r.totals.openShiftsCount} të hapura)` : ''}
              </strong>
            </div>
            <div className="kv">
              <span>Hyrje në arkë</span>
              <strong>{money(r.totals.cashInCents)}</strong>
            </div>
            <div className="kv">
              <span>Dalje nga arka</span>
              <strong>{money(r.totals.cashOutCents)}</strong>
            </div>
            <div className="kv">
              <span>Të pritura në arkë</span>
              <strong>{money(r.totals.expectedCashCents)}</strong>
            </div>
            <div className="kv">
              <span>Të numëruara</span>
              <strong>{money(r.totals.countedCashCents)}</strong>
            </div>
            <div className="kv">
              <span>Diferenca</span>
              <strong className={r.totals.differenceCents < 0 ? 'text-danger' : undefined}>{money(r.totals.differenceCents)}</strong>
            </div>
          </Section>

          <Section title="Turnet">
            {r.rows.length === 0 ? (
              <Empty>Nuk ka turne në këtë periudhë.</Empty>
            ) : (
              <ul className="list">
                {r.rows.map((row) => (
                  <li key={row.shift.id} className="kv">
                    <span>
                      {row.shift.registerName} · {when(row.shift.openedAt)}
                      <span className="block small muted">
                        {row.shift.openedBy.name}
                        {row.shift.status === 'open' ? ' · i hapur' : row.shift.closedAt ? ` · mbyllur ${when(row.shift.closedAt)}` : ''}
                      </span>
                      <span className="block small muted">
                        Hapja {money(row.shift.openingCents)} · hyrje {money(row.cashInCents)} · dalje {money(row.cashOutCents)}
                      </span>
                    </span>
                    <strong className={row.shift.differenceCents && row.shift.differenceCents < 0 ? 'text-danger' : undefined}>
                      {row.shift.status === 'open' ? 'E hapur' : money(row.shift.differenceCents)}
                    </strong>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </Wait>
  );
}

function ProfitView({ q }: { q: Q<ProfitReport> }) {
  return (
    <Wait q={q} what="Raporti i fitimit">
      {(r) => (
        <>
          <Section title="Fitimi">
            <div className="kv">
              <span>Të ardhura (pa TVSH)</span>
              <strong>{money(r.revenue.revenueCents)}</strong>
            </div>
            <div className="kv">
              <span>Kosto e mallit të shitur</span>
              <strong>{money(r.costOfSalesCents)}</strong>
            </div>
            <div className="kv">
              <span>Fitimi bruto</span>
              <strong>
                {money(r.grossProfitCents)} <span className="small muted">({pct(r.grossMarginBp)})</span>
              </strong>
            </div>
            <div className="kv">
              <span>Shpenzime operative</span>
              <strong>{money(r.operatingExpensesCents)}</strong>
            </div>
            <div className="kv">
              <span>Humbje stoku</span>
              <strong>{money(r.stockLossCents)}</strong>
            </div>
            <div className="kv">
              <span>Fitimi neto</span>
              <strong className={cx(r.netProfitCents < 0 && 'text-danger')}>
                {money(r.netProfitCents)} <span className="small muted">({pct(r.netMarginBp)})</span>
              </strong>
            </div>
          </Section>

          <Section title="Para reale">
            <div className="kv">
              <span>Hyrje në arkë</span>
              <strong>{money(r.cash.drawerInCents)}</strong>
            </div>
            <div className="kv">
              <span>Dalje nga arka</span>
              <strong>{money(r.cash.drawerOutCents)}</strong>
            </div>
            <div className="kv">
              <span>Paguar furnitorëve</span>
              <strong>{money(r.cash.supplierPaidCents)}</strong>
            </div>
            <div className="kv">
              <span>Borxhi ndaj furnitorëve</span>
              <strong>{money(r.payables.supplierBalanceCents)}</strong>
            </div>
          </Section>

          {(r.checks.productsWithoutCost > 0 || r.checks.saleLinesWithoutCost > 0 || r.checks.lossesWithoutCost > 0) && (
            <p className="notice notice--warn small">
              Disa produkte nuk kanë kosto, prandaj raporti mund të jetë i paplotë. Plotësojeni në kompjuter.
            </p>
          )}
        </>
      )}
    </Wait>
  );
}

/** CSV downloads for the chosen period. The file has the same numbers as the report on screen. */
function ExportRow({ from, to, disabled, canProfit }: { from: string; to: string; disabled: boolean; canProfit: boolean }) {
  const notify = useNotify();
  const [busy, setBusy] = useState<string | null>(null);
  const items: { kind: string; label: string }[] = [
    { kind: 'sales', label: 'Shitjet' },
    { kind: 'cash_book', label: 'Arka' },
    ...(canProfit ? [{ kind: 'sale_items', label: 'Produktet' }] : []),
  ];
  const run = async (kind: string) => {
    setBusy(kind);
    try {
      await downloadFile(`/reports/export?${new URLSearchParams({ kind, from, to }).toString()}`, `${kind}-${from}-${to}.csv`);
    } catch (err) {
      notify(errorText(err), 'err');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="chips" role="group" aria-label="Shkarko CSV">
      {items.map((i) => (
        <button key={i.kind} type="button" className="chip" disabled={disabled || busy !== null} onClick={() => void run(i.kind)}>
          {busy === i.kind ? '…' : `CSV · ${i.label}`}
        </button>
      ))}
    </div>
  );
}
