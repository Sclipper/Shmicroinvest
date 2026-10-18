import type { Page } from '@playwright/test';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Like fixtures.menu(), but also finds items that show a keyboard gesture
 * (their accessible name is "<label> <gesture>", e.g. "Разплащания F3").
 */
export async function menuPath(page: Page, ...path: string[]) {
  const name = (label: string) => new RegExp(`^${escape(label)}( [A-Za-z0-9+]+)?$`);
  const bar = page.locator('div').filter({ has: page.getByRole('button', { name: 'Файл', exact: true }) }).first();
  await bar.getByRole('button', { name: path[0], exact: true }).dispatchEvent('mousedown');
  for (const [i, label] of path.slice(1).entries()) {
    const item = page.getByRole('button', { name: name(label) }).last();
    if (i < path.length - 2) await item.hover();
    else await item.click();
  }
}
