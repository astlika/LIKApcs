import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { checkForUpdate, isDesktopApp, relaunchApp, type AvailableUpdate } from '../lib/updater';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'error';

interface UpdatesContextValue {
  supported: boolean;
  status: UpdateStatus;
  update: AvailableUpdate | null;
  /** 0–100 while downloading, null when the size is unknown. */
  progress: number | null;
  error: string | null;
  lastCheckedAt: Date | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
  relaunch: () => Promise<void>;
}

const UpdatesContext = createContext<UpdatesContextValue | null>(null);

/**
 * Holds the state of the in-app updater so the topbar badge and the Settings › About panel stay in
 * sync. In the desktop app one automatic check runs shortly after start-up; afterwards the user
 * drives it from Settings. Nothing is downloaded or installed without an explicit click.
 */
export function UpdatesProvider({
  children,
  autoCheck = true,
}: {
  children: ReactNode;
  autoCheck?: boolean;
}) {
  const supported = isDesktopApp();
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (!supported || busy.current) return;
    busy.current = true;
    setStatus('checking');
    setError(null);
    try {
      const found = await checkForUpdate();
      if (update) await update.dismiss().catch(() => undefined);
      setUpdate(found);
      setStatus(found ? 'available' : 'up-to-date');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
      setLastCheckedAt(new Date());
    }
  }, [supported, update]);

  const install = useCallback(async () => {
    if (!update || busy.current) return;
    busy.current = true;
    setStatus('downloading');
    setProgress(null);
    setError(null);
    try {
      await update.install((downloaded, total) => {
        setProgress(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
        if (total && downloaded >= total) setStatus('installing');
      });
      setStatus('installed');
      // On Windows the NSIS installer restarts the app itself; this is a fallback.
      window.setTimeout(() => void relaunchApp(), 1500);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
    }
  }, [update]);

  useEffect(() => {
    if (!supported || !autoCheck) return;
    const timer = window.setTimeout(() => void check(), 8_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, autoCheck]);

  const value = useMemo<UpdatesContextValue>(
    () => ({
      supported,
      status,
      update,
      progress,
      error,
      lastCheckedAt,
      check,
      install,
      relaunch: relaunchApp,
    }),
    [supported, status, update, progress, error, lastCheckedAt, check, install],
  );
  return <UpdatesContext.Provider value={value}>{children}</UpdatesContext.Provider>;
}

export function useUpdates(): UpdatesContextValue {
  const ctx = useContext(UpdatesContext);
  if (!ctx) throw new Error('useUpdates must be used inside UpdatesProvider');
  return ctx;
}
