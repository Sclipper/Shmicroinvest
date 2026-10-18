import { expect, test, type Page } from '@playwright/test';
import { MENU, type MenuItem } from '../../apps/web/src/shell/menu.ts';
import { menu, openApp } from './fixtures.ts';

/**
 * Smoke test of the whole UI: every screen of the main menu (06 1.3) opens
 * through the menu without a script error, a server error (5xx) or the
 * generic error message, and report screens also run their report.
 */

/** Commands that end the session or open a modal flow covered by their own specs. */
const SKIP_COMMANDS = new Set(['newCompany', 'logout', 'changeUser', 'closeCurrent', 'closeAllButCurrent', 'closeAll']);

function screenItems() {
  const out: { path: string[]; label: string }[] = [];
  const walk = (items: MenuItem[], path: string[]) => {
    for (const i of items) {
      if ('sep' in i) continue;
      if (i.children) walk(i.children, [...path, i.label]);
      else if (i.screen || (i.command && !SKIP_COMMANDS.has(i.command))) out.push({ path: [...path, i.label], label: i.label });
    }
  };
  for (const m of MENU) walk(m.items, [m.label]);
  return out;
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`script: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  page.on('response', (r) => r.status() >= 500 && errors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
  return errors;
}

test('every menu screen opens without errors', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const errors = watchErrors(page);
  await openApp(page);
  const failures: string[] = [];
  let reports = 0;
  for (const [n, { path }] of screenItems().entries()) {
    // Keep the browser light: close the opened tabs every few screens.
    if (n % 12 === 11) {
      await menu(page, 'Прозорци', 'Затваряне на всички прозорци');
      const yes = page.getByRole('dialog').getByRole('button', { name: 'Да', exact: true });
      if (await yes.count()) await yes.click();
    }
    const before = errors.length;
    const name = path.join(' > ');
    try {
      await menu(page, ...path);
      // Either a tab or a dialog takes over; give queries time to settle.
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('Възникна неочаквана грешка')).toHaveCount(0, { timeout: 1000 });
      await expect(page.locator('footer')).toBeVisible();
      // Report screens: run the report with its default filter too.
      const run = page.locator('main > div:not(.hidden)').getByRole('button', { name: 'Справка', exact: true });
      if (!(await page.getByRole('dialog').count()) && (await run.count()) === 1 && (await run.isEnabled())) {
        await run.click();
        await page.waitForLoadState('networkidle');
        await expect(page.getByText('Възникна неочаквана грешка')).toHaveCount(0, { timeout: 1000 });
        reports++;
      }
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message.split('\n')[0]}`);
    }
    if (errors.length > before) failures.push(`${name}: ${errors.slice(before).join('; ')}`);
    // Dismiss whatever the item opened and start the next one from a clean shell.
    for (let tries = 0; tries < 4 && (await page.getByRole('dialog').count()); tries++) {
      await page.keyboard.press('Escape');
      if (await page.getByRole('dialog').count()) {
        const close = page.getByRole('dialog').last().getByRole('button', { name: /^(OK|Отказ|Затвори|Изход|Не)$/ }).first();
        if (await close.count()) await close.click();
      }
    }
    if (!(await page.locator('footer').isVisible())) await openApp(page);
  }
  expect(failures).toEqual([]);
  expect(reports).toBeGreaterThan(20);
});
