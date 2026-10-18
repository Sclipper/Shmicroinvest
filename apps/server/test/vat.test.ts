import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCompany, type EntrySpec, type TestCompany } from './helpers.ts';

/**
 * VAT module API tests (spec 02b, 04a 1-2, 05 7). One VAT-registered company
 * in 2026; every feature uses its own months so the scenarios stay apart:
 * Mar/Apr save checks, Jun diaries/files/VIES, Jul-Aug protocols, Sep-Oct art. 73,
 * Nov-Dec VAT closing. A second company covers the diary import, a third the
 * euro changeover (2025 -> 2026).
 */

let t: TestCompany;
let call: TestCompany['call'];
let acc: TestCompany['acc'];
let client: number;
let supplier: number;
let euClient: number;
let euSupplier: number;

const VAT_ID = 'BG831641791';
const EGN = '7501010010';
const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);
const dec2 = (v: string | number) => Number(v).toFixed(2);
const pr = (v: string, n: number) => v.padEnd(n, ' ').slice(0, n);
const pl = (v: string, n: number) => v.padStart(n, ' ').slice(-n);
const cp1251 = (bytes: Uint8Array | ArrayBuffer) => new TextDecoder('windows-1251').decode(bytes);
const b64 = (s: string | Uint8Array) => Buffer.from(typeof s === 'string' ? Buffer.from(s, 'base64') : s).toString('base64');

/** Sale: Dt 411 (total) / Kt 702 base + Kt 453/2 VAT, all with one VAT term. */
function sale(date: string, base: number, vat: number, term: number, extra: Partial<EntrySpec> = {}): EntrySpec {
  const total = Math.round((base + vat) * 100) / 100;
  return {
    date, docType: 1, term: 'Продажба', partner: client, transactionTypeId: 3,
    dr: [['411', total, { vatTermId: term, companyId: extra.partner ?? client }]],
    cr: [['702', base, { vatTermId: term }], ...(vat ? [['453/2', vat, { vatTermId: term }] as [string, number, Record<string, unknown>]] : [])],
    ...extra,
  };
}
/** Purchase: Dt 602 base + Dt 453/1 VAT / Kt 401 total. */
function purchase(date: string, base: number, vat: number, term: number, extra: Partial<EntrySpec> = {}): EntrySpec {
  const total = Math.round((base + vat) * 100) / 100;
  return {
    date, docType: 1, term: 'Доставка', partner: supplier, transactionTypeId: 2,
    dr: [['602', base, { vatTermId: term }], ...(vat ? [['453/1', vat, { vatTermId: term }] as [string, number, Record<string, unknown>]] : [])],
    cr: [['401', total, { vatTermId: term, companyId: extra.partner ?? supplier }]],
    ...extra,
  };
}

const report = (from: string, to: string, extra: Record<string, unknown> = {}) => ({ from, to, kl33: '0', ...extra });
const query = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

