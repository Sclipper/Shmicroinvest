import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { accountId, activeTab, api, menu, moduleCompany } from './fixtures.ts';

const { openApp } = moduleCompany('exchange');

// exceljs comes from the server package (the e2e package has no dependency on it).
const ExcelJS = createRequire(new URL('../../apps/server/package.json', import.meta.url))('exceljs') as {
  Workbook: new () => { addWorksheet(name: string): { addRow(r: unknown[]): void }; xlsx: { writeBuffer(): Promise<ArrayBuffer> } };
};

const uid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function post(page: Page, e: { date: string; doc: string; companyId?: number; dr: [string, string]; cr: [string, string] }) {
  return api<{ id: number }>(page, 'POST', '/entries', {
    accountingDate: e.date, documentTypeId: 1, documentNumber: e.doc, term: 'Е2Е обмен', companyId: e.companyId,
    debits: [{ accountId: await accountId(page, e.dr[0]), amount: e.dr[1] }], credits: [{ accountId: await accountId(page, e.cr[0]), amount: e.cr[1] }],
  });
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

  test('Delta conversion is shown as not supported', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Редакция', 'Администриране', 'Импорт от Microinvest Делта');
    await expect(activeTab(page).getByTestId('delta-not-supported')).toContainText('не се поддържа');
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

  test('bank preview: keywords, re-applied rule, IBAN binding after the confirmation, duplicate warning, totals (04b 1.5-1.8)', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const own = 'BG80STSA93000012345678';
    const iban = 'BG50UBBS80021012345678';
    const banks = await api<{ id: number; code: string }[]>(page, 'GET', '/banks');
    const my = await api(page, 'GET', '/my-company');
    await api(page, 'PUT', '/my-company', { ...my, addresses: [], bankAccounts: [{ account: own, bankId: banks.find((b) => b.code === 'STSABGSF')!.id, bankStatementAccountId: await accountId(page, '503'), isEuro: true }] });
    const name = `Е2Е Банков ${id}`;
    const partnerId = (await api<{ id: number }>(page, 'POST', '/partners', { name, accountIds: [await accountId(page, '411')] })).id;
    const day = String(10 + (Number(id.slice(-2)) % 18)).padStart(2, '0');
    const mt940 = [
      ':20:STMT2', `:25:${own}`, ':28C:1/1', ':60F:C261101EUR1000,00',
      `:61:2611${day}11${day}C50,00NTRFE${id}`, `:86:Плащане ${iban}`,
      `:61:2611${day}11${day}D12,00NTRFF${id}`, `:86:Абонамент ${id}`,
      ':62F:C261130EUR1038,00', '-',
    ].join('\r\n');

    await menu(page, 'Операции', 'Банкови извлечения', 'Импорт на банкови извлечения');
    const tab = activeTab(page);
    await tab.getByTestId('bank-file').setInputFiles({ name: 'statement2.sta', mimeType: 'text/plain', buffer: Buffer.from(mt940, 'utf8') });
    await tab.getByRole('button', { name: 'Напред' }).click();
    const rows = tab.getByTestId('bank-row');
    await expect(rows).toHaveCount(2);
    await expect(tab.getByTestId('bank-balances')).toContainText('1 000,00');
    await expect(tab.getByTestId('bank-totals')).toContainText('Постъпления: 50,00');
    await expect(tab.getByTestId('bank-totals')).toContainText('Плащания: 12,00');

    // Keyword chips are saved at once.
    const chips = tab.getByTestId('bank-keywords');
    await expect(chips.getByTestId('keyword-chip').filter({ hasText: 'ф-ра' })).toBeVisible();
    await chips.getByLabel('Нова ключова дума').fill(`дума${id}`);
    await chips.getByRole('button', { name: 'Добави' }).click();
    await expect(chips.getByTestId('keyword-chip').filter({ hasText: `дума${id}` })).toBeVisible();
    expect((await api<{ word: string }[]>(page, 'GET', '/bank-statements/keywords')).map((k) => k.word)).toContain(`дума${id}`);
    await chips.getByRole('button', { name: `Изтриване на дума${id}` }).click();
    await expect(chips.getByTestId('keyword-chip').filter({ hasText: `дума${id}` })).toHaveCount(0);

    // The second row has no rule; the user picks "Банкова такса" for it.
    await expect(rows.nth(1)).toContainText('Няма шаблон');
    const template = rows.nth(1).getByLabel('Шаблон');
    await template.selectOption({ label: 'Банкова такса' });
    await expect(rows.nth(1).getByPlaceholder('Сметка (F4)').first()).toHaveValue(/629/);
    await expect(rows.nth(1)).not.toContainText('Няма шаблон');

    // Choosing a partner for an unknown IBAN asks before binding it.
    const picker = rows.nth(0).getByPlaceholder('Партньор (F4)');
    await picker.fill(name);
    await expect(page.getByText(name).last()).toBeVisible();
    await picker.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`Искате ли да обвържете IBAN ${iban} с партньор ${name}?`);
    await dialog.getByRole('button', { name: 'Да', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(`IBAN ${iban} е обвързан с партньор ${name}.`);
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    const partner = await api<{ bankAccounts: { account: string }[] }>(page, 'GET', `/partners/${partnerId}`);
    expect(partner.bankAccounts.map((b) => b.account)).toContain(iban);
    await rows.nth(0).getByPlaceholder('Сметка (F4)').nth(1).fill('411');
    await rows.nth(0).getByPlaceholder('Сметка (F4)').nth(1).press('Enter');

    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByText('Записани контирания: 2.')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    const tb = await trialBalance(page, `2026-11-${day}`, `2026-11-${day}`);
    expect(tb.find((r) => r.number === '629')?.debitTurnover).toBe('12.00');

    // Re-importing the same file: the rows are flagged and the save asks first.
    await tab.getByRole('button', { name: 'Назад' }).click();
    await tab.getByTestId('bank-file').setInputFiles({ name: 'statement2.sta', mimeType: 'text/plain', buffer: Buffer.from(mt940, 'utf8') });
    await tab.getByRole('button', { name: 'Напред' }).click();
    await expect(rows.nth(0)).toContainText('Движението вече е импортирано');
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Редове, които вече са импортирани: 1, 2');
    await page.getByRole('dialog').getByRole('button', { name: /Отказ|Не/ }).first().click();
    expect((await trialBalance(page, `2026-11-${day}`, `2026-11-${day}`)).find((r) => r.number === '629')?.debitTurnover).toBe('12.00');
  });

  test('currency account: editable currency amount and rate, the difference shown (04b 1.8, 1.10)', async ({ page }) => {
    await openApp(page);
    const banks = await api<{ id: number; code: string }[]>(page, 'GET', '/banks');
    const accounts = await api<{ id: number; number: string; currencyId: number; parentId: number | null }[]>(page, 'GET', '/accounts');
    let usd = accounts.find((a) => a.currencyId === 3 && a.number.startsWith('504/'));
    if (!usd) {
      const r = await api<{ id: number }>(page, 'POST', '/accounts', { parentId: await accountId(page, '504'), description: 'Банка USD Е2Е', accountCategoryId: 27, currencyId: 3 });
      usd = { id: r.id } as typeof usd & { id: number };
    }
    const my = await api(page, 'GET', '/my-company');
    await api(page, 'PUT', '/my-company', { ...my, addresses: [], bankAccounts: [{ account: 'BG11FINV91501014771636', bankId: banks.find((b) => b.code === 'FINVBGSF')!.id, bankStatementAccountId: usd!.id, isEuro: false }] });
    await api(page, 'PUT', '/revaluation/rates', { date: '2026-08-03', rates: [{ currencyId: 3, rate: '0.9' }] });
    const xml = `<ROWSET><ROW><XML><statement><system/><header><IBAN>BG11FINV91501014771636</IBAN><Currency>USD</Currency></header>
      <movements><movement><ValueDate>03.08.2026</ValueDate><Reference>E2EFX</Reference><DebitTov>0</DebitTov><CreditTov>91.00</CreditTov><Amount>100.00</Amount>
      <OperationReason><Description>Покупка на валута</Description></OperationReason></movement></movements></statement></XML></ROW></ROWSET>`;

    await menu(page, 'Операции', 'Банкови извлечения', 'Импорт на банкови извлечения');
    const tab = activeTab(page);
    await tab.getByTestId('bank-file').setInputFiles({ name: 'fibank.xml', mimeType: 'text/xml', buffer: Buffer.from(xml, 'utf8') });
    await tab.getByRole('button', { name: 'Напред' }).click();
    const row = tab.getByTestId('bank-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByLabel('Валутна сума')).toHaveValue('100.00');
    await expect(row.getByLabel('Курс')).toHaveValue('0.9');
    await expect(row.getByLabel('Сума', { exact: true })).toHaveValue('91.00');
    await expect(row.getByTestId('row-difference')).toContainText('1,00');
    await expect(tab.getByTestId('bank-totals')).toContainText('Валутни разлики: 1,00');
    // A new rate recomputes the base amount (round(currency x rate, 2)) and clears the difference.
    await row.getByLabel('Курс').fill('0.91');
    await expect(row.getByLabel('Сума', { exact: true })).toHaveValue('91.00');
    await expect(row.getByTestId('row-difference')).toHaveText('');
    await row.getByLabel('Валутна сума').fill('50');
    await expect(row.getByLabel('Сума', { exact: true })).toHaveValue('45.50');
  });

  test('IBANs of payment intermediaries are kept on their own screen (04b 1.7)', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Операции', 'Банкови извлечения', 'IBAN на платежни посредници');
    const tab = activeTab(page);
    await tab.getByLabel('IBAN').fill('bg14 bpbi 7924 1012 3456 78');
    await tab.getByRole('button', { name: 'Добави' }).click();
    await expect(tab.getByTestId('excluded-iban')).toContainText('BG14BPBI79241012345678');
    await tab.getByRole('button', { name: 'Запис' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    expect((await api<{ ibans: string[] }>(page, 'GET', '/bank-statements/excluded-ibans')).ibans).toContain('BG14BPBI79241012345678');
    await tab.getByRole('button', { name: 'Премахване на BG14BPBI79241012345678' }).click();
    await tab.getByRole('button', { name: 'Запис' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    expect((await api<{ ibans: string[] }>(page, 'GET', '/bank-statements/excluded-ibans')).ibans).toEqual([]);
  });

  test('IsBindingDocumentsInBankImportEnabled is a basic setting (06 3.4)', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Други', 'Настройки');
    const tab = activeTab(page);
    const box = tab.getByLabel('Обвързване на документи при импорт на банкови извлечения');
    await expect(box).toBeChecked();
    await box.uncheck();
    await tab.getByRole('button', { name: 'Запис' }).click();
    await expect.poll(async () => (await api<{ key: string; value: string }[]>(page, 'GET', '/settings')).find((s) => s.key === 'IsBindingDocumentsInBankImportEnabled')?.value).toBe('False');
    await api(page, 'PUT', '/settings', { IsBindingDocumentsInBankImportEnabled: 'True' });
  });

  test('imports fixed assets from Excel: САП and "… - ДАП" sheets, errors listed together (04a 5.5)', async ({ page }) => {
    await openApp(page);
    const n = uid().slice(-6);
    const sapHeader = ['Инвентарен номер', 'Наименование', 'МОЛ', 'Местонахождение', 'Категория', 'Дата на придобиване', 'Дата на въвеждане в експлоатация', 'Крайна дата', 'Към дата',
      'Полезен срок (месеци)', 'Годишна норма (%)', 'Начислена амортизация', 'Остатъчна стойност', 'Амортизируема стойност', 'Преоценъчен резерв', 'Сметка на актива',
      'Сметка за амортизация', 'Разходна сметка', 'Синхронизирани планове'];
    const dapHeader = ['Инвентарен номер', 'Наименование', 'Категория', 'Дата на придобиване', 'Дата на въвеждане в експлоатация', 'Крайна дата', 'Към дата', 'Полезен срок (месеци)', 'Годишна норма (%)', 'Начислена амортизация', 'Остатъчна стойност', 'Амортизируема стойност'];
    const book = async (sapAccount: string, extraDap: boolean) => {
      const wb = new ExcelJS.Workbook();
      const sap = wb.addWorksheet('Активи');
      sap.addRow(sapHeader);
      sap.addRow([`E${n}`, `Е2Е машина ${n}`, 'Иван', '', 'Категория 2', '10.01.2025', '15.01.2025', '', '31.12.2025', 24, '', 1100, 0, 2400, 0, sapAccount, '241/2', '603', 'Не']);
      const dap = wb.addWorksheet('Активи - ДАП');
      dap.addRow(dapHeader);
      dap.addRow([`E${n}`, `Е2Е машина ${n}`, 'Категория 2', '10.01.2025', '15.01.2025', '', '31.12.2025', 24, '', 1200, 0, 2400]);
      if (extraDap) dap.addRow([`X${n}`, 'Само в ДАП', 'Категория 2', '10.01.2025', '15.01.2025', '', '31.12.2025', 24, '', 0, 0, 100]);
      return Buffer.from(await wb.xlsx.writeBuffer());
    };
    const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    await menu(page, 'Операции', 'Дълготрайни активи');
    const tab = activeTab(page);
    await tab.getByRole('button', { name: 'Импорт от Excel' }).click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'Импорт на дълготрайни активи от Excel' });
    await dlg.getByTestId('asset-import-file').setInputFiles({ name: 'активи.xlsx', mimeType: xlsxType, buffer: await book('999', true) });
    await dlg.getByRole('button', { name: 'Импорт', exact: true }).click();
    const errors = dlg.getByTestId('asset-import-errors');
    await expect(errors).toContainText('Импортът не може да бъде извършен поради следните причини:');
    await expect(errors).toContainText(`X${n}`);
    await expect(errors).toContainText('Не е намерена сметка с номер: 999.');

    await dlg.getByTestId('asset-import-file').setInputFiles({ name: 'активи.xlsx', mimeType: xlsxType, buffer: await book('203', false) });
    await dlg.getByRole('button', { name: 'Импорт', exact: true }).click();
    const alert = page.getByRole('dialog').filter({ hasText: 'Импортирани дълготрайни активи: 1.' });
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: 'OK' }).click();
    await expect(tab.getByRole('table', { name: 'Дълготрайни активи' })).toContainText(`Е2Е машина ${n}`);
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
