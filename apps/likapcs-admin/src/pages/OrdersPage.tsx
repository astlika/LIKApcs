/**
 * Orders (0.10.0): what customers order from their seat.
 *   Open     — waiting (accept / reject) and "on the bill" (pay at the desk / write off).
 *   History  — every order with a status filter; receipts of the sold ones.
 *   Menu     — which products the PCs offer under "Order", in which order (products.manage).
 * Live through `order.changed`; the menu reaches the PCs the moment it is saved.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Banknote,
  Check,
  Monitor,
  PackageCheck,
  ReceiptText,
  ScanLine,
  Search,
  ShoppingBag,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import type {
  CategorySummary,
  OrderStatus,
  ProductSummary,
  SettingsMap,
  StationOrder,
} from '@likapcs/shared';
import { ORDER_STATUSES, PERMISSIONS } from '@likapcs/shared';
import {
  AcceptOrderDialog,
  OrderReceiptDialog,
  OrderStatusBadge,
  PrepareOrderDialog,
  RejectOrderDialog,
  orderItemsText,
} from '../components/orders/orders';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  Loading,
  PageHeader,
  Select,
  Tabs,
} from '../components/ui/primitives';
import { useI18n } from '../i18n';
import { api, ApiError, fileUrl } from '../lib/api';
import { useFormat } from '../lib/format';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';

type Tab = 'open' | 'history' | 'menu';
const TABS: Tab[] = ['open', 'history', 'menu'];

export function OrdersPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : 'open';
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === 'open') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };
  const canMenu = can(PERMISSIONS.PRODUCTS_VIEW);
  const publicSettings = useQuery({
    queryKey: ['settings', 'public'],
    queryFn: () => api<Partial<SettingsMap>>('/settings/public', { auth: false }),
  });
  const enabled = publicSettings.data?.['orders.enabled'] ?? true;

  return (
    <>
      <PageHeader title={t('orders.title')} subtitle={t('orders.subtitle')} />
      {!enabled && (
        <Alert tone="warning">
          {t('orders.disabledBanner')}{' '}
          {can(PERMISSIONS.SETTINGS_MANAGE) && (
            <Link to="/settings?tab=stations">{t('orders.disabledLink')}</Link>
          )}
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={TABS.filter((id) => id !== 'menu' || canMenu).map((id) => ({
          id,
          label: t(
            id === 'open'
              ? 'orders.tabOpen'
              : id === 'history'
                ? 'orders.tabHistory'
                : 'orders.tabMenu',
          ),
        }))}
      />
      {tab === 'open' && (
        <OrdersList
          open
          defaultSettlement={publicSettings.data?.['orders.settlement'] ?? 'ask'}
          scanCheck={publicSettings.data?.['orders.scan_check'] ?? true}
        />
      )}
      {tab === 'history' && (
        <OrdersList
          open={false}
          defaultSettlement={publicSettings.data?.['orders.settlement'] ?? 'ask'}
          scanCheck={publicSettings.data?.['orders.scan_check'] ?? true}
        />
      )}
      {tab === 'menu' && canMenu && <MenuEditor />}
    </>
  );
}

// ─── Orders list ───────────────────────────────────────────────────────────────
function OrdersList({
  open,
  defaultSettlement,
  scanCheck,
}: {
  open: boolean;
  defaultSettlement: 'ask' | 'pay_now' | 'on_bill';
  scanCheck: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);
  const canSell = can(PERMISSIONS.POS_SELL);
  const [status, setStatus] = useState<OrderStatus | ''>('');
  const query = useQuery({
    queryKey: ['orders', open ? 'open' : 'history', status],
    queryFn: () =>
      api<{ items: StationOrder[] }>('/orders', {
        query: open ? { open: true, limit: 200 } : { status: status || undefined, limit: 200 },
      }),
    refetchInterval: 30_000,
  });
  const [action, setAction] = useState<{
    order: StationOrder;
    kind: 'accept' | 'pay' | 'reject' | 'void' | 'receipt' | 'prepare';
  } | null>(null);
  const items = query.data?.items ?? [];

  if (query.isLoading) return <Loading />;
  if (query.isError) return <Alert tone="danger">{t('common.errorGeneric')}</Alert>;

  return (
    <>
      {!open && (
        <div className="row" style={{ marginBottom: 12 }}>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as OrderStatus | '')}
            style={{ maxWidth: 220 }}
            data-testid="orders-status-filter"
          >
            <option value="">{t('orders.filterAll')}</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`orders.status.${s}`)}
              </option>
            ))}
          </Select>
        </div>
      )}
      {items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShoppingBag size={28} />}
            title={open ? t('orders.none') : t('orders.noneHistory')}
            hint={open ? t('orders.noneHint') : undefined}
          />
        </Card>
      ) : (
        <Card flush>
          <ul className="orders-list" data-testid="orders-list">
            {items.map((o) => (
              <li key={o.id} className="orders-row" data-testid="orders-row" data-status={o.status}>
                <div className="orders-row__head">
                  <strong>{t('orders.number', { number: o.number })}</strong>
                  <Badge tone="accent">
                    <Monitor size={11} /> {o.stationCode}
                  </Badge>
                  <OrderStatusBadge order={o} />
                  {o.preparedAt && (
                    <Badge tone="success" dot>
                      <PackageCheck size={11} /> {t('orders.prepare.prepared')}
                    </Badge>
                  )}
                  <span className="muted">{fmt.dateTime(o.requestedAt)}</span>
                  {o.customerName && <span className="muted">· {o.customerName}</span>}
                  <span style={{ flex: 1 }} />
                  <strong className="num orders-row__total">{fmt.money(o.totalCents)}</strong>
                </div>
                <div className="orders-row__body">
                  <span>{orderItemsText(o, 6)}</span>
                  {o.note && <span className="muted"> · „{o.note}”</span>}
                  {o.reason && (
                    <span className="muted">
                      {' '}
                      · {t('orders.reason')}: {o.reason}
                    </span>
                  )}
                  {o.decidedByName && (
                    <span className="faint"> · {t('orders.by', { name: o.decidedByName })}</span>
                  )}
                  {o.receiptNo && (
                    <span className="faint">
                      {' '}
                      · {t('orders.receipt')} {o.receiptNo}
                    </span>
                  )}
                </div>
                <div className="orders-row__actions">
                  {o.status === 'pending' && canControl && (
                    <>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setAction({ order: o, kind: 'accept' })}
                        data-testid="orders-accept"
                      >
                        <Check size={14} /> {t('orders.accept')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setAction({ order: o, kind: 'reject' })}
                        data-testid="orders-reject"
                      >
                        <X size={14} /> {t('orders.reject')}
                      </Button>
                    </>
                  )}
                  {(o.status === 'accepted' || o.status === 'paid') &&
                    !o.preparedAt &&
                    canControl && (
                      <Button
                        size="sm"
                        variant={o.status === 'paid' ? 'primary' : 'default'}
                        onClick={() => setAction({ order: o, kind: 'prepare' })}
                        data-testid="orders-prepare"
                      >
                        <ScanLine size={14} /> {t('orders.prepare.button')}
                      </Button>
                    )}
                  {o.status === 'accepted' && (
                    <>
                      {canSell && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => setAction({ order: o, kind: 'pay' })}
                          data-testid="orders-pay"
                        >
                          <Banknote size={14} /> {t('orders.pay')}
                        </Button>
                      )}
                      {canControl && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAction({ order: o, kind: 'void' })}
                          data-testid="orders-void"
                        >
                          <X size={14} /> {t('orders.void')}
                        </Button>
                      )}
                    </>
                  )}
                  {o.saleId && canControl && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setAction({ order: o, kind: 'receipt' })}
                      data-testid="orders-receipt"
                    >
                      <ReceiptText size={14} /> {t('orders.receipt')}
                    </Button>
                  )}
                  <Link
                    to={`/stations?focus=${o.stationId}`}
                    className="btn btn--ghost btn--sm"
                    data-testid="orders-open-station"
                  >
                    <Monitor size={14} /> {t('orders.openStation')}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {action?.kind === 'accept' && (
        <AcceptOrderDialog
          order={action.order}
          defaultSettlement={defaultSettlement}
          scanCheck={scanCheck}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'prepare' && (
        <PrepareOrderDialog order={action.order} onClose={() => setAction(null)} />
      )}
      {action?.kind === 'pay' && (
        <AcceptOrderDialog order={action.order} mode="pay" onClose={() => setAction(null)} />
      )}
      {action?.kind === 'reject' && (
        <RejectOrderDialog order={action.order} onClose={() => setAction(null)} />
      )}
      {action?.kind === 'void' && (
        <RejectOrderDialog order={action.order} mode="void" onClose={() => setAction(null)} />
      )}
      {action?.kind === 'receipt' && (
        <OrderReceiptDialog order={action.order} onFinish={() => setAction(null)} />
      )}
    </>
  );
}

// ─── Menu editor ───────────────────────────────────────────────────────────────
/**
 * Left: every active product (search + category filter) with a tick box. Right: the menu in the
 * order the PCs show it (move up / down, remove). Save = `PUT /catalog/menu`, one round trip.
 */
