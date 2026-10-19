import { describe, expect, it } from 'vitest';
import { DEFAULT_SKIN, isSkin, SKINS, skinFromSetting, validateSkin } from '../src/index.ts';

describe('skins (06 2.7, ApplicationSkin)', () => {
  it('the nine internal skins of Framework.Core, default first', () => {
    expect(SKINS.map((s) => s.id)).toEqual(['default', 'cherrymint', 'forestmist', 'ladypink', 'limetree', 'moonlight', 'moonlightversionexperimental', 'sunset', 'violetlane']);
    expect(DEFAULT_SKIN).toBe('default');
    expect(new Set(SKINS.map((s) => s.name)).size).toBe(9);
  });

  it('stored values: a skin id, a Delta resource URI or .def name naming a skin, else the default', () => {
    expect(skinFromSetting('sunset')).toBe('sunset');
    expect(skinFromSetting(' VioletLane ')).toBe('violetlane');
    expect(skinFromSetting('/Microinvest.Framework.Core;component/Skins/MoonlightVersionExperimental/Skin.xaml')).toBe('moonlightversionexperimental');
    expect(skinFromSetting('/Microinvest.Framework.Core;component/Skins/Moonlight/Skin.xaml')).toBe('moonlight');
    expect(skinFromSetting('file://Dawn.def')).toBe('default');
    expect(skinFromSetting('')).toBe('default');
    expect(skinFromSetting(null)).toBe('default');
  });

  it('saving without a skin is strNoSkinSelected', () => {
    expect(validateSkin('limetree')).toEqual([]);
    expect(isSkin('limetree')).toBe(true);
    for (const v of ['', null, 'dawn']) {
      expect(validateSkin(v)).toEqual([{ key: 'strNoSkinSelected', text: 'Не е избран визуален стил!', severity: 'critical' }]);
    }
  });
});
