import { expect, test } from '@playwright/test';
import { activeTab, api, openApp } from './fixtures.ts';
import { menuPath } from './payments-fixtures.ts';

test.describe('payment documents (02c 1)', () => {
  test('adds a credit transfer, shows the words and warnings, saves, lists and deletes it', async ({ page }) => {
    await openApp(page);
    await menuPath(page, 'Операции', 'Платежни документи', 'Платежно нареждане за кредитен превод');
    const tab = activeTab(page);
    await tab.getByRole('button', { name: 'Добавяне' }).click();

    const name = `Е2Е Получател ${Date.now() % 100000}`;
    await tab.getByLabel('Платете на (име на получателя)').fill(name);
    await tab.getByLabel('IBAN на получателя').fill('BG80BNBG96611020345678');
    // The bank and BIC are filled from the IBAN.
    await expect(tab.getByLabel('BIC на банката на получателя')).toHaveValue('BNBGBGSF');
    await tab.getByLabel('Сума', { exact: true }).fill('123.45');
    await expect(tab.getByTestId('in-words')).toHaveText('сто двадесет и три евро и 45 цента');

    // NonCritical warnings are listed but do not block saving.
    const warnings = tab.getByRole('list', { name: 'Предупреждения' });
    await expect(warnings).toContainText('Не е въведено основание за паричния превод!');
    await expect(warnings).toContainText('Не е въведено име на наредител!');
    await tab.getByLabel('Основание за превода').fill('Фактура 1001');
    await expect(warnings).not.toContainText('Не е въведено основание за паричния превод!');

    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByText('Данните са записани успешно.')).toBeVisible();
    await page.getByRole('button', { name: 'OK' }).click();

    const row = tab.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText('123,45');
    await expect(row).toContainText('Фактура 1001');

    const saved = await api<{ id: number; personName: string; inWords: string }[]>(page, 'GET', '/payment-documents?type=3');
    expect(saved.find((d) => d.personName === name)?.inWords).toBe('сто двадесет и три евро и 45 цента');

    await row.click();
    await tab.getByRole('button', { name: 'Изтриване' }).click();
    await expect(page.getByText('Желаете ли изтриване на избрания(те) документ(и)?')).toBeVisible();
    await page.getByRole('button', { name: 'Да', exact: true }).click();
    await expect(row).toHaveCount(0);

    await tab.getByText('Покажи всички документи').click();
    await expect(tab.getByRole('row').filter({ hasText: name })).toContainText('Изтрит');
  });
});
