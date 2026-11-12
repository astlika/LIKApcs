/**
 * 0.32.0 — the parts every stations view shares: the PC icon, the state tag, the badges, and the
 * pointer / keyboard behaviour of a PC (click, Ctrl/Shift selection, double-click, right-click,
 * hover after a short pause). The views (grid, list, compact, detailed) only lay these out.
 */
import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  CircleDollarSign,
  Hourglass,
  Lock,
  Pause,
  Play,
  Power,
  Receipt,
  RefreshCw,
  Wrench,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { StationBadge } from '@likapcs/shared';
import { useI18n } from '../../i18n';
import type { BoardState } from '../../lib/station-board';

/** Modifier keys held while clicking a PC (Ctrl/Cmd toggles, Shift selects a range). */
export interface SelectModifiers {
  toggle: boolean;
  range: boolean;
  /** Right-click: keep an existing multi-selection the PC is part of. */
  keep?: boolean;
}

export const modifiersOf = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => ({
  toggle: e.ctrlKey || e.metaKey,
  range: e.shiftKey,
});

export const STATE_ICON: Record<BoardState, LucideIcon> = {
  active: Play,
  paused: Pause,
  expiring: Hourglass,
  awaiting: Receipt,
  debt: CircleDollarSign,
  reserved: CalendarClock,
  offline: WifiOff,
  free: Power,
  disabled: Ban,
  maintenance: Wrench,
  locked: Lock,
  updating: RefreshCw,
  error: AlertTriangle,
};

export const BADGE_KEYS: StationBadge[] = ['vip', 'tournament', 'premium', 'birthday'];

/** The PC icon: the screen takes the state's colour; a glyph marks the states that need a look. */
export function PcIcon({
  status,
  number,
  size,
}: {
  status: BoardState;
  number: number;
  size: number;
}) {
  const fontSize = number >= 100 ? 15 : 19;
  const glyphStates: BoardState[] = [
    'paused',
    'offline',
    'disabled',
    'locked',
    'maintenance',
    'debt',
    'awaiting',
    'reserved',
    'updating',
    'error',
  ];
  const lowered = glyphStates.includes(status);
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
      ) : status === 'debt' ? (
        <g className="pc-icon__glyph" transform="translate(32 22)">
          <text x="0" y="6" textAnchor="middle" fontSize="16" fontWeight="800">
            €
          </text>
        </g>
      ) : status === 'reserved' ? (
        <g className="pc-icon__glyph" transform="translate(32 22)">
          <circle r="7.5" fill="none" strokeWidth="2.2" />
          <path d="M0 -4 V0 L3 2" fill="none" strokeWidth="2" strokeLinecap="round" />
        </g>
      ) : null}
      <text
        className="pc-icon__number"
        x="32"
        y={lowered ? 37 : 28}
        textAnchor="middle"
        fontSize={lowered ? 9 : fontSize}
        fontWeight={700}
      >
        {String(number).padStart(2, '0')}
      </text>
      <rect className="pc-icon__frame" x="27" y="43" width="10" height="6" />
      <rect className="pc-icon__frame" x="18" y="49" width="28" height="4" rx="2" />
      {status === 'active' || status === 'expiring' ? (
        <circle className="pc-icon__led" cx="32" cy="41" r="1.2" />
      ) : null}
    </svg>
  );
}

/** The state as a small tag: icon and label. */
export function StateTag({ state, label }: { state: BoardState; label?: string }) {
  const { t } = useI18n();
  const Icon = STATE_ICON[state];
  return (
    <span className="pc-state" data-state={state}>
      <Icon size={12} aria-hidden />
      {label ?? t(`board.state.${state}`)}
    </span>
  );
}

/** The manual badges (V.I.P, tournament, premium, birthday) and, when a reservation holds the PC, "Reserved". */
export function BadgePills({
  badges,
  reserved,
  compact = false,
}: {
  badges: readonly StationBadge[];
  reserved?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  if (badges.length === 0 && !reserved) return null;
  return (
    <span className="pc-badges" data-compact={compact || undefined}>
      {reserved && (
        <span className="pc-badge pc-badge--reserved">{t('board.badges.reserved')}</span>
      )}
      {badges.map((b) => (
        <span key={b} className={`pc-badge pc-badge--${b}`}>
          {t(`board.badges.${b}`)}
        </span>
      ))}
    </span>
  );
}

export interface TileHandlers {
  onSelect: (mods: SelectModifiers) => void;
  onPrimary: () => void;
  onMenu: (x: number, y: number) => void;
  /** Mouse rests on the PC (after a short delay): its rectangle; null when it leaves. */
  onHover?: (rect: DOMRect | null) => void;
}

/** Event props of one PC, whatever view it is drawn in. */
export function usePcEvents(handlers: TileHandlers) {
  const hoverTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: (e: MouseEvent<HTMLElement>) => handlers.onSelect(modifiersOf(e)),
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      if (!handlers.onHover) return;
      const el = e.currentTarget;
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = window.setTimeout(() => handlers.onHover?.(el.getBoundingClientRect()), 300);
    },
    onMouseLeave: () => {
      window.clearTimeout(hoverTimer.current);
      handlers.onHover?.(null);
    },
    onDoubleClick: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      handlers.onPrimary();
    },
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      // Right-click keeps a multi-selection the PC belongs to (the page decides).
      handlers.onSelect({ toggle: false, range: false, keep: true });
      handlers.onMenu(e.clientX, e.clientY);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handlers.onPrimary();
      } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        handlers.onMenu(r.left + r.width / 2, r.top + r.height / 2);
      }
    },
  };
}
