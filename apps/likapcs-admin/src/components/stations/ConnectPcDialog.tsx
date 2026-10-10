import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, Check, Shield, ShieldAlert, ShieldCheck, Cpu } from 'lucide-react';
import type { NetworkInfoResponse } from '@likapcs/shared';
import { api, getServerUrl } from '../../lib/api';
import {
  allowFirewall,
  embeddedServerInfo,
  firewallStatus,
  type FirewallState,
} from '../../lib/desktop';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Alert, Button, Dialog } from '../ui/primitives';

export const RELEASES_URL = 'https://github.com/astlika/LIKApcs/releases/latest';

/**
 * Everything staff need to bring a gaming PC online, in one place: the address to type when
 * automatic discovery does not reach the PC, the Windows Firewall state of this main PC (the
 * usual reason a PC "cannot find the server") with a one-click fix, and the approval list.
 */
export function ConnectPcDialog({
  onClose,
  pendingPanel,
  pendingCount,
}: {
  onClose: () => void;
  /** The approval table (rendered by the Stations page so it shares its mutations). */
  pendingPanel: React.ReactNode;
  pendingCount: number;
}) {
  const { t } = useI18n();
  const network = useQuery({
    queryKey: ['system', 'network'],
    queryFn: () => api<NetworkInfoResponse>('/system/network'),
    staleTime: 30_000,
  });
  const serverPort = network.data?.port ?? portOf(getServerUrl());
  const addresses = network.data?.addresses ?? [];

  return (
    <Dialog open onClose={onClose} title={t('stations.connect.title')} size="xl">
      <div className="stack" style={{ gap: 18 }}>
        <ol className="connect-steps">
          <li>
            <strong>{t('stations.connect.step1')}</strong>
            <div className="muted">
              {t('stations.connect.step1Hint')} <code className="mono">{RELEASES_URL}</code>
            </div>
          </li>
          <li>
            <strong>{t('stations.connect.step2')}</strong>
            <div className="muted">{t('stations.connect.step2Hint')}</div>
            <div className="connect-addresses">
              {network.isLoading && <span className="muted">…</span>}
              {network.isError && (
                <span className="muted">{t('stations.connect.noAddresses')}</span>
              )}
              {addresses.map((ip, i) => (
                <AddressChip key={ip} value={`${ip}:${serverPort}`} primary={i === 0} />
              ))}
              {network.data && addresses.length === 0 && (
                <span className="muted">{t('stations.connect.noAddresses')}</span>
              )}
            </div>
            {network.data && !network.data.discoveryEnabled && (
              <div className="muted" style={{ marginTop: 6 }}>
                {t('stations.connect.discoveryOff')}
              </div>
            )}
          </li>
          <li>
            <strong>{t('stations.connect.step3')}</strong>
            <div className="muted">{t('stations.connect.step3Hint')}</div>
          </li>
        </ol>

        <FirewallCard />

        {pendingCount === 0 ? (
          <Alert tone="info" icon={<Cpu size={18} />}>
            <strong>{t('stations.pendingTitle')}</strong>
            <div className="muted">{t('stations.connect.noPending')}</div>
          </Alert>
        ) : (
          <div className="connect-pending">{pendingPanel}</div>
        )}
      </div>
    </Dialog>
  );
}

function portOf(url: string): number {
  try {
    const u = new URL(url);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return 4700;
  }
}

function AddressChip({ value, primary }: { value: string; primary: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the address is still visible */
    }
  };
  return (
    <button
      type="button"
      className={`connect-address${primary ? ' connect-address--primary' : ''}`}
      onClick={() => void copy()}
      title={t('stations.connect.copy')}
    >
      <span className="mono">{value}</span>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/**
 * Windows Firewall state of the main PC (only meaningful in the desktop app with the bundled
 * server). Shown inline here and as a banner on the Stations page while the rule is missing.
 */
export function useFirewall() {
  const [state, setState] = useState<FirewallState | 'n/a'>('n/a');
  const refresh = async () => {
    const info = await embeddedServerInfo();
    if (!info?.available) {
      setState('n/a');
      return;
    }
    setState(await firewallStatus());
  };
  useEffect(() => {
    void refresh();
  }, []);
  return { state, refresh };
}

/** `bannerOnly`: render nothing unless the rule is missing (used at the top of the Stations page). */
export function FirewallCard({ bannerOnly = false }: { bannerOnly?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const { state, refresh } = useFirewall();
  const allow = useMutation({
    mutationFn: allowFirewall,
    onSuccess: async () => {
      toast.success(t('settings.localServer.firewallOk'));
      await refresh();
    },
    onError: (err) =>
      toast.error(
        t('settings.localServer.firewallFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
  });
  if (state === 'n/a' || (bannerOnly && state !== 'missing')) return null;
  const tone = state === 'allowed' ? 'success' : state === 'missing' ? 'warning' : 'info';
  const Icon = state === 'allowed' ? ShieldCheck : state === 'missing' ? ShieldAlert : Shield;
  return (
    <Alert tone={tone} icon={<Icon size={18} />}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>
            {bannerOnly ? t('stations.firewallBanner') : t('stations.connect.firewall')}
          </strong>
          <div className="muted">
            {state === 'allowed'
              ? t('stations.connect.firewallAllowed')
              : state === 'missing'
                ? t('stations.connect.firewallMissing')
                : t('stations.connect.firewallUnknown')}
          </div>
        </div>
        {state !== 'allowed' && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => allow.mutate()}
            loading={allow.isPending}
          >
            <Shield size={14} /> {t('stations.connect.allowNow')}
          </Button>
        )}
      </div>
    </Alert>
  );
}
