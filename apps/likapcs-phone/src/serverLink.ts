/**
 * Is the LIKApcs Server reachable from this phone? The header shows it, so the staff know
 * when a sale is only being kept on the phone. Checked every 20 seconds and when the network changes.
 */
import { useEffect, useState } from 'react';
import { apiOrigin } from './native';

const CHECK_MS = 20_000;

export type ServerLink = 'checking' | 'ok' | 'down' | 'no-network';

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${apiOrigin()}/api/v1/system/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function useServerLink(): ServerLink {
  const [link, setLink] = useState<ServerLink>('checking');

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setLink('no-network');
        return;
      }
      const ok = await reachable();
      if (!stopped) setLink(ok ? 'ok' : 'down');
    };
    const onNetwork = () => void check();
    void check();
    const timer = window.setInterval(check, CHECK_MS);
    window.addEventListener('online', onNetwork);
    window.addEventListener('offline', onNetwork);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('online', onNetwork);
      window.removeEventListener('offline', onNetwork);
    };
  }, []);

  return link;
}
