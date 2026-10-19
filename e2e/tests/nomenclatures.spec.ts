import { expect, test } from '@playwright/test';
import { ADMIN, COMPANY, accountId, activeTab, api, loginFresh, menu, openApp } from './fixtures.ts';

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

test('own company shows the VAT registration turnover and the information tab', async ({ page }) => {
  await openApp(page);
  await menu(page, 'Редакция', 'Администриране', 'Моята фирма');
  const tab = activeTab(page);
  const turnover = tab.getByRole('table', { name: 'Оборот за регистрация по ЗДДС' });
  await expect(turnover.locator('thead th')).toHaveCount(12);
  await expect(tab.getByTestId('vat-turnover-total')).toContainText(/\d/);
  await expect(tab.getByText(/Праг за задължителна регистрация: 51 ?130,00 EUR/)).toBeVisible();
  await tab.getByRole('button', { name: 'Информация' }).click();
  await expect(tab.getByRole('table', { name: 'Информация за 2026 г.' })).toContainText('Контировки');
});

test('change active user (Ctrl+0)', async ({ page }) => {
  await loginFresh(page);
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

test('new company: duplicate name asks, partners are carried over', async ({ page }) => {
  // Own session: creating a company switches the session to it.
  await loginFresh(page);
  await expect(page.locator('footer')).toContainText(COMPANY.name);
  await api(page, 'POST', '/partners', { name: 'Пренесен Партньор ООД', accountIds: [await accountId(page, '411')] });

  await menu(page, 'Файл', 'Нова фирма...');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Име на фирмата').fill(COMPANY.name);
  await dialog.getByLabel('Парола', { exact: true }).fill(ADMIN.password);
  await dialog.getByLabel('Повтори паролата').fill(ADMIN.password);
  await dialog.getByText('Партньори', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Създай' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Вече съществува фирма със същото име! Желаете ли да продължите?');
  await dialog.getByRole('button', { name: 'Да', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const partners = await api(page, 'GET', '/partners?q=Пренесен');
  expect(partners.map((p: { name: string }) => p.name)).toEqual(['Пренесен Партньор ООД']);
  expect((await api(page, 'GET', '/entries')).total).toBe(0);
});

test('chart: delete asks with the spec text; a used account lists why it cannot be deleted', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+h');
  const tab = activeTab(page);
  await tab.getByPlaceholder('Търсене по номер или име').fill('109');
  await tab.getByRole('cell', { name: '109', exact: true }).click();
  await tab.getByRole('button', { name: 'Изтриване' }).click();
  await expect(page.getByText('Желаете ли да изтриете избраната сметка?')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Не', exact: true }).click();

  await tab.getByPlaceholder('Търсене по номер или име').fill('10');
  await tab.getByRole('cell', { name: '10', exact: true }).click();
  await tab.getByRole('button', { name: 'Изтриване' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Да', exact: true }).click();
  await expect(page.getByText('Сметката има подсметки.')).toBeVisible();
});

test('partner lookup fills the form from the EIK (server answer stubbed)', async ({ page }) => {
  await page.route('**/api/partners/lookup?*', (route) =>
    route.fulfill({ json: { companyName: 'ИНФОРМАЦИОННО ОБСЛУЖВАНЕ - АД', bulstat: '831641791', vatNumber: 'BG831641791', isVatRegistered: true, city: 'СОФИЯ', postalCode: '1504', location: 'ул. ПАНАЙОТ ВОЛОВ №2', countryCode: 'BG', address: '' } }));
  await openApp(page);
  await page.keyboard.press('Control+p');
  const tab = activeTab(page);
  await tab.getByRole('button', { name: 'Нова фирма' }).click();
  await tab.getByLabel('Идент. № (ЕИК/ЕГН)').fill('831641791');
  await tab.getByRole('button', { name: 'Търсене', exact: true }).click();
  await expect(tab.getByLabel('Име', { exact: true })).toHaveValue('ИНФОРМАЦИОННО ОБСЛУЖВАНЕ - АД');
  await expect(tab.getByLabel('ДДС номер')).toHaveValue('BG831641791');
  await tab.getByRole('button', { name: 'Адреси' }).click();
  await expect(tab.locator('input[value="СОФИЯ"]')).toBeVisible();
  await expect(tab.locator('input[value="1504"]')).toBeVisible();
});

test('currency rules come from the server with the spec texts', async ({ page }) => {
  await openApp(page);
  await menu(page, 'Редакция', 'Валути');
  const tab = activeTab(page);
  await expect(tab.getByRole('row', { name: /ISK/ })).toContainText('БНБ не публикува курс на исландската крона от 01.09.2010 г.');
  await tab.getByRole('button', { name: 'Нова валута' }).click();
  await tab.getByLabel('Код (ISO)').fill('EU');
  await tab.getByLabel('Наименование').fill('Евро-тест');
  await tab.getByRole('button', { name: 'Запис' }).first().click();
  await expect(page.getByText('Зададен е невалиден код на валутата. Кодът трябва да се състои от три главни латински букви.')).toBeVisible();
});
