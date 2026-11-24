/**
 * Printable receipt (58/80 mm thermal layout). Rendered on screen in the receipt dialog and
 * printed through the browser/WebView print pipeline (`@media print` hides everything else).
 */
import { Fragment } from 'react';
import { receiptRows, type ReceiptData } from '@likapcs/shared';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';

export function Receipt({ data }: { data: ReceiptData }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { sale, business } = data;
  /** The receipt's own date and time, printed in its head. */
  const soldAt = sale.completedAt ?? sale.createdAt;
  const qty = (milli: number) =>
    milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3);
  /** "ora 14:05"; on another day than the receipt's: "22.11, ora 23:40". */
  const addedText = (addedAt: string) => {
    const { time, day } = fmt.timeOnParts(addedAt, soldAt);
    return day ? t('receipt.addedAtDay', { day, time }) : t('receipt.addedAt', { time });
  };
  return (
    <div className="receipt" data-width={data.widthMm} id="printable-receipt">
      <div className="receipt__head">
        <div className="receipt__name">{business.name}</div>
        {business.legalName && <div>{business.legalName}</div>}
        {(business.address || business.city) && (
          <div>{[business.address, business.city].filter(Boolean).join(', ')}</div>
        )}
        {business.phone && <div>{business.phone}</div>}
        {business.taxId && (
          <div>
            {t('receipt.taxId')}: {business.taxId}
          </div>
        )}
      </div>
      <div className="receipt__meta">
        <div>
          <span>{t('receipt.receiptNo')}</span>
          <strong>{sale.receiptNo}</strong>
        </div>
        <div>
          <span>{t('receipt.date')}</span>
          <span>{fmt.dateTime(soldAt)}</span>
        </div>
        <div>
          <span>{t('receipt.cashier')}</span>
          <span>{sale.cashierName ?? '—'}</span>
        </div>
        {sale.customerName && (
          <div>
            <span>{t('receipt.customer')}</span>
            <span>{sale.customerName}</span>
          </div>
        )}
        {data.isReprint && <div className="receipt__copy">{t('receipt.reprint')}</div>}
      </div>
      <table className="receipt__items">
        <thead>
          <tr>
            <th>{t('receipt.item')}</th>
            <th className="right">{t('receipt.qty')}</th>
            <th className="right">{t('receipt.price')}</th>
            <th className="right">{t('receipt.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {/* 0.36.0: the lines of one offer are one row — its name and its price, with what it holds. */}
          {receiptRows(sale.items).map((i) => (
            <Fragment key={i.key}>
              <tr>
                <td>
                  {i.description}
                  {/* 0.40.0: a product of a PC's bill was taken earlier than the bill is paid —
                      the receipt says when (with the day, when it was not the receipt's day). */}
                  {i.addedAt && (
                    <div className="receipt__line-time" data-testid="receipt-added-at">
                      {addedText(i.addedAt)}
                    </div>
                  )}
                  {i.discountCents > 0 && (
                    <div className="receipt__line-note">
                      −{fmt.money(i.discountCents)} {t('receipt.discount').toLowerCase()}
                    </div>
                  )}
                </td>
                <td className="right">{qty(i.quantityMilli)}</td>
                <td className="right">{fmt.money(i.unitPriceCents)}</td>
                <td className="right">{fmt.money(i.lineTotalCents)}</td>
              </tr>
              {/* What the offer holds, on the receipt's whole width (never squeezes the columns). */}
              {i.parts.length > 0 && (
                <tr className="receipt__parts">
                  <td colSpan={4} className="receipt__line-note" data-testid="receipt-offer-parts">
                    {i.parts.join(' · ')}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="receipt__totals">
        {(sale.discountCents > 0 || sale.subtotalCents !== sale.totalCents) && (
          <div>
            <span>{t('receipt.subtotal')}</span>
            <span>{fmt.money(sale.subtotalCents)}</span>
          </div>
        )}
        {sale.discountCents > 0 && (
          <div>
            <span>{t('receipt.discount')}</span>
            <span>−{fmt.money(sale.discountCents)}</span>
          </div>
        )}
        <div className="receipt__total">
          <span>{t('receipt.total')}</span>
          <span>{fmt.money(sale.totalCents)}</span>
        </div>
        <div className="receipt__vat">
          <span>{t('receipt.vat')}</span>
          <span>{fmt.money(sale.taxCents)}</span>
        </div>
        {sale.payments
          .filter((p) => p.kind === 'sale')
          .map((p) => (
            <div key={p.id}>
              <span>
                {t('receipt.paid')} · {t(`sessions.methods.${p.method}` as 'sessions.methods.cash')}
              </span>
              <span>{fmt.money(p.amountCents)}</span>
            </div>
          ))}
        {sale.changeCents > 0 && (
          <div>
            <span>{t('receipt.change')}</span>
            <span>{fmt.money(sale.changeCents)}</span>
          </div>
        )}
        {sale.debt && (
          <div className="receipt__line-note">
            {t('receipt.debtNote', {
              amount: fmt.money(sale.debt.amountCents),
              date: fmt.date(sale.debt.dueDate),
            })}
          </div>
        )}
        {sale.refundedCents > 0 && (
          <div className="receipt__line-note">
            {t('receipt.refundedNote', { amount: fmt.money(sale.refundedCents) })}
          </div>
        )}
      </div>
      {sale.items.some((i) => (i.accessCodes?.length ?? 0) > 0) && (
        <div className="receipt__codes" data-testid="receipt-access-codes">
          {sale.items
            .filter((i) => (i.accessCodes?.length ?? 0) > 0)
            .map((i) => (
              <div key={i.id} className="receipt__codes-line">
                <div className="receipt__codes-name">
                  {t('receipt.accessCode', { name: i.description })}
                </div>
                {i.accessCodes.map((code) => (
                  <div key={code} className="receipt__code">
                    {code}
                  </div>
                ))}
              </div>
            ))}
        </div>
      )}
      {data.claimPins && data.claimPins.length > 0 && (
        <div className="receipt__totals" data-testid="receipt-claim-pins">
          {data.claimPins.map((p) => (
            <div key={p.creditId} className="receipt__line-note">
              {t('receipt.claimPin', { name: p.holderName, minutes: p.minutes, pin: p.pin })}
            </div>
          ))}
        </div>
      )}
      <div className="receipt__foot">
        <div>{business.footer || t('receipt.thanks')}</div>
      </div>
    </div>
  );
}

/** Opens the browser print dialog for the receipt currently on screen. */
export function printReceipt(): void {
  window.print();
}
