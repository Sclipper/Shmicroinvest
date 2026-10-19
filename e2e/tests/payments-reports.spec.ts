import { expect, test, type Page } from '@playwright/test';
import { accountId, activeTab, api, menu, moduleCompany } from './fixtures.ts';

const { openApp } = moduleCompany('payments');

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

    await menu(page, 'Справки', 'Фирми', 'Задължения/вземания по партньори');
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

    await menu(page, 'Справки', 'Фирми', 'Потвърдително писмо за задължения/вземания');
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

    await menu(page, 'Справки', 'Фирми', 'Просрочени задължения');
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

    await menu(page, 'Справки', 'Каса', 'Касова книга');
    let tab = activeTab(page);
    await tab.getByLabel('Партньор', { exact: true }).fill(name);
    await tab.getByRole('button', { name: 'Справка' }).click();
    const row = tab.locator('tbody tr', { hasText: name });
    await expect(row).toContainText('200,00');
    await expect(row).toContainText('411');
    await expect(tab.locator('tbody')).toContainText('Начално салдо');

    await menu(page, 'Справки', 'Каса', 'Касов ордер');
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

test.describe('report frame and the chapter 05 gaps', () => {
  /** Closes the tab with the given title. */
  async function closeTab(page: Page, title: string) {
    const strip = page.locator('div.group', { has: page.getByRole('button', { name: title, exact: true }) });
    await strip.getByRole('button', { name: 'Затвори' }).click();
  }

  test('chronological register: document filter and sort; the last filter is restored when the report opens again', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const cli = await partner(page, `Е2Е Хронологичен ${id}`, ['411']);
    const doc = `H${id}`;
    await post(page, { date: '2026-06-03', docType: 1, docNumber: doc, companyId: cli, dr: ['411', '64.20'], cr: ['702', '64.20'] });

    await menu(page, 'Справки', 'Хронологичен регистър');
    let tab = activeTab(page);
    await tab.getByLabel('Документ №', { exact: true }).fill(doc);
    await tab.getByLabel('Сортиране').selectOption({ label: 'Сума' });
    const saved = page.waitForResponse((r) => r.url().includes('/settings/report-filters/chronological') && r.request().method() === 'PUT');
    await tab.getByRole('button', { name: 'Справка' }).click();
    await saved;
    await expect(tab.locator('tbody tr', { hasText: doc })).toContainText('64,20');

    await closeTab(page, 'Хронологичен регистър');
    await menu(page, 'Справки', 'Хронологичен регистър');
    tab = activeTab(page);
    await expect(tab.getByLabel('Документ №', { exact: true })).toHaveValue(doc);
    await expect(tab.getByLabel('Сортиране')).toHaveValue('Amount');
  });

  test('trial balance by partners with two partners picked; "Със сумиране" is off by default', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const names = [`Е2Е ОВ Първи ${id}`, `Е2Е ОВ Втори ${id}`];
    for (const [i, name] of names.entries()) {
      const cli = await partner(page, name, ['411']);
      await post(page, { date: '2026-06-10', docType: 1, docNumber: `TB${i}${id}`, companyId: cli, dr: ['411', i ? '222.22' : '111.11'], cr: ['702', i ? '222.22' : '111.11'] });
    }

    await menu(page, 'Справки', 'Оборотна ведомост');
    const tab = activeTab(page);
    await tab.getByLabel('Тип справка').selectOption({ label: 'По партньори' });
    const acc = tab.getByPlaceholder('Сметка (F4)');
    await acc.fill('411');
    await acc.press('Enter');
    const picker = tab.getByPlaceholder('Партньор (F4)');
    for (const name of names) {
      await picker.fill(name);
      await expect(page.getByText(name).last()).toBeVisible();
      await picker.press('Enter');
      await expect(tab.getByTestId('partner-multi')).toContainText(name);
    }
    await expect(tab.getByLabel('Със сумиране')).not.toBeChecked();
    await tab.getByRole('button', { name: 'Справка' }).click();
    await expect(tab.locator('tbody tr')).toHaveCount(2);
    await expect(tab.locator('tbody tr', { hasText: names[0] })).toContainText('111,11');
    await expect(tab.locator('tbody tr', { hasText: names[1] })).toContainText('222,22');
    await expect(tab.locator('tfoot')).toHaveCount(0);
  });

  test('Справка партньори lists the partner with its city, IBAN and accounts', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const name = `Е2Е Регистър ${id}`;
    await api(page, 'POST', '/partners', {
      name, bulstat: '175074752', accountIds: [await accountId(page, '411')],
      addresses: [{ city: 'Габрово', address: 'ул. Радецки 1', postalCode: '5300' }], bankAccounts: [{ account: 'BG18RZBB91550123456789' }],
    });

    await menu(page, 'Справки', 'Фирми', 'Справка партньори');
    const tab = activeTab(page);
    await tab.getByLabel('Филтър по').selectOption({ label: 'Фирма' });
    await tab.getByLabel('Филтър', { exact: true }).fill(name);
    await tab.getByRole('button', { name: 'Справка' }).click();
    const row = tab.locator('tbody tr', { hasText: name });
    await expect(row).toContainText('Габрово');
    await expect(row).toContainText('BG18RZBB91550123456789');
    await expect(row).toContainText('411');
    await expect(tab.locator('tbody tr')).toHaveCount(1);
  });

  test('cash above the legal limit: start-up pop-up with "Не показвай повече" and the link to the report', async ({ page }) => {
    await openApp(page);
    const e = await api<{ id: number }>(page, 'POST', '/entries', {
      accountingDate: '2026-01-15', documentTypeId: 8, documentNumber: `L${uid().slice(-9)}`, term: 'Е2Е лимит каса',
      debits: [{ accountId: await accountId(page, '501'), amount: '6000' }], credits: [{ accountId: await accountId(page, '101'), amount: '6000' }],
    });
    try {
      await page.reload();
      const popup = page.getByRole('alertdialog', { name: 'Касова наличност и вземания' });
      await expect(popup).toContainText('надвишава допустимия лимит от 5 112,92 EUR');
      await popup.getByLabel('Не показвай повече').check();
      const hidden = page.waitForResponse((r) => r.url().includes('/reports/cash-and-receivables/limit') && r.request().method() === 'PUT');
      await popup.getByRole('button', { name: 'Касова наличност и вземания' }).click();
      await hidden;
      await expect(popup).toHaveCount(0);
      const tab = activeTab(page);
      await tab.getByRole('button', { name: 'Справка' }).click();
      await expect(tab.getByRole('alert')).toContainText('надвишава допустимия лимит');
      await expect(tab.getByRole('button', { name: 'Редакция на формули' })).toBeEnabled();

      await page.reload();
      await expect(page.locator('footer')).toBeVisible();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
    } finally {
      await api(page, 'DELETE', `/entries/${e.id}`);
    }
  });
});
