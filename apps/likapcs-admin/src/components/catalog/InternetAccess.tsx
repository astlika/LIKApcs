/**
 * Internet access (0.34.0): Wi-Fi packages sold at the till, each with its own list of codes.
 *
 *  • `InternetAccessLoadDialog` — pick a package (or make a new one: name, price) and paste its
 *    codes, one per line. The paste is counted as it is typed and checked against what the
 *    system already knows, so a list pasted twice adds nothing.
 *  • `InternetAccessCodesDialog` — the codes of one package: the unused ones in the order they
 *    will be sold, the sold ones with their receipt; unused codes can be taken out again.
 *
 * A package is an ordinary product for everything else (price, category, picture, reports); its
 * stock is the number of its unused codes.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Plus, Trash2, Wifi } from 'lucide-react';
import {
  ACCESS_CODES_MAX_PER_LOAD,
  PERMISSIONS,
  internetPackageName,
  parseAccessCodes,
  parseMoneyInput,
  type CategorySummary,
  type InternetAccessCheckResult,
  type InternetAccessCodeSummary,
  type InternetAccessKnownCode,
  type InternetAccessLoadResult,
  type InternetAccessPackageSummary,
  type InternetAccessRemoveResult,
  type Paginated,
  type ProductSummary,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { SaleDetailDialog } from '../../pages/SalesPage';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Loading,
  Pagination,
  Segmented,
  Select,
  Textarea,
} from '../ui/primitives';

const PACKAGES_KEY = ['internet-access', 'packages'] as const;
const CODES_PAGE = 100;
/** The lengths offered as one tap when a package is named. */
const QUICK_NAMES = ['h1', 'h2', 'h3', 'h5', 'd1', 'w1', 'm1'] as const;

function usePackages() {
  return useQuery({
    queryKey: PACKAGES_KEY,
    queryFn: () => api<{ items: InternetAccessPackageSummary[] }>('/internet-access/packages'),
  });
}

/** "A, B, C +12 more": enough of a list to recognise it, never a wall of codes. */
function useShortList() {
  const { t } = useI18n();
  return (items: readonly string[], show = 6): string =>
    items.length <= show
      ? items.join(', ')
      : `${items.slice(0, show).join(', ')} ${t('internet.more', { n: items.length - show })}`;
}

