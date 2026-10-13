/**
 * Countdown widget (0.13.0: thirteen designs).
 *
 * In the desktop app this is the whole always-on-top window — its footprint follows the owner's
 * design + size choice (`widget-designs.ts` in `@likapcs/shared`), its corner the position setting.
 * The surface is draggable (`data-tauri-drag-region`). Everything displayed is derived from server
 * time and server-provided billing facts (see Clock / sessionView) — the PC never computes billing.
 *
 * The action buttons ("+ time", pause, order) live in one tray for every design. The tray is hidden
 * until the mouse enters the widget, slides in staggered, and slides out 1.5 s after the mouse left.
 * An open order / pending request leaves a tiny count badge so the customer is never left guessing.
 *
 * Designs that cannot carry words (`text: 'none'`) are swapped for the classic card by `App` while a
 * staff notice, maintenance or an order flash is on — see `effectiveWidgetStyle`.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  formatMoney,
  widgetDesign,
  type ClientDisplayConfig,
  type WidgetDesignSpec,
} from '@likapcs/shared';
import { agent, type AgentSnapshot } from './lib/agent';
import { formatHMS, sessionView, type OrderView, type SessionView } from './lib/protocol';
import { t as translate, type Key, type Language } from './lib/i18n';
import { TRAY_LINGER_MS, bigNumber, compactDuration, effectiveWidgetStyle } from './lib/widget';

type T = (k: Key, vars?: Record<string, string | number>) => string;

export { effectiveWidgetStyle, TRAY_LINGER_MS } from './lib/widget';

/** Paid (prepaid) or running amount owed (postpaid) — null when the server gave no figure. */
export function moneyLine(
  view: SessionView | null,
  display: ClientDisplayConfig | null,
  language: Language,
  t: T,
): { label: string; amount: string; kind: 'paid' | 'owed' } | null {
  if (!view || !display?.widgetShowPayment) return null;
  const options = { currency: display.currency, locale: language };
  if (view.paidCents !== null)
    return { label: t('paid'), amount: formatMoney(view.paidCents, options), kind: 'paid' };
  if (view.owedCents !== null)
    return { label: t('owed'), amount: formatMoney(view.owedCents, options), kind: 'owed' };
  return null;
}

/** "Order #3 · accepted" for the widget (eight seconds after a decision / the preparation). */
export function orderFlashText(order: OrderView, t: T): string {
  if (order.preparedAt && (order.status === 'accepted' || order.status === 'paid'))
    return `${t('orderNumber', { n: order.number })} · ${t('orderStatusPrepared')}`;
  const status: Record<OrderView['status'], Key> = {
    pending: 'orderStatusPending',
    accepted: 'orderStatusAccepted',
    paid: 'orderStatusPaid',
    billed: 'orderStatusBilled',
    rejected: 'orderStatusRejected',
    cancelled: 'orderStatusCancelled',
    void: 'orderStatusVoid',
  };
  return `${t('orderNumber', { n: order.number })} · ${t(status[order.status])}`;
}

// ─── Icons ──────────────────────────────────────────────────────────────────────

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden focusable="false">
      <rect x="3" y="2.5" width="3.6" height="11" rx="1" fill="currentColor" />
      <rect x="9.4" y="2.5" width="3.6" height="11" rx="1" fill="currentColor" />
    </svg>
  );
}

function OrderIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5.5 4.5h7.2l-1 5.2H6.3z" />
      <path d="M2.2 2.2h1.6l1.1 2.3" />
      <path d="M6.6 9.7 5.9 11.6h7" />
      <circle cx="7" cy="13.3" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="11.6" cy="13.3" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="4" width="12" height="9" rx="2" />
      <path d="M2 7h12" />
      <circle cx="11" cy="10" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

// ─── Hover reveal ───────────────────────────────────────────────────────────────

