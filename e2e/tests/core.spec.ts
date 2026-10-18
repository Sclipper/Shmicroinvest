import { expect, test } from '@playwright/test';
import { ADMIN, COMPANY, accountId, activeTab, api, menu, openApp } from './fixtures.ts';

test.describe('shell and login', () => {
  test('logs in through the login screen and logs out', async ({ page }) => {
    // Own session: the shared admin session must stay valid for the other tests.
    await page.context().clearCookies();
    await page.goto('/');
    await expect(page.getByText('Шмикроинвест Шмелта Про')).toBeVisible();
    await page.getByLabel('Парола').fill('wrong');
    await page.getByRole('button', { name: 'Вход' }).click();
    await expect(page.getByText('Въведено е грешно потребителско име или парола!')).toBeVisible();
    await page.getByLabel('Парола').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Вход' }).click();
    await expect(page.locator('footer')).toContainText(COMPANY.name);
    await menu(page, 'Файл', 'Изход');
    await expect(page.getByRole('button', { name: 'Вход' })).toBeVisible();
  });

  test('status bar shows year, company and EUR base currency', async ({ page }) => {
    await openApp(page);
    const footer = page.locator('footer');
    await expect(footer).toContainText('2026');
    await expect(footer).toContainText(COMPANY.name);
    await expect(footer).toContainText('EUR');
  });

  test('keyboard shortcuts open screens as tabs', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+p');
    await expect(activeTab(page).getByRole('button', { name: 'Нова фирма' })).toBeVisible();
    await page.keyboard.press('Control+h');
    await expect(activeTab(page).getByRole('button', { name: 'Нова подсметка' })).toBeVisible();
    await page.keyboard.press('Alt+o');
    await expect(page.getByRole('button', { name: /Оборотна ведомост/ }).first()).toBeVisible();
  });
});

test.describe('partners', () => {
  test('creates a partner with validation of the name', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+p');
    const tab = activeTab(page);
    await tab.getByRole('button', { name: 'Нова фирма' }).click();
    await tab.getByRole('button', { name: 'Запис' }).click();
    await expect(page.getByText('Не е попълнено име на партньора')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await tab.getByLabel('Име', { exact: true }).fill('Е2Е Клиент ЕООД');
    await tab.getByLabel('Идент. № (ЕИК/ЕГН)').fill('200245489');
    await tab.getByRole('button', { name: 'Запис' }).click();
    await expect(tab.getByRole('cell', { name: 'Е2Е Клиент ЕООД' })).toBeVisible();
  });
});

test.describe('journal', () => {
  test('posts a balanced entry through the editor and lists it', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('F2');
    const tab = activeTab(page);
    await tab.getByLabel('Документ №').fill('7001');
    await tab.getByLabel('Основание').fill('Внесен капитал');
    const accounts = tab.getByPlaceholder('Сметка (F4)');
    await accounts.nth(0).fill('501');
    await accounts.nth(0).press('Enter');
    await accounts.nth(1).fill('101');
    await accounts.nth(1).press('Enter');
    const amounts = tab.locator('td input.num');
    await amounts.nth(0).fill('2500');
    await tab.getByRole('button', { name: 'Изравняване' }).click();
    await expect(tab.getByText('Разлика: 0,00')).toBeVisible();
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await page.keyboard.press('Control+F2');
    await expect(activeTab(page).getByRole('cell', { name: 'Внесен капитал' })).toBeVisible();
  });

  test('rejects an unbalanced entry with the Delta message', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('F2');
    const tab = activeTab(page);
    await tab.getByLabel('Документ №').fill('7002');
    await tab.getByLabel('Основание').fill('Грешка');
    const accounts = tab.getByPlaceholder('Сметка (F4)');
    await accounts.nth(0).fill('501');
    await accounts.nth(0).press('Enter');
    await accounts.nth(1).fill('101');
    await accounts.nth(1).press('Enter');
    const amounts = tab.locator('td input.num');
    await amounts.nth(0).fill('10');
    await amounts.nth(1).fill('9');
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByText('Сумите въведени в дебит и кредит се различават!')).toBeVisible();
  });

  test('trial balance reflects posted amounts', async ({ page }) => {
    await openApp(page);
    const date = '2026-03-01';
    await api(page, 'POST', '/entries', {
      accountingDate: date, documentTypeId: 1, documentNumber: '7100', term: 'Каса към банка',
      debits: [{ accountId: await accountId(page, '503'), amount: '400' }], credits: [{ accountId: await accountId(page, '501'), amount: '400' }],
    });
    await page.keyboard.press('Alt+o');
    const tab = activeTab(page);
    await tab.getByRole('button', { name: 'Справка' }).click();
    const row503 = tab.getByRole('row').filter({ hasText: 'Разплащателна сметка в основна валута' });
    await expect(row503).toContainText('400,00');
  });
});

test.describe('financial year', () => {
  test('a locked month blocks posting', async ({ page }) => {
    await openApp(page);
    const years = await api<{ id: number }[]>(page, 'GET', '/years');
    await api(page, 'PUT', `/years/${years[0]!.id}/locks`, { months: [5] });
    const res = await page.request.post('/api/entries', {
      data: {
        accountingDate: '2026-05-10', documentTypeId: 1, documentNumber: '7200', term: 'x',
        debits: [{ accountId: await accountId(page, '501'), amount: '1' }], credits: [{ accountId: await accountId(page, '101'), amount: '1' }],
      },
    });
    expect(res.status()).toBe(422);
    expect(await res.text()).toContain('заключен месец');
    await api(page, 'PUT', `/years/${years[0]!.id}/locks`, { months: [] });
  });
});
