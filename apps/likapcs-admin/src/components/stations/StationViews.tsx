/**
 * 0.32.0 — the three views besides the grid: List (one row per PC), Compact (as many PCs as fit)
 * and Detailed (a full card per PC with everything the desk needs at a glance).
 */
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useNow } from '../sessions/SessionPanel';
import { formatHms } from '../../lib/session-time';
import {
  clockLabel,
  countdownLabel,
  describeStation,
  type StationView,
} from '../../lib/station-board';
import { BadgePills, PcIcon, StateTag, usePcEvents } from './StationBits';
import type { PcItemProps } from './StationMap';
import type { StationSummary } from '@likapcs/shared';

type Item = PcItemProps;

/** The timer as the desk reads it: what is left, what has run, or the reservation's time. */
type Translate = ReturnType<typeof useI18n>['t'];

function timerText(view: StationView, t: Translate, tz?: string): string {
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

export function StationList({ items }: { items: Item[] }) {
  const { t } = useI18n();
  return (
    <div className="pc-list" role="table" aria-label={t('board.views.list')}>
      <div className="pc-list__head" role="row">
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
      className="pc-list__row"
      data-id={station.id}
      data-state={view.state}
      data-selected={selected || undefined}
      data-archived={station.archived ? 'true' : undefined}
      {...events}
    >
      <span className="pc-list__pc" role="cell">
        <span className="pc-list__dot" data-status={view.state} aria-hidden />
        <strong>{station.code}</strong>
        {station.name !== station.code && <span className="faint"> {station.name}</span>}
      </span>
      <span role="cell">
        <StateTag state={view.state} />
      </span>
      <span role="cell" className="num">
        {timerText(view, t, fmt.timeZone)}
      </span>
      <span role="cell" className="pc-list__clip">
        {customer}
      </span>
      <span role="cell" className="pc-list__clip faint">
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
    <div className="pc-compact">
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
  return (
    <div
      className="pc-chip"
      data-id={station.id}
      data-state={view.state}
      data-selected={selected || undefined}
      aria-label={`${station.code} — ${t(`board.state.${view.state}`)}`}
      {...events}
    >
      <span className="pc-chip__dot" data-status={view.state} aria-hidden />
      <span className="pc-chip__code">{station.code}</span>
      <span className="pc-chip__time num">{timerText(view, t, fmt.timeZone)}</span>
      {view.totalCents > 0 && <span className="pc-chip__money num">{fmt.money(view.totalCents)}</span>}
      {view.badges.length > 0 && <span className="pc-chip__star" aria-hidden>★</span>}
    </div>
  );
}

export function StationDetailed({ items }: { items: Item[] }) {
  return (
    <div className="pc-detailed">
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
  return (
    <article
      className="pc-card"
      data-id={station.id}
      data-state={view.state}
      data-selected={selected || undefined}
      data-archived={station.archived ? 'true' : undefined}
      aria-label={`${station.code} — ${t(`board.state.${view.state}`)}`}
      {...events}
    >
      <header className="pc-card__head">
        <PcIcon status={view.state} number={station.number} size={44} />
        <div className="pc-card__title">
          <strong>{station.code}</strong>
          {station.name !== station.code && <span className="faint">{station.name}</span>}
        </div>
        <StateTag state={view.state} />
      </header>
      <BadgePills badges={view.badges} reserved={!!view.hold} />
      <dl className="pc-card__rows">
        <div>
          <dt>{view.timerKind === 'elapsed' ? t('board.timerElapsed') : t('board.timerLeft')}</dt>
          <dd className="num pc-card__timer">{timerText(view, t, fmt.timeZone)}</dd>
        </div>
        {view.customerName && (
          <div>
            <dt>{t('board.customer')}</dt>
            <dd>{view.customerName}</dd>
          </div>
        )}
        {view.startedAt && (
          <div>
            <dt>{t('board.startedLabel')}</dt>
            <dd className="num">{clockLabel(view.startedAt, fmt.timeZone)}</dd>
          </div>
        )}
        {view.products.length > 0 && (
          <div className="pc-card__products">
            <dt>{t('board.products')}</dt>
            <dd>
              {view.products.slice(0, 4).map((p) => (
                <span key={p.name} className="pc-card__product">
                  {p.name} <span className="num">{fmt.money(p.amountCents)}</span>
                </span>
              ))}
              {view.products.length > 4 && <span className="faint"> +{view.products.length - 4}</span>}
            </dd>
          </div>
        )}
        {view.hold && (
          <div>
            <dt>{t('board.holdLabel')}</dt>
            <dd>
              {view.hold.customerName} · {timerText(view, t, fmt.timeZone)}
            </dd>
          </div>
        )}
        {view.debtCents > 0 && (
          <div>
            <dt>{t('board.state.debt')}</dt>
            <dd className="num">
              {fmt.money(view.debtCents)}
              {view.debtCustomerName ? ` · ${view.debtCustomerName}` : ''}
            </dd>
          </div>
        )}
        {view.awaitingCount > 0 && (
          <div>
            <dt>{t('board.state.awaiting')}</dt>
            <dd className="num">{fmt.money(view.awaitingCents)}</dd>
          </div>
        )}
      </dl>
      <footer className="pc-card__foot">
        <span>{t('board.total')}</span>
        <strong className="num">{fmt.money(view.totalCents)}</strong>
      </footer>
    </article>
  );
}
