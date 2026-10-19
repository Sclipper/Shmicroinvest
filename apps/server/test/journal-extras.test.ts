import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listToMask, SCHEDULER_MODE } from '@shmi/core';
import { createTestCompany, type EntrySpec, type TestCompany } from './helpers.ts';

/**
 * Journal extras (spec 02a): editor acceptance checks 4.8, numbering 3,
 * void/reversal/copy 5, mass edit 6, list filter 7, fast entry 8.1,
 * group-60 / expenses distribution 4.7, attachments 4.6; 01b 7 initial
 * correspondences; 06 3 settings pages and shortcuts.
 */

let t: TestCompany;
let call: TestCompany['call'];
let acc: TestCompany['acc'];
let yearId: number;
let supplierA: number;
let supplierB: number;
let client: number;

const keys = (body: { messages?: { key: string }[] }) => (body.messages ?? []).map((m) => m.key);
const lock = (months: number[]) => call('PUT', `/years/${yearId}/locks`, { months });

beforeAll(async () => {
  t = await createTestCompany();
  call = t.call;
  acc = t.acc;
  yearId = (await call('GET', '/session')).body.year.id;
  supplierA = await t.partner('Доставчик А ООД', ['401', '403']);
  supplierB = await t.partner('Доставчик Б ООД', ['401', '403']);
  client = await t.partner('Клиент ЕООД', ['411']);
  // The commercial template leaves 304 without a category (01a 6.3): Стоки = 3.
  expect((await call('PUT', `/accounts/${acc('304')}`, { accountCategoryId: 3 })).status).toBe(200);
  for (const name of ['Стока А', 'Стока Б']) {
    const r = await call('POST', '/accounts', { parentId: acc('304'), description: name, accountType: 'material', measure: 'бр.' });
    expect(r.status, r.text).toBe(201);
  }
  await t.reloadAccounts();
}, 60_000);
afterAll(() => t.close());

