import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Megaphone, Save, Undo2, UtensilsCrossed } from 'lucide-react';
import {
  AD_THEMES,
  CLIENT_ADS_CAPTIONS,
  CLIENT_ADS_GRIDS,
  CLIENT_ADS_IMAGE_FITS,
  CLIENT_ADS_LAYOUTS,
  CLIENT_ADS_STYLES,
  CLIENT_ADS_TRANSITIONS,
  CLIENT_LOCK_TITLES,
  adsGridSize,
  CLIENT_WIDGET_POSITIONS,
  CLIENT_WIDGET_SIZES,
  CLIENT_WIDGET_STYLES,
  PERMISSIONS,
  PROTOCOL_VERSION,
  SETTING_SCHEMAS,
  clientDisplayFromSettings,
  type SettingKey,
  type SettingsMap,
  type SystemInfoResponse,
} from '@likapcs/shared';
import { api, ApiError } from '../lib/api';
import { themeStyle } from '../lib/ad-themes';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Loading,
  Segmented,
  Select,
  Switch,
  Tabs,
  Textarea,
} from '../components/ui/primitives';
import { ClientScreenPreview } from '../components/settings/ClientScreenPreview';
import { UpdatePanel } from '../components/UpdatePanel';
import { LocalServerPanel } from '../components/LocalServerPanel';

type TabId =
  'business' | 'locale' | 'stations' | 'client' | 'printing' | 'security' | 'system' | 'about';
const TAB_IDS: TabId[] = [
  'business',
  'locale',
  'stations',
  'client',
  'printing',
  'security',
  'system',
  'about',
];
const ADMIN_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0-dev';

const TIMEZONES = [
  'Europe/Belgrade',
  'Europe/Tirane',
  'Europe/Skopje',
  'Europe/Podgorica',
  'Europe/Zagreb',
  'Europe/Sarajevo',
  'Europe/Ljubljana',
  'Europe/Vienna',
  'Europe/Berlin',
  'Europe/Zurich',
  'Europe/Rome',
  'Europe/Paris',
  'Europe/London',
  'Europe/Istanbul',
  'Europe/Athens',
  'Europe/Sofia',
  'UTC',
];
const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'ALL', 'MKD', 'RSD', 'BAM', 'TRY'];

