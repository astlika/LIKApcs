/**
 * 0.33.0 — the three views besides the grid: List (one row per PC, a checkbox per row and one for
 * the whole group), Compact (as many PCs as fit) and Detailed (a card per PC with everything the
 * desk needs). Every item carries `data-pc` and a checkbox, so a PC can be selected in every view
 * with the mouse (click, Ctrl+click, Shift+click) and the page's rubber-band ignores them.
 */
import type { MouseEvent } from 'react';
import { Check } from 'lucide-react';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useNow } from '../sessions/SessionPanel';
import { formatHms } from '../../lib/session-time';
import {
  clockLabel,
  countdownLabel,
  describeStation,
  pcNameShown,
  type StationView,
} from '../../lib/station-board';
import { BadgePills, StateTag, usePcEvents, type SelectModifiers, type TileHandlers } from './StationBits';
import type { PcItemProps } from './StationMap';
import type { StationSummary } from '@likapcs/shared';

type Item = PcItemProps;
type Translate = ReturnType<typeof useI18n>['t'];

/** The timer as the desk reads it: what is left, what has run, or the reservation's time. */
export function timerText(view: StationView, t: Translate, tz?: string): string {
  if (view.timerSeconds !== null) return formatHms(view.timerSeconds);
  if (view.hold?.phase === 'scheduled') return t('board.forTime', { time: clockLabel(view.hold.startsAt, tz) });
  if (view.hold?.phase === 'window' && view.hold.windowSeconds !== null) {
    return t('board.deadline', { time: countdownLabel(view.hold.windowSeconds) });
  }
  return '—';
}

function useItemView(station: StationSummary, fetchedAt: number) {
  const now = useNow();
  return describeStation(station, fetchedAt, now);
}

/** The selection box. A click toggles this PC; Shift extends the selection from the last PC. */
export function PcCheck({
  checked,
  mixed,
  label,
  handlers,
  onToggle,
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  handlers?: TileHandlers;
  onToggle?: (mods: SelectModifiers) => void;
}) {
  const act = (e: MouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    const mods: SelectModifiers = { toggle: true, range: e.shiftKey, keep: false };
    if (onToggle) onToggle(mods);
    else handlers?.onSelect(mods);
  };
  return (
    <span
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      title={label}
      tabIndex={-1}
      className="pc-check"
      data-on={checked || undefined}
      data-mixed={mixed || undefined}
      onClick={act}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {checked && !mixed && <Check size={12} strokeWidth={3} />}
      {mixed && <span className="pc-check__dash" />}
    </span>
  );
}

export function StationList({
  items,
  allSelected,
  someSelected,
  onToggleAll,
}: {
  items: Item[];
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: (mods: SelectModifiers) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="pcl" role="table" aria-label={t('board.views.list')}>
      <div className="pcl__head" role="row">
        <span className="pcl__check" role="columnheader">
          <PcCheck
            checked={allSelected}
            mixed={someSelected && !allSelected}
            label={t('board.checkAll')}
            onToggle={onToggleAll}
          />
        </span>
        <span role="columnheader">{t('board.list.pc')}</span>
        <span role="columnheader">{t('board.list.state')}</span>
        <span role="columnheader">{t('board.list.time')}</span>
        <span role="columnheader">{t('board.list.customer')}</span>
        <span role="columnheader">{t('board.list.products')}</span>
        <span role="columnheader" className="num">{t('board.list.total')}</span>
        <span role="columnheader">{t('board.list.badges')}</span>
      </div>
      {items.map((item) => (
        <StationListRow key={item.station.id} {...item} />
      ))}
    </div>
  );
}

