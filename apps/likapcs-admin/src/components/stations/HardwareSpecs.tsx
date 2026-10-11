/**
 * PC hardware at a glance. Facts come from the client (`station_devices.hardware`, sent with the
 * hello) and the live load from the server's presence table (last heartbeat). Anything the PC did
 * not report is shown as "—" — nothing is guessed.
 */
import type { StationDeviceSummary } from '@likapcs/shared';
import { Cpu } from 'lucide-react';
import { useI18n } from '../../i18n';

/** "Intel(R) Core(TM) i5-12400F CPU @ 2.50GHz" → "i5-12400F"; "AMD Ryzen 5 5600X 6-Core Processor" → "Ryzen 5 5600X". */
export function shortCpu(name: string): string {
  let s = name
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\b(Intel|AMD|CPU|Processor|Core|Genuine|with Radeon Graphics)\b/gi, ' ')
    .replace(/\d+-Core/gi, ' ')
    .replace(/@.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^\d+(th|nd|rd|st) Gen/i.test(s)) s = s.replace(/^\d+(th|nd|rd|st) Gen\s*/i, '');
  return s || name;
}

/** "NVIDIA GeForce RTX 3060" → "RTX 3060"; "AMD Radeon RX 6600" → "RX 6600"; "Intel(R) UHD Graphics 730" → "UHD 730". */
export function shortGpu(name: string): string {
  const s = name
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\b(NVIDIA|GeForce|AMD|ATI|Radeon|Intel|Graphics|Microsoft)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || name;
}

/** The dedicated card first (a PC with an iGPU + a discrete card should read "RTX 3060"). */
export function primaryGpu(gpus: string[]): string | null {
  if (gpus.length === 0) return null;
  const discrete = gpus.find((g) => /(RTX|GTX|Radeon RX|Arc|Quadro|RX \d)/i.test(g));
  return discrete ?? gpus[0] ?? null;
}

const gb = (mb: number) => (mb >= 1024 * 10 ? Math.round(mb / 1024) : Math.round(mb / 102.4) / 10);

/** One compact line: "i5-12400F · RTX 3060 · 7.9/16 GB · 45 °C · 12 % CPU". */
export function HardwareStrip({ device }: { device: StationDeviceSummary }) {
  const { t } = useI18n();
  const hw = device.hardware;
  const live = device.online ? device.metrics : null;
  const gpu = hw ? primaryGpu(hw.gpus) : null;
  const ramTotal = live?.memoryTotalMb ?? hw?.ramTotalMb ?? null;
  const parts: string[] = [];
  parts.push(hw?.cpu ? shortCpu(hw.cpu) : '—');
  parts.push(gpu ? shortGpu(gpu) : '—');
  if (live?.memoryUsedMb != null && ramTotal)
    parts.push(`${gb(live.memoryUsedMb)}/${gb(ramTotal)} GB`);
  else parts.push(ramTotal ? `${gb(ramTotal)} GB` : '—');
  const temp = live?.cpuTempC ?? live?.gpuTempC ?? null;
  parts.push(temp != null ? `${Math.round(temp)} °C` : '—');
  parts.push(live?.cpuPercent != null ? `${Math.round(live.cpuPercent)} % CPU` : '—');
  return (
    <span className="hw-strip" data-testid="hw-strip" title={t('stations.hw.title')}>
      <Cpu size={13} />
      {parts.map((p, i) => (
        <span key={i} className={p === '—' ? 'hw-strip__na' : undefined}>
          {p}
        </span>
      ))}
    </span>
  );
}

function Bar({ fraction, tone }: { fraction: number; tone: 'ok' | 'warn' | 'hot' }) {
  return (
    <span className={`hw-bar hw-bar--${tone}`} aria-hidden>
      <i style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }} />
    </span>
  );
}

const tempTone = (c: number): 'ok' | 'warn' | 'hot' => (c >= 85 ? 'hot' : c >= 70 ? 'warn' : 'ok');
const loadTone = (p: number): 'ok' | 'warn' | 'hot' => (p >= 90 ? 'hot' : p >= 70 ? 'warn' : 'ok');

