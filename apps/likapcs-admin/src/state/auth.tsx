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
import { PERMISSIONS_CHANGED_EVENT } from '../lib/ws';

interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated';
  user: AuthenticatedUser | null;
  permissions: Set<string>;
  /** Set when the session was ended by the server (expired/revoked) — shown on the login page. */
  expiredNotice: boolean;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string, remember?: boolean) => Promise<AuthenticatedUser>;
  acceptSession: (session: LoginResponse, remember?: boolean) => void;
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
    const onPermissionsChanged = () => void refresh();
    window.addEventListener(PERMISSIONS_CHANGED_EVENT, onPermissionsChanged);
    return () => {
      setUnauthorizedHandler(null);
      window.removeEventListener(PERMISSIONS_CHANGED_EVENT, onPermissionsChanged);
    };
  }, [refresh, applyUser]);

  const acceptSession = useCallback(
    (session: LoginResponse, remember = false) => {
      setToken(session.token, { remember });
      applyUser(session.user);
    },
    [applyUser],
  );

  /**
   * `remember` = "Stay signed in on this PC": the server issues a long-lived session and the
   * token is kept in persistent storage; otherwise it only lives until the app is closed.
   */
  const login = useCallback(
    async (username: string, password: string, remember = false) => {
      const session = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { username, password, rememberMe: remember },
        auth: false,
      });
      acceptSession(session, remember);
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