// ─── Paste codes ─────────────────────────────────────────────────────────────
export function InternetAccessLoadDialog({
  categories,
  initialProductId,
  onClose,
}: {
  categories: CategorySummary[];
  /** Opened from one package ("Add codes"): that package is already chosen. */
  initialProductId?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const shortList = useShortList();
  const packages = usePackages();
  const active = useMemo(
    () => (packages.data?.items ?? []).filter((p) => p.product.isActive),
    [packages.data],
  );

  // Which package the codes go to: a product id, 'new', or '' while nothing is chosen. Nothing is
  // chosen for the owner — codes pasted into the wrong package would be sold at the wrong price.
  const [target, setTarget] = useState<string>(initialProductId ?? '');
  useEffect(() => {
    if (packages.isSuccess && active.length === 0 && target === '') setTarget('new');
  }, [packages.isSuccess, active.length, target]);

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [lowAt, setLowAt] = useState('10');
  const [nameError, setNameError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [allowSoldBefore, setAllowSoldBefore] = useState(false);

  const parsed = useMemo(() => parseAccessCodes(text), [text]);
  const codes = parsed.codes;
  const tooMany = codes.length > ACCESS_CODES_MAX_PER_LOAD;

  // What the system already knows about these codes — asked a moment after the typing stops.
  const [settled, setSettled] = useState<string[]>([]);
  useEffect(() => {
    const h = window.setTimeout(() => setSettled(codes), 350);
    return () => window.clearTimeout(h);
  }, [codes]);
  const check = useQuery({
    queryKey: ['internet-access', 'check', settled],
    queryFn: () =>
      api<InternetAccessCheckResult>('/internet-access/check', {
        method: 'POST',
        body: { codes: settled },
      }),
    enabled: settled.length > 0 && settled.length <= ACCESS_CODES_MAX_PER_LOAD,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  // The answer counts only while it is about the text on screen.
  const current = settled === codes;
  const known = current && check.isSuccess ? check.data : null;
  const checking = codes.length > 0 && !tooMany && (!current || check.isFetching);
  const waiting = known?.waiting ?? [];
  const soldBefore = known?.soldBefore ?? [];
  useEffect(() => {
    if (soldBefore.length === 0) setAllowSoldBefore(false);
  }, [soldBefore.length]);
  const willAdd = codes.length - waiting.length - (allowSoldBefore ? 0 : soldBefore.length);

  const priceCents = price.trim() ? parseMoneyInput(price) : null;
  const lowAtCodes = /^\d{1,6}$/.test(lowAt.trim()) ? Number(lowAt.trim()) : null;
  const isNew = target === 'new';
  const packageValid =
    !isNew || (name.trim().length > 0 && priceCents !== null && lowAtCodes !== null);
  const chosen = active.find((p) => p.product.id === target) ?? null;
  const canSave =
    target !== '' &&
    packageValid &&
    !tooMany &&
    !checking &&
    // An existing package needs something to add; a new one may start without codes.
    (isNew ? willAdd >= 0 : willAdd > 0);

  const save = useMutation({
    mutationFn: () =>
      api<InternetAccessLoadResult>('/internet-access/load', {
        method: 'POST',
        body: {
          ...(isNew
            ? {
                package: {
                  name: name.trim(),
                  sellingPriceCents: priceCents,
                  categoryId: categoryId || null,
                  lowAtCodes,
                },
              }
            : { productId: target }),
          codes,
          allowSoldBefore,
        },
      }),
    onSuccess: (r) => {
      const packageName = r.package.product.name;
      toast.success(
        r.added > 0
          ? t('internet.loaded', { n: r.added, name: packageName })
          : t('internet.created', { name: packageName }),
        t('internet.loadedTotal', { total: r.package.availableCodes }),
      );
      void queryClient.invalidateQueries({ queryKey: ['internet-access'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    },
    onError: (err) => {
      const code =
        err instanceof ApiError ? (err.details as { code?: string } | null)?.code : undefined;
      if (code === 'ACCESS_PACKAGE_EXISTS') {
        setNameError(t('internet.nameTaken'));
        return;
      }
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });

  /** "Internet 1h: A, B, C (+12 more) · Internet 2h: D" — the known codes, by their package. */
  const describe = (list: InternetAccessKnownCode[], withDate: boolean) => {
    const byPackage = new Map<string, string[]>();
    for (const k of list) {
      const entry = withDate && k.soldAt ? `${k.code} (${fmt.date(k.soldAt)})` : k.code;
      byPackage.set(k.productName, [...(byPackage.get(k.productName) ?? []), entry]);
    }
    return [...byPackage].map(([name, entries]) => `${name}: ${shortList(entries, 5)}`).join(' · ');
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('internet.title')}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!canSave}
            loading={save.isPending}
            onClick={() => save.mutate()}
            data-testid="internet-save"
          >
            <Wifi size={14} />{' '}
            {isNew
              ? willAdd > 0
                ? t('internet.saveNew', { n: willAdd })
                : t('internet.saveEmpty')
              : t('internet.save', { n: Math.max(0, willAdd) })}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted access-intro">{t('internet.intro')}</p>

        <div className="field">
          <div className="field__label">{t('internet.package')}</div>
          {packages.isLoading && <Loading />}
          {packages.isSuccess && (
            <div className="chips" role="group" aria-label={t('internet.package')}>
              {active.map((p) => (
                <button
                  key={p.product.id}
                  type="button"
                  className="chip access-package"
                  aria-pressed={target === p.product.id}
                  onClick={() => setTarget(p.product.id)}
                  data-testid="internet-package"
                >
                  <strong>{p.product.name}</strong>
                  <span className="faint">
                    {t('internet.packageLine', {
                      price: fmt.money(p.product.sellingPriceCents),
                      n: p.availableCodes,
                    })}
                  </span>
                </button>
              ))}
              <button
                type="button"
                className="chip access-package"
                aria-pressed={isNew}
                onClick={() => setTarget('new')}
                data-testid="internet-package-new"
              >
                <strong>
                  <Plus size={13} style={{ verticalAlign: '-2px' }} /> {t('internet.newPackage')}
                </strong>
                <span className="faint">{t('internet.newPackageHint')}</span>
              </button>
            </div>
          )}
          {target === '' && packages.isSuccess && (
            <div className="field__hint">{t('internet.choosePackage')}</div>
          )}
        </div>

        {isNew && (
          <div className="access-new">
            <Field
              label={t('internet.name')}
              hint={t('internet.nameHint')}
              error={nameError ?? undefined}
            >
              {(id, invalid) => (
                <Input
                  id={id}
                  value={name}
                  maxLength={120}
                  autoFocus
                  aria-invalid={invalid}
                  placeholder={internetPackageName(t('internet.quick.h1'))}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(null);
                  }}
                  data-testid="internet-name"
                />
              )}
            </Field>
            <div className="chips access-quick" role="group" aria-label={t('internet.name')}>
              {QUICK_NAMES.map((k) => {
                const label = t(`internet.quick.${k}` as 'internet.quick.h1');
                const full = internetPackageName(label);
                return (
                  <button
                    key={k}
                    type="button"
                    className="chip"
                    aria-pressed={name.trim() === full}
                    onClick={() => {
                      setName(full);
                      setNameError(null);
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="grid grid--3">
              <Field
                label={`${t('internet.price')} (${fmt.currency})`}
                error={price.trim() && priceCents === null ? t('common.invalid') : undefined}
              >
                {(id, invalid) => (
                  <Input
                    id={id}
                    value={price}
                    inputMode="decimal"
                    className="num"
                    placeholder="1.00"
                    aria-invalid={invalid}
                    onChange={(e) => setPrice(e.target.value)}
                    data-testid="internet-price"
                  />
                )}
              </Field>
              <Field label={t('internet.category')} optional>
                {(id) => (
                  <Select
                    id={id}
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                  >
                    <option value="">{t('internet.noCategory')}</option>
                    {categories
                      .filter((c) => c.isActive)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
              <Field
                label={t('internet.lowAt')}
                hint={t('internet.lowAtHint')}
                error={lowAtCodes === null ? t('common.invalid') : undefined}
              >
                {(id, invalid) => (
                  <Input
                    id={id}
                    value={lowAt}
                    inputMode="numeric"
                    className="num"
                    aria-invalid={invalid}
                    onChange={(e) => setLowAt(e.target.value)}
                  />
                )}
              </Field>
            </div>
          </div>
        )}

        <Field
          label={
            chosen ? t('internet.codesFor', { name: chosen.product.name }) : t('internet.codes')
          }
          hint={t('internet.codesHint', { max: ACCESS_CODES_MAX_PER_LOAD })}
        >
          {(id) => (
            <Textarea
              id={id}
              className="mono access-codes__input"
              rows={6}
              value={text}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              placeholder={t('internet.codesPlaceholder')}
              onChange={(e) => setText(e.target.value)}
              data-testid="internet-codes"
            />
          )}
        </Field>

        {parsed.pieces > 0 && (
          <div className="access-summary" data-testid="internet-summary">
            <div className="access-summary__count">
              <strong className="num" data-testid="internet-count">
                {t('internet.counted', { n: codes.length })}
              </strong>
              {codes.length > 1 && (
                <span className="faint mono">
                  {t('internet.firstLast', {
                    first: codes[0]!,
                    last: codes[codes.length - 1]!,
                  })}
                </span>
              )}
            </div>
            {tooMany && (
              <Alert tone="danger" icon={<AlertTriangle size={16} />}>
                {t('internet.tooMany', { n: codes.length, max: ACCESS_CODES_MAX_PER_LOAD })}
              </Alert>
            )}
            {parsed.repeated.length > 0 && (
              <div className="access-summary__note">
                {t('internet.repeated', {
                  n: parsed.repeated.length,
                  list: shortList(parsed.repeated),
                })}
              </div>
            )}
            {parsed.invalid.length > 0 && (
              <div className="access-summary__note text-warning">
                {t('internet.invalid', {
                  n: parsed.invalid.length,
                  list: shortList(parsed.invalid.map((x) => `«${x}»`)),
                })}
              </div>
            )}
            {checking && <div className="faint">{t('internet.checking')}</div>}
            {current && check.isError && (
              <div className="access-summary__note text-warning">{t('internet.checkFailed')}</div>
            )}
            {waiting.length > 0 && (
              <Alert tone="info">
                {t('internet.waiting', { n: waiting.length, list: describe(waiting, false) })}
              </Alert>
            )}
            {soldBefore.length > 0 && (
              <Alert tone="warning" icon={<AlertTriangle size={16} />}>
                <div>
                  {t('internet.soldBefore', {
                    n: soldBefore.length,
                    list: describe(soldBefore, true),
                  })}
                </div>
                <Checkbox
                  checked={allowSoldBefore}
                  onChange={(e) => setAllowSoldBefore(e.target.checked)}
                  label={t('internet.allowSoldBefore', { n: soldBefore.length })}
                  description={t('internet.allowSoldBeforeHint')}
                />
              </Alert>
            )}
            {known && !tooMany && (
              <div
                className={`access-summary__result ${willAdd > 0 ? 'text-success' : 'muted'}`}
                data-testid="internet-will-add"
              >
                {willAdd > 0 ? (
                  <>
                    <CheckCircle2 size={15} style={{ verticalAlign: '-2px' }} />{' '}
                    {t('internet.willAdd', { n: willAdd })}
                  </>
                ) : (
                  t('internet.nothingToAdd')
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ─── The codes of one package ────────────────────────────────────────────────
type CodesTab = 'available' | 'sold';

export function InternetAccessCodesDialog({
  product,
  onClose,
  onAddCodes,
}: {
  product: ProductSummary;
  onClose: () => void;
  /** Opens the paste dialog for this package. */
  onAddCodes: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const packages = usePackages();
  const pkg = packages.data?.items.find((p) => p.product.id === product.id) ?? null;

  const [tab, setTab] = useState<CodesTab>('available');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const [openSale, setOpenSale] = useState<string | null>(null);
  useEffect(() => {
    const h = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(h);
  }, [q]);
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [tab, debouncedQ]);

  const codes = useQuery({
    queryKey: ['internet-access', 'codes', product.id, tab, debouncedQ, page],
    queryFn: () =>
      api<Paginated<InternetAccessCodeSummary>>('/internet-access/codes', {
        query: {
          productId: product.id,
          status: tab,
          q: debouncedQ || undefined,
          page,
          pageSize: CODES_PAGE,
        },
      }),
    placeholderData: (prev) => prev,
  });
  const items = codes.data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((c) => selected.has(c.id));
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('internet.codesTitle', { name: product.name })}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" onClick={onAddCodes} data-testid="internet-add-codes">
            <Plus size={14} /> {t('internet.addCodes')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <Badge tone={pkg && pkg.availableCodes > 0 ? 'success' : 'danger'}>
            {t('internet.availableCount', { n: pkg?.availableCodes ?? '…' })}
          </Badge>
          <Badge>{t('internet.soldCount', { n: pkg?.soldCodes ?? '…' })}</Badge>
          <span className="muted">{fmt.money(product.sellingPriceCents)}</span>
          {pkg?.lastSoldAt && (
            <span className="faint">
              {t('internet.lastSold', { when: fmt.dateTime(pkg.lastSoldAt) })}
            </span>
          )}
        </div>
        <div className="toolbar">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'available', label: t('internet.available') },
              { value: 'sold', label: t('internet.sold') },
            ]}
            testId="internet-tab"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('internet.search')}
            aria-label={t('internet.search')}
            className="mono"
            style={{ maxWidth: 240 }}
          />
          {tab === 'available' && (
            <div className="row" style={{ gap: 6, marginLeft: 'auto' }}>
              <Button
                size="sm"
                disabled={selected.size === 0}
                onClick={() => setRemoving({ ids: [...selected], count: selected.size })}
                data-testid="internet-remove-selected"
              >
                <Trash2 size={13} /> {t('internet.removeSelected', { n: selected.size })}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!pkg || pkg.availableCodes === 0}
                onClick={() => setRemoving({ all: true, count: pkg?.availableCodes ?? 0 })}
              >
                {t('internet.removeAll')}
              </Button>
            </div>
          )}
        </div>

        {codes.isLoading && <Loading />}
        {codes.isError && <p className="text-danger">{t('common.errorGeneric')}</p>}
        {codes.isSuccess && items.length === 0 && (
          <p className="muted">
            {debouncedQ
              ? t('internet.noMatch')
              : tab === 'available'
                ? t('internet.noCodes')
                : t('internet.noSold')}
          </p>
        )}
        {codes.isSuccess && items.length > 0 && (
          <div className="table-wrap">
            {tab === 'available' && !debouncedQ && (
              <p className="faint access-order-hint">{t('internet.nextHint')}</p>
            )}
            <table className="table table--compact" data-testid="internet-codes-table">
              <thead>
                {tab === 'available' ? (
                  <tr>
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        checked={allOnPage}
                        aria-label={t('internet.selectPage')}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            for (const c of items) {
                              if (allOnPage) next.delete(c.id);
                              else next.add(c.id);
                            }
                            return next;
                          })
                        }
                      />
                    </th>
                    {!debouncedQ && <th className="right">{t('internet.order')}</th>}
                    <th>{t('internet.code')}</th>
                    <th>{t('internet.loadedAt')}</th>
                    <th>{t('internet.loadedBy')}</th>
                  </tr>
                ) : (
                  <tr>
                    <th>{t('internet.code')}</th>
                    <th>{t('internet.soldAt')}</th>
                    <th>{t('internet.receipt')}</th>
                    <th>{t('internet.soldBy')}</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {items.map((c, i) =>
                  tab === 'available' ? (
                    <tr key={c.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selected.has(c.id)}
                          aria-label={c.code}
                          onChange={() => toggle(c.id)}
                        />
                      </td>
                      {!debouncedQ && (
                        <td className="right num faint">{(page - 1) * CODES_PAGE + i + 1}</td>
                      )}
                      <td className="mono access-code-cell">{c.code}</td>
                      <td className="num faint">{fmt.dateTime(c.loadedAt)}</td>
                      <td className="faint">{c.loadedByName ?? '—'}</td>
                    </tr>
                  ) : (
                    <tr key={c.id}>
                      <td className="mono access-code-cell">{c.code}</td>
                      <td className="num">{c.soldAt ? fmt.dateTime(c.soldAt) : '—'}</td>
                      <td>
                        {c.saleId && can(PERMISSIONS.POS_SELL) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            title={t('internet.openSale')}
                            onClick={() => setOpenSale(c.saleId)}
                          >
                            <span className="mono">{c.receiptNo ?? '—'}</span>
                          </Button>
                        ) : (
                          <span className="mono">{c.receiptNo ?? '—'}</span>
                        )}
                      </td>
                      <td className="faint">{c.soldByName ?? '—'}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
            <Pagination
              page={page}
              pageSize={CODES_PAGE}
              total={codes.data.total}
              onPage={setPage}
            />
          </div>
        )}
      </div>
      {removing && (
        <RemoveCodesDialog
          product={product}
          target={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            setSelected(new Set());
          }}
        />
      )}
      {openSale && (
        <SaleDetailDialog
          saleId={openSale}
          onClose={() => setOpenSale(null)}
          canRefund={can(PERMISSIONS.POS_REFUND)}
          canReprint={can(PERMISSIONS.POS_REPRINT)}
          canInvoice={can(PERMISSIONS.INVOICES_MANAGE)}
          canViewInvoice={can(PERMISSIONS.INVOICES_VIEW)}
          onResume={() => setOpenSale(null)}
        />
      )}
    </Dialog>
  );
}

interface RemoveTarget {
  ids?: number[];
  all?: true;
  count: number;
}

function RemoveCodesDialog({
  product,
  target,
  onClose,
  onRemoved,
}: {
  product: ProductSummary;
  target: RemoveTarget;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState(t('internet.removeReasonDefault'));
  const remove = useMutation({
    mutationFn: () =>
      api<InternetAccessRemoveResult>('/internet-access/remove', {
        method: 'POST',
        body: {
          productId: product.id,
          ...(target.all ? { all: true } : { ids: target.ids }),
          reason: reason.trim(),
        },
      }),
    onSuccess: (r) => {
      toast.success(
        t('internet.removed', { n: r.removed }),
        t('internet.loadedTotal', { total: r.package.availableCodes }),
      );
      void queryClient.invalidateQueries({ queryKey: ['internet-access'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onRemoved();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
      void queryClient.invalidateQueries({ queryKey: ['internet-access'] });
    },
  });
  const valid = reason.trim().length >= 2;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('internet.removeTitle')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            disabled={!valid}
            loading={remove.isPending}
            onClick={() => remove.mutate()}
            data-testid="internet-remove-confirm"
          >
            <Trash2 size={14} /> {t('internet.removeConfirm', { n: target.count })}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>{t('internet.removeBody', { n: target.count, name: product.name })}</p>
        <Field label={t('internet.removeReason')}>
          {(id) => (
            <Input
              id={id}
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && valid && !remove.isPending) remove.mutate();
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
