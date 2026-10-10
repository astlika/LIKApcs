import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useI18n } from '../../i18n';

// ─── Buttons ───────────────────────────────────────────────────────────────────
type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: boolean;
  block?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    size = 'md',
    loading = false,
    icon = false,
    block = false,
    className = '',
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const classes = ['btn'];
  if (variant !== 'default') classes.push(`btn--${variant}`);
  if (size !== 'md') classes.push(`btn--${size}`);
  if (icon) classes.push('btn--icon');
  if (block) classes.push('btn--block');
  if (className) classes.push(className);
  return (
    <button
      ref={ref}
      type={type}
      className={classes.join(' ')}
      disabled={disabled || loading}
      aria-busy={loading}
      {...rest}
    >
      {loading ? <span className="spinner" /> : children}
    </button>
  );
});

// ─── Form fields ───────────────────────────────────────────────────────────────
interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: (id: string, invalid: boolean) => ReactNode;
  className?: string;
}
export function Field({ label, hint, error, optional, children, className = '' }: FieldProps) {
  const id = useId();
  const { t } = useI18n();
  return (
    <div className={`field ${className}`}>
      <label className="field__label" htmlFor={id}>
        {label}
        {optional && <span className="faint"> · {t('common.optional')}</span>}
      </label>
      {children(id, Boolean(error))}
      {error ? (
        <div className="field__error">{error}</div>
      ) : hint ? (
        <div className="field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`input ${className}`} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', ...rest }, ref) {
    return <select ref={ref} className={`select ${className}`} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = '', ...rest }, ref) {
  return <textarea ref={ref} className={`textarea ${className}`} {...rest} />;
});

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="switch" data-checked={checked} aria-disabled={disabled}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__track" aria-hidden />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox" data-checked={checked} aria-disabled={disabled}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span>
        <span className="checkbox__title">{label}</span>
        {description && <div className="checkbox__desc">{description}</div>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="seg__btn"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Display ───────────────────────────────────────────────────────────────────
type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'purple';
export function Badge({
  tone = 'default',
  children,
  dot,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`badge ${tone !== 'default' ? `badge--${tone}` : ''}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function Card({
  title,
  actions,
  children,
  flush,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card__header">
          <h3 className="card__title">{title}</h3>
          {actions}
        </header>
      )}
      <div className={`card__body ${flush ? 'card__body--flush' : ''}`}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone,
  icon,
  to,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'accent' | 'success' | 'danger' | 'warning';
  icon?: ReactNode;
  to?: string;
  onClick?: () => void;
}) {
  const classes = `card stat ${tone ? `stat--${tone}` : ''}`;
  const body = (
    <>
      <div className="stat__label">
        <span>{label}</span>
        {icon}
      </div>
      <div className="stat__value">{value}</div>
      {sub && <div className="stat__sub">{sub}</div>}
    </>
  );
  if (to) {
    return (
      <a className={classes} href={`#${to}`} style={{ color: 'inherit' }}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={classes}
        onClick={onClick}
        style={{ cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
      >
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="page-header__sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <div className="empty__title">{title}</div>
      {hint && <p>{hint}</p>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="loading-row">
      <span className="spinner" /> {label ?? t('common.loading')}
    </div>
  );
}

export function Alert({
  tone = 'info',
  children,
  icon,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon}
      <div className="alert__body">{children}</div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

// ─── Tabs ──────────────────────────────────────────────────────────────────────
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { id: T; label: string }[];
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab.id === value}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ─── Dialog ────────────────────────────────────────────────────────────────────
interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Prevent closing with Escape / overlay click (e.g. forced password change). */
  locked?: boolean;
}
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  locked = false,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  // Callers almost always pass inline arrow functions for `onClose`; keep the latest one in a ref so
  // the effects below depend on `open` only. (Depending on `onClose` re-ran the focus effect on every
  // keystroke — each re-render moved the focus back to the first field while the user was typing.)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !lockedRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  // Focus the first control once, when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const first = ref.current?.querySelector<HTMLElement>(
      'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([data-close])',
    );
    first?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !locked && onClose()}
    >
      <div
        ref={ref}
        className={`dialog ${size !== 'md' ? `dialog--${size}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="dialog__header">
          <div>
            <div className="dialog__title">{title}</div>
            {description && <div className="dialog__desc">{description}</div>}
          </div>
          {!locked && (
            <Button
              variant="ghost"
              icon
              size="sm"
              onClick={onClose}
              aria-label={t('common.close')}
              data-close
            >
              <X size={16} />
            </Button>
          )}
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  danger,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      {body && <p className="muted">{body}</p>}
    </Dialog>
  );
}

// ─── Pagination ────────────────────────────────────────────────────────────────
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pagination">
      <span>{t('common.showing', { from, to, total })}</span>
      <div className="pagination__controls">
        <Button
          size="sm"
          icon
          variant="ghost"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={16} />
        </Button>
        <span className="num">
          {t('common.page')} {page} {t('common.of')} {pages}
        </span>
        <Button
          size="sm"
          icon
          variant="ghost"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight size={16} />
        </Button>
      </div>
    </div>
  );
}
