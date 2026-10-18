import { expect, test } from '@playwright/test';
import { accountId, activeTab, api, menu, moduleCompany } from './fixtures.ts';

const { openApp } = moduleCompany('payments');

const uid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

test.describe('automatic operations: revaluation and closings', () => {
  test('revalues a USD account with a manually entered fixing', async ({ page }) => {
    await openApp(page);
    const sub = await api<{ id: number; number: string }>(page, 'POST', '/accounts', { parentId: await accountId(page, '504'), description: `Е2Е USD ${uid()}`, accountCategoryId: 27, currencyId: 3 });
    await api(page, 'POST', '/entries', {
      accountingDate: '2026-09-10', documentTypeId: 1, documentNumber: `R${uid()}`, term: 'Е2Е валута',
      debits: [{ accountId: sub.id, amount: '110', currencyAmount: '120' }], credits: [{ accountId: await accountId(page, '702'), amount: '110' }],
    });

    await menu(page, 'Операции', 'Автоматични операции', 'Преоценка');
    const tab = activeTab(page);
    await tab.getByLabel('Дата', { exact: true }).fill('2026-09-30');
    const acc = tab.getByPlaceholder('Сметка (F4)');
    await acc.fill(sub.number);
    await acc.press('Enter');
    await tab.getByLabel('Курс USD').fill('0.925');
    await tab.getByLabel('Курс USD').press('Tab');
    // 120 * 0.925 = 111.00 against 110.00 booked: Positive 1.00, Dr account / Cr 724.
    const row = tab.getByRole('row').filter({ hasText: sub.number });
    await expect(row.getByRole('cell', { name: '111,00', exact: true })).toBeVisible();
    await expect(row.getByRole('cell', { name: '724', exact: true })).toBeVisible();
    await expect(row.getByRole('cell', { name: '1,00', exact: true })).toBeVisible();
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByText('Записани са 1 мемориални ордера.')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    const bal = await api<{ rows: { bookNet: string; curNet: string }[] }>(page, 'GET', `/revaluation/balances?date=2026-09-30&accountId=${sub.id}`);
    expect(bal.rows).toEqual([expect.objectContaining({ bookNet: '111.00', curNet: '120.00' })]);
  });

  test('closes an expense account 602 to 123 by hand', async ({ page }) => {
    await openApp(page);
    await api(page, 'POST', '/entries', {
      accountingDate: '2026-11-05', documentTypeId: 1, documentNumber: `K${uid()}`, term: 'Е2Е услуга',
      debits: [{ accountId: await accountId(page, '602'), amount: '75' }], credits: [{ accountId: await accountId(page, '503'), amount: '75' }],
    });

    await menu(page, 'Операции', 'Автоматични операции', 'Приключване на разходни и приходни сметки');
    const tab = activeTab(page);
    await tab.getByLabel('Период').selectOption({ label: 'Ноември' });
    await tab.getByLabel('Филтър по сметка').fill('602');
    await tab.getByLabel('Избор 602').check();
    const target = tab.getByPlaceholder('Сметка (F4)').first();
    await target.fill('123');
    await target.press('Enter');
    await expect(tab.getByText('Дт 123')).toBeVisible();
    await expect(tab.getByText('Кт 602')).toBeVisible();
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByText('Създадени са 1 мемориални ордера.')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(tab.getByLabel('Избор 602')).toBeHidden();
  });

  test('the "Приключване" tab of the financial years is enabled (checked without concluding)', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+y');
    const tab = activeTab(page);
    const conclude = tab.getByRole('button', { name: 'Приключване', exact: true });
    await expect(conclude).toBeEnabled();
    await conclude.click();
    await expect(tab).toContainText('2026 >> 2027');
    await expect(tab.getByText('крайните салда ще бъдат записани като начални салда за следващата')).toBeVisible();
    await expect(tab.getByRole('button', { name: 'Прехвърляне на салда' })).toBeEnabled();
  });
});
