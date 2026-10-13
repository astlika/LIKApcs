/**
 * Enter anywhere in a dialog (outside text fields) runs `submit`. Keyboard events older than the
 * dialog are ignored, so the Enter that opened it can never also confirm it. Text fields keep
 * their own Enter handling (the cash field submits itself; pickers select).
 */
import { useEffect, useRef } from 'react';
import { isEditableElement } from './scanner';

export function useEnterSubmits(submit: () => void) {
  const openedAt = useRef(performance.now());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.timeStamp <= openedAt.current) return;
      if (e.key === 'Enter' && !e.repeat && !isEditableElement(e.target as Element)) {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
}
