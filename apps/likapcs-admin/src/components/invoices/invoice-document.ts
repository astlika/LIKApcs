/**
 * A4 invoice as a self-contained HTML document (inline CSS, no external resources). The same
 * markup is shown in the preview dialog (iframe) and sent to the printer, so what you see is what
 * prints. Monetary values arrive as integer cents and are formatted here only for display.
 */
import type { InvoiceData, SaleItemSummary } from '@likapcs/shared';
import { escapeHtml as e } from '../../lib/print';

export interface InvoiceRenderContext {
  lang: string;
  t: (key: InvoiceTextKey) => string;
  money: (cents: number) => string;
  date: (value: string | null | undefined) => string;
  dateTime: (value: string | null | undefined) => string;
  methodLabel: (method: string) => string;
}

export type InvoiceTextKey =
  | 'title'
  | 'copy'
  | 'void'
  | 'number'
  | 'issuedAt'
  | 'dueAt'
  | 'dueOnReceipt'
  | 'receipt'
  | 'seller'
  | 'buyer'
  | 'taxId'
  | 'registrationNo'
  | 'phone'
  | 'email'
  | 'web'
  | 'item'
  | 'qty'
  | 'unitPrice'
  | 'discount'
  | 'vatRate'
  | 'amount'
  | 'subtotal'
  | 'saleDiscount'
  | 'net'
  | 'vat'
  | 'total'
  | 'vatBreakdown'
  | 'base'
  | 'payments'
  | 'paid'
  | 'balanceDue'
  | 'refunded'
  | 'notes'
  | 'bank'
  | 'issuedBy'
  | 'printedAt'
  | 'voidReason'
  | 'page';

const qty = (milli: number) =>
  milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3);
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

export function invoiceVatBreakdown(
  items: SaleItemSummary[],
): { rateBp: number; baseCents: number; taxCents: number }[] {
  const map = new Map<number, { rateBp: number; baseCents: number; taxCents: number }>();
  for (const i of items) {
    const row = map.get(i.taxRateBp) ?? { rateBp: i.taxRateBp, baseCents: 0, taxCents: 0 };
    row.baseCents += i.lineTotalCents - i.taxCents;
    row.taxCents += i.taxCents;
    map.set(i.taxRateBp, row);
  }
  return [...map.values()].sort((a, b) => a.rateBp - b.rateBp);
}

