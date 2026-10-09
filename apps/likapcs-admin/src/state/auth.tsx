import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthenticatedUser, LoginResponse, PermissionCode } from '@likapcs/shared';
import { api, ApiError, getToken, setToken, setUnauthorizedHandler } from '../lib/api';

interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated';
  user: AuthenticatedUser | null;
  permissions: Set<string>;
  /** Set when the session was ended by the server (expired/revoked) — shown on the login page. */
  expiredNotice: boolean;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<AuthenticatedUser>;
  acceptSession: (session: LoginResponse) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (...codes: PermissionCode[]) => boolean;
  clearExpiredNotice: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    user: null,
    permissions: new Set(),
    expiredNotice: false,
  });

  const applyUser = useCallback((user: AuthenticatedUser | null, expiredNotice = false) => {
    setState({
      status: user ? 'authenticated' : 'anonymous',
      user,
      permissions: new Set(user?.permissions ?? []),
      expiredNotice,
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) return applyUser(null);
    try {
      applyUser(await api<AuthenticatedUser>('/auth/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        applyUser(null, true);
      } else {
        // Network problem: keep whatever we have, surface via server status indicator.
        setState((s) => (s.status === 'loading' ? { ...s, status: 'anonymous' } : s));
      }
    }
  }, [applyUser]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      applyUser(null, true);
    });
    void refresh();
    return () => setUnauthorizedHandler(null);
  }, [refresh, applyUser]);

  const acceptSession = useCallback(
    (session: LoginResponse) => {
      setToken(session.token);
      applyUser(session.user);
    },
    [applyUser],
  );

  const login = useCallback(
    async (username: string, password: string) => {
      const session = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { username, password },
        auth: false,
      });
      acceptSession(session);
      return session.user;
    },
    [acceptSession],
  );

  const logout = useCallback(async () => {
    try {
      await api<void>('/auth/logout', { method: 'POST' });
    } catch {
      /* token may already be invalid */
    }
    setToken(null);
    applyUser(null);
  }, [applyUser]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      login,
      acceptSession,
      logout,
      refresh,
      can: (...codes) => codes.every((c) => state.permissions.has(c)),
      clearExpiredNotice: () => setState((s) => ({ ...s, expiredNotice: false })),
    }),
    [state, login, acceptSession, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
