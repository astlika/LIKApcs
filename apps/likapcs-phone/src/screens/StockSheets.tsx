import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InventoryMovementSummary, Paginated, ProductSummary } from '@likapcs/shared';
import { api, errorText, money } from '../api';
import { apiOrigin } from '../native';
import { Btn, Choices, Field, Notice, Sheet, cx } from '../components/ui';
import { useT, useLang, localeOf, type TFunc } from '../i18n';
import { checkPin, hasPin } from '../pinLock';
import { useNotify } from '../notify';
import { buzz, playSound } from '../sound';
import {
  daysLeft,
  isLarge,
  salesByDay,
  statusOf,
  toUnits,
  type StockStatus,
  type StockViewPrefs,
} from '../stockView';
import {
  handOffToSale,
  isStockSnoozed,
  searchProducts,
  setSnooze,
  snoozeUntil,
} from '../stockData';

export const STATUS_LABEL: Record<StockStatus, string> = {
  out: 'Mbaruar',
  low: 'Stok i ulët',
  ok: 'Në rregull',
  plenty: 'Stok i shumtë',
  untracked: 'Pa gjurmim',
};
export const STATUS_TONE: Record<StockStatus, string> = {
  out: 'badge--danger',
  low: 'badge--warn',
  ok: 'badge--ok',
  plenty: 'badge--accent',
  untracked: 'badge--off',
};
export const STATUS_ICON: Record<StockStatus, string> = {
  out: '✕',
  low: '▲',
  ok: '●',
  plenty: '◆',
  untracked: '○',
};

/** Stock number with its unit, in the phone's language. */
export function useUnits(): (milli: number) => string {
  const lang = useLang();
  return (milli: number) =>
    (milli / 1000).toLocaleString(localeOf(lang), { maximumFractionDigits: 3 });
}

const MOVE_LABEL: Record<string, string> = {
  sale: 'Shitje',
  refund: 'Kthim shitjeje',
  purchase: 'Blerje',
  stock_count: 'Numërim',
  adjustment: 'Korrigjim',
  initial: 'Stoku fillestar',
  opening: 'Stoku i hapjes',
  damaged: 'Dëmtim',
  expired: 'Skadencë',
  missing: 'Mungesë',
};

// ── Product details ──────────────────────────────────────────────────────────

