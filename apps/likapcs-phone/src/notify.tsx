import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Tone = 'ok' | 'err' | 'info';
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

const NotifyContext = createContext<(text: string, tone?: Tone) => void>(() => undefined);

/** A short message at the top of the screen (success or failure of an action). */
export function NotifyProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const notify = useCallback((text: string, tone: Tone = 'ok') => {
    setToast({ id: Date.now(), text, tone });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  const value = useMemo(() => notify, [notify]);
  return (
    <NotifyContext.Provider value={value}>
      {children}
      {toast && (
        <div key={toast.id} className={`toast toast--${toast.tone}`} role="status">
          {toast.text}
        </div>
      )}
    </NotifyContext.Provider>
  );
}

export const useNotify = () => useContext(NotifyContext);
