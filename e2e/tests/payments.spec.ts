import { expect, test, type Page } from '@playwright/test';
import { accountId, activeTab, api, menu, openApp } from './fixtures.ts';

const uid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function partner(page: Page, name: string, accounts: string[]) {
  const ids = await Promise.all(accounts.map((a) => accountId(page, a)));
  return (await api<{ id: number }>(page, 'POST', '/partners', { name, accountIds: ids })).id;
}

async function post(page: Page, e: { date: string; docType: number; docNumber: string; companyId: number; dr: [string, string]; cr: [string, string] }) {
  return api<{ id: number }>(page, 'POST', '/entries', {
    accountingDate: e.date, documentTypeId: e.docType, documentNumber: e.docNumber, term: 'Е2Е разплащане', companyId: e.companyId,
    debits: [{ accountId: await accountId(page, e.dr[0]), amount: e.dr[1] }], credits: [{ accountId: await accountId(page, e.cr[0]), amount: e.cr[1] }],
  });
}

const openItems = (page: Page, companyId: number) =>
  api<{ liabilities: { accountingId: number }[]; payments: { accountingId: number }[] }>(page, 'GET', `/payments/open-items?companyId=${companyId}`);

test.describe('payments', () => {
  test('pays an open invoice from F3 and it disappears from the list', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const name = `Е2Е Платец ${id}`;
    const cli = await partner(page, name, ['411']);
    const doc = `F${id}`;
    await post(page, { date: '2026-03-02', docType: 1, docNumber: doc, companyId: cli, dr: ['411', '150'], cr: ['702', '150'] });

    await menu(page, 'Операции', 'Разплащания');
    const tab = activeTab(page);
    await tab.getByLabel('Търсене на партньор').fill(name);
    await tab.getByTestId('payments-partners').getByRole('cell', { name }).click();
    const liabilities = tab.getByTestId('payments-liabilities');
    await expect(liabilities.locator(`tr[data-doc="${doc}"]`)).toBeVisible();
    await liabilities.getByLabel(`Избор Ф-ра ${doc}`).check();
    await tab.getByRole('button', { name: 'Разплащане', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Сума на плащането')).toHaveValue('150.00');
    const acc = dialog.getByPlaceholder('Сметка (F4)');
    await acc.fill('501');
    await acc.press('Enter');
    await dialog.getByRole('button', { name: 'Запис' }).click();
    await expect(dialog).toBeHidden();
    await expect(tab.getByTestId('payments-partners').getByRole('cell', { name })).toBeHidden();
    expect((await openItems(page, cli)).liabilities).toHaveLength(0);
  });

  test('documents closing by amount pairs an invoice with a cash receipt', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const cli = await partner(page, `Е2Е Закриване ${id}`, ['411']);
    const doc = `C${id}`;
    await post(page, { date: '2026-04-01', docType: 1, docNumber: doc, companyId: cli, dr: ['411', '100'], cr: ['702', '100'] });
    await post(page, { date: '2026-04-03', docType: 8, docNumber: `P${id}`, companyId: cli, dr: ['501', '100'], cr: ['411', '100'] });

    await menu(page, 'Операции', 'Автоматични операции', 'Закриване на документи');
    const tab = activeTab(page);
    await tab.getByLabel('Начин на търсене').selectOption('amount');
    await tab.getByLabel('№ на документ').fill(doc);
    await tab.getByRole('button', { name: 'Филтриране' }).click();
    const grid = tab.getByTestId('closing-grid');
    await expect(grid.locator(`tr[data-doc="${doc}"]`)).toContainText('Вземане');
    await expect(grid.locator(`tr[data-doc="P${id}"]`)).toContainText('Плащане');
    await tab.getByRole('button', { name: 'Запис' }).click();
    await expect(page.getByText('Документите са закрити успешно.')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(tab.getByText('Няма документи за закриване.')).toBeVisible();
    const open = await openItems(page, cli);
    expect(open.liabilities).toHaveLength(0);
    expect(open.payments).toHaveLength(0);
  });

  test('automatic payment from the entry editor settles the new invoice', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const name = `Е2Е Автоматично ${id}`;
    const cli = await partner(page, name, ['411']);

    await page.keyboard.press('F2');
    const tab = activeTab(page);
    await tab.getByLabel('Документ №').fill(`A${id}`);
    await tab.getByLabel('Основание').fill('Продажба с автоматично разплащане');
    const partnerPicker = tab.getByPlaceholder('Партньор (F4)');
    await partnerPicker.fill(name);
    await expect(page.getByText(name).last()).toBeVisible();
    await partnerPicker.press('Enter');
    const accounts = tab.getByPlaceholder('Сметка (F4)');
    await accounts.nth(0).fill('411');
    await accounts.nth(0).press('Enter');
    await accounts.nth(1).fill('702');
    await accounts.nth(1).press('Enter');
    await tab.locator('td input.num').nth(0).fill('80');
    await tab.getByRole('button', { name: 'Изравняване' }).click();

    const panel = tab.getByTestId('entry-payment');
    await panel.getByText('Автоматично разплащане').click();
    const payAcc = panel.getByPlaceholder('Сметка (F4)');
    await payAcc.fill('501');
    await payAcc.press('Enter');
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();

    await expect.poll(async () => (await api<unknown[]>(page, 'GET', `/payments/links?companyId=${cli}`)).length).toBe(1);
    const open = await openItems(page, cli);
    expect(open.liabilities).toHaveLength(0);
    expect(open.payments).toHaveLength(0);
  });
});
