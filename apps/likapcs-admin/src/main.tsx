import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './lib/api';
import { storage } from './lib/storage';
import { I18nProvider } from './i18n';
import { ToastProvider } from './state/toast';
import { AuthProvider } from './state/auth';
import { AppSettingsProvider } from './state/app-settings';
import { App } from './App';
import './styles/app.css';

// Apply the persisted theme before the first paint to avoid a flash.
document.documentElement.dataset.theme = storage.get('theme') ?? 'dark';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      // Never retry auth/validation failures; retry network blips a little.
      retry: (failureCount, error) =>
        error instanceof ApiError && !error.isNetwork ? false : failureCount < 2,
    },
    mutations: { retry: false },
  },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ToastProvider>
          <AuthProvider>
            <AppSettingsProvider>
              <HashRouter>
                <App />
              </HashRouter>
            </AppSettingsProvider>
          </AuthProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
