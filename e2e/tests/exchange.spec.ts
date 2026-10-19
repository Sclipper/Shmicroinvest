import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { accountId, activeTab, api, menu, moduleCompany } from './fixtures.ts';
import { writeJet, type JetColumn } from '../../apps/server/test/jetWriter.ts';

const { openApp } = moduleCompany('exchange');

const uid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function post(page: Page, e: { date: string; doc: string; companyId?: number; dr: [string, string]; cr: [string, string] }) {
  return api<{ id: number }>(page, 'POST', '/entries', {
    accountingDate: e.date, documentTypeId: 1, documentNumber: e.doc, term: 'Е2Е обмен', companyId: e.companyId,
    debits: [{ accountId: await accountId(page, e.dr[0]), amount: e.dr[1] }], credits: [{ accountId: await accountId(page, e.cr[0]), amount: e.cr[1] }],
  });
}

/** A small legacy Delta database (Jet 4): chart, one partner, one sale in 2009 and an opening balance. */
function legacyDeltaFile() {
  const c = (name: string, type: JetColumn['type'], size?: number): JetColumn => ({ name, type, size });
  const year = [c('KonID', 'long'), c('Kon', 'long'), c('Acct', 'long'), c('SubAcct', 'long'), c('PriznakID', 'long'), c('Date', 'datetime'), c('FakNo', 'text', 10), c('DocType', 'text', 8), c('Osnovanie', 'text', 40), c('IsPokupka', 'byte'), c('OperType', 'byte'), c('IsKredit', 'byte'), c('Qtty', 'currency'), c('StartDebit', 'currency'), c('PartnerID', 'long')];
  const date = new Date(Date.UTC(2009, 4, 20));
  const sale = { KonID: 1, Date: date, FakNo: '0000000101', DocType: 'Ф-ра', Osnovanie: 'Продажба', IsPokupka: 2, OperType: 16, SubAcct: 0, PriznakID: 0 };
  return writeJet([
    { name: 'Priznaci', columns: [c('PriznakID', 'long'), c('Type', 'integer')], rows: [{ PriznakID: 0, Type: 0 }] },
    { name: 'Accts', columns: [c('AcctID', 'long'), c('Acct', 'long'), c('SubAcct', 'long'), c('PriznakID', 'long'), c('Name', 'text', 50), c('IsValutna', 'boolean')], rows: [
      { AcctID: 1, Acct: 411, SubAcct: 0, PriznakID: 0, Name: 'Клиенти' }, { AcctID: 2, Acct: 702, SubAcct: 0, PriznakID: 0, Name: 'Приходи от стоки' },
      { AcctID: 3, Acct: 453, SubAcct: 0, PriznakID: 0, Name: 'ДДС' }, { AcctID: 4, Acct: 453, SubAcct: 2, PriznakID: 0, Name: 'ДДС продажби' },
      { AcctID: 5, Acct: 501, SubAcct: 0, PriznakID: 0, Name: 'Каса' },
    ] },
    { name: 'Part', columns: [c('ID', 'long'), c('Company', 'text', 60), c('Bulstat', 'text', 13), c('IsVeryUsed', 'byte')], rows: [{ ID: 1, Company: 'Клиент Делта АД', Bulstat: '200000001', IsVeryUsed: 1 }] },
    { name: 'Year2009', columns: year, rows: [
      { ...sale, Kon: 1, Acct: 411, IsKredit: 2, Qtty: 120, PartnerID: 1 },
      { ...sale, Kon: 2, Acct: 702, IsKredit: 1, Qtty: -100, PartnerID: 0 },
      { ...sale, Kon: 3, Acct: 453, SubAcct: 2, IsKredit: 1, Qtty: -20, PartnerID: 0 },
      { KonID: 0, Kon: 0, Acct: 501, SubAcct: 0, PriznakID: 0, StartDebit: 500 },
    ] },
  ]);
}

