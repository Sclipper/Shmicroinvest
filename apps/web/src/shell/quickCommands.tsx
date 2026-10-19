import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * "Бързи команди" (FixedContextMenuView, 06 2.1): a screen publishes groups of
 * its commands for the left panel. The commands of the active tab are shown.
 */
export interface QuickCommand {
  label: string;
  run: () => void;
  disabled?: boolean;
  gesture?: string;
}
export interface QuickGroup {
  title: string;
  items: QuickCommand[];
}

interface Store {
  get: (tabKey: string) => QuickGroup[] | undefined;
  set: (tabKey: string, groups: QuickGroup[] | null) => void;
}

/** Stable setter/getter (screens), and a version bumped on visible changes (the panel). */
const StoreCtx = createContext<Store | null>(null);
const VersionCtx = createContext(0);
/** Key of the tab a screen is rendered in (provided by the shell around each tab pane). */
export const TabKeyContext = createContext<string | null>(null);

const signature = (groups: QuickGroup[]) => JSON.stringify(groups.map((g) => [g.title, g.items.map((i) => [i.label, !!i.disabled, i.gesture ?? ''])]));

export function QuickCommandsProvider({ children }: { children: ReactNode }) {
  const map = useRef(new Map<string, { groups: QuickGroup[]; sig: string }>());
  const [version, setVersion] = useState(0);
  const set = useCallback((key: string, groups: QuickGroup[] | null) => {
    const prev = map.current.get(key);
    if (!groups) {
      if (prev) {
        map.current.delete(key);
        setVersion((v) => v + 1);
      }
      return;
    }
    const sig = signature(groups);
    map.current.set(key, { groups, sig });
    // Only a visible change re-renders the panel; the latest closures are kept anyway.
    if (prev?.sig !== sig) setVersion((v) => v + 1);
  }, []);
  const get = useCallback((key: string) => map.current.get(key)?.groups, []);
  const value = useMemo(() => ({ get, set }), [get, set]);
  return (
    <StoreCtx.Provider value={value}>
      <VersionCtx.Provider value={version}>{children}</VersionCtx.Provider>
    </StoreCtx.Provider>
  );
}

/** Groups of a tab (re-renders the caller when any tab's commands change visibly). */
export function useQuickGroups(tabKey: string | null): QuickGroup[] | undefined {
  const store = useContext(StoreCtx);
  useContext(VersionCtx);
  return tabKey && store ? store.get(tabKey) : undefined;
}

/** Publishes the screen's quick commands while it is mounted. */
export function useQuickCommands(groups: QuickGroup[]) {
  const store = useContext(StoreCtx);
  const key = useContext(TabKeyContext);
  useEffect(() => {
    if (store && key) store.set(key, groups);
  });
  useEffect(() => () => {
    if (store && key) store.set(key, null);
  }, [store, key]);
}