describe('02a 4.8 acceptance checks', () => {
  it('1. one debit and two credits store two pairs and load back as 1/2 lines', async () => {
    const e = await t.post({ date: '2026-02-10', docType: 10, docNumber: '', dr: [['503', '100.00']], cr: [['501', '60.00'], ['101', '40.00']] });
    const db = await t.driver.company(t.companyDb);
    const rows = (await db.execute(`SELECT sign, amount FROM accounting_details WHERE accounting_id = ${e.id} ORDER BY position`)) as unknown as { rows: unknown[] };
    expect(rows.rows).toHaveLength(4);
    const loaded = (await call('GET', `/entries/${e.id}`)).body;
    expect(loaded.debits).toHaveLength(1);
    expect(loaded.credits.map((l: { amount: string }) => l.amount)).toEqual(['60.00', '40.00']);
  });

  it('2. unequal sides block with strInvalidDebitCreditAmounts and store nothing', async () => {
    const before = (await call('GET', '/entries')).body.total;
    const r = await t.tryPost({ date: '2026-02-10', docType: 10, dr: [['503', '100.00']], cr: [['501', '99.99']] });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('Операцията не може да бъде записана поради следните грешки:');
    expect(keys(r.body)).toContain('strInvalidDebitCreditAmounts');
    expect((await call('GET', '/entries')).body.total).toBe(before);
  });

  it('3. a locked March blocks an entry dated 15 March', async () => {
    await lock([3]);
    const r = await t.tryPost({ date: '2026-03-15', docType: 10, dr: [['503', '1']], cr: [['501', '1']] });
    expect(r.status).toBe(422);
    expect(keys(r.body)).toContain('strWrongAccountingMonth');
    await lock([]);
  });

  it('4. a previous-year date blocks with strWrongAccountingDate', async () => {
    const r = await t.tryPost({ date: '2025-12-31', docType: 10, dr: [['503', '1']], cr: [['501', '1']] });
    expect(keys(r.body)).toContain('strWrongAccountingDate');
  });

  it('5. a partner account without a partner blocks with strMissingCompany', async () => {
    const r = await t.tryPost({ date: '2026-02-11', docType: 10, dr: [['602', '10']], cr: [['401', '10']] });
    expect(keys(r.body)).toContain('strMissingCompany');
  });

  it('6. a credit note with positive amounts warns (strCreditNoteAmountWarning)', async () => {
    const spec: EntrySpec = { date: '2026-02-11', docType: 3, partner: client, transactionTypeId: 3, dr: [['411', '12', { companyId: client }]], cr: [['702', '12']] };
    // At save the user is asked first (strCreditNoteAmountConfirmation); after "Да" the warning stays.
    const asked = await t.tryPost(spec);
    expect([asked.status, keys(asked.body)]).toEqual([409, ['strCreditNoteAmountConfirmation']]);
    const e = await t.post({ ...spec, force: true });
    expect(e.warnings.map((w) => w.key)).toContain('strCreditNoteAmountWarning');
  });

  it('7. attachments of 11 MB or .exe are rejected', async () => {
    await call('PUT', '/settings', { IsAllowAccountingAttachments: 'True' });
    const e = await t.post({ date: '2026-02-12', docType: 10, dr: [['503', '5']], cr: [['501', '5']] });
    const upload = (name: string, size: number) => t.app.request(`/api/journal/entries/${e.id}/attachments?fileName=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { cookie: t.session.get(), 'content-type': 'application/octet-stream' }, body: new Uint8Array(size),
    });
    const big = await upload('scan.pdf', 11 * 1024 * 1024);
    expect(big.status).toBe(422);
    expect(((await big.json()) as { error: string }).error).toBe('Файлът е по-голям от позволената дължина (10 MB).');
    const exe = await upload('setup.EXE', 10);
    expect(((await exe.json()) as { error: string }).error).toBe('Непозволен тип на файл (.exe).');
    const ok = await upload('фактура.pdf', 2048);
    expect(ok.status).toBe(201);
    const list = (await call('GET', `/journal/entries/${e.id}/attachments`)).body.rows;
    expect(list).toEqual([expect.objectContaining({ fileName: 'фактура.pdf', size: 2048 })]);
    const dl = await t.app.request(`/api/journal/attachments/${list[0].id}/download`, { headers: { cookie: t.session.get() } });
    expect(dl.status).toBe(200);
    expect((await dl.arrayBuffer()).byteLength).toBe(2048);
    // The list shows the attachment count; removing it clears the row.
    const row = (await call('GET', '/entries?hasAttachments=1')).body.rows;
    expect(row.map((r: { id: number; attachments: number }) => [r.id, r.attachments])).toEqual([[e.id, 1]]);
    expect((await call('DELETE', `/journal/attachments/${list[0].id}`)).status).toBe(200);
    expect((await call('GET', `/journal/entries/${e.id}/attachments`)).body.rows).toEqual([]);
  });

  it('attachments are refused when the setting is off; turning it off clears the list column option', async () => {
    await call('PUT', '/settings', { IsAllowAccountingAttachments: 'True', IsShowAccountingAttachmentsInList: 'True' });
    await call('PUT', '/settings', { IsAllowAccountingAttachments: 'False' });
    const s = (await call('GET', '/settings')).body as { key: string; value: string }[];
    expect(s.find((x) => x.key === 'IsShowAccountingAttachmentsInList')!.value).toBe('False');
    const e = await t.post({ date: '2026-02-12', docType: 10, dr: [['503', '5']], cr: [['501', '5']] });
    const r = await t.app.request(`/api/journal/entries/${e.id}/attachments?fileName=a.txt`, { method: 'POST', headers: { cookie: t.session.get() }, body: new Uint8Array(3) });
    expect(r.status).toBe(400);
  });
});

describe('02a 4.3/4.4 warnings and duplicate documents', () => {
  it('warns about an invoice number longer than the series length', async () => {
    const e = await t.post({ date: '2026-02-13', docType: 1, docNumber: '12345678901', partner: client, transactionTypeId: 3, dr: [['411', '10', { companyId: client }]], cr: [['702', '10']] });
    expect(e.warnings.map((w) => w.key)).toContain('strInvalidDocNumberLenght');
  });

  it('finds an existing document with the same type, number and partner', async () => {
    const e = await t.post({ date: '2026-02-13', docType: 1, docNumber: '777', partner: client, transactionTypeId: 3, dr: [['411', '10', { companyId: client }]], cr: [['702', '10']] });
    const q = (extra: string) => call('GET', `/journal/duplicate-document?documentTypeId=1&documentNumber=777${extra}`);
    expect((await q('')).body.rows.map((r: { id: number }) => r.id)).toEqual([e.id]);
    expect((await q(`&companyId=${client}`)).body.rows).toHaveLength(1);
    expect((await q(`&companyId=${supplierA}`)).body.rows).toHaveLength(0);
    expect((await q(`&excludeId=${e.id}`)).body.rows).toHaveLength(0);
  });
});

describe('02a 5 void, reversal, copy', () => {
  it('reversal: same accounts, negated amounts, Term "Сторно операция", nets to zero (5.2)', async () => {
    const orig = await t.post({ date: '2026-01-20', docType: 1, docNumber: '55', partner: client, transactionTypeId: 3, dr: [['411', '120.00', { companyId: client }]], cr: [['703', '120.00']] });
    const r = await call('POST', `/journal/entries/${orig.id}/reversal`);
    expect(r.status, r.text).toBe(201);
    const rev = (await call('GET', `/entries/${r.body.id}`)).body;
    expect(rev).toMatchObject({ term: 'Сторно операция', reference: 'Фактура 55', documentNumber: '55', documentDate: '2026-01-20' });
    expect(rev.debits[0]).toMatchObject({ accountId: acc('411'), amount: '-120.00' });
    expect(rev.credits[0]).toMatchObject({ accountId: acc('703'), amount: '-120.00' });
    const tb = (await call('GET', '/journal-lines?account=703')).body;
    const net = (tb.rows ?? tb).filter((l: { accounting_id?: number; accountingId?: number }) => [orig.id, r.body.id].includes(l.accounting_id ?? l.accountingId ?? -1));
    const total = net.reduce((s: number, l: { amount: string }) => s + Number(l.amount), 0);
    expect(total).toBe(0);
  });

  it('copy keeps lines, partner and document fields with an empty number (5.3)', async () => {
    const orig = await t.post({ date: '2026-01-21', docType: 1, docNumber: '56', partner: client, term: 'Продажба', transactionTypeId: 3, dr: [['411', '30', { companyId: client }]], cr: [['702', '30']] });
    const d = (await call('GET', `/journal/entries/${orig.id}/copy`)).body;
    expect(d.id).toBeUndefined();
    expect(d).toMatchObject({ number: '', documentTypeId: 1, documentNumber: '56', term: 'Продажба', companyId: client, transactionTypeId: 3 });
    expect(d.debits[0]).toMatchObject({ accountId: acc('411'), amount: '30.00', companyId: client });
    const saved = await call('POST', '/entries', { ...d, documentNumber: '57', force: true });
    expect(saved.status, saved.text).toBe(201);
    expect(saved.body.number).not.toBe(orig.number);
  });

  it('prev/next navigation follows date, number, id', async () => {
    const a = await t.post({ date: '2026-05-01', docType: 10, dr: [['503', '1']], cr: [['501', '1']] });
    const b = await t.post({ date: '2026-05-02', docType: 10, dr: [['503', '1']], cr: [['501', '1']] });
    const c = await t.post({ date: '2026-05-02', docType: 10, dr: [['503', '1']], cr: [['501', '1']] });
    expect((await call('GET', `/journal/entries/${b.id}/neighbor?dir=next`)).body.entry.id).toBe(c.id);
    expect((await call('GET', `/journal/entries/${b.id}/neighbor?dir=prev`)).body.entry.id).toBe(a.id);
  });

  it('void: locked month is refused; linked payments are reported and their link rows vanish (5.1)', async () => {
    const rows = [{ documentTypeId: 1, documentNumber: 'F-900', date: '2026-04-03', debitAccountId: acc('602'), creditAccountId: acc('401'), amount: '50', companyId: supplierA, term: 'Услуга', paymentAccountId: acc('501'), debitVatTermId: 2 }];
    const fast = await call('POST', '/journal/fast-entry', { rows, force: true });
    expect(fast.status, fast.text).toBe(201);
    const { id, paymentId } = fast.body.saved[0];
    const check = (await call('POST', '/journal/void-check', { ids: [id] })).body.rows[0];
    expect(check.paymentNumbers).toHaveLength(1);
    const checkPay = (await call('POST', '/journal/void-check', { ids: [paymentId] })).body.rows[0];
    expect(checkPay.liabilityNumbers).toHaveLength(1);

    await lock([4]);
    const locked = await call('POST', '/journal/void', { ids: [id] });
    expect(locked.status).toBe(400);
    expect(locked.body.error).toBe('Операцията, която се опитвате да извършите, обхваща заключен месец/период!');
    await lock([]);

    expect((await call('POST', '/journal/void', { ids: [id] })).status).toBe(200);
    expect((await call('GET', `/entries/${id}`)).status).toBe(404);
    expect((await call('GET', `/entries/${paymentId}`)).status).toBe(200);
    expect((await call('POST', '/journal/void-check', { ids: [paymentId] })).body.rows[0].liabilityNumbers).toEqual([]);
  });
});

describe('02a 6 mass edit', () => {
  let ids: number[];
  beforeAll(async () => {
    ids = [];
    for (const p of [supplierA, supplierA, supplierB]) {
      ids.push((await t.post({ date: '2026-06-10', docType: 10, partner: p, term: 'Плащане', dr: [['401', '25', { companyId: p }]], cr: [['503', '25']] })).id);
    }
  });

  it('validates in the documented order', async () => {
    const r = await call('POST', '/journal/mass-edit', { ids: [] });
    expect(keys(r.body)).toEqual(['strInvalidAccountingsNumber']);
    expect(keys((await call('POST', '/journal/mass-edit', { ids })).body)).toEqual(['strInvalidAccountingEditData']);
    expect(keys((await call('POST', '/journal/mass-edit', { ids, newAccountingDate: '2025-06-10' })).body)).toContain('strWrongAccountingDate');
    expect(keys((await call('POST', '/journal/mass-edit', { ids, newAccount: '403' })).body)).toContain('strNoEditAccountingNo');
    expect(keys((await call('POST', '/journal/mass-edit', { ids, fromDebitAccount: '401', newAccount: '503' })).body)).toContain('strInvalidEditCompanyAccount');
    expect(keys((await call('POST', '/journal/mass-edit', { ids, fromDebitAccount: '602', newAccount: '601' })).body)).toContain('strNotValidEditDataAccount');
    await lock([6]);
    expect(keys((await call('POST', '/journal/mass-edit', { ids, newTerm: 'X' })).body)).toContain('strWrongAccountingMonth');
    await lock([]);
  });

  it('worked example 6.4: replace debit 401 with 403 and set a new term; counterpart RefAccount follows (A5)', async () => {
    const r = await call('POST', '/journal/mass-edit', { ids, fromDebitAccount: '401', newAccount: '403', newTerm: 'Корекция' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.updated).toBe(3);
    for (const id of ids) {
      const e = (await call('GET', `/entries/${id}`)).body;
      expect(e.term).toBe('Корекция');
      expect(e.debits[0].accountId).toBe(acc('403'));
      expect(e.credits[0].accountId).toBe(acc('503'));
    }
    const db = await t.driver.company(t.companyDb);
    const rows = ((await db.execute(`SELECT sign, account_id, ref_account_id, company_id FROM accounting_details WHERE accounting_id = ${ids[0]} ORDER BY sign DESC`)) as unknown as { rows: unknown[] }).rows as { sign: number; account_id: number; ref_account_id: number; company_id: number | null }[];
    expect(rows[0]).toMatchObject({ account_id: acc('403'), company_id: supplierA });
    expect(rows[1]).toMatchObject({ account_id: acc('503'), ref_account_id: acc('403') });
  });

  it('sets a new partner, document-free date checks and the search filter', async () => {
    expect(keys((await call('POST', '/journal/mass-edit', { ids, newDocumentDate: '2026-06-11' })).body)).toEqual([]);
    const r = await call('POST', '/journal/mass-edit', { ids, newCompanyId: supplierB, newReference: 'общ' });
    expect(r.status, r.text).toBe(200);
    expect((await call('GET', `/entries/${ids[0]}`)).body.debits[0].companyId).toBe(supplierB);
    const found = (await call('GET', '/journal/mass-edit/search?debit=403&reference=общ')).body.rows.map((x: { id: number }) => x.id);
    expect(found).toEqual(ids);
    expect((await call('GET', '/journal/mass-edit/search?from=2025-01-01')).body.error).toBe('"От дата" е различна от текущата счетоводна година.');
  });
});

describe('02b 12 mass edit VAT questions', () => {
  it('asks before editing an entry with two VAT regimes or a bread/flour protocol; Yes (force) edits', async () => {
    const mixed = await t.post({
      date: '2026-06-12', docType: 1, partner: supplierA, transactionTypeId: 2, term: 'Доставка',
      dr: [['602', '50', { vatTermId: 3 }], ['602', '100', { vatTermId: 2 }], ['453/1', '20', { vatTermId: 2 }]], cr: [['401', '170', { vatTermId: 2, companyId: supplierA }]],
    });
    const plain = await t.post({ date: '2026-06-12', docType: 10, partner: supplierA, term: 'Плащане', dr: [['401', '5', { companyId: supplierA }]], cr: [['503', '5']] });
    expect((await call('POST', '/journal/mass-edit', { ids: [plain.id], newReference: 'без въпрос' })).status).toBe(200);
    const asked = await call('POST', '/journal/mass-edit', { ids: [mixed.id, plain.id], newReference: 'ДДС' });
    expect(asked.status).toBe(409);
    expect(keys(asked.body)).toEqual(['strDifferentVATEditWarning']);
    expect((await call('GET', `/entries/${mixed.id}`)).body.reference).not.toBe('ДДС');
    const db = await t.driver.company(t.companyDb);
    await db.execute(`UPDATE accountings SET ica_type = 8 WHERE id = ${plain.id}`);
    expect(keys((await call('POST', '/journal/mass-edit', { ids: [plain.id], newReference: 'ДДС' })).body)).toEqual(['strICATypeDefaultBreadFlourEditWarning']);
    const yes = await call('POST', '/journal/mass-edit', { ids: [mixed.id, plain.id], newReference: 'ДДС', force: true });
    expect(yes.status, yes.text).toBe(200);
    expect((await call('GET', `/entries/${mixed.id}`)).body.reference).toBe('ДДС');
  });
});

describe('02a 7 list filter', () => {
  it('filters by number range, accounts, amount and document number', async () => {
    const e = await t.post({ date: '2026-07-01', docType: 5, docNumber: 'PR-1', term: 'Филтър', dr: [['602', '123.45']], cr: [['503', '123.45']] });
    const q = async (s: string) => (await call('GET', `/entries?${s}`)).body.rows.map((r: { id: number }) => r.id);
    expect(await q('amount=123.45')).toEqual([e.id]);
    expect(await q('amountFrom=123&amountTo=124&debit=602')).toEqual([e.id]);
    expect(await q('credit=602&amount=123.45')).toEqual([]);
    expect(await q('documentNumber=PR-1')).toEqual([e.id]);
    expect(await q(`numberFrom=${Number(e.number)}&numberTo=${Number(e.number)}`)).toEqual([e.id]);
    expect(await q('term=Филтър')).toEqual([e.id]);
    expect((await call('GET', '/entries?to=2027-01-01')).body.error).toBe('"До дата" е различна от текущата счетоводна година.');
  });
});

describe('02a 8.1 fast entry', () => {
  const row = (n: string, extra: Record<string, unknown> = {}) => ({
    documentTypeId: 1, documentNumber: n, date: '2026-08-05', debitAccountId: acc('602'), creditAccountId: acc('401'), amount: '10',
    companyId: supplierA, term: 'Бързо', debitVatTermId: 2, ...extra,
  });

  it('blocks a duplicated purchase document within the rows', async () => {
    const r = await call('POST', '/journal/fast-entry', { rows: [row('D-1'), row('D-1')] });
    expect(r.status).toBe(422);
    expect(keys(r.body)).toEqual(['strDuplicatedPurchaseDocumentExistInRows']);
    expect(r.body.messages[0].text).toBe('Ред 2: Документ с номер D-1 от тип Фактура е дублиран за един и същ партньор във въведените редове!');
  });

  it('rejects material/foreign accounts and is atomic when one row is invalid (A7)', async () => {
    const bad = await call('POST', '/journal/fast-entry/validate', { rows: [row('M-1', { debitAccountId: acc('304/1') })] });
    expect(keys(bad.body)).toContain('strInappropriateFastAccountingAccountMessage');
    await lock([9]);
    const before = (await call('GET', '/entries')).body.total;
    const rows = [row('A-1'), row('A-2'), row('A-3', { date: '2026-09-01' }), row('A-4'), row('A-5')];
    const r = await call('POST', '/journal/fast-entry', { rows });
    expect(r.status).toBe(422);
    expect(keys(r.body)).toContain('strWrongAccountingMonth');
    expect((await call('GET', '/entries')).body.total).toBe(before);
    await lock([]);
  });

  it('saves all rows; a duplicate against the database needs confirmation', async () => {
    const r = await call('POST', '/journal/fast-entry', { rows: [row('B-1'), row('B-2', { companyId: supplierB })] });
    expect(r.status, r.text).toBe(201);
    expect(r.body.saved).toHaveLength(2);
    const again = await call('POST', '/journal/fast-entry', { rows: [row('B-1')] });
    expect(again.status).toBe(409);
    expect(keys(again.body)).toEqual(['strDuplicatedPurchaseDocumentExistsWithParams']);
    expect(again.body.messages[0].text).toBe('Ред 1: Съществува осчетоводен тип документ Фактура с № B-1, тип сделка Покупка и клиент Доставчик А ООД!');
    expect((await call('POST', '/journal/fast-entry', { rows: [row('B-1')], force: true })).status).toBe(201);
  });
});

describe('02a 3 renumbering', () => {
  // A second company: the renumbering acceptance needs a year with exactly these entries.
  let t2: TestCompany;
  let ids: number[];
  beforeAll(async () => {
    t2 = await createTestCompany();
    ids = [];
    for (const [i, n] of ['0000000001', '0000000002', '0000000002', '0000000005'].entries()) {
      ids.push((await t2.post({ date: `2026-01-0${i + 1}`, docType: 10, number: n, dr: [['503', '1']], cr: [['501', '1']] })).id);
    }
  }, 60_000);
  afterAll(() => t2.close());

  it('1,2,2,5 by number becomes 1,2,2,3 with LastNumber 3; blocked with a locked month', async () => {
    const y2 = (await t2.call('GET', '/session')).body.year.id;
    await t2.call('PUT', `/years/${y2}/locks`, { months: [11] });
    const blocked = await t2.call('POST', '/journal/reorder', { type: 'accounting', by: 'number' });
    expect(blocked.body.error).toBe('Операцията, която се опитвате да извършите, обхваща заключен месец/период!');
    await t2.call('PUT', `/years/${y2}/locks`, { months: [] });
    const r = await t2.call('POST', '/journal/reorder', { type: 'accounting', by: 'number' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ count: 3, message: 'Преподреждането завърши успешно!' });
    const after = await Promise.all(ids.map(async (id) => (await t2.call('GET', `/entries/${id}`)).body.number));
    expect(after).toEqual(['0000000001', '0000000002', '0000000002', '0000000003']);
    expect((await t2.call('GET', '/entries/next-number')).body.number).toBe('0000000004');
  });

  it('renumbers memorial orders by date on channel 6', async () => {
    const a = await t2.post({ date: '2026-03-01', docType: 10, docNumber: '1', dr: [['503', '1']], cr: [['501', '1']] });
    const b = await t2.post({ date: '2026-02-01', docType: 10, docNumber: '2', dr: [['503', '1']], cr: [['501', '1']] });
    const r = await t2.call('POST', '/journal/reorder', { type: 'mo', by: 'date' });
    expect(r.body.count).toBe(6);
    expect((await t2.call('GET', `/entries/${ids[0]}`)).body.documentNumber).toBe('0000000001');
    expect((await t2.call('GET', `/entries/${b.id}`)).body.documentNumber).toBe('0000000005');
    expect((await t2.call('GET', `/entries/${a.id}`)).body.documentNumber).toBe('0000000006');
  });
});

describe('02a 4.7 assisted features', () => {
  it('group 60 closing: one МО with the group-60 debits as credits and an empty debit side', async () => {
    const e = await t.post({ date: '2026-10-05', docType: 10, term: '', dr: [['601', '40'], ['602', '60']], cr: [['503', '100']] }).catch(() => null);
    const saved = e ?? (await t.post({ date: '2026-10-05', docType: 10, term: 'Разходи', dr: [['601', '40'], ['602', '60']], cr: [['503', '100']] }));
    expect((await call('GET', `/journal/entries/${saved.id}/group60-drafts`)).body.drafts).toEqual([]);
    await call('PUT', '/settings', { IsAllowAccountingAutomaticEnd: 'True' });
    const one = (await call('GET', `/journal/entries/${saved.id}/group60-drafts`)).body.drafts;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ documentTypeId: 10, accountingDate: '2026-10-05', term: 'Разходи', transactionTypeId: 1 });
    expect(one[0].debits).toEqual([expect.objectContaining({ accountId: null })]);
    expect(one[0].credits.map((c: { accountId: number; amount: string }) => [c.accountId, c.amount])).toEqual([[acc('601'), '40.00'], [acc('602'), '60.00']]);
    await call('PUT', '/settings', { IsShowSeperateAccountingsForeachAccountGroup60: 'True' });
    expect((await call('GET', `/journal/entries/${saved.id}/group60-drafts`)).body.drafts).toHaveLength(2);
    await call('PUT', '/settings', { IsAllowAccountingAutomaticEnd: 'False' });
    const s = (await call('GET', '/settings')).body as { key: string; value: string }[];
    expect(s.find((x) => x.key === 'IsShowSeperateAccountingsForeachAccountGroup60')!.value).toBe('False');
  });

  it('expenses distribution draft spreads the amount by line amount', async () => {
    const e = await t.post({ date: '2026-10-06', docType: 10, term: 'Покупка', dr: [['601', '300'], ['602', '100']], cr: [['503', '400']] });
    const d = await call('POST', `/journal/entries/${e.id}/expenses-draft`, { amount: '10', side: 'debit', base: 'amount' });
    expect(d.status, d.text).toBe(200);
    expect(d.body.reference).toBe(`Разпределение по контиране ${e.number}`);
    expect(d.body.debits.map((l: { accountId: number; amount: string }) => [l.accountId, l.amount])).toEqual([[acc('601'), '7.50'], [acc('602'), '2.50']]);
    expect(d.body.credits).toEqual([expect.objectContaining({ accountId: null, amount: '10.00' })]);
  });

  it('expenses distribution by quantity uses only the material lines', async () => {
    const e = await t.post({
      date: '2026-10-07', docType: 1, partner: supplierA, transactionTypeId: 2, term: 'Доставка',
      dr: [['304/1', '100', { quantity: '10' }], ['304/2', '100', { quantity: '30' }], ['602', '50']], cr: [['401', '250', { companyId: supplierA }]],
    });
    const d = await call('POST', `/journal/entries/${e.id}/expenses-draft`, { amount: '20', side: 'debit', base: 'quantity' });
    expect(d.status, d.text).toBe(200);
    expect(d.body.debits.map((l: { accountId: number; amount: string }) => [l.accountId, l.amount])).toEqual([[acc('304/1'), '5.00'], [acc('304/2'), '15.00']]);
  });
});

describe('01b 7 initial correspondences', () => {
  it('stores opening pairs with an empty number and partner analytics, editable and deletable', async () => {
    const r = await call('POST', '/initial-correspondences', { debitAccountId: acc('411'), creditAccountId: acc('101'), amount: '1500', debitCompanyId: client, documentTypeId: 1, documentNumber: 'НС-1' });
    expect(r.status, r.text).toBe(201);
    expect(r.body.number).toBe('');
    const list = (await call('GET', '/initial-correspondences')).body;
    expect(list.date).toBe('2026-01-01');
    expect(list.accounts.find((a: { account: string }) => a.account === '411')).toMatchObject({ debit: '1500.00', credit: '0.00', partners: [{ name: 'Клиент ЕООД', debit: '1500.00', credit: '0.00' }] });
    expect(list.accounts.find((a: { account: string }) => a.account === '101')).toMatchObject({ debit: '0.00', credit: '1500.00' });
    const e = (await call('GET', `/initial-correspondences/${r.body.id}`)).body;
    expect(e).toMatchObject({ isInitialBalance: true, isInitialCorrespondence: true, accountingDate: '2026-01-01' });
    // Not month-lock checked (opening balances).
    await lock([1]);
    const put = await call('PUT', `/initial-correspondences/${r.body.id}`, { debitAccountId: acc('411'), creditAccountId: acc('101'), amount: '1600', debitCompanyId: client });
    expect(put.status, put.text).toBe(200);
    await lock([]);
    expect((await call('GET', '/entries')).body.rows.find((x: { id: number }) => x.id === r.body.id)).toBeUndefined();
    expect((await call('DELETE', `/initial-correspondences/${r.body.id}`)).status).toBe(200);
    expect((await call('GET', '/initial-correspondences')).body.rows).toEqual([]);
    const missing = await call('POST', '/initial-correspondences', { debitAccountId: acc('411'), creditAccountId: acc('101'), amount: '5' });
    expect(keys(missing.body)).toContain('strMissingCompany');
  });
});

describe('06 3 settings pages', () => {
  it('sequence worked example: AB / - / length 9 / start 5 (06 3.7)', async () => {
    const p = await call('POST', '/settings/sequences/preview', { prefix: 'AB', separator: '-', selectedNumberLength: 9, startNumber: 5 });
    expect(p.body).toEqual({ preview: 'AB00000005', messages: [] });
    const err = await call('POST', '/settings/sequences/preview', { prefix: 'ABC', separator: '', selectedNumberLength: 2, startNumber: 1 });
    expect(err.body.preview).toBe('Грешка!');
    const created = await call('POST', '/settings/sequences', { channel: 2, prefix: 'AB', separator: '-', selectedNumberLength: 9, startNumber: 5 });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ format: 'AB-', numericLength: 8, lastNumber: 4 });
    const bad = await call('POST', '/settings/sequences', { channel: 2, prefix: 'ABC', separator: '', selectedNumberLength: 2, startNumber: 1 });
    expect(keys(bad.body)).toEqual(['strIncorrectSequenceData']);
  });

  it('activating a series makes it the user series; in-use and channel-1 rules hold', async () => {
    const created = await call('POST', '/settings/sequences', { channel: 1, prefix: 'K', separator: '', selectedNumberLength: 5, startNumber: 1 });
    expect((await call('POST', `/settings/sequences/${created.body.id}/activate`)).status).toBe(200);
    expect((await call('GET', '/entries/next-number')).body.number).toBe('K00001');
    const e = await t.post({ date: '2026-11-02', docType: 10, dr: [['503', '1']], cr: [['501', '1']] });
    expect(e.number).toBe('K00001');
    const list = (await call('GET', '/settings/sequences')).body as { id: number; channel: number; isActive: boolean; users: number }[];
    expect(list.find((x) => x.id === created.body.id)).toMatchObject({ isActive: true, users: 1 });
    expect(keys((await call('DELETE', `/settings/sequences/${created.body.id}`)).body)).toEqual(['strSequenceInUse']);
    expect(keys((await call('POST', `/settings/sequences/${created.body.id}/deactivate`)).body)).toEqual(['strAccountingNumberationCannotBeDeactivated']);
    // Back to the default series for the rest of the file.
    const def = list.find((x) => x.channel === 1 && x.id !== created.body.id)!;
    await call('POST', `/settings/sequences/${def.id}/activate`);
    expect((await call('GET', '/entries/next-number')).body.number).toMatch(/^\d{10}$/);
  });

  it('document types: order/visibility saved, mandatory and used types cannot be removed (06 3.8)', async () => {
    const all = (await call('GET', '/settings/document-types')).body as { id: number; isVisible: boolean; accountings: number }[];
    const visible = all.filter((d) => d.isVisible).map((d) => d.id);
    const noInvoice = await call('PUT', '/settings/document-types', { visible: visible.filter((id) => id !== 1) });
    expect(keys(noInvoice.body)).toEqual(['strErrorCannotDeleteDocumentTypeUsedByProgram']);
    const noCustoms = await call('PUT', '/settings/document-types', { visible: visible.filter((id) => id !== 4) });
    expect(noCustoms.status, noCustoms.text).toBe(200);
    const after = (await call('GET', '/settings/document-types')).body as { id: number; isVisible: boolean }[];
    expect(after.find((d) => d.id === 4)!.isVisible).toBe(false);
    // A used non-mandatory type (Протокол 5 is mandatory; use ПН 12 after posting one).
    await t.post({ date: '2026-11-03', docType: 12, docNumber: 'PN1', dr: [['503', '1']], cr: [['501', '1']] });
    const noPn = await call('PUT', '/settings/document-types', { visible: visible.filter((id) => id !== 4 && id !== 12) });
    expect(keys(noPn.body)).toEqual(['strErrorCannotDeleteDocumentType']);
    // Reordering: put ПКО first.
    expect((await call('PUT', '/settings/document-types', { visible: [8, ...visible.filter((id) => id !== 8 && id !== 4)] })).status).toBe(200);
    expect(((await call('GET', '/settings/document-types')).body as { id: number }[])[0]!.id).toBe(8);
  });

  it('database page shows the active catalog', async () => {
    const r = (await call('GET', '/settings/database')).body;
    expect(r).toMatchObject({ catalog: t.companyDb, companyName: 'Тест ООД', server: 'PGlite (вграден)' });
  });

  it('shortcuts: per-user overrides, duplicate warning, restore defaults (06 2.6)', async () => {
    const d = (await call('GET', '/settings/shortcuts')).body;
    expect(d.rows.find((r: { id: string }) => r.id === 'BalancingAndSave').gesture).toBe('Shift+F9');
    expect(d.warnings).toEqual([]);
    const put = await call('PUT', '/settings/shortcuts', { overrides: { SaveTemplate: 'Ctrl+F9' } });
    expect(put.body.rows.find((r: { id: string }) => r.id === 'SaveTemplate').gesture).toBe('Ctrl+F9');
    expect(put.body.warnings.map((w: { text: string }) => w.text)).toEqual(['Клавишната комбинация Ctrl+F9 вече се използва за „Изравняване“.']);
    expect((await call('PUT', '/settings/shortcuts', { overrides: { SaveTemplate: 'Ctrl+%' } })).status).toBe(400);
    const restored = (await call('DELETE', '/settings/shortcuts')).body;
    expect(restored.rows.find((r: { id: string }) => r.id === 'SaveTemplate').gesture).toBe('F5');
  });

  it('per-user keep-open option', async () => {
    expect((await call('GET', '/settings/user')).body).toEqual({ KeepAccountingOpen: 'False' });
    await call('PUT', '/settings/user', { KeepAccountingOpen: 'True' });
    expect((await call('GET', '/settings/user')).body.KeepAccountingOpen).toBe('True');
  });
});

/** The file's main company, reachable from blocks that shadow `t`. */
const mainCompany = () => t;

/** Templates, template schedules and reschedules (02a 9), on the same company. */
describe('02a 9 templates, schedules, reschedules', () => {
  let t: TestCompany;
  let call: TestCompany['call'];
  let acc: TestCompany['acc'];
  let supplier: number;
  let yearId: number;

  const keys = (body: { messages?: { key: string }[] }) => (body.messages ?? []).map((m) => m.key);
  const monthly = (months: number[], days: number[]) => ({ mode: SCHEDULER_MODE.Monthly, interval: 1, weekDays: 0, months: listToMask(months), days: listToMask(days) });

  beforeAll(async () => {
    t = mainCompany();
    call = t.call;
    acc = t.acc;
    supplier = await t.partner('Наемодател ООД', ['401']);
    yearId = (await call('GET', '/session')).body.year.id;
  }, 60_000);

  describe('templates (02a 9.1)', () => {
    let rentId: number;

    it('requires a unique name', async () => {
      const empty = await call('POST', '/templates', { name: ' ', debits: [], credits: [] });
      expect(empty.status).toBe(422);
      expect(keys(empty.body)).toEqual(['strTemplateNameError']);
      expect(empty.body.error).toBe('Не е въведено име на шаблон!');

      const r = await call('POST', '/templates', {
        name: 'Наем офис', documentTypeId: 10, term: 'Начислен наем', reference: 'договор 5', companyId: supplier,
        debits: [{ accountId: acc('602'), amount: '500' }], credits: [{ accountId: acc('401'), amount: '500', companyId: supplier }],
      });
      expect(r.status, r.text).toBe(201);
      rentId = r.body.id;

      const dup = await call('POST', '/templates', { name: 'наем офис ', debits: [], credits: [] });
      expect(dup.status).toBe(422);
      expect(keys(dup.body)).toEqual(['strTemplateNameExistWarning']);
      expect(dup.body.error).toBe('Съществува шаблон с това име!');
    });

    it('lists templates with summary columns and the fast-entry filter', async () => {
      const multi = await call('POST', '/templates', {
        name: 'Продажба с ДДС', documentTypeId: 1, term: 'Продажба',
        debits: [{ accountId: acc('411'), amount: '120' }], credits: [{ accountId: acc('702'), amount: '100' }, { accountId: acc('453/2'), amount: '20' }],
      });
      expect(multi.status, multi.text).toBe(201);
      const all = (await call('GET', '/templates')).body;
      expect(all.map((x: { name: string }) => x.name)).toEqual(['Наем офис', 'Продажба с ДДС']);
      const rent = all.find((x: { id: number }) => x.id === rentId);
      expect(rent).toMatchObject({ debitAccounts: '602', creditAccounts: '401', amount: '500.00', isFast: true, debitAccountId: acc('602'), creditAccountId: acc('401'), companyName: 'Наемодател ООД', documentTypeName: 'Мемориален ордер', hasSchedule: false });
      const sale = all.find((x: { name: string }) => x.name === 'Продажба с ДДС');
      expect(sale).toMatchObject({ creditAccounts: '702, 453/2', amount: '120.00', isFast: false, debitAccountId: null });
      const fast = (await call('GET', '/templates?fast=1')).body;
      expect(fast.map((x: { id: number }) => x.id)).toEqual([rentId]);
      expect((await call('GET', '/templates?q=прод')).body).toHaveLength(1);
      expect((await call('GET', '/templates?account=453')).body.map((x: { name: string }) => x.name)).toEqual(['Продажба с ДДС']);
    });

    it('returns an editor draft with constants from the template', async () => {
      const d = (await call('GET', `/templates/${rentId}/draft?date=2026-04-15`)).body;
      expect(d).toMatchObject({ number: '', accountingDate: '2026-04-15', documentDate: '2026-04-15', documentTypeId: 10, documentNumber: '', term: 'Начислен наем', reference: 'договор 5', companyId: supplier, source: 'template', viesMonth: '2026-04-01' });
      expect(d.id).toBeUndefined();
      expect(d.debits).toEqual([expect.objectContaining({ accountId: acc('602'), amount: '500.00' })]);
      expect(d.credits).toEqual([expect.objectContaining({ accountId: acc('401'), amount: '500.00', companyId: supplier })]);
    });

    it('updates and deletes a template', async () => {
      const full = (await call('GET', `/templates/${rentId}`)).body;
      const put = await call('PUT', `/templates/${rentId}`, { ...full, name: 'Наем офис', debits: [{ accountId: acc('602'), amount: '550' }], credits: [{ accountId: acc('401'), amount: '550', companyId: supplier }] });
      expect(put.status, put.text).toBe(200);
      expect((await call('GET', `/templates/${rentId}`)).body.debits[0].amount).toBe('550.00');
      const tmp = await call('POST', '/templates', { name: 'Временен', debits: [{ accountId: acc('501'), amount: '1' }], credits: [{ accountId: acc('101'), amount: '1' }] });
      expect((await call('PUT', `/templates/${tmp.body.id}`, { name: 'Наем офис', debits: [], credits: [] })).status).toBe(422);
      expect((await call('DELETE', `/templates/${tmp.body.id}`)).status).toBe(200);
      expect((await call('GET', `/templates/${tmp.body.id}`)).status).toBe(404);
    });

    describe('schedules (02a 9.2)', () => {
      it('validates the schedule form', async () => {
        const r = await call('PUT', `/templates/${rentId}`, { name: 'Наем офис', debits: [{ accountId: acc('602'), amount: '550' }], credits: [{ accountId: acc('401'), amount: '550', companyId: supplier }], documentTypeId: 10, term: 'Начислен наем', schedule: monthly([], []) });
        expect(r.status).toBe(422);
        expect(keys(r.body)).toEqual(['strMonthsError', 'strDaysError']);
      });

      it('generates 12 monthly rows on the 5th and regenerating replaces them (acceptance)', async () => {
        const full = (await call('GET', `/templates/${rentId}`)).body;
        const r = await call('PUT', `/templates/${rentId}`, { ...full, schedule: monthly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [5]) });
        expect(r.status, r.text).toBe(200);
        const g = await call('POST', `/templates/${rentId}/schedule/generate`);
        expect(g.status, g.text).toBe(200);
        expect(g.body.generated).toBe(12);
        const rows = (await call('GET', '/template-schedules?from=2026-01-01&to=2026-12-31')).body;
        expect(rows).toHaveLength(12);
        expect(rows.every((x: { date: string }) => x.date.endsWith('-05'))).toBe(true);
        expect(rows[0]).toMatchObject({ templateName: 'Наем офис', isProcessed: false, accountingId: null });
        const again = await call('POST', `/templates/${rentId}/schedule/generate`);
        expect(again.body.generated).toBe(12);
        const rows2 = (await call('GET', '/template-schedules')).body;
        expect(rows2).toHaveLength(12);
        expect(rows2[0].id).not.toBe(rows[0].id);
        expect((await call('GET', '/templates')).body.find((x: { id: number }) => x.id === rentId).hasSchedule).toBe(true);
      });

      it('processes selected rows into entries at the scheduled dates', async () => {
        const rows = (await call('GET', '/template-schedules')).body;
        const r = await call('POST', '/template-schedules/process', { ids: [rows[0].id, rows[1].id] });
        expect(r.status, r.text).toBe(200);
        expect(r.body.processed).toBe(2);
        expect(r.body.message).toBe('Осчетоводяване на графика за 05.01.2026 г. - 05.02.2026 г. завърши успешно.');
        const e = (await call('GET', `/entries/${r.body.entries[0].id}`)).body;
        expect(e).toMatchObject({ accountingDate: '2026-01-05', documentTypeId: 10, term: 'Начислен наем', source: 'schedule' });
        expect(e.debits).toEqual([expect.objectContaining({ accountId: acc('602'), amount: '550.00' })]);
        expect(e.credits).toEqual([expect.objectContaining({ accountId: acc('401'), amount: '550.00', companyId: supplier })]);
        const processed = (await call('GET', '/template-schedules?processed=1')).body;
        expect(processed).toHaveLength(2);
        expect(processed[0].accountingNumber).toBe(e.number);
        expect((await call('GET', '/template-schedules')).body).toHaveLength(10);
        // Regenerating keeps the processed rows.
        const g = await call('POST', `/templates/${rentId}/schedule/generate`);
        expect(g.body).toEqual({ generated: 10, kept: 2 });
        expect((await call('GET', '/template-schedules?processed=all')).body).toHaveLength(12);
      });

      it('deleting a generated entry un-processes its row', async () => {
        const [row] = (await call('GET', '/template-schedules?processed=1')).body;
        expect((await call('DELETE', `/entries/${row.accountingId}`)).status).toBe(200);
        const back = (await call('GET', '/template-schedules?processed=all')).body.find((x: { id: number }) => x.id === row.id);
        expect(back).toMatchObject({ isProcessed: false, accountingId: null });
      });

      it('rejects a locked month and posts nothing of the batch', async () => {
        await call('PUT', `/years/${yearId}/locks`, { months: [3] });
        const rows = (await call('GET', '/template-schedules?from=2026-01-01&to=2026-04-30')).body;
        const before = (await call('GET', '/entries')).body.total;
        const r = await call('POST', '/template-schedules/process', { ids: rows.map((x: { id: number }) => x.id) });
        expect(r.status).toBe(422);
        expect(keys(r.body)).toContain('strWrongAccountingMonth');
        expect((await call('GET', '/entries')).body.total).toBe(before);
        await call('PUT', `/years/${yearId}/locks`, { months: [] });
      });

      it('skips rows of another financial year with a warning', async () => {
        expect((await call('POST', '/years', { year: 2027, force: true })).status).toBe(201);
        expect((await call('PUT', '/years/active', { year: 2027 })).status).toBe(200);
        const g = await call('POST', `/templates/${rentId}/schedule/generate`);
        expect(g.body.generated).toBe(12);
        expect((await call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
        const next = (await call('GET', '/template-schedules?from=2027-01-01&to=2027-01-31')).body;
        const cur = (await call('GET', '/template-schedules?from=2026-04-01&to=2026-04-30')).body;
        const r = await call('POST', '/template-schedules/process', { ids: [next[0].id, cur[0].id] });
        expect(r.status, r.text).toBe(200);
        expect(r.body.processed).toBe(1);
        expect(r.body.warnings.map((w: { key: string }) => w.key)).toEqual(['strTemplateSchedulesFromAnotherYearFound']);
        expect(r.body.warnings[0].text).toBe('Шаблоните за осчетоводяване от други счетоводни години няма да бъдат обработени!');
      });

      it('numbers documents from the document sequence when the type requires one', async () => {
        const inv = await call('POST', '/templates', {
          name: 'Абонамент', documentTypeId: 1, term: 'Абонамент', transactionTypeId: 2,
          debits: [{ accountId: acc('411'), amount: '60' }], credits: [{ accountId: acc('703'), amount: '60' }], schedule: monthly([6], [1]),
        });
        expect(inv.status, inv.text).toBe(201);
        await call('POST', `/templates/${inv.body.id}/schedule/generate`);
        const client = await t.partner('Абонат АД', ['411']);
        // A partner is needed on 411: the template has none, so the batch fails with strMissingCompany.
        const [row] = (await call('GET', '/template-schedules?q=Абонамент')).body;
        const bad = await call('POST', '/template-schedules/process', { ids: [row.id] });
        expect(keys(bad.body)).toContain('strMissingCompany');
        const full = (await call('GET', `/templates/${inv.body.id}`)).body;
        await call('PUT', `/templates/${inv.body.id}`, { ...full, companyId: client, schedule: undefined });
        const ok = await call('POST', '/template-schedules/process', { ids: [row.id] });
        expect(ok.status, ok.text).toBe(200);
        const e = (await call('GET', `/entries/${ok.body.entries[0].id}`)).body;
        expect(e.documentNumber).toMatch(/^0*1$/);
        expect(e.companyId).toBe(client);
      });
    });
  });

  describe('reschedules (02a 9.3)', () => {
    let cardId: number;
    const base = () => ({
      name: 'Застраховка', amount: '1200', documentTypeId: 1, documentNumber: '777', documentDate: '2026-01-10',
      fromDate: '2026-01-01', toDate: '2026-12-31', isRescheduleByDays: false,
      debitAccountId: acc('609'), creditAccountId: acc('651'), term: 'Отписване на застраховка',
    });

    it('validates the card', async () => {
      const r = await call('POST', '/reschedules', { fromDate: '2026-01-01', toDate: '2026-12-31' });
      expect(r.status).toBe(422);
      expect(keys(r.body)).toEqual(['strInvalidAccountingRescheduleName', 'strInvalidAccountingRescheduleAmount', 'strDebitAccountIsMissing', 'strCreditAccountIsMissing']);
      const cat = await call('POST', '/reschedules', { ...base(), creditAccountId: acc('501') });
      expect(keys(cat.body)).toEqual(['strInvalidAccountingRescheduleDebitAccount', 'strInvalidAccountingRescheduleCreditAccount']);
      const sub = await call('POST', '/reschedules', { ...base(), debitAccountId: acc('604') });
      expect(keys(sub.body)).toEqual(['strDebitAccountHasSubAccounts']);
      const partner = await call('POST', '/reschedules', { ...base(), debitAccountId: acc('751'), creditAccountId: acc('411') });
      expect(keys(partner.body)).toEqual(['strCompanyIsMissing']);
      expect(partner.body.messages[0].text).toBe('Не е попълнен Партньор');
    });

    it('creates a card with 12 monthly periods', async () => {
      const r = await call('POST', '/reschedules', base());
      expect(r.status, r.text).toBe(201);
      cardId = r.body.id;
      expect(r.body).toMatchObject({ number: '1', amount: '1200.00', processedAmount: '0.00', remainingAmount: '1200.00', lastProcessedMonth: null });
      expect(r.body.details).toHaveLength(12);
      expect(r.body.details.every((d: { amount: string }) => d.amount === '100.00')).toBe(true);
      const odd = await call('POST', '/reschedules', { ...base(), name: 'Абонамент', amount: '100', fromDate: '2026-04-01', toDate: '2026-06-30' });
      expect(odd.body.details.map((d: { amount: string }) => d.amount)).toEqual(['33.33', '33.33', '33.34']);
      expect(odd.body.number).toBe('2');
      const days = await call('POST', '/reschedules', { ...base(), name: 'По дни', amount: '100', fromDate: '2026-01-15', toDate: '2026-03-14', isRescheduleByDays: true });
      expect(days.body.details.map((d: { amount: string }) => d.amount)).toEqual(['28.81', '47.45', '23.74']);
      const list = (await call('GET', '/reschedules?name=застр')).body;
      expect(list).toEqual([expect.objectContaining({ id: cardId, debitAccount: '609', creditAccount: '651', documentName: 'Фактура', remainingAmount: '1200.00' })]);
    });

    it('posts monthly entries up to a month and keeps processed periods on edit', async () => {
      const r = await call('POST', '/reschedules/process', { toMonth: '2026-02', ids: [cardId] });
      expect(r.status, r.text).toBe(200);
      expect(r.body.created).toHaveLength(2);
      const e = (await call('GET', `/entries/${r.body.created[1].id}`)).body;
      expect(e).toMatchObject({ accountingDate: '2026-02-28', documentTypeId: 10, term: 'Отписване на застраховка', reference: 'Разсрочване по Фактура №777', source: 'reschedule' });
      expect(e.debits).toEqual([expect.objectContaining({ accountId: acc('609'), amount: '100.00' })]);
      expect(e.credits).toEqual([expect.objectContaining({ accountId: acc('651'), amount: '100.00' })]);
      const card = (await call('GET', `/reschedules/${cardId}`)).body;
      expect(card).toMatchObject({ processedAmount: '200.00', remainingAmount: '1000.00', lastProcessedMonth: '2026-02-01' });
      expect(card.details[0]).toMatchObject({ isProcessed: true, accountingNumber: expect.any(String) });
      // Editing the amount regenerates the unprocessed periods from the remainder.
      const put = await call('PUT', `/reschedules/${cardId}`, { ...base(), amount: '1100' });
      expect(put.status, put.text).toBe(200);
      expect(put.body.details.map((d: { amount: string }) => d.amount)).toEqual(['100.00', '100.00', ...Array(10).fill('90.00')]);
      // Processing again is idempotent for already posted months.
      expect((await call('POST', '/reschedules/process', { toMonth: '2026-02', ids: [cardId] })).body.created).toHaveLength(0);
    });

    it('blocks locked months', async () => {
      await call('PUT', `/years/${yearId}/locks`, { months: [3] });
      const r = await call('POST', '/reschedules/process', { toMonth: '2026-03', ids: [cardId] });
      expect(r.status).toBe(422);
      expect(keys(r.body)).toContain('strWrongAccountingMonth');
      await call('PUT', `/years/${yearId}/locks`, { months: [] });
      expect((await call('GET', `/reschedules/${cardId}`)).body.processedAmount).toBe('200.00');
    });

    it('reports values, totals and sorting', async () => {
      const r = (await call('GET', '/reports/reschedules?from=2026-01-01&to=2026-12-31&sort=remaining')).body;
      expect(r.rows.map((x: { name: string }) => x.name)).toEqual(['Абонамент', 'По дни', 'Застраховка']);
      expect(r.rows[2]).toMatchObject({ number: '1', documentName: 'Фактура', documentNumber: '777', amount: '1100.00', processedAmount: '200.00', remainingAmount: '900.00', processedAmountByFinYear: '200.00', lastProcessedMonth: '2026-02-01', debitAccount: '609', creditAccount: '651' });
      expect(r.totals).toMatchObject({ amount: '1300.00', processedAmount: '200.00', remainingAmount: '1100.00' });
      // As of January only the first period counts.
      const jan = (await call('GET', '/reports/reschedules?from=2026-01-01&to=2026-01-31&debit=609&name=Застр')).body;
      expect(jan.rows).toHaveLength(1);
      expect(jan.rows[0]).toMatchObject({ processedAmount: '100.00', remainingAmount: '1000.00' });
    });

    it('deletes a card; posted entries remain', async () => {
      const card = (await call('GET', `/reschedules/${cardId}`)).body;
      expect((await call('DELETE', `/reschedules/${cardId}`)).status).toBe(200);
      expect((await call('GET', `/reschedules/${cardId}`)).status).toBe(404);
      expect((await call('GET', `/entries/${card.details[0].accountingId}`)).status).toBe(200);
    });
  });
});

describe('journal read routes need the journal rights', () => {
  /** Logs in as a user of a new group with the permission overrides, runs fn, then returns to the admin. */
  async function asRole(name: string, perms: Record<number, boolean>, fn: () => Promise<void>) {
    const role = await call('POST', '/roles', { name });
    expect(role.status, role.text).toBeLessThan(300);
    expect((await call('PUT', `/roles/${role.body.id}/permissions`, perms)).status).toBe(200);
    const u = await call('POST', '/users', { name: `${name} потребител`, password: 'secret1', roleId: role.body.id });
    expect(u.status, u.text).toBe(201);
    const adminId = (await call('GET', '/session')).body.user.id;
    expect((await call('POST', '/login', { companyDb: t.companyDb, userId: u.body.id, password: 'secret1' })).status).toBe(200);
    try {
      await fn();
    } finally {
      expect((await call('POST', '/login', { companyDb: t.companyDb, userId: adminId, password: 'secret1' })).status).toBe(200);
    }
  }

  it('list needs UI_Edit_Accountings; an entry, its attachments and the running balances need posting or editing rights', async () => {
    const e = await t.post({ date: '2026-02-20', docNumber: 'PERM-1', dr: [['501', 10]], cr: [['101', 10]] });
    const reads = [`/entries/${e.id}`, `/journal/entries/${e.id}/attachments`, `/journal/account-balances?ids=${acc('501')}&date=2026-02-28&excludeId=0`];
    // 15 = UI_Operations_Accounting, 28 = UI_Edit_Accountings, 34 = UI_Reporting_ChronologicalReport.
    await asRole('Без контиране', { 15: false, 28: false, 34: false }, async () => {
      expect((await call('GET', '/entries')).status).toBe(403);
      for (const url of reads) expect((await call('GET', url)).status, url).toBe(403);
      expect((await call('GET', '/journal/attachments/1/download')).status).toBe(403);
      expect((await call('GET', '/journal-lines')).status).toBe(403);
    });
    await asRole('Само контиране', { 15: true, 28: false }, async () => {
      expect((await call('GET', '/entries')).status).toBe(403);
      for (const url of reads) expect((await call('GET', url)).status, url).toBe(200);
    });
    await asRole('Само редакция', { 15: false, 28: true }, async () => {
      expect((await call('GET', '/entries')).status).toBe(200);
      for (const url of reads) expect((await call('GET', url)).status, url).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// Entry editor follow-ups: fixing, partner account links, entry card, VAT
// protocol commands, fast-entry payment numbers and binding.

/** Points the ECB download at a canned answer (no network in the tests). */
async function withEcb<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ECB_RATES_URL;
  process.env.ECB_RATES_URL = url;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ECB_RATES_URL;
    else process.env.ECB_RATES_URL = prev;
  }
}
const DEAD_ECB = 'http://127.0.0.1:9/eurofxref.xml';
const ecbXml = (date: string, usd: string) =>
  `data:text/xml,${encodeURIComponent(`<gesmes:Envelope><Cube><Cube time='${date}'><Cube currency='USD' rate='${usd}'/></Cube></Cube></gesmes:Envelope>`)}`;

describe('02a 2 / 03a 5.4 fixing of the accounting date', () => {
  let usd = '';
  beforeAll(async () => {
    const r = await call('POST', '/accounts', { parentId: acc('504'), description: 'Банка USD фиксинг', accountCategoryId: 27, currencyId: 3 });
    expect(r.status, r.text).toBe(201);
    await t.reloadAccounts();
    usd = (await call('GET', '/accounts')).body.find((a: { id: number }) => a.id === r.body.id).number;
    expect((await call('PUT', '/revaluation/rates', { date: '2026-03-10', rates: [{ currencyId: 3, rate: '0.92' }] })).status).toBe(200);
  });
  const fixingOf = async (id: number) => (await call('GET', `/entries/${id}`)).body.debits[0].fixedRate;

  it('the line fixing is the stored rate of the accounting date, else the currency fixed rate; a typed fixing stays', async () => {
    const stored = await t.post({ date: '2026-03-10', dr: [[usd, 920, { currencyAmount: '1000', exchangeRate: '0.92' }]], cr: [['702', 920]] });
    expect(await fixingOf(stored.id)).toBe('0.920000');
    const none = await t.post({ date: '2026-03-11', dr: [[usd, 900, { currencyAmount: '1000' }]], cr: [['702', 900]] });
    expect(await fixingOf(none.id)).toBe('1.000000');
    const typed = await t.post({ date: '2026-03-10', dr: [[usd, 930, { currencyAmount: '1000', exchangeRate: '0.93', fixedRate: '0.931' }]], cr: [['702', 930]] });
    expect(await fixingOf(typed.id)).toBe('0.931000');
  });

  it('GET /journal/fixing: stored rate, a missing one downloaded, a holiday reported without a 1.0 fallback', async () => {
    const stored = await call('GET', '/journal/fixing?date=2026-03-10&currencyIds=3');
    expect(stored.status, stored.text).toBe(200);
    expect([stored.body.rates[0].rate, stored.body.message]).toEqual(['0.92', null]);
    const holiday = await withEcb(DEAD_ECB, () => call('GET', '/journal/fixing?date=2026-03-14&currencyIds=3&download=1'));
    expect([holiday.body.rates[0].rate, holiday.body.message]).toEqual([null, 'Избраната дата на осчетоводяване е почивен ден или услугата за валутни справки е временно неактивна.']);
    const noDownload = await withEcb(ecbXml('2026-03-12', '1.0810'), () => call('GET', '/journal/fixing?date=2026-03-12&currencyIds=3'));
    expect(noDownload.body.rates[0].rate).toBeNull();
    const downloaded = await withEcb(ecbXml('2026-03-12', '1.0810'), () => call('GET', '/journal/fixing?date=2026-03-12&currencyIds=3&download=1'));
    expect([downloaded.body.rates[0].rate, downloaded.body.rates[0].source, downloaded.body.message]).toEqual(['0.92507', 'ecb', null]);
    // The downloaded rate is stored: the save of that date uses it.
    const e = await t.post({ date: '2026-03-12', dr: [[usd, 92.51, { currencyAmount: '100' }]], cr: [['702', 92.51]] });
    expect(await fixingOf(e.id)).toBe('0.925070');
  });

  it('"Обновяване на фиксингите от БНБ" writes the downloaded rates to the currencies; a failure changes nothing', async () => {
    const cur = async (iso: string) => (await call('GET', '/currencies')).body.find((c: { isoCode: string }) => c.isoCode === iso);
    const before = await cur('USD');
    const failed = await withEcb(DEAD_ECB, () => call('POST', '/currencies/refresh-fixings', { date: '2026-03-16' }));
    expect(failed.status).toBe(503);
    expect(failed.body.error).toBe('Избраната дата на осчетоводяване е почивен ден или услугата за валутни справки е временно неактивна.');
    expect((await cur('USD')).fixedRate).toBe(before.fixedRate);
    const ok = await withEcb(ecbXml('2026-03-16', '1.25'), () => call('POST', '/currencies/refresh-fixings', { date: '2026-03-16' }));
    expect(ok.status, ok.text).toBe(200);
    expect([ok.body.updated, ok.body.message]).toEqual([1, 'Фиксингите са обновени към 16.03.2026 г. (1 валути).']);
    expect(await cur('USD')).toMatchObject({ fixedRate: '0.800000', rateDate: '2026-03-16' });
    expect((await cur('EUR')).fixedRate).toBe('1.955830');
  });
});

describe('03a 2.9 strAddAccountToCompanyConfirmation', () => {
  it('a partner line on an account the partner lacks asks (409 confirm); Yes links the account in the same save', async () => {
    const p = await t.partner('Без сметка 411 ООД', ['401']);
    const spec: EntrySpec = { date: '2026-05-02', docNumber: 'LNK-1', partner: p, dr: [['411', 10]], cr: [['702', 10]], confirmAccountLinks: true };
    const before = (await call('GET', '/entries')).body.total;
    const ask = await t.tryPost(spec);
    expect([ask.status, ask.body.code, keys(ask.body)]).toEqual([409, 'confirm', ['strAddAccountToCompanyConfirmation']]);
    expect(ask.body.messages[0].text).toBe('Избраният партньор не съдържа сметка 411! Сметката ще бъде добавена към партньора!');
    expect((await call('GET', '/entries')).body.total).toBe(before);
    const linked = async (id: number) => (await call('GET', `/partners/${id}`)).body.accountIds as number[];
    expect(await linked(p)).toEqual([acc('401')]);
    const yes = await t.tryPost({ ...spec, force: true });
    expect(yes.status, yes.text).toBe(201);
    expect((await linked(p)).sort()).toEqual([acc('401'), acc('411')].sort());
    // Linked now: no question.
    expect((await t.tryPost({ ...spec, docNumber: 'LNK-2' })).status).toBe(201);
    // Callers that do not ask (imports, API) save without linking.
    const q = await t.partner('Без въпрос ООД', ['401']);
    expect((await t.tryPost({ date: '2026-05-02', docNumber: 'LNK-3', partner: q, dr: [['411', 10]], cr: [['702', 10]] })).status).toBe(201);
    expect(await linked(q)).toEqual([acc('401')]);
  });
});

describe('05 7.11 entry card and the list protocol commands (02a 7)', () => {
  it('prints the header and the debit / credit tables with totals', async () => {
    const e = await t.post({ date: '2026-05-03', docNumber: 'PR-1', term: 'Печат на контиране', partner: supplierA, dr: [['602', 70], ['603', 30]], cr: [['401', 100]] });
    const r = await call('GET', `/journal/entries/${e.id}/print`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.header).toMatchObject({ number: e.number, accountingDate: '2026-05-03', documentType: 'Фактура', documentNumber: 'PR-1', company: 'Доставчик А ООД', term: 'Печат на контиране' });
    expect(r.body.debit.lines.map((l: { accountNumber: string; amount: string }) => [l.accountNumber, l.amount])).toEqual([['602', '70.00'], ['603', '30.00']]);
    expect([r.body.debit.total, r.body.credit.total, r.body.credit.lines[0].companyName, r.body.debit.hasCurrency]).toEqual(['100.00', '100.00', 'Доставчик А ООД', false]);
    expect(r.body.company.name).toBe('Тест ООД');
  });

  it('the VAT protocol commands find the protocol of the selected entry; without one they answer noProtocol', async () => {
    const e = await t.post({ date: '2026-05-04', docNumber: 'VOP-1', partner: supplierA, transactionTypeId: 2, dr: [['602', 100, { vatTermId: 2 }]], cr: [['401', 100, { vatTermId: 2 }]] });
    const none = await call('GET', `/journal/entries/${e.id}/protocol`);
    expect([none.status, none.body.code, none.body.error]).toEqual([404, 'noProtocol', 'Към избраното контиране няма протокол по ЗДДС.']);
    const d = (await call('GET', `/vat/protocols/${e.id}/defaults?icaType=1&purchaseTermId=2`)).body;
    const saved = await call('PUT', `/vat/protocols/${e.id}`, { icaType: 1, purchaseTermId: 2, documentNumber: d.documentNumber, documentDate: '2026-05-04', viesMonth: '2026-05-01', base: '100', vat: '20' });
    expect(saved.status, saved.text).toBe(200);
    const p = await call('GET', `/journal/entries/${e.id}/protocol`);
    expect(p.status, p.text).toBe(200);
    expect(p.body.protocol).toMatchObject({ documentNumber: d.documentNumber, base: '100.00', vat: '20.00', total: '120.00' });
    // Selecting the protocol accounting itself finds the same protocol.
    const fromProtocol = await call('GET', `/journal/entries/${saved.body.id}/protocol`);
    expect([fromProtocol.status, fromProtocol.body.main.documentNumber]).toEqual([200, 'VOP-1']);
  });
});

describe('02a 8.1 fast entry: payment numbers and binding', () => {
  const frow = (n: string, extra: Record<string, unknown> = {}) => ({
    documentTypeId: 1, documentNumber: n, date: '2026-08-06', debitAccountId: acc('602'), creditAccountId: acc('401'), amount: '10',
    companyId: supplierA, term: 'Бързо с плащане', debitVatTermId: 2, ...extra,
  });

  it('the РКО of a row payment skips a number a typed РКО already uses', async () => {
    const first = await call('POST', '/journal/fast-entry', { rows: [frow('FP-1', { paymentAccountId: acc('501') })] });
    expect(first.status, first.text).toBe(201);
    const n1 = (await call('GET', `/entries/${first.body.saved[0].paymentId}`)).body.documentNumber as string;
    const pad = (n: number) => String(n).padStart(n1.length, '0');
    await t.post({ date: '2026-08-06', docType: 9, docNumber: pad(Number(n1) + 1), partner: supplierA, dr: [['401', 5]], cr: [['501', 5]] });
    const second = await call('POST', '/journal/fast-entry', { rows: [frow('FP-2', { paymentAccountId: acc('501') })] });
    expect(second.status, second.text).toBe(201);
    expect((await call('GET', `/entries/${second.body.saved[0].paymentId}`)).body.documentNumber).toBe(pad(Number(n1) + 2));
  });

  it('binds a row entry with open documents in the same save (IsBindingDocumentsInFastAccountingEnabled)', async () => {
    const sup = await t.partner('Бързо обвързване ООД', ['401']);
    const inv = await t.post({ date: '2026-08-01', partner: sup, dr: [['602', 70]], cr: [['401', 70]] });
    const pay = (n: string, extra: Record<string, unknown> = {}) => ({
      documentTypeId: 9, documentNumber: n, date: '2026-08-07', debitAccountId: acc('401'), creditAccountId: acc('501'), amount: '70', companyId: sup,
      term: 'Плащане с обвързване', bindDocuments: [{ accountingId: inv.id }], ...extra,
    });
    expect((await call('GET', '/session')).body.settings.IsBindingDocumentsInFastAccountingEnabled).toBe('True');
    // With a payment account the binding is refused, and nothing is saved.
    const before = (await call('GET', '/entries')).body.total;
    const both = await call('POST', '/journal/fast-entry', { rows: [pay('FB-0', { debitAccountId: acc('602'), creditAccountId: acc('401'), paymentAccountId: acc('501'), documentTypeId: 1 })] });
    expect([both.status, keys(both.body)]).toEqual([422, ['strBindingWithPayment']]);
    // A document of another partner fails the whole batch.
    const foreign = await t.post({ date: '2026-08-01', partner: supplierB, dr: [['602', 5]], cr: [['401', 5]] });
    const bad = await call('POST', '/journal/fast-entry', { rows: [pay('FB-1'), pay('FB-2', { bindDocuments: [{ accountingId: foreign.id }] })] });
    expect(bad.status).toBe(422);
    expect((await call('GET', '/entries')).body.total).toBe(before + 1);
    // Off in the settings: refused.
    expect((await call('PUT', '/settings', { IsBindingDocumentsInFastAccountingEnabled: 'False' })).status).toBe(200);
    expect((await call('POST', '/journal/fast-entry', { rows: [pay('FB-3')] })).status).toBe(400);
    expect((await call('PUT', '/settings', { IsBindingDocumentsInFastAccountingEnabled: 'True' })).status).toBe(200);
    const ok = await call('POST', '/journal/fast-entry', { rows: [pay('FB-4')] });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body.saved[0].bound).toBe(1);
    const open = (await call('GET', `/payments/open-items?companyId=${sup}`)).body;
    expect([open.liabilities.length, open.payments.length]).toEqual([0, 0]);
  });
});
