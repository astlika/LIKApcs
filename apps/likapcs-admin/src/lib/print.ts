/**
 * Prints a self-contained HTML document (A4 invoices, reports) through a hidden iframe, so the
 * page's own print styles (thermal receipt) are not involved and `@page` can be set per document.
 * Works in browsers and in the Tauri WebView (WebView2 / WebKit) without opening new windows.
 */
export function printHtmlDocument(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.srcdoc = html;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.setTimeout(() => frame.remove(), 1000);
      resolve();
    };
    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) return finish();
      // Give the WebView a tick to lay out fonts before opening the dialog.
      window.setTimeout(() => {
        try {
          win.focus();
          win.print();
        } finally {
          // `afterprint` is unreliable across WebViews; keep the frame alive long enough for the
          // print dialog to grab the document, then clean up.
          window.setTimeout(finish, 60_000);
          win.addEventListener?.('afterprint', finish);
        }
      }, 50);
    };
    document.body.appendChild(frame);
  });
}

/** Escapes text for inclusion in HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
