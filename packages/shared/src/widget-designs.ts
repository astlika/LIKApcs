/**
 * Countdown widget designs (LIKApcs-Client, 0.13.0).
 *
 * One table drives all three apps: the client renders the chosen look and sizes its native window
 * from the footprint, Admin → Settings → Client screen shows the gallery, and the server only
 * validates the id (`client.widget_style`). Footprints are logical pixels — the window follows the
 * monitor scale factor.
 */
import type { ClientWidgetSize, ClientWidgetStyle } from './settings.js';

export interface WidgetFootprint {
  width: number;
  height: number;
}

export interface WidgetDesignSpec {
  id: ClientWidgetStyle;
  /**
   * The window itself is see-through: the design draws its own shape (capsule, ring, dot, …) and
   * the desktop shows around it. Opaque designs fill the whole window.
   */
  transparent: boolean;
  /** How the paid / owed amount is shown — `none` designs never show money ("minutes only"). */
  money: 'full' | 'compact' | 'none';
  /** Shows the station code (PC 01) somewhere in the widget. */
  station: boolean;
  /** Draws a progress indication of the prepaid time (bar, ring, strip). */
  progress: boolean;
  /**
   * Room for words. `card` designs show a staff notice, maintenance and the order flash inline;
   * `line` designs show the order flash in their text slot but hand over to the classic card for a
   * notice / maintenance; `none` designs hand over for all three (see the client's `Overlay`).
   */
  text: 'card' | 'line' | 'none';
  /** Window size per owner-chosen footprint (small / normal / large). */
  footprint: Record<ClientWidgetSize, WidgetFootprint>;
}

const fp = (
  small: [number, number],
  normal: [number, number],
  large: [number, number],
): Record<ClientWidgetSize, WidgetFootprint> => ({
  small: { width: small[0], height: small[1] },
  normal: { width: normal[0], height: normal[1] },
  large: { width: large[0], height: large[1] },
});

export const WIDGET_DESIGNS: readonly WidgetDesignSpec[] = [
  {
    id: 'detailed',
    text: 'card',
    transparent: false,
    money: 'full',
    station: true,
    progress: true,
    footprint: fp([264, 60], [300, 96], [392, 128]),
  },
  {
    id: 'minimal',
    text: 'line',
    transparent: false,
    money: 'compact',
    station: true,
    progress: true,
    footprint: fp([264, 44], [300, 52], [392, 64]),
  },
  {
    id: 'minutes',
    text: 'none',
    transparent: false,
    money: 'none',
    station: false,
    progress: true,
    footprint: fp([164, 44], [184, 54], [236, 70]),
  },
  {
    id: 'minutes-money',
    text: 'line',
    transparent: false,
    money: 'compact',
    station: false,
    progress: true,
    footprint: fp([212, 44], [250, 54], [320, 70]),
  },
  {
    id: 'compact',
    text: 'line',
    transparent: false,
    money: 'compact',
    station: true,
    progress: true,
    footprint: fp([184, 54], [214, 64], [270, 80]),
  },
  {
    id: 'pill',
    text: 'line',
    transparent: true,
    money: 'compact',
    station: false,
    progress: false,
    footprint: fp([224, 40], [264, 48], [330, 60]),
  },
  {
    id: 'ring',
    text: 'none',
    transparent: true,
    money: 'compact',
    station: false,
    progress: true,
    footprint: fp([92, 92], [116, 116], [152, 152]),
  },
  {
    id: 'dot',
    text: 'none',
    transparent: true,
    money: 'none',
    station: false,
    progress: false,
    footprint: fp([156, 48], [176, 56], [212, 72]),
  },
  {
    id: 'strip',
    text: 'line',
    transparent: true,
    money: 'compact',
    station: false,
    progress: true,
    footprint: fp([420, 28], [520, 32], [660, 40]),
  },
  {
    id: 'digital',
    text: 'line',
    transparent: false,
    money: 'compact',
    station: true,
    progress: false,
    footprint: fp([244, 64], [290, 84], [372, 108]),
  },
  {
    id: 'glass',
    text: 'card',
    transparent: true,
    money: 'full',
    station: true,
    progress: true,
    footprint: fp([264, 60], [300, 96], [392, 128]),
  },
  {
    id: 'neon',
    text: 'card',
    transparent: true,
    money: 'full',
    station: true,
    progress: true,
    footprint: fp([264, 64], [300, 100], [392, 132]),
  },
  {
    id: 'ticket',
    text: 'line',
    transparent: true,
    money: 'full',
    station: true,
    progress: false,
    footprint: fp([220, 88], [252, 112], [312, 144]),
  },
];

const BY_ID = new Map(WIDGET_DESIGNS.map((d) => [d.id, d]));

/** Spec of a design; unknown ids (a newer Admin than this client) fall back to the classic card. */
export function widgetDesign(id: string | null | undefined): WidgetDesignSpec {
  return BY_ID.get(id as ClientWidgetStyle) ?? (BY_ID.get('detailed') as WidgetDesignSpec);
}

/** Window footprint for a design and footprint size (logical pixels). */
export function widgetFootprint(
  id: string | null | undefined,
  size: string | null | undefined,
): WidgetFootprint {
  const spec = widgetDesign(id);
  const key: ClientWidgetSize =
    size === 'small' || size === 'large' || size === 'normal' ? size : 'normal';
  return spec.footprint[key];
}
