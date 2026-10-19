import { expect, test } from '@playwright/test';
import { accountId, activeTab, api, menu, moduleCompany } from './fixtures.ts';

const { openApp } = moduleCompany('journal');

/**
 * Report tables with thousands of rows render only the rows in view (the
 * windowed VirtualRows); the totals, scrolling to the last row and the
 * printout (every row) work as with the full table.
 */
test('a long chronological register is windowed on screen and printed in full', async ({ page }) => {
  const N = 400;
  await page.addInitScript(() => {
    window.print = () => {
      (window as unknown as { __printedRows: number }).__printedRows = document.querySelectorAll('.report-print-portal tbody tr').length;
    };
  });
  await openApp(page);
  const doc = `BIG${Date.now()}`.slice(-12);
  const bank = await accountId(page, '503');
  const entry = await api<{ id: number }>(page, 'POST', '/entries', {
    accountingDate: '2026-02-11', documentTypeId: 1, documentNumber: doc, term: 'Е2Е дълга справка',
    debits: Array.from({ length: N }, (_, i) => ({ accountId: bank, amount: String(i + 1) })),
    credits: [{ accountId: await accountId(page, '101'), amount: String((N * (N + 1)) / 2) }],
  });
  try {
    await menu(page, 'Справки', 'Хронологичен регистър');
    const tab = activeTab(page);
    await tab.getByLabel('Документ №', { exact: true }).fill(doc);
    await tab.getByRole('button', { name: 'Справка' }).click();
    await expect(tab.locator('tfoot')).toContainText(`Общо: ${N} записа`);
    await expect(tab.locator('tfoot')).toContainText('80 200,00');

    // Only a window of the 400 rows is in the DOM, between two spacer rows.
    const rows = tab.locator('tbody tr:not([data-virtual-spacer]):not([hidden])');
    await expect(rows.first()).toContainText('1,00');
    expect(await rows.count()).toBeLessThan(N / 2);
    await expect(tab.locator('tbody tr[data-virtual-spacer="bottom"]')).toHaveCount(1);

    // Scrolling to the end brings the last row in; selection by click still works.
    await tab.locator('tbody').evaluate((el) => {
      let p = el.parentElement;
      while (p && getComputedStyle(p).overflowY !== 'auto') p = p.parentElement;
      p!.scrollTop = p!.scrollHeight;
    });
    const last = tab.locator('tbody tr', { hasText: '400,00' });
    await expect(last).toBeVisible();
    await last.click();
    await expect(last).toHaveAttribute('aria-selected', 'true');
    expect(await rows.count()).toBeLessThan(N / 2);

    // The printout has every row.
    await tab.getByRole('button', { name: 'Печат' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printedRows?: number }).__printedRows ?? 0)).toBe(N);
  } finally {
    await api(page, 'DELETE', `/entries/${entry.id}`);
  }
});
