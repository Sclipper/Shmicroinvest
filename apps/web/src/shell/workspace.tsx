import { createContext, useCallback, useContext, useMemo, useState, type ComponentType, type ReactNode } from 'react';

export interface Tab {
  key: string;
  screen: string;
  title: string;
  params?: Record<string, unknown>;
  dirty?: boolean;
  /** Question asked when a dirty tab is closed (default: lose unsaved data?). */
  dirtyMessage?: string;
}

export interface ScreenProps {
  tab: Tab;
}

export interface ScreenDef {
  id: string;
  title: string;
  component: ComponentType<ScreenProps>;
  /** Permission key from the role tree (spec 06 1.3). */
  permission?: string;
  /** Several instances allowed (e.g. entry editors); otherwise a single tab is reused. */
  multi?: boolean;
}

interface WorkspaceApi {
  tabs: Tab[];
  active: string | null;
  open: (screen: string, opts?: { params?: Record<string, unknown>; key?: string; title?: string }) => void;
  close: (key: string) => void;
  closeAll: (exceptKey?: string) => void;
  activate: (key: string) => void;
  update: (key: string, patch: Partial<Pick<Tab, 'title' | 'dirty' | 'dirtyMessage' | 'params'>>) => void;
}

const Ctx = createContext<WorkspaceApi | null>(null);
let seq = 0;

export function WorkspaceProvider({ screens, children, initial }: { screens: Record<string, ScreenDef>; children: ReactNode; initial?: Tab[] }) {
  const [tabs, setTabs] = useState<Tab[]>(initial ?? []);
  const [active, setActive] = useState<string | null>(initial?.[0]?.key ?? null);

  const open = useCallback<WorkspaceApi['open']>((screen, opts = {}) => {
    const def = screens[screen];
    if (!def) return;
    const key = opts.key ?? (def.multi ? `${screen}:${++seq}` : screen);
    setTabs((ts) => {
      const existing = ts.find((t) => t.key === key);
      if (existing) return opts.params ? ts.map((t) => (t.key === key ? { ...t, params: opts.params } : t)) : ts;
      return [...ts, { key, screen, title: opts.title ?? def.title, params: opts.params }];
    });
    setActive(key);
  }, [screens]);

  const close = useCallback((key: string) => {
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.key === key);
      const next = ts.filter((t) => t.key !== key);
      setActive((a) => (a === key ? (next[Math.max(0, i - 1)]?.key ?? null) : a));
      return next;
    });
  }, []);

  const closeAll = useCallback((exceptKey?: string) => {
    setTabs((ts) => ts.filter((t) => t.key === exceptKey));
    setActive(exceptKey ?? null);
  }, []);

  const update = useCallback<WorkspaceApi['update']>((key, patch) => {
    setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }, []);

  const value = useMemo(() => ({ tabs, active, open, close, closeAll, activate: setActive, update }), [tabs, active, open, close, closeAll, update]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace() {
  const c = useContext(Ctx);
  if (!c) throw new Error('WorkspaceProvider missing');
  return c;
}
