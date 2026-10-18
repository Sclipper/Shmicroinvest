import { expect, test } from '@playwright/test';
import { activeTab, api, menu, openApp } from './fixtures.ts';

test('partner groups: create, rename and filter the list', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+p');
  const tab = activeTab(page);
  await tab.getByTitle('Нова група').click();
  const group = tab.getByRole('button', { name: /^Нова група \d+$/ }).first();
  await expect(group).toBeVisible();
  await group.dblclick();
  const input = tab.locator('form input').first();
  await input.fill('Доставчици Е2Е');
  await input.press('Enter');
  await tab.getByRole('button', { name: 'Доставчици Е2Е' }).click();
  await tab.getByRole('button', { name: 'Нова фирма' }).click();
  await tab.getByLabel('Име', { exact: true }).fill('Групиран Партньор');
  await tab.getByRole('button', { name: 'Запис' }).click();
  await page.getByRole('button', { name: 'OK' }).click().catch(() => {});
  await expect(tab.getByRole('cell', { name: 'Групиран Партньор' })).toBeVisible();
  await tab.getByRole('button', { name: 'Основна група' }).click();
  await expect(tab.getByRole('cell', { name: 'Групиран Партньор' })).toBeVisible();
});

test('VAT number follows the EIK when VAT-registered and the service number button', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+p');
  const tab = activeTab(page);
  await tab.getByRole('button', { name: 'Нова фирма' }).click();
  await tab.getByLabel('Партньорът е регистриран по ЗДДС').check();
  await tab.getByLabel('Идент. № (ЕИК/ЕГН)').fill('831903180');
  await expect(tab.getByLabel('ДДС номер')).toHaveValue('BG831903180');
  await tab.getByRole('button', { name: '-->9999' }).click();
  await expect(tab.getByLabel('ДДС номер')).toHaveValue('999999999999999');
});

test('branches of the own company and switching the active branch', async ({ page }) => {
  await openApp(page);
  await menu(page, 'Редакция', 'Администриране', 'Моята фирма');
  const tab = activeTab(page);
  await tab.getByRole('button', { name: 'Клонове' }).click();
  await tab.getByRole('button', { name: 'Нов', exact: true }).click();
  await tab.getByRole('button', { name: 'Запис' }).last().click();
  await expect(page.getByText('Не е попълнено име на клона!')).toBeVisible();
  await page.getByRole('button', { name: 'OK' }).click();
  await tab.getByLabel('Код', { exact: true }).fill('02');
  await tab.getByLabel('Име', { exact: true }).fill('Клон Пловдив');
  await tab.getByRole('button', { name: 'Запис' }).last().click();
  await expect(tab.getByRole('cell', { name: 'Клон Пловдив' })).toBeVisible();
  await page.locator('footer').getByText('Клон:').click();
  await page.getByRole('dialog').locator('select').selectOption({ label: '02 – Клон Пловдив' });
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('footer')).toContainText('Клон Пловдив');
  await api(page, 'PUT', '/session/branch', { branchId: 1 });
});

test('change active user (Ctrl+0)', async ({ page }) => {
  await openApp(page);
  await api(page, 'POST', '/users', { name: 'Оператор Е2Е', password: 'parola1', roleId: 5 });
  await page.keyboard.press('Control+0');
  const dlg = page.getByRole('dialog');
  await dlg.locator('select').selectOption({ label: 'Оператор Е2Е' });
  await dlg.getByLabel('Парола').fill('parola1');
  await dlg.getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: 'Да', exact: true }).click();
  await expect(page.locator('footer')).toContainText('Оператор Е2Е');
  // Operators may not manage users: the menu item is disabled.
  await menu(page, 'Редакция', 'Администриране');
  await expect(page.getByRole('button', { name: /^Потребители/ })).toBeDisabled();
});