function useHoverReveal(): { revealed: boolean; enter: () => void; leave: () => void } {
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);
  return {
    revealed,
    enter: () => {
      clear();
      setRevealed(true);
    },
    leave: () => {
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setRevealed(false);
      }, TRAY_LINGER_MS);
    },
  };
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function Overlay({
  snap,
  notice,
  onRequestTime = null,
  onPause = null,
  onOrder = null,
}: {
  snap: AgentSnapshot;
  notice: string | null;
  /** Prepaid session with customer login on: the "+ time" button asks the staff for more. */
  onRequestTime?: (() => void) | null;
  /** Customer pause allowed by the owner (0.10.0): the screen is covered until resumed. */
  onPause?: (() => void) | null;
  /** Orders from the seat switched on (0.10.0): opens the menu panel. */
  onOrder?: (() => void) | null;
}) {
  const t: T = (key, vars) => translate(snap.state.language, key, vars);
  const session = snap.state.session;
  const display = snap.state.display;
  const view = session ? sessionView(session, snap.serverNowMs) : null;
  const offline = snap.phase.phase === 'offline';
  const openOrders = snap.orders.filter((o) => o.status === 'pending' || o.status === 'accepted');
  const flash = snap.orderFlash;
  const flashText = flash ? orderFlashText(flash.order, t) : null;
  const flashTone: 'good' | 'bad' | null = flash
    ? flash.order.status === 'rejected' || flash.order.status === 'void'
      ? 'bad'
      : 'good'
    : null;
  const low = view?.kind === 'countdown' && !view.paused && view.seconds <= 300;
  const critical = view?.kind === 'countdown' && !view.paused && view.seconds <= 60;
  const maintenance = snap.state.mode === 'free' ? snap.state.maintenance : null;
  const maintenanceLeft =
    maintenance && Number.isFinite(maintenance.untilServerMs)
      ? Math.max(0, Math.round((maintenance.untilServerMs - snap.serverNowMs) / 1000))
      : null;
  const spec = widgetDesign(
    effectiveWidgetStyle(display?.widgetStyle, {
      notice: Boolean(notice),
      maintenance: Boolean(maintenance),
      flash: Boolean(flash),
    }),
  );
  const money = spec.money === 'none' ? null : moneyLine(view, display, snap.state.language, t);
  // Progress of a prepaid session (fraction of planned time still left).
  let fraction: number | null = null;
  if (session?.endsAt && view?.kind === 'countdown') {
    const total = (Date.parse(session.endsAt) - Date.parse(session.startedAt)) / 1000;
    if (total > 0) fraction = Math.min(1, Math.max(0, view.seconds / total));
  }
  const code = snap.state.station?.code ?? 'LIKApcs';
  // 0.11.0: the prepaid balance of the customer this PC plays on (only while there is one).
  const balance =
    snap.account && snap.account.walletBalanceCents > 0 ? snap.account.walletBalanceCents : null;
  const pendingRequest = snap.request?.status === 'pending';
  const pinned = openOrders.length + (pendingRequest ? 1 : 0);
  const hover = useHoverReveal();
  const hasActions = !notice && !maintenance && Boolean(onRequestTime || onPause || onOrder);
  const revealed = hasActions && hover.revealed;

  const cls = [
    'overlay',
    `overlay--${spec.id}`,
    `overlay--${display?.widgetSize ?? 'normal'}`,
    spec.text === 'card' ? 'overlay--card' : '',
    spec.transparent ? 'overlay--clear' : '',
    low ? 'overlay--low' : '',
    critical ? 'overlay--critical' : '',
    offline ? 'overlay--offline' : '',
    notice ? 'overlay--notice' : '',
    maintenance ? 'overlay--maintenance' : '',
    view?.paused ? 'overlay--paused' : '',
    revealed ? 'is-revealed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const tray = hasActions ? (
    <div className="overlay__anchor">
      {!revealed && pinned > 0 && (
        <i className="overlay__pin" aria-hidden>
          {pinned}
        </i>
      )}
      <div
        className="overlay__tray"
        data-testid="overlay-tray"
        data-revealed={revealed || undefined}
      >
        {onRequestTime && (
          <button
            type="button"
            className={`overlay__act ${pendingRequest ? 'overlay__act--pending' : ''}`}
            style={{ '--i': 0 } as CSSProperties}
            onClick={onRequestTime}
            title={pendingRequest ? t('requestPendingShort') : t('requestExtendTitle')}
            aria-label={t('requestMoreTime')}
            data-testid="overlay-more"
            tabIndex={revealed ? 0 : -1}
          >
            {pendingRequest ? '…' : <PlusIcon />}
          </button>
        )}
        {onPause && view && !view.paused && (
          <button
            type="button"
            className="overlay__act"
            style={{ '--i': 1 } as CSSProperties}
            onClick={onPause}
            title={t('pauseTitle')}
            aria-label={t('pauseAction')}
            data-testid="overlay-pause"
            tabIndex={revealed ? 0 : -1}
          >
            <PauseIcon />
          </button>
        )}
        {onOrder && (
          <button
            type="button"
            className={`overlay__act ${openOrders.length > 0 ? 'overlay__act--busy' : ''}`}
            style={{ '--i': 2 } as CSSProperties}
            onClick={onOrder}
            title={t('orderTitle')}
            aria-label={t('orderButton')}
            data-testid="overlay-order"
            data-count={openOrders.length || undefined}
            tabIndex={revealed ? 0 : -1}
          >
            <OrderIcon />
            {openOrders.length > 0 && <i className="overlay__count">{openOrders.length}</i>}
          </button>
        )}
      </div>
    </div>
  ) : null;

  const ctx: Ctx = {
    t,
    spec,
    view,
    money,
    code,
    fraction,
    flashText,
    flashTone,
    offline,
    language: snap.state.language,
    currency: display?.currency ?? 'EUR',
    balance,
    notice,
    maintenance,
    maintenanceLeft,
  };

  let body: ReactNode;
  switch (spec.id) {
    case 'minimal':
      body = <MinimalLine ctx={ctx} />;
      break;
    case 'minutes':
    case 'minutes-money':
      body = <MinutesLine ctx={ctx} withMoney={spec.id === 'minutes-money'} />;
      break;
    case 'compact':
      body = <CompactCard ctx={ctx} />;
      break;
    case 'pill':
      body = <Pill ctx={ctx} />;
      break;
    case 'ring':
      body = <Ring ctx={ctx} />;
      break;
    case 'dot':
      body = <Dot ctx={ctx} />;
      break;
    case 'strip':
      body = <Strip ctx={ctx} />;
      break;
    case 'digital':
      body = <Digital ctx={ctx} />;
      break;
    case 'ticket':
      body = <Ticket ctx={ctx} />;
      break;
    case 'detailed':
    case 'glass':
    case 'neon':
    default:
      body = <ClassicCard ctx={ctx} />;
      break;
  }

  return (
    <div
      className={cls}
      data-tauri-drag-region
      data-testid="overlay"
      data-design={spec.id}
      onMouseEnter={hover.enter}
      onMouseLeave={hover.leave}
    >
      {body}
      {tray}
    </div>
  );
}

