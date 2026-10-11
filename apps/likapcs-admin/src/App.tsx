import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldOff } from 'lucide-react';
import { PERMISSIONS, type PermissionCode, type SetupStatusResponse } from '@likapcs/shared';
import { api } from './lib/api';
import { initFullscreen, isFullscreenKey, toggleFullscreen } from './lib/fullscreen';
import { useAuth } from './state/auth';
import { useI18n } from './i18n';
import { Card, EmptyState, Loading } from './components/ui/primitives';
import { AppShell } from './components/layout/AppShell';
import { ServerGate } from './components/ServerGate';
import { LoginPage } from './pages/LoginPage';
import { SetupPage } from './pages/SetupPage';
import { DashboardPage } from './pages/DashboardPage';
import { StationsPage } from './pages/StationsPage';
import { PricingPage } from './pages/PricingPage';
import { EmployeesPage } from './pages/EmployeesPage';
import { SettingsPage } from './pages/SettingsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { PosPage } from './pages/PosPage';
import { SalesPage } from './pages/SalesPage';
import { ProductsPage } from './pages/ProductsPage';
import { CashPage } from './pages/CashPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { SuppliersPage } from './pages/SuppliersPage';
import { BackupsPage } from './pages/BackupsPage';
import { UpdatesPage } from './pages/UpdatesPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { CustomersPage } from './pages/CustomersPage';
import { ReportsPage } from './pages/ReportsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ShiftGuardProvider } from './state/shift-guard';
import { PosCartProvider } from './state/pos-cart';

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

/** Where "/" lands for staff who may not see the dashboard — first page they are allowed to use. */
const HOME_FALLBACKS: [PermissionCode, string][] = [
  [PERMISSIONS.STATIONS_VIEW, '/stations'],
  [PERMISSIONS.POS_SELL, '/pos'],
  [PERMISSIONS.CASH_VIEW, '/cash'],
  [PERMISSIONS.PRODUCTS_VIEW, '/products'],
  [PERMISSIONS.PURCHASES_VIEW, '/purchases'],
  [PERMISSIONS.CUSTOMERS_VIEW, '/customers'],
  [PERMISSIONS.INVOICES_VIEW, '/invoices'],
  [PERMISSIONS.EXPENSES_VIEW, '/expenses'],
  [PERMISSIONS.REPORTS_VIEW, '/reports'],
  [PERMISSIONS.USERS_VIEW, '/employees'],
  [PERMISSIONS.SETTINGS_VIEW, '/settings'],
  [PERMISSIONS.AUDIT_VIEW, '/audit'],
];

function HomeRoute() {
  const { can } = useAuth();
  const { t } = useI18n();
  if (can(PERMISSIONS.DASHBOARD_VIEW)) return <DashboardPage />;
  const fallback = HOME_FALLBACKS.find(([permission]) => can(permission));
  if (fallback) return <Navigate to={fallback[1]} replace />;
  return (
    <Card>
      <EmptyState
        icon={<ShieldOff size={24} />}
        title={t('common.noAccessTitle')}
        hint={t('common.noAccessHint')}
      />
    </Card>
  );
}

/** F11 / F12 toggle whole-app full screen on every screen, including sign-in. */
function useFullscreenShortcut() {
  useEffect(() => {
    const stop = initFullscreen();
    const onKey = (e: KeyboardEvent) => {
      if (!isFullscreenKey(e)) return;
      e.preventDefault();
      void toggleFullscreen().catch(() => undefined);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      stop();
      document.removeEventListener('keydown', onKey);
    };
  }, []);
}

export function App() {
  useFullscreenShortcut();
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
              <ShiftGuardProvider>
                <PosCartProvider>
                  <AppShell />
                </PosCartProvider>
              </ShiftGuardProvider>
            </RequireAuth>
          }
        >
          <Route index element={<HomeRoute />} />
          <Route path="stations" element={<StationsPage />} />
          <Route path="pos" element={<PosPage />} />
          <Route path="sales" element={<SalesPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="purchases" element={<PurchasesPage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="cash" element={<CashPage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="pricing" element={<PricingPage />} />
          <Route path="employees" element={<EmployeesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="updates" element={<UpdatesPage />} />
          <Route path="invoices" element={<InvoicesPage />} />
          <Route path="audit" element={<AuditLogPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </ServerGate>
  );
}
