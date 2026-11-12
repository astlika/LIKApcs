import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@phone/styles.css';
import './tablet.css';
import { applyPrefs, cachedPrefs } from '@phone/prefs';
import { App } from './App';

// Use the last look of this tablet right away (before the account's settings arrive).
applyPrefs(cachedPrefs());

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
