/**
 * 0.19.1: ten ready-made customer-screen views, from 800×600 to 4K. Each shows a schematic of the
 * screen at its real aspect ratio (a photo page, a text list or a product grid, plus the widget),
 * and "Apply" loads the view into the Settings draft. Like the saved presets, nothing is sent to
 * the PCs until the owner presses Save.
 */
import type { CSSProperties } from 'react';
import type { ClientWidgetSize } from '@likapcs/shared';
import { adsGridSize } from '@likapcs/shared';
import { SCREEN_VIEWS, type ScreenView } from '../../lib/screen-views';
import { useI18n } from '../../i18n';
import { Button, Card } from '../ui/primitives';

const WIDGET_WIDTH: Record<ClientWidgetSize, string> = {
  small: '14%',
  normal: '18%',
  large: '24%',
};

function ViewPreview({ view }: { view: ScreenView }) {
  const { t } = useI18n();
  const screen: CSSProperties = {
    position: 'relative',
    width: '100%',
    aspectRatio: `${view.width} / ${view.height}`,
    background: 'linear-gradient(160deg, #1e293b, #0b1120)',
    borderRadius: 6,
    overflow: 'hidden',
    border: '1px solid var(--border)',
  };
  const content: CSSProperties = { position: 'absolute', inset: '6% 6% 6% 6%', display: 'flex' };
  let body;
  if (view.layout === 'full') {
    body = <div style={{ ...content, background: 'linear-gradient(135deg, #334155, #475569)' }} />;
  } else if (view.layout === 'menu') {
    body = (
      <div style={{ ...content, flexDirection: 'column', gap: '6%' }}>
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            style={{
              height: '8%',
              width: `${70 - i * 6}%`,
              background: '#475569',
              borderRadius: 2,
            }}
          />
        ))}
      </div>
    );
  } else {
    const { cols, rows } = adsGridSize(view.grid);
    body = (
      <div
        style={{
          ...content,
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: '3%',
        }}
      >
        {Array.from({ length: cols * rows }, (_, i) => (
          <span key={i} style={{ background: '#64748b', borderRadius: 2 }} />
        ))}
      </div>
    );
  }
  const layoutLabel =
    view.layout === 'full'
      ? t('settings.client.views.photo')
      : view.layout === 'menu'
        ? t('settings.client.views.text')
        : `${adsGridSize(view.grid).cols * adsGridSize(view.grid).rows} ${t('settings.client.views.products')}`;
  return (
    <div>
      <div style={screen} aria-hidden>
        {body}
        <span
          style={{
            position: 'absolute',
            top: '4%',
            right: '3%',
            width: WIDGET_WIDTH[view.widget],
            height: '9%',
            background: 'var(--accent, #6366f1)',
            borderRadius: 4,
          }}
        />
      </div>
      <div style={{ fontSize: 12.5, marginTop: 6 }}>
        <strong>
          {view.width} × {view.height}
        </strong>{' '}
        · {layoutLabel}
      </div>
    </div>
  );
}

export function ScreenViewsCard({
  canManage,
  onApply,
}: {
  canManage: boolean;
  onApply: (values: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  return (
    <Card
      title={t('settings.client.views.title')}
      subtitle={t('settings.client.views.hint')}
      testId="screen-views"
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
          gap: 12,
        }}
      >
        {SCREEN_VIEWS.map((view) => (
          <div key={view.id} data-testid="screen-view">
            <ViewPreview view={view} />
            <Button
              style={{ marginTop: 6, width: '100%' }}
              disabled={!canManage}
              onClick={() =>
                onApply({
                  'client.widget_size': view.widget,
                  'client.ads_layout': view.layout,
                  'client.ads_grid': view.grid,
                  'client.ads_image_fit': 'contain',
                })
              }
            >
              {t('settings.client.views.apply')}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