type TbRow = { number: string; openingDebit: string; openingCredit: string; debitTurnover: string; creditTurnover: string };
const trialBalance = async (page: Page, from: string, to: string) =>
  (await api<{ rows: TbRow[] }>(page, 'GET', `/reports/trial-balance?from=${from}&to=${to}&level=3`)).rows;

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

  test('Delta conversion: refuses a non-Access file, then converts a legacy MAINACCT.MDB into an empty company (04a 7)', async ({ page }) => {
    await openApp(page);
    // The conversion needs an empty company: a new one, in this page's own session.
    const name = `Делта Е2Е ${uid()}`;
    await api(page, 'POST', '/companies', { companyName: name, adminName: 'Администратор', adminPassword: 'e2e-secret', year: 2026, bulstat: '175074752' });
    await page.goto('/');
    await expect(page.locator('footer')).toContainText(name);
    await menu(page, 'Редакция', 'Администриране', 'Импорт от Microinvest Делта');
    const tab = activeTab(page);
    await expect(tab.getByTestId('delta-type')).toHaveValue('all');

    await tab.getByTestId('delta-file').setInputFiles({ name: 'MAINACCT.MDB', mimeType: 'application/octet-stream', buffer: Buffer.from('Това не е база данни на Access.\n'.repeat(100)) });
    await tab.getByTestId('delta-run').click();
    await expect(page.getByText('При импорта от Microinvest Делта ще бъдат прехвърлени', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Да', exact: true }).click();
    await expect(tab.getByText('Некоректен файлов формат!')).toBeVisible();

    await tab.getByTestId('delta-file').setInputFiles({ name: 'MAINACCT.MDB', mimeType: 'application/octet-stream', buffer: Buffer.from(legacyDeltaFile()) });
    await tab.getByTestId('delta-run').click();
    await page.getByRole('button', { name: 'Да', exact: true }).click();
    await expect(tab.getByTestId('import-done')).toHaveText('Прехвърлянето завърши.');
    const result = tab.getByTestId('delta-result');
    await expect(result.getByRole('row', { name: /^Контирания 1$/ })).toBeVisible();
    await expect(result.getByRole('row', { name: /^Year2009 2009 1 1 0$/ })).toBeVisible();
    await expect(tab.getByText('Некоректен файлов формат!')).toHaveCount(0);
    const partners = await api<{ name: string }[]>(page, 'GET', '/partners');
    expect(partners.map((p) => p.name)).toContain('Клиент Делта АД');
  });

  test('exports operations to XML and imports the file back, closing the documents by amount (04a 3)', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const cli = (await api<{ id: number }>(page, 'POST', '/partners', { name: `Е2Е XML ${id}`, accountIds: [await accountId(page, '411')] })).id;
    await post(page, { date: '2026-10-05', doc: `X${id}`, companyId: cli, dr: ['411', '240'], cr: ['702', '240'] });
    await post(page, { date: '2026-10-06', doc: `P${id}`, companyId: cli, dr: ['501', '240'], cr: ['411', '240'] });

    await menu(page, 'Операции', 'Експорт на операции', 'Експорт към XML');
    let tab = activeTab(page);
    await tab.getByLabel('От дата').fill('2026-10-05');
    await tab.getByLabel('До дата').fill('2026-10-06');
    await tab.getByLabel('Име на файла').fill(`Transfer-${id}.xml`);
    const downloading = page.waitForEvent('download');
    await tab.getByRole('button', { name: 'Експорт', exact: true }).click();
    const file = await downloading;
    expect(file.suggestedFilename()).toBe(`Transfer-${id}.xml`);
    await expect(tab.getByText('Експортирани контирания: 2.')).toBeVisible();
    const xml = readFileSync((await file.path())!, 'utf8');
    expect(xml).toContain('urn:Transfer');
    expect(xml).toContain(`X${id}`);
    expect(xml).toContain('240.00');

    await menu(page, 'Операции', 'Импорт на операции', 'Импорт от XML');
    tab = activeTab(page);
    await tab.getByTestId('xml-file').setInputFiles({ name: `Transfer-${id}.xml`, mimeType: 'text/xml', buffer: Buffer.from(xml, 'utf8') });
    await tab.getByRole('button', { name: 'Напред' }).click();
    await expect(tab.getByRole('button', { name: 'Назад' })).toBeVisible();
    // Accounts by category are asked only when the file has categories without an account.
    if (await tab.getByRole('button', { name: 'Напред' }).isVisible()) await tab.getByRole('button', { name: 'Напред' }).click();
    await expect(tab.getByRole('row', { name: /Контирания\s*2/ })).toBeVisible();
    await tab.getByText('Закриване на документи след импорта').click();
    await tab.getByLabel('Начин на търсене').selectOption('amount');
    await tab.getByRole('button', { name: 'Импорт', exact: true }).click();
    await expect(tab.getByText(/контирания: 2\. Закрити двойки документи: [1-9]/)).toBeVisible();
    const tb = await trialBalance(page, '2026-10-05', '2026-10-06');
    expect(tb.find((r) => r.number === '702')?.creditTurnover).toBe('480.00');
    // The choice is kept for the next import (IsDocumentsClosingEnabled / SelectedWayOfSearching).
    const settings = await api<{ isDocumentsClosingEnabled: boolean; selectedWayOfSearching: string }>(page, 'GET', '/exchange/xml/settings');
    expect(settings).toMatchObject({ isDocumentsClosingEnabled: true, selectedWayOfSearching: 'amount' });
  });

  // Runs last: it adds the 2025 year (BGN chart) and opens 2026 from it.
  test('converts 2025 to the euro: openings per document in EUR (04b 4)', async ({ page }) => {
    await openApp(page);
    await api(page, 'POST', '/years', { year: 2025 });
    await api(page, 'PUT', '/years/active', { year: 2025 });
    await api(page, 'POST', '/accounts/template', { type: 'commercial' });
    const id = uid();
    const cli = (await api<{ id: number }>(page, 'POST', '/partners', { name: `Е2Е Евро ${id}`, accountIds: [await accountId(page, '411')] })).id;
    await post(page, { date: '2025-11-10', doc: `B${id}`, dr: ['503', '1955.83'], cr: ['101', '1955.83'] });
    await post(page, { date: '2025-11-12', doc: `E${id}`, companyId: cli, dr: ['411', '391.17'], cr: ['702', '391.17'] });

    await page.reload();
    await menu(page, 'Редакция', 'Администриране', 'Конвертиране към евро');
    const tab = activeTab(page);
    await expect(tab.getByRole('cell', { name: '503', exact: true }).first()).toBeVisible();
    const diff = tab.getByLabel('Сметка за обиране на разлики');
    const option = await diff.locator('option', { hasText: /^123 / }).first().getAttribute('value');
    await diff.selectOption(option!);
    await tab.getByText('Архив преди конвертиране').click();
    await tab.getByRole('button', { name: 'Конвертиране', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Да', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    await expect(tab.getByText(/Възстановени връзки с плащания: 0/)).toBeVisible();

    await api(page, 'PUT', '/years/active', { year: 2026 });
    const tb = await trialBalance(page, '2026-01-01', '2026-12-31');
    expect(tb.find((r) => r.number === '503')?.openingDebit).toBe('1000.00');
    expect(tb.find((r) => r.number === '101')?.openingCredit).toBe('1000.00');
    expect(tb.find((r) => r.number === '411')?.openingDebit).toBe('200.00');
    // The 2025 invoice stays an open item with its document in 2026.
    const open = await api<{ liabilities: { documentNumber: string; booked: string }[] }>(page, 'GET', `/payments/open-items?companyId=${cli}`);
    expect(open.liabilities.map((l) => [l.documentNumber, l.booked])).toEqual([[`E${id}`, '200.00']]);
  });
});
