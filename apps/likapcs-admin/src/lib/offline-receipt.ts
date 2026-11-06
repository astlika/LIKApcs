/**
 * Punkti 4 (0.28.0): the offline slip, 80 mm. It is NOT a fiscal invoice: it carries this PC's
 * number and says so. The official R-number is given when the sale reaches the server.
 */
import type { OfflineLine, QueuedSale } from './offline-sales';

const esc = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const money = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export function offlineSlipHtml(
  sale: QueuedSale,
  shopName: string,
  when: Date = new Date(),
): string {
  const rows = sale.lines
    .map(
      (l: OfflineLine) =>
        `<tr><td colspan="2">${esc(l.name)}</td></tr>` +
        `<tr><td>${(l.quantityMilli / 1000).toString()} × ${money(l.unitPriceCents)}</td>` +
        `<td class="r">${money(l.lineCents)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sale.localNumber)}</title>
<style>
  @page { size: 80mm auto; margin: 3mm; }
  body { width: 72mm; font: 12px/1.35 monospace; color: #000; margin: 0; }
  h1 { font-size: 15px; text-align: center; margin: 2px 0; }
  .c { text-align: center; } .r { text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  .big { font-size: 15px; font-weight: bold; }
  .flag { border: 2px solid #000; text-align: center; font-weight: bold; padding: 3px; margin: 6px 0; }
  hr { border: 0; border-top: 1px dashed #000; margin: 5px 0; }
</style></head><body>
<h1>${esc(shopName)}</h1>
<div class="c">${esc(when.toLocaleString('sq-AL'))}</div>
<div class="flag">JO-FISKAL · PROVIZOR</div>
<div class="c big">${esc(sale.localNumber)}</div>
<div class="c">Numri zyrtar i faturës do të jepet kur shitja arrin te serveri.</div>
<hr>
<table>${rows}</table>
<hr>
<table><tr><td class="big">TOTAL</td><td class="r big">${money(sale.totalCents)}</td></tr></table>
<hr>
<div class="c">Faleminderit!</div>
</body></html>`;
}

/** Prints the slip through a hidden frame (works inside the desktop webview too). */
export function printOfflineSlip(sale: QueuedSale, shopName = 'LIKApcs'): void {
  if (typeof document === 'undefined') return;
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  doc.open();
  doc.write(offlineSlipHtml(sale, shopName));
  doc.close();
  win.focus();
  win.print();
  setTimeout(() => frame.remove(), 1000);
}
