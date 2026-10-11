/**
 * PanCafe-style floor map: every station is a PC icon whose screen colour is its live state, with
 * the station number on the screen and the running timer / amount underneath. One click selects,
 * Ctrl+click adds/removes, Shift+click selects a range, double-click (or Enter) runs the primary
 * action, right-click opens the action menu. Rubber-band selection lives in the page (it needs
 * the scrolling canvas).
 */
import { useMemo } from 'react';
import type { StationStatus, StationSummary } from '@likapcs/shared';
import { formatHms, projectSession } from '../../lib/session-time';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useNow } from '../sessions/SessionPanel';
import { mapOrder } from '../../lib/map-selection';

export type MapStatus = StationStatus | 'expiring';

/** Modifier keys held while clicking a tile (Ctrl/Cmd toggles, Shift selects a range). */
export interface SelectModifiers {
  toggle: boolean;
  range: boolean;
  /** Right-click: keep an existing multi-selection the tile is part of. */
  keep?: boolean;
}

export const modifiersOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => ({
  toggle: e.ctrlKey || e.metaKey,
  range: e.shiftKey,
});

/** Resolve the colour-state shown on the icon (adds "expiring" for prepaid sessions < 5 min). */
export function mapStatus(station: StationSummary, remaining: number | null): MapStatus {
  if (!station.isEnabled) return 'disabled';
  if (station.activeSession && station.activeSession.status === 'paused') return 'paused';
  if (station.activeSession && remaining !== null && remaining <= 300) return 'expiring';
  return station.status;
}

export function PcIcon({
  status,
  number,
  size,
}: {
  status: MapStatus;
  number: number;
  size: number;
}) {
  const fontSize = number >= 100 ? 15 : 19;
  return (
    <svg
      className="pc-icon"
      data-status={status}
      width={size}
      height={size * 0.88}
      viewBox="0 0 64 56"
      aria-hidden
    >
      <rect className="pc-icon__screen" x="2" y="2" width="60" height="40" rx="5" />
      <rect className="pc-icon__glass" x="5" y="5" width="54" height="34" rx="3" />
      {status === 'offline' || status === 'disabled' ? (
        <g className="pc-icon__glyph" transform="translate(32 22)">
          <path d="M-9 -5 L9 5 M-9 5 L9 -5" strokeWidth="2.5" strokeLinecap="round" />
        </g>
      ) : status === 'paused' ? (
        <g className="pc-icon__glyph" transform="translate(32 22)">
          <rect x="-7" y="-7" width="5" height="14" rx="1" />
          <rect x="2" y="-7" width="5" height="14" rx="1" />
        </g>
      ) : status === 'locked' ? (
        <g className="pc-icon__glyph" transform="translate(32 22)">
          <rect x="-7" y="-2" width="14" height="10" rx="2" />
          <path d="M-4 -2 V-5 a4 4 0 0 1 8 0 V-2" fill="none" strokeWidth="2.2" />
        </g>
      ) : status === 'maintenance' ? (
        <g className="pc-icon__glyph" transform="translate(32 22)">
          <path
            d="M-7 7 L1 -1 M1 -1 a4 4 0 1 0 4 -4 l-2 2 -2 -2 2 -2 a4 4 0 0 0 -4 4 z"
            fill="none"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      ) : null}
      <text
        className="pc-icon__number"
        x="32"
        y={
          status === 'paused' ||
          status === 'offline' ||
          status === 'disabled' ||
          status === 'locked' ||
          status === 'maintenance'
            ? 37
            : 28
        }
        textAnchor="middle"
        fontSize={
          status === 'paused' ||
          status === 'offline' ||
          status === 'disabled' ||
          status === 'locked' ||
          status === 'maintenance'
            ? 9
            : fontSize
        }
        fontWeight={700}
      >
        {String(number).padStart(2, '0')}
      </text>
      <rect className="pc-icon__frame" x="27" y="43" width="10" height="6" />
      <rect className="pc-icon__frame" x="18" y="49" width="28" height="4" rx="2" />
      {status === 'occupied' || status === 'expiring' ? (
        <circle className="pc-icon__led" cx="32" cy="41" r="1.2" />
      ) : null}
    </svg>
  );
}

