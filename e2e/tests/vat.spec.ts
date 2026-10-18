import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { COMPANY, accountId, activeTab, api, menu, openApp } from './fixtures.ts';

/**
 * VAT module (spec 02b, 04a 1, 05 7): the VAT diaries screen (Alt+D), the NAP
 * files, VAT closing (Alt+F) and the VAT assists of the entry editor.
 * Uses August 2026 so it does not clash with the other suites.
 */

const VAT_ID = 'BG831641791';

async function setup(page: Page) {
  const my = await api(page, 'GET', '/my-company');
  await api(page, 'PUT', '/my-company', {
    name: my.name ?? COMPANY.name, bulstat: my.bulstat ?? COMPANY.bulstat, accountant: my.accountant ?? '', isVat: true, vatId: VAT_ID,
    vatDeclarationSubscriberName: 'Иван Петров', vatDeclarationSubscriberEgn: '7501010010', vatDeclarationSubscriberPosition: 'Управител', vatDeclarationSubscriberRole: 1,
    addresses: (my.addresses ?? []).map((a: Record<string, unknown>) => ({ city: a.city, address: a.address, postalCode: a.postalCode })), bankAccounts: [],
  });
  const partners = await api<{ id: number; name: string }[]>(page, 'GET', '/partners?q=ДДС Клиент');
  let client = partners.find((p) => p.name === 'ДДС Клиент ЕООД')?.id;
  if (!client) client = (await api(page, 'POST', '/partners', { name: 'ДДС Клиент ЕООД', isVat: true, vatNumber: 'BG111111110', accountIds: [await accountId(page, '411')] })).id;
  const line = async (n: string, amount: string, extra: Record<string, unknown> = {}) => ({ accountId: await accountId(page, n), amount, vatTermId: 7, ...extra });
  await api(page, 'POST', '/entries', {
    accountingDate: '2026-08-12', documentTypeId: 1, documentNumber: '0000008001', term: 'Продажба на стоки', transactionTypeId: 3, companyId: client, viesId: 1,
    debits: [await line('411', '240', { companyId: client })], credits: [await line('702', '200'), await line('453/2', '40')],
  });
}

test.describe('VAT', () => {
  test('VAT diaries, declaration and a downloaded PRODAGBI.TXT', async ({ page }) => {
    await openApp(page);
    await setup(page);
    await page.keyboard.press('Alt+d');
    const tab = activeTab(page);
    await expect(page.getByRole('button', { name: /ДДС дневници, декларация и VIES/ }).first()).toBeVisible();
    await tab.getByLabel('От дата').fill('2026-08-01');
    await tab.getByLabel('До дата').fill('2026-08-31');
    await tab.getByRole('button', { name: 'Справка' }).click();
    await expect(tab.locator('tr[data-cell="11"]')).toContainText('200,00');
    await expect(tab.locator('tr[data-cell="21"]')).toContainText('40,00');
    await expect(tab.locator('tr[data-cell="50"]')).toContainText('40,00');
    await tab.getByRole('tab', { name: 'Дневник продажби' }).click();
    const row = tab.getByRole('row').filter({ hasText: '0000008001' });
    await expect(row).toContainText('ДДС Клиент ЕООД');
    await expect(row).toContainText('BG111111110');
    await expect(row).toContainText('200,00');

    await tab.getByRole('tab', { name: 'Файлове за НАП' }).click();
    await tab.getByRole('button', { name: 'Създаване на файловете' }).click();
    await expect(tab.locator('[data-file="PRODAGBI.TXT"]')).toContainText('08.2026/PRODAGBI.TXT');
    const download = page.waitForEvent('download');
    await tab.getByRole('button', { name: 'PRODAGBI.TXT' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('PRODAGBI.TXT');
    const bytes = await readFile((await file.path())!);
    const text = new TextDecoder('windows-1251').decode(bytes);
    const lines = text.split('\r\n').filter(Boolean);
    const line = lines.find((l) => l.includes('0000008001'))!;
    expect(line).toHaveLength(424);
    expect(line.startsWith(VAT_ID.padEnd(15) + '202608')).toBe(true);
    expect(line.slice(87, 137).trim()).toBe('ДДС Клиент ЕООД');
    expect(line.slice(167, 227)).toBe(['200.00', '40.00', '200.00', '40.00'].map((v) => v.padStart(15)).join(''));
    expect(bytes.includes(0xc4)).toBe(true); // "Д" in cp1251
  });

  test('VAT closing posts the memorial order (Alt+F)', async ({ page }) => {
    await openApp(page);
    // The item's accessible name includes its gesture ("Alt+F"), so match by prefix.
    await menu(page, 'Операции', 'Автоматични операции');
    await page.getByRole('button', { name: /^Приключване на ДДС/ }).last().click();
    const tab = activeTab(page);
    await tab.getByLabel('От дата').fill('2026-08-01');
    await tab.getByLabel('До дата').fill('2026-08-31');
    await tab.getByRole('button', { name: 'Изчисли' }).click();
    const rows = tab.getByTestId('vat-closing-rows');
    await expect(rows.getByRole('row').filter({ hasText: '453/9' })).toContainText('453/2');
    await expect(rows.getByLabel('Сума 1')).toHaveValue('40,00');
    await tab.getByRole('button', { name: 'Запис' }).click();
    await expect(page.getByText(/Създадени са 1 контирания/)).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(rows).toContainText('Няма суми за приключване.');
    // Alt+F reopens the same screen.
    await page.keyboard.press('Alt+f');
    await expect(page.getByRole('button', { name: /Приключване на ДДС/ }).first()).toBeVisible();
  });

  test('entry editor: Shift+F2 adds the VAT sales line and F8 recalculates it', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('F2');
    const tab = activeTab(page);
    await tab.getByLabel('Тип на сделката').selectOption({ label: 'Продажба' });
    await expect(tab.getByLabel('ДДС режим')).toHaveValue('7');
    const accounts = tab.getByPlaceholder('Сметка (F4)');
    await accounts.nth(0).fill('411');
    await accounts.nth(0).press('Enter');
    await accounts.nth(1).fill('702');
    await accounts.nth(1).press('Enter');
    const amounts = tab.locator('td input.num');
    await amounts.nth(0).fill('100');
    await amounts.nth(1).fill('100');
    await amounts.nth(1).press('Shift+F2');
    await expect(tab.getByText('Общо кредит: 120,00')).toBeVisible();
    await expect(tab.getByText('Общо дебит: 120,00')).toBeVisible();
    await amounts.nth(1).fill('50');
    await amounts.nth(1).press('F8');
    await page.getByRole('button', { name: 'Да', exact: true }).click();
    await expect(amounts.nth(2)).toHaveValue('10'); // the editor shows amounts without trailing zeros
  });
});
