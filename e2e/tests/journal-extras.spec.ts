import { expect, test, type Page } from '@playwright/test';
import { accountId, activeTab, api, keepAddToListPrompt, menu, moduleCompany } from './fixtures.ts';

const { openApp } = moduleCompany('journal');

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

  test('a new term asks strAddTermConfirmation; Не and then Да saves it hidden from the list (03a 8.1)', async ({ page }) => {
    await openApp(page);
    await keepAddToListPrompt(page);
    await page.keyboard.press('F2');
    const tab = activeTab(page);
    const stamp = Date.now();
    const term = `Ново основание E2E ${stamp}`;
    await tab.getByLabel('Документ №').fill(`E2E-AT-${stamp}`);
    await tab.getByLabel('Основание').fill(term);
    await pickAccount(page, 0, '602');
    await pickAccount(page, 1, '503');
    await tab.locator('td input.num').nth(0).fill('20');
    await tab.getByRole('button', { name: 'Изравняване' }).click();
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    const ask = page.getByRole('dialog');
    await expect(ask).toContainText('Прибавяне на основанието към списъка с основания към контирания?');
    await ask.getByRole('button', { name: 'Не', exact: true }).click();
    const cancel = page.getByRole('dialog');
    await expect(cancel).toContainText('Основанието няма да бъде прибавено към списъка с основания. Желаете ли да продължите?');
    await cancel.getByRole('button', { name: 'Да', exact: true }).click();
    await expect.poll(async () => (await entries(page, { documentNumber: `E2E-AT-${stamp}` })).map((e) => e.term)).toEqual([term]);
    // Used by the entry, not offered in the list.
    expect(await api<unknown[]>(page, 'GET', `/dictionary/terms?q=${encodeURIComponent(term)}`)).toHaveLength(0);
    const all = await api<{ description: string; isHidden: boolean }[]>(page, 'GET', `/dictionary/terms?all=1&q=${encodeURIComponent(term)}`);
    expect(all.map((x) => [x.description, x.isHidden])).toEqual([[term, true]]);
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

/** Entry editor follow-ups: fixing, Ctrl+F10, after-save questions, asset-linked postings, printouts, fast-entry binding. */
test.describe('entry editor follow-ups', () => {
  const uid = () => Math.random().toString(36).slice(2, 7);
  const partner = async (page: Page, name: string, accounts: string[]) =>
    (await api<{ id: number }>(page, 'POST', '/partners', { name, accountIds: await Promise.all(accounts.map((a) => accountId(page, a))) })).id;
  const yes = async (page: Page, text: string) => {
    const dlg = page.getByRole('dialog').filter({ hasText: text });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Да' }).click();
    await expect(dlg).toHaveCount(0);
  };
  /** Body of the last printout (the hidden print frame). */
  const printed = (page: Page) => page.frameLocator('iframe[data-testid="print-frame"]').locator('body');

  test('fixing of the accounting date fills Фиксинг and Курс; Ctrl+F12 recalculates; a holiday is reported (02a 2)', async ({ page }) => {
    await openApp(page);
    const id = uid();
    const acc = await api<{ id: number; number: string }>(page, 'POST', '/accounts', { parentId: await accountId(page, '504'), description: `Банка USD ${id}`, accountCategoryId: 27, currencyId: 3 });
    await api(page, 'PUT', '/revaluation/rates', { date: '2026-03-10', rates: [{ currencyId: 3, rate: '0.92' }] });
    await api(page, 'PUT', '/settings', { AutomaticFillExchangeRate: 'True' });
    try {
      await openApp(page);
      await page.keyboard.press('F2');
      const tab = activeTab(page);
      await tab.getByLabel('Дата на контиране').fill('2026-03-10');
      await tab.getByLabel('Документ №').fill(`FX-${id}`);
      await tab.getByLabel('Основание').fill('Фиксинг E2E');
      await pickAccount(page, 0, acc.number);
      await expect(tab.getByLabel('Фиксинг Дебит 1')).toHaveValue('0,92');
      const debit = tab.locator('table.grid-table').first();
      await debit.locator('td input.num').nth(1).fill('1000'); // Вал. сума
      await expect(debit.locator('td input.num').nth(0)).toHaveValue('920,00');
      await pickAccount(page, 1, '703');
      await tab.getByRole('button', { name: 'Изравняване' }).click();
      // Ctrl+F12 asks strCalculateFixingExchangeConfirmationPrompt and keeps the rate of the date.
      await tab.getByLabel('Основание').press('Control+F12');
      await yes(page, 'Ще бъде преизчислен фиксингът/валутният курс за всички сметки в операцията.');
      await expect(tab.getByLabel('Фиксинг Дебит 1')).toHaveValue('0,92');
      await tab.getByRole('button', { name: 'Запис', exact: true }).click();
      await expect.poll(async () => (await entries(page, { documentNumber: `FX-${id}` })).length).toBe(1);
      const saved = await api<{ debits: { fixedRate: string; exchangeRate: string; amount: string }[] }>(page, 'GET', `/entries/${(await entries(page, { documentNumber: `FX-${id}` }))[0]!.id}`);
      expect(saved.debits[0]).toMatchObject({ fixedRate: '0.920000', exchangeRate: '0.920000', amount: '920.00' });

      // A Sunday has no fixing (stored or published): the holiday / service message.
      await page.keyboard.press('F2');
      const sunday = activeTab(page);
      await sunday.getByLabel('Дата на контиране').fill('2026-03-15');
      await pickAccount(page, 0, acc.number);
      await expect(page.getByRole('dialog')).toContainText('Избраната дата на осчетоводяване е почивен ден или услугата за валутни справки е временно неактивна.');
      await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
      await expect(sunday.getByLabel('Фиксинг Дебит 1')).toHaveValue('');
    } finally {
      await api(page, 'PUT', '/settings', { AutomaticFillExchangeRate: 'False' });
    }
  });

  test('Ctrl+F10 balances, saves and opens the payments of the partner (02a 4.1)', async ({ page }) => {
    await openApp(page);
    const name = `Е2Е Плащане ${uid()}`;
    await partner(page, name, ['411']);
    await page.keyboard.press('F2');
    const tab = activeTab(page);
    await tab.getByLabel('Документ №').fill(`BP-${uid()}`);
    await tab.getByLabel('Основание').fill('Изравняване, запис и разплащане E2E');
    const picker = tab.getByPlaceholder('Партньор (F4)');
    await picker.fill(name);
    await expect(page.getByText(name).last()).toBeVisible();
    await picker.press('Enter');
    await pickAccount(page, 0, '411');
    await pickAccount(page, 1, '703');
    await tab.locator('td input.num').nth(0).fill('45');
    await tab.getByLabel('Основание').press('Control+F10');
    await expect(page.getByRole('button', { name: 'Разплащания' }).first()).toBeVisible();
    await expect(activeTab(page).locator('tr[aria-selected="true"]', { hasText: name })).toBeVisible();
    expect(await entries(page, { term: 'Изравняване, запис и разплащане E2E' })).toHaveLength(1);
  });

  test('a partner line on an unlinked account asks strAddAccountToCompanyConfirmation and links it (03a 2.9)', async ({ page }) => {
    await openApp(page);
    const name = `Е2Е Без 411 ${uid()}`;
    const id = await partner(page, name, ['401']);
    await page.keyboard.press('F2');
    const tab = activeTab(page);
    await tab.getByLabel('Документ №').fill(`LK-${uid()}`);
    await tab.getByLabel('Основание').fill('Свързване на сметка E2E');
    const picker = tab.getByPlaceholder('Партньор (F4)');
    await picker.fill(name);
    await expect(page.getByText(name).last()).toBeVisible();
    await picker.press('Enter');
    await pickAccount(page, 0, '411');
    await pickAccount(page, 1, '703');
    await tab.locator('td input.num').nth(0).fill('12');
    await tab.getByRole('button', { name: 'Изравняване' }).click();
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await yes(page, 'Избраният партньор не съдържа сметка 411! Сметката ще бъде добавена към партньора!');
    await expect.poll(async () => (await entries(page, { term: 'Свързване на сметка E2E' })).length).toBe(1);
    const p = await api<{ accountIds: number[] }>(page, 'GET', `/partners/${id}`);
    expect(p.accountIds).toContain(await accountId(page, '411'));
  });

  test('a 2xx debit offers a new asset prefilled from the posting (strAddFixedAssetData, 03b 14.1)', async ({ page }) => {
    await openApp(page);
    const term = `Лаптоп E2E ${uid()}`;
    await page.keyboard.press('F2');
    const tab = activeTab(page);
    await tab.getByLabel('Документ №').fill(`FA-${uid()}`);
    await tab.getByLabel('Основание').fill(term);
    await pickAccount(page, 0, '207');
    await pickAccount(page, 1, '503');
    await tab.locator('td input.num').nth(0).fill('1500');
    await tab.getByRole('button', { name: 'Изравняване' }).click();
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await yes(page, 'Желаете ли да въведете допълнителни данни за амортизационния план на актива?');
    const asset = activeTab(page);
    await expect(asset.getByLabel('Наименование')).toHaveValue(term);
    await expect(asset.locator('input[name="sap-amount"]')).toHaveValue('1500,00');
  });

  test('a depreciation posting warns when opened and when voided (03b 12.3)', async ({ page }) => {
    await openApp(page);
    const plan = { depreciationAmount: '1200', nonDepreciableAmount: '0', acquisitionDate: '2026-01-15', startDate: '2026-01-15', calcType: 'period', activePeriodLength: 12, annualRate: null, conservation: null, note: '', serialNumber: '' };
    const asset = await api<{ id: number }>(page, 'POST', '/assets', {
      inventoryNumber: `J${uid()}`, name: 'Е2Е амортизация', personInCharge: null, categoryId: 2, inventoryAccountId: await accountId(page, '206'),
      debitAccountId: await accountId(page, '241/6'), creditAccountId: await accountId(page, '603'), locationId: null, synchronized: false,
      accounting: plan, tax: { ...plan, calcType: 'rate', annualRate: '30', activePeriodLength: null },
    });
    const pending = await api<{ rows: { id: number; assetId: number }[] }>(page, 'GET', '/accounting-requests?from=2026-02-01&to=2026-02-28');
    const posted = await api<{ posted: { accountingId: number; number: string }[] }>(page, 'POST', '/accounting-requests/post', { ids: pending.rows.filter((r) => r.assetId === asset.id).map((r) => r.id) });
    const dep = posted.posted[0]!;
    await page.keyboard.press('Control+F2');
    const list = activeTab(page);
    await list.getByLabel('От номер').fill(dep.number);
    await list.getByLabel('До номер').fill(dep.number);
    await list.getByRole('button', { name: 'Филтрирай' }).click();
    await list.locator('tbody tr', { has: page.locator(`input[aria-label="Избор ${dep.number}"]`) }).dblclick();
    const warning = 'Избраният документ е генериран от амортизационен план. Моля, коригирайте амортизационния план. Желаете ли продължение?';
    await expect(page.getByRole('dialog')).toContainText(warning);
    await page.getByRole('dialog').getByRole('button', { name: 'Не' }).click();
    await expect(page.getByRole('button', { name: new RegExp(`^Контиране ${dep.number}`) })).toHaveCount(0);
    // Void from the list: confirm, then the depreciation-plan warning.
    await list.getByLabel(`Избор ${dep.number}`, { exact: true }).check();
    await list.getByRole('button', { name: 'Изтриване' }).click();
    await yes(page, 'Желаете ли да изтриете избрания документ?');
    await expect(page.getByRole('dialog')).toContainText(warning);
    await page.getByRole('dialog').getByRole('button', { name: 'Не' }).click();
    expect((await api<unknown>(page, 'GET', `/entries/${dep.accountingId}`))).toBeTruthy();
  });

  test('Печат prints the entry card from the editor and the selected entries from the list (05 7.11)', async ({ page }) => {
    await openApp(page);
    const doc = `PRN-${uid()}`;
    const e = await postEntry(page, doc, 'Печат E2E', '602', '503', '77.50');
    await page.keyboard.press('Control+F2');
    const list = activeTab(page);
    await list.getByLabel('№ документ').fill(doc);
    await list.getByRole('button', { name: 'Филтрирай' }).click();
    await list.getByLabel(`Избор ${e.number}`, { exact: true }).check();
    await list.getByRole('button', { name: 'Печат', exact: true }).click();
    await expect(printed(page)).toContainText(`Мемориален ордер № ${e.number} от 10.04.2026`);
    await expect(printed(page)).toContainText('Общо дебит');
    await expect(printed(page).locator('tr.t').first()).toContainText('77,50');
    // The VAT protocol commands answer for an entry without a protocol.
    await list.getByRole('button', { name: 'Печат на протокол по ЗДДС' }).click();
    await expect(page.getByRole('dialog')).toContainText('Към избраното контиране няма протокол по ЗДДС.');
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    // From the editor.
    await list.locator('tbody tr', { has: page.locator(`input[aria-label="Избор ${e.number}"]`) }).dblclick();
    const editor = activeTab(page);
    await editor.getByRole('button', { name: 'Печат', exact: true }).click();
    await expect(printed(page)).toContainText('Печат E2E');
    await expect(printed(page)).toContainText('Кредит');
  });

  test('Обновяване на фиксингите от БНБ answers with the result or the service message (03a 5.4)', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Редакция', 'Валути');
    await activeTab(page).getByRole('button', { name: 'Обновяване на фиксингите от БНБ' }).click();
    // Offline (or on a holiday) the service message, online the update count.
    await expect(page.getByRole('dialog')).toContainText(/Фиксингите са обновени|почивен ден или услугата за валутни справки е временно неактивна/);
  });

  test('fast entry binds a row with an open document in the same save (В-ка, 02a 8.1)', async ({ page }) => {
    await openApp(page);
    const name = `Е2Е Бързо обвързване ${uid()}`;
    const sup = await partner(page, name, ['401']);
    const inv = await api<{ id: number }>(page, 'POST', '/entries', {
      accountingDate: '2026-04-02', documentTypeId: 1, documentNumber: `FBI-${uid()}`, term: 'Фактура за обвързване', companyId: sup,
      debits: [{ accountId: await accountId(page, '602'), amount: '33' }], credits: [{ accountId: await accountId(page, '401'), amount: '33', companyId: sup }],
    });
    await page.keyboard.press('F12');
    const tab = activeTab(page);
    await tab.getByLabel('Тип док. 1').selectOption({ label: 'РКО' });
    await tab.getByLabel('Документ № 1').fill(`FB-${uid()}`);
    await tab.getByLabel('Дата 1').fill('2026-04-05');
    await pickAccount(page, 0, '401');
    await pickAccount(page, 1, '501');
    await tab.getByLabel('Ст-ст 1').fill('33');
    const picker = tab.getByPlaceholder('Партньор (F4)');
    await picker.fill(name);
    await expect(page.getByText(name).last()).toBeVisible();
    await picker.press('Enter');
    await tab.getByPlaceholder('Основание').first().fill('Бързо обвързване E2E');
    await tab.getByLabel('Обвързване 1').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('binding-grid').locator('input[type="checkbox"]').first().check();
    await dlg.getByRole('button', { name: 'ОК' }).click();
    await expect(tab.getByLabel('Обвързване 1')).toHaveText('(1)');
    await tab.getByRole('button', { name: 'Контиране' }).click();
    await expect(page.getByRole('dialog')).toContainText('Записани са 1 контировки');
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    const open = await api<{ liabilities: { accountingId: number }[]; payments: unknown[] }>(page, 'GET', `/payments/open-items?companyId=${sup}`);
    expect(open.liabilities.map((l) => l.accountingId)).not.toContain(inv.id);
    expect(open.payments).toHaveLength(0);
  });
});
