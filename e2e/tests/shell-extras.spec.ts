import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { extractPdfText, pdfPageCount } from '../../packages/core/src/pdf.ts';
import { unzipStore } from '../../packages/core/src/xlsx.ts';
import { ADMIN, accountId, activeTab, api, menu, moduleCompany } from './fixtures.ts';

/**
 * Shell side panels (06 2.1), settings gaps (06 3.4), window shortcuts in the
 * payments screen and the reports (06 2.6), Действия по потребители (01b 8),
 * e-mail of reports (04b 3), carry-over of templates (01b 1.2) and the
 * chart-type check (03a 1.1).
 */
const { openApp, name: COMPANY } = moduleCompany('shell');

const uid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function partner(page: Page, name: string, accounts: string[]) {
  const ids = await Promise.all(accounts.map((a) => accountId(page, a)));
  return (await api<{ id: number }>(page, 'POST', '/partners', { name, accountIds: ids })).id;
}

async function post(page: Page, e: { date: string; docType: number; docNumber: string; companyId?: number; dr: [string, string]; cr: [string, string] }) {
  return api<{ id: number }>(page, 'POST', '/entries', {
    accountingDate: e.date, documentTypeId: e.docType, documentNumber: e.docNumber, term: 'Е2Е панели', companyId: e.companyId ?? null,
    debits: [{ accountId: await accountId(page, e.dr[0]), amount: e.dr[1] }], credits: [{ accountId: await accountId(page, e.cr[0]), amount: e.cr[1] }],
  });
}

/** Runs the trial balance of the active year in a fresh tab. */
async function runTrialBalance(page: Page) {
  await menu(page, 'Справки', 'Оборотна ведомост');
  const tab = activeTab(page);
  await tab.getByRole('button', { name: 'Справка', exact: true }).click();
  await expect(tab.locator('table.grid-table')).toBeVisible();
  return tab;
}

