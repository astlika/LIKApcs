/**
 * Mock-ups of the LIKApcs-Client countdown widget designs (0.13.0) for Settings › Client screen.
 *
 * Pure presentation. Each mock mirrors the client's markup (apps/likapcs-client/src/Overlay.tsx)
 * with the `.wm` class prefix and is drawn at the design's real footprint (shared
 * `widget-designs.ts`), then scaled down — so the gallery and the desktop preview show the exact
 * proportions the PC will have. Sample values: PC 01, 23 min 41 s left of 60 min, 1.50 € paid.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Check } from 'lucide-react';
import {
  CLIENT_WIDGET_STYLES,
  WIDGET_DESIGNS,
  widgetDesign,
  widgetFootprint,
  type ClientWidgetSize,
  type ClientWidgetStyle,
} from '@likapcs/shared';
import { useI18n } from '../../i18n';

const SAMPLE_SECONDS = 23 * 60 + 41;
const SAMPLE_FRACTION = SAMPLE_SECONDS / 3600;

function hms(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export interface WidgetMockProps {
  design: string;
  size: ClientWidgetSize;
  showPayment: boolean;
  /** Station code shown by designs that carry it. */
  code: string;
  /** Formatted sample amount ("1.50 €"). */
  money: string;
  /** Scale factor applied to the real footprint (1 = the size on the PC). */
  scale: number;
  /** The dot design hugs the outer edge: `left` for the two left corners. */
  align?: 'left' | 'right';
  /** Draw the action tray as revealed (the gallery reveals it on hover by CSS). */
  revealed?: boolean;
  className?: string;
}

