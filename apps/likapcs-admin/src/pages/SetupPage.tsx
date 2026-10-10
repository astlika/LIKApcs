import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import type { LoginResponse, SetupStatusResponse } from '@likapcs/shared';
import { api, ApiError, fieldError } from '../lib/api';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { Alert, Button, Field, Input, Select, Segmented } from '../components/ui/primitives';

/** First-run wizard: business identity + owner account. Only works while no user exists. */
export function SetupPage() {
  const { t, language, setLanguage } = useI18n();
  const auth = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState<0 | 1>(0);
  const [businessName, setBusinessName] = useState('');
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<SetupStatusResponse>('/system/setup-status', { auth: false }),
    retry: false,
  });

  if (auth.status === 'authenticated') return <Navigate to="/" replace />;
  if (status.data && !status.data.needsSetup) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (step === 0) return setStep(1);
    if (password !== confirm)
      return setError(
        new ApiError(400, 'mismatch', t('auth.passwordMismatch'), { field: 'confirm' }),
      );
    setBusy(true);
    setError(null);
    try {
      const session = await api<LoginResponse>('/system/setup', {
        method: 'POST',
        auth: false,
        body: { businessName, language, owner: { fullName, username, password } },
      });
      auth.acceptSession(session);
      toast.success(t('setup.done'));
      navigate('/', { replace: true });
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.status === 409) void status.refetch();
    } finally {
      setBusy(false);
    }
  };
  const generic =
    error instanceof ApiError &&
    !['owner.username', 'owner.password', 'owner.fullName', 'businessName', 'confirm'].some((f) =>
      fieldError(error, f),
    )
      ? error.isNetwork
        ? t('common.networkError')
        : error.message
      : null;

  return (
    <div className="auth">
      <form className="card auth__card auth__card--wide" onSubmit={submit}>
        <div className="auth__brand">
          <div className="brand-mark">LK</div>
          <div>
            <div className="auth__title">{t('setup.title')}</div>
            <div className="muted">{t('setup.subtitle')}</div>
          </div>
        </div>
        <div className="steps" aria-hidden>
          <div className="step step--done" />
          <div className={`step ${step === 1 ? 'step--done' : ''}`} />
        </div>
        <div className="row row--between">
          <strong>{step === 0 ? t('setup.stepBusiness') : t('setup.stepOwner')}</strong>
          <Segmented
            value={language}
            onChange={setLanguage}
            options={[
              { value: 'en', label: 'EN' },
              { value: 'sq', label: 'SQ' },
            ]}
          />
        </div>
        {generic && <Alert tone="danger">{generic}</Alert>}
        {step === 0 ? (
          <>
            <Field
              label={t('setup.businessName')}
              hint={t('setup.businessNameHint')}
              error={fieldError(error, 'businessName')}
            >
              {(id, invalid) => (
                <Input
                  id={id}
                  autoFocus
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  aria-invalid={invalid}
                  required
                  maxLength={120}
                />
              )}
            </Field>
            <Field label={t('setup.defaultLanguage')}>
              {(id) => (
                <Select
                  id={id}
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as 'en' | 'sq')}
                >
                  <option value="en">English</option>
                  <option value="sq">Shqip</option>
                </Select>
              )}
            </Field>
          </>
        ) : (
          <>
            <Alert tone="info" icon={<ShieldCheck size={18} />}>
              {t('setup.ownerIntro')}
            </Alert>
            <div className="form-grid">
              <Field label={t('setup.fullName')} error={fieldError(error, 'owner.fullName')}>
                {(id, invalid) => (
                  <Input
                    id={id}
                    autoFocus
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    aria-invalid={invalid}
                    required
                  />
                )}
              </Field>
              <Field
                label={t('auth.username')}
                hint={t('employees.usernameHint')}
                error={fieldError(error, 'owner.username')}
              >
                {(id, invalid) => (
                  <Input
                    id={id}
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    aria-invalid={invalid}
                    required
                  />
                )}
              </Field>
              <Field
                label={t('auth.password')}
                hint={t('auth.passwordRules')}
                error={fieldError(error, 'owner.password')}
              >
                {(id, invalid) => (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={invalid}
                    required
                    minLength={4}
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
            </div>
          </>
        )}
        <div className="form-actions">
          {step === 1 && <Button onClick={() => setStep(0)}>{t('common.back')}</Button>}
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={step === 0 && !businessName.trim()}
          >
            {step === 0 ? t('common.next') : t('setup.finish')}
          </Button>
        </div>
      </form>
    </div>
  );
}
