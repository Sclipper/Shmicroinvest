import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_SKIN, SKIN_SETTING, skinFromSetting, type SkinId } from '@shmi/core';
import { api } from './api.ts';

/**
 * Skins (06 2.7) are CSS variable themes: `html[data-skin=...]` in index.css
 * redefines the Tailwind palette variables (brand, slate, ...). The default
 * skin sets no attribute, so its look is the plain theme.
 */
const CACHE = 'shmi.skin';

export function applySkin(id: SkinId, opts: { remember?: boolean } = {}) {
  const el = document.documentElement;
  if (id === DEFAULT_SKIN) delete el.dataset.skin;
  else el.dataset.skin = id;
  if (opts.remember) {
    try {
      localStorage.setItem(CACHE, id);
    } catch {
      // private mode: the skin is applied once the user settings load
    }
  }
}

/** Before the first render: the last user's skin, so a reload does not flash the default colours. */
export function applyCachedSkin() {
  try {
    applySkin(skinFromSetting(localStorage.getItem(CACHE)));
  } catch {
    // no storage
  }
}

export const USER_SETTINGS_KEY = ['settings', 'user'] as const;
export const useUserSettings = () => useQuery({ queryKey: USER_SETTINGS_KEY, queryFn: () => api.get<Record<string, string>>('/settings/user'), staleTime: 60_000 });

/** The signed-in user's saved skin (ApplicationSkin); signing out goes back to the default skin. */
export function UserSkin() {
  const q = useUserSettings();
  const saved = q.data?.[SKIN_SETTING];
  useEffect(() => {
    if (saved !== undefined) applySkin(skinFromSetting(saved), { remember: true });
  }, [saved]);
  useEffect(() => () => applySkin(DEFAULT_SKIN, { remember: true }), []);
  return null;
}
