import { expect, test } from '@playwright/test';
import { accountId, activeTab, api, moduleCompany } from './fixtures.ts';

/** Audit gaps: chart editor fields, entry conflicts, financial year questions. */
const { openApp } = moduleCompany('rules');

test.describe('chart editor (01a 4.1, 07 3.5)', () => {
  test('conclude account is disabled for active-passive accounts; the bank-statement flag is saved', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+h');
    const tab = activeTab(page);
    await tab.getByPlaceholder('Търсене по номер или име').fill('602');
    await tab.getByRole('cell', { name: '602', exact: true }).click();
    const nature = tab.getByLabel('Характер на сметка');
    const conclude = tab.getByLabel('Сметка за приключване');
    await nature.selectOption({ label: 'Активно-пасивна' });
    await expect(conclude).toBeDisabled();
    await expect(tab.getByText('Не се задава за активно-пасивни сметки.')).toBeVisible();
    await nature.selectOption({ label: 'Активна' });
    await expect(conclude).toBeEnabled();
    await conclude.fill('123');
    await conclude.press('Enter');
    await tab.getByText('Сметката се използва за банкови извлечения').click();
    await tab.getByRole('button', { name: 'Запис' }).click();
    const id = await accountId(page, '602');
    await expect.poll(async () => (await api<{ id: number; concludeAccountId: number | null; isForBanks: boolean }[]>(page, 'GET', '/accounts')).find((a) => a.id === id))
      .toMatchObject({ concludeAccountId: await accountId(page, '123'), isForBanks: true });
  });
});

test.describe('entry editor (01b 9)', () => {
  test('a save over a change made meanwhile shows the conflict and reloads the entry', async ({ page }) => {
    await openApp(page);
    const { workingDate } = await api<{ workingDate: string }>(page, 'GET', '/session');
    const body = (term: string) => ({
      accountingDate: workingDate, documentTypeId: 1, documentNumber: 'КФ-1', term,
      debits: [{ accountId: 0, amount: '15' }], credits: [{ accountId: 0, amount: '15' }],
    });
    const lines = async (b: ReturnType<typeof body>) => ({
      ...b, debits: [{ ...b.debits[0], accountId: await accountId(page, '501') }], credits: [{ ...b.credits[0], accountId: await accountId(page, '101') }],
    });
    const created = await api<{ id: number }>(page, 'POST', '/entries', await lines(body('Конфликт Е2Е')));
    await page.keyboard.press('Control+F2');
    await activeTab(page).getByRole('row', { name: /Конфликт Е2Е/ }).dblclick();
    const editor = activeTab(page);
    await expect(editor.getByLabel('Основание')).toHaveValue('Конфликт Е2Е');
    // Another user saves the entry while it is open here.
    const loaded = await api<{ version: string }>(page, 'GET', `/entries/${created.id}`);
    await api(page, 'PUT', `/entries/${created.id}`, { ...(await lines(body('Промяна от друг'))), version: loaded.version });
    await editor.getByLabel('Основание').fill('Моята промяна');
    await editor.getByRole('button', { name: 'Запис', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Контирането е променено от друг потребител след зареждането му.');
    await dialog.getByRole('button', { name: 'Да' }).click();
    await expect(editor.getByLabel('Основание')).toHaveValue('Промяна от друг');
    // Saving the reloaded entry works.
    await editor.getByLabel('Основание').fill('След презареждане');
    await editor.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect.poll(async () => (await api<{ term: string }>(page, 'GET', `/entries/${created.id}`)).term).toBe('След презареждане');
  });
});

test.describe('financial years (01b 5, 6.3)', () => {
  test('the next year asks for the conclusion of the previous one first', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+y');
    const tab = activeTab(page);
    await tab.getByRole('cell', { name: '2027 *' }).click();
    await tab.getByRole('button', { name: 'Създаване на 2027 г.' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('За да бъде създадена следващата счетоводна година, годината преди нея трябва да бъде приключена.');
    await dialog.getByRole('button', { name: 'Да' }).click();
    // "Да" leads to the conclusion of 2026; nothing was created.
    await expect(tab.getByRole('button', { name: 'Прехвърляне на салда' })).toBeVisible();
    await expect(tab.getByLabel('Счетоводна година')).toHaveValue(String((await api<{ id: number; year: number }[]>(page, 'GET', '/years')).find((y) => y.year === 2026)!.id));
    expect((await api<unknown[]>(page, 'GET', '/years'))).toHaveLength(1);
  });

  test('choosing a later year asks before moving the working date', async ({ page }) => {
    await api(page, 'POST', '/years', { year: 2027, force: true });
    await openApp(page);
    const { workingDate } = await api<{ workingDate: string }>(page, 'GET', '/session');
    await page.keyboard.press('Control+y');
    const tab = activeTab(page);
    await tab.getByRole('cell', { name: '2027', exact: true }).click();
    const choose = tab.getByRole('button', { name: 'Избор на 2027 г.' });
    const dialog = page.getByRole('dialog');
    const question = 'За текуща година на приложението ще бъде избрана текущата счетоводна година.';
    await choose.click();
    await expect(dialog).toContainText(question);
    await dialog.getByRole('button', { name: 'Не' }).click();
    expect((await api<{ year: { year: number } }>(page, 'GET', '/session')).year.year).toBe(2026);
    await choose.click();
    await expect(dialog).toContainText(question);
    await dialog.getByRole('button', { name: 'Да' }).click();
    await expect(page.locator('footer')).toContainText('2027');
    const s = await api<{ year: { year: number }; workingDate: string }>(page, 'GET', '/session');
    expect([s.year.year, s.workingDate]).toEqual([2027, `2027${workingDate.slice(4)}`]);
    // Back to 2026 for the other tests: the date follows without a question.
    await api(page, 'PUT', '/years/active', { year: 2026 });
  });
});
