import type { ValidationMessage } from './journal.ts';

/**
 * Skins ("Визуален стил", spec 06 2.7). Delta ships nine internal skins in
 * Framework.Core; the setting `ApplicationSkin` holds the chosen one. The web
 * rebuild stores the skin id per user (Configuration row with UserID) and
 * paints it with CSS variable themes.
 */
export const SKINS = [
  { id: 'default', name: 'Default' },
  { id: 'cherrymint', name: 'Cherry Mint' },
  { id: 'forestmist', name: 'Forest Mist' },
  { id: 'ladypink', name: 'Lady Pink' },
  { id: 'limetree', name: 'Lime Tree' },
  { id: 'moonlight', name: 'Moonlight' },
  { id: 'moonlightversionexperimental', name: 'Moonlight (Experimental)' },
  { id: 'sunset', name: 'Sunset' },
  { id: 'violetlane', name: 'Violet Lane' },
] as const;

export type SkinId = (typeof SKINS)[number]['id'];
export const DEFAULT_SKIN: SkinId = 'default';
export const SKIN_SETTING = 'ApplicationSkin';

export const SKIN_MESSAGES = {
  strNoSkinSelected: 'Не е избран визуален стил!',
} as const;

const IDS = new Set<string>(SKINS.map((s) => s.id));
export const isSkin = (v: string | null | undefined): v is SkinId => !!v && IDS.has(v);

/**
 * The skin of a stored ApplicationSkin value: a skin id, or a Delta value
 * (an internal resource URI or `file://...def` name) that names one of the
 * skins; anything else (empty, a missing external skin) is the default skin.
 */
export function skinFromSetting(v: string | null | undefined): SkinId {
  const t = (v ?? '').trim().toLowerCase();
  if (isSkin(t)) return t;
  // Longest names first: "moonlightversionexperimental" before "moonlight".
  const hit = [...SKINS].sort((a, b) => b.id.length - a.id.length).find((s) => s.id !== 'default' && t.includes(s.id));
  return hit?.id ?? DEFAULT_SKIN;
}

/** Saving with no skin selected (or an unknown one) is strNoSkinSelected. */
export function validateSkin(v: string | null | undefined): ValidationMessage[] {
  return isSkin(v) ? [] : [{ key: 'strNoSkinSelected', text: SKIN_MESSAGES.strNoSkinSelected, severity: 'critical' }];
}