// ─── Shared context for the design renderers ───────────────────────────────────

interface Ctx {
  t: T;
  spec: WidgetDesignSpec;
  view: SessionView | null;
  money: { label: string; amount: string; kind: 'paid' | 'owed' } | null;
  code: string;
  fraction: number | null;
  flashText: string | null;
  flashTone: 'good' | 'bad' | null;
  offline: boolean;
  language: Language;
  currency: string;
  balance: number | null;
  notice: string | null;
  maintenance: { byName: string | null; untilServerMs: number } | null;
  maintenanceLeft: number | null;
}

/** Time text of the one-line designs: the order flash takes the slot for a few seconds. */
function lineText(ctx: Ctx): string {
  const { t, view, flashText } = ctx;
  if (flashText) return flashText;
  if (!view) return t('free');
  return view.paused ? t('paused') : compactDuration(view.seconds, t);
}

function ProgressBar({ fraction }: { fraction: number | null }) {
  if (fraction === null) return null;
  return (
    <div className="overlay__bar" aria-hidden>
      <span style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}

function OfflineDot({ ctx }: { ctx: Ctx }) {
  return ctx.offline ? <span className="overlay__offline" title={ctx.t('offlineSession')} /> : null;
}

// ─── 1 · classic card (also glass / neon) ──────────────────────────────────────

function ClassicCard({ ctx }: { ctx: Ctx }) {
  const { t, view, money, code, fraction, flashText, flashTone, balance, notice, maintenance } =
    ctx;
  const showBalance = balance !== null && !flashText && !notice && !maintenance;
  return (
    <>
      <div className="overlay__top" data-tauri-drag-region>
        <span className="overlay__brand" data-tauri-drag-region>
          <span className="overlay__mark">L</span>
          <span className="overlay__code">{code}</span>
        </span>
        {showBalance && (
          <span
            className="overlay__balance"
            title={t('balanceTitle')}
            data-testid="overlay-balance"
            data-tauri-drag-region
          >
            <WalletIcon />
            {formatMoney(balance ?? 0, { currency: ctx.currency, locale: ctx.language })}
          </span>
        )}
        {!showBalance && (
          <span
            className={`overlay__label ${flashTone ? `overlay__flash overlay__flash--${flashTone}` : ''}`}
            data-tauri-drag-region
            data-testid={flashTone ? 'overlay-order-flash' : undefined}
            title={flashText ?? undefined}
          >
            {flashText
              ? flashText
              : notice
                ? ''
                : maintenance
                  ? t('maintenance')
                  : view
                    ? view.paused
                      ? t('paused')
                      : view.kind === 'countdown'
                        ? t('remaining')
                        : t('elapsed')
                    : t('free')}
          </span>
        )}
        <OfflineDot ctx={ctx} />
      </div>
      {notice ? (
        <div className="overlay__notice" title={notice}>
          {notice}
        </div>
      ) : maintenance ? (
        <div className="overlay__main">
          <div className="overlay__maint" data-tauri-drag-region>
            {maintenance.byName && (
              <span className="overlay__by">
                {t('maintenanceBy')} {maintenance.byName}
              </span>
            )}
            {ctx.maintenanceLeft !== null && (
              <span className="overlay__time overlay__time--sm">
                {t('locksIn')} {formatHMS(ctx.maintenanceLeft)}
              </span>
            )}
          </div>
          <button
            type="button"
            className="overlay__lock"
            onClick={() => void agent.staffLock()}
            data-testid="overlay-lock"
          >
            {t('lockNow')}
          </button>
        </div>
      ) : view ? (
        <div className="overlay__main" data-tauri-drag-region>
          <span className="overlay__time" data-tauri-drag-region data-testid="overlay-time">
            {formatHMS(view.seconds)}
          </span>
          {money && (
            <span
              className={`overlay__money overlay__money--${money.kind}`}
              data-tauri-drag-region
              data-testid="overlay-money"
            >
              <small>{money.label}</small>
              <strong>{money.amount}</strong>
            </span>
          )}
        </div>
      ) : (
        <div className="overlay__main" data-tauri-drag-region>
          <span className="overlay__time overlay__time--sm">{t('free')}</span>
        </div>
      )}
      {!notice && <ProgressBar fraction={fraction} />}
    </>
  );
}

// ─── 2 · one line ───────────────────────────────────────────────────────────────

function MinimalLine({ ctx }: { ctx: Ctx }) {
  const { money, code, fraction, flashTone } = ctx;
  return (
    <>
      <div className="overlay__line" data-tauri-drag-region>
        <span className="overlay__mark" data-tauri-drag-region>
          L
        </span>
        <span className="overlay__code" data-tauri-drag-region>
          {code}
        </span>
        <span className="overlay__dot" aria-hidden />
        <span
          className={`overlay__mini-time ${flashTone ? `overlay__flash--${flashTone}` : ''}`}
          data-tauri-drag-region
          data-testid="overlay-time"
        >
          {lineText(ctx)}
        </span>
        {money && !ctx.flashText && (
          <>
            <span className="overlay__dot" aria-hidden />
            <span
              className={`overlay__mini-money overlay__mini-money--${money.kind}`}
              data-tauri-drag-region
              data-testid="overlay-money"
              title={money.label}
            >
              {money.amount}
            </span>
          </>
        )}
        <OfflineDot ctx={ctx} />
      </div>
      <ProgressBar fraction={fraction} />
    </>
  );
}

// ─── 3/4 · minutes only · minutes + € ───────────────────────────────────────────

function MinutesLine({ ctx, withMoney }: { ctx: Ctx; withMoney: boolean }) {
  const { money, fraction, flashTone } = ctx;
  return (
    <>
      <div className="overlay__line overlay__line--center" data-tauri-drag-region>
        <span
          className={`overlay__mini-time ${flashTone ? `overlay__flash--${flashTone}` : ''}`}
          data-tauri-drag-region
          data-testid="overlay-time"
        >
          {lineText(ctx)}
        </span>
        {withMoney && money && !ctx.flashText && (
          <span
            className={`overlay__mini-money overlay__mini-money--${money.kind}`}
            data-tauri-drag-region
            data-testid="overlay-money"
            title={money.label}
          >
            {money.amount}
          </span>
        )}
        <OfflineDot ctx={ctx} />
      </div>
      <ProgressBar fraction={fraction} />
    </>
  );
}

// ─── 5 · compact card ───────────────────────────────────────────────────────────

function CompactCard({ ctx }: { ctx: Ctx }) {
  const { t, view, money, code, fraction, flashText, flashTone } = ctx;
  return (
    <>
      <div className="overlay__top" data-tauri-drag-region>
        <span className="overlay__brand" data-tauri-drag-region>
          <span className="overlay__mark">L</span>
          <span className="overlay__code">{code}</span>
        </span>
        <span
          className={`overlay__label ${flashTone ? `overlay__flash overlay__flash--${flashTone}` : ''}`}
          data-tauri-drag-region
          title={flashText ?? undefined}
        >
          {flashText
            ? flashText
            : view
              ? view.paused
                ? t('paused')
                : view.kind === 'countdown'
                  ? t('remaining')
                  : t('elapsed')
              : t('free')}
        </span>
        <OfflineDot ctx={ctx} />
      </div>
      <div className="overlay__main" data-tauri-drag-region>
        <span className="overlay__time" data-tauri-drag-region data-testid="overlay-time">
          {view ? formatHMS(view.seconds) : t('free')}
        </span>
        {money && (
          <span
            className={`overlay__mini-money overlay__mini-money--${money.kind}`}
            data-tauri-drag-region
            data-testid="overlay-money"
            title={money.label}
          >
            {money.amount}
          </span>
        )}
      </div>
      <ProgressBar fraction={fraction} />
    </>
  );
}

// ─── 6 · pill ───────────────────────────────────────────────────────────────────

function Pill({ ctx }: { ctx: Ctx }) {
  const { money, flashTone } = ctx;
  return (
    <div className="overlay__pill" data-tauri-drag-region>
      <span className="overlay__state" aria-hidden />
      <span
        className={`overlay__mini-time ${flashTone ? `overlay__flash--${flashTone}` : ''}`}
        data-tauri-drag-region
        data-testid="overlay-time"
      >
        {lineText(ctx)}
      </span>
      {money && !ctx.flashText && (
        <span
          className={`overlay__mini-money overlay__mini-money--${money.kind}`}
          data-tauri-drag-region
          data-testid="overlay-money"
          title={money.label}
        >
          {money.amount}
        </span>
      )}
      <OfflineDot ctx={ctx} />
    </div>
  );
}

// ─── 7 · ring ───────────────────────────────────────────────────────────────────

function Ring({ ctx }: { ctx: Ctx }) {
  const { t, view, money, fraction } = ctx;
  // A postpaid (elapsed) session has no end: the ring is full and the number counts up.
  const left = fraction ?? 1;
  const r = 44;
  const c = 2 * Math.PI * r;
  const big = view ? bigNumber(view.seconds) : null;
  return (
    <div className="overlay__ring" data-tauri-drag-region>
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle className="overlay__ring-track" cx="50" cy="50" r={r} />
        <circle
          className="overlay__ring-fill"
          cx="50"
          cy="50"
          r={r}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - left)}
        />
      </svg>
      <div className="overlay__ring-text" data-tauri-drag-region>
        {view && !view.paused && big ? (
          <>
            <b data-testid="overlay-time" title={formatHMS(view.seconds)}>
              {big.value}
            </b>
            <small>{t(big.unit)}</small>
          </>
        ) : (
          <small data-testid="overlay-time">{view ? t('paused') : t('free')}</small>
        )}
        {money && view && !view.paused && (
          <em
            className={`overlay__mini-money overlay__mini-money--${money.kind}`}
            data-testid="overlay-money"
            title={money.label}
          >
            {money.amount}
          </em>
        )}
      </div>
      <OfflineDot ctx={ctx} />
    </div>
  );
}