export function StationTile({
  station,
  fetchedAt,
  selected,
  size,
  onSelect,
  onPrimary,
  onMenu,
}: {
  station: StationSummary;
  fetchedAt: number;
  selected: boolean;
  size: number;
  onSelect: (mods: SelectModifiers) => void;
  onPrimary: () => void;
  onMenu: (x: number, y: number) => void;
}) {
  const { t, td } = useI18n();
  const fmt = useFormat();
  const now = useNow();
  const live = station.activeSession;
  const projected = live
    ? projectSession(
        {
          status: live.status,
          billableSeconds: live.elapsedSeconds,
          endsAt: live.endsAt,
          pausedAt: live.pausedAt,
        },
        fetchedAt,
        now,
      )
    : null;
  const status = mapStatus(station, projected?.remaining ?? null);
  const plannedSeconds =
    live?.endsAt && live.startedAt
      ? Math.max(1, (new Date(live.endsAt).getTime() - new Date(live.startedAt).getTime()) / 1000)
      : null;
  const fraction =
    projected && projected.remaining !== null && plannedSeconds
      ? Math.min(1, Math.max(0, projected.remaining / plannedSeconds))
      : null;
  const compact = size < 88;
  return (
    <div
      className="pc-tile"
      data-id={station.id}
      data-status={status}
      data-selected={selected || undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${station.code} — ${td(`stations.status.${station.isEnabled ? station.status : 'disabled'}`, station.status)}`}
      style={{ width: size + 24 }}
      onClick={(e) => onSelect(modifiersOf(e))}
      onDoubleClick={(e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        onPrimary();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // Right-click keeps a multi-selection the tile belongs to (the page decides).
        onSelect({ toggle: false, range: false, keep: true });
        onMenu(e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onPrimary();
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left + r.width / 2, r.top + r.height / 2);
        }
      }}
    >
      <PcIcon status={status} number={station.number} size={size} />
      <div className="pc-tile__code">{station.code}</div>
      {!compact && station.name !== station.code && (
        <div className="pc-tile__name">{station.name}</div>
      )}
      {live && projected ? (
        <>
          <div className="pc-tile__timer num" data-warn={status === 'expiring' || undefined}>
            {projected.remaining !== null
              ? formatHms(projected.remaining)
              : formatHms(projected.elapsed)}
          </div>
          {!compact && (
            <div className="pc-tile__meta">
              <span className="num">{fmt.money(live.currentPriceCents)}</span>
              {live.customerName && <span className="pc-tile__customer">{live.customerName}</span>}
            </div>
          )}
          {fraction !== null && (
            <div className="pc-tile__bar" aria-hidden>
              <span style={{ width: `${fraction * 100}%` }} />
            </div>
          )}
        </>
      ) : (
        <div className="pc-tile__state">
          {td(`stations.status.${station.isEnabled ? station.status : 'disabled'}`, station.status)}
          {station.isEnabled && station.status === 'available' && !station.device && !compact && (
            <span className="faint"> · {t('stations.noDevice')}</span>
          )}
          {station.status === 'maintenance' && station.maintenance && !compact && (
            <span className="faint">
              {' '}
              · {station.maintenance.byName ?? '—'} ·{' '}
              {formatHms(
                Math.max(
                  0,
                  Math.round((new Date(station.maintenance.until).getTime() - Date.now()) / 1000),
                ),
              )}
            </span>
          )}
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
  onSelect,
  onPrimary,
  onMenu,
}: {
  stations: StationSummary[];
  fetchedAt: number;
  selectedIds: ReadonlySet<string>;
  size: number;
  groupByZone: boolean;
  onSelect: (id: string, mods: SelectModifiers) => void;
  onPrimary: (id: string) => void;
  onMenu: (id: string, x: number, y: number) => void;
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

  return (
    <div className="pc-map">
      {groups.map((g) => (
        <section key={g.zone ?? '__none'} className="pc-map__zone">
          {groupByZone && groups.length > 1 && (
            <h3 className="pc-map__zone-title">{g.zone ?? t('stations.zoneNone')}</h3>
          )}
          <div className="pc-map__grid">
            {g.items.map((s) => (
              <StationTile
                key={s.id}
                station={s}
                fetchedAt={fetchedAt}
                selected={selectedIds.has(s.id)}
                size={size}
                onSelect={(mods) => onSelect(s.id, mods)}
                onPrimary={() => onPrimary(s.id)}
                onMenu={(x, y) => onMenu(s.id, x, y)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
