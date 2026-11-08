import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useT } from '../i18n';

export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

/** Bottom sheet: the one place where a money action is confirmed. Closes on the ✕, the backdrop or Esc. */
export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const tClose = useT()('Mbyll');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-root">
      <button type="button" className="sheet-backdrop" aria-label={tClose} onClick={onClose} />
      <section className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet__grip" aria-hidden="true" />
        <header className="sheet__head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label={tClose} onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="sheet__body">{children}</div>
        {footer && <footer className="sheet__foot">{footer}</footer>}
      </section>
    </div>
  );
}

type BtnVariant = 'primary' | 'ghost' | 'danger' | 'ok';

export function Btn({
  variant = 'primary',
  block = false,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; block?: boolean }) {
  return <button type="button" className={cx('btn', `btn--${variant}`, block && 'btn--block', className)} {...rest} />;
}

/** Big choice buttons (payment method, duration…). Works for text and number values. */
export function Choices<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="choices" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            className={cx('choice', value === o.value && 'choice--on')}
            aria-pressed={value === o.value}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  return (
    <div className={cx('notice', `notice--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Loading({ text }: { text?: string }) {
  const t = useT();
  return <p className="muted center">{text ?? t('Duke ngarkuar…')}</p>;
}

export function QueryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="card stack">
      <Notice tone="danger">{message}</Notice>
      <Btn onClick={onRetry} block>
        {t('Provo përsëri')}
      </Btn>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/** Euro amount typed as "12,50". Decimal keyboard on the phone. */
export function EuroInput({
  label,
  value,
  onChange,
  placeholder = '0,00',
  disabled = false,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <Field label={label}>
      <span className="euro-input">
        <input
          inputMode="decimal"
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ''))}
        />
        <span aria-hidden="true">€</span>
      </span>
    </Field>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <div className={cx('stat', tone && `stat--${tone}`)}>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}