// ─── 8 · dot ────────────────────────────────────────────────────────────────────

function Dot({ ctx }: { ctx: Ctx }) {
  const { t, view } = ctx;
  const title = view
    ? view.paused
      ? t('paused')
      : `${formatHMS(view.seconds)}${ctx.money ? ` · ${ctx.money.amount}` : ''}`
    : t('free');
  return (
    <div className="overlay__dotwrap" data-tauri-drag-region>
      <span
        className="overlay__bigdot"
        data-tauri-drag-region
        data-testid="overlay-time"
        title={title}
      >
        {view && !view.paused ? bigNumber(view.seconds).value : view ? '❚❚' : '·'}
      </span>
      <OfflineDot ctx={ctx} />
    </div>
  );
}

// ─── 9 · strip ──────────────────────────────────────────────────────────────────

function Strip({ ctx }: { ctx: Ctx }) {
  const { view, money, fraction, flashTone } = ctx;
  return (
    <div className="overlay__strip" data-tauri-drag-region>
      <span
        className={`overlay__strip-fill ${fraction === null && view && !view.paused ? 'is-running' : ''}`}
        style={{ width: `${(fraction ?? 1) * 100}%` }}
        aria-hidden
      />
      <span className="overlay__strip-text" data-tauri-drag-region>
        <span
          className={`overlay__mini-time ${flashTone ? `overlay__flash--${flashTone}` : ''}`}
          data-testid="overlay-time"
        >
          {lineText(ctx)}
        </span>
        {money && !ctx.flashText && (
          <span
            className={`overlay__mini-money overlay__mini-money--${money.kind}`}
            data-testid="overlay-money"
            title={money.label}
          >
            {money.amount}
          </span>
        )}
        <OfflineDot ctx={ctx} />
      </span>
    </div>
  );
}

