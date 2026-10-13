/**
 * "Order" panel (0.10.0): drinks / snacks ordered from the seat. The customer picks from the menu
 * the owner curated in LIKApcs (Products › "On the PC menu"), adds a note when allowed and sends.
 * The staff accept ("pay now" / "on the bill") or reject in LIKApcs; every answer arrives as a
 * `server.order` push and shows up here and, briefly, in the countdown widget.
 *
 * Nothing here decides money: prices come from the server and are frozen on the order there.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatMoney, type ClientMenu, type ClientMenuItem } from '@likapcs/shared';
import { agent, type AgentSnapshot, type CustomerActionError } from './lib/agent';
import { sessionView, type OrderView } from './lib/protocol';
import { t as translate, type Key } from './lib/i18n';
import { billTotalCents, ordersOnBillCents } from './lib/widget';

const ORDER_ERRORS: Partial<Record<CustomerActionError, Key>> = {
  orders_disabled: 'errOrdersDisabled',
  out_of_stock: 'errOutOfStock',
  no_session: 'orderNoSession',
  rate_limited: 'errRateLimited',
  network: 'errNetwork',
  not_paired: 'errNetwork',
  validation_error: 'errGeneric',
};

export const ORDER_STATUS_KEY: Record<OrderView['status'], Key> = {
  pending: 'orderStatusPending',
  accepted: 'orderStatusAccepted',
  paid: 'orderStatusPaid',
  billed: 'orderStatusBilled',
  rejected: 'orderStatusRejected',
  cancelled: 'orderStatusCancelled',
  void: 'orderStatusVoid',
};

const MENU_REFRESH_MS = 45_000;
const MAX_PER_LINE = 20;

export function OrderPanel({ snap, onClose }: { snap: AgentSnapshot; onClose: () => void }) {
  const language = snap.state.language;
  const t = (key: Key, vars?: Record<string, string | number>) => translate(language, key, vars);
  const [menu, setMenu] = useState<ClientMenu | null>(null);
  const [menuError, setMenuError] = useState<Key | null>(null);
  const [category, setCategory] = useState<string | null | 'all'>('all');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const [sentNumber, setSentNumber] = useState<number | null>(null);

  // The menu is re-read while the panel is open (prices, stock and the owner's picks change) and
  // the session's orders once on open (a missed push never hides an answer).
  const load = useCallback(async () => {
    const res = await agent.loadMenu();
    if (res.ok) {
      setMenu(res.menu);
      setMenuError(null);
    } else setMenuError(ORDER_ERRORS[res.error] ?? 'errGeneric');
  }, []);
  useEffect(() => {
    void load();
    void agent.refreshOrders();
    const timer = window.setInterval(() => void load(), MENU_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load, snap.state.session?.id]);

  // Items that vanished from the menu (or ran out) leave the cart by themselves.
  useEffect(() => {
    if (!menu) return;
    setCart((current) => {
      const next: Record<string, number> = {};
      for (const [id, qty] of Object.entries(current)) {
        const item = menu.items.find((i) => i.productId === id);
        if (item && item.available) next[id] = qty;
      }
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [menu]);

  const money = (cents: number) =>
    formatMoney(cents, {
      currency: menu?.currency ?? snap.state.display?.currency ?? 'EUR',
      locale: language,
    });
  const items = useMemo(() => {
    if (!menu) return [];
    if (category === 'all') return menu.items;
    return menu.items.filter((i) => i.categoryId === category);
  }, [menu, category]);
  const lines = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, qty]) => ({ item: menu?.items.find((i) => i.productId === id), qty }))
        .filter((l): l is { item: ClientMenuItem; qty: number } => Boolean(l.item) && l.qty > 0),
    [cart, menu],
  );
  const total = lines.reduce((sum, l) => sum + l.item.priceCents * l.qty, 0);
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  const add = (item: ClientMenuItem, delta: number) => {
    if (!item.available) return;
    setSentNumber(null);
    setCart((c) => {
      const qty = Math.max(0, Math.min(MAX_PER_LINE, (c[item.productId] ?? 0) + delta));
      const next = { ...c };
      if (qty === 0) delete next[item.productId];
      else next[item.productId] = qty;
      return next;
    });
  };

  const send = async () => {
    if (busy || lines.length === 0) return;
    setBusy(true);
    setError(null);
    const res = await agent.placeOrder({
      items: lines.map((l) => ({ productId: l.item.productId, quantity: l.qty })),
      ...(menu?.allowNote && note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(ORDER_ERRORS[res.error] ?? 'errGeneric');
      if (res.error === 'out_of_stock') void load();
      return;
    }
    setCart({});
    setNote('');
    setSentNumber(res.order.number);
  };

  const open = snap.orders.filter((o) => o.status === 'pending' || o.status === 'accepted');
  const done = snap.orders.filter((o) => o.status !== 'pending' && o.status !== 'accepted');
  // 0.16.0: what the desk will ask for — PC time (postpaid / end pay) plus orders on the bill.
  const view = snap.state.session ? sessionView(snap.state.session, snap.serverNowMs) : null;
  const onBill = ordersOnBillCents(snap.orders);
  const billTotal = onBill > 0 ? billTotalCents(view, snap.orders) : null;
  // Browse-only (0.14.0): the lock screen shows the menu even when sending must wait for a
  // session — the products are still worth looking at.
  const browseOnly = Boolean(
    menu && !menu.enabled && menu.reason === 'no_session' && menu.items.length,
  );
  const blocked: Key | null =
    menuError ??
    (menu && !menu.enabled && !browseOnly
      ? menu.reason === 'no_session'
        ? 'orderNoSession'
        : menu.reason === 'disabled'
          ? 'orderDisabled'
          : 'orderMenuEmpty'
      : null);
  const lockedContext = menu?.context === 'locked';

  return (
    <div
      className="panel panel--center panel--order"
      role="dialog"
      aria-labelledby="order-title"
      data-testid="order-panel"
      data-state={
        menu
          ? menu.enabled
            ? 'ready'
            : browseOnly
              ? 'browse'
              : menu.reason
          : menuError
            ? 'error'
            : 'loading'
      }
      data-context={menu?.context}
    >
      <div className="panel__head">
        <strong id="order-title">{t('orderTitle')}</strong>
        {snap.account && snap.account.walletBalanceCents > 0 && (
          <span
            className="order__balance"
            title={t('customerBalanceHint')}
            data-testid="order-balance"
          >
            {t('balanceShort')} · {money(snap.account.walletBalanceCents)}
          </span>
        )}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onClose}
          data-testid="order-close"
        >
          {t('close')}
        </button>
      </div>

      {blocked ? (
        <div className="card card--warn" role="status" data-testid="order-blocked">
          <div className="card__text">{t(blocked)}</div>
        </div>
      ) : !menu ? (
        <div className="order__loading">
          <span className="spinner" />
        </div>
      ) : (
        <>
          <p className="muted small order__hint">
            {browseOnly
              ? t('orderNoSession')
              : lockedContext
                ? t('orderHintLocked')
                : t('orderHint')}
          </p>
          {!menu.staffOnline && (
            <p className="order__offline" role="status">
              {t('orderStaffOffline')}
            </p>
          )}
          {menu.categories.length > 1 && (
            <div className="order__cats" role="tablist" data-testid="order-categories">
              <button
                type="button"
                role="tab"
                className={`chip ${category === 'all' ? 'chip--on' : ''}`}
                aria-selected={category === 'all'}
                onClick={() => setCategory('all')}
              >
                {t('orderAll')}
              </button>
              {menu.categories.map((c) => (
                <button
                  key={c.id ?? 'none'}
                  type="button"
                  role="tab"
                  className={`chip ${category === c.id ? 'chip--on' : ''}`}
                  aria-selected={category === c.id}
                  onClick={() => setCategory(c.id)}
                  style={c.color ? ({ '--chip': c.color } as React.CSSProperties) : undefined}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}

          <div className="order__menu" data-testid="order-menu">
            {items.map((item) => {
              const qty = cart[item.productId] ?? 0;
              return (
                <div
                  key={item.productId}
                  className={`order__item ${item.available ? '' : 'order__item--off'} ${qty > 0 ? 'order__item--picked' : ''}`}
                  data-testid="order-item"
                  data-product={item.productId}
                >
                  <button
                    type="button"
                    className="order__pick"
                    onClick={() => add(item, 1)}
                    disabled={!item.available || browseOnly}
                    aria-label={item.name}
                  >
                    {item.imageUrl ? (
                      <img
                        src={item.imageUrl}
                        alt=""
                        draggable={false}
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className="order__thumb" aria-hidden>
                        {item.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="order__name">{item.name}</span>
                    <span className="order__price">
                      {item.oldPriceCents !== null && <s>{money(item.oldPriceCents)}</s>}
                      {money(item.priceCents)}
                    </span>
                    {!item.available && <span className="order__off">{t('orderUnavailable')}</span>}
                  </button>
                  {qty > 0 && (
                    <span className="order__qty" data-testid="order-qty">
                      <button type="button" onClick={() => add(item, -1)} aria-label="−">
                        −
                      </button>
                      <b>{qty}</b>
                      <button type="button" onClick={() => add(item, 1)} aria-label="+">
                        +
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {!browseOnly && (
            <div className="order__cart" data-testid="order-cart" data-count={count}>
              <div className="order__cart-head">
                <strong>{t('orderCart')}</strong>
                {lines.length > 0 && (
                  <button type="button" className="link" onClick={() => setCart({})}>
                    {t('orderClear')}
                  </button>
                )}
              </div>
              {lines.length === 0 ? (
                <p className="muted small">
                  {sentNumber !== null ? t('orderSent') : t('orderCartEmpty')}
                </p>
              ) : (
                <>
                  <ul className="order__lines">
                    {lines.map((l) => (
                      <li key={l.item.productId}>
                        <span>
                          {l.qty} × {l.item.name}
                        </span>
                        <span>{money(l.item.priceCents * l.qty)}</span>
                      </li>
                    ))}
                  </ul>
                  {menu.allowNote && (
                    <label className="field">
                      <span>{t('orderNote')}</span>
                      <input
                        value={note}
                        maxLength={200}
                        placeholder={t('orderNotePlaceholder')}
                        onChange={(e) => setNote(e.target.value)}
                        data-testid="order-note"
                      />
                    </label>
                  )}
                  <div className="order__total">
                    <span>{t('orderTotal')}</span>
                    <strong data-testid="order-total">{money(total)}</strong>
                  </div>
                  <button
                    type="button"
                    className="btn btn--primary order__send"
                    onClick={() => void send()}
                    disabled={busy}
                    data-testid="order-send"
                  >
                    {busy ? t('orderSending') : t('orderSend')}
                  </button>
                  <p className="muted small">
                    {lockedContext ? t('orderPayNoteLocked') : t('orderPayNote')}
                  </p>
                </>
              )}
              {error && (
                <p className="card__error" role="alert">
                  {t(error)}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {billTotal !== null && (
        <div className="order__bill" data-testid="order-bill">
          <span className="order__bill-head">{t('billSoFar')}</span>
          {view && view.owedCents !== null && view.owedCents > 0 && (
            <span className="order__bill-row">
              <span>{t('billTime')}</span>
              <span>{money(view.owedCents)}</span>
            </span>
          )}
          <span className="order__bill-row">
            <span>{t('billOrders')}</span>
            <span>{money(onBill)}</span>
          </span>
          <span className="order__bill-row order__bill-row--total">
            <span>{t('orderTotal')}</span>
            <b data-testid="order-bill-total">{money(billTotal)}</b>
          </span>
        </div>
      )}
      {snap.orders.length > 0 && (
        <div className="order__mine" data-testid="order-mine">
          <strong>{t('orderMine')}</strong>
          <ul>
            {[...open, ...done].slice(0, 8).map((o) => (
              <li key={o.id} data-testid="order-mine-row" data-status={o.status}>
                <span className="order__mine-head">
                  <b>{t('orderNumber', { n: o.number })}</b>
                  <span className={`order__status order__status--${o.status}`}>
                    {o.preparedAt && (o.status === 'accepted' || o.status === 'paid')
                      ? t('orderStatusPrepared')
                      : t(ORDER_STATUS_KEY[o.status])}
                  </span>
                </span>
                <span className="order__mine-body">
                  {o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')} ·{' '}
                  {money(o.totalCents)}
                </span>
                {o.reason && (o.status === 'rejected' || o.status === 'void') && (
                  <span className="order__reason">{t('requestReason', { reason: o.reason })}</span>
                )}
                {o.status === 'pending' && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => void agent.cancelOrder(o.id)}
                    data-testid="order-cancel"
                  >
                    {t('orderCancel')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
