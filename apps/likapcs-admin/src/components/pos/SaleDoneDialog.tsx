/**
 * "Done" dialog shown the moment money has been taken — after a POS sale and after a session bill
 * (prepaid start / extension, postpaid end). The change due in large type, the receipt preview,
 * and Print / Finish. Finishing happens by itself after `autoFinishSeconds` (Settings › Printing;
 * 0 waits for the cashier); pressing Print stops the countdown so the print dialog is never
 * pulled away. Enter / Esc finish, P prints. The POS page additionally finishes when the next
 * product is scanned (its scanner hook).
 *
 * 0.34.0: a sale with internet access shows its codes here in large type. Such a screen never
 * closes by itself, and for a moment it cannot be closed from the keyboard either — the Enter
 * that paid is often pressed twice, and the code must not vanish before it was read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Printer, Wifi } from 'lucide-react';
import type { ReceiptData } from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { useFormat } from '../../lib/format';
import { Button, Dialog, Kbd } from '../ui/primitives';
import { Receipt, printReceipt } from './Receipt';

/** How long a sale with internet codes cannot be closed from the keyboard. */
const CODE_GUARD_MS = 1500;

/** One code in large type; a click copies it (for a message to the customer). */
function AccessCode({ code }: { code: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the code is on the screen and on the receipt */
    }
  };
  return (
    <div className="pos-codes__code">
      <span className="access-code" data-testid="access-code-value">
        {code}
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => void copy()}
        title={t('pos.copyCode')}
        aria-label={t('pos.copyCode')}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

