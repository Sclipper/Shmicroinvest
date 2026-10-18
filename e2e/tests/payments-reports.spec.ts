import { expect, test, type Page } from '@playwright/test';
import { accountId, activeTab, api, openApp } from './fixtures.ts';
import { menuPath } from './payments-fixtures.ts';

/** Partner and cash reports (spec 05 6). The e2e company is shared (active year 2026): every test uses its own partner. */

const uid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function partner(page: Page, name: string, accounts: string[]) {
  const ids = await Promise.all(accounts.map((a) => accountId(page, a)));
  return (await api<{ id: number }>(page, 'POST', '/partners', { name, accountIds: ids })).id;
}

async function post(page: Page, e: { date: string; docType: number; docNumber: string; companyId: number; dr: [string, string]; cr: [string, string]; dueDate?: string; term?: string }) {
  return api<{ id: number }>(page, 'POST', '/entries', {
    accountingDate: e.date, documentTypeId: e.docType, documentNumber: e.docNumber, term: e.term ?? 'Е2Е справка', companyId: e.companyId, dueDate: e.dueDate,
    debits: [{ accountId: await accountId(page, e.dr[0]), amount: e.dr[1] }], credits: [{ accountId: await accountId(page, e.cr[0]), amount: e.cr[1] }],
  });
}

test.describe('partner and cash reports', () => {
  test('partner debts at document level show the open invoice', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const name = `Е2Е Длъжник ${id}`;
    const cli = await partner(page, name, ['411']);
    const doc = `D${id}`;
    await post(page, { date: '2026-03-02', docType: 1, docNumber: doc, companyId: cli, dr: ['411', '321.50'], cr: ['702', '321.50'] });

    await menuPath(page, 'Справки', 'Фирми', 'Задължения/вземания по партньори');
    const tab = activeTab(page);
    await tab.getByLabel('Ниво на справка').selectOption('document');
    await tab.getByLabel('Филтър', { exact: true }).fill(doc);
    await tab.getByRole('button', { name: 'Справка' }).click();
    await expect(tab.locator('table')).toContainText(name);
    await expect(tab.locator('tbody tr', { hasText: doc })).toContainText('321,50');
  });

  test('confirmation letter for one partner cites чл. 22 ЗСч and respects the minimum sum', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const name = `Е2Е Писмо ${id}`;
    const sup = await partner(page, name, ['401']);
    await post(page, { date: '2026-02-10', docType: 1, docNumber: `L${id}`, companyId: sup, dr: ['602', '480'], cr: ['401', '480'] });

    await menuPath(page, 'Справки', 'Фирми', 'Потвърдително писмо за задължения/вземания');
    const tab = activeTab(page);
    await tab.getByLabel('Партньор', { exact: true }).fill(name);
    await tab.getByRole('button', { name: 'Справка' }).click();
    await expect(tab.getByText('ПОТВЪРДИТЕЛНО ПИСМО').first()).toBeVisible();
    await expect(tab.getByText(/чл\. 22 от Закона за счетоводството/)).toBeVisible();
    await expect(tab.getByText(/ние Ви дължим 480,00 евро/)).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Печат на писмата' })).toBeEnabled();

    await tab.getByLabel('Минимална сума').fill('500');
    await tab.getByRole('button', { name: 'Справка' }).click();
    await expect(tab.getByText('Няма данни за избраните условия.')).toBeVisible();
  });

  test('overdue liabilities letter counts the days to the end date', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const name = `Е2Е Просрочил ${id}`;
    const cli = await partner(page, name, ['411']);
    await post(page, { date: '2026-03-01', docType: 1, docNumber: `O${id}`, companyId: cli, dueDate: '2026-03-10', dr: ['411', '75'], cr: ['702', '75'] });

    await menuPath(page, 'Справки', 'Фирми', 'Просрочени задължения');
    const tab = activeTab(page);
    await tab.getByLabel('Към дата').fill('2026-03-20');
    await tab.getByRole('button', { name: 'Справка' }).click();
    const letter = tab.locator('.pay-sheet', { hasText: name });
    await expect(letter).toContainText('С настоящото писмо най-учтиво Ви уведомяваме');
    await expect(letter.locator('tbody tr', { hasText: `O${id}` })).toContainText('10 дни');
  });

  test('cash book and cash order of a receipt from a partner', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const name = `Е2Е Каса ${id}`;
    const cli = await partner(page, name, ['411']);
    const num = String(Number(id.slice(-9)));
    await post(page, { date: '2026-05-05', docType: 8, docNumber: num, companyId: cli, term: 'Е2Е вноска', dr: ['501', '200'], cr: ['411', '200'] });

    await menuPath(page, 'Справки', 'Каса', 'Касова книга');
    let tab = activeTab(page);
    await tab.getByLabel('Партньор', { exact: true }).fill(name);
    await tab.getByRole('button', { name: 'Справка' }).click();
    const row = tab.locator('tbody tr', { hasText: name });
    await expect(row).toContainText('200,00');
    await expect(row).toContainText('411');
    await expect(tab.locator('tbody')).toContainText('Начално салдо');

    await menuPath(page, 'Справки', 'Каса', 'Касов ордер');
    tab = activeTab(page);
    await tab.getByLabel('Партньор', { exact: true }).fill(name);
    await tab.getByLabel('Получил').fill('Е2Е Касиер');
    await tab.getByRole('button', { name: 'Справка' }).click();
    const form = tab.locator('.pay-sheet').first();
    await expect(form).toContainText(`Приходен касов ордер № ${num} / 05.05.2026`);
    await expect(form).toContainText('Двеста евро');
    await expect(form).toContainText('Е2Е Касиер');
  });
});
