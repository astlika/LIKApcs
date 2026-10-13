/**
 * Main-window end of the customer display link (0.16.0, see `lib/customer-display.ts`).
 *
 * Mounted once inside the authenticated shell (it needs the POS draft and the server). It turns
 * the cart into a `DisplaySale`, overlays what the payment dialog reports (`setTender`) and the
 * completed sale (`setDone`), and posts the resulting `DisplayState` whenever it changes. It also
 * keeps the ads program (`GET /ads/feed`) fresh and answers the display's `hello` with everything
 * it has. The display opens by itself at start-up when this PC has it switched on (Settings).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomerDisplayFeed, CustomerSummary } from '@likapcs/shared';
import { api, fileUrl } from '../lib/api';
import { cartItemCount, cartTotals, unitPriceOf, type Cart } from '../lib/cart';
import {
  DISPLAY_THANKS_SECONDS,
  DisplayChannel,
  loadDisplayPrefs,
  openCustomerDisplay,
  type DisplayBrand,
  type DisplayCustomer,
  type DisplayDone,
  type DisplaySale,
  type DisplayState,
  type DisplayTender,
} from '../lib/customer-display';
import { useAppSettings } from './app-settings';
import { useI18n } from '../i18n';
import { usePosCart } from './pos-cart';

interface CustomerDisplayValue {
  /** The payment dialog reports what is being counted; null when it is closed. */
  setTender: (tender: DisplayTender | null) => void;
  /** A sale was completed: thank-you screen for `DISPLAY_THANKS_SECONDS`. */
  setDone: (done: Omit<DisplayDone, 'at'>) => void;
  /** True once a display window has reported in (this app session). */
  connected: boolean;
  state: DisplayState;
}

const noop = () => {};
const CustomerDisplayContext = createContext<CustomerDisplayValue>({
  setTender: noop,
  setDone: noop,
  connected: false,
  state: { kind: 'idle' },
});

export function displayCustomerOf(
  customer: CustomerSummary | null,
  walletEnabled: boolean,
): DisplayCustomer | null {
  if (!customer) return null;
  return {
    name: customer.name,
    balanceDueCents: customer.balanceDueCents > 0 ? customer.balanceDueCents : null,
    walletBalanceCents: walletEnabled ? customer.walletBalanceCents : null,
  };
}

/** The open sale as the customer screen shows it; null while the cart is empty. */
export function displaySaleOf(
  cart: Cart,
  customer: CustomerSummary | null,
  walletEnabled: boolean,
  lastLineId: string | null,
): DisplaySale | null {
  if (cart.lines.length === 0) return null;
  const totals = cartTotals(cart, customer?.discountBp ?? 0);
  return {
    lines: cart.lines.map((l) => {
      const unit = unitPriceOf(l.product);
      const gross = Math.round((unit * l.quantityMilli) / 1000);
      return {
        id: l.product.id,
        name: l.product.name,
        quantityMilli: l.quantityMilli,
        unitPriceCents: unit,
        totalCents: Math.max(0, gross - Math.min(l.discountCents, gross)),
        regularPriceCents: unit < l.product.sellingPriceCents ? l.product.sellingPriceCents : null,
        imageUrl: fileUrl(l.product.imageUrl),
      };
    }),
    subtotalCents: totals.subtotalCents,
    discountCents: totals.discountCents,
    totalCents: totals.totalCents,
    itemCount: cartItemCount(cart),
    customer: displayCustomerOf(customer, walletEnabled),
    lastLineId,
  };
}

