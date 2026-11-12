/**
 * 0.32.0 — the stations header: the figures at the top (active, free, waiting payment, debt, the
 * day's revenue and products sold), the View ▼ menu that picks the layout, and the hover card that
 * shows a PC's customer, time, products, total and start time without a click.
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, LayoutGrid, List, Rows3, Maximize2 } from 'lucide-react';
import type { StationSummary } from '@likapcs/shared';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import {
  BOARD_VIEWS,
  boardStats,
  clockLabel,
  describeStation,
  type BoardStats,
  type BoardView,
} from '../../lib/station-board';
import { useNow } from '../sessions/SessionPanel';
import { BadgePills, StateTag } from './StationBits';
import { formatHms } from '../../lib/session-time';

const VIEW_ICON = { grid: LayoutGrid, list: List, compact: Rows3, detailed: Maximize2 } as const;

/** Literal keys, so the translation check sees each label. */
const STAT_LABEL = {
  active: 'board.stats.active',
  free: 'board.stats.free',
  awaiting: 'board.stats.awaiting',
  debt: 'board.stats.debt',
  revenue: 'board.stats.revenue',
  products: 'board.stats.products',
} as const;

/** The six figures of the header. */
export function BoardStatsBar({
  stations,
  dashboard,
  loading,
}: {
  stations: StationSummary[];
  dashboard?: Parameters<typeof boardStats>[1];
  loading?: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const s: BoardStats = boardStats(stations, dashboard);
  const cards: { key: keyof typeof STAT_LABEL; value: string; tone: string }[] = [
    { key: 'active', value: String(s.active), tone: 'active' },
    { key: 'free', value: String(s.free), tone: 'free' },
    { key: 'awaiting', value: String(s.awaiting), tone: 'awaiting' },
    { key: 'debt', value: String(s.debt), tone: 'debt' },
    { key: 'revenue', value: fmt.money(s.revenueCents), tone: 'revenue' },
    { key: 'products', value: String(s.productUnits), tone: 'products' },
  ];
  return (
    <div className="board-stats" role="group" aria-label={t('board.stats.title')} data-loading={loading || undefined}>
      {cards.map((c) => (
        <div key={c.key} className="board-stat" data-tone={c.tone}>
          <span className="board-stat__label">{t(STAT_LABEL[c.key])}</span>
          <strong className="board-stat__value num">{c.value}</strong>
        </div>
      ))}
    </div>
  );
}

/** View ▼: Grid (the PC icons), List (rows), Compact (as many PCs as fit), Detailed (all information). */
export function ViewMenu({ value, onChange }: { value: BoardView; onChange: (v: BoardView) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const Current = VIEW_ICON[value];
  return (
    <div className="view-menu" ref={root}>
      <button
        type="button"
        className="view-menu__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="view-menu"
      >
        <Current size={15} aria-hidden />
        {t('board.view')} <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="view-menu__panel" role="menu">
          {BOARD_VIEWS.map((v) => {
            const Icon = VIEW_ICON[v];
            return (
              <button
                key={v}
                type="button"
                role="menuitemradio"
                aria-checked={value === v}
                className="view-menu__item"
                data-view={v}
                onClick={() => {
                  onChange(v);
                  setOpen(false);
                }}
              >
                <Icon size={15} aria-hidden />
                <span>
                  <strong>{t(`board.views.${v}`)}</strong>
                  <small>{t(`board.viewHint.${v}`)}</small>
                </span>
                {value === v && <Check size={14} aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The hover card: what is on this PC right now. Placed beside the PC, inside the screen. */
export function HoverInfo({
  station,
  rect,
  fetchedAt,
}: {
  station: StationSummary;
  rect: DOMRect;
  fetchedAt: number;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const now = useNow();
  const view = describeStation(station, fetchedAt, now);
  const width = 290;
  let left = rect.right + 12;
  if (left + width > window.innerWidth - 8) left = Math.max(8, rect.left - width - 12);
  const top = Math.min(Math.max(8, rect.top), window.innerHeight - 320);
  const live = station.activeSession;
  return (
    <div className="hover-info" role="tooltip" style={{ left, top, width }} data-state={view.state}>
      <div className="hover-info__head">
        <strong>
          {station.code}
          {station.name !== station.code ? ` · ${station.name}` : ''}
        </strong>
        <StateTag state={view.state} />
      </div>
      <BadgePills badges={view.badges} reserved={!!view.hold} compact />
      <dl className="hover-info__rows">
        <div>
          <dt>{t('board.customer')}</dt>
          <dd>{view.customerName ?? view.hold?.customerName ?? (view.debtCustomerName ?? '—')}</dd>
        </div>
        {view.timerSeconds !== null && (
          <div>
            <dt>{view.timerKind === 'remaining' ? t('board.timerLeft') : t('board.timerElapsed')}</dt>
            <dd className="num">{formatHms(view.timerSeconds)}</dd>
          </div>
        )}
        {live?.startedAt && (
          <div>
            <dt>{t('board.startedLabel')}</dt>
            <dd className="num">{clockLabel(live.startedAt, fmt.timeZone)}</dd>
          </div>
        )}
        {view.hold && (
          <div>
            <dt>{t('board.holdLabel')}</dt>
            <dd className="num">
              {view.hold.customerName} · {clockLabel(view.hold.startsAt, fmt.timeZone)}
            </dd>
          </div>
        )}
        {view.debtCents > 0 && (
          <div>
            <dt>{t('board.state.debt')}</dt>
            <dd className="num">{fmt.money(view.debtCents)}</dd>
          </div>
        )}
      </dl>
      <ul className="hover-info__products">
        {view.products.length === 0 && <li className="faint">{t('board.noProducts')}</li>}
        {view.products.map((p) => (
          <li key={p.name}>
            <span>
              {p.name}
              <span className="faint"> × {Math.round(p.quantityMilli / 1000)}</span>
            </span>
            <span className="num">{fmt.money(p.amountCents)}</span>
          </li>
        ))}
      </ul>
      <div className="hover-info__total">
        <span>{t('board.total')}</span>
        <strong className="num">{fmt.money(view.totalCents)}</strong>
      </div>
    </div>
  );
}