function MenuEditor() {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.PRODUCTS_MANAGE);
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [picked, setPicked] = useState<string[] | null>(null);

  const products = useQuery({
    queryKey: ['products', 'menu-editor'],
    queryFn: () =>
      api<{ items: ProductSummary[] }>('/products', { query: { active: 'active', pageSize: 500 } }),
  });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<CategorySummary[]>('/catalog/categories'),
  });
  const menu = useQuery({
    queryKey: ['products', 'menu'],
    queryFn: () => api<{ items: ProductSummary[] }>('/catalog/menu'),
  });
  // The working list starts from the saved menu (once loaded) and is edited locally until Save.
  useEffect(() => {
    if (menu.data && picked === null) setPicked(menu.data.items.map((p) => p.id));
  }, [menu.data, picked]);

  const byId = useMemo(
    () => new Map((products.data?.items ?? []).map((p) => [p.id, p])),
    [products.data],
  );
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (products.data?.items ?? []).filter(
      (p) =>
        (!categoryId || p.categoryId === categoryId) &&
        (!needle ||
          p.name.toLowerCase().includes(needle) ||
          (p.sku ?? '').toLowerCase().includes(needle)),
    );
  }, [products.data, q, categoryId]);
  const current = picked ?? [];
  const saved = menu.data?.items.map((p) => p.id) ?? [];
  const dirty = current.join('|') !== saved.join('|');

  const save = useMutation({
    mutationFn: () =>
      api<{ items: ProductSummary[] }>('/catalog/menu', {
        method: 'PUT',
        body: { productIds: current },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['products', 'menu'], data);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      setPicked(data.items.map((p) => p.id));
      toast.success(t('orders.menuSaved'));
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const toggle = (id: string) =>
    setPicked((p) => {
      const list = p ?? [];
      return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    });
  const move = (id: string, delta: number) =>
    setPicked((p) => {
      const list = [...(p ?? [])];
      const from = list.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= list.length) return list;
      list.splice(to, 0, list.splice(from, 1)[0]!);
      return list;
    });

  if (products.isLoading || menu.isLoading || picked === null) return <Loading />;
  if (products.isError || menu.isError)
    return <Alert tone="danger">{t('common.errorGeneric')}</Alert>;
  if ((products.data?.items.length ?? 0) === 0)
    return (
      <Card>
        <EmptyState
          icon={<UtensilsCrossed size={28} />}
          title={t('orders.menuNoProducts')}
          action={
            <Link to="/products" className="btn btn--primary">
              {t('nav.products')}
            </Link>
          }
        />
      </Card>
    );

  return (
    <div className="menu-editor" data-testid="menu-editor">
      <Card
        title={t('orders.menuTitle')}
        subtitle={t('orders.menuSubtitle')}
        actions={
          canManage ? (
            <div className="row" style={{ gap: 8 }}>
              {dirty && <span className="muted">{t('orders.menuDirty')}</span>}
              <Button
                variant="primary"
                disabled={!dirty}
                loading={save.isPending}
                onClick={() => save.mutate()}
                data-testid="menu-save"
              >
                <Check size={15} /> {t('common.save')}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="menu-editor__grid">
          <div className="menu-editor__all">
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <div className="input-icon" style={{ flex: 1 }}>
                <Search size={14} />
                <Input
                  value={q}
                  placeholder={t('orders.menuSearch')}
                  onChange={(e) => setQ(e.target.value)}
                  data-testid="menu-search"
                />
              </div>
              <Select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                style={{ maxWidth: 200 }}
              >
                <option value="">{t('orders.menuAllCategories')}</option>
                {(categories.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <ul className="menu-editor__list" data-testid="menu-products">
              {list.map((p) => {
                const on = current.includes(p.id);
                const out = p.trackStock && p.stockMilli <= 0;
                return (
                  <li
                    key={p.id}
                    className="menu-editor__item"
                    data-on={on}
                    data-testid="menu-product"
                  >
                    <Checkbox
                      checked={on}
                      disabled={!canManage}
                      onChange={() => toggle(p.id)}
                      label={
                        <span className="row" style={{ gap: 8 }}>
                          {p.imageUrl ? (
                            <img
                              className="menu-editor__thumb"
                              src={fileUrl(p.imageUrl) ?? ''}
                              alt=""
                            />
                          ) : (
                            <span className="menu-editor__thumb menu-editor__thumb--blank" />
                          )}
                          <span>{p.name}</span>
                          <span className="num muted">{fmt.money(p.sellingPriceCents)}</span>
                          {out && <Badge tone="warning">{t('orders.menuOutOfStock')}</Badge>}
                        </span>
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="menu-editor__picked">
            <h4 style={{ margin: '0 0 8px' }}>{t('orders.menuPicked', { n: current.length })}</h4>
            {current.length === 0 ? (
              <p className="muted">{t('orders.menuEmpty')}</p>
            ) : (
              <ol className="menu-editor__order" data-testid="menu-picked">
                {current.map((id, index) => {
                  const p = byId.get(id);
                  if (!p) return null;
                  return (
                    <li key={id} className="menu-editor__picked-row" data-testid="menu-picked-row">
                      <span className="num faint">{index + 1}.</span>
                      <span style={{ flex: 1 }}>{p.name}</span>
                      {canManage && (
                        <>
                          <Button
                            icon
                            size="sm"
                            variant="ghost"
                            disabled={index === 0}
                            onClick={() => move(id, -1)}
                            aria-label={t('ads.moveUp')}
                          >
                            <ArrowUp size={14} />
                          </Button>
                          <Button
                            icon
                            size="sm"
                            variant="ghost"
                            disabled={index === current.length - 1}
                            onClick={() => move(id, 1)}
                            aria-label={t('ads.moveDown')}
                          >
                            <ArrowDown size={14} />
                          </Button>
                          <Button
                            icon
                            size="sm"
                            variant="ghost"
                            onClick={() => toggle(id)}
                            aria-label={t('common.delete')}
                          >
                            <X size={14} />
                          </Button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