export function buildInvoiceHtml(data: InvoiceData, ctx: InvoiceRenderContext): string {
  const { business, invoice, sale } = data;
  const { t, money } = ctx;
  const isVoid = invoice.status === 'void';
  const paidCents =
    sale.payments.filter((p) => p.kind === 'sale').reduce((s, p) => s + p.amountCents, 0) -
    sale.changeCents;
  const balanceCents = Math.max(0, sale.totalCents - paidCents);
  const netCents = sale.totalCents - sale.taxCents;
  const sellerLines = [
    business.legalName && business.legalName !== business.name ? business.legalName : '',
    [business.address, business.city].filter(Boolean).join(', '),
    business.taxId ? `${t('taxId')}: ${business.taxId}` : '',
    business.registrationNo ? `${t('registrationNo')}: ${business.registrationNo}` : '',
    business.phone ? `${t('phone')}: ${business.phone}` : '',
    business.email ? `${t('email')}: ${business.email}` : '',
    business.website ? `${t('web')}: ${business.website}` : '',
  ].filter(Boolean);
  const buyerLines = [
    invoice.billingAddress ?? '',
    invoice.billingTaxId ? `${t('taxId')}: ${invoice.billingTaxId}` : '',
    invoice.billingEmail ? `${t('email')}: ${invoice.billingEmail}` : '',
  ].filter(Boolean);

  const rows = sale.items
    .map(
      (i, idx) => `
      <tr>
        <td class="c">${idx + 1}</td>
        <td>${e(i.description)}${i.sku ? `<div class="sku">${e(i.sku)}</div>` : ''}</td>
        <td class="r">${qty(i.quantityMilli)}</td>
        <td class="r">${e(money(i.unitPriceCents))}</td>
        <td class="r">${i.discountCents > 0 ? `−${e(money(i.discountCents))}` : '—'}</td>
        <td class="r">${pct(i.taxRateBp)}</td>
        <td class="r">${e(money(i.lineTotalCents))}</td>
      </tr>`,
    )
    .join('');
  const vatRows = invoiceVatBreakdown(sale.items)
    .map(
      (v) =>
        `<tr><td>${pct(v.rateBp)}</td><td class="r">${e(money(v.baseCents))}</td><td class="r">${e(money(v.taxCents))}</td></tr>`,
    )
    .join('');
  // Cash tenders are stored as handed over; the change goes back to the customer, so the invoice
  // shows the amount actually applied to the sale.
  let changeLeft = sale.changeCents;
  const paymentRows = sale.payments
    .filter((p) => p.kind === 'sale')
    .map((p) => {
      let applied = p.amountCents;
      if (p.method === 'cash' && changeLeft > 0) {
        const back = Math.min(changeLeft, applied);
        applied -= back;
        changeLeft -= back;
      }
      return `<tr><td>${e(ctx.methodLabel(p.method))}</td><td class="r">${e(money(applied))}</td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="${e(ctx.lang)}">
<head>
<meta charset="utf-8">
<title>${e(invoice.invoiceNo)}</title>
<style>
  @page { size: A4; margin: 14mm 14mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font: 11pt/1.4 "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; position: relative; }
  .sheet { width: 182mm; margin: 0 auto; padding: 0; position: relative; }
  @media screen {
    html, body { overflow-x: hidden; }
    body { background: #e9ecef; padding: 16px 0; }
    .sheet { background: #fff; padding: 14mm; min-height: 297mm; box-shadow: 0 4px 24px rgba(0,0,0,.18); width: 210mm; zoom: var(--fit, 1); }
  }
  h1 { font-size: 22pt; letter-spacing: .04em; margin: 0; font-weight: 700; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #111; padding-bottom: 10px; }
  .brand { font-size: 16pt; font-weight: 700; }
  .meta { text-align: right; }
  .meta table { margin-left: auto; border-collapse: collapse; }
  .meta td { padding: 1px 0 1px 14px; }
  .meta td:first-child { color: #555; }
  .tag { display: inline-block; margin-top: 6px; padding: 2px 8px; border: 1.5px solid #111; border-radius: 4px; font-size: 9pt; font-weight: 700; letter-spacing: .08em; }
  .tag--void { border-color: #b00020; color: #b00020; }
  .parties { display: flex; gap: 24px; margin: 14px 0 16px; }
  .party { flex: 1; border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; min-height: 30mm; }
  .party h3 { margin: 0 0 4px; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .08em; color: #666; }
  .party .name { font-weight: 700; font-size: 12pt; }
  .party div { white-space: pre-line; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items th { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .05em; color: #444; border-bottom: 1.5px solid #111; padding: 6px 6px; text-align: left; }
  table.items td { padding: 6px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .sku { font-size: 8pt; color: #777; }
  .r { text-align: right; white-space: nowrap; } .c { text-align: center; }
  .totals { display: flex; justify-content: space-between; gap: 24px; margin-top: 12px; align-items: flex-start; }
  .totals .left { flex: 1; font-size: 9.5pt; }
  .totals .left table { border-collapse: collapse; }
  .totals .left th, .totals .left td { padding: 2px 10px 2px 0; text-align: left; font-weight: 400; color: #333; }
  .totals .left th { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .05em; color: #666; }
  .sum { width: 72mm; border-collapse: collapse; }
  .sum td { padding: 3px 6px; }
  .sum td:first-child { color: #444; }
  .sum tr.total td { border-top: 2px solid #111; font-size: 13pt; font-weight: 700; padding-top: 6px; }
  .sum tr.due td { color: #b00020; font-weight: 700; }
  .box { border: 1px solid #ccc; border-radius: 6px; padding: 8px 10px; margin-top: 12px; white-space: pre-line; font-size: 10pt; }
  .box h4 { margin: 0 0 3px; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .08em; color: #666; }
  .foot { margin-top: 18px; padding-top: 8px; border-top: 1px solid #ccc; font-size: 8.5pt; color: #666; display: flex; justify-content: space-between; gap: 12px; }
  .footer-text { margin-top: 14px; font-size: 9.5pt; white-space: pre-line; color: #333; }
  .watermark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .watermark span { font-size: 90pt; font-weight: 900; color: rgba(176,0,32,.12); transform: rotate(-24deg); letter-spacing: .1em; border: 6px solid rgba(176,0,32,.12); padding: 10px 40px; border-radius: 16px; }
</style>
</head>
<body>
<script>
  // Screen preview only: shrink the A4 sheet to the available width (print uses the real size).
  (function () {
    function fit() {
      var w = 210 * 96 / 25.4 + 2;
      var avail = document.documentElement.clientWidth - 24;
      document.documentElement.style.setProperty('--fit', String(Math.min(1, avail / w)));
    }
    window.addEventListener('resize', fit);
    fit();
  })();
</script>
<div class="sheet">
  ${isVoid ? `<div class="watermark"><span>${e(t('void'))}</span></div>` : ''}
  <div class="head">
    <div>
      <div class="brand">${e(business.name)}</div>
      ${sellerLines.map((l) => `<div>${e(l)}</div>`).join('')}
    </div>
    <div class="meta">
      <h1>${e(t('title'))}</h1>
      <table>
        <tr><td>${e(t('number'))}</td><td><strong>${e(invoice.invoiceNo)}</strong></td></tr>
        <tr><td>${e(t('issuedAt'))}</td><td>${e(ctx.date(invoice.issuedAt))}</td></tr>
        <tr><td>${e(t('dueAt'))}</td><td>${invoice.dueAt && invoice.dueAt !== invoice.issuedAt.slice(0, 10) ? e(ctx.date(invoice.dueAt)) : e(t('dueOnReceipt'))}</td></tr>
        ${sale.receiptNo ? `<tr><td>${e(t('receipt'))}</td><td>${e(sale.receiptNo)}</td></tr>` : ''}
      </table>
      ${isVoid ? `<div class="tag tag--void">${e(t('void'))}</div>` : data.isReprint ? `<div class="tag">${e(t('copy'))}</div>` : ''}
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <h3>${e(t('seller'))}</h3>
      <div class="name">${e(business.legalName || business.name)}</div>
      ${sellerLines.map((l) => `<div>${e(l)}</div>`).join('')}
    </div>
    <div class="party">
      <h3>${e(t('buyer'))}</h3>
      <div class="name">${e(invoice.billingName)}</div>
      ${buyerLines.map((l) => `<div>${e(l)}</div>`).join('')}
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th class="c">#</th>
        <th>${e(t('item'))}</th>
        <th class="r">${e(t('qty'))}</th>
        <th class="r">${e(t('unitPrice'))}</th>
        <th class="r">${e(t('discount'))}</th>
        <th class="r">${e(t('vatRate'))}</th>
        <th class="r">${e(t('amount'))}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div class="left">
      <table>
        <thead><tr><th>${e(t('vatBreakdown'))}</th><th>${e(t('base'))}</th><th>${e(t('vat'))}</th></tr></thead>
        <tbody>${vatRows}</tbody>
      </table>
      ${
        paymentRows
          ? `<table style="margin-top:8px"><thead><tr><th colspan="2">${e(t('payments'))}</th></tr></thead><tbody>${paymentRows}</tbody></table>`
          : ''
      }
    </div>
    <table class="sum">
      <tr><td>${e(t('subtotal'))}</td><td class="r">${e(money(sale.subtotalCents))}</td></tr>
      ${sale.discountCents > 0 ? `<tr><td>${e(t('saleDiscount'))}</td><td class="r">−${e(money(sale.discountCents))}</td></tr>` : ''}
      <tr><td>${e(t('net'))}</td><td class="r">${e(money(netCents))}</td></tr>
      <tr><td>${e(t('vat'))}</td><td class="r">${e(money(sale.taxCents))}</td></tr>
      <tr class="total"><td>${e(t('total'))}</td><td class="r">${e(money(sale.totalCents))}</td></tr>
      <tr><td>${e(t('paid'))}</td><td class="r">${e(money(Math.min(paidCents, sale.totalCents)))}</td></tr>
      <tr class="${balanceCents > 0 ? 'due' : ''}"><td>${e(t('balanceDue'))}</td><td class="r">${e(money(balanceCents))}</td></tr>
      ${sale.refundedCents > 0 ? `<tr><td>${e(t('refunded'))}</td><td class="r">−${e(money(sale.refundedCents))}</td></tr>` : ''}
    </table>
  </div>

  ${invoice.notes ? `<div class="box"><h4>${e(t('notes'))}</h4>${e(invoice.notes)}</div>` : ''}
  ${business.bankDetails ? `<div class="box"><h4>${e(t('bank'))}</h4>${e(business.bankDetails)}</div>` : ''}
  ${isVoid && invoice.voidReason ? `<div class="box"><h4>${e(t('voidReason'))}</h4>${e(invoice.voidReason)}</div>` : ''}
  ${business.footer ? `<div class="footer-text">${e(business.footer)}</div>` : ''}

  <div class="foot">
    <span>${e(t('issuedBy'))}: ${e(invoice.issuedByName ?? '—')}</span>
    <span>${e(t('printedAt'))}: ${e(ctx.dateTime(data.printedAt))}</span>
  </div>
</div>
</body>
</html>`;
}
