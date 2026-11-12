/**
 * 0.33.0 — the action bar of the stations page. Only the actions that apply to the current
 * selection are shown (no "Stop (0)" buttons): the first four inline, the rest in "More".
 */
import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Kbd } from '../ui/primitives';
import type { StationAction, StationActionId } from './useStationActions';

const INLINE = 4;

export function ActionsBar({
  actions,
  primary,
  busy,
  onRun,
}: {
  /** Enabled bar actions for the current selection, in their order. */
  actions: StationAction[];
  primary: StationActionId | null;
  busy: boolean;
  onRun: (id: StationActionId) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const inline = actions.slice(0, INLINE);
  const rest = actions.slice(INLINE);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <div className="map-actions__buttons" ref={wrap}>
      {inline.map((a) => (
        <button
          key={a.id}
          type="button"
          className="map-action"
          data-action={a.id}
          data-tone={a.tone}
          data-pressed={a.pressed ? 'true' : undefined}
          aria-pressed={a.pressed === undefined ? undefined : a.pressed}
          disabled={busy}
          title={a.pressed ? `${a.label} — ${t('map.endTasksPressed')}` : a.label}
          onClick={() => onRun(a.id)}
        >
          <a.icon size={18} />
          <span>{a.label}</span>
          {a.shortcut && primary === a.id && <Kbd>{a.shortcut}</Kbd>}
        </button>
      ))}
      {rest.length > 0 && (
        <div className="map-more">
          <button
            type="button"
            className="map-action"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <MoreHorizontal size={18} />
            <span>{t('board.more')}</span>
          </button>
          {open && (
            <div className="map-more__menu" role="menu">
              {rest.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  role="menuitem"
                  className="map-more__item"
                  data-action={a.id}
                  data-tone={a.tone}
                  disabled={busy}
                  onClick={() => {
                    setOpen(false);
                    onRun(a.id);
                  }}
                >
                  <a.icon size={16} />
                  <span>{a.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
