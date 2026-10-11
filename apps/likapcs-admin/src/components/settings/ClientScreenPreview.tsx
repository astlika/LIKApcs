/**
 * Live preview of the customer PC screen for Settings → Client screen. Pure presentation: it
 * mirrors the same `client.*` values the PC receives (`clientDisplayFromSettings`), so what the
 * owner sees here is what LIKApcs-Client shows — lock-screen title, slideshow layout and the
 * countdown widget (size, corner, style, paid / owed line).
 */
import type { ClientDisplayConfig } from '@likapcs/shared';
import { formatMoney } from '@likapcs/shared';
import { useI18n } from '../../i18n';

const SAMPLE = [
  { name: 'Coca-Cola 0.5 L', priceCents: 150, hue: 4 },
  { name: 'Chips Paprika', priceCents: 120, hue: 38 },
  { name: 'Red Bull', priceCents: 250, hue: 210 },
  { name: 'Snickers', priceCents: 90, hue: 28 },
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

  if (mode === 'locked') {
    return (
      <div className="csp" data-testid="csp-locked">
        <div className="csp__header">
          <span className="csp__brand">
            <i>L</i>
            {title}
          </span>
          <span className="csp__clock">21:34</span>
        </div>
        {display.ads.enabled ? (
          <div className={`csp__ads csp__ads--${display.ads.layout}`}>
            {display.ads.layout === 'grid' ? (
              SAMPLE.map((p) => (
                <div key={p.name} className="csp__cell">
                  <Photo hue={p.hue} />
                  <span className="csp__cell-cap">
                    <b>{p.name}</b>
                    {display.ads.showPrice && <em>{money(p.priceCents)}</em>}
                  </span>
                </div>
              ))
            ) : display.ads.layout === 'full' ? (
              <>
                <Photo hue={first.hue} className="csp-photo--full" />
                <span className="csp__full-cap">
                  <b>{first.name}</b>
                  {display.ads.showPrice && <em>{money(first.priceCents)}</em>}
                </span>
              </>
            ) : (
              <>
                <Photo hue={first.hue} className="csp-photo--card" />
                <span className="csp__card-cap">
                  <b>{first.name}</b>
                  {display.ads.showPrice && <em>{money(first.priceCents)}</em>}
                </span>
              </>
            )}
            <span className="csp__dots">
              <i className="is-on" />
              <i />
              <i />
            </span>
          </div>
        ) : (
          <div className="csp__big">{stationCode}</div>
        )}
        <div className="csp__strip">{t('settings.client.previewLocked')}</div>
      </div>
    );
  }

  const w = display.widgetSize;
  const cls = [
    'csp__widget',
    `csp__widget--${w}`,
    `csp__widget--${display.widgetPosition}`,
    display.widgetStyle === 'minimal' ? 'csp__widget--minimal' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="csp csp--desktop" data-testid="csp-session">
      <div className="csp__wallpaper" />
      <div className={cls}>
        {display.widgetStyle === 'minimal' ? (
          <span className="csp__line">
            <i>L</i>
            <b>{stationCode}</b>
            <span>·</span>
            <strong>23 min</strong>
            {display.widgetShowPayment && (
              <>
                <span>·</span>
                <em>{money(150)}</em>
              </>
            )}
          </span>
        ) : (
          <>
            <span className="csp__wtop">
              <i>L</i>
              <b>{stationCode}</b>
              <small>{t('settings.client.previewRemaining')}</small>
            </span>
            <span className="csp__wmain">
              <strong>00:23:41</strong>
              {display.widgetShowPayment && (
                <em>
                  <small>{t('settings.client.previewPaid')}</small>
                  {money(150)}
                </em>
              )}
            </span>
            <span className="csp__wbar">
              <i style={{ width: '40%' }} />
            </span>
          </>
        )}
      </div>
    </div>
  );
}
