import { useState } from 'react';
import type { Paginated, ProductLookupResponse, ProductSummary } from '@likapcs/shared';
import { api, errorText } from '../api';
import { useLive } from '../useLive';
import { Empty, Loading, Notice, QueryError, cx } from '../components/ui';
import { localeOf, useLang, useT } from '../i18n';

/** Low stock list and a barcode check. Read-only: stock is changed on the desk. */
export function Stock() {
  const t = useT();
  const lang = useLang();
  const units = (milli: number) => (milli / 1000).toLocaleString(localeOf(lang), { maximumFractionDigits: 3 });
  const [code, setCode] = useState('');
  const [found, setFound] = useState<ProductSummary | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const low = useLive(['low-stock'], () => api<Paginated<ProductSummary>>('/products?lowStock=true&pageSize=200&active=active'));

  const check = async () => {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    setLookupError(null);
    try {
      const res = await api<ProductLookupResponse>(`/products/lookup?${new URLSearchParams({ code: c }).toString()}`);
      setFound(res.product);
    } catch (err) {
      setFound(null);
      setLookupError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>{t('Stoku')}</h1>
      </div>

      <form
        className="card card--flat stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <label className="small muted" htmlFor="barcode">
          {t('Kontrollo barkodin ose kodin')}
        </label>
        <div className="row">
          <input id="barcode" className="search" value={code} onChange={(e) => setCode(e.target.value)} inputMode="text" autoComplete="off" placeholder={t('Shkruani ose skanoni')} />
          <button type="submit" className="ghost small-btn" disabled={busy || !code.trim()}>
            {busy ? '…' : t('Kontrollo')}
          </button>
        </div>
        {lookupError && <Notice tone="warn">{lookupError}</Notice>}
        {found && (
          <div className="row row--between">
            <strong>{found.name}</strong>
            <span className={cx('badge', found.lowStock ? 'badge--warn' : 'badge--ok')}>{t('Stoku: {qty}', { qty: units(found.stockMilli) })}</span>
          </div>
        )}
      </form>

      <h2 className="small muted">{t('Stoku i ulët')}</h2>
      {low.isLoading && <Loading />}
      {low.error && <QueryError message={t('Lista e stokut nuk u ngarkua.')} onRetry={() => void low.refetch()} />}
      {low.data && low.data.items.length === 0 && <Empty>{t('Nuk ka produkte me stok të ulët.')}</Empty>}
      {low.data && low.data.items.length > 0 && (
        <ul className="list">
          {low.data.items.map((p) => (
            <li key={p.id} className="debt-row">
              <span className="pc-row__main">
                <strong>{p.name}</strong>
                <span className="muted small">{t('Minimumi: {qty}', { qty: units(p.minStockMilli) })}</span>
              </span>
              <span className="badge badge--warn">{units(p.stockMilli)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
