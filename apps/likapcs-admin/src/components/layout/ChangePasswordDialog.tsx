import { useState, type FormEvent } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api, ApiError, fieldError } from '../../lib/api';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { useAuth } from '../../state/auth';
import { Alert, Button, Dialog, Field, Input } from '../ui/primitives';

export function ChangePasswordDialog({
  open,
  onClose,
  forced = false,
}: {
  open: boolean;
  onClose: () => void;
  forced?: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { refresh } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm)
      return setError(
        new ApiError(400, 'mismatch', t('auth.passwordMismatch'), { field: 'confirm' }),
      );
    setBusy(true);
    setError(null);
    try {
      await api<void>('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      toast.success(t('auth.passwordChanged'));
      await refresh();
      reset();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const generic =
    error instanceof ApiError &&
    !fieldError(error, 'currentPassword') &&
    !fieldError(error, 'newPassword') &&
    !fieldError(error, 'confirm')
      ? error.message
      : null;

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t('topbar.changePassword')}
      size="sm"
      locked={forced}
    >
      <form onSubmit={submit} className="stack" id="change-password-form">
        {forced && (
          <Alert tone="warning" icon={<ShieldAlert size={18} />}>
            {t('auth.mustChangePassword')}
          </Alert>
        )}
        {generic && <Alert tone="danger">{generic}</Alert>}
        <Field label={t('auth.currentPassword')} error={fieldError(error, 'currentPassword')}>
          {(id, invalid) => (
            <Input
              id={id}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              aria-invalid={invalid}
              required
            />
          )}
        </Field>
        <Field
          label={t('auth.newPassword')}
          hint={t('auth.passwordRules')}
          error={fieldError(error, 'newPassword')}
        >
          {(id, invalid) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={invalid}
              required
              minLength={8}
            />
          )}
        </Field>
        <Field label={t('auth.confirmPassword')} error={fieldError(error, 'confirm')}>
          {(id, invalid) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={invalid}
              required
            />
          )}
        </Field>
        <div className="form-actions">
          {!forced && (
            <Button
              onClick={() => {
                reset();
                onClose();
              }}
            >
              {t('common.cancel')}
            </Button>
          )}
          <Button type="submit" variant="primary" loading={busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
