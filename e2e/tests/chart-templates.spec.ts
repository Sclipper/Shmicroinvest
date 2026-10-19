import { expect, test } from '@playwright/test';
import { ADMIN, activeTab, api, loginFresh, menu } from './fixtures.ts';

/**
 * Chart-of-accounts templates (01a 7, 03a 1.3-1.4): ЮЛНЦ chosen for a new
 * company and on the "Избор на сметкоплан" screen. Each test logs in with a
 * session of its own because creating a company switches the session to it.
 */
const uid = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

type Session = { chartOfAccountsType: string; settings: Record<string, string> };

test('new company with the ЮЛНЦ chart', async ({ page }) => {
  await loginFresh(page);
  const name = `Е2Е Сдружение ${uid()}`;
  await menu(page, 'Файл', 'Нова фирма...');
  const dialog = page.getByRole('dialog').filter({ hasText: 'Име на фирмата' });
  await dialog.getByLabel('Име на фирмата').fill(name);
  await dialog.getByLabel('Парола', { exact: true }).fill(ADMIN.password);
  await dialog.getByLabel('Повтори паролата').fill(ADMIN.password);
  await expect(dialog.getByLabel('Вид сметкоплан')).toHaveValue('commercial');
  await dialog.getByLabel('Вид сметкоплан').selectOption({ label: 'ЮЛНЦ (Организации)' });
  await expect(dialog).toContainText('Фирмата се създава с ЮЛНЦ (Организации) сметкоплан.');
  await dialog.getByRole('button', { name: 'Създай' }).click();
  await expect(page.locator('footer')).toContainText(name);
  const s = await api<Session>(page, 'GET', '/session');
  expect([s.chartOfAccountsType, s.settings.IsParagraphEnabled]).toEqual(['nonProfit', 'False']);
  const accounts = await api<{ number: string; description: string }[]>(page, 'GET', '/accounts');
  expect(accounts.find((a) => a.number === '712')?.description).toBe('Приходи от членски внос');
  expect(accounts.some((a) => a.number === '415')).toBe(false);

  await menu(page, 'Операции', 'Сметкоплан и начални салда', 'Индивидуален сметкоплан');
  await expect(activeTab(page).getByText('Приходи от нестопанска дейност').first()).toBeVisible();
});

test('"Избор на сметкоплан" adds the ЮЛНЦ template to an empty chart', async ({ page }) => {
  await loginFresh(page);
  const name = `Е2Е ЮЛНЦ без сметкоплан ${uid()}`;
  await api(page, 'POST', '/companies', { companyName: name, adminName: ADMIN.name, adminPassword: ADMIN.password, year: 2026, chartTemplate: null });
  await page.goto('/');
  await expect(page.locator('footer')).toContainText(name);
  await menu(page, 'Операции', 'Сметкоплан и начални салда', 'Избор на сметкоплан');
  const tab = activeTab(page);
  const radio = tab.getByRole('radio', { name: 'ЮЛНЦ (Организации)' });
  await expect(radio).toBeEnabled();
  await expect(tab.getByRole('radio', { name: 'Бюджетен' })).toBeEnabled();
  await radio.check();
  await expect(tab).toContainText('Шаблон: 289 сметки');
  await expect(tab.getByRole('cell', { name: 'Сметки за капитал, фондове, резерви и финансови резултати' })).toBeVisible();
  await tab.getByRole('button', { name: 'Добавяне на избраните' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toContainText('Ще бъдат добавени 289 сметки от сметкоплан „ЮЛНЦ (Организации)“');
  await confirm.getByRole('button', { name: 'Да', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Добавени са 289 сметки.');
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click();
  await expect(tab).toContainText('избрани за добавяне: 0');
  const s = await api<Session>(page, 'GET', '/session');
  expect(s.chartOfAccountsType).toBe('nonProfit');
  const accounts = await api<{ number: string }[]>(page, 'GET', '/accounts');
  expect(accounts.filter((a) => a.number !== '0')).toHaveLength(289);
});
