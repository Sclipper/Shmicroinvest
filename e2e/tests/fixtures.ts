import { expect, type Page } from '@playwright/test';

export const BASE_URL = `http://localhost:${process.env.E2E_PORT ?? 4310}`;
export const ADMIN = { name: 'Администратор', password: 'e2e-secret' };
export const COMPANY = { name: 'Е2Е Тест ООД', bulstat: '831641791' };

/** Opens the app and waits for the shell. */
export async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.locator('footer')).toContainText(COMPANY.name);
}

/** Clicks through the main menu, e.g. menu(page, 'Редакция', 'Администриране', 'Потребители'). */
export async function menu(page: Page, ...path: string[]) {
  const bar = page.locator('div').filter({ has: page.getByRole('button', { name: 'Файл', exact: true }) }).first();
  await bar.getByRole('button', { name: path[0], exact: true }).dispatchEvent('mousedown');
  for (const [i, label] of path.slice(1).entries()) {
    const item = page.getByRole('button', { name: label, exact: true }).last();
    if (i < path.length - 2) await item.hover();
    else await item.click();
  }
}

/** Active tab content (keep-alive tabs keep inactive ones hidden). */
export function activeTab(page: Page) {
  return page.locator('main > div:not(.hidden)');
}

/** API call with the page's session cookie. */
export async function api<T = any>(page: Page, method: string, url: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api${url}`, { method, data });
  if (!res.ok()) throw new Error(`${method} ${url}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function accountId(page: Page, number: string) {
  const accounts = await api<{ id: number; number: string }[]>(page, 'GET', '/accounts');
  const a = accounts.find((x) => x.number === number);
  if (!a) throw new Error(`No account ${number}`);
  return a.id;
}