/** One design at a given scale, inside a box of the scaled size (so it lays out like an image). */
export function WidgetMock({
  design,
  size,
  showPayment,
  code,
  money,
  scale,
  align = 'right',
  revealed = false,
  className = '',
}: WidgetMockProps) {
  const { t } = useI18n();
  const spec = widgetDesign(design);
  const fp = widgetFootprint(spec.id, size);
  const showMoney = showPayment && spec.money !== 'none';
  const minutes = `${Math.floor(SAMPLE_SECONDS / 60)} ${t('settings.client.previewMin')}`;
  const labels = {
    remaining: t('settings.client.previewRemaining'),
    paid: t('settings.client.previewPaid'),
    min: t('settings.client.previewMin'),
  };
  const bar = spec.progress ? (
    <span className="wm__bar" aria-hidden>
      <span style={{ width: `${SAMPLE_FRACTION * 100}%` }} />
    </span>
  ) : null;
  const cls = [
    'wm',
    `wm--${spec.id}`,
    `wm--${size}`,
    spec.text === 'card' ? 'wm--card' : '',
    spec.transparent ? 'wm--clear' : '',
    align === 'left' ? 'wm--left' : '',
    revealed ? 'is-revealed' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  let body: ReactNode;
  switch (spec.id) {
    case 'minimal':
      body = (
        <>
          <span className="wm__line">
            <i className="wm__mark">L</i>
            <b className="wm__code">{code}</b>
            <i className="wm__dot" />
            <strong className="wm__mini-time">{minutes}</strong>
            {showMoney && (
              <>
                <i className="wm__dot" />
                <em className="wm__mini-money">{money}</em>
              </>
            )}
          </span>
          {bar}
        </>
      );
      break;
    case 'simple':
      body = (
        <span className="wm__line wm__line--center">
          <strong className="wm__mini-time">{minutes}</strong>
        </span>
      );
      break;
    case 'minutes':
    case 'minutes-money':
      body = (
        <>
          <span className="wm__line wm__line--center">
            <strong className="wm__mini-time">{minutes}</strong>
            {spec.id === 'minutes-money' && showMoney && (
              <em className="wm__mini-money">{money}</em>
            )}
          </span>
          {bar}
        </>
      );
      break;
    case 'compact':
      body = (
        <>
          <span className="wm__top">
            <span className="wm__brand">
              <i className="wm__mark">L</i>
              <b className="wm__code">{code}</b>
            </span>
            <small className="wm__label">{labels.remaining}</small>
          </span>
          <span className="wm__main">
            <strong className="wm__time">{hms(SAMPLE_SECONDS)}</strong>
            {showMoney && <em className="wm__mini-money">{money}</em>}
          </span>
          {bar}
        </>
      );
      break;
    case 'pill':
      body = (
        <span className="wm__pill">
          <i className="wm__state" />
          <strong className="wm__mini-time">{minutes}</strong>
          {showMoney && <em className="wm__mini-money">{money}</em>}
        </span>
      );
      break;
    case 'ring': {
      const r = 44;
      const c = 2 * Math.PI * r;
      body = (
        <span className="wm__ring">
          <svg viewBox="0 0 100 100" aria-hidden>
            <circle className="wm__ring-track" cx="50" cy="50" r={r} />
            <circle
              className="wm__ring-fill"
              cx="50"
              cy="50"
              r={r}
              strokeDasharray={c}
              strokeDashoffset={c * (1 - SAMPLE_FRACTION)}
            />
          </svg>
          <span className="wm__ring-text">
            <b>{Math.floor(SAMPLE_SECONDS / 60)}</b>
            <small>{labels.min}</small>
            {showMoney && <em className="wm__mini-money">{money}</em>}
          </span>
        </span>
      );
      break;
    }
    case 'dot':
      body = (
        <span className="wm__dotwrap">
          <span className="wm__bigdot">{Math.floor(SAMPLE_SECONDS / 60)}</span>
        </span>
      );
      break;
    case 'strip':
      body = (
        <span className="wm__strip">
          <i className="wm__strip-fill" style={{ width: `${SAMPLE_FRACTION * 100}%` }} />
          <span className="wm__strip-text">
            <strong className="wm__mini-time">{minutes}</strong>
            {showMoney && <em className="wm__mini-money">{money}</em>}
          </span>
        </span>
      );
      break;
    case 'digital':
      body = (
        <>
          <span className="wm__top">
            <b className="wm__code">{code}</b>
            <small className="wm__label">{showMoney ? money : labels.remaining}</small>
          </span>
          <span className="wm__main wm__main--center">
            <strong className="wm__led">{hms(SAMPLE_SECONDS)}</strong>
          </span>
        </>
      );
      break;
    case 'ticket':
      body = (
        <span className="wm__ticket">
          <span className="wm__ticket-head">
            <b>{code}</b>
            <span>{labels.remaining}</span>
          </span>
          <span className="wm__ticket-time">{hms(SAMPLE_SECONDS)}</span>
          <span className="wm__ticket-cut" />
          <span className="wm__ticket-foot">
            {showMoney ? (
              <>
                <span>{labels.paid}</span>
                <b>{money}</b>
              </>
            ) : (
              <span>LIKApcs</span>
            )}
          </span>
        </span>
      );
      break;
    default:
      body = (
        <>
          <span className="wm__top">
            <span className="wm__brand">
              <i className="wm__mark">L</i>
              <b className="wm__code">{code}</b>
            </span>
            <small className="wm__label">{labels.remaining}</small>
          </span>
          <span className="wm__main">
            <strong className="wm__time">{hms(SAMPLE_SECONDS)}</strong>
            {showMoney && (
              <em className="wm__money wm__money--paid">
                <small>{labels.paid}</small>
                <strong>{money}</strong>
              </em>
            )}
          </span>
          {bar}
        </>
      );
  }

  const style: CSSProperties = {
    width: fp.width,
    height: fp.height,
    transform: `scale(${scale})`,
    // the dot sizes itself from the footprint height like the client does
    ['--ov-h' as string]: `${fp.height}px`,
  };
  return (
    <span
      className="wm-fit"
      style={{ width: fp.width * scale, height: fp.height * scale }}
      data-testid="widget-mock"
      data-design={spec.id}
    >
      <span className={cls} style={style}>
        {body}
        <span className="wm__anchor" aria-hidden>
          <span className="wm__tray">
            <i className="wm__act" style={{ ['--i' as string]: 0 }}>
              +
            </i>
            <i className="wm__act" style={{ ['--i' as string]: 1 }}>
              ❚❚
            </i>
            <i className="wm__act" style={{ ['--i' as string]: 2 }}>
              ☰
            </i>
          </span>
        </span>
      </span>
    </span>
  );
}

/** The gallery of the thirteen designs with name, description and traits; `value` is highlighted. */
export function WidgetDesignPicker({
  value,
  size,
  showPayment,
  code,
  money,
  disabled = false,
  onChange,
}: {
  value: string;
  size: ClientWidgetSize;
  showPayment: boolean;
  code: string;
  money: string;
  disabled?: boolean;
  onChange: (next: ClientWidgetStyle) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="wd-grid" role="radiogroup" data-testid="widget-designs">
      {CLIENT_WIDGET_STYLES.map((id) => {
        const spec = WIDGET_DESIGNS.find((d) => d.id === id) ?? widgetDesign(id);
        const fp = widgetFootprint(id, size);
        // fit the real footprint into the preview box (210 × 84) without ever upscaling
        const scale = Math.min(1, 200 / fp.width, 76 / fp.height);
        const on = value === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            className={`wd-card ${on ? 'is-on' : ''}`}
            onClick={() => onChange(id)}
            disabled={disabled}
            data-testid={`widget-design-${id}`}
          >
            <span className="wd-card__preview">
              <WidgetMock
                design={id}
                size={size}
                showPayment={showPayment}
                code={code}
                money={money}
                scale={scale}
              />
            </span>
            <span className="wd-card__head">
              {on && (
                <span className="wd-card__check">
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
              <span className="wd-card__name">{t(`settings.client.design.${id}.name`)}</span>
              <span className="wd-card__tags">
                {spec.transparent && (
                  <span className="wd-card__tag">{t('settings.client.widgetTransparent')}</span>
                )}
              </span>
            </span>
            <p className="wd-card__desc">{t(`settings.client.design.${id}.desc`)}</p>
          </button>
        );
      })}
    </div>
  );
}
