/**
 * Printable receipt (58/80 mm thermal layout). Rendered on screen in the receipt dialog and
 * printed through the browser/WebView print pipeline (`@media print` hides everything else).
 */
import type { ReceiptData } from '@likapcs/shared';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';

export function Receipt({ data }: { data: ReceiptData }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { sale, business } = data;
  const qty = (milli: number) =>
    milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3);
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
          <span>{fmt.dateTime(sale.completedAt ?? sale.createdAt)}</span>
        </div>
        <div>
          <span>{t('receipt.cashier')}</span>
          <span>{sale.cashierName ?? '—'}</span>
        </div>
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
          {sale.items.map((i) => (
            <tr key={i.id}>
              <td>
                {i.description}
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
        {sale.refundedCents > 0 && (
          <div className="receipt__line-note">
            {t('receipt.refundedNote', { amount: fmt.money(sale.refundedCents) })}
          </div>
        )}
      </div>
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
