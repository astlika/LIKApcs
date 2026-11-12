/**
 * 0.31.0 — Live tracking for the phone and the tablet: the same figures as the admin page
 * (`GET /live/snapshot`). Read only. Refreshes on the server's push (see liveSales.tsx) and every
 * 15 seconds as a fallback. Navy palette, one column on a phone, more columns on a tablet.
 */
import { formatMinutesShort, type LiveSale, type LiveSnapshot } from '@likapcs/shared';
import { api, money } from '../api';
import { useT, useLang, localeOf, type Lang } from '../i18n';
import { Empty, Loading, Notice, QueryError, cx } from '../components/ui';
import { useLive } from '../useLive';

const qty = (milli: number) => String(Number((milli / 1000).toFixed(3)));
const clock = (iso: string | null | undefined, lang: Lang) =>
  iso
    ? new Date(iso).toLocaleTimeString(localeOf(lang), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    : '—';

export function Live() {
  const t = useT();
  const lang = useLang();
  const q = useLive<LiveSnapshot>(['live'], () => api<LiveSnapshot>('/live/snapshot'));

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) {
    return <QueryError message={t('Nuk u lexuan të dhënat e live.')} onRetry={() => void q.refetch()} />;
  }
  const s = q.data;
  const x = s.totals;
  const d = s.drawer;

  return (
    <div className="live-screen">
      <div className="live-head">
        <span className="live-pill">
          <span className="live-pill__dot" aria-hidden="true" />
          {t('Live tracking')}
        </span>
        <span className="live-muted">
          {t('Përditësuar')} {clock(s.generatedAt, lang)}
        </span>
      </div>

      {x.incomplete && <Notice tone="warn">{t('Disa kosto mungojnë: fitimi mund të jetë më i lartë se realiteti.')}</Notice>}

      <div className="live-kpis">
        <div className="live-kpi live-kpi--accent">
          <span>{t('Qarkullimi (me TVSH)')}</span>
          <strong>{money(x.turnoverCents)}</strong>
          <small>{t('{count} shitje', { count: x.salesCount })}</small>
        </div>
        <div className="live-kpi live-kpi--good">
          <span>{t('Fitimi bruto')}</span>
          <strong>{money(x.grossProfitCents)}</strong>
          <small>{t('Pa TVSH, minus kosto')}</small>
        </div>
        <div className={cx('live-kpi', x.netProfitCents < 0 && 'live-kpi--bad')}>
          <span>{t('Fitimi neto')}</span>
          <strong>{money(x.netProfitCents)}</strong>
        </div>
        <div className="live-kpi">
          <span>{t('Shpenzimet')}</span>
          <strong>{money(x.expensesCents)}</strong>
        </div>
        <div className={cx('live-kpi', x.lossCents > 0 && 'live-kpi--bad')}>
          <span>{t('Humbjet')}</span>
          <strong>{money(x.lossCents)}</strong>
          <small>
            {t('Kthime {refunded} · Humbje stoku {stock}', {
              refunded: money(x.refundedCents),
              stock: money(x.stockLossCents),
            })}
          </small>
        </div>
        <div className="live-kpi">
          <span>{t('Borxh i dhënë sot')}</span>
          <strong>{money(x.debtGivenCents)}</strong>
        </div>
        <div className="live-kpi">
          <span>{t('Borxh i paguar sot')}</span>
          <strong>{money(x.debtCollectedCents)}</strong>
        </div>
        <div className="live-kpi live-kpi--accent">
          <span>{t('Arka')}</span>
          <strong>{d.open && d.expectedCents !== null ? money(d.expectedCents) : '—'}</strong>
          <small>{d.open ? t('Duhet të ketë tani') : t('Asnjë turn nuk është hapur')}</small>
        </div>
      </div>

      <div className="live-cols">
        <section className="card live-card">
          <h3>{t('Punonjësit')}</h3>
          {s.staff.length === 0 ? (
            <Empty>{t('Ende asnjë veprim nga punonjësit sot')}</Empty>
          ) : (
            <ul className="live-list">
              {s.staff.map((p) => (
                <li key={p.userId} className="live-row">
                  <div className="live-row__main">
                    <strong className="live-name">
                      {p.onDuty && <span className="live-dot" aria-hidden="true" />}
                      {p.name}
                    </strong>
                    <span className="live-muted">
                      {p.workedMinutes > 0 ? t('Punoi {time}', { time: formatMinutesShort(p.workedMinutes) }) : ''}
                      {p.lastSaleAt ? ` · ${t('Shitja e fundit {time}', { time: clock(p.lastSaleAt, lang) })}` : ''}
                    </span>
                  </div>
                  <div className="live-row__end">
                    <span className={cx('live-tag', p.onDuty && 'live-tag--on')}>
                      {p.onDuty ? t('Në punë') : t('Jashtë pune')}
                    </span>
                    <span className="live-money">{t('{count} shitje · {amount}', { count: p.salesCount, amount: money(p.salesCents) })}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card live-card">
          <h3>{t('Produktet kryesore sot')}</h3>
          {s.topProducts.length === 0 ? (
            <Empty>{t('Asnjë produkt i shitur sot')}</Empty>
          ) : (
            <ul className="live-list">
              {s.topProducts.map((p) => (
                <li key={p.name} className="live-row">
                  <span className="live-row__main">
                    <strong className="live-name">{p.name}</strong>
                    <span className="live-muted">×{qty(p.quantityMilli)}</span>
                  </span>
                  <span className="live-row__end">
                    <span className="live-money">{money(p.amountCents)}</span>
                    <span className="live-muted">{money(p.profitCents)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card live-card live-card--wide">
          <h3>{t('Shitjet live')}</h3>
          {s.feed.length === 0 ? (
            <Empty>{t('Ende asnjë shitje sot')}</Empty>
          ) : (
            <ol className="live-feed">
              {s.feed.map((sale) => (
                <FeedItem key={sale.saleId} sale={sale} lang={lang} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function FeedItem({ sale, lang }: { sale: LiveSale; lang: Lang }) {
  const t = useT();
  const items = sale.items.map((i) => (i.isTime ? i.name : `${i.name} ×${qty(i.quantityMilli)}`)).join(', ');
  return (
    <li className="live-feed__item">
      <span className="live-feed__time">{clock(sale.completedAt, lang)}</span>
      <div className="live-feed__body">
        <div>
          <strong>{sale.cashierName}</strong>
          <span className="live-muted"> · {items}</span>
          {sale.onCredit && <span className="live-tag live-tag--warn">{t('Borxh')}</span>}
        </div>
        <div className="live-feed__meta">
          <span className="live-money">{money(sale.totalCents)}</span>
          <span className="live-muted">
            {' · '}
            {t('fitimi {amount}', { amount: money(sale.profitCents) })}
            {sale.missingCost ? ` (${t('pa kosto')})` : ''}
          </span>
        </div>
      </div>
    </li>
  );
}
