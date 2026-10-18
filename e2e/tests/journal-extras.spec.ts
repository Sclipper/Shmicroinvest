import { expect, test, type Page } from '@playwright/test';
import { accountId, activeTab, api, menu, openApp } from './fixtures.ts';

/** Journal extras (spec 02a 5, 6, 8, 9) and material delivery / sale (03a 4.5). */

interface EntryRow { id: number; number: string; term: string | null; document_number: string | null; amount: string }

async function entries(page: Page, params: Record<string, string>) {
  return (await api<{ rows: EntryRow[] }>(page, 'GET', `/entries?${new URLSearchParams(params)}`)).rows;
}

async function postEntry(page: Page, docNumber: string, term: string, debit: string, credit: string, amount: string) {
  return api<{ id: number; number: string }>(page, 'POST', '/entries', {
    accountingDate: '2026-04-10', documentTypeId: 10, documentNumber: docNumber, term,
    debits: [{ accountId: await accountId(page, debit), amount }], credits: [{ accountId: await accountId(page, credit), amount }],
  });
}

async function pickAccount(page: Page, index: number, number: string) {
  const input = activeTab(page).getByPlaceholder('Сметка (F4)').nth(index);
  await input.fill(number);
  await input.press('Enter');
}

test.describe('journal extras', () => {
  test('saves an entry as a template and applies it to a new entry (9.1)', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('F2');
    const tab = activeTab(page);
    await tab.getByLabel('Документ №').fill('E2E-T1');
    await tab.getByLabel('Основание').fill('Наем офис E2E');
    await pickAccount(page, 0, '602');
    await pickAccount(page, 1, '503');
    await tab.locator('td input.num').nth(0).fill('350');
    await tab.getByRole('button', { name: 'Изравняване' }).click();
    await tab.getByRole('button', { name: 'Запис като шаблон' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Име на шаблон').fill('E2E Наем');
    await dlg.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(dlg).toHaveCount(0);
    await tab.getByRole('button', { name: 'Отказ' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Да' }).click();

    await page.keyboard.press('F2');
    const fresh = activeTab(page);
    await fresh.getByRole('button', { name: 'Шаблон', exact: true }).click();
    await page.getByRole('dialog').getByRole('cell', { name: 'E2E Наем' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Зареждане' }).click();
    await expect(fresh.getByLabel('Основание')).toHaveValue('Наем офис E2E');
    await expect(fresh.getByText('Общо дебит: 350,00')).toBeVisible();
    await fresh.getByLabel('Документ №').fill('E2E-T2');
    await fresh.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect.poll(async () => (await entries(page, { documentNumber: 'E2E-T2' })).length).toBe(1);
  });

  test('fast entry posts all rows at once (8.1)', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('F12');
    const tab = activeTab(page);
    await expect(tab.getByTestId('fast-entry')).toBeVisible();
    await tab.getByRole('button', { name: 'Прибавяне на ред' }).click();
    for (const [i, n] of ['FE-1', 'FE-2'].entries()) {
      await tab.getByLabel(`Тип док. ${i + 1}`).selectOption({ label: 'МО' });
      await tab.getByLabel(`Документ № ${i + 1}`).fill(n);
      await pickAccount(page, i * 2, '602');
      await pickAccount(page, i * 2 + 1, '503');
      await tab.getByLabel(`Ст-ст ${i + 1}`).fill(String(10 * (i + 1)));
      await tab.getByPlaceholder('Основание').nth(i).fill('Бързо E2E');
    }
    await tab.getByRole('button', { name: 'Контиране' }).click();
    await expect(page.getByRole('dialog')).toContainText('Записани са 2 контировки');
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    const rows = await entries(page, { term: 'Бързо E2E' });
    expect(rows.map((r) => [r.document_number, Number(r.amount)]).sort()).toEqual([['FE-1', 10], ['FE-2', 20]]);
  });

  test('copies an entry from the list ("Ново контиране от избраното", 5.3)', async ({ page }) => {
    await openApp(page);
    await postEntry(page, 'CP-1', 'Копие E2E', '602', '503', '42');
    await page.keyboard.press('Control+F2');
    const list = activeTab(page);
    await list.getByRole('cell', { name: 'Копие E2E' }).first().click();
    await list.getByRole('button', { name: 'Ново контиране от избраното' }).click();
    const editor = activeTab(page);
    await expect(editor.getByLabel('Основание')).toHaveValue('Копие E2E');
    await expect(editor.getByLabel('Документ №')).toHaveValue('CP-1');
    await editor.getByLabel('Документ №').fill('CP-2');
    await editor.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect.poll(async () => (await entries(page, { term: 'Копие E2E' })).map((r) => r.document_number).sort()).toEqual(['CP-1', 'CP-2']);
  });

  test('mass edit replaces the term on the selected entries (6)', async ({ page }) => {
    await openApp(page);
    await postEntry(page, 'ME-1', 'Масово E2E', '602', '503', '5');
    await postEntry(page, 'ME-2', 'Масово E2E', '602', '503', '6');
    await menu(page, 'Редакция', 'Администриране', 'Редакция на контировки');
    const tab = activeTab(page);
    await tab.getByLabel('Основание', { exact: true }).fill('Масово E2E');
    await tab.getByRole('button', { name: 'Филтрирай' }).click();
    await expect(tab.getByRole('cell', { name: 'Масово E2E' })).toHaveCount(2);
    await tab.getByLabel('Избор на всички').check();
    await tab.getByLabel('Ново основание').fill('Масово E2E коригирано');
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Редактирани контировки: 2.');
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    expect(await entries(page, { term: 'Масово E2E коригирано' })).toHaveLength(2);
  });

  test('product delivery and sale through the material dialogs (03a 4.5)', async ({ page }) => {
    await openApp(page);
    for (const [n, cat] of [['304', 3], ['702', 24]] as const) await api(page, 'PUT', `/accounts/${await accountId(page, n)}`, { accountCategoryId: cat });
    await api(page, 'POST', '/products', { name: 'E2E Стока', measure: 'бр.', price: '5', incrementAccountIds: [await accountId(page, '304')], decrementAccountIds: [await accountId(page, '702')] });

    // Доставка на СМЗ (Ctrl+Shift+D): the material dialog opens by itself.
    await page.keyboard.press('Control+Shift+D');
    let dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Доставка на стоково-материални запаси');
    await dlg.getByLabel('Филтър по име, сметка или код').fill('E2E Стока');
    await dlg.getByLabel('Филтър по име, сметка или код').press('Enter');
    await dlg.getByLabel('Количество E2E Стока').fill('10');
    await dlg.getByLabel('Цена E2E Стока').fill('2');
    await dlg.getByRole('button', { name: 'OK' }).click();
    let tab = activeTab(page);
    await expect(tab.getByText('Общо дебит: 20,00')).toBeVisible();
    await pickAccount(page, 1, '503');
    await tab.getByRole('button', { name: 'Изравняване' }).click();
    await tab.getByLabel('Документ №').fill('DL-1');
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect.poll(async () => (await entries(page, { documentNumber: 'DL-1' })).length).toBe(1);

    // Продажба на СМЗ (Ctrl+Shift+S): sale lines go to the credit side.
    await page.keyboard.press('Control+Shift+S');
    dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Продажба на стоково-материални запаси');
    await dlg.getByLabel('Филтър по име, сметка или код').fill('E2E Стока');
    await dlg.getByLabel('Филтър по име, сметка или код').press('Enter');
    await dlg.getByLabel('Количество E2E Стока').fill('4');
    await dlg.getByLabel('Цена E2E Стока').fill('5');
    await dlg.getByRole('button', { name: 'OK' }).click();
    tab = activeTab(page);
    await expect(tab.getByText('Общо кредит: 20,00')).toBeVisible();
    await pickAccount(page, 0, '501');
    await tab.getByRole('button', { name: 'Изравняване' }).click();
    await tab.getByLabel('Документ №').fill('SL-1');
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect.poll(async () => (await entries(page, { documentNumber: 'SL-1' })).length).toBe(1);
    const sale = await api<{ credits: { quantity: string; price: string; amount: string }[] }>(page, 'GET', `/entries/${(await entries(page, { documentNumber: 'SL-1' }))[0]!.id}`);
    expect(sale.credits[0]).toMatchObject({ amount: '20.00' });
    expect(Number(sale.credits[0]!.quantity)).toBe(4);
  });
});
