/**
 * 0.32.0 — the stations layout (View ▼) for this account. It is saved on the account (so the same
 * username sees the same layout on any screen) and kept in the browser so the page opens right away.
 */
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { storage } from '../../lib/storage';
import {
  DEFAULT_BOARD_VIEW,
  isBoardView,
  type BoardView,
} from '../../lib/station-board';

const LOCAL_KEY = 'stationsView';

export function useBoardView(): [BoardView, (view: BoardView) => void] {
  const [view, setLocal] = useState<BoardView>(() => {
    const saved = storage.get(LOCAL_KEY);
    return isBoardView(saved) ? saved : DEFAULT_BOARD_VIEW;
  });
  const prefs = useQuery({
    queryKey: ['auth', 'preferences'],
    queryFn: () => api<{ stationsView?: string }>('/auth/preferences'),
    staleTime: Infinity,
  });
  useEffect(() => {
    const fromAccount = prefs.data?.stationsView;
    if (isBoardView(fromAccount)) {
      setLocal(fromAccount);
      storage.set(LOCAL_KEY, fromAccount);
    }
  }, [prefs.data]);

  const save = useMutation({
    mutationFn: (next: BoardView) =>
      api('/auth/preferences', { method: 'PUT', body: { stationsView: next } }),
  });
  const set = useCallback(
    (next: BoardView) => {
      setLocal(next);
      storage.set(LOCAL_KEY, next);
      save.mutate(next);
    },
    [save],
  );
  return [view, set];
}
