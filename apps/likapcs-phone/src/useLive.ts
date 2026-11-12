import { useQuery } from '@tanstack/react-query';

/**
 * Live data: refetched every 15 s, when the phone comes back to the foreground, and when the
 * connection returns. Money and PC status are never cached on the phone for long.
 */
export function useLive<T>(key: unknown[], fetcher: () => Promise<T>) {
  return useQuery({
    queryKey: ['phone', ...key],
    queryFn: fetcher,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 0,
    retry: 1,
  });
}