/** Full specification block for the station detail dialog. */
export function HardwareDetails({ device }: { device: StationDeviceSummary }) {
  const { t } = useI18n();
  const hw = device.hardware;
  const live = device.online ? device.metrics : null;
  if (!hw && !live) {
    return (
      <div className="faint" style={{ fontSize: 12 }} data-testid="hw-details">
        {t('stations.hw.unknown')}
      </div>
    );
  }
  const ramTotal = live?.memoryTotalMb ?? hw?.ramTotalMb ?? null;
  const ramFraction = live?.memoryUsedMb != null && ramTotal ? live.memoryUsedMb / ramTotal : null;
  const diskUsedFraction =
    live?.diskFreeMb != null && hw?.diskTotalMb
      ? (hw.diskTotalMb - live.diskFreeMb) / hw.diskTotalMb
      : null;
  return (
    <div className="hw" data-testid="hw-details">
      <div className="hw__row">
        <span className="muted">{t('stations.hw.cpu')}</span>
        <span className="hw__value" title={hw?.cpu ?? undefined}>
          {hw?.cpu ? shortCpu(hw.cpu) : '—'}
          {hw?.cpuCores || hw?.cpuThreads ? (
            <small className="faint">
              {' '}
              {[hw.cpuCores ? `${hw.cpuCores}C` : null, hw.cpuThreads ? `${hw.cpuThreads}T` : null]
                .filter(Boolean)
                .join('/')}
            </small>
          ) : null}
        </span>
      </div>
      <div className="hw__row">
        <span className="muted">{t('stations.hw.gpu')}</span>
        <span className="hw__value" title={hw?.gpus.join(', ') || undefined}>
          {hw && hw.gpus.length > 0 ? hw.gpus.map(shortGpu).join(' + ') : '—'}
        </span>
      </div>
      <div className="hw__row">
        <span className="muted">{t('stations.hw.ram')}</span>
        <span className="hw__value">
          {live?.memoryUsedMb != null && ramTotal
            ? `${gb(live.memoryUsedMb)} / ${gb(ramTotal)} GB`
            : ramTotal
              ? `${gb(ramTotal)} GB`
              : '—'}
          {ramFraction !== null && (
            <Bar fraction={ramFraction} tone={loadTone(ramFraction * 100)} />
          )}
        </span>
      </div>
      <div className="hw__row">
        <span className="muted">{t('stations.hw.disk')}</span>
        <span className="hw__value">
          {hw?.diskTotalMb
            ? live?.diskFreeMb != null
              ? t('stations.hw.diskFree', {
                  free: String(gb(live.diskFreeMb)),
                  total: String(gb(hw.diskTotalMb)),
                })
              : `${gb(hw.diskTotalMb)} GB`
            : '—'}
          {diskUsedFraction !== null && (
            <Bar fraction={diskUsedFraction} tone={loadTone(diskUsedFraction * 100)} />
          )}
        </span>
      </div>
      <div className="hw__row">
        <span className="muted">{t('stations.hw.load')}</span>
        <span className="hw__value">
          {live?.cpuPercent != null ? `${Math.round(live.cpuPercent)} %` : '—'}
          {live?.cpuPercent != null && (
            <Bar fraction={live.cpuPercent / 100} tone={loadTone(live.cpuPercent)} />
          )}
        </span>
      </div>
      <div className="hw__row">
        <span className="muted">{t('stations.hw.temp')}</span>
        <span className="hw__value">
          {live?.cpuTempC != null || live?.gpuTempC != null ? (
            <>
              {live.cpuTempC != null && (
                <span className={`hw-temp hw-temp--${tempTone(live.cpuTempC)}`}>
                  CPU {Math.round(live.cpuTempC)} °C
                </span>
              )}
              {live.gpuTempC != null && (
                <span className={`hw-temp hw-temp--${tempTone(live.gpuTempC)}`}>
                  GPU {Math.round(live.gpuTempC)} °C
                </span>
              )}
            </>
          ) : (
            '—'
          )}
        </span>
      </div>
      {hw?.os && (
        <div className="hw__row">
          <span className="muted">{t('stations.hw.os')}</span>
          <span className="hw__value" title={hw.os}>
            {hw.os}
          </span>
        </div>
      )}
    </div>
  );
}
