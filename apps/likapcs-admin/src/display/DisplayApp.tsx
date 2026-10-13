/**
 * Customer display (0.16.0) — the screen turned towards the customer at the counter.
 *
 * Four pictures, all driven by the main window (`DisplayState`):
 *  - idle    → the ads program (albums, same as the PCs) or a welcome card when there are none;
 *  - sale    → the open sale line by line (small square photo, name, qty × price, line total),
 *              the running total, the customer's debt / balance when one is attached;
 *  - paying  → the same list, the summary turns into the payment: paid so far, change due or
 *              what goes on the tab / comes from the balance;
 *  - done    → "Thank you" with total, paid and change for 8 s, then back to the ads.
 *
 * Every size is in `vmin` units (see display.css), so the layout reads the same from a 480p
 * stick monitor to a 1080p screen; the orientation (landscape / portrait) is detected live and
 * switches the composition (list beside the summary vs. list above it; grid pages re-flow).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, formatQuantity, type CustomerDisplayFeed } from '@likapcs/shared';
import {
  DISPLAY_THANKS_SECONDS,
  DisplayChannel,
  type DisplayBrand,
  type DisplayDone,
  type DisplaySale,
  type DisplayState,
  type DisplayTender,
} from '../lib/customer-display';
import { DisplayAds } from './DisplayAds';
import { displayText, type DisplayLanguage, type DisplayTextKey } from './i18n';

export type Orientation = 'landscape' | 'portrait';
export interface Viewport {
  width: number;
  height: number;
  orientation: Orientation;
}

/** Live viewport: size + orientation (re-evaluated on every resize / rotation). */
export function useViewport(): Viewport {
  const read = (): Viewport => ({
    width: window.innerWidth,
    height: window.innerHeight,
    orientation: window.innerHeight > window.innerWidth ? 'portrait' : 'landscape',
  });
  const [vp, setVp] = useState<Viewport>(read);
  useEffect(() => {
    const onResize = () => setVp(read());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return vp;
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function DisplayApp() {
  const channel = useMemo(() => new DisplayChannel(), []);
  const [state, setState] = useState<DisplayState>({ kind: 'idle' });
  const [brand, setBrand] = useState<DisplayBrand | null>(null);
  const [feed, setFeed] = useState<CustomerDisplayFeed | null>(null);
  const [linked, setLinked] = useState(false);
  const linkedRef = useRef(false);
  const vp = useViewport();

  useEffect(() => {
    const off = channel.subscribe((message) => {
      if (message.type === 'state') {
        setState(message.state);
        setBrand(message.brand);
        linkedRef.current = true;
        setLinked(true);
      } else if (message.type === 'feed') {
        setFeed(message.feed);
      }
    });
    // Announce until the register answers (also after a reload of this window).
    channel.post({ type: 'hello' });
    const timer = window.setInterval(() => {
      if (!linkedRef.current) channel.post({ type: 'hello' });
    }, 3000);
    return () => {
      off();
      window.clearInterval(timer);
      channel.close();
    };
  }, [channel]);

  // The screen speaks the business language; the cashier's UI language is only a fallback.
  const language: DisplayLanguage = feed?.language ?? brand?.language ?? 'sq';
  const currency = feed?.currency ?? brand?.currency ?? 'EUR';
  const businessName = feed?.businessName ?? brand?.businessName ?? 'LIKApcs';
  const t = (key: DisplayTextKey) => displayText(language, key);
  const money = (cents: number) => formatMoney(cents, { currency, locale: language });
  const clock = useClock();

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const hasAds = (feed?.feed.albums.length ?? 0) > 0 || (feed?.feed.items.length ?? 0) > 0;

  return (
    <div
      className={`cd cd--${vp.orientation} cd--${state.kind}`}
      data-testid="customer-display"
      data-state={state.kind}
      data-orientation={vp.orientation}
    >
      {state.kind === 'idle' &&
        (feed && hasAds ? (
          <DisplayAds
            feed={feed}
            viewport={vp}
            language={language}
            currency={currency}
            businessName={businessName}
            clock={clock}
          />
        ) : (
          <Welcome
            businessName={businessName}
            clock={clock}
            text={t('welcome')}
            linked={linked}
            waiting={t('waiting')}
          />
        ))}
      {(state.kind === 'sale' || state.kind === 'paying') && (
        <SaleScreen
          sale={state.sale}
          tender={state.kind === 'paying' ? state.tender : null}
          businessName={businessName}
          language={language}
          money={money}
          t={t}
        />
      )}
      {state.kind === 'done' && (
        <DoneScreen done={state.done} businessName={businessName} money={money} t={t} />
      )}
    </div>
  );
}

// ─── Idle without ads ───────────────────────────────────────────────────────────
function Welcome({
  businessName,
  clock,
  text,
  linked,
  waiting,
}: {
  businessName: string;
  clock: string;
  text: string;
  linked: boolean;
  waiting: string;
}) {
  return (
    <div className="cd-welcome" data-testid="display-welcome">
      <div className="cd-welcome__glow" aria-hidden />
      <div className="cd-welcome__clock">{clock}</div>
      <h1 className="cd-welcome__brand">{businessName}</h1>
      <p className="cd-welcome__text">{text}</p>
      {!linked && <p className="cd-welcome__waiting">{waiting}</p>}
    </div>
  );
}

// ─── Sale / payment ─────────────────────────────────────────────────────────────
function SaleScreen({
  sale,
  tender,
  businessName,
  language,
  money,
  t,
}: {
  sale: DisplaySale;
  tender: DisplayTender | null;
  businessName: string;
  language: DisplayLanguage;
  money: (cents: number) => string;
  t: (key: DisplayTextKey) => string;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-line-id="${CSS.escape(sale.lastLineId ?? '')}"]`,
    );
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [sale.lastLineId, sale.lines.length]);

  return (
    <div className="cd-sale" data-testid="display-sale">
      <header className="cd-sale__head">
        <span className="cd-sale__brand">{businessName}</span>
        <span className="cd-sale__count">
          {t('items')}: <b>{formatQuantity(Math.round(sale.itemCount * 1000), language)}</b>
        </span>
      </header>
      <ol className="cd-lines" ref={listRef} data-testid="display-lines">
        {sale.lines.map((line, index) => (
          <li
            key={line.id}
            className={`cd-line ${line.id === sale.lastLineId ? 'cd-line--last' : ''}`}
            data-line-id={line.id}
            data-testid="display-line"
          >
            <span className="cd-line__no">{index + 1}</span>
            <span className="cd-line__photo">
              {line.imageUrl ? (
                <img src={line.imageUrl} alt="" draggable={false} />
              ) : (
                <span className="cd-line__initial">{line.name.slice(0, 1).toUpperCase()}</span>
              )}
            </span>
            <span className="cd-line__main">
              <span className="cd-line__name">{line.name}</span>
              <span className="cd-line__meta">
                {formatQuantity(line.quantityMilli, language)} × {money(line.unitPriceCents)}
                {line.regularPriceCents !== null && (
                  <s className="cd-line__regular">{money(line.regularPriceCents)}</s>
                )}
              </span>
            </span>
            <span className="cd-line__total">{money(line.totalCents)}</span>
          </li>
        ))}
      </ol>
      <aside className={`cd-sum ${tender ? 'cd-sum--paying' : ''}`} data-testid="display-summary">
        {sale.customer && (
          <div className="cd-customer" data-testid="display-customer">
            <span className="cd-customer__label">{t('customer')}</span>
            <span className="cd-customer__name">{sale.customer.name}</span>
            {(sale.customer.balanceDueCents !== null ||
              sale.customer.walletBalanceCents !== null) && (
              <span className="cd-customer__facts">
                {sale.customer.balanceDueCents !== null && (
                  <span className="cd-customer__fact cd-customer__fact--debt">
                    {t('debt')} <b>{money(sale.customer.balanceDueCents)}</b>
                  </span>
                )}
                {sale.customer.walletBalanceCents !== null && (
                  <span className="cd-customer__fact">
                    {t('balance')} <b>{money(sale.customer.walletBalanceCents)}</b>
                  </span>
                )}
              </span>
            )}
          </div>
        )}
        {sale.discountCents > 0 && (
          <>
            <div className="cd-sum__row">
              <span>{t('subtotal')}</span>
              <span>{money(sale.subtotalCents)}</span>
            </div>
            <div className="cd-sum__row cd-sum__row--discount">
              <span>{t('discount')}</span>
              <span>−{money(sale.discountCents)}</span>
            </div>
          </>
        )}
        <div className="cd-sum__total">
          <span className="cd-sum__label">{tender ? t('toPay') : t('total')}</span>
          <span className="cd-sum__amount" data-testid="display-total">
            {money(sale.totalCents)}
          </span>
        </div>
        {tender && <TenderBlock tender={tender} money={money} t={t} />}
      </aside>
    </div>
  );
}

function TenderBlock({
  tender,
  money,
  t,
}: {
  tender: DisplayTender;
  money: (cents: number) => string;
  t: (key: DisplayTextKey) => string;
}) {
  const remaining = Math.max(0, tender.changeCents < 0 ? -tender.changeCents : 0);
  return (
    <div className="cd-tender" data-testid="display-tender" data-mode={tender.mode}>
      {tender.cashCents > 0 && (
        <div className="cd-sum__row">
          <span>{t('cash')}</span>
          <span data-testid="display-paid">{money(tender.cashCents)}</span>
        </div>
      )}
      {tender.walletCents > 0 && (
        <div className="cd-sum__row">
          <span>{t('fromBalance')}</span>
          <span>{money(tender.walletCents)}</span>
        </div>
      )}
      {tender.creditCents > 0 && (
        <div className="cd-sum__row cd-sum__row--credit">
          <span>{t('onTab')}</span>
          <span>{money(tender.creditCents)}</span>
        </div>
      )}
      {tender.covered ? (
        <div className="cd-change" data-testid="display-change">
          <span className="cd-sum__label">{t('change')}</span>
          <span className="cd-change__amount">{money(tender.changeCents)}</span>
        </div>
      ) : (
        remaining > 0 && (
          <div className="cd-change cd-change--due">
            <span className="cd-sum__label">{t('remaining')}</span>
            <span className="cd-change__amount">{money(remaining)}</span>
          </div>
        )
      )}
    </div>
  );
}

// ─── Thank you ──────────────────────────────────────────────────────────────────
function DoneScreen({
  done,
  businessName,
  money,
  t,
}: {
  done: DisplayDone;
  businessName: string;
  money: (cents: number) => string;
  t: (key: DisplayTextKey) => string;
}) {
  return (
    <div className="cd-done" data-testid="display-done">
      <div className="cd-done__glow" aria-hidden />
      <div className="cd-done__check" aria-hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h1 className="cd-done__title">{t('thankYou')}</h1>
      <div className="cd-done__facts">
        <div className="cd-done__fact">
          <span>{t('total')}</span>
          <b data-testid="display-done-total">{money(done.totalCents)}</b>
        </div>
        {done.paidCents > 0 && (
          <div className="cd-done__fact">
            <span>{t('paid')}</span>
            <b>{money(done.paidCents)}</b>
          </div>
        )}
        {done.creditCents > 0 && (
          <div className="cd-done__fact cd-done__fact--credit">
            <span>{t('onTab')}</span>
            <b>{money(done.creditCents)}</b>
          </div>
        )}
        {done.changeCents > 0 && (
          <div className="cd-done__fact cd-done__fact--change">
            <span>{t('change')}</span>
            <b data-testid="display-done-change">{money(done.changeCents)}</b>
          </div>
        )}
      </div>
      <p className="cd-done__foot">
        {done.receiptNo && (
          <span>
            {t('receipt')} {done.receiptNo} ·{' '}
          </span>
        )}
        {t('seeYou')} · {businessName}
      </p>
      <span
        className="cd-done__bar"
        style={{ animationDuration: `${DISPLAY_THANKS_SECONDS}s` }}
        aria-hidden
      />
    </div>
  );
}