function StationListRow({ station, fetchedAt, selected, handlers }: Item) {
  const { t } = useI18n();
  const fmt = useFormat();
  const view = useItemView(station, fetchedAt);
  const events = usePcEvents(handlers);
  const customer = view.customerName ?? view.hold?.customerName ?? view.debtCustomerName ?? '—';
  const products = view.products.map((p) => p.name).join(', ');
  return (
    <div
      className="pcl__row"
      data-pc
      data-id={station.id}
      data-state={view.state}
      data-selected={selected || undefined}
      data-archived={station.archived ? 'true' : undefined}
      aria-selected={selected}
      {...events}
    >
      <span className="pcl__check">
        <PcCheck checked={selected} label={t('board.checkOne', { code: station.code })} handlers={handlers} />
      </span>
      <span className="pcl__pc" role="cell">
        <span className="pcl__dot" data-status={view.state} aria-hidden />
        <strong>{station.code}</strong>
        {pcNameShown(station, view) && <span className="faint">{pcNameShown(station, view)}</span>}
      </span>
      <span role="cell">
        <StateTag state={view.state} />
      </span>
      <span role="cell" className="num">
        {timerText(view, t, fmt.timeZone)}
      </span>
      <span role="cell" className="pcl__clip">
        {customer}
      </span>
      <span role="cell" className="pcl__clip faint">
        {products || '—'}
      </span>
      <span role="cell" className="num">
        {view.totalCents > 0 ? fmt.money(view.totalCents) : '—'}
      </span>
      <span role="cell">
        <BadgePills badges={view.badges} reserved={!!view.hold} compact />
      </span>
    </div>
  );
}

export function StationCompact({ items }: { items: Item[] }) {
  return (
    <div className="pcc">
      {items.map((item) => (
        <StationChip key={item.station.id} {...item} />
      ))}
    </div>
  );
}

function StationChip({ station, fetchedAt, selected, handlers }: Item) {
  const { t } = useI18n();
  const fmt = useFormat();
  const view = useItemView(station, fetchedAt);
  const events = usePcEvents(handlers);
  const stateLabel = t(`board.state.${view.state}`);
  const text = view.timerSeconds !== null || view.hold ? timerText(view, t, fmt.timeZone) : stateLabel;
  return (
    <div
      className="pcc__chip"
      data-pc
      data-id={station.id}
      data-state={view.state}
      data-selected={selected || undefined}
      data-archived={station.archived ? 'true' : undefined}
      aria-selected={selected}
      title={`${station.code} — ${stateLabel}`}
      {...events}
    >
      <PcCheck checked={selected} label={t('board.checkOne', { code: station.code })} handlers={handlers} />
      <span className="pcc__dot" data-status={view.state} aria-hidden />
      <span className="pcc__code">{station.code}</span>
      <span className="pcc__text num">{text}</span>
      {view.totalCents > 0 && <span className="pcc__money num">{fmt.money(view.totalCents)}</span>}
    </div>
  );
}

export function StationDetailed({ items }: { items: Item[] }) {
  return (
    <div className="pcd">
      {items.map((item) => (
        <StationCard key={item.station.id} {...item} />
      ))}
    </div>
  );
}

function StationCard({ station, fetchedAt, selected, handlers }: Item) {
  const { t } = useI18n();
  const fmt = useFormat();
  const view = useItemView(station, fetchedAt);
  const events = usePcEvents(handlers);
  const customer = view.customerName ?? view.hold?.customerName ?? view.debtCustomerName ?? '—';
  const shown = view.products.slice(0, 3);
  const more = view.products.length - shown.length;
  return (
    <article
      className="pcd__card"
      data-pc
      data-id={station.id}
      data-state={view.state}
      data-selected={selected || undefined}
      data-archived={station.archived ? 'true' : undefined}
      aria-selected={selected}
      {...events}
    >
      <header className="pcd__head">
        <PcCheck checked={selected} label={t('board.checkOne', { code: station.code })} handlers={handlers} />
        <div className="pcd__title">
          <strong>{station.code}</strong>
          {pcNameShown(station, view) && <span className="faint">{pcNameShown(station, view)}</span>}
        </div>
        <StateTag state={view.state} />
      </header>
      <div className="pcd__timer num">{timerText(view, t, fmt.timeZone)}</div>
      <dl className="pcd__rows">
        <div>
          <dt>{t('board.customer')}</dt>
          <dd>{customer}</dd>
        </div>
        {view.startedAt && (
          <div>
            <dt>{t('board.startedLabel')}</dt>
            <dd className="num">{clockLabel(view.startedAt, fmt.timeZone)}</dd>
          </div>
        )}
      </dl>
      <ul className="pcd__products">
        {shown.length === 0 && <li className="faint">{t('board.noProducts')}</li>}
        {shown.map((p) => (
          <li key={p.name}>
            <span>{p.name}</span>
          </li>
        ))}
        {more > 0 && <li className="faint">+{more}</li>}
      </ul>
      <footer className="pcd__foot">
        <BadgePills badges={view.badges} reserved={!!view.hold} compact />
        <strong className="num">{fmt.money(view.totalCents)}</strong>
      </footer>
    </article>
  );
}
