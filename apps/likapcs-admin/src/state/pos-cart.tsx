/**
 * The open POS sale, kept outside the page so switching Stations ↔ POS (F9) or any other page
 * never loses what the cashier has already scanned. This is a draft only: the authoritative sale
 * is created on the server at checkout (or with "suspend"), so nothing here is a business record.
 * It lives inside the authenticated shell and is dropped on logout.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { CustomerSummary } from '@likapcs/shared';
import { emptyCart, type Cart } from '../lib/cart';

interface PosCartValue {
  cart: Cart;
  setCart: Dispatch<SetStateAction<Cart>>;
  customer: CustomerSummary | null;
  setCustomer: Dispatch<SetStateAction<CustomerSummary | null>>;
  /** Id of the suspended sale the draft was resumed from (completed/voided together with it). */
  resumedId: string | null;
  setResumedId: Dispatch<SetStateAction<string | null>>;
  /** Last chosen category filter, so the grid comes back the way it was left. */
  categoryId: string | null;
  setCategoryId: Dispatch<SetStateAction<string | null>>;
  /** Empties the draft (cart, customer, resumed id). */
  reset: () => void;
}

const PosCartContext = createContext<PosCartValue | null>(null);

export function PosCartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<Cart>(() => emptyCart());
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [resumedId, setResumedId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const reset = useCallback(() => {
    setCart(emptyCart());
    setCustomer(null);
    setResumedId(null);
  }, []);
  const value = useMemo<PosCartValue>(
    () => ({
      cart,
      setCart,
      customer,
      setCustomer,
      resumedId,
      setResumedId,
      categoryId,
      setCategoryId,
      reset,
    }),
    [cart, customer, resumedId, categoryId, reset],
  );
  return <PosCartContext.Provider value={value}>{children}</PosCartContext.Provider>;
}

export function usePosCart(): PosCartValue {
  const ctx = useContext(PosCartContext);
  if (!ctx) throw new Error('usePosCart must be used inside <PosCartProvider>');
  return ctx;
}