// ─── 10 · digital ───────────────────────────────────────────────────────────────

function Digital({ ctx }: { ctx: Ctx }) {
  const { t, view, money, code, flashText, flashTone } = ctx;
  return (
    <>
      <div className="overlay__top" data-tauri-drag-region>
        <span className="overlay__code" data-tauri-drag-region>
          {code}
        </span>
        <span
          className={`overlay__label ${flashTone ? `overlay__flash overlay__flash--${flashTone}` : ''}`}
          data-tauri-drag-region
          title={flashText ?? undefined}
        >
          {flashText
            ? flashText
            : money
              ? money.amount
              : view
                ? view.paused
                  ? t('paused')
                  : view.kind === 'countdown'
                    ? t('remaining')
                    : t('elapsed')
                : t('free')}
        </span>
        <OfflineDot ctx={ctx} />
      </div>
      <div className="overlay__main overlay__main--center" data-tauri-drag-region>
        <span className="overlay__led" data-tauri-drag-region data-testid="overlay-time">
          {view ? formatHMS(view.seconds) : '--:--:--'}
        </span>
        {money && (
          <span className="overlay__led-money" data-testid="overlay-money" title={money.label}>
            {money.amount}
          </span>
        )}
      </div>
    </>
  );
}

// ─── 13 · ticket ────────────────────────────────────────────────────────────────

function Ticket({ ctx }: { ctx: Ctx }) {
  const { t, view, money, code, flashText, flashTone } = ctx;
  return (
    <div className="overlay__ticket" data-tauri-drag-region>
      <div className="overlay__ticket-head" data-tauri-drag-region>
        <b>{code}</b>
        <span
          className={flashTone ? `overlay__flash overlay__flash--${flashTone}` : ''}
          title={flashText ?? undefined}
        >
          {flashText
            ? flashText
            : view
              ? view.paused
                ? t('paused')
                : view.kind === 'countdown'
                  ? t('remaining')
                  : t('elapsed')
              : t('free')}
        </span>
        <OfflineDot ctx={ctx} />
      </div>
      <div className="overlay__ticket-time" data-tauri-drag-region data-testid="overlay-time">
        {view ? formatHMS(view.seconds) : t('free')}
      </div>
      <div className="overlay__ticket-cut" aria-hidden />
      <div className="overlay__ticket-foot" data-tauri-drag-region>
        {money ? (
          <>
            <span>{money.label}</span>
            <b data-testid="overlay-money">{money.amount}</b>
          </>
        ) : (
          <span>LIKApcs</span>
        )}
      </div>
    </div>
  );
}
