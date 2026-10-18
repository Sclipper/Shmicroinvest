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

test.describe('shell behaviour', () => {
  test('unsaved pages are marked with * and closing them asks first', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('F2');
    await activeTab(page).getByLabel('Основание').fill('Незаписано');
    const tabTitle = page.getByRole('button', { name: /Контиране \*/ });
    await expect(tabTitle).toBeVisible();
    await page.keyboard.press('Shift+F4');
    await expect(page.getByText('Има незаписани промени')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Не', exact: true }).click();
    await expect(tabTitle).toBeVisible();
    await page.keyboard.press('Shift+F4');
    await page.getByRole('dialog').getByRole('button', { name: 'Да', exact: true }).click();
    await expect(tabTitle).toHaveCount(0);
  });

  test('Ctrl+Shift+F8 shows the active database and the status bar clock runs', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+Shift+F8');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Активна база данни');
    await expect(dialog).toContainText(COMPANY.name);
    await expect(dialog).toContainText('1.01.089');
    await page.getByRole('button', { name: 'OK' }).click();
    const clock = page.getByTestId('clock');
    const first = await clock.textContent();
    await expect(clock).not.toHaveText(first!, { timeout: 3000 });
  });

  test('status bar year cell opens the year chooser', async ({ page }) => {
    await openApp(page);
    await page.locator('footer').getByRole('button', { name: /Година/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Активна година')).toHaveValue('2026');
    await dialog.getByRole('button', { name: 'Отказ' }).click();
    await expect(dialog).toHaveCount(0);
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

  test('dates are entered and shown as dd.mm.yyyy', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('F2');
    const tab = activeTab(page);
    const accDate = tab.getByLabel('Дата на контиране');
    await expect(accDate).toHaveValue(/^\d{2}\.\d{2}\.2026$/);
    await accDate.fill('5.4.26');
    await accDate.blur();
    await expect(accDate).toHaveValue('05.04.2026');
    // The document date follows the accounting date while they were equal.
    await expect(tab.getByLabel('Дата на документ')).toHaveValue('05.04.2026');
    await accDate.fill('31.04.2026');
    await expect(accDate).toHaveClass(/border-red-400/);
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
