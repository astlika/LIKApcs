import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Deep link from the command palette: `?open=<id>` (or any other name) hands the id to the page
 * exactly once and is stripped from the URL right away, so refresh / back do not reopen it.
 */
export function useOpenParam(name: string, onOpen: (id: string) => void): void {
  const [params, setParams] = useSearchParams();
  const value = params.get(name);
  const handler = useRef(onOpen);
  useEffect(() => {
    handler.current = onOpen;
  });
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!value || handled.current === value) return;
    handled.current = value;
    handler.current(value);
    const next = new URLSearchParams(params);
    next.delete(name);
    setParams(next, { replace: true });
  }, [value, name, params, setParams]);
}
