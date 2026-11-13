import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CategorySummary,
  InventoryMovementSummary,
  Paginated,
  ProductLookupResponse,
  ProductSummary,
  PurchaseSummary,
} from '@likapcs/shared';
import { PERMISSIONS } from '@likapcs/shared';
import { api, errorText, money } from '../api';
import { useLive } from '../useLive';
import { useDebounced } from '../useDebounced';
import { useMe, can } from '../me';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { buzz, playSound, unlockSound } from '../sound';
import { Btn, Empty, Loading, QueryError, cx, haptic } from '../components/ui';
import { useT, useLang, localeOf, type TFunc } from '../i18n';
import {
  DEFAULT_PREFS,
  loadPrefs,
  loadRecent,
  matchesBarcode,
  matchesStatus,
  orderText,
  pushRecent,
  savePrefs,
  sortProducts,
  statusOf,
  stockCsv,
  stockValueCents,
  type ActiveFilter,
  type BarcodeFilter,
  type SortKey,
  type StatusFilter,
  type StockStatus,
  type StockViewPrefs,
} from '../stockView';
import {
  daysLeftFor,
  isInternetAccess,
  loadSnapshot,
  saveSnapshot,
  searchProducts,
  soldByProduct,
  supplierNames,
} from '../stockData';
import {
  AdjustSheet,
  BulkSheet,
  ProductSheet,
  STATUS_ICON,
  STATUS_LABEL,
  STATUS_TONE,
  ScanSheet,
  SettingsSheet,
  useUnits,
} from './StockSheets';

const PAGE = 60;
const UNDO_MS = 60_000;
const SALES_DAYS = 30;

/** Every product (the server pages at 500). The search runs on the phone, on this full list. */
async function fetchAllProducts(params: {
  categoryId: string;
  active: ActiveFilter;
}): Promise<ProductSummary[]> {
  const out: ProductSummary[] = [];
  for (let page = 1; page <= 20; page++) {
    const qs = new URLSearchParams({ active: params.active, page: String(page), pageSize: '500' });
    if (params.categoryId) qs.set('categoryId', params.categoryId);
    const res = await api<Paginated<ProductSummary>>(`/products?${qs.toString()}`);
    out.push(...res.items);
    if (out.length >= res.total || res.items.length === 0) break;
  }
  return out;
}

/** Sales of the last 30 days, all products (for "days left" and the speed sort). */
async function fetchSales(): Promise<InventoryMovementSummary[]> {
  const from = new Date(Date.now() - SALES_DAYS * 86_400_000).toISOString();
  const out: InventoryMovementSummary[] = [];
  for (let page = 1; page <= 10; page++) {
    const qs = new URLSearchParams({ type: 'sale', from, page: String(page), pageSize: '200' });
    const res = await api<Paginated<InventoryMovementSummary>>(
      `/inventory/movements?${qs.toString()}`,
    );
    out.push(...res.items);
    if (res.items.length < 200) break;
  }
  return out;
}

type SpeechLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start: () => void;
};
const speechCtor = (): (new () => SpeechLike) | null => {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechLike;
    webkitSpeechRecognition?: new () => SpeechLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export function Stock() {
  const t: TFunc = useT();
  const lang = useLang();
  const units = useUnits();
  const notify = useNotify();
  const qc = useQueryClient();
  const online = useOnline();
  const me = useMe(true);
  const canAdjust = can(me.data, PERMISSIONS.INVENTORY_ADJUST);
  const canCost = can(me.data, PERMISSIONS.PRODUCTS_MANAGE);
  const canSell = can(me.data, PERMISSIONS.POS_SELL);
  const canPurchases = can(me.data, PERMISSIONS.PURCHASES_VIEW);

  const [prefs, setPrefsState] = useState<StockViewPrefs>(loadPrefs);
  const setPrefs = (patch: Partial<StockViewPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefsState(next);
    savePrefs(next);
  };

  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 200);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<ProductSummary | null>(null);
  const [adjusting, setAdjusting] = useState<{
    product: ProductSummary;
    mode: 'add' | 'count' | 'loss';
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [listening, setListening] = useState(false);
  const [pullPx, setPullPx] = useState(0);
  const [undo, setUndo] = useState<{
    productId: string;
    name: string;
    deltaMilli: number;
    until: number;
  } | null>(null);
  const [, setTick] = useState(0);
  const pullStart = useRef<number | null>(null);

  // Remember searches that are long enough to be useful.
  useEffect(() => {
    if (q.length >= 2) setRecent(pushRecent(q));
  }, [q]);

  // Scrolling back to the top of a new list.
  useEffect(() => {
    setLimit(PAGE);
  }, [
    q,
    prefs.status,
    prefs.barcode,
    prefs.active,
    prefs.categoryId,
    prefs.supplierId,
    prefs.sort,
  ]);

  // The undo window: the counter ticks every second and the button goes away after a minute.
  useEffect(() => {
    if (!undo) return;
    const id = window.setInterval(() => {
      if (Date.now() >= undo.until) setUndo(null);
      setTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [undo]);

  const products = useLive(['stock-products', prefs.categoryId, prefs.active], () =>
    fetchAllProducts({ categoryId: prefs.categoryId, active: prefs.active }),
  );
  const categories = useLive(['stock-categories'], () =>
    api<CategorySummary[]>('/catalog/categories'),
  );
  const sales = useQuery({
    queryKey: ['phone', 'stock-sales'],
    queryFn: fetchSales,
    enabled: canAdjust || can(me.data, PERMISSIONS.PRODUCTS_VIEW),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const purchases = useQuery({
    queryKey: ['phone', 'stock-purchases'],
    queryFn: () => api<Paginated<PurchaseSummary>>('/purchases?pageSize=100'),
    enabled: canPurchases,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Offline copy: the last full list the phone got, shown when the server cannot be reached.
  useEffect(() => {
    if (products.data && prefs.active === 'active' && !prefs.categoryId)
      saveSnapshot(products.data);
  }, [products.data, prefs.active, prefs.categoryId]);
  const snapshot = useMemo(() => (products.error ? loadSnapshot() : null), [products.error]);
  const all = products.data ?? snapshot?.items ?? [];
  const usingSnapshot = !products.data && snapshot !== null;

  const soldMap = useMemo(() => soldByProduct(sales.data ?? []), [sales.data]);
  const supplierMap = useMemo(() => supplierNames(purchases.data?.items ?? []), [purchases.data]);
  const supplierOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of all) {
      if (p.supplierId && !m.has(p.supplierId)) {
        m.set(
          p.supplierId,
          supplierMap.get(p.supplierId) ?? `${t('Furnitor')} ${p.supplierId.slice(0, 4)}`,
        );
      }
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], localeOf(lang)));
  }, [all, supplierMap, t, lang]);

  // Search first (accents and typos are ignored), then the status, barcode and supplier filters.
  const searched = useMemo(() => (q ? searchProducts(all, q) : all), [all, q]);
  const counts = useMemo(() => {
    const c = { all: searched.length, out: 0, low: 0, ok: 0, plenty: 0, order: 0, value: 0 };
    for (const p of searched) {
      const s = statusOf(p, prefs);
      if (s === 'out') c.out++;
      else if (s === 'low') c.low++;
      else if (s === 'ok') c.ok++;
      else if (s === 'plenty') c.plenty++;
      if (s === 'out' || s === 'low') c.order++;
      c.value += stockValueCents(p);
    }
    return c;
  }, [searched, prefs]);

  const visible = useMemo(() => {
    const filtered = searched.filter(
      (p) =>
        matchesStatus(statusOf(p, prefs), prefs.status) &&
        matchesBarcode(p, prefs.barcode) &&
        (!prefs.supplierId || p.supplierId === prefs.supplierId),
    );
    return sortProducts(filtered, prefs.sort, soldMap);
  }, [searched, prefs, soldMap]);

  const shown = visible.slice(0, limit);
  const hasMore = visible.length > limit;
  const statusName = (p: ProductSummary) => t(STATUS_LABEL[statusOf(p, prefs)]);

  // Infinite scroll: the next page loads when the end of the list comes into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setLimit((n) => n + PAGE);
      },
      { rootMargin: '240px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore]);

  const activeChips: { key: string; label: string; clear: () => void }[] = [];
  if (prefs.categoryId) {
    const name = categories.data?.find((c) => c.id === prefs.categoryId)?.name ?? t('Kategoria');
    activeChips.push({ key: 'cat', label: name, clear: () => setPrefs({ categoryId: '' }) });
  }
  if (prefs.supplierId) {
    activeChips.push({
      key: 'sup',
      label: supplierOptions.find(([id]) => id === prefs.supplierId)?.[1] ?? t('Furnitori'),
      clear: () => setPrefs({ supplierId: '' }),
    });
  }
  if (prefs.barcode !== 'any') {
    activeChips.push({
      key: 'bc',
      label: prefs.barcode === 'with' ? t('Me barkod') : t('Pa barkod'),
      clear: () => setPrefs({ barcode: 'any' }),
    });
  }
  if (prefs.active !== 'active') {
    activeChips.push({
      key: 'act',
      label: prefs.active === 'inactive' ? t('Jo aktiv') : t('Të gjitha'),
      clear: () => setPrefs({ active: 'active' }),
    });
  }
  if (prefs.status !== 'all') {
    activeChips.push({
      key: 'st',
      label:
        prefs.status === 'order' ? t('Për porosi') : t(STATUS_LABEL[prefs.status as StockStatus]),
      clear: () => setPrefs({ status: 'all' }),
    });
  }
  const filtersOn = activeChips.length > 0 || query !== '';
  const clearAll = () => {
    setQuery('');
    setPrefs({ status: 'all', barcode: 'any', active: 'active', categoryId: '', supplierId: '' });
  };

  const exportCsv = () => {
    const csv = stockCsv(visible, statusName);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stoku-${new Date().toLocaleDateString('sv-SE')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(t('CSV u gjenerua: {n} produkte', { n: visible.length }));
  };

  // Order list: as plain text, through the share sheet when the phone has one, else copied.
  const orderList = () => all.filter((p) => matchesStatus(statusOf(p, prefs), 'order'));
  const copyOrder = async () => {
    const list = orderList();
    const text = orderText(list);
    try {
      if (navigator.share) {
        await navigator.share({ title: t('Lista e porosisë'), text });
        return;
      }
      await navigator.clipboard.writeText(text);
      notify(t('Lista e porosisë u kopjua: {n} produkte', { n: list.length }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      notify(t('Lista nuk u kopjua. Provoni përsëri.'), 'err');
    }
  };

  // A scanned code opens its product: from the list first, then from the server.
  const openCode = async (code: string) => {
    setScanning(false);
    haptic(20);
    const local = all.find((p) => p.barcodes.some((b) => b.barcode === code));
    if (local) {
      setSelected(local);
      return;
    }
    try {
      const res = await api<ProductLookupResponse>(
        `/products/lookup?${new URLSearchParams({ code }).toString()}`,
      );
      if (res.product) {
        setSelected(res.product);
        return;
      }
    } catch {
      /* not found: the search below shows the code */
    }
    playSound('error');
    setQuery(code);
    notify(t('Ky barkod nuk u gjet: {code}', { code }), 'err');
  };

  const startVoice = () => {
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = lang === 'en' ? 'en-US' : 'sq-AL';
    rec.interimResults = false;
    rec.onresult = (e) => {
      const said = e.results[0]?.[0]?.transcript ?? '';
      setQuery(said.trim());
      setListening(false);
    };
    setListening(true);
    rec.start();
  };

  const voiceOn = speechCtor() !== null;

  // The product after the one being counted, in the order of the list.
  const nextAfter = (p: ProductSummary): ProductSummary | null => {
    const i = visible.findIndex((x) => x.id === p.id);
    // Internet access is not counted by hand: its stock is its unused codes.
    return i >= 0 ? (visible.slice(i + 1).find((x) => !isInternetAccess(x)) ?? null) : null;
  };
  const countNext = adjusting?.mode === 'count' ? nextAfter(adjusting.product) : null;

  const usingSnapshotNote =
    usingSnapshot && snapshot ? (
      <div className="stock-banner" role="status">
        {t('Pa lidhje: po shfaqet kopja e fundit nga {time}.', {
          time: new Date(snapshot.savedAt).toLocaleTimeString(localeOf(lang), {
            hour: '2-digit',
            minute: '2-digit',
          }),
        })}
      </div>
    ) : null;

  return (
    <div
      className="stack stock-page"
      onTouchStart={(e) => {
        pullStart.current = window.scrollY <= 0 ? (e.touches[0]?.clientY ?? null) : null;
      }}
      onTouchMove={(e) => {
        if (pullStart.current === null) return;
        const dy = (e.touches[0]?.clientY ?? 0) - pullStart.current;
        setPullPx(dy > 0 ? Math.min(90, dy * 0.5) : 0);
      }}
      onTouchEnd={() => {
        if (pullPx >= 60) void products.refetch();
        pullStart.current = null;
        setPullPx(0);
      }}
    >
      {pullPx > 0 && (
        <div className="stock-pull" style={{ height: pullPx }} aria-hidden="true">
          {pullPx >= 60 ? t('Lësho për rifreskim') : t('Tërhiq për rifreskim')}
        </div>
      )}

      <div className="stock-sticky">
        <div className="page-head row row--between">
          <h1>{t('Stoku')}</h1>
          <div className="row stock-tools">
            <button
              type="button"
              className={cx('ghost small-btn', prefs.view === 'compact' && 'stock-tool--on')}
              onClick={() => setPrefs({ view: prefs.view === 'cards' ? 'compact' : 'cards' })}
              aria-label={prefs.view === 'cards' ? t('Listë') : t('Kartela')}
              aria-pressed={prefs.view === 'compact'}
            >
              {prefs.view === 'cards' ? '≡' : '▦'}
            </button>
            <button
              type="button"
              className={cx('ghost small-btn', filtersOpen && 'stock-tool--on')}
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
            >
              {t('Filtrat')}
              {activeChips.length + (query ? 1 : 0) > 0
                ? ` (${activeChips.length + (query ? 1 : 0)})`
                : ''}
            </button>
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => void products.refetch()}
              aria-label={t('Rifresko')}
            >
              ⟳
            </button>
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => setSettingsOpen(true)}
              aria-label={t('Cilësimet e stokut')}
            >
              ⚙
            </button>
          </div>
        </div>

        <div className="stock-search row">
          <input
            className="search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // A USB or Bluetooth scanner types the code and presses Enter: the product opens with the beep.
              if (e.key !== 'Enter') return;
              const code = query.trim();
              if (!code) return;
              const exact = all.find((p) => p.barcodes.some((b) => b.barcode === code));
              if (exact) {
                playSound('scan');
                buzz(40);
                setSelected(exact);
                return;
              }
              const hits = searchProducts(all, code);
              if (hits.length === 1 && hits[0]) setSelected(hits[0]);
            }}
            placeholder={t('Kërko me emër, kod ose barkod')}
            autoComplete="off"
            aria-label={t('Kërko produktin')}
          />
          {query && (
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => setQuery('')}
              aria-label={t('Pastro kërkimin')}
            >
              ✕
            </button>
          )}
          {(
            <button
              type="button"
              className="ghost small-btn"
              onClick={() => {
                // The tap lets the browser play the scan beep later.
                unlockSound();
                setScanning(true);
              }}
              aria-label={t('Skano barkodin')}
            >
              ▦
            </button>
          )}
          {voiceOn && (
            <button
              type="button"
              className={cx('ghost small-btn', listening && 'stock-listening')}
              onClick={startVoice}
              aria-label={t('Kërko me zë')}
            >
              🎙
            </button>
          )}
        </div>

        <div className="stock-chips" role="group" aria-label={t('Statusi i stokut')}>
          {(['all', 'out', 'low', 'plenty', 'ok'] as StatusFilter[]).map((s) => {
            const n = s === 'all' ? counts.all : counts[s];
            const label = s === 'all' ? t('Të gjitha') : t(STATUS_LABEL[s as StockStatus]);
            return (
              <button
                key={s}
                type="button"
                className={cx(
                  'stock-pill',
                  s !== 'all' && `stock-pill--${s}`,
                  prefs.status === s && 'stock-pill--on',
                )}
                aria-pressed={prefs.status === s}
                onClick={() => setPrefs({ status: prefs.status === s ? 'all' : s })}
              >
                {s !== 'all' && <span aria-hidden="true">{STATUS_ICON[s as StockStatus]}</span>}{' '}
                {label} <strong>{n}</strong>
              </button>
            );
          })}
        </div>

        {filtersOpen && (
          <div className="stock-filters">
            <select
              value={prefs.categoryId}
              onChange={(e) => setPrefs({ categoryId: e.target.value })}
              aria-label={t('Kategoria')}
            >
              <option value="">{t('Të gjitha kategoritë')}</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={prefs.supplierId}
              onChange={(e) => setPrefs({ supplierId: e.target.value })}
              aria-label={t('Furnitori')}
            >
              <option value="">{t('Të gjithë furnitorët')}</option>
              {supplierOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={prefs.barcode}
              onChange={(e) => setPrefs({ barcode: e.target.value as BarcodeFilter })}
              aria-label={t('Barkodi')}
            >
              <option value="any">{t('Me/pa barkod')}</option>
              <option value="with">{t('Me barkod')}</option>
              <option value="without">{t('Pa barkod')}</option>
            </select>
            <select
              value={prefs.active}
              onChange={(e) => setPrefs({ active: e.target.value as ActiveFilter })}
              aria-label={t('Aktiv')}
            >
              <option value="active">{t('Aktiv')}</option>
              <option value="inactive">{t('Jo aktiv')}</option>
              <option value="all">{t('Të gjitha')}</option>
            </select>
            <select
              value={prefs.sort}
              onChange={(e) => setPrefs({ sort: e.target.value as SortKey })}
              aria-label={t('Rendit sipas')}
            >
              <option value="name">{t('Emri A–Z')}</option>
              <option value="stock-asc">{t('Stoku më i ulët')}</option>
              <option value="stock-desc">{t('Stoku më i lartë')}</option>
              <option value="ratio">{t('Stok / minimum')}</option>
              <option value="days">{t('Ditët e mbetura')}</option>
              <option value="speed">{t('Më të shiturit (30 ditë)')}</option>
              {canCost && <option value="value">{t('Vlera e stokut')}</option>}
              <option value="category">{t('Kategoria')}</option>
              <option value="updated">{t('Ndryshimi i fundit')}</option>
            </select>
          </div>
        )}

        {filtersOn && (
          <div className="stock-chips stock-chips--active" aria-label={t('Filtrat aktivë')}>
            {activeChips.map((c) => (
              <button
                key={c.key}
                type="button"
                className="stock-chip stock-chip--on"
                onClick={c.clear}
              >
                {c.label} <span aria-hidden="true">✕</span>
              </button>
            ))}
            {query && (
              <button
                type="button"
                className="stock-chip stock-chip--on"
                onClick={() => setQuery('')}
              >
                “{query}” <span aria-hidden="true">✕</span>
              </button>
            )}
            <button type="button" className="ghost small-btn" onClick={clearAll}>
              {t('Pastro filtrat')}
            </button>
          </div>
        )}
      </div>

      {usingSnapshotNote}
      {!online && !usingSnapshot && (
        <div className="stock-banner">{t('Pa lidhje me serverin.')}</div>
      )}

      {!query && recent.length > 0 && (
        <div className="stock-chips" aria-label={t('Kërkimet e fundit')}>
          {recent.map((r) => (
            <button key={r} type="button" className="stock-chip" onClick={() => setQuery(r)}>
              {r}
            </button>
          ))}
        </div>
      )}

      {undo && (
        <div className="stock-undo" role="status">
          <span>
            {t('Stoku u ndryshua: {name}', { name: undo.name })} ·{' '}
            {Math.max(0, Math.ceil((undo.until - Date.now()) / 1000))}s
          </span>
          <button
            type="button"
            className="ghost small-btn"
            onClick={async () => {
              const u = undo;
              setUndo(null);
              try {
                await api(`/products/${u.productId}/stock`, {
                  method: 'POST',
                  body: {
                    type: 'adjustment',
                    quantityMilliDelta: -u.deltaMilli,
                    reason: t('Anulim i ndryshimit'),
                  },
                });
                void qc.invalidateQueries({ queryKey: ['phone', 'stock-products'] });
                notify(t('Ndryshimi u anulua.'));
              } catch (err) {
                notify(errorText(err), 'err');
              }
            }}
          >
            {t('Anulo')}
          </button>
        </div>
      )}

      {products.isLoading && !snapshot && <Loading />}
      {products.error && !snapshot && (
        <QueryError
          message={t('Lista e stokut nuk u ngarkua.')}
          onRetry={() => void products.refetch()}
        />
      )}

      {(products.data || snapshot) && all.length === 0 && (
        <Empty>{filtersOn ? t('Asnjë produkt me këto filtra.') : t('Nuk ka produkte.')}</Empty>
      )}

      {all.length > 0 && visible.length === 0 && (
        <Empty>
          {t('Asnjë produkt me këto filtra.')}
          <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <Btn variant="ghost" onClick={clearAll}>
              {t('Pastro filtrat')}
            </Btn>
          </div>
        </Empty>
      )}

      {shown.length > 0 && (
        <p className="muted small stock-count-line">
          {t('{n} nga {total} produkte', { n: shown.length, total: visible.length })}
          {canCost && (
            <>
              {' · '}
              {t('Vlera e stokut')}: <strong>{money(counts.value)}</strong>
            </>
          )}
        </p>
      )}

      <ul className={cx('list', prefs.view === 'compact' ? 'stock-compact' : 'stock-cards')}>
        {shown.map((p, i) => {
          // Sorted by category: a heading starts each group.
          const group = prefs.sort === 'category' ? (p.categoryName ?? t('Pa kategori')) : null;
          const prev = i > 0 ? shown[i - 1] : undefined;
          const prevGroup = prev ? (prev.categoryName ?? t('Pa kategori')) : null;
          return (
            <Fragment key={p.id}>
              {group !== null && group !== prevGroup && (
                <li className="stock-group" role="presentation">
                  {group}
                </li>
              )}
              <StockRow
                product={p}
                status={statusOf(p, prefs)}
                compact={prefs.view === 'compact'}
                showPrice={prefs.showPrices}
                units={units}
                canAdjust={canAdjust && !isInternetAccess(p)}
                statusName={statusName(p)}
                days={daysLeftFor(p, soldMap.get(p.id))}
                onOpen={() => setSelected(p)}
                onQuick={() =>
                  canAdjust && !isInternetAccess(p) && setAdjusting({ product: p, mode: 'add' })
                }
              />
            </Fragment>
          );
        })}
      </ul>
      {hasMore && <div ref={sentinel} className="stock-sentinel" aria-hidden="true" />}
      {hasMore && (
        <Btn variant="ghost" block onClick={() => setLimit((n) => n + PAGE)}>
          {t('Shfaq më shumë')}
        </Btn>
      )}

      {all.length > 0 && (
        <div className="stock-footer row">
          <Btn variant="ghost" onClick={() => void copyOrder()} disabled={orderList().length === 0}>
            {t('Ndaj listën e porosisë')} ({orderList().length})
          </Btn>
          <Btn variant="ghost" onClick={exportCsv} disabled={visible.length === 0}>
            {t('Eksporto CSV')}
          </Btn>
          {canAdjust && (
            <Btn variant="ghost" onClick={() => setBulkOpen(true)}>
              {t('Faturë hyrje')}
            </Btn>
          )}
        </div>
      )}

      {selected && (
        <ProductSheet
          product={selected}
          prefs={prefs}
          allProducts={all}
          supplierName={selected.supplierId ? (supplierMap.get(selected.supplierId) ?? null) : null}
          canAdjust={canAdjust && !isInternetAccess(selected)}
          canCost={canCost}
          canManage={can(me.data, PERMISSIONS.PRODUCTS_MANAGE)}
          canSell={canSell}
          onClose={() => setSelected(null)}
          onAction={(mode) => {
            setAdjusting({ product: selected, mode });
            setSelected(null);
          }}
          onSell={() => setSelected(null)}
        />
      )}
      {adjusting && (
        <AdjustSheet
          key={`${adjusting.product.id}-${adjusting.mode}`}
          product={adjusting.product}
          mode={adjusting.mode}
          onClose={() => setAdjusting(null)}
          onSaved={(u) => {
            if (u) setUndo({ ...u, until: Date.now() + UNDO_MS });
          }}
          onNext={countNext ? () => setAdjusting({ product: countNext, mode: 'count' }) : undefined}
        />
      )}
      {bulkOpen && (
        <BulkSheet
          products={all.filter((p) => !isInternetAccess(p))}
          onClose={() => setBulkOpen(false)}
          onDone={(n) => notify(t('Faturën e hyrjes e ruajtëm: {n} produkte', { n }))}
        />
      )}
      {settingsOpen && (
        <SettingsSheet
          prefs={prefs}
          onChange={setPrefs}
          onClose={() => setSettingsOpen(false)}
          onReset={() => setPrefs({ ...DEFAULT_PREFS, active: prefs.active })}
        />
      )}
      {scanning && (
        <ScanSheet onFound={(code) => void openCode(code)} onClose={() => setScanning(false)} />
      )}
    </div>
  );
}

/**
 * One product in the list. Tap opens it. Long press, or a swipe to the left, adds stock when the
 * account may change stock.
 */
function StockRow({
  product,
  status,
  compact,
  showPrice,
  units,
  canAdjust,
  statusName,
  days,
  onOpen,
  onQuick,
}: {
  product: ProductSummary;
  status: StockStatus;
  compact: boolean;
  showPrice: boolean;
  units: (milli: number) => string;
  canAdjust: boolean;
  statusName: string;
  days: number | null;
  onOpen: () => void;
  onQuick: () => void;
}) {
  const t: TFunc = useT();
  const timer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const start = useRef<{ x: number; y: number; dx: number; locked: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  const cancel = () => window.clearTimeout(timer.current);
  const place = [product.categoryName, product.storageLocation].filter(Boolean).join(' · ');
  const variant = product.parentName
    ? `${product.parentName}${product.variantLabel ? ` · ${product.variantLabel}` : ''}`
    : null;
  return (
    <li className="stock-swipe">
      {canAdjust && dx < -8 && (
        <span className="stock-swipe__hint" aria-hidden="true">
          + {t('Shto')}
        </span>
      )}
      <button
        type="button"
        className={cx('stock-item', `stock-item--${status}`, compact && 'stock-item--compact')}
        style={dx ? { transform: `translateX(${Math.max(-120, Math.min(0, dx))}px)` } : undefined}
        onClick={() => {
          if (held.current) {
            held.current = false;
            return;
          }
          onOpen();
        }}
        onPointerDown={(e) => {
          held.current = false;
          start.current = { x: e.clientX, y: e.clientY, dx: 0, locked: false };
          if (!canAdjust) return;
          timer.current = window.setTimeout(() => {
            held.current = true;
            haptic(25);
            onQuick();
          }, 550);
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (!s) return;
          const mx = e.clientX - s.x;
          const my = e.clientY - s.y;
          if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) {
            // A vertical move is scrolling: the swipe and the long press are dropped.
            cancel();
            start.current = null;
            setDx(0);
            return;
          }
          if (Math.abs(mx) > 8 || Math.abs(my) > 8) cancel();
          if (canAdjust && mx < 0) {
            s.dx = mx;
            setDx(mx);
          }
        }}
        onPointerUp={() => {
          cancel();
          const s = start.current;
          start.current = null;
          if (s && s.dx < -90 && canAdjust) {
            held.current = true;
            haptic(20);
            onQuick();
          }
          setDx(0);
        }}
        onPointerLeave={() => {
          cancel();
          setDx(0);
        }}
        onPointerCancel={() => {
          cancel();
          start.current = null;
          setDx(0);
        }}
        onContextMenu={(e) => e.preventDefault()}
        aria-label={`${product.name}, ${statusName}, ${units(product.stockMilli)} ${product.unitCode}`}
      >
        <span className="stock-item__main">
          <strong>{product.name}</strong>
          <span className="muted small">
            {variant ?? (place || product.sku)}
            {showPrice ? ` · ${money(product.sellingPriceCents)}` : ''}
          </span>
          {!compact && (
            <span className="stock-item__badges">
              <span className={cx('badge', STATUS_TONE[status])}>
                {STATUS_ICON[status]} {statusName}
              </span>
              {days !== null && status !== 'out' && (
                <span className="muted small">{t('≈ {days} ditë', { days })}</span>
              )}
            </span>
          )}
          {product.minStockMilli > 0 && (
            <span className="stock-meter" aria-hidden="true">
              <span
                className={cx('stock-meter__fill', `stock-meter__fill--${status}`)}
                style={{
                  width: `${Math.min(100, Math.max(0, (product.stockMilli / (product.minStockMilli * 2)) * 100))}%`,
                }}
              />
            </span>
          )}
        </span>
        <span className="stock-item__qty">
          <strong className="stock-item__num">{units(product.stockMilli)}</strong>
          <span className="muted small">{product.unitCode}</span>
          {product.minStockMilli > 0 && (
            <span className="muted small">
              {t('min {qty}', { qty: units(product.minStockMilli) })}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
