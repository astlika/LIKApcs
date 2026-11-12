import { useSyncExternalStore } from 'react';

const subscribe = (notify: () => void) => {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
};

/** False when the phone knows it has no network. Money actions are blocked then. */
export const useOnline = (): boolean =>
  useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