export function SaleDoneDialog({
  receipt,
  onFinish,
  title,
  testId = 'pos',
  variant = 'pos',
}: {
  receipt: ReceiptData;
  onFinish: () => void;
  /** Defaults to "Sale completed"; session bills say "Payment recorded". */
  title?: string;
  testId?: string;
  /** Session bills: the hint talks about closing, not about the next sale. */
  variant?: 'pos' | 'session';
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const codeLines = receipt.sale.items.filter((i) => (i.accessCodes?.length ?? 0) > 0);
  const hasCodes = codeLines.length > 0;
  const seconds = Math.max(0, Math.floor(receipt.autoFinishSeconds));
  const [remaining, setRemaining] = useState(seconds);
  // With a code on the screen the cashier decides when it is done.
  const [counting, setCounting] = useState(seconds > 0 && !hasCodes);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  // The first moment after a sale with codes: keys do not close the screen.
  const [guarded, setGuarded] = useState(hasCodes);
  const guardedRef = useRef(guarded);
  guardedRef.current = guarded;
  useEffect(() => {
    if (!hasCodes) return;
    const h = window.setTimeout(() => setGuarded(false), CODE_GUARD_MS);
    return () => window.clearTimeout(h);
  }, [hasCodes]);

  const print = useCallback(() => {
    setCounting(false);
    printReceipt();
  }, []);

  // Settings › Printing › "Print receipt automatically" — the countdown keeps running: the print
  // dialog blocks the page while it is up, so the remaining seconds elapse after it closes.
  useEffect(() => {
    if (!receipt.autoPrint) return;
    const h = window.setTimeout(() => printReceipt(), 150);
    return () => window.clearTimeout(h);
  }, [receipt.autoPrint]);

  useEffect(() => {
    if (!counting) return;
    const h = window.setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          window.clearInterval(h);
          window.setTimeout(() => onFinishRef.current(), 0);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => window.clearInterval(h);
  }, [counting]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `repeat`: the Enter that completed the payment may still be held down when this mounts.
      if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!guardedRef.current) onFinishRef.current();
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        print();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [print]);

  const { sale } = receipt;
  // What the customer actually handed over now — "pay later" is not money in the drawer.
  const tendered = sale.payments
    .filter((p) => p.kind === 'sale' && p.method !== 'credit')
    .reduce((a, p) => a + p.amountCents, 0);
  // Part settled from the prepaid balance (0.11.0) — shown on its own line.
  const fromWallet = sale.payments
    .filter((p) => p.kind === 'sale' && p.method === 'wallet')
    .reduce((a, p) => a + p.amountCents, 0);
  return (
    <Dialog
      open
      onClose={onFinish}
      title={title ?? t('pos.doneTitle')}
      description={sale.receiptNo ?? undefined}
      size="sm"
      locked={guarded}
      footer={
        <>
          <Button onClick={print}>
            <Printer size={14} /> {t('pos.print')} <Kbd>P</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={onFinish}
            disabled={guarded}
            data-testid={`${testId}-finish`}
          >
            {counting ? t('pos.finishCountdown', { s: remaining }) : t('pos.finish')}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        {hasCodes && (
          <div className="pos-codes" data-testid={`${testId}-access-codes`}>
            <div className="pos-codes__title">
              <Wifi size={16} />{' '}
              {codeLines.reduce((n, i) => n + i.accessCodes.length, 0) === 1
                ? t('pos.accessCodeTitle')
                : t('pos.accessCodesTitle')}
            </div>
            {codeLines.map((line) => (
              <div key={line.id} className="pos-codes__line">
                <div className="pos-codes__name">{line.description}</div>
                {line.accessCodes.map((code) => (
                  <AccessCode key={code} code={code} />
                ))}
              </div>
            ))}
            <div className="pos-codes__hint">{t('pos.accessCodesHint')}</div>
          </div>
        )}
        <div className="pos-done">
          <div className="pos-done__row">
            <span>{t('pos.total')}</span>
            <span className="num">{fmt.money(sale.totalCents)}</span>
          </div>
          <div className="pos-done__row">
            <span>{t('pos.paid')}</span>
            <span className="num">{fmt.money(tendered)}</span>
          </div>
          {fromWallet > 0 && (
            <div
              className="pos-done__row pos-done__row--wallet"
              data-testid={`${testId}-done-wallet`}
            >
              <span>{t('pos.wallet')}</span>
              <span className="num">{t('pos.walletPaid', { amount: fmt.money(fromWallet) })}</span>
            </div>
          )}
          {sale.debt && (
            <div className="pos-done__row pos-done__row--debt" data-testid={`${testId}-done-debt`}>
              <span>{t('pos.payLater')}</span>
              <span className="num">
                {t('pos.debtRecorded', {
                  amount: fmt.money(sale.debt.amountCents),
                  date: fmt.date(sale.debt.dueDate),
                })}
              </span>
            </div>
          )}
          <div className="pos-done__change" data-testid={`${testId}-change`}>
            <span>{t('pos.change')}</span>
            <strong className="num">{fmt.money(sale.changeCents)}</strong>
          </div>
        </div>
        <p className="faint pos-done__hint">
          {variant === 'session'
            ? counting
              ? t('sessions.autoFinishHint', { s: remaining })
              : t('sessions.finishHint')
            : counting
              ? t('pos.autoFinishHint', { s: remaining })
              : hasCodes
                ? t('pos.finishHintCodes')
                : t('pos.finishHint')}
        </p>
        <div className="pos-done__receipt">
          {receipt.claimPins && receipt.claimPins.length > 0 && (
            <div className="stack" data-testid={`${testId}-claim-pins`}>
              <strong>{t('pos.claimPinsTitle')}</strong>
              <div className="muted small">{t('pos.claimPinsHint')}</div>
              {receipt.claimPins.map((p) => (
                <div key={p.creditId} className="pos-done__row">
                  <span>
                    {p.holderName} · {t('pos.claimPinsMinutes', { minutes: p.minutes })}
                  </span>
                  <span className="num" data-testid="claim-pin-value">
                    {p.pin}
                  </span>
                </div>
              ))}
            </div>
          )}
          <Receipt data={receipt} />
        </div>
      </div>
    </Dialog>
  );
}
