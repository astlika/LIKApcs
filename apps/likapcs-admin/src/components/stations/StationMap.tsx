/**
 * The stations floor (0.33.0). Four views of the same PCs: Grid (a card per PC: code, state, the
 * timer in large figures, the bill line and the badges), List, Compact and Detailed (see
 * StationViews). Selection is the same everywhere: click, Ctrl+click (add/remove), Shift+click
 * (range), a checkbox per PC, a checkbox for the whole group, and a click on a zone title selects
 * the zone. Double-click or Enter runs the primary action, right-click opens the action menu.
 * Rubber-band selection lives in the page (it needs the scrolling canvas).
 */
import { useMemo } from 'react';
import { Bell, Hourglass } from 'lucide-react';
import type { StationSummary } from '@likapcs/shared';
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
  StateTag,
  modifiersOf,
  usePcEvents,
  type SelectModifiers,
  type TileHandlers,
} from './StationBits';
import { PcCheck, StationCompact, StationDetailed, StationList, timerText } from './StationViews';

export { modifiersOf, type SelectModifiers } from './StationBits';

export interface PcItemProps {
  station: StationSummary;
  fetchedAt: number;
  selected: boolean;
  handlers: TileHandlers;
}

/** Below this icon size the grid card becomes one line (the slider can make the PCs very small). */
const LINE_BELOW = 88;

/** The grid card: the PC code and name, the state, the timer in large figures, the bill line and badges. */
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
  const tz = fmt.timeZone;
  const stateLabel = t(`board.state.${view.state}`);
  const width = Math.round(Math.min(240, Math.max(150, size * 1.6)));

  if (size < LINE_BELOW) {
    const text = view.timerSeconds !== null || view.hold ? timerText(view, t, tz) : stateLabel;
    return (
      <div
        className="pcg pcg--line"
        data-pc
        data-id={station.id}
        data-state={view.state}
        data-selected={selected || undefined}
        aria-selected={selected}
        aria-label={`${station.code} — ${stateLabel}`}
        {...events}
      >
        <span className="pcg__pip" data-status={view.state} aria-hidden />
        <span className="pcg__code">{station.code}</span>
        <span className="pcg__line-text num">{text}</span>
      </div>
    );
  }

  const line = shortLineParts(
    view,
    {
      state: stateLabel,
      hold: t('board.holdLabel'),
      debt: t('board.state.debt'),
      awaiting: t('board.state.awaiting'),
    },
    fmt.money,
    tz,
  );
  // The state tag already says Offline / Free: the timer and the line only repeat it, so they show
  // only when there is a time or a bill to show.
  const hasTime = view.timerSeconds !== null || !!view.hold;
  const timer = hasTime ? timerText(view, t, tz) : null;
  const lineText = line.join(' • ');
  const hasFoot = view.badges.length > 0 || !!station.pendingRequest || view.awaitingCount > 0;

  return (
    <div
      className="pcg"
      data-pc
      data-id={station.id}
      data-state={view.state}
      data-selected={selected || undefined}
      data-archived={station.archived ? 'true' : undefined}
      aria-selected={selected}
      aria-label={`${station.code} — ${stateLabel}`}
      style={{ width }}
      {...events}
    >
      <div className="pcg__head">
        <div className="pcg__title">
          <span className="pcg__code">{station.code}</span>
          {station.name !== station.code && <span className="pcg__name">{station.name}</span>}
        </div>
        <PcCheck checked={selected} label={t('board.checkOne', { code: station.code })} handlers={handlers} />
      </div>
      <StateTag state={view.state} />
      {timer && (
        <div className="pcg__timer num" data-kind={view.timerSeconds !== null ? 'timer' : undefined}>
          {timer}
        </div>
      )}
      {lineText && lineText !== stateLabel && <div className="pcg__line">{lineText}</div>}
      {hasFoot && (
        <div className="pcg__foot">
          <BadgePills badges={view.badges} reserved={!!view.hold} compact />
          {station.pendingRequest && (
            <span className="pcg__flag" data-testid="tile-request" title={station.pendingRequest.customerName}>
              <Bell size={11} />
              {t('requests.tile')}
            </span>
          )}
          {view.awaitingCount > 0 && (
            <span className="pcg__flag" data-kind="awaiting" data-testid="tile-awaiting">
              <Hourglass size={11} />
              {fmt.money(view.awaitingCents)}
            </span>
          )}
        </div>
      )}
      {view.hold?.phase === 'window' && view.hold.windowSeconds !== null && (
        <div className="pcg__deadline" data-testid="tile-deadline">
          {t('board.deadline', { time: countdownLabel(view.hold.windowSeconds) })}
        </div>
      )}
      {view.fraction !== null && (
        <div className="pcg__bar" aria-hidden>
          <span style={{ width: `${view.fraction * 100}%` }} />
        </div>
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
  onSelectGroup,
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
  /** Selects (or, with Ctrl / the group checkbox, adds or removes) a whole list of PCs. */
  onSelectGroup: (ids: string[], mods: SelectModifiers) => void;
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
        const ids = g.items.map((s) => s.id);
        const picked = ids.filter((id) => selectedIds.has(id)).length;
        const allPicked = ids.length > 0 && picked === ids.length;
        const toggleGroup = (mods: SelectModifiers) => {
          // The group checkbox: all selected -> clear this group; otherwise add the rest of it.
          onSelectGroup(ids, { ...mods, toggle: true, range: false, keep: false });
        };
        const items = g.items.map((s) => ({
          station: s,
          fetchedAt,
          selected: selectedIds.has(s.id),
          handlers: handlersFor(s.id),
        }));
        return (
          <section key={g.zone ?? '__none'} className="pc-map__zone">
            {groupByZone && groups.length > 1 && (
              <header className="pc-map__zone-head">
                <button
                  type="button"
                  className="pc-map__zone-title"
                  title={t('board.zoneSelect')}
                  onClick={(e) => onSelectGroup(ids, modifiersOf(e))}
                >
                  <span>{g.zone ?? t('stations.zoneNone')}</span>
                  <span className="pc-map__zone-count num" data-on={picked > 0 || undefined}>
                    {picked > 0 ? `${picked}/${ids.length}` : ids.length}
                  </span>
                </button>
              </header>
            )}
            {view === 'grid' && (
              <div className="pc-map__grid">
                {items.map((item) => (
                  <StationTile key={item.station.id} {...item} size={size} />
                ))}
              </div>
            )}
            {view === 'list' && (
              <StationList
                items={items}
                allSelected={allPicked}
                someSelected={picked > 0}
                onToggleAll={toggleGroup}
              />
            )}
            {view === 'compact' && <StationCompact items={items} />}
            {view === 'detailed' && <StationDetailed items={items} />}
          </section>
        );
      })}
    </div>
  );
}
