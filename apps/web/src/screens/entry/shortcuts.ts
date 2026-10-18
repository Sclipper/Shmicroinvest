import { useQuery } from '@tanstack/react-query';
import { DEFAULT_SHORTCUTS } from '@shmi/core';
import { api } from '../../api.ts';
import { gestureOf } from '../../shell/menu.ts';

/** Shortcut row as returned by GET /settings/shortcuts (06 2.6). */
export interface ShortcutRow {
  id: string;
  label: string;
  type: string;
  gesture: string;
  default: string;
}

const MODIFIERS = ['Ctrl', 'Alt', 'Shift'];

/** Canonical form matching shell/menu gestureOf: modifiers Ctrl, Alt, Shift then the key. */
export function normalizeGesture(g: string): string {
  const parts = g.replace(/\s/g, '').split('+').filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

export function useShortcutRows() {
  return useQuery({ queryKey: ['shortcuts'], queryFn: () => api.get<{ rows: ShortcutRow[] }>('/settings/shortcuts'), staleTime: 5 * 60_000 });
}

/**
 * Window shortcuts with the user's overrides. `match(event, ids)` returns the
 * first id of `ids` bound to the pressed gesture (several commands may share a
 * gesture in different windows, so each window asks only for its own ids).
 */
export function useShortcuts() {
  const q = useShortcutRows();
  const rows = q.data?.rows ?? DEFAULT_SHORTCUTS.map((d) => ({ ...d, default: d.gesture }));
  const byId = new Map(rows.map((r) => [r.id, r.gesture ? normalizeGesture(r.gesture) : '']));
  return {
    gesture: (id: string) => byId.get(id) ?? '',
    match(e: KeyboardEvent | React.KeyboardEvent, ids: readonly string[]): string | null {
      const native = 'nativeEvent' in e ? e.nativeEvent : e;
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(native.key)) return null;
      const g = gestureOf(native);
      return ids.find((id) => byId.get(id) === g) ?? null;
    },
  };
}