test.describe('shell, settings and reports', () => {
  test.beforeAll(async ({ browser }) => {
    // One entry so the reports have data.
    const page = await (await browser.newContext({ storageState: '.auth/shell.json' })).newPage();
    await page.goto('/');
    await post(page, { date: '2026-02-01', docType: 10, docNumber: 'МО-1', dr: ['501', '1000'], cr: ['101', '1000'] });
    await page.context().close();
  });

  test('settings: most-used VAT operations stored as enum names, invoice as payment document in F3', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Други', 'Настройки');
    const tab = activeTab(page);
    await tab.getByRole('tab', { name: 'Основни' }).click();
    await tab.getByLabel('Най-често използвана операция по ДДС при продажба').selectOption({ label: 'Облагаеми доставки със ставка 9%' });
    await tab.getByLabel('Разплащане на задължения/вземания с документ тип Фактура').check();
    await tab.getByRole('button', { name: 'Запис' }).click();
    await expect(tab.getByText(/Незаписани промени/)).toBeHidden();
    const settings = await api<{ key: string; value: string }[]>(page, 'GET', '/settings');
    expect(settings.find((x) => x.key === 'SaleVatTerm')!.value).toBe('Sale9');
    expect(settings.find((x) => x.key === 'InvoiceAsPaymentDocument')!.value).toBe('True');

    try {
      const id = uid();
      const name = `Е2Е Фактура плащане ${id}`;
      const cli = await partner(page, name, ['411']);
      const doc = `F${id}`;
      await post(page, { date: '2026-03-02', docType: 1, docNumber: doc, companyId: cli, dr: ['411', '80'], cr: ['702', '80'] });
      await page.reload();
      await menu(page, 'Операции', 'Разплащания');
      const pay = activeTab(page);
      await pay.getByLabel('Търсене на партньор').fill(name);
      await pay.getByTestId('payments-partners').getByRole('cell', { name }).click();
      await pay.getByTestId('payments-liabilities').getByLabel(`Избор Ф-ра ${doc}`).check();
      // F10 (window shortcut "Разплащане") opens the payment.
      await pay.getByTestId('payments-liabilities').click();
      await page.keyboard.press('F10');
      const dialog = page.getByRole('dialog');
      const acc = dialog.getByPlaceholder('Сметка (F4)');
      await acc.fill('501');
      await acc.press('Enter');
      await expect(dialog.getByLabel('Платежен документ', { exact: true })).toHaveValue('1');
      await dialog.getByRole('button', { name: 'Запис' }).click();
      await expect(dialog).toBeHidden();
      // The payment entry is a Фактура with the paid invoice's number.
      const list = await api<{ rows: { document_type: string | null; document_number: string | null; source: string }[] }>(page, 'GET', '/entries?limit=2000');
      expect(list.rows.filter((r) => r.document_number === doc).map((r) => `${r.source}:${r.document_type}`).sort()).toEqual(['manual:Фактура', 'payment:Фактура']);
    } finally {
      await api(page, 'PUT', '/settings', { InvoiceAsPaymentDocument: 'False', SaleVatTerm: '' });
    }
  });

  test('side panels: messages, help and quick commands, collapsible and persisted', async ({ page }) => {
    await openApp(page);
    const my = await api<Record<string, unknown>>(page, 'GET', '/my-company');
    const accounts = await api<{ id: number; number: string }[]>(page, 'GET', '/accounts');
    const payable = accounts.find((a) => a.number === '453/9')!;
    await api(page, 'PUT', '/my-company', { ...my, isVat: true, vatId: 'BG831641791' });
    await api(page, 'PUT', `/accounts/${payable.id}`, { accountCategoryId: null });
    try {
      await page.reload();
      // Collapsed by default: the strip shows the panel captions and the message count.
      await expect(page.getByTestId('messages-badge')).toHaveText('1');
      await menu(page, 'Прозорци', 'Съобщения');
      const messages = page.getByTestId('panel-messages');
      await expect(messages.getByTestId('messages-list')).toContainText('Липсват следните ДДС сметки: ДДС за внасяне');
      await messages.getByRole('button', { name: 'Индивидуален сметкоплан' }).click();
      const help = page.getByTestId('help-panel');
      await expect(help).toContainText('Индивидуален сметкоплан');
      await expect(help).toContainText('Операции › Сметкоплан и начални салда › Индивидуален сметкоплан (Ctrl+H)');

      // Quick commands of a report: "Справка" runs it.
      await menu(page, 'Справки', 'Оборотна ведомост');
      const quick = page.getByTestId('panel-quick');
      await quick.getByRole('button', { name: 'Справка' }).click();
      await expect(activeTab(page).locator('table.grid-table')).toBeVisible();
      await expect(quick.getByRole('button', { name: /^Печат/ })).toBeEnabled();

      // A panel collapses from its header; the state survives a reload.
      await page.getByRole('button', { name: 'Помощен панел' }).click();
      await expect(page.getByTestId('help-panel')).toBeHidden();
      await page.reload();
      await expect(page.getByTestId('panel-messages').getByTestId('messages-list')).toBeVisible();
      await expect(page.getByTestId('help-panel')).toBeHidden();
      await page.getByRole('button', { name: 'Скриване на панелите' }).click();
      await expect(page.getByTestId('panel-messages')).toBeHidden();
      await expect(page.getByRole('button', { name: 'Показване на панелите' })).toBeVisible();
    } finally {
      await api(page, 'PUT', `/accounts/${payable.id}`, { accountCategoryId: 36 });
      await api(page, 'PUT', '/my-company', { ...my });
    }
  });

  test('reports: Ctrl+E exports and is logged; a saved override applies; print logs too', async ({ page }) => {
    await openApp(page);
    const tab = await runTrialBalance(page);
    await tab.locator('table.grid-table').click();
    let download = page.waitForEvent('download');
    await page.keyboard.press('Control+e');
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
    const log = await api<{ activity: string; entityType: string; description: string }[]>(page, 'GET', '/activity?activity=export&entityType=turnoverReport');
    expect(log[0]!.description).toBe('Оборотна ведомост (Excel)');

    await api(page, 'PUT', '/settings/shortcuts', { overrides: { Export: 'Alt+X', Print: 'Alt+Z' } });
    try {
      await page.reload();
      const tb = await runTrialBalance(page);
      await expect(tb.getByRole('button', { name: 'Експорт Excel' })).toHaveAttribute('title', 'Alt+X');
      await tb.locator('table.grid-table').click();
      download = page.waitForEvent('download');
      await page.keyboard.press('Alt+x');
      expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
      await page.evaluate(() => { window.print = () => undefined; });
      await page.keyboard.press('Alt+z');
      await expect.poll(async () => (await api<{ entityType: string }[]>(page, 'GET', '/activity?activity=print'))[0]?.entityType).toBe('turnoverReport');
    } finally {
      await api(page, 'DELETE', '/settings/shortcuts');
    }
  });

  test('shortcuts page prints the list grouped by type', async ({ page }) => {
    await page.addInitScript(() => {
      window.print = () => {
        (window as unknown as { __printed: string }).__printed = (document.querySelector('.report-print-portal') as HTMLElement | null)?.innerText ?? '';
      };
    });
    await openApp(page);
    await menu(page, 'Други', 'Клавишни комбинации');
    await activeTab(page).getByRole('button', { name: 'Печат' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printed?: string }).__printed ?? '')).toContain('Главно меню');
    const text = await page.evaluate(() => (window as unknown as { __printed: string }).__printed);
    expect(text).toContain('Клавишни комбинации');
    expect(text.indexOf('Прозорец (редакция)')).toBeLessThan(text.indexOf('Главно меню'));
    expect(text).toContain('Експорт (справки)');
    expect(text).toContain('Ctrl+E');
  });

  test('Действия по потребители: by documents and by menus, filtered on the server', async ({ page }) => {
    await openApp(page);
    await api(page, 'POST', '/activity/log', { activity: 'export', entityType: 'analyticalReport', description: 'Е2Е аналитичен' });
    await menu(page, 'Справки', 'Действия по потребители');
    const tab = activeTab(page);
    await tab.getByLabel('Тип справка').selectOption({ label: 'По документи' });
    await tab.getByRole('button', { name: 'Справка', exact: true }).click();
    const docs = tab.getByTestId('activity-documents');
    await expect(docs).toContainText(ADMIN.name);
    await expect(docs.locator('thead')).toContainText('Мемориален ордер');

    await tab.getByLabel('Тип справка').selectOption({ label: 'По менюта' });
    await tab.getByLabel('Действие').selectOption({ label: 'Експорт на справка' });
    await tab.getByRole('button', { name: 'Справка', exact: true }).click();
    const logTable = tab.getByTestId('activity-log');
    await expect(logTable).toContainText('Е2Е аналитичен');
    await expect(logTable).not.toContainText('Вписване');
  });

  test('e-mail: SMTP page with test send, report sent as .xlsx with To/CC validation', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Други', 'Настройки');
    const settings = activeTab(page);
    await settings.getByRole('tab', { name: 'E-mail' }).click();
    await settings.getByLabel('SMTP сървър').fill('smtp.panels.bg');
    await settings.getByLabel('Порт').fill('587');
    await settings.getByLabel('Парола на SMTP').fill('Tajna-e2e');
    await settings.getByLabel('E-mail адрес на подателя').fill('office@panels.bg');
    await settings.getByRole('button', { name: 'Запис' }).click();
    await expect(settings.getByText(/Запазена парола/)).toBeVisible();
    expect(JSON.stringify(await api(page, 'GET', '/settings/smtp'))).not.toContain('Tajna-e2e');
    await settings.getByRole('button', { name: 'Тестово изпращане' }).click();
    await expect(page.getByRole('dialog')).toContainText('Изпращането е успешно! (office@panels.bg)');
    await page.getByRole('button', { name: 'OK' }).click();

    const tab = await runTrialBalance(page);
    await tab.getByRole('button', { name: 'Изпращане по e-mail' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Прикачен файл' });
    // PDF by default; Excel is still available and renames the attachment.
    await expect(dialog.getByLabel('Формат на прикачения файл')).toHaveValue('pdf');
    await expect(dialog.getByLabel('Прикачен файл')).toHaveValue(/^Оборотна ведомост 2026\.12\.31\.pdf$/);
    await dialog.getByLabel('Формат на прикачения файл').selectOption('xlsx');
    await expect(dialog.getByLabel('Прикачен файл')).toHaveValue(/^Оборотна ведомост 2026\.12\.31\.xlsx$/);
    await dialog.getByLabel('До', { exact: true }).fill('лошо');
    await dialog.getByLabel('Копие до').fill('x@');
    await dialog.getByRole('button', { name: 'Изпрати' }).click();
    await expect(page.getByText('Невалиден e-mail адрес на получателя!')).toBeVisible();
    await expect(page.getByText('Невалиден e-mail адрес в полето "Копие до"!')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await dialog.getByLabel('До', { exact: true }).fill('boss@panels.bg');
    await dialog.getByLabel('Копие до').fill('');
    const request = page.waitForRequest((r) => r.url().endsWith('/api/email/report'));
    await dialog.getByRole('button', { name: 'Изпрати' }).click();
    await expect(page.getByText('Изпращането е успешно!')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    const sent = (await request).postDataJSON() as { attachment: { fileName: string; contentBase64: string } };
    expect(sent.attachment.fileName).toBe('Оборотна ведомост 2026.12.31.xlsx');
    expect(Buffer.from(sent.attachment.contentBase64, 'base64').subarray(0, 2).toString('latin1')).toBe('PK');
    const log = await api<{ description: string }[]>(page, 'GET', '/activity?activity=export&entityType=turnoverReport');
    expect(log[0]!.description).toBe('Оборотна ведомост: e-mail до boss@panels.bg');
  });

  test('reports: PDF and Word export of the report viewer, logged like Excel', async ({ page }) => {
    await openApp(page);
    const tab = await runTrialBalance(page);

    let download = page.waitForEvent('download');
    await tab.getByRole('button', { name: 'Експорт PDF' }).click();
    const pdfFile = await download;
    expect(pdfFile.suggestedFilename()).toMatch(/^ОВ_2026-01-01_2026-12-31\.pdf$/);
    const pdf = new Uint8Array(await readFile(await pdfFile.path()));
    expect(Buffer.from(pdf.subarray(0, 8)).toString('latin1')).toBe('%PDF-1.7');
    expect(pdfPageCount(pdf)).toBeGreaterThanOrEqual(1);
    const text = (await extractPdfText(pdf)).join('\n');
    expect(text).toContain('Оборотна ведомост');
    expect(text).toContain(COMPANY);
    expect(text).toContain('Начално салдо Дебит');
    expect(text).toContain('1 000,00');
    expect(text).toContain('Страница 1 от');

    download = page.waitForEvent('download');
    await tab.getByRole('button', { name: 'Експорт Word' }).click();
    const docxFile = await download;
    expect(docxFile.suggestedFilename()).toMatch(/^ОВ_2026-01-01_2026-12-31\.docx$/);
    const files = unzipStore(new Uint8Array(await readFile(await docxFile.path())));
    const xml = new TextDecoder().decode(files.get('word/document.xml'));
    expect(xml).toContain('>Оборотна ведомост<');
    expect(xml).toContain('<w:tblHeader/>');
    expect(xml).toContain('1 000,00');

    const log = await api<{ description: string }[]>(page, 'GET', '/activity?activity=export&entityType=turnoverReport');
    expect(log.slice(0, 2).map((l) => l.description).sort()).toEqual(['Оборотна ведомост (PDF)', 'Оборотна ведомост (Word)']);
  });

  test('e-mail: a report on one partner goes to the partner e-mail with the PDF attached', async ({ page }) => {
    await openApp(page);
    await api(page, 'PUT', '/settings/smtp', { host: 'smtp.panels.bg', port: 587, userName: 'office', password: 'Tajna-e2e', email: 'office@panels.bg', enableSsl: true });
    const id = uid();
    const name = `Е2Е Имейл ${id}`;
    const email = `klient${id}@klient.bg`;
    const cli = (await api<{ id: number }>(page, 'POST', '/partners', { name, email, accountIds: [await accountId(page, '411')] })).id;
    await post(page, { date: '2026-03-01', docType: 10, docNumber: `Ф-${id}`, companyId: cli, dr: ['411', '120'], cr: ['702', '120'] });
    // The report opens with this filter (the user's last run, 05 1.2).
    await api(page, 'PUT', '/settings/report-filters/partnerTurnover', { from: '2026-01-01', to: '2026-12-31', account: '411', zero: false, byExportMonth: false, companyId: cli, companyName: name });

    const restored = page.waitForResponse((r) => r.url().includes('/settings/report-filters/partnerTurnover') && r.request().method() === 'GET');
    await menu(page, 'Справки', 'Фирми', 'Оборотна ведомост по партньори');
    await restored;
    const tab = activeTab(page);
    await expect(tab.getByPlaceholder('Партньор (F4)')).toHaveValue(name);
    await tab.getByRole('button', { name: 'Справка', exact: true }).click();
    await expect(tab.locator('table.grid-table')).toContainText(name);

    await tab.getByRole('button', { name: 'Изпращане по e-mail' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Прикачен файл' });
    await expect(dialog.getByLabel('До', { exact: true })).toHaveValue(email);
    await expect(dialog.getByLabel('Формат на прикачения файл')).toHaveValue('pdf');
    await expect(dialog.getByLabel('Прикачен файл')).toHaveValue('Задължения_вземания по партньори 2026.12.31.pdf');
    const request = page.waitForRequest((r) => r.url().endsWith('/api/email/report'));
    await dialog.getByRole('button', { name: 'Изпрати' }).click();
    await expect(page.getByText('Изпращането е успешно!')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();

    const sent = (await request).postDataJSON() as { to: string; report: string; attachment: { fileName: string; contentBase64: string } };
    expect(sent.to).toBe(email);
    expect(sent.attachment.fileName).toBe('Задължения_вземания по партньори 2026.12.31.pdf');
    const pdf = new Uint8Array(Buffer.from(sent.attachment.contentBase64, 'base64'));
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = (await extractPdfText(pdf)).join('\n');
    expect(text).toContain('Задължения/вземания по партньори');
    expect(text).toContain(name);
    expect(text).toContain('120,00');
    const log = await api<{ description: string }[]>(page, 'GET', '/activity?activity=export&entityType=report');
    expect(log[0]!.description).toBe(`Задължения/вземания по партньори: e-mail до ${email}`);
  });

  test('new company carries over the accounting and bank-import templates', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const tpl = `Е2Е шаблон ${id}`;
    await api(page, 'POST', '/templates', { name: tpl, documentTypeId: 10, term: 'Наем', debits: [{ accountId: await accountId(page, '602'), amount: '100' }], credits: [{ accountId: await accountId(page, '401'), amount: '100' }] });
    await menu(page, 'Файл', 'Нова фирма...');
    const dialog = page.getByRole('dialog').filter({ hasText: 'Име на фирмата' });
    await dialog.getByLabel('Име на фирмата').fill(`Е2Е Шаблони ${id}`);
    await dialog.getByLabel('Парола', { exact: true }).fill('secret12');
    await dialog.getByLabel('Повтори паролата').fill('secret12');
    await dialog.getByLabel('Шаблони на контировки').check();
    await expect(dialog.getByLabel('Сметкоплан', { exact: true })).toBeChecked();
    await expect(dialog.getByLabel('Сметкоплан', { exact: true })).toBeDisabled();
    await dialog.getByLabel('Шаблони за банков импорт').check();
    await dialog.getByRole('button', { name: 'Създай' }).click();
    await expect(page.locator('footer')).toContainText(`Е2Е Шаблони ${id}`);
    const list = await api<{ name: string }[]>(page, 'GET', '/templates');
    expect(list.map((x) => x.name)).toContain(tpl);
    expect((await api<{ total: number }>(page, 'GET', '/entries')).total).toBe(0);
  });

  test('strChartOfAccountsNotDefined opens the chart selection; strSelectedAccountsExistWarning on leaving it', async ({ page }) => {
    await openApp(page);
    const id = uid();
    await api(page, 'POST', '/companies', { companyName: `Е2Е Без сметкоплан ${id}`, adminName: ADMIN.name, adminPassword: ADMIN.password, year: 2026, chartTemplate: null });
    await page.goto('/');
    await expect(page.locator('footer')).toContainText(`Е2Е Без сметкоплан ${id}`);
    await menu(page, 'Операции', 'Сметкоплан и начални салда', 'Индивидуален сметкоплан');
    await expect(page.getByRole('dialog')).toContainText('Не е избран тип на сметкоплан!');
    await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
    const tab = activeTab(page);
    await expect(tab.getByRole('button', { name: 'Добавяне на избраните' })).toBeVisible();
    // Leaving with selected, not transferred accounts asks first.
    await page.locator('[aria-label="Затвори"]').last().click();
    await expect(page.getByRole('dialog')).toContainText('Има избрани сметки, които не са прехвърлени в индивидуалния сметкоплан. Желаете ли да продължите?');
    await page.getByRole('dialog').getByRole('button', { name: 'Не', exact: true }).click();
    await tab.getByRole('button', { name: 'Добавяне на избраните' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Да', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
    expect((await api<{ chartOfAccountsType: string }>(page, 'GET', '/session')).chartOfAccountsType).toBe('commercial');
    void COMPANY;
  });
});
