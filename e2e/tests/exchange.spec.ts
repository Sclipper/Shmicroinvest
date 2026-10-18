import { expect, test } from '@playwright/test';
import { accountId, activeTab, api, menu, moduleCompany } from './fixtures.ts';

const { openApp } = moduleCompany('exchange');

test.describe('data exchange', () => {
  test('imports operations from a text file', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Операции', 'Импорт на операции', 'Импорт от текстов файл');
    const tab = activeTab(page);
    const line = '2|15.03.2026|1001|Ф-ра|120.00|16|Е2Е Текст ООД|Иван|София|ул. 1||200000001|||бел.|-1';
    await tab.getByTestId('text-file').setInputFiles({ name: 'ops.txt', mimeType: 'text/plain', buffer: Buffer.from(`${line}\r\n`, 'utf8') });
    await expect(tab.getByText('ops.txt')).toBeVisible();
    await tab.getByRole('button', { name: 'Импорт', exact: true }).click();
    await expect(tab.getByTestId('import-done')).toContainText('Записани контирания: 1');
    const tb = await api<{ rows: { number: string; creditTurnover: string }[] }>(page, 'GET', '/reports/trial-balance?from=2026-03-15&to=2026-03-15&level=3');
    expect(tb.rows.find((r) => r.number === '702')?.creditTurnover).toBe('100.00');
  });

  test('imports a bank statement and posts a row by a rule', async ({ page }) => {
    await openApp(page);
    const banks = await api<{ id: number; code: string }[]>(page, 'GET', '/banks');
    const bankId = banks.find((b) => b.code === 'STSABGSF')!.id;
    const my = await api(page, 'GET', '/my-company');
    await api(page, 'PUT', '/my-company', { ...my, addresses: [], bankAccounts: [{ account: 'BG80STSA93000012345678', bankId, bankStatementAccountId: await accountId(page, '503'), isEuro: true }] });
    await api(page, 'POST', '/bank-templates', { bankId, name: 'Наем Е2Е', formula: 'Reason съдържа "наем"', debitAccountId: await accountId(page, '602'), termText: 'Наем', priority: 1 });

    await menu(page, 'Операции', 'Банкови извлечения', 'Импорт на банкови извлечения');
    const tab = activeTab(page);
    const mt940 = [
      ':20:STMT1', ':25:BG80STSA93000012345678', ':28C:1/1', ':60F:C260901EUR1000,00',
      ':61:2609040904D300,00NTRFREF3', ':86:Наем за септември',
      ':62F:C260904EUR700,00', '-',
    ].join('\r\n');
    await tab.getByTestId('bank-file').setInputFiles({ name: 'statement.sta', mimeType: 'text/plain', buffer: Buffer.from(mt940, 'utf8') });
    await tab.getByRole('button', { name: 'Напред' }).click();
    const row = tab.getByTestId('bank-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Наем Е2Е');
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByText('Записани контирания: 1.')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(row).toContainText('Записан');
    const tb = await api<{ rows: { number: string; debitTurnover: string; creditTurnover: string }[] }>(page, 'GET', '/reports/trial-balance?from=2026-09-04&to=2026-09-04&level=3');
    expect(tb.rows.find((r) => r.number === '602')?.debitTurnover).toBe('300.00');
    expect(tb.rows.find((r) => r.number === '503')?.creditTurnover).toBe('300.00');
  });

  test('backs up the company and downloads the archive', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Файл', 'Архивиране на фирма');
    const tab = activeTab(page);
    const downloading = page.waitForEvent('download');
    await tab.getByRole('button', { name: 'Архивиране', exact: true }).click();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/^Shmelta Pro - .+ - \d{2}\.\d{2}\.\d{4}_\d{2}\.\d{2}\.shbak$/);
    await expect(page.getByText('Архивирането на фирмата завърши успешно', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(tab.getByRole('cell', { name: file.suggestedFilename() })).toBeVisible();
  });

  test('Delta conversion is shown as not supported', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Редакция', 'Администриране', 'Импорт от Microinvest Делта');
    await expect(activeTab(page).getByTestId('delta-not-supported')).toContainText('не се поддържа');
  });
});
