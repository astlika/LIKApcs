import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { SetupStatusResponse } from '@likapcs/shared';
import { api } from './lib/api';
import { useAuth } from './state/auth';
import { useI18n } from './i18n';
import { Loading } from './components/ui/primitives';
import { AppShell } from './components/layout/AppShell';
import { ServerGate } from './components/ServerGate';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { DashboardPage } from './pages/DashboardPage';
import { StationsPage } from './pages/StationsPage';
import { EmployeesPage } from './pages/EmployeesPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { NotFoundPage } from './pages/NotFoundPage';

/** Redirects anonymous visitors to /login (or /setup on a fresh server). */
function RequireAuth({ children }: { children: JSX.Element }) {
  const auth = useAuth();
  const location = useLocation();
  const setup = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<SetupStatusResponse>('/system/setup-status', { auth: false }),
    enabled: auth.status === 'anonymous',
    retry: false,
    staleTime: 30_000,
  });
  if (auth.status === 'loading') return <Loading />;
  if (auth.status === 'anonymous') {
    if (setup.isLoading) return <Loading />;
    if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return children;
}

export function App() {
  const { t } = useI18n();
  useEffect(() => {
    document.title = t('app.name');
  }, [t]);

  return (
    <ServerGate>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="stations" element={<StationsPage />} />
          <Route path="employees" element={<EmployeesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="audit" element={<AuditLogPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </ServerGate>
  );
}
