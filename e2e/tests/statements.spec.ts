import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, accountId, activeTab, api, menu, openApp } from './fixtures.ts';

/** Current-year amount of a statement cell in the two-sided balance sheet. */
function cell(page: Page, key: string) {
  return activeTab(page).locator(`tr[data-key="${key}"] td`).nth(2);
}

async function runBalance(page: Page) {
  const tab = activeTab(page);
  await tab.getByRole('button', { name: 'Справка', exact: true }).click();
  await expect(tab.locator('tr[data-key="b50"]')).toBeVisible();
}

test.describe('financial statements', () => {
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, storageState: '.auth/admin.json' });
    const page = await context.newPage();
    await api(page, 'POST', '/entries', {
      accountingDate: '2026-01-01', documentTypeId: null, documentNumber: '9100', term: 'Начални салда', isInitialBalance: true,
      debits: [{ accountId: await accountId(page, '501'), amount: '2500' }], credits: [{ accountId: await accountId(page, '101'), amount: '2500' }],
    });
    await api(page, 'POST', '/entries', {
      accountingDate: '2026-02-10', documentTypeId: 1, documentNumber: '9101', term: 'Продажба на услуга',
      debits: [{ accountId: await accountId(page, '501'), amount: '600' }], credits: [{ accountId: await accountId(page, '702'), amount: '600' }],
    });
    // As in Delta, the balance sheet takes the current result from 123 (b62 = fcb(123)-fdb(123)),
    // so revenue accounts must be closed for it to balance.
    await api(page, 'POST', '/entries', {
      accountingDate: '2026-12-31', documentTypeId: 1, documentNumber: '9102', term: 'Приключване на приходи',
      debits: [{ accountId: await accountId(page, '702'), amount: '600' }], credits: [{ accountId: await accountId(page, '123'), amount: '600' }],
    });
    await context.close();
  });

  test('opens Отчети и баланс from the menu and generates a balanced balance sheet', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Справки', 'Отчети и баланс Alt+B');
    const tab = activeTab(page);
    await expect(tab.getByRole('combobox', { name: 'Отчети' })).toHaveValue('balance');
    await runBalance(page);
    await expect(tab.getByRole('heading', { name: 'Б А Л А Н С' })).toBeVisible();
    const assets = (await cell(page, 'b50').textContent())?.trim();
    expect(assets).toBeTruthy();
    await expect(cell(page, 'b108')).toHaveText(assets!);

    await tab.getByRole('button', { name: 'Проверка на данните' }).click();
    await expect(page.getByText('Данните са попълнени коректно.')).toBeVisible();
    await page.getByRole('button', { name: 'OK', exact: true }).click();
  });

  test('all statements include the income statement with the current result', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Alt+b');
    const tab = activeTab(page);
    await tab.getByRole('combobox', { name: 'Отчети' }).selectOption('');
    await tab.getByRole('button', { name: 'Справка', exact: true }).click();
    await expect(tab.getByRole('heading', { name: 'ОТЧЕТ ЗА ПРИХОДИТЕ И РАЗХОДИТЕ' })).toBeVisible();
    await expect(tab.getByRole('heading', { name: 'ОТЧЕТ ЗА ПАРИЧНИТЕ ПОТОЦИ ПО ПРЕКИЯ МЕТОД' })).toBeVisible();
    await expect(tab.getByRole('heading', { name: 'ОТЧЕТ ЗА СОБСТВЕНИЯ КАПИТАЛ' })).toBeVisible();
  });

  test('a formula edited in the Ctrl+B editor changes the report and can be restored', async ({ page }) => {
    await openApp(page);
    try {
      await page.keyboard.press('Alt+b');
      await runBalance(page);
      await expect(cell(page, 'b1')).toHaveText('');

      await page.keyboard.press('Control+b');
      const editor = activeTab(page);
      await expect(editor.getByRole('combobox', { name: 'Избор на отчет/баланс' })).toBeVisible();
      const input = editor.getByLabel('Формула b1', { exact: true });
      await expect(input).toHaveValue('fdb(426)');

      // An unknown reference is rejected before saving.
      await input.fill('fdb(426)+zz9');
      await editor.getByRole('button', { name: 'Запис', exact: true }).click();
      await expect(page.getByText('Има невалидни формули. Поправете ги преди запис.')).toBeVisible();
      await page.getByRole('button', { name: 'OK', exact: true }).click();
      await expect(editor.getByText('Непозната формула : zz9')).toBeVisible();

      await input.fill('fdb(426)+77');
      await editor.getByRole('button', { name: 'Запис', exact: true }).click();
      await expect(editor.getByRole('button', { name: 'Запис', exact: true })).toBeDisabled();

      await page.keyboard.press('Alt+b');
      await runBalance(page);
      await expect(cell(page, 'b1')).toHaveText('77,00');

      await page.keyboard.press('Control+b');
      await editor.locator('tr[data-key="b1"]').click();
      await editor.getByRole('button', { name: 'Възстановяване', exact: true }).click();
      await expect(input).toHaveValue('fdb(426)');
      await editor.getByRole('button', { name: 'Запис', exact: true }).click();
      await expect(editor.getByRole('button', { name: 'Запис', exact: true })).toBeDisabled();

      await page.keyboard.press('Alt+b');
      await runBalance(page);
      await expect(cell(page, 'b1')).toHaveText('');
    } finally {
      await api(page, 'POST', '/statements/formulas/restore', { statement: 'balance' });
    }
  });

  test('exports the statements to Excel', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Alt+b');
    await runBalance(page);
    const download = page.waitForEvent('download');
    await activeTab(page).getByRole('button', { name: 'Експорт Excel' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  });
});
