/**
 * Live preview of the customer PC screen for Settings → Client screen. Pure presentation: it
 * mirrors the same `client.*` values the PC receives (`clientDisplayFromSettings`), so what the
 * owner sees here is what LIKApcs-Client shows — lock-screen title, the slideshow (layout, grid
 * size, full screen, every overlay toggle, caption, picture fit, backdrop, ticker) and the
 * countdown widget (size, corner, style, paid / owed line).
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ClientDisplayConfig } from '@likapcs/shared';
import { adsGridSize, formatMoney } from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { WidgetMock } from './WidgetMock';
import { THEME_COLORS, THEME_GLOWS } from '../../lib/ad-themes';

const SAMPLE = [
  { name: 'Coca-Cola 0.5 L', category: 'Drinks', priceCents: 150, hue: 4 },
  { name: 'Chips Paprika', category: 'Snacks', priceCents: 120, hue: 38 },
  { name: 'Red Bull', category: 'Drinks', priceCents: 250, hue: 210 },
  { name: 'Snickers', category: 'Snacks', priceCents: 90, hue: 28 },
  { name: 'Fanta 0.5 L', category: 'Drinks', priceCents: 150, hue: 24 },
  { name: 'Pringles', category: 'Snacks', priceCents: 220, hue: 350 },
  { name: 'Water 0.5 L', category: 'Drinks', priceCents: 80, hue: 200 },
  { name: 'Mars', category: 'Snacks', priceCents: 90, hue: 16 },
  { name: 'Ice tea', category: 'Drinks', priceCents: 160, hue: 44 },
  { name: 'Popcorn', category: 'Snacks', priceCents: 130, hue: 52 },
  { name: 'Monster', category: 'Drinks', priceCents: 270, hue: 120 },
  { name: 'Twix', category: 'Snacks', priceCents: 90, hue: 32 },
  { name: 'Sprite 0.5 L', category: 'Drinks', priceCents: 150, hue: 150 },
  { name: 'Doritos', category: 'Snacks', priceCents: 180, hue: 8 },
  { name: 'Juice', category: 'Drinks', priceCents: 170, hue: 60 },
  { name: 'Kinder', category: 'Snacks', priceCents: 110, hue: 20 },
];

function Photo({ hue, className }: { hue: number; className?: string }) {
  return (
    <span
      className={`csp-photo ${className ?? ''}`}
      style={{
        background: `radial-gradient(circle at 30% 30%, hsl(${hue} 90% 72%), hsl(${hue} 70% 38%) 70%)`,
      }}
    />
  );
}

export function ClientScreenPreview({
  display,
  businessName,
  stationCode = 'PC 01',
  mode,
}: {
  display: ClientDisplayConfig;
  businessName: string;
  stationCode?: string;
  /** `locked` previews the lock screen (title + slideshow); `session` the countdown widget. */
  mode: 'locked' | 'session';
}) {
  const { t, language } = useI18n();
  const money = (cents: number) =>
    formatMoney(cents, { currency: display.currency, locale: language });
  const title = display.lockTitle === 'station' ? stationCode : businessName || 'LIKApcs';
  const first = SAMPLE[0]!;
  // Width of the preview desktop (responsive) → scale of the widget mock in session mode.
  const desktopRef = useRef<HTMLDivElement>(null);
  const [previewWidth, setPreviewWidth] = useState(420);
  useLayoutEffect(() => {
    const el = desktopRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setPreviewWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  if (mode === 'locked') {
    const ads = display.ads;
    const on = ads.enabled;
    const fullscreen = on && ads.fullscreen;
    const showBrand = !on || ads.showBrand;
    const showClock = !on || ads.showClock;
    const showStatus = !on || ads.showStatus;
    const ticker = on ? ads.tickerText.trim() : '';
    // The PC pill repeats the code only when it is not already the title (never twice).
    const showPill =
      on && ads.showStation && !(display.lockTitle === 'station' && ads.showBrand && !fullscreen);
    const { cols, rows } = adsGridSize(ads.grid);
    const perPage = cols * rows;
    const [bgA, bgB] = THEME_COLORS[ads.background];
    const [glow1, glow2] = THEME_GLOWS[ads.background];
    const style = {
      '--csp-a': bgA,
      '--csp-b': bgB,
      '--csp-glow-1': glow1,
      '--csp-glow-2': glow2,
      '--cols': cols,
      '--rows': rows,
      '--cell-scale': cols >= 4 ? 0.7 : cols === 3 ? 0.84 : 1,
    } as CSSProperties;
    const cls = [
      'csp',
      on ? 'csp--ads' : '',
      fullscreen ? 'csp--fullscreen' : '',
      on ? `csp--fit-${ads.imageFit}` : '',
      on ? `csp--caption-${ads.caption}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const caption = (p: (typeof SAMPLE)[number], dense = false) => (
      <>
        {ads.showCategory && !dense && <small className="csp__cat">{p.category}</small>}
        <b>{p.name}</b>
        {ads.showPrice && <em>{money(p.priceCents)}</em>}
      </>
    );
    const slideshow = on ? (
      <div className={`csp__ads csp__ads--${ads.layout}`} data-testid="csp-ads">
        {ads.layout === 'grid' ? (
          <div className="csp__grid">
            {SAMPLE.slice(0, perPage).map((p) => (
              <div key={p.name} className="csp__cell">
                <Photo hue={p.hue} />
                <span className="csp__cell-cap">{caption(p, perPage > 9)}</span>
              </div>
            ))}
          </div>
        ) : ads.layout === 'full' ? (
          <>
            <Photo hue={first.hue} className="csp-photo--full" />
            {ads.caption !== 'hidden' && <span className="csp__full-cap">{caption(first)}</span>}
          </>
        ) : (
          <>
            <Photo hue={first.hue} className="csp-photo--card" />
            <span className="csp__card-cap">{caption(first)}</span>
          </>
        )}
        {showPill && <span className="csp__pill">{stationCode}</span>}
        {ads.showProgress && (
          <>
            <span className="csp__dots">
              <i className="is-on" />
              <i />
              <i />
            </span>
            <span className="csp__progress">
              <i />
            </span>
          </>
        )}
      </div>
    ) : null;

    return (
      <div
        className={cls}
        style={style}
        data-testid="csp-locked"
        data-fullscreen={fullscreen ? 'true' : undefined}
      >
        {fullscreen && slideshow}
        <div className="csp__header">
          {showBrand ? (
            <span className="csp__brand">
              <i>L</i>
              {title}
            </span>
          ) : (
            <span />
          )}
          {showClock && <span className="csp__clock">21:34</span>}
        </div>
        {on ? (
          fullscreen ? (
            <div className="csp__spacer" />
          ) : (
            slideshow
          )
        ) : (
          <div className="csp__big">{stationCode}</div>
        )}
        <div className="csp__bottom">
          {showStatus && <div className="csp__strip">{t('settings.client.previewLocked')}</div>}
          {ticker && (
            <div className="csp__ticker" title={t('settings.client.previewTicker')}>
              <span>{ticker}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // The widget at the owner's chosen design / size / corner. The preview desktop stands for an
  // 800 px wide screen, so the real footprint (shared widget-designs.ts) is scaled by width / 800
  // — large enough to read, true to the proportions.
  const corner = display.widgetPosition;
  const align = corner.endsWith('center') ? 'center' : corner.endsWith('left') ? 'left' : 'right';
  const cornerStyle: CSSProperties = {
    position: 'absolute',
    ...(corner.startsWith('top') ? { top: '4%' } : { bottom: '6%' }),
    ...(align === 'center'
      ? { left: '50%', transform: 'translateX(-50%)' }
      : align === 'left'
        ? { left: '3%' }
        : { right: '3%' }),
  };
  return (
    <div
      className="csp csp--desktop"
      data-testid="csp-session"
      data-design={display.widgetStyle}
      data-pos={corner}
      ref={desktopRef}
    >
      <div className="csp__wallpaper" />
      <div style={cornerStyle}>
        <WidgetMock
          design={display.widgetStyle}
          size={display.widgetSize}
          showPayment={display.widgetShowPayment}
          code={stationCode}
          money={money(150)}
          scale={previewWidth / 800}
          align={align === 'left' ? 'left' : 'right'}
        />
      </div>
    </div>
  );
}
