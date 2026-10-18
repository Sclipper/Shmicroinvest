import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import type { Account, Lookups, Session } from './types.ts';
import { compareAccountNumbers } from './format.ts';

export function useSessionQuery() {
  return useQuery({ queryKey: ['session'], queryFn: () => api.get<Session>('/session'), retry: false, staleTime: 60_000 });
}

/** Session for screens rendered inside the shell (always loaded there). */
export function useSession(): Session {
  const { data } = useSessionQuery();
  if (!data) throw new Error('No session');
  return data;
}

export function useCan() {
  const s = useSession();
  return (key?: string) => !key || s.permissions[key] !== false;
}

export function useLookups() {
  return useQuery({ queryKey: ['lookups'], queryFn: () => api.get<Lookups>('/lookups'), staleTime: 5 * 60_000 });
}

export function useAccounts() {
  const s = useSessionQuery();
  return useQuery({ queryKey: ['accounts', s.data?.year.year], queryFn: async () => (await api.get<Account[]>('/accounts')).sort((a, b) => compareAccountNumbers(a.number, b.number)), staleTime: 60_000, enabled: !!s.data });
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}
