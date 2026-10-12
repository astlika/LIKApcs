/**
 * Colour presets shared by Ads › Look (per slide) and Settings › Client screen › Background
 * (the backdrop behind the slides). Mirrors `.ads__theme--*` in LIKApcs-Client's styles.css so the
 * Admin previews what the PCs render.
 */
import type { AdTheme } from '@likapcs/shared';

export const THEME_COLORS: Record<AdTheme, [string, string]> = {
  midnight: ['#1e293b', '#0f172a'],
  ocean: ['#0c4a6e', '#082f49'],
  sunset: ['#7c2d12', '#3b0764'],
  forest: ['#14532d', '#052e16'],
  ruby: ['#7f1d1d', '#27060a'],
  gold: ['#78350f', '#1c1917'],
  mono: ['#262626', '#0a0a0a'],
};
/** Glow colours (two radial highlights) per preset — same values as the client. */
export const THEME_GLOWS: Record<AdTheme, [string, string]> = {
  midnight: ['rgba(99, 102, 241, 0.55)', 'rgba(14, 165, 233, 0.45)'],
  ocean: ['rgba(34, 211, 238, 0.55)', 'rgba(59, 130, 246, 0.5)'],
  sunset: ['rgba(251, 146, 60, 0.6)', 'rgba(236, 72, 153, 0.5)'],
  forest: ['rgba(74, 222, 128, 0.5)', 'rgba(45, 212, 191, 0.45)'],
  ruby: ['rgba(248, 113, 113, 0.55)', 'rgba(244, 63, 94, 0.45)'],
  gold: ['rgba(251, 191, 36, 0.6)', 'rgba(245, 158, 11, 0.4)'],
  mono: ['rgba(163, 163, 163, 0.35)', 'rgba(82, 82, 82, 0.45)'],
};

export const themeStyle = (theme: AdTheme | null) => {
  const [a, b] = THEME_COLORS[theme ?? 'midnight'];
  return { background: `linear-gradient(135deg, ${a}, ${b})` };
};
