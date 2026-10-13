/**
 * Settings › POS › Customer display (0.16.0). A per-PC choice, kept in this PC's localStorage
 * (not a business setting): whether the second window opens with the app and on which monitor.
 * The buttons open / close it right away so the owner sees the result while choosing.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MonitorPlay, MonitorX } from 'lucide-react';
import {
  closeCustomerDisplay,
  displayMonitors,
  loadDisplayPrefs,
  openCustomerDisplay,
  saveDisplayPrefs,
  type DisplayPrefs,
  type MonitorInfo,
} from '../../lib/customer-display';
import { isDesktopApp } from '../../lib/updater';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { useCustomerDisplay } from '../../state/customer-display';
import { Badge, Button, Card, Field, Select, Switch } from '../ui/primitives';

function monitorLabel(
  m: MonitorInfo,
  index: number,
  t: (
    key:
      | 'settings.display.landscape'
      | 'settings.display.portrait'
      | 'settings.display.monitorCurrent',
  ) => string,
): string {
  const orientation =
    m.height > m.width ? t('settings.display.portrait') : t('settings.display.landscape');
  const name = m.name.replace(/^[\\.]+/, '') || `#${index + 1}`;
  return `${name} — ${m.width}×${m.height} ${orientation}${m.current ? ` · ${t('settings.display.monitorCurrent')}` : ''}`;
}

export function CustomerDisplayCard() {
  const { t } = useI18n();
  const toast = useToast();
  const { connected } = useCustomerDisplay();
  const desktop = isDesktopApp();
  const [prefs, setPrefs] = useState<DisplayPrefs>(() => loadDisplayPrefs());
  const [busy, setBusy] = useState(false);
  const monitors = useQuery({
    queryKey: ['display', 'monitors'],
    queryFn: displayMonitors,
    enabled: desktop,
    staleTime: 10_000,
  });
  useEffect(() => saveDisplayPrefs(prefs), [prefs]);

  const open = async () => {
    setBusy(true);
    try {
      const fullscreen = await openCustomerDisplay(prefs.monitor);
      toast.success(
        fullscreen ? t('settings.display.opened') : t('settings.display.openedPreview'),
      );
    } catch {
      toast.error(t('settings.display.failed'));
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    setBusy(true);
    try {
      await closeCustomerDisplay();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t('settings.display.title')}
      subtitle={t('settings.display.subtitle')}
      testId="settings-display-card"
      actions={
        connected ? (
          <Badge tone="success">{t('settings.display.connected')}</Badge>
        ) : (
          <Badge tone="default">{t('settings.display.notConnected')}</Badge>
        )
      }
    >
      <div className="form-grid" data-testid="settings-display">
        <div className="span-2">
          <Switch
            checked={prefs.enabled}
            onChange={(enabled) => {
              setPrefs((p) => ({ ...p, enabled }));
              if (enabled) void open();
              else void close();
            }}
            label={
              <span>
                {t('settings.display.enabled')}
                <div className="faint" style={{ fontSize: 12 }}>
                  {t('settings.display.enabledHint')}
                </div>
              </span>
            }
            testId="display-enabled"
          />
        </div>
        <Field label={t('settings.display.monitor')} hint={t('settings.display.monitorHint')}>
          {(id) => (
            <Select
              id={id}
              value={prefs.monitor}
              onChange={(e) => setPrefs((p) => ({ ...p, monitor: e.target.value }))}
              disabled={!desktop}
              data-testid="display-monitor"
            >
              <option value="">{t('settings.display.monitorAuto')}</option>
              {(monitors.data ?? []).map((m, i) => (
                <option key={`${m.name}-${i}`} value={m.name}>
                  {monitorLabel(m, i, t)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Button onClick={() => void open()} loading={busy} data-testid="display-open">
            <MonitorPlay size={16} /> {t('settings.display.open')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => void close()}
            disabled={busy}
            data-testid="display-close"
          >
            <MonitorX size={16} /> {t('settings.display.close')}
          </Button>
        </div>
        {!desktop && (
          <p className="faint span-2" style={{ margin: 0 }}>
            {t('settings.display.browserHint')}
          </p>
        )}
      </div>
    </Card>
  );
}