export function SettingsPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canManage = can(PERMISSIONS.SETTINGS_MANAGE);
  const [params] = useSearchParams();
  const initialTab = params.get('tab') as TabId | null;
  const [tab, setTab] = useState<TabId>(
    initialTab && TAB_IDS.includes(initialTab) ? initialTab : 'business',
  );
  const [draft, setDraft] = useState<Partial<SettingsMap>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const settings = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: () => api<SettingsMap>('/settings'),
  });
  const info = useQuery({
    queryKey: ['system-info'],
    queryFn: () => api<SystemInfoResponse>('/system/info'),
    enabled: tab === 'about',
    refetchInterval: tab === 'about' ? 10_000 : false,
  });

  const current = useMemo(
    () => ({ ...(settings.data ?? {}), ...draft }) as SettingsMap,
    [settings.data, draft],
  );
  const dirty = Object.keys(draft).length > 0;

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function set<K extends SettingKey>(key: K, value: SettingsMap[K]) {
    setDraft((d) => {
      const next = { ...d, [key]: value };
      if (settings.data && JSON.stringify(settings.data[key]) === JSON.stringify(value))
        delete next[key];
      return next;
    });
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      // Client-side validation with the shared schemas so the error lands on the right field.
      const localErrors: Record<string, string> = {};
      for (const [key, value] of Object.entries(draft)) {
        const schema = SETTING_SCHEMAS[key as SettingKey];
        const result = schema.safeParse(value);
        if (!result.success) localErrors[key] = result.error.issues[0]?.message ?? 'Invalid value';
      }
      if (Object.keys(localErrors).length) {
        setErrors(localErrors);
        throw new ApiError(400, 'validation_error', t('common.errorGeneric'));
      }
      return api<SettingsMap>('/settings', { method: 'PATCH', body: draft });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['settings', 'all'], data);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      setDraft({});
      toast.success(t('settings.saved'));
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        err.code === 'validation_error' &&
        Array.isArray(err.details)
      ) {
        const next: Record<string, string> = {};
        for (const issue of err.details as { path: string; message: string }[])
          next[issue.path] = issue.message;
        setErrors((e) => ({ ...e, ...next }));
      } else if (err instanceof ApiError && err.code !== 'validation_error')
        toast.error(err.message);
    },
  });

  const ro = !canManage;
  const text = (
    key: SettingKey,
    label: string,
    opts: { hint?: string; multiline?: boolean; className?: string; type?: string } = {},
  ) => (
    <Field key={key} label={label} hint={opts.hint} error={errors[key]} className={opts.className}>
      {(id, invalid) =>
        opts.multiline ? (
          <Textarea
            id={id}
            rows={3}
            value={String(current[key] ?? '')}
            onChange={(e) => set(key, e.target.value as never)}
            aria-invalid={invalid}
            disabled={ro}
          />
        ) : (
          <Input
            id={id}
            type={opts.type ?? 'text'}
            value={String(current[key] ?? '')}
            onChange={(e) => set(key, e.target.value as never)}
            aria-invalid={invalid}
            disabled={ro}
          />
        )
      }
    </Field>
  );
  const number = (
    key: SettingKey,
    label: string,
    opts: { hint?: string; min?: number; max?: number; step?: number } = {},
  ) => (
    <Field key={key} label={label} hint={opts.hint} error={errors[key]}>
      {(id, invalid) => (
        <Input
          id={id}
          type="number"
          min={opts.min}
          max={opts.max}
          step={opts.step ?? 1}
          value={String(current[key] ?? '')}
          onChange={(e) => set(key, (e.target.value === '' ? '' : Number(e.target.value)) as never)}
          aria-invalid={invalid}
          disabled={ro}
        />
      )}
    </Field>
  );
  const bool = (key: SettingKey, label: string, hint?: string) => (
    <Switch
      key={key}
      checked={Boolean(current[key])}
      onChange={(v) => set(key, v as never)}
      disabled={ro}
      label={
        <span>
          {label}
          {hint && (
            <div className="faint" style={{ fontSize: 12 }}>
              {hint}
            </div>
          )}
        </span>
      }
    />
  );

  if (settings.isLoading) return <Loading />;
  if (settings.isError) return <Alert tone="danger">{t('common.errorGeneric')}</Alert>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{t('settings.title')}</h1>
          <p className="page-header__sub">{t('settings.subtitle')}</p>
        </div>
        {canManage && (
          <div className="page-header__actions">
            {dirty && <span className="muted">{t('settings.unsaved')}</span>}
            <Button
              disabled={!dirty}
              onClick={() => {
                setDraft({});
                setErrors({});
              }}
            >
              <Undo2 size={15} /> {t('settings.discard')}
            </Button>
            <Button
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate()}
              data-testid="settings-save"
            >
              <Save size={15} /> {t('common.save')}
            </Button>
          </div>
        )}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={TAB_IDS.map((id) => ({ id, label: t(`settings.tabs.${id}`) }))}
      />

      {tab === 'business' && (
        <Card>
          <div className="form-grid">
            {text('business.name', t('settings.business.name'))}
            {text('business.legal_name', t('settings.business.legalName'))}
            {text('business.address', t('settings.business.address'), { className: 'span-2' })}
            {text('business.city', t('settings.business.city'))}
            {text('business.phone', t('settings.business.phone'))}
            {text('business.email', t('settings.business.email'), { type: 'email' })}
            {text('business.website', t('settings.business.website'))}
            {text('business.tax_id', t('settings.business.taxId'))}
            {text('business.registration_no', t('settings.business.registrationNo'))}
            {text('business.receipt_footer', t('settings.business.receiptFooter'), {
              hint: t('settings.business.receiptFooterHint'),
              multiline: true,
              className: 'span-2',
            })}
          </div>
        </Card>
      )}

      {tab === 'locale' && (
        <Card>
          <div className="form-grid">
            <Field label={t('settings.locale.language')} error={errors['locale.default_language']}>
              {(id) => (
                <Select
                  id={id}
                  value={current['locale.default_language']}
                  onChange={(e) => set('locale.default_language', e.target.value as 'en' | 'sq')}
                  disabled={ro}
                >
                  <option value="en">English</option>
                  <option value="sq">Shqip</option>
                </Select>
              )}
            </Field>
            <Field label={t('settings.locale.currency')} error={errors['locale.currency']}>
              {(id) => (
                <Select
                  id={id}
                  value={current['locale.currency']}
                  onChange={(e) => set('locale.currency', e.target.value)}
                  disabled={ro}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('settings.locale.timezone')} error={errors['locale.timezone']}>
              {(id) => (
                <Select
                  id={id}
                  value={current['locale.timezone']}
                  onChange={(e) => set('locale.timezone', e.target.value)}
                  disabled={ro}
                >
                  {[...new Set([current['locale.timezone'], ...TIMEZONES])].map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('settings.locale.dateFormat')}>
              {(id) => (
                <Input
                  id={id}
                  value={`${current['locale.date_format']} · ${current['locale.time_format']}`}
                  disabled
                />
              )}
            </Field>
            <Field label={t('settings.locale.taxRate')} error={errors['tax.default_rate_bp']}>
              {(id, invalid) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  max={100}
                  step={0.01}
                  value={(current['tax.default_rate_bp'] / 100).toString()}
                  onChange={(e) =>
                    set('tax.default_rate_bp', Math.round(Number(e.target.value) * 100))
                  }
                  aria-invalid={invalid}
                  disabled={ro}
                />
              )}
            </Field>
            <div className="span-2">
              {bool(
                'tax.prices_include_tax',
                t('settings.locale.pricesIncludeTax'),
                t('settings.locale.pricesIncludeTaxHint'),
              )}
            </div>
          </div>
        </Card>
      )}

      {tab === 'stations' && (
        <Card>
          <div className="form-grid">
            {number('stations.heartbeat_interval_seconds', t('settings.stations.heartbeat'), {
              min: 3,
              max: 120,
            })}
            {number('stations.offline_after_seconds', t('settings.stations.offlineAfter'), {
              min: 5,
              max: 600,
            })}
            {number('stations.session_grace_seconds', t('settings.stations.grace'), {
              min: 0,
              max: 3600,
              hint: t('settings.stations.graceHint'),
            })}
            <Field
              label={t('settings.stations.warnings')}
              error={errors['stations.expiry_warning_minutes']}
            >
              {(id, invalid) => (
                <Input
                  id={id}
                  value={current['stations.expiry_warning_minutes'].join(', ')}
                  onChange={(e) =>
                    set(
                      'stations.expiry_warning_minutes',
                      e.target.value
                        .split(',')
                        .map((v) => Number(v.trim()))
                        .filter((v) => Number.isInteger(v) && v > 0),
                    )
                  }
                  aria-invalid={invalid}
                  disabled={ro}
                />
              )}
            </Field>
            {text('stations.client_welcome_message', t('settings.stations.welcome'), {
              multiline: true,
              className: 'span-2',
            })}
            {number('stations.maintenance_minutes', t('settings.stations.maintenanceMinutes'), {
              min: 1,
              max: 480,
              hint: t('settings.stations.maintenanceMinutesHint'),
            })}
          </div>
        </Card>
      )}
      {tab === 'stations' && (
        <Card title={t('settings.pause.title')} subtitle={t('settings.pause.subtitle')}>
          <div className="grid grid--2">
            <div data-testid="settings-customer-pause">
              {bool(
                'sessions.customer_pause',
                t('settings.pause.customerPause'),
                t('settings.pause.customerPauseHint'),
              )}
            </div>
            <div data-testid="settings-customer-resume">
              {bool(
                'sessions.customer_resume',
                t('settings.pause.customerResume'),
                t('settings.pause.customerResumeHint'),
              )}
            </div>
            {number('sessions.pause_max_minutes', t('settings.pause.maxMinutes'), {
              min: 0,
              max: 240,
              hint: t('settings.pause.maxMinutesHint'),
            })}
          </div>
        </Card>
      )}
      {tab === 'stations' && (
        <Card title={t('settings.orders.title')} subtitle={t('settings.orders.subtitle')}>
          <div className="grid grid--2">
            <div data-testid="settings-orders-enabled">
              {bool(
                'orders.enabled',
                t('settings.orders.enabled'),
                t('settings.orders.enabledHint'),
              )}
            </div>
            <div data-testid="settings-orders-note">
              {bool(
                'orders.allow_note',
                t('settings.orders.allowNote'),
                t('settings.orders.allowNoteHint'),
              )}
            </div>
            <Field
              label={t('settings.orders.settlement')}
              hint={t('settings.orders.settlementHint')}
              className="span-2"
            >
              {() => (
                <Segmented
                  value={current['orders.settlement']}
                  options={(['ask', 'pay_now', 'on_bill'] as const).map((v) => ({
                    value: v,
                    label: t(`settings.orders.settlements.${v}`),
                  }))}
                  onChange={(v) => !ro && set('orders.settlement', v)}
                  testId="settings-orders-settlement"
                />
              )}
            </Field>
            <div className="span-2">
              <Link to="/orders?tab=menu" className="btn btn--sm">
                <UtensilsCrossed size={14} /> {t('orders.menuTitle')}
              </Link>
            </div>
          </div>
        </Card>
      )}
      {tab === 'stations' && (
        <Card title={t('settings.requests.title')} subtitle={t('settings.requests.subtitle')}>
          <div className="grid grid--2">
            <div className="span-2" data-testid="settings-requests-enabled">
              {bool(
                'requests.enabled',
                t('settings.requests.enabled'),
                t('settings.requests.enabledHint'),
              )}
            </div>
            <Field
              label={t('settings.requests.quickMinutes')}
              hint={t('settings.requests.quickMinutesHint')}
              error={errors['requests.quick_minutes']}
            >
              {(id, invalid) => (
                <Input
                  id={id}
                  data-testid="settings-requests-quick"
                  value={current['requests.quick_minutes'].join(', ')}
                  onChange={(e) =>
                    set(
                      'requests.quick_minutes',
                      e.target.value
                        .split(',')
                        .map((v) => Number(v.trim()))
                        .filter((v) => Number.isInteger(v) && v > 0),
                    )
                  }
                  aria-invalid={invalid}
                  disabled={ro || !current['requests.enabled']}
                />
              )}
            </Field>
          </div>
        </Card>
      )}

      {tab === 'client' && (
        <div className="client-screen">
          <div className="stack">
            <Card
              title={t('settings.client.widgetTitle')}
              subtitle={t('settings.client.widgetHint')}
            >
              <div className="form-grid">
                <Field label={t('settings.client.widgetStyle')}>
                  {() => (
                    <Segmented
                      value={current['client.widget_style']}
                      options={CLIENT_WIDGET_STYLES.map((v) => ({
                        value: v,
                        label: t(`settings.client.style.${v}`),
                      }))}
                      onChange={(v) => !ro && set('client.widget_style', v)}
                    />
                  )}
                </Field>
                <Field label={t('settings.client.widgetSize')}>
                  {() => (
                    <Segmented
                      value={current['client.widget_size']}
                      options={CLIENT_WIDGET_SIZES.map((v) => ({
                        value: v,
                        label: t(`settings.client.size.${v}`),
                      }))}
                      onChange={(v) => !ro && set('client.widget_size', v)}
                    />
                  )}
                </Field>
                <Field label={t('settings.client.widgetPosition')} className="span-2">
                  {() => (
                    <Segmented
                      value={current['client.widget_position']}
                      options={CLIENT_WIDGET_POSITIONS.map((v) => ({
                        value: v,
                        label: t(`settings.client.position.${v}`),
                      }))}
                      onChange={(v) => !ro && set('client.widget_position', v)}
                    />
                  )}
                </Field>
                <div className="span-2">
                  {bool(
                    'client.widget_show_payment',
                    t('settings.client.showPayment'),
                    t('settings.client.showPaymentHint'),
                  )}
                </div>
              </div>
            </Card>
            <Card
              title={t('settings.client.lockTitle')}
              subtitle={t('settings.client.lockTitleHint')}
            >
              <Segmented
                value={current['client.lock_title']}
                options={CLIENT_LOCK_TITLES.map((v) => ({
                  value: v,
                  label: t(`settings.client.title.${v}`),
                }))}
                onChange={(v) => !ro && set('client.lock_title', v)}
              />
            </Card>
            <Card
              title={t('settings.client.staffLoginTitle')}
              subtitle={t('settings.client.staffLoginHint')}
            >
              {text('client.staff_login_username', t('settings.client.staffLoginUsername'), {
                hint: t('settings.client.staffLoginUsernameHint'),
              })}
            </Card>
            <Card
              title={t('settings.client.adsTitle')}
              subtitle={t('settings.client.adsHint')}
              actions={
                <Link to="/ads" className="btn btn--sm">
                  <Megaphone size={14} /> {t('settings.client.manageAds')}
                </Link>
              }
            >
              <div className="stack">
                {bool('client.ads_enabled', t('settings.client.adsEnabled'))}
                <div className="form-grid">
                  <Field label={t('settings.client.adsLayout')} className="span-2">
                    {() => (
                      <Segmented
                        value={current['client.ads_layout']}
                        options={CLIENT_ADS_LAYOUTS.map((v) => ({
                          value: v,
                          label: t(`settings.client.layout.${v}`),
                        }))}
                        onChange={(v) => !ro && set('client.ads_layout', v)}
                        testId="screen-layout"
                      />
                    )}
                  </Field>
                  {current['client.ads_layout'] === 'grid' && (
                    <Field
                      label={t('settings.client.gridSize')}
                      hint={t('settings.client.gridSizeHint')}
                      className="span-2"
                    >
                      {() => (
                        <div className="grid-pick" role="radiogroup" data-testid="screen-grids">
                          {CLIENT_ADS_GRIDS.map((g) => {
                            const { cols, rows } = adsGridSize(g);
                            const on = current['client.ads_grid'] === g;
                            return (
                              <button
                                key={g}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                className={`grid-pick__opt ${on ? 'is-on' : ''}`}
                                onClick={() => !ro && set('client.ads_grid', g)}
                                data-testid={`screen-grid-${g}`}
                              >
                                <span
                                  className="grid-pick__thumb"
                                  style={{
                                    gridTemplateColumns: `repeat(${cols}, 1fr)`,
                                    gridTemplateRows: `repeat(${rows}, 1fr)`,
                                  }}
                                  aria-hidden
                                >
                                  {Array.from({ length: cols * rows }, (_, i) => (
                                    <i key={i} />
                                  ))}
                                </span>
                                <span className="grid-pick__label">
                                  <b>{cols * rows}</b>
                                  <small>
                                    {cols} × {rows}
                                  </small>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </Field>
                  )}
                  {current['client.ads_layout'] === 'full' && (
                    <Field label={t('settings.client.caption')} className="span-2">
                      {() => (
                        <Segmented
                          value={current['client.ads_caption']}
                          options={CLIENT_ADS_CAPTIONS.map((v) => ({
                            value: v,
                            label: t(`settings.client.captions.${v}`),
                          }))}
                          onChange={(v) => !ro && set('client.ads_caption', v)}
                          testId="screen-caption"
                        />
                      )}
                    </Field>
                  )}
                  <Field
                    label={t('settings.client.adsStyle')}
                    hint={t('settings.client.adsStyleHint')}
                    className="span-2"
                  >
                    {() => (
                      <Segmented
                        value={current['client.ads_style']}
                        options={CLIENT_ADS_STYLES.map((v) => ({
                          value: v,
                          label: t(`ads.styles.${v}`),
                        }))}
                        onChange={(v) => !ro && set('client.ads_style', v)}
                        testId="screen-style"
                      />
                    )}
                  </Field>
                  <Field label={t('settings.client.adsTransition')} className="span-2">
                    {() => (
                      <Segmented
                        value={current['client.ads_transition']}
                        options={CLIENT_ADS_TRANSITIONS.map((v) => ({
                          value: v,
                          label: t(`settings.client.transition.${v}`),
                        }))}
                        onChange={(v) => !ro && set('client.ads_transition', v)}
                      />
                    )}
                  </Field>
                  {number('client.ads_interval_seconds', t('settings.client.adsInterval'), {
                    min: 3,
                    max: 120,
                  })}
                  <Field
                    label={t('settings.client.imageFit')}
                    hint={t('settings.client.imageFitHint')}
                  >
                    {() => (
                      <Segmented
                        value={current['client.ads_image_fit']}
                        options={CLIENT_ADS_IMAGE_FITS.map((v) => ({
                          value: v,
                          label: t(`settings.client.fits.${v}`),
                        }))}
                        onChange={(v) => !ro && set('client.ads_image_fit', v)}
                        testId="screen-fit"
                      />
                    )}
                  </Field>
                  <div className="span-2 toggle-grid">
                    <div>{bool('client.ads_show_price', t('settings.client.adsShowPrice'))}</div>
                    <div data-testid="screen-show-category">
                      {bool('client.ads_show_category', t('settings.client.showCategory'))}
                    </div>
                    <div data-testid="screen-motion">
                      {bool(
                        'client.ads_motion',
                        t('settings.client.motion'),
                        t('settings.client.motionHint'),
                      )}
                    </div>
                    <div data-testid="screen-shuffle">
                      {bool(
                        'client.ads_shuffle',
                        t('settings.client.adsShuffle'),
                        t('settings.client.adsShuffleHint'),
                      )}
                    </div>
                    <div data-testid="screen-promo-countdown">
                      {bool(
                        'client.ads_promo_countdown',
                        t('settings.client.adsPromoCountdown'),
                        t('settings.client.adsPromoCountdownHint'),
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </Card>
            <Card
              title={t('settings.client.screenTitle')}
              subtitle={t('settings.client.screenHint')}
              testId="screen-card"
            >
              <div className="stack">
                <div data-testid="screen-fullscreen">
                  {bool(
                    'client.ads_fullscreen',
                    t('settings.client.fullscreen'),
                    t('settings.client.fullscreenHint'),
                  )}
                </div>
                <div className="toggle-grid">
                  <div data-testid="screen-show-clock">
                    {bool('client.ads_show_clock', t('settings.client.showClock'))}
                  </div>
                  <div data-testid="screen-show-brand">
                    {bool('client.ads_show_brand', t('settings.client.showBrand'))}
                  </div>
                  <div data-testid="screen-show-station">
                    {bool('client.ads_show_station', t('settings.client.showStation'))}
                  </div>
                  <div data-testid="screen-show-status">
                    {bool('client.ads_show_status', t('settings.client.showStatus'))}
                  </div>
                  <div data-testid="screen-show-progress">
                    {bool('client.ads_show_progress', t('settings.client.showProgress'))}
                  </div>
                </div>
                <Field
                  label={t('settings.client.background')}
                  hint={t('settings.client.backgroundHint')}
                >
                  {() => (
                    <div className="ad-themes" role="radiogroup" data-testid="screen-backgrounds">
                      {AD_THEMES.map((theme) => {
                        const on = current['client.ads_background'] === theme;
                        return (
                          <button
                            key={theme}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            className={`ad-theme ${on ? 'is-on' : ''}`}
                            title={t(`ads.themes.${theme}`)}
                            onClick={() => !ro && set('client.ads_background', theme)}
                            data-testid={`screen-background-${theme}`}
                          >
                            <span className="ad-theme__swatch" style={themeStyle(theme)}>
                              {on && <Check size={14} />}
                            </span>
                            <span className="ad-theme__label">{t(`ads.themes.${theme}`)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </Field>
                <Field
                  label={t('settings.client.ticker')}
                  hint={t('settings.client.tickerHint')}
                  error={errors['client.ads_ticker_text']}
                >
                  {(id, invalid) => (
                    <Input
                      id={id}
                      value={current['client.ads_ticker_text']}
                      maxLength={200}
                      placeholder={t('settings.client.tickerPlaceholder')}
                      onChange={(e) => set('client.ads_ticker_text', e.target.value)}
                      aria-invalid={invalid}
                      disabled={ro}
                      data-testid="screen-ticker"
                    />
                  )}
                </Field>
              </div>
            </Card>
          </div>
          <div className="client-screen__preview">
            <div className="muted" style={{ fontSize: 12.5 }}>
              {t('settings.client.previewSession')}
            </div>
            <ClientScreenPreview
              display={clientDisplayFromSettings(current)}
              businessName={current['business.name']}
              mode="session"
            />
            <div className="muted" style={{ fontSize: 12.5 }}>
              {t('settings.client.previewLockTitle')}
            </div>
            <ClientScreenPreview
              display={clientDisplayFromSettings(current)}
              businessName={current['business.name']}
              mode="locked"
            />
            <div className="faint" style={{ fontSize: 12 }}>
              {t('settings.client.previewNote')}
            </div>
          </div>
        </div>
      )}

      {tab === 'printing' && (
        <div className="stack">
          <Card title={t('settings.printing.receipts')}>
            <div className="form-grid">
              <Field
                label={t('settings.printing.receiptWidth')}
                error={errors['pos.receipt_width_mm']}
              >
                {(id) => (
                  <Select
                    id={id}
                    value={String(current['pos.receipt_width_mm'])}
                    onChange={(e) => set('pos.receipt_width_mm', Number(e.target.value) as 58 | 80)}
                    disabled={ro}
                  >
                    <option value="80">80 mm</option>
                    <option value="58">58 mm</option>
                  </Select>
                )}
              </Field>
              <div className="span-2">
                {bool(
                  'pos.auto_print_receipt',
                  t('settings.printing.autoPrint'),
                  t('settings.printing.autoPrintHint'),
                )}
              </div>
              {number('pos.auto_finish_seconds', t('settings.printing.autoFinish'), {
                min: 0,
                max: 60,
                hint: t('settings.printing.autoFinishHint'),
              })}
              <div className="span-2">
                {bool(
                  'pos.card_payments',
                  t('settings.printing.cardPayments'),
                  t('settings.printing.cardPaymentsHint'),
                )}
              </div>
              {number('pos.credit_default_days', t('settings.printing.creditDays'), {
                min: 0,
                max: 365,
                hint: t('settings.printing.creditDaysHint'),
              })}
              {text('business.receipt_footer', t('settings.business.receiptFooter'), {
                hint: t('settings.business.receiptFooterHint'),
                multiline: true,
                className: 'span-2',
              })}
            </div>
          </Card>
          <Card title={t('settings.printing.invoices')}>
            <Alert tone="info">{t('settings.printing.invoicesNote')}</Alert>
            <div className="form-grid" style={{ marginTop: 16 }}>
              {number('printing.invoice_due_days', t('settings.printing.dueDays'), {
                min: 0,
                max: 365,
                hint: t('settings.printing.dueDaysHint'),
              })}
              {text('printing.invoice_bank_details', t('settings.printing.bankDetails'), {
                hint: t('settings.printing.bankDetailsHint'),
                multiline: true,
                className: 'span-2',
              })}
              {text('printing.invoice_footer', t('settings.printing.invoiceFooter'), {
                hint: t('settings.printing.invoiceFooterHint'),
                multiline: true,
                className: 'span-2',
              })}
            </div>
          </Card>
        </div>
      )}

      {tab === 'security' && (
        <Card>
          <div className="form-grid">
            {number('security.session_hours', t('settings.security.sessionHours'), {
              min: 1,
              max: 168,
            })}
            {number('security.min_password_length', t('settings.security.minPassword'), {
              min: 4,
              max: 64,
            })}
            {number('security.max_failed_logins', t('settings.security.maxFailed'), {
              min: 3,
              max: 20,
            })}
            {number('security.lockout_minutes', t('settings.security.lockout'), {
              min: 1,
              max: 1440,
            })}
          </div>
        </Card>
      )}

      {tab === 'system' && (
        <>
          <LocalServerPanel />
          <div style={{ height: 16 }} />
          <Card>
            <Alert tone="info">{t('settings.system.note')}</Alert>
            <div className="form-grid" style={{ marginTop: 16 }}>
              <div className="span-2">
                {bool('backup.enabled', t('settings.system.backupEnabled'))}
              </div>
              {text('backup.time', t('settings.system.backupTime'), { type: 'time' })}
              {number('backup.keep_count', t('settings.system.keepCount'), { min: 1, max: 365 })}
              <Field label={t('settings.system.channel')} error={errors['updates.channel']}>
                {(id) => (
                  <Select
                    id={id}
                    value={current['updates.channel']}
                    onChange={(e) => set('updates.channel', e.target.value as 'stable' | 'beta')}
                    disabled={ro}
                  >
                    <option value="stable">stable</option>
                    <option value="beta">beta</option>
                  </Select>
                )}
              </Field>
              <Field
                label={t('settings.system.clientPolicy')}
                error={errors['updates.client_policy']}
              >
                {(id) => (
                  <Select
                    id={id}
                    value={current['updates.client_policy']}
                    onChange={(e) =>
                      set(
                        'updates.client_policy',
                        e.target.value as SettingsMap['updates.client_policy'],
                      )
                    }
                    disabled={ro}
                  >
                    {(['manual', 'idle_only', 'maintenance_window'] as const).map((p) => (
                      <option key={p} value={p}>
                        {t(`settings.system.clientPolicies.${p}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {text('updates.maintenance_window', t('settings.system.maintenanceWindow'))}
              <div className="span-2 stack">
                {bool('updates.check_on_startup', t('settings.system.checkOnStartup'))}
                {bool('updates.auto_download', t('settings.system.autoDownload'))}
              </div>
            </div>
          </Card>
        </>
      )}

      {tab === 'about' && (
        <>
          <UpdatePanel />
          <div style={{ height: 16 }} />
          <AboutPanel info={info.data} loading={info.isLoading} />
        </>
      )}
    </>
  );
}

function AboutPanel({ info, loading }: { info: SystemInfoResponse | undefined; loading: boolean }) {
  const { t } = useI18n();
  const fmt = useFormat();
  if (loading || !info) return <Loading />;
  const row = (label: string, value: ReactNode) => (
    <div
      className="row row--between"
      style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}
    >
      <span className="muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
  return (
    <div className="grid grid--2">
      <Card title={t('common.version')}>
        {row(t('settings.about.admin'), ADMIN_VERSION)}
        {row(t('settings.about.server'), info.serverVersion)}
        {row(t('settings.about.schema'), `v${info.schemaVersion}`)}
        {row(t('settings.about.protocol'), `v${info.protocolVersion} (admin v${PROTOCOL_VERSION})`)}
        {row(t('settings.about.uptime'), fmt.dateTime(info.startedAt))}
        {row(t('settings.about.dbLatency'), `${info.database.latencyMs} ms`)}
      </Card>
      <Card title={t('settings.about.connections')}>
        {row(t('settings.about.devicesOnline', { n: info.counts.devicesOnline }), '')}
        {row(t('settings.about.admins', { n: info.counts.adminConnections }), '')}
        {row(t('settings.about.stationsCount', { n: info.counts.stations }), '')}
        {row(t('settings.about.usersCount', { n: info.counts.users }), '')}
      </Card>
    </div>
  );
}
