import { expect, test } from '@playwright/test';
import { activeTab, menu, openApp } from './fixtures.ts';

/** Fixed assets (spec 03b): create an asset in the UI, check its schedule, post the monthly depreciation, open a report. */
test.describe('fixed assets', () => {
  test('creates an asset, shows its schedule, posts the depreciation and reports it', async ({ page }) => {
    await openApp(page);

    // Register (Ctrl+D) -> Нов.
    await page.keyboard.press('Control+d');
    let tab = activeTab(page);
    await expect(tab.getByRole('tree', { name: 'Местоположения' })).toBeVisible();
    await tab.getByRole('button', { name: 'Нов', exact: true }).click();
    tab = activeTab(page);
    await tab.getByLabel('Наименование').fill('Е2Е Струг');
    await tab.getByLabel('Инвентарен номер').fill('E2E-0001');
    await tab.getByLabel('МОЛ', { exact: true }).fill('Иван Петров');
    await tab.getByLabel('Категория по ЗКПО').selectOption({ label: 'II - Машини, оборудване' });
    const accounts = tab.getByPlaceholder('Сметка (F4)');
    for (const [i, n] of [[0, '203'], [1, '241/2'], [2, '603']] as const) {
      await accounts.nth(i).fill(n);
      await accounts.nth(i).press('Enter');
    }
    await tab.getByLabel('Синхронизиране на данъчна и сч. амортизация').check();
    await tab.locator('input[name="sap-amount"]').fill('12000');
    await tab.getByLabel('Дата на придобиване').fill('2026-03-15');
    await tab.getByLabel('Дата на въвеждане в експлоатация').fill('2026-03-15');
    await tab.getByRole('spinbutton', { name: 'Полезен срок (месеци)' }).fill('60');

    // The schedule (acceptance 1, shifted to 2026): first row April = 200.00, 2026 = 1 800.00, last 01.03.2031.
    const schedule = tab.getByRole('table', { name: 'Амортизационен план' });
    await expect(schedule.locator('td[data-month="2026-04-01"] input')).toHaveValue('200,00');
    await expect(schedule.getByRole('row', { name: /^2026/ })).toContainText('1 800,00');
    await expect(schedule.locator('td[data-month="2031-03-01"] input')).toHaveValue('200,00');
    await expect(schedule).toContainText('Общо (60 мес.)');
    await expect(tab.getByRole('table', { name: 'Амортизационни планове' })).toContainText('01.03.2031');

    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByRole('button', { name: 'ДА E2E-0001' })).toBeVisible();

    // Заявки за осчетоводяване (Ctrl+Q): April..October 2026 = 7 months, "Контиране" posts them.
    await page.keyboard.press('Control+q');
    tab = activeTab(page);
    await tab.getByLabel('От дата').fill('2026-01-01');
    await tab.getByLabel('До дата').fill('2026-10-31');
    await tab.getByLabel('Инв. №').fill('E2E-0001');
    const requests = tab.getByRole('table', { name: 'Заявки за осчетоводяване' });
    await expect(requests.locator('tbody tr')).toHaveCount(7);
    await expect(requests.locator('tfoot')).toContainText('1 400,00');
    await tab.getByRole('button', { name: 'Контиране', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Създадени контирания: 7.');
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(tab.getByText('Няма заявки за осчетоводяване за избрания период.')).toBeVisible();

    // The posted months are marked in the asset's schedule.
    await page.getByRole('button', { name: 'ДА E2E-0001' }).click();
    tab = activeTab(page);
    await expect(tab.getByRole('table', { name: 'Амортизационни планове' }).getByRole('row', { name: /Счетоводен/ })).toContainText('1 400,00');
    await expect(tab.locator('td[data-month="2026-04-01"]')).toHaveAttribute('title', /Контиране №/);

    // Report: Справки > Дълготрайни активи > Инвентарна книга (Alt+I).
    await page.keyboard.press('Alt+i');
    tab = activeTab(page);
    await tab.getByLabel('Към дата').fill('2026-12-31');
    await tab.getByRole('button', { name: 'Справка' }).click();
    const row = tab.getByRole('row', { name: /E2E-0001/ });
    await expect(row).toContainText('Е2Е Струг');
    await expect(row).toContainText('12 000,00');
    await expect(row).toContainText('1 400,00');
    await expect(row).toContainText('10 600,00');
  });

  test('refuses an asset with a life under 12 months with the Delta message', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Control+d');
    await activeTab(page).getByRole('button', { name: 'Нов', exact: true }).click();
    const tab = activeTab(page);
    await tab.getByLabel('Наименование').fill('Кратък срок');
    await tab.locator('input[name="sap-amount"]').fill('1000');
    await tab.getByRole('spinbutton', { name: 'Полезен срок (месеци)' }).fill('11');
    await expect(tab.getByRole('list', { name: 'Съобщения' })).toContainText('Счетоводни амортизации: Полезният срок на годност за актива не може да е по-малък от 12 месеца');
    await tab.getByRole('button', { name: 'Запис', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('не може да бъде запазен');
    await page.getByRole('button', { name: 'OK' }).click();
  });

  test('opens the depreciation plan report from the menu', async ({ page }) => {
    await openApp(page);
    await menu(page, 'Справки', 'Дълготрайни активи', 'Амортизационен план');
    const tab = activeTab(page);
    await tab.getByLabel('Към месец').fill('2026-12');
    await tab.getByRole('button', { name: 'Справка' }).click();
    const row = tab.getByRole('row', { name: /E2E-0001/ });
    await expect(row).toContainText('12 000,00');
    await expect(row).toContainText('1 400,00');
    await expect(row).toContainText('20,00');
  });
});
