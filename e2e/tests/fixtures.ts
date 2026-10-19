import { expect, test, type Page } from '@playwright/test';

export const BASE_URL = `http://localhost:${process.env.E2E_PORT ?? 4310}`;
export const ADMIN = { name: 'Администратор', password: 'e2e-secret' };
export const COMPANY = { name: 'Е2Е Тест ООД', bulstat: '831641791' };
/**
 * Companies of the module specs (created by the global setup). Each module works
 * on data no other spec touches: sub-accounts, overdrafts or unclosed results
 * left by one module would break the balances another one checks.
 */
export const MODULE_COMPANIES = {
  statements: 'Отчети Е2Е ООД',
  vat: 'ДДС Е2Е ООД',
  journal: 'Журнал Е2Е ООД',
  payments: 'Разплащания Е2Е ООД',
  assets: 'Активи Е2Е ООД',
  exchange: 'Обмен Е2Е ООД',
  rules: 'Правила Е2Е ООД',
  shell: 'Панели Е2Е ООД',
} as const;
export type ModuleKey = keyof typeof MODULE_COMPANIES;
export const moduleState = (m: ModuleKey) => `.auth/${m}.json`;

/** Runs the spec file in its module company; call once at the top of the file. */
export function moduleCompany(m: ModuleKey) {
  test.use({ storageState: moduleState(m) });
  const name = MODULE_COMPANIES[m];
  return { name, state: moduleState(m), openApp: (page: Page) => openApp(page, name) };
}

/**
 * Specs that post through the entry editor type terms of their own: the
 * add-to-list question of a new term/reference/paragraph (strAdd...Confirmation,
 * 03a 8.1) is answered "Да" in the page as soon as it shows (also while a spec
 * waits on the API, where a Playwright locator handler would not run). A spec
 * that checks the question itself calls keepAddToListPrompt(page) first.
 */
export async function acceptAddToList(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __addToListObserver?: boolean; __keepAddToListPrompt?: boolean };
    if (w.__addToListObserver) return;
    w.__addToListObserver = true;
    const re = /Прибавяне на (основанието|забележката|параграфа) към списъка/;
    new MutationObserver(() => {
      if (w.__keepAddToListPrompt) return;
      for (const d of document.querySelectorAll('[role="dialog"]')) {
        if (!re.test(d.textContent ?? '')) continue;
        [...d.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Да')?.click();
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

/** Turns the automatic "Да" of acceptAddToList off for this page. */
export async function keepAddToListPrompt(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __keepAddToListPrompt?: boolean }).__keepAddToListPrompt = true;
  });
}

/** Opens the app and waits for the shell. */
export async function openApp(page: Page, company: string = COMPANY.name) {
  await acceptAddToList(page);
  await page.goto('/');
  await expect(page.locator('footer')).toContainText(company);
}

/** Picks the shared test company on the login screen (the module companies are listed too). */
export async function chooseCompany(page: Page) {
  await page.getByRole('combobox', { name: /^Фирма/ }).selectOption({ label: COMPANY.name });
}

/** Logs in with a session of its own, for tests that switch user or company (they would end the shared session). */
export async function loginFresh(page: Page) {
  await page.context().clearCookies();
  await acceptAddToList(page);
  await page.goto('/');
  await chooseCompany(page);
  await page.getByLabel('Парола').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Вход' }).click();
  await page.locator('footer').waitFor();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Clicks through the main menu, e.g. menu(page, 'Редакция', 'Администриране', 'Потребители').
 * Items that show a keyboard gesture are found by their label alone
 * (their accessible name is "<label> <gesture>", e.g. "Разплащания F3").
 */
export async function menu(page: Page, ...path: string[]) {
  const name = (label: string) => new RegExp(`^${escapeRe(label)}( [A-Za-z0-9+]+)?$`);
  const bar = page.getByTestId('menu-bar');
  await bar.getByRole('button', { name: path[0], exact: true }).dispatchEvent('mousedown');
  for (const [i, label] of path.slice(1).entries()) {
    // The innermost open list: a submenu is nested inside its parent's list.
    const item = page.getByTestId('menu-list').last().getByRole('button', { name: name(label) }).first();
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
