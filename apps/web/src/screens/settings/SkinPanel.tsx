import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isSkin, SKIN_SETTING, SKINS, skinFromSetting, validateSkin } from '@shmi/core';
import { api } from '../../api.ts';
import { Panel, Select, cx } from '../../components/ui.tsx';
import { applySkin, USER_SETTINGS_KEY, useUserSettings } from '../../skin.ts';

/**
 * "Визуален стил" of Настройки > Основни (06 2.7): choosing a skin previews it
 * at once, Отказ (or leaving the screen unsaved) restores the saved one, Запис
 * stores ApplicationSkin for the user; saving with no skin selected is
 * strNoSkinSelected.
 */
export function useSkinChoice() {
  const qc = useQueryClient();
  const q = useUserSettings();
  const saved = q.data?.[SKIN_SETTING];
  const [value, setValue] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (saved !== undefined) setValue(saved);
  }, [saved]);
  useEffect(() => {
    if (value !== undefined) applySkin(skinFromSetting(value));
  }, [value]);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => () => {
    if (savedRef.current !== undefined) applySkin(skinFromSetting(savedRef.current));
  }, []);
  return {
    value,
    changed: value !== undefined && saved !== undefined && value !== saved,
    set: setValue,
    cancel: () => setValue(saved),
    /** Messages that block saving the settings page. */
    validate: () => (value === undefined ? [] : validateSkin(value)),
    save: async () => {
      await api.put('/settings/user', { [SKIN_SETTING]: value! });
      await qc.invalidateQueries({ queryKey: USER_SETTINGS_KEY });
    },
  };
}

const SWATCHES = ['--color-brand-700', '--color-brand-500', '--color-brand-100', '--color-slate-100', '--color-white'];

export function SkinPanel({ choice, disabled }: { choice: ReturnType<typeof useSkinChoice>; disabled?: boolean }) {
  const { value } = choice;
  return (
    <Panel title="Визуален стил" className="w-[420px]">
      <div className="flex flex-col gap-2 p-3">
        <label className={cx('flex flex-col gap-0.5', choice.changed && 'font-medium text-amber-800')}>
          <span>Визуален стил</span>
          <Select aria-label="Визуален стил" value={value ?? ''} disabled={disabled || value === undefined} onChange={(e) => choice.set(e.target.value)} data-testid="skin-select">
            {!isSkin(value) && <option value="">(не е избран)</option>}
            {SKINS.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </label>
        <div className="flex items-center gap-1.5 text-[12px] text-slate-500" aria-hidden>
          <span>Цветове:</span>
          {SWATCHES.map((v) => (
            <span key={v} className="inline-block size-4 rounded-sm border border-slate-300" style={{ background: `var(${v})` }} />
          ))}
        </div>
      </div>
    </Panel>
  );
}
