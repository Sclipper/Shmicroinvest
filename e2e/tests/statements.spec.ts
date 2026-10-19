import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, accountId, activeTab, api, menu, moduleCompany } from './fixtures.ts';

const OWN = moduleCompany('statements');
const { openApp } = OWN;

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
    const context = await browser.newContext({ baseURL: BASE_URL, storageState: OWN.state });
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
    await menu(page, 'Справки', 'Отчети и баланс');
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

  test('micro-enterprise format: abbreviated statements, ГФО Микро and the workbook', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Alt+b');
    const tab = activeTab(page);
    await tab.getByRole('combobox', { name: 'Тип справка' }).selectOption('micro');
    await tab.getByRole('combobox', { name: 'Отчети' }).selectOption('');
    await expect(tab.getByRole('combobox', { name: 'Отчети' }).locator('option')).toHaveCount(3);
    await tab.getByRole('button', { name: 'Справка', exact: true }).click();
    await expect(tab.getByRole('heading', { name: 'СЪКРАТЕН СЧЕТОВОДЕН БАЛАНС' })).toBeVisible();
    await expect(tab.getByRole('heading', { name: 'СЪКРАТЕН ОТЧЕТ ЗА ПРИХОДИТЕ И РАЗХОДИТЕ' })).toBeVisible();
    await expect(tab.getByRole('heading', { name: 'ОТЧЕТ ЗА ПАРИЧНИТЕ ПОТОЦИ ПО ПРЕКИЯ МЕТОД' })).toHaveCount(0);
    // Total assets = total liabilities, and the micro form repeats them.
    const assets = (await cell(page, 'sb14').textContent())?.trim();
    expect(assets).toBeTruthy();
    await expect(cell(page, 'sb27')).toHaveText(assets!);
    await expect(tab.locator('table[data-gfo] tr[data-key="m08"] td').nth(2)).toHaveText(assets!);
    await expect(tab.locator('table[data-gfo] tr[data-key="m32"] td').nth(2)).toHaveText((await cell(page, 'sr11').textContent())!.trim());

    const download = page.waitForEvent('download');
    await tab.getByRole('button', { name: 'Експорт Excel' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
    const data = readFileSync((await file.path())!);
    expect(data.includes(Buffer.from('ГФО Микро'))).toBe(true);

    // "Експорт на съкратени отчети" works for any format.
    await tab.getByRole('combobox', { name: 'Тип справка' }).selectOption('national');
    const abbreviated = page.waitForEvent('download');
    await tab.getByRole('button', { name: 'Експорт на съкратени отчети' }).click();
    const abbr = await abbreviated;
    expect(abbr.suggestedFilename()).toMatch(/^Съкратени_отчети_.*\.xlsx$/);
    const abbrData = readFileSync((await abbr.path())!);
    expect(abbrData.includes(Buffer.from('Съкратен баланс'))).toBe(true);
    expect(abbrData.includes(Buffer.from('Съкратен ОПР'))).toBe(true);
  });

  test('NSI format in English', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Alt+b');
    const tab = activeTab(page);
    await tab.getByRole('combobox', { name: 'Тип справка' }).selectOption('nsi');
    await tab.getByRole('combobox', { name: 'Език' }).selectOption('en');
    await tab.getByRole('combobox', { name: 'Отчети' }).selectOption('balance');
    await runBalance(page);
    await expect(tab.getByRole('heading', { name: 'B A L A N C E   S H E E T' })).toBeVisible();
    await expect(tab.locator('tr[data-key="b50"] td').first()).toHaveText('Total assets (A+B+C+D)');
    await tab.getByRole('combobox', { name: 'Тип справка' }).selectOption('national');
    await expect(tab.getByRole('combobox', { name: 'Език' })).toHaveCount(0);
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
