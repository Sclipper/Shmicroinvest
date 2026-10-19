import { expect, test, type Page } from '@playwright/test';
import { accountId, activeTab, api, moduleCompany } from './fixtures.ts';

const { openApp } = moduleCompany('journal');

/**
 * Attachments from the scanner (spec 02a 4.6, strScanDocument): the browser's
 * scanner is the camera. Chrome's fake capture device stands in for it and its
 * permission prompt is accepted automatically; the file-input path (a photo
 * from the device) is covered too.
 */
test.use({
  launchOptions: [async ({ launchOptions }, use) => {
    await use({ ...launchOptions, args: [...(launchOptions.args ?? []), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  }, { scope: 'worker' }],
  permissions: ['camera'],
});

/** A 1x1 PNG (a photo of the document chosen on the device). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

interface Attachment { id: number; fileName: string; mimeType: string; size: number }

async function openEntry(page: Page, doc: string, number: string) {
  await page.keyboard.press('Control+F2');
  const list = activeTab(page);
  await list.getByLabel('№ документ').fill(doc);
  await list.getByRole('button', { name: 'Филтрирай' }).click();
  await list.locator('tbody tr', { has: page.locator(`input[aria-label="Избор ${number}"]`) }).dblclick();
  return activeTab(page).getByTestId('attachments');
}

async function download(page: Page, id: number) {
  const res = await page.request.get(`/api/journal/attachments/${id}/download`);
  expect(res.ok()).toBe(true);
  return { type: res.headers()['content-type'], body: await res.body() };
}

test('Сканиране на документ: camera capture as JPEG, a photo from the device as PNG (02a 4.6)', async ({ page }) => {
  await api(page, 'PUT', '/settings', { IsAllowAccountingAttachments: 'True' });
  try {
    const doc = `SCAN-${Date.now()}`;
    const e = await api<{ id: number; number: string }>(page, 'POST', '/entries', {
      accountingDate: '2026-04-11', documentTypeId: 10, documentNumber: doc, term: 'Сканиране E2E',
      debits: [{ accountId: await accountId(page, '602'), amount: '12' }], credits: [{ accountId: await accountId(page, '503'), amount: '12' }],
    });
    await openApp(page);
    const panel = await openEntry(page, doc, e.number);
    await expect(panel).toContainText('Прикачени файлове (0)');

    // Camera: live preview, capture, store as JPEG (the default format).
    await panel.getByRole('button', { name: 'Сканиране на документ' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Сканиране на документ');
    const video = dlg.getByTestId('scan-video');
    await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    await dlg.getByTestId('scan-capture').click();
    await expect(dlg.getByTestId('scan-preview')).toBeVisible();
    await expect(dlg.getByTestId('scan-size')).toHaveText(/^\d+ x \d+$/);
    await dlg.getByTestId('scan-save').click();
    await expect(dlg).toHaveCount(0);
    await expect(panel).toContainText('Прикачени файлове (1)');
    await expect(panel.getByRole('link', { name: /^Сканиран документ \d{2}\.\d{2}\.\d{4} \d{2}-\d{2}-\d{2}\.jpg$/ })).toBeVisible();
    let rows = (await api<{ rows: Attachment[] }>(page, 'GET', `/journal/entries/${e.id}/attachments`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mimeType).toBe('image/jpeg');
    const jpeg = await download(page, rows[0]!.id);
    expect(jpeg.type).toBe('image/jpeg');
    expect([...jpeg.body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    // A photo from the device (the capture input), stored as PNG.
    await panel.getByRole('button', { name: 'Сканиране на документ' }).click();
    await dlg.getByLabel('Формат').selectOption('png');
    await dlg.getByTestId('scan-file').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
    await expect(dlg.getByTestId('scan-size')).toHaveText('1 x 1');
    await dlg.getByTestId('scan-save').click();
    await expect(dlg).toHaveCount(0);
    await expect(panel).toContainText('Прикачени файлове (2)');
    rows = (await api<{ rows: Attachment[] }>(page, 'GET', `/journal/entries/${e.id}/attachments`)).rows;
    const png = rows.find((r) => r.fileName.endsWith('.png'))!;
    expect(png).toMatchObject({ mimeType: 'image/png', fileName: expect.stringMatching(/^Сканиран документ .+\.png$/) });
    expect((await download(page, png.id)).body.subarray(1, 4).toString('latin1')).toBe('PNG');
  } finally {
    await api(page, 'PUT', '/settings', { IsAllowAccountingAttachments: 'False' });
  }
});
