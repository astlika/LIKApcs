/**
 * "No open cash shift" guard.
 *
 * The server refuses cash tenders (sales, session bills, drawer expenses) with
 * 409 `SHIFT_REQUIRED` while `cash.require_open_shift` is on and no shift is open. Any mutation
 * can hand such an error to `shiftGuard.handle(err, retry)`: a dialog offers to open the shift
 * right there (for users with cash.open_close) and re-runs the original action afterwards.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, parseMoneyInput, type CashShiftDetail } from '@likapcs/shared';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../i18n';
import { useAuth } from './auth';
import { useToast } from './toast';
import { Alert, Button, Dialog, Field, Input } from '../components/ui/primitives';

export const SHIFT_REQUIRED = 'SHIFT_REQUIRED';

export function isShiftRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === SHIFT_REQUIRED;
}

interface ShiftGuardValue {
  /** Opens the dialog; `onOpened` runs after a shift was opened successfully. */
  requestOpenShift: (onOpened?: () => void) => void;
  /** Returns true when `err` was a SHIFT_REQUIRED error and the dialog took over. */
  handle: (err: unknown, retry?: () => void) => boolean;
}

const ShiftGuardContext = createContext<ShiftGuardValue | null>(null);

export function ShiftGuardProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState('');
  const [notes, setNotes] = useState('');
  const afterOpen = useRef<(() => void) | undefined>(undefined);
  const canOpen = can(PERMISSIONS.CASH_OPEN_CLOSE);

  const requestOpenShift = useCallback((onOpened?: () => void) => {
    afterOpen.current = onOpened;
    setOpening('');
    setNotes('');
    setOpen(true);
  }, []);
  const handle = useCallback(
    (err: unknown, retry?: () => void) => {
      if (!isShiftRequired(err)) return false;
      requestOpenShift(retry);
      return true;
    },
    [requestOpenShift],
  );

  const openingCents = opening.trim() ? parseMoneyInput(opening) : 0;
  const mutation = useMutation({
    mutationFn: () =>
      api<CashShiftDetail>('/cash/shifts/open', {
        method: 'POST',
        body: { openingCents: openingCents ?? 0, notes: notes.trim() || undefined },
      }),
    onSuccess: () => {
      toast.success(t('cash.shiftOpened'));
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setOpen(false);
      const next = afterOpen.current;
      afterOpen.current = undefined;
      next?.();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const value = useMemo<ShiftGuardValue>(
    () => ({ requestOpenShift, handle }),
    [requestOpenShift, handle],
  );

  return (
    <ShiftGuardContext.Provider value={value}>
      {children}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('cash.openShift')}
        description={canOpen ? t('cash.openShiftHint') : undefined}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            {canOpen && (
              <Button
                variant="primary"
                onClick={() => mutation.mutate()}
                loading={mutation.isPending}
                disabled={openingCents === null}
              >
                {t('cash.openShift')}
              </Button>
            )}
          </>
        }
      >
        {canOpen ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (openingCents !== null && !mutation.isPending) mutation.mutate();
            }}
          >
            <Field
              label={t('cash.openingFloat')}
              hint={t('cash.openingFloatHint')}
              error={openingCents === null ? t('common.invalid') : undefined}
            >
              {(id, invalid) => (
                <Input
                  id={id}
                  aria-invalid={invalid || undefined}
                  autoFocus
                  inputMode="decimal"
                  placeholder="0.00"
                  value={opening}
                  onChange={(e) => setOpening(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('common.notes')} optional>
              {(id, invalid) => (
                <Input
                  id={id}
                  aria-invalid={invalid || undefined}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={500}
                />
              )}
            </Field>
          </form>
        ) : (
          <Alert tone="warning">{t('cash.shiftRequiredNoPermission')}</Alert>
        )}
      </Dialog>
    </ShiftGuardContext.Provider>
  );
}

export function useShiftGuard(): ShiftGuardValue {
  const ctx = useContext(ShiftGuardContext);
  if (!ctx) throw new Error('useShiftGuard must be used inside ShiftGuardProvider');
  return ctx;
}
