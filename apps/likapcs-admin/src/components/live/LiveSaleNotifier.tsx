/**
 * 0.31.0 — the sale notification for admins with live.view. Sales that arrive close together
 * (within 2 s of each other, at most 5 s from the first) are grouped per cashier into one toast,
 * so a busy minute does not flood the screen. A short chime plays too; browsers may block sound
 * until the admin has clicked something in the page, in which case only the toast shows.
 */
import { useEffect, useRef } from 'react';
import { PERMISSIONS, type LiveSale } from '@likapcs/shared';
import { useFormat } from '../../lib/format';
import { itemLabel, LIVE_SALE_EVENT } from '../../lib/live';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';

const QUIET_MS = 2000;
const MAX_WAIT_MS = 5000;

function chime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    window.setTimeout(() => void ctx.close(), 600);
  } catch {
    // No sound is not an error: the toast still shows.
  }
}

export function LiveSaleNotifier() {
  const { can } = useAuth();
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const enabled = can(PERMISSIONS.LIVE_VIEW);
  // The listener is set up once; it reads the latest translator, formatter and toast from here.
  const latest = useRef({ t, fmt, toast });
  latest.current = { t, fmt, toast };

  useEffect(() => {
    if (!enabled) return;
    let batch: LiveSale[] = [];
    let quiet: number | null = null;
    let cap: number | null = null;

    const flush = () => {
      if (quiet) window.clearTimeout(quiet);
      if (cap) window.clearTimeout(cap);
      quiet = null;
      cap = null;
      const sales = batch;
      batch = [];
      if (sales.length === 0) return;
      const { t: tr, fmt: f, toast: tst } = latest.current;
      const byCashier = new Map<string, LiveSale[]>();
      for (const s of sales) byCashier.set(s.cashierName, [...(byCashier.get(s.cashierName) ?? []), s]);
      for (const [cashier, group] of byCashier) {
        const total = group.reduce((sum, s) => sum + s.totalCents, 0);
        const profit = group.reduce((sum, s) => sum + s.profitCents, 0);
        const noCost = group.some((s) => s.missingCost);
        const profitText = `${f.money(profit)}${noCost ? ` (${tr('live.noCost')})` : ''}`;
        if (group.length === 1) {
          const [only] = group as [LiveSale];
          const items = only.items.map(itemLabel).join(', ');
          tst.success(
            tr('live.notifyTitle'),
            tr('live.notifyOne', {
              cashier,
              items,
              total: f.money(total),
              profit: profitText,
            }),
          );
        } else {
          tst.success(
            tr('live.notifyTitle'),
            tr('live.notifyMany', {
              cashier,
              count: group.length,
              total: f.money(total),
              profit: profitText,
            }),
          );
        }
      }
      chime();
    };

    const onSale = (event: Event) => {
      const sale = (event as CustomEvent<LiveSale>).detail;
      if (!sale) return;
      batch.push(sale);
      if (quiet) window.clearTimeout(quiet);
      quiet = window.setTimeout(flush, QUIET_MS);
      if (!cap) cap = window.setTimeout(flush, MAX_WAIT_MS);
    };

    window.addEventListener(LIVE_SALE_EVENT, onSale);
    return () => {
      window.removeEventListener(LIVE_SALE_EVENT, onSale);
      if (quiet) window.clearTimeout(quiet);
      if (cap) window.clearTimeout(cap);
    };
  }, [enabled]);

  return null;
}
