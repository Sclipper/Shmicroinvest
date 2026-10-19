import { expect, test, type Page } from '@playwright/test';
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
    await expect(dialog.getByLabel('Прикачен файл')).toHaveValue(/^Оборотна ведомост 2026\.12\.31\.xlsx$/);
    await dialog.getByLabel('До', { exact: true }).fill('лошо');
    await dialog.getByLabel('Копие до').fill('x@');
    await dialog.getByRole('button', { name: 'Изпрати' }).click();
    await expect(page.getByText('Невалиден e-mail адрес на получателя!')).toBeVisible();
    await expect(page.getByText('Невалиден e-mail адрес в полето "Копие до"!')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await dialog.getByLabel('До', { exact: true }).fill('boss@panels.bg');
    await dialog.getByLabel('Копие до').fill('');
    await dialog.getByRole('button', { name: 'Изпрати' }).click();
    await expect(page.getByText('Изпращането е успешно!')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    const log = await api<{ description: string }[]>(page, 'GET', '/activity?activity=export&entityType=turnoverReport');
    expect(log[0]!.description).toBe('Оборотна ведомост: e-mail до boss@panels.bg');
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
