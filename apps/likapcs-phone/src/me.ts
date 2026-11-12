import { useQuery } from '@tanstack/react-query';
import type { AuthenticatedUser } from '@likapcs/shared';
import { api } from './api';

/** The signed-in user and their permissions. Fresh on every sign-in. */
export function useMe(enabled: boolean) {
  return useQuery({
    queryKey: ['phone', 'me'],
    queryFn: () => api<AuthenticatedUser>('/auth/me'),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export const can = (user: AuthenticatedUser | undefined, permission: string): boolean =>
  Boolean(user?.permissions.includes(permission));