export function CustomerDisplayProvider({ children }: { children: ReactNode }) {
  const { cart, customer } = usePosCart();
  const settings = useAppSettings();
  const { language } = useI18n();
  const queryClient = useQueryClient();
  const channel = useMemo(() => new DisplayChannel(), []);
  const [tender, setTenderState] = useState<DisplayTender | null>(null);
  const [done, setDoneState] = useState<DisplayDone | null>(null);
  const [connected, setConnected] = useState(false);
  const [prefsEnabled] = useState(() => loadDisplayPrefs().enabled);

  // Which line changed last: compare quantities with the previous cart.
  const prevLines = useRef<Map<string, number>>(new Map());
  const lastLineId = useMemo(() => {
    const prev = prevLines.current;
    let changed: string | null = null;
    for (const l of cart.lines) {
      if (prev.get(l.product.id) !== l.quantityMilli) changed = l.product.id;
    }
    prevLines.current = new Map(cart.lines.map((l) => [l.product.id, l.quantityMilli]));
    return changed ?? cart.lines[cart.lines.length - 1]?.product.id ?? null;
  }, [cart.lines]);

  const walletEnabled = settings['wallet.enabled'];
  const sale = useMemo(
    () => displaySaleOf(cart, customer, walletEnabled, lastLineId),
    [cart, customer, walletEnabled, lastLineId],
  );

  // The thank-you screen ends by itself; a new sale ends it at once (see `state`).
  useEffect(() => {
    if (!done) return;
    const left = done.at + DISPLAY_THANKS_SECONDS * 1000 - Date.now();
    const timer = window.setTimeout(() => setDoneState(null), Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [done]);

  const state = useMemo<DisplayState>(() => {
    if (sale) return tender ? { kind: 'paying', sale, tender } : { kind: 'sale', sale };
    if (done) return { kind: 'done', done };
    return { kind: 'idle' };
  }, [sale, tender, done]);

  const brand = useMemo<DisplayBrand>(
    () => ({
      businessName: settings['business.name'],
      language,
      currency: settings['locale.currency'],
    }),
    [settings, language],
  );

  // Ads program: only fetched while a display is in use on this PC (switched on, or one said hello).
  const active = prefsEnabled || connected;
  const feed = useQuery({
    queryKey: ['display', 'feed'],
    queryFn: () => api<CustomerDisplayFeed>('/ads/feed'),
    enabled: active,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Push on every change; answer a display's hello with the full picture.
  const latest = useRef({ state, brand, feed: feed.data ?? null });
  latest.current = { state, brand, feed: feed.data ?? null };
  useEffect(() => {
    channel.post({ type: 'state', state, brand });
  }, [channel, state, brand]);
  useEffect(() => {
    if (feed.data) channel.post({ type: 'feed', feed: feed.data });
  }, [channel, feed.data]);
  useEffect(() => {
    const off = channel.subscribe((message) => {
      if (message.type !== 'hello') return;
      setConnected(true);
      channel.post({ type: 'state', state: latest.current.state, brand: latest.current.brand });
      if (latest.current.feed) channel.post({ type: 'feed', feed: latest.current.feed });
      else void queryClient.invalidateQueries({ queryKey: ['display', 'feed'] });
    });
    return () => {
      off();
    };
  }, [channel, queryClient]);
  useEffect(() => () => channel.close(), [channel]);

  // Start-up: open the display on the configured monitor (desktop) when this PC uses one.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !prefsEnabled) return;
    opened.current = true;
    void openCustomerDisplay(loadDisplayPrefs().monitor).catch(() => {
      /* no second monitor / window creation failed — the POS keeps working */
    });
  }, [prefsEnabled]);

  const setTender = useCallback((t: DisplayTender | null) => setTenderState(t), []);
  const setDone = useCallback((d: Omit<DisplayDone, 'at'>) => {
    setTenderState(null);
    setDoneState({ ...d, at: Date.now() });
  }, []);

  const value = useMemo<CustomerDisplayValue>(
    () => ({ setTender, setDone, connected, state }),
    [setTender, setDone, connected, state],
  );
  return (
    <CustomerDisplayContext.Provider value={value}>{children}</CustomerDisplayContext.Provider>
  );
}

export function useCustomerDisplay(): CustomerDisplayValue {
  return useContext(CustomerDisplayContext);
}
