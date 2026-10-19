import { expect, test, type Page } from '@playwright/test';
import { activeTab, api, menu, moduleCompany } from './fixtures.ts';

const { openApp } = moduleCompany('shell');

/** Skins (spec 06 2.7): live preview in Настройки, Отказ reverts, the saved skin (ApplicationSkin, per user) survives a reload. */

const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const skinAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.skin ?? 'default');
/** Background of the primary "Запис" button: painted with --color-brand-500 (it animates colour changes). */
const saveButtonColor = (page: Page) => activeTab(page).getByRole('button', { name: 'Запис', exact: true }).evaluate((b) => getComputedStyle(b).backgroundColor);

test('Визуален стил: preview, cancel, save, persists after reload (06 2.7)', async ({ page }) => {
  await api(page, 'PUT', '/settings/user', { ApplicationSkin: 'default' });
  try {
    await openApp(page);
    await menu(page, 'Други', 'Настройки');
    const tab = activeTab(page);
    await tab.getByRole('tab', { name: 'Основни' }).click();
    const select = tab.getByLabel('Визуален стил');
    await expect(select).toHaveValue('default');
    const defaultBrand = await cssVar(page, '--color-brand-500');
    expect(defaultBrand).toBe('#2f74c0');
    expect(await skinAttr(page)).toBe('default');
    // The default skin keeps the original look (the body background is slate-100).
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const saveBg = await saveButtonColor(page);

    // Choosing a skin previews it at once.
    await select.selectOption({ label: 'Sunset' });
    await expect.poll(() => skinAttr(page)).toBe('sunset');
    expect(await cssVar(page, '--color-brand-500')).not.toBe(defaultBrand);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(bodyBg);
    expect(await saveButtonColor(page)).not.toBe(saveBg);
    await expect(tab.getByText('Незаписани промени: 1')).toBeVisible();

    // Отказ reverts the preview.
    await tab.getByRole('button', { name: 'Отказ', exact: true }).click();
    await expect(select).toHaveValue('default');
    await expect.poll(() => skinAttr(page)).toBe('default');
    expect(await cssVar(page, '--color-brand-500')).toBe(defaultBrand);
    await expect.poll(() => saveButtonColor(page)).toBe(saveBg); // after the button's colour transition

    // Запис stores it for the user; a reload comes back with it.
    await select.selectOption({ label: 'Violet Lane' });
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(tab.getByText(/Незаписани промени/)).toHaveCount(0);
    expect((await api<Record<string, string>>(page, 'GET', '/settings/user')).ApplicationSkin).toBe('violetlane');
    const violet = await cssVar(page, '--color-brand-500');
    await page.reload();
    await expect(page.locator('footer')).toBeVisible();
    await expect.poll(() => skinAttr(page)).toBe('violetlane');
    expect(await cssVar(page, '--color-brand-500')).toBe(violet);

    // The dark variant repaints the surfaces (white panels become dark).
    await menu(page, 'Други', 'Настройки');
    await activeTab(page).getByRole('tab', { name: 'Основни' }).click();
    await activeTab(page).getByLabel('Визуален стил').selectOption('moonlightversionexperimental');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
    // Leaving the settings unsaved restores the saved skin.
    await activeTab(page).getByRole('button', { name: 'Отказ', exact: true }).click();
    await expect.poll(() => skinAttr(page)).toBe('violetlane');
  } finally {
    await api(page, 'PUT', '/settings/user', { ApplicationSkin: 'default' });
  }
});