async function download(url: string) {
  const res = await t.app.request(`/api${url}`, { headers: { cookie: t.session.get() } });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function setMyCompany(c: TestCompany, extra: Record<string, unknown> = {}) {
  const cur = (await c.call('GET', '/my-company')).body;
  const r = await c.call('PUT', '/my-company', {
    name: 'ДДС Тест ООД', bulstat: '831641791', vatId: VAT_ID, isVat: true, accountant: '',
    vatDeclarationSubscriberName: 'Иван Петров', vatDeclarationSubscriberEgn: EGN, vatDeclarationSubscriberRole: 1,
    addresses: [{ city: 'София', address: 'ул. Тестова 1', postalCode: '1000' }], bankAccounts: [], ...extra,
  });
  expect(r.status, r.text).toBe(200);
  return cur;
}

beforeAll(async () => {
  t = await createTestCompany({ companyName: 'ДДС Тест ООД' });
  call = t.call;
  acc = t.acc;
  await setMyCompany(t);
  client = await t.partner('Клиент ЕООД', ['411'], { isVat: true, vatNumber: 'BG111111110' });
  supplier = await t.partner('Доставчик АД', ['401'], { isVat: true, vatNumber: 'BG222222220' });
  euClient = await t.partner('Partner A GmbH', ['411'], { isVat: true, vatNumber: 'DE123456789' });
  euSupplier = await t.partner('EU Supplier GmbH', ['401'], { isVat: true, vatNumber: 'DE999999999' });
}, 60_000);
afterAll(() => t.close());

// ---------------------------------------------------------------------------

describe('VAT checks of the save pipeline (02b 12, 22)', () => {
  it('blocks РСПЕС with a sale and РСИЕС with a purchase (Critical)', async () => {
    const r = await t.tryPost(sale('2026-03-05', 100, 20, 7, { docType: 37, docNumber: 'R1' }));
    expect(r.status).toBe(422);
    expect(keys(r)).toContain('strDocumentWithPurchaseAttention');
    const r2 = await t.tryPost(purchase('2026-03-05', 100, 20, 2, { docType: 36, docNumber: 'R2' }));
    expect(r2.status).toBe(422);
    expect(keys(r2)).toContain('strDocumentWithSaleAttention');
  });

  it('asks when ViesMonth is before the document month; force saves', async () => {
    const e = purchase('2026-04-10', 100, 20, 2, { docNumber: 'C-1', viesMonth: '2026-03-01' });
    const r = await t.tryPost(e);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('confirm');
    expect(keys(r)).toEqual(['strAskIfViesMonthIsBeforeDocumentDate']);
    expect(r.body.messages[0].text).toBe('Месец за експорт е в период преди дата на документа! Желаете ли да продължите?');
    expect((await t.tryPost({ ...e, force: true })).status).toBe(201);
  });

  it('asks about the tax-credit deadline (> 13 months) unless term 3', async () => {
    const e = purchase('2026-04-15', 100, 20, 2, { docNumber: 'C-2', docDate: '2025-01-10', viesMonth: '2026-04-01' });
    const r = await t.tryPost(e);
    expect(r.status).toBe(409);
    expect(keys(r)).toEqual(['strViesMonthAfterTaxCredit']);
    expect((await t.tryPost(purchase('2026-04-15', 120, 0, 3, { docNumber: 'C-3', docDate: '2025-01-10', viesMonth: '2026-04-01' }))).status).toBe(201);
  });

  it('asks to confirm a credit note with a non-negative amount and warns after saving', async () => {
    const e = purchase('2026-04-16', 100, 20, 2, { docType: 3, docNumber: 'C-4' });
    const r = await t.tryPost(e);
    expect(r.status).toBe(409);
    expect(keys(r)).toEqual(['strCreditNoteAmountConfirmation']);
    const ok = await t.tryPost({ ...e, force: true });
    expect(ok.status).toBe(201);
    expect(ok.body.warnings.map((w: { key: string }) => w.key)).toContain('strCreditNoteAmountWarning');
  });

  it('asks about duplicated documents: purchases by number and partner, sales by number', async () => {
    expect((await t.tryPost(purchase('2026-04-20', 10, 2, 2, { docNumber: 'D-1' }))).status).toBe(201);
    const dup = await t.tryPost(purchase('2026-04-21', 10, 2, 2, { docNumber: 'D-1' }));
    expect(dup.status).toBe(409);
    expect(keys(dup)).toEqual(['strDuplicatedDocumentWarning']);
    expect((await t.tryPost(purchase('2026-04-21', 10, 2, 2, { docNumber: 'D-1', force: true }))).status).toBe(201);
    // Another supplier with the same number is not a duplicate.
    expect((await t.tryPost(purchase('2026-04-22', 10, 2, 2, { docNumber: 'D-1', partner: euSupplier }))).status).toBe(201);
    expect((await t.tryPost(sale('2026-04-23', 10, 2, 7, { docNumber: '0000000107' }))).status).toBe(201);
    const sdup = await t.tryPost(sale('2026-04-24', 10, 2, 7, { docNumber: '0000000107', partner: euClient }));
    expect(sdup.status).toBe(409);
    expect((await t.tryPost(sale('2026-04-24', 10, 2, 7, { docNumber: '0000000107', partner: euClient, force: true }))).status).toBe(201);
  });

  it('does not ask anything for non-deal (undefined) entries', async () => {
    const r = await t.tryPost({ date: '2026-04-25', docType: 3, docNumber: 'X1', viesMonth: '2026-01-01', dr: [['501', 5]], cr: [['101', 5]] });
    expect(r.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------

describe('June: diaries, declaration, VIES and NAP files', () => {
  let pokupki: Uint8Array;
  let prodagbi: Uint8Array;

  beforeAll(async () => {
    await t.post(sale('2026-06-05', 100, 20, 7, { docNumber: '0000000101' }));
    await t.post(sale('2026-06-12', 50, 10, 7, { docType: 25, docNumber: '0000000103' }));
    await t.post(sale('2026-06-20', -10, -2, 7, { docType: 3, docNumber: '0000000104' }));
    await t.post(sale('2026-06-25', 1000, 0, 13, { docNumber: '0000000105', partner: euClient, viesId: 2 }));
    await t.post(sale('2026-06-28', 30, 6, 7, { docNumber: '0000000106', viesMonth: '2026-07-01' }));
    await t.post(purchase('2026-06-08', 500, 100, 2, { docNumber: 'P-1' }));
  });

  it('reports the company checks and the VIES hint with the full run', async () => {
    const r = await call('POST', '/vat/report', report('2026-06-01', '2026-06-30'));
    expect(r.status, r.text).toBe(200);
    expect(keys(r)).toEqual(['strMyCompanyVATSubscriberPositionIsEmpty']);
    expect(r.body.info).toBe('Има налични данни за VIES декларация за избрания период. Ако желаете попълване на декларацията, моля изпълнете справката отново с включен избор "Създаване на VIES Декларация".');
    expect(r.body.hasViesData).toBe(true);
    await setMyCompany(t, { vatDeclarationSubscriberPosition: 'Управител' });
    expect(keys(await call('POST', '/vat/report', report('2026-06-01', '2026-06-30', { createVies: true })))).toEqual([]);
  });

  it('sales diary: term 7 sale gives S9=100, S10=20, S11=100, S12=20; КО included; July export month excluded', async () => {
    const r = (await call('POST', '/vat/diaries', report('2026-06-01', '2026-06-30'))).body;
    expect(r.sales.map((x: { documentNumber: string }) => x.documentNumber)).toEqual(['0000000101', '0000000103', '0000000104', '0000000105']);
    const s1 = r.sales[0];
    expect([s1.cols[0], s1.cols[1], s1.cols[2], s1.cols[3]]).toEqual(['100.00', '20.00', '100.00', '20.00']);
    expect(s1).toMatchObject({ documentType: 'Ф-ра', partnerVat: 'BG111111110', partnerName: 'Клиент ЕООД', description: 'Продажба' });
    // Credit note reduces the columns; the totals add up.
    expect(r.sales[2].cols.slice(0, 4)).toEqual(['-10.00', '-2.00', '-10.00', '-2.00']);
    expect(r.salesTotals.slice(0, 4)).toEqual(['1140.00', '28.00', '140.00', '28.00']);
    // Purchase diary: P10=500, P11=100.
    expect(r.purchases).toHaveLength(1);
    expect(r.purchases[0].cols).toEqual(['0.00', '500.00', '100.00', '0.00', '0.00', '0.00', '0.00']);
    const july = (await call('POST', '/vat/diaries', report('2026-07-01', '2026-07-31'))).body;
    expect(july.sales.map((x: { documentNumber: string }) => x.documentNumber)).toEqual(['0000000106']);
  });

  it('declaration: КО excluded; cells 01, 11, 15, 20, 21, 31, 40, 41, 50, 60', async () => {
    const d = (await call('POST', '/vat/declaration', report('2026-06-01', '2026-06-30'))).body;
    const pick = ['01', '11', '15', '20', '21', '31', '40', '41', '50', '60'].map((k) => dec2(d[k]));
    expect(pick).toEqual(['1090.00', '90.00', '1000.00', '18.00', '18.00', '500.00', '100.00', '100.00', '0.00', '82.00']);
  });

  it('declaration with KL33 = 0.80 keeps P13 x KL33 out of a term-2-only period; KL33 is persisted as Coefficient73', async () => {
    await call('POST', '/vat/report', report('2026-06-01', '2026-06-30', { kl33: '0.80' }));
    expect((await call('GET', '/vat/defaults')).body.kl33).toBe('0.80');
    await call('POST', '/vat/report', report('2026-06-01', '2026-06-30'));
    expect((await call('GET', '/vat/defaults')).body.kl33).toBe('0.00');
  });

  it('VIES part 1: K3 per partner, totals [01]=K3+K4+K5, [02]=count', async () => {
    const v = (await call('POST', '/vat/vies', report('2026-06-01', '2026-06-30'))).body;
    expect(v.part1).toHaveLength(1);
    expect(v.part1[0]).toMatchObject({ vatNumber: 'DE123456789', k3: '1000.00', k4: '0.00', k5: '0.00' });
    expect(v.totals).toEqual({ '01': '1000.00', '17': '1000.00', '02': 1 });
    expect(v.part2).toEqual([]);
  });

  it('PRODAGBI.TXT: exact 424-character records in cp1251 with CRLF', async () => {
    const f = await download(`/vat/files/PRODAGBI.TXT?${query(report('2026-06-01', '2026-06-30'))}`);
    expect(f.status).toBe(200);
    expect(f.headers.get('content-type')).toContain('windows-1251');
    expect(f.headers.get('content-disposition')).toBe('attachment; filename="PRODAGBI.TXT"');
    prodagbi = f.bytes;
    const text = cp1251(f.bytes);
    const lines = text.split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.length === 424)).toBe(true);
    const amounts = (v: number[]) => [...v, ...Array(17 - v.length).fill(0)].map((x) => pl(x.toFixed(2), 15)).join('');
    expect(lines[0]).toBe(pr(VAT_ID, 15) + '202606' + pr('0', 4) + pl('1', 15) + '01' + pr('0000000101', 20) + '05/06/2026'
      + pr('BG111111110', 15) + pr('Клиент ЕООД', 50) + pr('Продажба', 30) + amounts([100, 20, 100, 20]) + '  ');
    // Cyrillic is one byte per character in cp1251.
    expect(f.bytes.length).toBe(4 * 426);
    expect(f.bytes[f.bytes.indexOf(0x0d) + 1]).toBe(0x0a);
    expect(lines[1]!.slice(40, 42)).toBe('11');
    expect(lines[3]!.slice(72, 87)).toBe(pr('DE123456789', 15));
  });

  it('POKUPKI.TXT and DEKLAR.TXT: exact records', async () => {
    const r = await call('POST', '/vat/files', report('2026-06-01', '2026-06-30'));
    expect(r.status, r.text).toBe(200);
    expect(r.body.folder).toBe('06.2026');
    expect(r.body.files.map((f: { name: string }) => f.name)).toEqual(['POKUPKI.TXT', 'PRODAGBI.TXT', 'DEKLAR.TXT']);
    const pok = r.body.files[0];
    pokupki = new Uint8Array(Buffer.from(pok.data, 'base64'));
    const amounts = (v: number[]) => v.map((x) => pl(x.toFixed(2), 15)).join('');
    expect(pok.lines).toEqual([pr(VAT_ID, 15) + '202606' + pr('0', 4) + pl('1', 15) + '01' + pr('P-1', 20) + '08/06/2026'
      + pr('BG222222220', 15) + pr('Доставчик АД', 50) + pr('Доставка', 30) + amounts([0, 500, 100, 0, 0, 0, 0]) + '  ']);
    expect(pok.lines[0].length).toBe(274);
    const deklar: string = r.body.files[2].lines[0];
    const n = (v: number) => pl(v.toFixed(2), 15);
    const cells: Record<string, number> = { '01': 1090, '20': 18, '11': 90, '21': 18, '15': 1000, '31': 500, '41': 100, '40': 100, '60': 82 };
    const c = (k: string) => n(cells[k] ?? 0);
    expect(deklar).toBe(pr(VAT_ID, 15) + pr('ДДС Тест ООД', 50) + '202606' + pr(`${EGN}/Иван Петров`, 50) + pl('4', 15) + pl('1', 15)
      + ['01', '20', '11', '21', '12', '22', '23', '13', '24', '14', '15', '16', '17', '18', '19', '30', '31', '41', '32', '42', '43'].map(c).join('')
      + pl('0.00', 4) + ['40', '50', '60', '70', '71', '80', '81', '82'].map(c).join(''));
    expect(deklar.length).toBe(590);
  });

  it('VIES.TXT: VHR, VDR, VTR, TTR, VIR records', async () => {
    const f = await download(`/vat/files/VIES.TXT?${query(report('2026-06-01', '2026-06-30'))}`);
    expect(f.status).toBe(200);
    const lines = cp1251(f.bytes).split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines.map((l) => l.slice(0, 3))).toEqual(['VHR', 'VDR', 'VTR', 'TTR', 'VIR']);
    expect(lines[0]).toBe('VHR06/2026    1');
    expect(lines[1]).toBe('VDR' + pr(EGN, 15) + pr('Иван Петров', 150) + pr('София', 50) + '1000' + pr('ул. Тестова 1', 150) + 'R');
    expect(lines[2]).toBe('VTR' + pr(VAT_ID, 15) + pr('ДДС Тест ООД', 150) + pr('ул. Тестова 1', 200));
    expect(lines[3]).toBe('TTR' + pl('1000.00', 12) + pl('1000.00', 12));
    expect(lines[4]).toBe('VIR' + pl('1', 5) + pr('DE123456789', 15) + pl('1000.00', 12) + pl('0.00', 12) + pl('0.00', 12) + ' '.repeat(7));
  });

  it('zip of the NAP folder MM.yyyy', async () => {
    const z = await download(`/vat/files.zip?${query(report('2026-06-01', '2026-06-30', { createVies: true }))}`);
    expect(z.status).toBe(200);
    expect([...z.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const names = cp1251(z.bytes);
    for (const n of ['06.2026/POKUPKI.TXT', '06.2026/PRODAGBI.TXT', '06.2026/DEKLAR.TXT', '06.2026/VIES.TXT']) expect(names).toContain(n);
  });

  it('VAT-diary import into a second company reproduces the same diaries (04a 2)', async () => {
    const b = await createTestCompany({ companyName: 'ДДС Тест ООД' });
    try {
      await setMyCompany(b, { vatDeclarationSubscriberPosition: 'Управител' });
      expect((await b.call('POST', '/vat/import', { purchases: { data: b64(pokupki) } })).body.error).toBe('Файлът не е намерен!');
      const bad = await b.call('POST', '/vat/import', { purchases: { data: b64(new TextEncoder().encode('garbage\r\n')) }, sales: { data: b64(prodagbi) } });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toBe('POKUPKI.TXT: Невалиден формат на данните на ред 1 от файла за импорт.');
      const pokLine = cp1251(pokupki).split('\r\n')[0]!;
      const code81 = pokLine.slice(0, 40) + '81' + pokLine.slice(42);
      const bad2 = await b.call('POST', '/vat/import', { purchases: { data: Buffer.from(new Uint8Array([...encode(code81)])).toString('base64') }, sales: { data: b64(prodagbi) } });
      expect(bad2.body.error).toBe('POKUPKI.TXT: Невалиден тип на документ на ред 1 от файла за импорт в поле 4: 81.');
      const r = await b.call('POST', '/vat/import', { purchases: { data: b64(pokupki) }, sales: { data: b64(prodagbi) } });
      expect(r.status, r.text).toBe(201);
      expect(r.body).toMatchObject({ purchases: 1, sales: 4, accountings: 5, partnersCreated: 3 });
      const files = (await b.call('POST', '/vat/files', report('2026-06-01', '2026-06-30'))).body.files;
      expect(files[0].lines).toEqual(cp1251(pokupki).split('\r\n').filter(Boolean));
      expect(files[1].lines).toEqual(cp1251(prodagbi).split('\r\n').filter(Boolean));
    } finally {
      await b.close();
    }
  }, 60_000);

  it('NAP-file check lists missing, absent and different documents and imports the missing ones', async () => {
    const line = cp1251(pokupki).split('\r\n')[0]!;
    const extra = line.slice(0, 42) + pr('P-2', 20) + line.slice(62);
    const changed = line.slice(0, 197) + pl('90.00', 15) + line.slice(212);
    const file = (lines: string[]) => ({ data: Buffer.from(encode(lines.join('\r\n') + '\r\n')).toString('base64') });
    const body = (lines: string[]) => ({ from: '2026-06-01', to: '2026-06-30', kind: 'purchase', file: file(lines) });
    const r1 = (await call('POST', '/vat/nap-check', body([line, extra]))).body;
    expect(r1.missing.map((m: { documentNumber: string }) => m.documentNumber)).toEqual(['P-2']);
    expect([r1.absent.length, r1.different.length]).toEqual([0, 0]);
    const r2 = (await call('POST', '/vat/nap-check', body([extra]))).body;
    expect(r2.absent.map((m: { documentNumber: string; source: string }) => [m.documentNumber, m.source])).toEqual([['P-1', 'Дневник покупки']]);
    const r3 = (await call('POST', '/vat/nap-check', body([changed]))).body;
    expect(r3.different).toHaveLength(1);
    expect([r3.different[0].file.vat, r3.different[0].booked.vat]).toEqual(['90.00', '100.00']);
    const imp = await call('POST', '/vat/nap-check/import', body([line, extra]));
    expect(imp.status, imp.text).toBe(201);
    expect(imp.body.imported).toBe(1);
    expect((await call('POST', '/vat/nap-check', body([line, extra]))).body.missing).toEqual([]);
  });
});

function encode(s: string): Uint8Array {
  // Test-side cp1251 encoder for the Cyrillic range used here.
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x350);
    else out.push(0x3f);
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------

describe('protocols under art. 117 (02b 7, 19)', () => {
  let mainId: number;

  beforeAll(async () => {
    mainId = (await t.post(purchase('2026-08-10', 1000, 0, 1, { docNumber: 'EU-1', partner: euSupplier }))).id;
  });

  it('proposes base, VAT, term and number for a ВОП protocol', async () => {
    const d = (await call('GET', `/vat/protocols/${mainId}/defaults?icaType=1&purchaseTermId=2`)).body;
    expect(d).toMatchObject({ base: '1000.00', vat: '200.00', purchaseTermId: 2, saleTermId: 8, term: 'Самоначисляване на ДДС при ВОП', viesMonth: '2026-08-01', documentDate: '2026-08-10' });
    expect(d.documentNumber).toBe('0000000001');
  });

  it('validates the dialog: missing term, number, expense account (Critical)', async () => {
    const base = { icaType: 1, purchaseTermId: 2, documentNumber: '0000000001', documentDate: '2026-08-10', viesMonth: '2026-08-01', base: '1000', vat: '200' };
    const noTerm = await call('PUT', `/vat/protocols/${mainId}`, { ...base, purchaseTermId: null });
    expect(keys(noTerm)).toContain('strMissingTerm');
    const noNumber = await call('PUT', `/vat/protocols/${mainId}`, { ...base, documentNumber: '' });
    expect(keys(noNumber)).toEqual(['strMissingDocumentNumber']);
    const noExpense = await call('PUT', `/vat/protocols/${mainId}`, { ...base, purchaseTermId: 3 });
    expect(noExpense.status).toBe(422);
    expect(noExpense.body.error).toBe('Не е избрана валидна сметка в поле Сметка за разход!');
    const parent = await call('PUT', `/vat/protocols/${mainId}`, { ...base, purchaseTermId: 3, expenseAccountId: acc('60') });
    expect(keys(parent)).toEqual(['strICACreditAccountHasSubAccounts']);
  });

  it('saves Dt 453/1 200 (term 2) / Kt 453/2 200 (term 8) plus base rows; diaries P10/P11 and S13/S15', async () => {
    const r = await call('PUT', `/vat/protocols/${mainId}`, { icaType: 1, purchaseTermId: 2, documentNumber: '0000000001', documentDate: '2026-08-10', viesMonth: '2026-08-01', base: '1000', vat: '200' });
    expect(r.status, r.text).toBe(200);
    const p = (await call('GET', `/vat/protocols/${mainId}`)).body.protocol;
    expect(p).toMatchObject({ icaType: 1, documentNumber: '0000000001', purchaseTermId: 2, base: '1000.00', vat: '200.00', term: 'Самоначисляване на ДДС при ВОП' });
    const d = (await call('POST', '/vat/diaries', report('2026-08-01', '2026-08-31'))).body;
    const pp = d.purchases.find((x: { documentCode: string }) => x.documentCode === '09');
    expect(pp).toMatchObject({ documentType: 'ПЗДДС', documentNumber: '0000000001', partnerVat: 'DE999999999' });
    expect([pp.cols[1], pp.cols[2]]).toEqual(['1000.00', '200.00']);
    expect(d.sales).toHaveLength(1);
    expect([d.sales[0].cols[4], d.sales[0].cols[6], d.sales[0].cols[0], d.sales[0].cols[1]]).toEqual(['1000.00', '200.00', '1000.00', '200.00']);
    const decl = (await call('POST', '/vat/declaration', report('2026-08-01', '2026-08-31'))).body;
    expect(['12', '22', '31', '41', '50', '60'].map((k) => dec2(decl[k]))).toEqual(['1000.00', '200.00', '1000.00', '200.00', '0.00', '0.00']);
    // The proposed number is reserved: the next proposal moves on.
    expect((await call('GET', `/vat/protocols/${mainId}/defaults?icaType=1&purchaseTermId=2`)).body.documentNumber).toBe('0000000002');
  });

  it('report "Протоколи по чл. 117 от ЗДДС" lists the invoice with its protocol', async () => {
    const r = (await call('GET', '/vat/ica-report?from=2026-08-01&to=2026-08-31')).body.rows;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ documentNumber: 'EU-1', documentType: 'Ф-ра', companyName: 'EU Supplier GmbH', icaNumber: '0000000001', icaDate: '2026-08-10', icaType: 'ВОП', icaTermDesc: 'Самоначисляване на ДДС при ВОП' });
    expect([Number(r[0].amount), Number(r[0].icaAmount)]).toEqual([1000, 200]);
    expect(r[0].purchaseVat).toMatch(/^2-/);
    expect(r[0].saleVat).toMatch(/^8-/);
    expect((await call('GET', '/vat/ica-report?from=2026-08-01&to=2026-08-31&icaType=5')).body.rows).toEqual([]);
    expect((await call('GET', '/vat/ica-report?from=2026-08-01&to=2026-08-31&documentNumber=EU')).body.rows).toHaveLength(1);
    const print = (await call('GET', `/vat/protocols/${mainId}/print`)).body;
    expect(print).toMatchObject({ partner: { name: 'EU Supplier GmbH', vatNumber: 'DE999999999' }, main: { documentNumber: 'EU-1' }, protocol: { total: '1200.00', typeName: 'ВОП' } });
  });

  it('163a: VAT different from 20% warns but saves; code 01 marker only', async () => {
    const id = (await t.post(purchase('2026-07-10', 1000, 190, 2, { docNumber: 'R-163' }))).id;
    const r = await call('PUT', `/vat/protocols/${id}`, { icaType: 4, purchaseTermId: null, documentNumber: '163-1', documentDate: '2026-07-10', viesMonth: '2026-07-01', base: '1000', vat: '190', vatDiaryCode: '01' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.warnings.map((w: { key: string }) => w.key)).toEqual(['strInvalidICAVatAmount']);
    const p = (await call('GET', `/vat/protocols/${id}`)).body.protocol;
    expect(p).toMatchObject({ icaType: 4, vatDiaryCode: '01', vat: '0.00', base: '0.00' });
    const pk = (await call('POST', '/vat/diaries', report('2026-07-01', '2026-07-31'))).body.purchases.find((x: { documentNumber: string }) => x.documentNumber === 'R-163');
    expect(pk.vatDiaryCode).toBe('01');
  });

  it('15a: code 41 with a VIES type other than 5 asks to confirm; force saves', async () => {
    const id = (await t.post(purchase('2026-07-12', 300, 0, 1, { docNumber: 'S-15A' }))).id;
    const body = { icaType: 6, purchaseTermId: null, documentNumber: '15A-1', documentDate: '2026-07-12', viesMonth: '2026-07-01', base: '0', vat: '0', vatDiaryCode: '41' };
    const r = await call('PUT', `/vat/protocols/${id}`, body);
    expect(r.status).toBe(409);
    expect(keys(r)).toEqual(['strIncorrectViesOperation']);
    expect((await call('PUT', `/vat/protocols/${id}`, { ...body, force: true })).status).toBe(200);
    expect((await call('DELETE', `/vat/protocols/${id}`)).status).toBe(200);
    expect((await call('GET', `/vat/protocols/${id}`)).body.protocol).toBeNull();
  });

  it('deleting the main entry removes its protocol', async () => {
    const id = (await t.post(purchase('2026-07-20', 50, 0, 1, { docNumber: 'DEL-1', partner: euSupplier }))).id;
    const r = await call('PUT', `/vat/protocols/${id}`, { icaType: 2, purchaseTermId: 2, documentNumber: 'DEL-P', documentDate: '2026-07-20', viesMonth: '2026-07-01', base: '50', vat: '10' });
    expect(r.status, r.text).toBe(200);
    expect((await call('DELETE', `/entries/${id}`)).status).toBe(200);
    const d = (await call('POST', '/vat/diaries', report('2026-07-01', '2026-07-31'))).body;
    expect(d.purchases.some((x: { documentNumber: string }) => x.documentNumber === 'DEL-P')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('article 73 ratio and annual adjustment (02b 8, 21)', () => {
  beforeAll(async () => {
    await t.post(sale('2026-09-10', 83333, 16666.6, 7, { docNumber: 'A73-S1' }));
    await t.post(sale('2026-09-11', 16667, 0, 13, { docNumber: 'A73-S2', partner: euClient, viesId: 2 }));
    await t.post(purchase('2026-10-05', 50000, 10000, 4, { docNumber: 'A73-P1' }));
  });

  it('N = 83 333, D = 100 000: ratio 0.84 (rounded up), plain 0.83', async () => {
    const r = (await call('POST', '/vat/article73/calculate', { from: '2026-09-01', to: '2026-09-30' })).body;
    expect(r).toMatchObject({ numerator: '83333.00', denominator: '100000.00', ratio: '0.84', plain: '0.83' });
    const dev = (await call('POST', '/vat/article73/calculate', { from: '2026-09-01', to: '2026-09-30', numeratorDeviation: '1667', denominatorDeviation: '0' })).body;
    expect(dev.ratio).toBe('0.85');
  });

  it('warns that the ratio is not updated (NonCritical) and still saves; Coefficient73 is unchanged', async () => {
    const v = (await call('POST', '/vat/article73/validate', { from: '2026-09-01', to: '2026-09-30', ratio: '0.84' })).body.messages;
    expect(v).toEqual([{ key: 'strNotUpdatedArticle73RatioWarning', text: 'Стойността на коефициента не е изчислена спрямо въведените данни. За да получите правилен резултат натиснете "Изчисли".', severity: 'warning' }]);
    expect((await call('POST', '/vat/article73/validate', { from: '2026-09-01', to: '2026-09-30', ratio: '0.83', isNew: true })).body.messages).toEqual([]);
    const before = (await call('GET', '/vat/defaults')).body.kl33;
    const s = await call('PUT', '/vat/article73', { from: '2026-09-01', to: '2026-09-30', ratio: '0.84' });
    expect(s.status, s.text).toBe(200);
    expect(s.body.warnings.map((w: { key: string }) => w.key)).toEqual(['strNotUpdatedArticle73RatioWarning']);
    expect((await call('GET', '/vat/article73')).body).toMatchObject({ ratio: '0.84', from: '2026-09-01', to: '2026-09-30' });
    expect((await call('GET', '/vat/defaults')).body.kl33).toBe(before);
  });

  it('defaults to the previous calendar year', async () => {
    const fresh = await createTestCompany();
    try {
      expect((await fresh.call('GET', '/vat/article73')).body).toMatchObject({ ratio: null, from: '2025-01-01', to: '2025-12-31' });
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it('annual adjustment: base 10 000, old 0.80, new 0.84 -> Dt 453/1 400 / Kt 709 400, term 5', async () => {
    await call('PUT', '/vat/article73', { from: '2025-01-01', to: '2025-12-31', ratio: '0.80' });
    const d = (await call('GET', '/vat/article73/adjustment?newRatio=0.84')).body;
    expect(d).toMatchObject({ from: '2026-01-01', to: '2026-12-31', oldRatio: '0.80', newRatio: '0.84', base: '10000.00', amount: '400.00', term: 'Годишна корекция по чл. 73, ал. 8 от ЗДДС' });
    expect((await call('GET', '/vat/article73/adjustment?newRatio=0.76')).body.amount).toBe('-400.00');
    const body = { amount: '400', accountingDate: '2026-10-31', documentTypeId: 5, documentNumber: 'A73' };
    expect(keys(await call('POST', '/vat/article73/adjustment', { ...body, amount: '0' }))).toEqual(['strSumCannotBeZero']);
    expect(keys(await call('POST', '/vat/article73/adjustment', { ...body, documentTypeId: null, documentNumber: '' }))).toEqual(['strMissingDocumentType', 'strMissingDocumentNumber']);
    const r = await call('POST', '/vat/article73/adjustment', body);
    expect(r.status, r.text).toBe(201);
    const e = (await call('GET', `/entries/${r.body.id}`)).body;
    expect(e.term).toBe('Годишна корекция по чл. 73, ал. 8 от ЗДДС');
    expect(e.transactionTypeId).toBe(2);
    expect(e.debits.map((l: { accountId: number; amount: string; vatTermId: number }) => [l.accountId, l.amount, l.vatTermId])).toEqual([[acc('453/1'), '400.00', 5]]);
    expect(e.credits.map((l: { accountId: number; amount: string }) => [l.accountId, l.amount])).toEqual([[acc('709'), '400.00']]);
    // Term 5 feeds P14 -> cell 43 and is added to the credit in cell 40.
    const decl = (await call('POST', '/vat/declaration', report('2026-10-01', '2026-10-31', { kl33: '0.84' }))).body;
    expect([dec2(decl['42']), dec2(decl['43']), dec2(decl['40'])]).toEqual(['10000.00', '400.00', '8800.00']);
  });
});

// ---------------------------------------------------------------------------

describe('VAT closing (02b 9, 20)', () => {
  let yearId: number;

  beforeAll(async () => {
    yearId = (await call('GET', '/years')).body.find((y: { year: number }) => y.year === 2026).id;
    await t.post(purchase('2026-11-05', 500, 100, 2, { docNumber: 'N-P1' }));
    await t.post(sale('2026-11-06', 1500, 300, 7, { docNumber: 'N-S1' }));
  });

  const nov = { from: '2026-11-01', to: '2026-11-30' };
  const rowsOf = (r: { rows: { credit: { number: string }; debit: { number: string }; amount: string }[] }) => r.rows.map((x) => [x.credit.number, x.debit.number, x.amount]);

  it('P=100, S=300: Kt 453/1 Dt 453/2 100 and Kt 453/9 Dt 453/2 200 (EUR chart accounts)', async () => {
    const r = (await call('POST', '/vat/closing/calculate', nov)).body;
    expect([r.purchases, r.sales]).toEqual(['100.00', '300.00']);
    expect(rowsOf(r)).toEqual([['453/1', '453/2', '100.00'], ['453/9', '453/2', '200.00']]);
    expect(r.rows[0].credit.id).toBe(acc('453/1'));
    expect(r.rows[1].credit.id).toBe(acc('453/9'));
  });

  it('alternative closing (bug-compatible D1): 100, 300, 200', async () => {
    const r = (await call('POST', '/vat/closing/calculate', { ...nov, alternative: true, includeRefund: true })).body;
    expect(rowsOf(r)).toEqual([['453/1', '453/8', '100.00'], ['453/9', '453/2', '300.00'], ['453/8', '453/9', '200.00']]);
  });

  it('blocks a locked month and negative amounts', async () => {
    const rows = [{ creditAccountId: acc('453/1'), debitAccountId: acc('453/2'), amount: '100' }];
    await call('PUT', `/years/${yearId}/locks`, { months: [11] });
    const locked = await call('POST', '/vat/closing', { to: '2026-11-30', rows });
    expect(locked.status).toBe(422);
    expect(keys(locked)).toEqual(['strWrongAccountingMonth']);
    await call('PUT', `/years/${yearId}/locks`, { months: [] });
    const neg = await call('POST', '/vat/closing', { to: '2026-11-30', rows: [{ ...rows[0], amount: '-1' }] });
    expect(keys(neg)).toEqual(['strInvalidNegativeAmount']);
    expect(neg.body.error).toBe('Сумата за контиране не може да бъде отрицателна.');
  });

  it('saves one memorial order per row; the period is then closed', async () => {
    const r = (await call('POST', '/vat/closing/calculate', nov)).body;
    const save = await call('POST', '/vat/closing', { to: '2026-11-30', rows: r.rows.map((x: { credit: { id: number }; debit: { id: number }; amount: string }) => ({ creditAccountId: x.credit.id, debitAccountId: x.debit.id, amount: x.amount })) });
    expect(save.status, save.text).toBe(201);
    expect(save.body.created).toHaveLength(2);
    const e = (await call('GET', `/entries/${save.body.created[1].id}`)).body;
    expect(e).toMatchObject({ accountingDate: '2026-11-30', documentTypeId: 10, term: 'Приключване на ДДС', transactionTypeId: 1 });
    expect(e.credits[0]).toMatchObject({ accountId: acc('453/9'), amount: '200.00', vatTermId: 1 });
    expect(e.debits[0]).toMatchObject({ accountId: acc('453/2'), amount: '200.00' });
    expect((await call('POST', '/vat/closing/calculate', nov)).body.rows).toEqual([]);
  });

  it('carry-forward with refund: P=50, S=400, R=200 -> 50 / 200 / 150; without the tick 50 / 350', async () => {
    await t.post({ date: '2026-11-30', docType: 10, docNumber: '', term: 'Възстановим ДДС', dr: [['453/8', 200]], cr: [['101', 200]] });
    await t.post(purchase('2026-12-03', 250, 50, 2, { docNumber: 'D-P1' }));
    await t.post(sale('2026-12-04', 2000, 400, 7, { docNumber: 'D-S1' }));
    const dec = { from: '2026-12-01', to: '2026-12-31' };
    const r = (await call('POST', '/vat/closing/calculate', { ...dec, includeRefund: true })).body;
    expect(r.refund).toBe('200.00');
    expect(rowsOf(r)).toEqual([['453/1', '453/2', '50.00'], ['453/8', '453/2', '200.00'], ['453/9', '453/2', '150.00']]);
    expect(keys({ body: r })).toContain('strInitialBalanceWarning');
    expect(r.messages[0].text).toMatch(/^Следните сметки имат начални салда: .*453\/8/);
    expect(rowsOf((await call('POST', '/vat/closing/calculate', dec)).body)).toEqual([['453/1', '453/2', '50.00'], ['453/9', '453/2', '350.00']]);
  });
});

// ---------------------------------------------------------------------------

describe('missing and duplicated documents (05 7.7, 04a 1.12)', () => {
  it('lists the gap 0000000102 and the duplicated purchase D-1 and sale 0000000107', async () => {
    const r = await call('POST', '/vat/validation', { from: '2026-01-01', to: '2026-12-31' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.missing).toEqual([{ channel: 'Фактури за продажба', documentNumber: '0000000102' }]);
    const groups = r.body.duplicated.map((g: { channel: string; documentNumber: string; rows: unknown[] }) => [g.channel, g.documentNumber, g.rows.length]);
    expect(groups).toEqual(expect.arrayContaining([['Фактури за покупка', 'D-1', 2], ['Фактури за продажба', '0000000107', 2]]));
    expect(groups).toHaveLength(2);
    const onlyMissing = (await call('POST', '/vat/validation', { from: '2026-01-01', to: '2026-12-31', reportType: 2 })).body;
    expect(onlyMissing.duplicated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('euro changeover (02b 13)', () => {
  it('converts BGN entries of 2025-12 in a period ending 2026-01-31: diaries per detail, VIES file unrounded', async () => {
    const c = await createTestCompany({ year: 2025, companyName: 'ДДС Тест ООД' });
    try {
      await setMyCompany(c, { vatDeclarationSubscriberPosition: 'Управител' });
      const cl = await c.partner('Клиент ЕООД', ['411'], { isVat: true, vatNumber: 'BG111111110' });
      const eu = await c.partner('Partner A GmbH', ['411'], { isVat: true, vatNumber: 'DE123456789' });
      const bgn4531 = c.acc('453/1');
      const post = (e: EntrySpec) => c.post(e);
      await post({ ...sale('2025-12-20', 1955.83, 391.17, 7, { docNumber: '0000000001' }), partner: cl, dr: [['411', 2347, { vatTermId: 7, companyId: cl }]] });
      await post({ ...sale('2025-12-22', 1000, 0, 13, { docNumber: '0000000002', viesId: 2 }), partner: eu, dr: [['411', 1000, { vatTermId: 13, companyId: eu }]] });
      // Same period ending in 2025: leva.
      const bgn = (await c.call('POST', '/vat/diaries', report('2025-12-01', '2025-12-31'))).body;
      expect(bgn.sales[0].cols.slice(0, 4)).toEqual(['1955.83', '391.17', '1955.83', '391.17']);

      expect((await c.call('POST', '/years', { year: 2026 })).status).toBe(201);
      expect((await c.call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
      await c.reloadAccounts();
      const eur = (await c.call('POST', '/vat/diaries', report('2025-12-01', '2026-01-31'))).body;
      expect(eur.sales[0].cols.slice(0, 4)).toEqual(['1000.00', '200.00', '1000.00', '200.00']);
      const v = (await c.call('POST', '/vat/vies', report('2025-12-01', '2026-01-31'))).body;
      expect(v.part1[0].k3).toBe('511.29');
      const files = (await c.call('POST', '/vat/files', report('2025-12-01', '2026-01-31', { createVies: true }))).body.files;
      const prod: string = files.find((f: { name: string }) => f.name === 'PRODAGBI.TXT').lines[0];
      expect(prod.slice(167, 227)).toBe([1000, 200, 1000, 200].map((x) => pl(x.toFixed(2), 15)).join(''));
      const vies: string[] = files.find((f: { name: string }) => f.name === 'VIES.TXT').lines;
      expect(vies.find((l) => l.startsWith('VIR'))).toBe('VIR' + pl('1', 5) + pr('DE123456789', 15) + pl('511.29', 12) + pl('0.00', 12) + pl('0.00', 12) + ' '.repeat(7));
      // Closing in 2026 uses the EUR chart only.
      const close = (await c.call('POST', '/vat/closing/calculate', { from: '2026-01-01', to: '2026-01-31' })).body;
      expect(close.accounts.purchases.id).toBe(c.acc('453/1'));
      expect(close.accounts.purchases.id).not.toBe(bgn4531);
    } finally {
      await c.close();
    }
  }, 60_000);
});