export function ProductSheet({
  product,
  prefs,
  allProducts,
  supplierName,
  canAdjust,
  canCost,
  canManage,
  canSell,
  onClose,
  onAction,
  onSell,
}: {
  product: ProductSummary;
  prefs: StockViewPrefs;
  allProducts: ProductSummary[];
  supplierName: string | null;
  canAdjust: boolean;
  canCost: boolean;
  canManage: boolean;
  canSell: boolean;
  onClose: () => void;
  onAction: (mode: 'add' | 'count' | 'loss') => void;
  onSell: () => void;
}) {
  const t: TFunc = useT();
  const units = useUnits();
  const lang = useLang();
  const qc = useQueryClient();
  const notify = useNotify();
  const status = statusOf(product, prefs);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const moves = useQuery({
    queryKey: ['phone', 'stock-moves', product.id],
    queryFn: () =>
      api<Paginated<InventoryMovementSummary>>(
        `/inventory/movements?${new URLSearchParams({ productId: product.id, from: since, pageSize: '200' }).toString()}`,
      ),
    retry: false,
  });
  const sales = moves.data ? salesByDay(moves.data.items) : null;
  const left = sales ? daysLeft(product.stockMilli, sales.avgPerDay) : null;
  const max = Math.max(1, ...(sales?.days ?? [1]));
  const when = (iso: string) =>
    new Date(iso).toLocaleString(localeOf(lang), { dateStyle: 'short', timeStyle: 'short' });
  const variants = allProducts.filter((p) => p.parentId === product.id);
  const parent = product.parentId ? allProducts.find((p) => p.id === product.parentId) : undefined;

  // Minimum stock and the note: only for accounts that may change products.
  const [minText, setMinText] = useState(String(toUnits(product.minStockMilli)));
  const [noteText, setNoteText] = useState(product.description ?? '');
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/products/${product.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['phone', 'stock-products'] });
      notify(t('Produkti u ruajt.'));
    },
  });
  const minValue = Number(minText.replace(',', '.'));
  const minValid = Number.isFinite(minValue) && minValue >= 0;

  return (
    <Sheet
      title={product.name}
      onClose={onClose}
      footer={
        <div className="stock-actions">
          {canSell && (
            <Btn
              variant="ghost"
              onClick={() => {
                handOffToSale(product);
                onSell();
              }}
            >
              {t('Shit tani')}
            </Btn>
          )}
          {canAdjust ? (
            <>
              <Btn onClick={() => onAction('add')}>{t('Shto stok')}</Btn>
              <Btn variant="ghost" onClick={() => onAction('count')}>
                {t('Numëro fizikisht')}
              </Btn>
              <Btn variant="ghost" onClick={() => onAction('loss')}>
                {t('Dëmtim / skadencë')}
              </Btn>
            </>
          ) : (
            <Notice tone="info">
              {t('Ndryshimi i stokut është vetëm për llogaritë me leje.')}
            </Notice>
          )}
        </div>
      }
    >
      {product.imageUrl && (
        <img className="stock-photo" src={`${apiOrigin()}${product.imageUrl}`} alt={product.name} />
      )}
      <div className="row row--between">
        <span className={cx('badge', STATUS_TONE[status])}>
          {STATUS_ICON[status]} {t(STATUS_LABEL[status])}
        </span>
        <span className="muted small">{product.sku}</span>
      </div>

      <div className="stock-big">
        <span className="stock-big__num">{units(product.stockMilli)}</span>
        <span className="muted">{product.unitCode}</span>
      </div>
      <p className="muted small">
        {t('Minimumi: {qty}', { qty: units(product.minStockMilli) })}
        {product.storageLocation ? ` · ${t('Vendndodhja')}: ${product.storageLocation}` : ''}
      </p>

      <div className="stock-facts">
        <div>
          <span className="muted small">{t('Çmimi i shitjes')}</span>
          <strong>{money(product.sellingPriceCents)}</strong>
        </div>
        {canCost && (
          <div>
            <span className="muted small">{t('Çmimi i blerjes')}</span>
            <strong>{money(product.purchaseCostCents)}</strong>
          </div>
        )}
        {product.categoryName && (
          <div>
            <span className="muted small">{t('Kategoria')}</span>
            <strong>{product.categoryName}</strong>
          </div>
        )}
        <div>
          <span className="muted small">{t('Furnitori i produktit')}</span>
          <strong>
            {supplierName ?? (product.supplierId ? t('Furnitor pa emër') : t('Pa furnitor'))}
          </strong>
        </div>
      </div>

      {parent && (
        <p className="small">
          <span className="muted">{t('Variant i')}: </span>
          {parent.name}
          {product.variantLabel ? ` · ${product.variantLabel}` : ''}
        </p>
      )}
      {variants.length > 0 && (
        <>
          <strong className="small">{t('Variantet')}</strong>
          <ul className="list list--tight">
            {variants.map((v) => (
              <li key={v.id} className="row row--between small">
                <span>{v.variantLabel ?? v.name}</span>
                <strong className={v.stockMilli <= 0 ? 'text-danger' : undefined}>
                  {units(v.stockMilli)} {v.unitCode}
                </strong>
              </li>
            ))}
          </ul>
        </>
      )}

      {product.barcodes.length > 0 && (
        <p className="small">
          <span className="muted">{t('Barkodi')}: </span>
          {product.barcodes.map((b) => b.barcode).join(', ')}
        </p>
      )}

      {canManage ? (
        <div className="stock-edit stack-sm">
          <Field label={t('Minimumi i stokut')}>
            <div className="row">
              <input
                inputMode="decimal"
                value={minText}
                onChange={(e) => setMinText(e.target.value)}
              />
              <button
                type="button"
                className="ghost small-btn"
                disabled={!minValid || save.isPending}
                onClick={() => save.mutate({ minStockMilli: Math.round(minValue * 1000) })}
              >
                {t('Ruaj')}
              </button>
            </div>
          </Field>
          <Field label={t('Shënim për produktin')}>
            <div className="row">
              <input
                value={noteText}
                maxLength={1000}
                onChange={(e) => setNoteText(e.target.value)}
              />
              <button
                type="button"
                className="ghost small-btn"
                disabled={save.isPending || noteText === (product.description ?? '')}
                onClick={() => save.mutate({ description: noteText.trim() || null })}
              >
                {t('Ruaj')}
              </button>
            </div>
          </Field>
          {save.isError && <Notice tone="danger">{errorText(save.error)}</Notice>}
        </div>
      ) : (
        product.description && <p className="small muted">{product.description}</p>
      )}

      <div className="stock-chart-head">
        <strong>{t('Shitjet 30 ditët e fundit')}</strong>
        <span className="muted small">
          {sales
            ? `${t('Mesatarja ditore')}: ${sales.avgPerDay.toLocaleString(localeOf(lang), { maximumFractionDigits: 1 })}`
            : ''}
        </span>
      </div>
      {moves.isLoading && <p className="muted small">{t('Duke ngarkuar…')}</p>}
      {moves.error && (
        <Notice tone="warn">{t('Historiku nuk është i disponueshëm për këtë llogari.')}</Notice>
      )}
      {sales && (
        <>
          <div className="stock-bars" role="img" aria-label={t('Shitjet 30 ditët e fundit')}>
            {sales.days.map((d, i) => (
              <span
                key={i}
                className={cx('stock-bars__bar', d === 0 && 'stock-bars__bar--zero')}
                style={{ height: `${Math.max(4, (d / max) * 100)}%` }}
                title={`${d}`}
              />
            ))}
          </div>
          <p className="small">
            {left === null
              ? t('Nuk ka shitje në 30 ditët e fundit.')
              : t('Mjafton për rreth {days} ditë', { days: left })}
          </p>
        </>
      )}

      {moves.data && moves.data.items.length > 0 && (
        <>
          <strong className="small">{t('Lëvizjet e fundit')}</strong>
          <ul className="list list--tight">
            {moves.data.items.slice(0, 8).map((m) => (
              <li key={m.id} className="row row--between small">
                <span>
                  {t(MOVE_LABEL[m.movementType] ?? 'Lëvizje')} · {when(m.createdAt)}
                </span>
                <strong className={m.quantityMilliDelta < 0 ? 'text-danger' : 'text-ok'}>
                  {m.quantityMilliDelta > 0 ? '+' : ''}
                  {units(m.quantityMilliDelta)}
                </strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </Sheet>
  );
}

// ── Add / count / loss ───────────────────────────────────────────────────────

const ADD_REASONS = ['Blerje', 'Kthim', 'Dhuratë', 'Tjetër'];
const LOSS_REASONS = ['Dëmtim', 'Skadencë', 'Humbje'];

/**
 * One sheet for the three stock changes. Large amounts need a second tap, and the PIN when the
 * phone has one. A change can be undone from the list for one minute. In a count, "Tjetra" moves on
 * to the next product of the list without saving this one.
 */
export function AdjustSheet({
  product,
  mode,
  onClose,
  onSaved,
  onNext,
}: {
  product: ProductSummary;
  mode: 'add' | 'count' | 'loss';
  onClose: () => void;
  onSaved: (undo: { productId: string; name: string; deltaMilli: number } | null) => void;
  onNext?: () => void;
}) {
  const t: TFunc = useT();
  const lang = useLang();
  const units = useUnits();
  const qc = useQueryClient();
  const notify = useNotify();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState(
    mode === 'add' ? ADD_REASONS[0]! : mode === 'loss' ? LOSS_REASONS[0]! : '',
  );
  const [confirm, setConfirm] = useState(false);
  const [pin, setPin] = useState('');
  const current = toUnits(product.stockMilli);
  const parsed = Number(amount.replace(',', '.'));
  const valid = amount !== '' && Number.isFinite(parsed) && parsed >= 0;

  // The change in units: positive for add, negative for loss, the difference for a count.
  const delta = !valid ? 0 : mode === 'add' ? parsed : mode === 'loss' ? -parsed : parsed - current;
  const large =
    valid &&
    (mode === 'count'
      ? Math.abs(delta) >= 10 || (current > 0 && Math.abs(delta) / current >= 0.2)
      : isLarge(parsed));
  const needPin = large && hasPin();

  const save = useMutation({
    mutationFn: async () => {
      if (needPin && !(await checkPin(pin))) {
        throw new Error(t('PIN i gabuar'));
      }
      if (mode === 'count') {
        return api(`/products/${product.id}/stock`, {
          method: 'POST',
          body: {
            type: 'stock_count',
            newStockMilli: Math.round(parsed * 1000),
            reason: reason || t('Numërim fizik'),
          },
        });
      }
      return api(`/products/${product.id}/stock`, {
        method: 'POST',
        body: {
          type:
            mode === 'loss'
              ? reason === 'Skadencë'
                ? 'expired'
                : reason === 'Humbje'
                  ? 'missing'
                  : 'damaged'
              : 'adjustment',
          quantityMilliDelta: Math.round(delta * 1000),
          reason,
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['phone', 'stock-products'] });
      void qc.invalidateQueries({ queryKey: ['phone', 'stock-moves', product.id] });
      notify(t('Stoku u ruajt: {name}', { name: product.name }));
      onSaved(
        mode === 'count' || delta === 0
          ? null
          : { productId: product.id, name: product.name, deltaMilli: Math.round(delta * 1000) },
      );
      if (onNext) onNext();
      else onClose();
    },
  });

  const quick = mode === 'add' ? [1, 5, 10, 25] : mode === 'loss' ? [1, 2, 5] : [];
  const reasons = mode === 'add' ? ADD_REASONS : mode === 'loss' ? LOSS_REASONS : [];
  const title =
    mode === 'add'
      ? t('Shto stok')
      : mode === 'loss'
        ? t('Dëmtim / skadencë')
        : t('Numëro fizikisht');
  const canSave = valid && (mode === 'count' || parsed > 0);

  return (
    <Sheet
      title={`${title} · ${product.name}`}
      onClose={onClose}
      footer={
        <>
          {save.isError && <Notice tone="danger">{errorText(save.error)}</Notice>}
          {!confirm || !large ? (
            <Btn
              block
              onClick={() => (large ? setConfirm(true) : save.mutate())}
              disabled={!canSave || save.isPending || (needPin && pin.length !== 4)}
            >
              {save.isPending
                ? t('Duke ruajtur…')
                : large
                  ? t('Vazhdo')
                  : onNext
                    ? t('Ruaj dhe vazhdo')
                    : t('Ruaj')}
            </Btn>
          ) : (
            <Btn
              variant="danger"
              block
              onClick={() => save.mutate()}
              disabled={save.isPending || (needPin && pin.length !== 4)}
            >
              {t('Po, konfirmo')}
            </Btn>
          )}
          {onNext && (
            <Btn variant="ghost" block onClick={onNext}>
              {t('Tjetra pa ruajtur')}
            </Btn>
          )}
        </>
      }
    >
      <p className="muted small">
        {t('Stoku aktual')}:{' '}
        <strong>
          {units(product.stockMilli)} {product.unitCode}
        </strong>
      </p>

      {mode === 'count' ? (
        <Field label={t('Sasia e numëruar')}>
          <input
            inputMode="decimal"
            value={amount}
            placeholder={String(current)}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
        </Field>
      ) : (
        <>
          {quick.length > 0 && (
            <div className="stock-quick" role="group" aria-label={t('Sasi e shpejtë')}>
              {quick.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="ghost"
                  onClick={() => setAmount(String((Number(amount) || 0) + q))}
                >
                  +{q}
                </button>
              ))}
            </div>
          )}
          <Field label={`${t('Sasia')} (${product.unitCode})`}>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </Field>
        </>
      )}

      {reasons.length > 0 && (
        <Choices
          label={t('Arsyeja')}
          options={reasons.map((r) => ({ value: r, label: t(r) }))}
          value={reason}
          onChange={setReason}
        />
      )}
      {mode === 'count' && (
        <Field label={t('Arsyeja')} hint={t('Opsionale')}>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder={t('Numërim fizik')}
          />
        </Field>
      )}

      {mode === 'count' && valid && (
        <p
          className={cx(
            'stock-diff',
            delta === 0 ? 'text-ok' : Math.abs(delta) >= 10 ? 'text-danger' : 'text-warn',
          )}
        >
          {t('Diferenca')}:{' '}
          {delta === 0
            ? t('Saktë')
            : `${delta > 0 ? '+' : ''}${units(Math.round(delta * 1000))} ${product.unitCode}`}
        </p>
      )}
      {mode !== 'count' && valid && (
        <p className="small muted">
          {t('Stoku pas ndryshimit')}:{' '}
          {(current + delta).toLocaleString(localeOf(lang), { maximumFractionDigits: 3 })}{' '}
          {product.unitCode}
        </p>
      )}
      {confirm && large && (
        <Notice tone="warn">{t('Sasi e madhe. Kontrolloni para se të ruani.')}</Notice>
      )}
      {needPin && (
        <Field label={t('PIN i telefonit')} hint={t('Kërkohet për sasi të mëdha.')}>
          <input
            inputMode="numeric"
            type="password"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
        </Field>
      )}
    </Sheet>
  );
}

// ── Bulk receipt ─────────────────────────────────────────────────────────────

/** "Faturë hyrje": several products received on one invoice, saved one after another. */
export function BulkSheet({
  products,
  onClose,
  onDone,
}: {
  products: ProductSummary[];
  onClose: () => void;
  onDone: (saved: number) => void;
}) {
  const t: TFunc = useT();
  const qc = useQueryClient();
  const notify = useNotify();
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState<{ product: ProductSummary; amount: string }[]>([]);
  const [reason, setReason] = useState('Faturë hyrje');
  const [failed, setFailed] = useState<string[]>([]);
  const results = useMemo(
    () => (search.trim() ? searchProducts(products, search.trim()).slice(0, 8) : []),
    [products, search],
  );
  const valid = lines.filter((l) => Number(l.amount.replace(',', '.')) > 0);

  const save = useMutation({
    mutationFn: async () => {
      const errors: string[] = [];
      let saved = 0;
      for (const l of valid) {
        try {
          await api(`/products/${l.product.id}/stock`, {
            method: 'POST',
            body: {
              type: 'adjustment',
              quantityMilliDelta: Math.round(Number(l.amount.replace(',', '.')) * 1000),
              reason: reason.trim() || 'Faturë hyrje',
            },
          });
          saved++;
        } catch {
          errors.push(l.product.name);
        }
      }
      return { saved, errors };
    },
    onSuccess: ({ saved, errors }) => {
      void qc.invalidateQueries({ queryKey: ['phone', 'stock-products'] });
      setFailed(errors);
      if (errors.length === 0) {
        notify(t('Faturën e hyrjes e ruajtëm: {n} produkte', { n: saved }));
        onDone(saved);
        onClose();
      }
    },
  });

  return (
    <Sheet
      title={t('Faturë hyrje')}
      onClose={onClose}
      footer={
        <>
          {failed.length > 0 && (
            <Notice tone="danger">
              {t('Këto nuk u ruajtën: {names}', { names: failed.join(', ') })}
            </Notice>
          )}
          <Btn block onClick={() => save.mutate()} disabled={valid.length === 0 || save.isPending}>
            {save.isPending ? t('Duke ruajtur…') : t('Ruaj të gjitha ({n})', { n: valid.length })}
          </Btn>
        </>
      }
    >
      <Field label={t('Kërko produktin për ta shtuar')}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('Emri, kodi ose barkodi')}
        />
      </Field>
      {results.length > 0 && (
        <ul className="list list--tight">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="list-btn"
                onClick={() => {
                  if (!lines.some((l) => l.product.id === p.id))
                    setLines((ls) => [...ls, { product: p, amount: '' }]);
                  setSearch('');
                }}
              >
                {p.name} <span className="muted small">+</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {lines.map((l) => (
        <div key={l.product.id} className="row row--between">
          <span className="stock-bulk__name">{l.product.name}</span>
          <input
            className="stock-bulk__qty"
            inputMode="decimal"
            aria-label={`${t('Sasia')} ${l.product.name}`}
            value={l.amount}
            onChange={(e) =>
              setLines((ls) =>
                ls.map((x) =>
                  x.product.id === l.product.id ? { ...x, amount: e.target.value } : x,
                ),
              )
            }
          />
          <span className="muted small">{l.product.unitCode}</span>
          <button
            type="button"
            className="ghost small-btn"
            aria-label={t('Hiq')}
            onClick={() => setLines((ls) => ls.filter((x) => x.product.id !== l.product.id))}
          >
            ✕
          </button>
        </div>
      ))}
      {lines.length === 0 && (
        <p className="muted small">{t('Shtoni produktet e faturës një nga një.')}</p>
      )}
      <Field label={t('Arsyeja')}>
        <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Sheet>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function SettingsSheet({
  prefs,
  onChange,
  onClose,
  onReset,
}: {
  prefs: StockViewPrefs;
  onChange: (patch: Partial<StockViewPrefs>) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const t: TFunc = useT();
  const [pause, setPause] = useState<string>(() => {
    if (!isStockSnoozed()) return '0';
    return snoozeUntil() - Date.now() > 90 * 60_000 ? '240' : '60';
  });
  const until = snoozeUntil();
  const pausedNow = isStockSnoozed();
  const left = pausedNow ? Math.ceil((until - Date.now()) / 60_000) : 0;
  return (
    <Sheet title={t('Cilësimet e stokut')} onClose={onClose}>
      <Choices
        label={t('Stok i shumtë kur është të paktën')}
        options={[3, 5, 10].map((n) => ({ value: n, label: `${n}× ${t('min')}` }))}
        value={prefs.plentyMultiple}
        onChange={(v) => onChange({ plentyMultiple: v })}
      />
      <Choices
        label={t('Produkti pa minimum është "shumë" nga')}
        options={[10, 20, 50].map((n) => ({ value: n, label: `${n} ${t('njësi')}` }))}
        value={prefs.plentyUnits}
        onChange={(v) => onChange({ plentyUnits: v })}
      />
      <Choices
        label={t('Çmimet në listë')}
        options={[
          { value: 0, label: t('Fshihen') },
          { value: 1, label: t('Shfaqen') },
        ]}
        value={prefs.showPrices ? 1 : 0}
        onChange={(v) => onChange({ showPrices: v === 1 })}
      />
      <Choices
        label={t('Pauzë njoftimesh stoku')}
        options={[
          { value: '0', label: t('Aktive') },
          { value: '60', label: t('1 orë') },
          { value: '240', label: t('4 orë') },
        ]}
        value={pause}
        onChange={(v) => {
          setPause(v);
          setSnooze(Number(v));
        }}
      />
      {pausedNow && (
        <p className="small muted">
          {t('Njoftimet e stokut janë në pauzë: edhe {min} min.', { min: left })}
        </p>
      )}
      <Btn variant="ghost" block onClick={onReset}>
        {t('Rivendos cilësimet')}
      </Btn>
    </Sheet>
  );
}

// ── Barcode scan ─────────────────────────────────────────────────────────────

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => DetectorLike;
  }
}

/**
 * Camera scan: the browser's barcode detector where it exists, otherwise a decoder that runs in the
 * page (ZXing). Camera access needs the phone's permission; without it the sheet says so.
 */
export function ScanSheet({
  onFound,
  onClose,
}: {
  onFound: (code: string) => void;
  onClose: () => void;
}) {
  const t: TFunc = useT();
  const video = useRef<HTMLVideoElement>(null);
  const onFoundRef = useRef(onFound);
  // Without a camera permission (plain http in a browser, or the APK's denied camera) the sheet says why.
  const cameraOk = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const [failed, setFailed] = useState(!cameraOk);
  useEffect(() => {
    onFoundRef.current = onFound;
  }, [onFound]);
  useEffect(() => {
    const node = video.current;
    if (!node) return;
    let stopped = false;
    let timer: number | undefined;
    let stopDecoder: (() => void) | null = null;
    if (!cameraOk) return;
    const done = (code: string) => {
      // The beep: the scan is taken as soon as the code is read.
      playSound('scan');
      buzz(40);
      if (stopped) return;
      stopped = true;
      onFoundRef.current(code);
    };
    const Detector = window.BarcodeDetector;

    if (Detector) {
      const detector = new Detector({
        formats: ['ean_13', 'ean_8', 'code_128', 'upc_a', 'qr_code'],
      });
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'environment' } })
        .then(async (s) => {
          if (stopped) {
            s.getTracks().forEach((tr) => tr.stop());
            return;
          }
          node.srcObject = s;
          stopDecoder = () => s.getTracks().forEach((tr) => tr.stop());
          await node.play();
          const loop = async () => {
            if (stopped) return;
            try {
              const code = (await detector.detect(node))[0]?.rawValue;
              if (code) return done(code);
            } catch {
              /* a frame that cannot be read: the next one is tried */
            }
            timer = window.setTimeout(loop, 350);
          };
          void loop();
        })
        .catch(() => setFailed(true));
    } else {
      import('@zxing/library')
        .then(async ({ BrowserMultiFormatReader }) => {
          const reader = new BrowserMultiFormatReader();
          stopDecoder = () => reader.reset();
          await reader.decodeFromConstraints(
            { video: { facingMode: 'environment' } },
            node,
            (result) => {
              if (result) done(result.getText());
            },
          );
          if (stopped) reader.reset();
        })
        .catch(() => setFailed(true));
    }
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      stopDecoder?.();
    };
  }, []);
  return (
    <Sheet title={t('Skano barkodin')} onClose={onClose}>
      {failed ? (
        <Notice tone="warn">
          {cameraOk
            ? t('Kamera nuk u hap. Lejoni kamerën ose shkruani kodin.')
            : t('Kamera nuk hapet në këtë adresë (http). Hapeni nga APK ose përdorni skanerin USB te kërkimi.')}
        </Notice>
      ) : (
        <video ref={video} className="stock-scan" playsInline muted />
      )}
      <p className="small muted">{t('Drejtoni kamerën nga barkodi. Kodi plotësohet vetvetiu.')}</p>
    </Sheet>
  );
}
