/**
 * 0.19.1: the ten ready-made customer-screen views (data only, so it can be unit-tested).
 */
import type { ClientAdsGrid, ClientAdsLayout, ClientWidgetSize } from '@likapcs/shared';

export interface ScreenView {
  id: string;
  width: number;
  height: number;
  widget: ClientWidgetSize;
  layout: ClientAdsLayout;
  grid: ClientAdsGrid;
}

/** The ten views. `photo` = one full picture, `text` = a list, `grid` = products (up to 25). */
export const SCREEN_VIEWS: ScreenView[] = [
  { id: '800x600', width: 800, height: 600, widget: 'small', layout: 'full', grid: '2x2' },
  { id: '1024x768', width: 1024, height: 768, widget: 'small', layout: 'grid', grid: '3x2' },
  { id: '1280x720', width: 1280, height: 720, widget: 'normal', layout: 'grid', grid: '3x3' },
  { id: '1280x1024', width: 1280, height: 1024, widget: 'normal', layout: 'grid', grid: '4x3' },
  { id: '1366x768', width: 1366, height: 768, widget: 'normal', layout: 'menu', grid: '3x3' },
  { id: '1600x900', width: 1600, height: 900, widget: 'normal', layout: 'grid', grid: '4x3' },
  { id: '1920x1080', width: 1920, height: 1080, widget: 'normal', layout: 'grid', grid: '4x4' },
  { id: '1920x1200', width: 1920, height: 1200, widget: 'normal', layout: 'full', grid: '4x4' },
  { id: '2560x1440', width: 2560, height: 1440, widget: 'large', layout: 'grid', grid: '4x4' },
  { id: '3840x2160', width: 3840, height: 2160, widget: 'large', layout: 'grid', grid: '5x5' },
];
