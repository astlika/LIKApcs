import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './styles.css';
import { isNative } from './native';
import { applyPrefs, cachedPrefs } from './prefs';
import { unlockSound } from './sound';

// Use the last look of this phone right away (before the account's settings arrive).
applyPrefs(cachedPrefs());

// Browsers play sound only after a tap: the first tap unlocks the app's sounds.
window.addEventListener('pointerdown', unlockSound, { passive: true });

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

// The app shell works without a connection (see public/sw.js). Failure is not fatal.
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNative()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
