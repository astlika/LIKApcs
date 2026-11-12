/**
 * "Done" dialog shown the moment money has been taken — after a POS sale and after a session bill
 * (prepaid start / extension, postpaid end). The change due in large type, the receipt preview,
 * and Print / Finish. Finishing happens by itself after `autoFinishSeconds` (Settings › Printing;
 * 0 waits for the cashier); pressing Print stops the countdown so the print dialog is never
 * pulled away. Enter / Esc finish, P prints. The POS page additionally finishes when the next
 * product is scanned (its scanner hook).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Printer } from 'lucide-react';
import type { ReceiptData } from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { useFormat } from '../../lib/format';
import { Button, Dialog, Kbd } from '../ui/primitives';
import { Receipt, printReceipt } from './Receipt';

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
  const seconds = Math.max(0, Math.floor(receipt.autoFinishSeconds));
  const [remaining, setRemaining] = useState(seconds);
  const [counting, setCounting] = useState(seconds > 0);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

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
        onFinishRef.current();
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
      footer={
        <>
          <Button onClick={print}>
            <Printer size={14} /> {t('pos.print')} <Kbd>P</Kbd>
          </Button>
          <Button variant="primary" size="lg" onClick={onFinish} data-testid={`${testId}-finish`}>
            {counting ? t('pos.finishCountdown', { s: remaining }) : t('pos.finish')}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
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
