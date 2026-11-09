/**
 * The stations floor. Four views of the same PCs (0.32.0): Grid (the PC icons, each a card with its
 * state, timer and bill line), List (one row per PC), Compact (as many PCs as fit) and Detailed
 * (a full card per PC). One click selects, Ctrl+click adds/removes, Shift+click selects a range,
 * double-click (or Enter) runs the primary action, right-click opens the action menu. Rubber-band
 * selection lives in the page (it needs the scrolling canvas).
 */
import { useMemo } from 'react';
import { Bell, Hourglass } from 'lucide-react';
import type { StationSummary } from '@likapcs/shared';
import { formatHms } from '../../lib/session-time';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useNow } from '../sessions/SessionPanel';
import { mapOrder } from '../../lib/map-selection';
import {
  countdownLabel,
  describeStation,
  shortLineParts,
  type BoardView,
} from '../../lib/station-board';
import {
  BadgePills,
  PcIcon,
  StateTag,
  usePcEvents,
  type SelectModifiers,
  type TileHandlers,
} from './StationBits';
import { StationCompact, StationDetailed, StationList } from './StationViews';

export { modifiersOf, PcIcon, type SelectModifiers } from './StationBits';

export interface PcItemProps {
  station: StationSummary;
  fetchedAt: number;
  selected: boolean;
  handlers: TileHandlers;
}

/** The grid card: the PC icon, its code and name, the state line, badges and the reservation countdown. */
export function StationTile({
  station,
  fetchedAt,
  selected,
  size,
  handlers,
}: PcItemProps & { size: number }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const now = useNow();
  const view = describeStation(station, fetchedAt, now);
  const events = usePcEvents(handlers);
  const compact = size < 88;
  const tz = fmt.timeZone;
  const line = shortLineParts(
    view,
    {
      state: t(`board.state.${view.state}`),
      hold: t('board.holdLabel'),
      debt: t('board.state.debt'),
      awaiting: t('board.state.awaiting'),
    },
    fmt.money,
    tz,
  );
  const stateLabel = t(`board.state.${view.state}`);
  return (
    <div
      className={compact ? 'pc-tile pc-tile--line' : 'pc-tile pc-card-grid'}
      data-id={station.id}
      data-status={view.state}
      data-state={view.state}
      data-archived={station.archived ? 'true' : undefined}
      data-selected={selected || undefined}
      aria-pressed={selected}
      aria-label={`${station.code} — ${stateLabel}`}
      style={compact ? undefined : { width: size + 24 }}
      {...events}
    >
      {!compact && (
        <>
          <PcIcon status={view.state} number={station.number} size={size} />
          {station.pendingRequest && (
            <span
              className="pc-tile__request"
              title={`${station.pendingRequest.customerName} · ${station.pendingRequest.durationMinutes} min`}
              data-testid="tile-request"
            >
              <Bell size={10} />
              {t('requests.tile')}
            </span>
          )}
          {view.awaitingCount > 0 && (
            <span
              className="pc-tile__awaiting"
              title={`${t('sessions.awaiting.title')} · ${fmt.money(view.awaitingCents)}`}
              data-testid="tile-awaiting"
            >
              <Hourglass size={10} />
              {fmt.money(view.awaitingCents)}
            </span>
          )}
          <div className="pc-tile__code">{station.code}</div>
          {station.name !== station.code && <div className="pc-tile__name">{station.name}</div>}
          <div className="pc-tile__line" data-state={view.state}>
            {line.join(' • ')}
          </div>
          <BadgePills badges={view.badges} reserved={!!view.hold} compact />
          {view.hold?.phase === 'window' && view.hold.windowSeconds !== null && (
            <div className="pc-tile__deadline" data-testid="tile-deadline">
              <Hourglass size={11} aria-hidden /> {t('board.deadline', { time: countdownLabel(view.hold.windowSeconds) })}
            </div>
          )}
          {view.fraction !== null && (
            <div className="pc-tile__bar" aria-hidden>
              <span style={{ width: `${view.fraction * 100}%` }} />
            </div>
          )}
        </>
      )}
      {compact && (
        <>
          {/* At small icon sizes the PC is one line: dot, code, timer or state. */}
          <span className="pc-tile__pip" data-status={view.state} aria-hidden />
          <span className="pc-tile__code">{station.code}</span>
          <span className="pc-tile__line-state num" data-warn={view.state === 'expiring' || undefined}>
            {view.timerSeconds !== null
              ? formatHms(view.timerSeconds)
              : view.hold
                ? t('board.holdLabel')
                : stateLabel}
          </span>
          {station.pendingRequest && (
            <Bell size={10} aria-label={t('requests.tile')} data-testid="tile-request" />
          )}
          {view.awaitingCount > 0 && (
            <Hourglass size={10} aria-label={t('sessions.awaiting.title')} data-testid="tile-awaiting" />
          )}
        </>
      )}
    </div>
  );
}

export function StationMap({
  stations,
  fetchedAt,
  selectedIds,
  size,
  groupByZone,
  view,
  onSelect,
  onPrimary,
  onMenu,
  onHover,
}: {
  stations: StationSummary[];
  fetchedAt: number;
  selectedIds: ReadonlySet<string>;
  size: number;
  groupByZone: boolean;
  view: BoardView;
  onSelect: (id: string, mods: SelectModifiers) => void;
  onPrimary: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
  onHover?: (id: string, rect: DOMRect | null) => void;
}) {
  const { t } = useI18n();
  const groups = useMemo(
    () =>
      mapOrder(stations, groupByZone).map((items) => ({
        zone: groupByZone ? (items[0]?.zone?.trim() ?? null) || null : null,
        items,
      })),
    [stations, groupByZone],
  );

  const handlersFor = (id: string): TileHandlers => ({
    onSelect: (mods) => onSelect(id, mods),
    onPrimary: () => onPrimary(id),
    onMenu: (x, y) => onMenu(id, x, y),
    onHover: onHover ? (rect) => onHover(id, rect) : undefined,
  });

  return (
    <div className="pc-map" data-view={view}>
      {groups.map((g) => {
        const items = g.items.map((s) => ({
          station: s,
          fetchedAt,
          selected: selectedIds.has(s.id),
          handlers: handlersFor(s.id),
        }));
        return (
          <section key={g.zone ?? '__none'} className="pc-map__zone">
            {groupByZone && groups.length > 1 && (
              <h3 className="pc-map__zone-title">{g.zone ?? t('stations.zoneNone')}</h3>
            )}
            {view === 'grid' && (
              <div className="pc-map__grid">
                {items.map((item) => (
                  <StationTile key={item.station.id} {...item} size={size} />
                ))}
              </div>
            )}
            {view === 'list' && <StationList items={items} />}
            {view === 'compact' && <StationCompact items={items} />}
            {view === 'detailed' && <StationDetailed items={items} />}
          </section>
        );
      })}
    </div>
  );
}
