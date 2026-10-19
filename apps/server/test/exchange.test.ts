import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { BACKUP_FORMAT_VERSION, CHANNEL, DOCUMENT_TYPE, formatTextImportLine, parseTransferXml, writeTransferXml, type TransferData } from '@shmi/core';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { encodeBackup } from '../src/services/exchange/backup.ts';
import { encodeLogicalDump, logicalDump } from '../src/db/logicalDump.ts';
import { queryRows } from '../src/db/provider.ts';
import { insertPaymentLinks, openItems } from '../src/services/openItems.ts';
import { peekNextNumber } from '../src/services/sequences.ts';

let t: TestCompany;
let call: TestCompany['call'];
let acc: TestCompany['acc'];

beforeAll(async () => {
  t = await createTestCompany();
  call = t.call;
  acc = t.acc;
}, 60_000);
afterAll(() => t.close());

const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);

type Caller = Pick<TestCompany, 'call'>;
type Rawer = Pick<TestCompany, 'app' | 'session'>;

/**
 * A second company in the same in-memory server (one driver per file keeps
 * the memory use low): its own session cookie, the same helpers.
 */
async function sibling(companyName: string, year = 2026, bulstat = '175074752') {
  const home = t.session.get();
  const r = await call('POST', '/companies', { companyName, adminName: 'Администратор', adminPassword: 'secret1', year, bulstat });
  expect(r.status, r.text).toBe(201);
  let cookie = t.session.get();
  t.session.set(home);
  const own = async <T>(fn: () => Promise<T>) => {
    const back = t.session.get();
    t.session.set(cookie);
    try {
      return await fn();
    } finally {
      cookie = t.session.get();
      t.session.set(back);
    }
  };
  const sCall: TestCompany['call'] = (m, u, b) => own(() => call(m, u, b));
  let accounts: { id: number; number: string }[] = (await sCall('GET', '/accounts')).body;
  const sAcc = (n: string) => {
    const a = accounts.find((x) => x.number === n);
    if (!a) throw new Error(`No account ${n}`);
    return a.id;
  };
  return {
    database: r.body.name as string,
    call: sCall,
    acc: sAcc,
    app: t.app,
    session: { get: () => cookie, set: (v: string) => { cookie = v; } },
    reloadAccounts: async () => { accounts = (await sCall('GET', '/accounts')).body; },
    partner: async (name: string, nums: string[], extra: Record<string, unknown> = {}) => {
      const x = await sCall('POST', '/partners', { name, accountIds: nums.map(sAcc), ...extra });
      expect(x.status, x.text).toBe(201);
      return x.body.id as number;
    },
    post: async (e: { date: string; partner?: number; dr: [string, string][]; cr: [string, string][] }) => {
      const x = await sCall('POST', '/entries', {
        accountingDate: e.date, documentDate: e.date, documentTypeId: 1, documentNumber: String(Math.floor(Math.random() * 1e9)), term: 'Тест', companyId: e.partner ?? null,
        debits: e.dr.map(([n, a]) => ({ accountId: sAcc(n), amount: a })), credits: e.cr.map(([n, a]) => ({ accountId: sAcc(n), amount: a })),
      });
      expect(x.status, x.text).toBe(201);
      return x.body;
    },
    /** Deletes the company again (frees its database). */
    drop: async () => {
      const x = await call('POST', `/companies/${r.body.name}/delete`, { userId: 1, password: 'secret1' });
      expect(x.status, x.text).toBe(200);
    },
  };
}

async function raw(tc: Rawer, method: string, url: string, body?: unknown) {
  const res = await tc.app.request(`/api${url}`, { method, headers: { 'content-type': 'application/json', cookie: tc.session.get() }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function balances(tc: Caller, from: string, to: string) {
  const r = await tc.call('GET', `/reports/trial-balance?from=${from}&to=${to}&level=3`);
  expect(r.status, r.text).toBe(200);
  const out: Record<string, { od: string; oc: string; dt: string; ct: string; cd: string; cc: string }> = {};
  for (const x of r.body.rows) out[x.number] = { od: x.openingDebit, oc: x.openingCredit, dt: x.debitTurnover, ct: x.creditTurnover, cd: x.closingDebit, cc: x.closingCredit };
  return out;
}

async function entryCount(tc: Caller, query = '') {
  const r = await tc.call('GET', `/entries?from=2026-01-01&to=2026-12-31&initial=all${query}`);
  expect(r.status, r.text).toBe(200);
  return r.body.total as number;
}

async function xlsx(rows: unknown[][], sheet = 'Данни') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

// ---------------------------------------------------------------------------

describe('text import (04a 4)', () => {
  const line = (kind: string, amount: string, code = '16', vat = '-1', doc = 'Ф-ра', date = '15.03.2026', partner = 'Текст Партньор ООД', bulstat = '200000001') =>
    formatTextImportLine([kind, date, '1001', doc, amount, code, partner, 'Иван', 'София', 'ул. 1', '', bulstat, '', '', 'бел.', vat]);

  it('imports a sale and a free-form purchase with VAT', async () => {
    const before = await entryCount(t);
    const text = [line('2', '120.00'), line('602%-401', '60.00', '12', '10.00', 'Ф-ра', '16.03.2026')].join('\r\n');
    const r = await call('POST', '/exchange/text/import', { fileName: 'ops.txt', text });
    expect(r.status, r.text).toBe(200);
    expect(r.body.accountings).toBe(2);
    expect(await entryCount(t)).toBe(before + 2);
    const tb = await balances(t, '2026-03-15', '2026-03-16');
    expect(tb['411']!.dt).toBe('120.00');
    expect(tb['702']!.ct).toBe('100.00');
    expect(tb['453/2']!.ct).toBe('20.00');
    expect(tb['602']!.dt).toBe('50.00');
    expect(tb['453/1']!.dt).toBe('10.00');
    expect(tb['401']!.ct).toBe('60.00');
    // One partner, reused by Bulstat.
    const partners = (await call('GET', '/partners?q=Текст')).body;
    expect((Array.isArray(partners) ? partners : partners.rows).filter((p: { name: string }) => p.name === 'Текст Партньор ООД')).toHaveLength(1);
  });

  it('rejects a row with 15 fields and saves nothing', async () => {
    const before = await entryCount(t);
    const bad = line('2', '1').split('|').slice(0, 15).join('|');
    const r = await call('POST', '/exchange/text/import', { fileName: 'bad.txt', text: [line('2', '5'), bad].join('\n') });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strInvalidDataFormatInRow']);
    expect(r.body.error).toContain('Невалиден формат на данните на ред 2');
    expect(await entryCount(t)).toBe(before);
  });

  it('collects row errors (VAT code 10, other year) and saves nothing', async () => {
    const before = await entryCount(t);
    const r = await call('POST', '/exchange/text/import', { fileName: 'bad.txt', text: [line('2', '1', '10'), line('2', '1', '16', '0', 'Ф-ра', '01.01.2025')].join('\n') });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strInvalidVatTermTypeInImport', 'strOperationDateInDifferentFY']);
    expect(await entryCount(t)).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe('TransferData XML (04a 3)', () => {
  let t2: Awaited<ReturnType<typeof sibling>>;
  beforeAll(async () => {
    t2 = await sibling('Приемник ООД');
  }, 60_000);
  afterAll(() => t2.drop());

  it('export -> import into another company gives the same balances', async () => {
    const p = await t.partner('XML Клиент АД', ['411'], { bulstat: '121212121' });
    await t.post({ date: '2026-04-02', docNumber: '0000000501', partner: p, dr: [['411', '240']], cr: [['702', '200'], ['453/2', '40']], term: 'Продажба XML' });
    await t.post({ date: '2026-04-03', docNumber: '0000000502', dr: [['503', '75.5']], cr: [['411', '75.5']], partner: p, term: 'Плащане' });
    const exp = await raw(t, 'POST', '/exchange/xml/export', { from: '2026-04-01', to: '2026-04-30', fileName: 'Transfer.xml' });
    expect(exp.status).toBe(200);
    expect(exp.headers.get('x-export-count')).toBe('2');
    const xml = new TextDecoder().decode(exp.bytes);
    expect(xml).toContain('urn:Transfer');
    const v = await t2.call('POST', '/exchange/xml/validate', { fileName: 'Transfer.xml', text: xml });
    expect(v.status, v.text).toBe(200);
    expect(v.body).toMatchObject({ accountings: 2, needsCategories: false });
    const r = await t2.call('POST', '/exchange/xml/import', { fileName: 'Transfer.xml', text: xml });
    expect(r.status, r.text).toBe(200);
    expect(r.body.accountings).toBe(2);
    const a = await balances(t, '2026-04-01', '2026-04-30');
    const b = await balances(t2, '2026-04-01', '2026-04-30');
    for (const n of ['411', '702', '453/2', '503']) expect({ dt: b[n]!.dt, ct: b[n]!.ct }, n).toEqual({ dt: a[n]!.dt, ct: a[n]!.ct });
    // Importing again reuses the partner (same Bulstat) and doubles the postings.
    await t2.call('POST', '/exchange/xml/import', { fileName: 'Transfer.xml', text: xml });
    const list = (await t2.call('GET', '/partners?q=XML')).body;
    expect((Array.isArray(list) ? list : list.rows).filter((x: { name: string }) => x.name === 'XML Клиент АД')).toHaveLength(1);
    expect((await balances(t2, '2026-04-01', '2026-04-30'))['702']!.ct).toBe('400.00');
  });

  it('operation type 7 posts Dt 411 120 / Ct 702 100 / Ct 453/2 20', async () => {
    const data: TransferData = {
      operations: [{ operationType: 7, date: '2026-05-10', vatTerm: 7, term: 'Стоки', documentSumVatIncl: '120.00', documentVat: '20.00', document: { documentType: 1, number: '0000000777', date: '2026-05-10' }, company: { name: 'Операция ООД', bulstat: '131313131', bankAccounts: [], companyAccounts: [] } }],
    };
    const cats = (await t2.call('GET', '/exchange/xml/categories')).body as { categoryId: number; accountNumber: string }[];
    expect(cats.find((c) => c.categoryId === 10)?.accountNumber).toBe('411');
    const r = await t2.call('POST', '/exchange/xml/import', { fileName: 'op.xml', text: writeTransferXml(data), categoryMap: { 17: t2.acc('453/2') } });
    expect(r.status, r.text).toBe(200);
    const tb = await balances(t2, '2026-05-10', '2026-05-10');
    expect(tb['411']!.dt).toBe('120.00');
    expect(tb['702']!.ct).toBe('100.00');
    expect(tb['453/2']!.ct).toBe('20.00');
  });

  it('error messages: VAT on a payment, 2-2 accounting, no data, schema', async () => {
    const op = { operationType: 14, date: '2026-05-10', vatTerm: 1, documentSumVatIncl: '10', documentVat: '5', document: { documentType: 1, number: '1', date: '2026-05-10' }, company: { name: 'X', bankAccounts: [], companyAccounts: [] } };
    let r = await t2.call('POST', '/exchange/xml/import', { fileName: 'x.xml', text: writeTransferXml({ operations: [op] }) });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strVATNotAllowedInOperation']);
    expect(r.body.error).toContain('Възникна грешка при импорт на операциите');
    const d = (n: string, amount: string, direction: 'Debit' | 'Credit') => ({ accountNumber: n, amount, direction, vatTerm: 1 });
    r = await t2.call('POST', '/exchange/xml/import', { fileName: 'x.xml', text: writeTransferXml({ accountings: [{ accountingDate: '2026-05-11', vies: 1, vatTerm: 1, details: [d('503', '10', 'Debit'), d('501', '10', 'Debit'), d('411', '10', 'Credit'), d('401', '10', 'Credit')] }] }) });
    expect(keys(r)).toEqual(['strXMLImportAccountingDetailsError']);
    r = await t2.call('POST', '/exchange/xml/import', { fileName: 'x.xml', text: writeTransferXml({ accounts: [{ number: '411/77', description: 'Х', currency: 'EUR' }] }) });
    expect(keys(r)).toEqual(['strImportFileHasNoDataErrorMessage']);
    r = await t2.call('POST', '/exchange/xml/validate', { fileName: 'x.xml', text: '<TransferData xmlns="urn:Transfer"><Accountings><Accounting Vies="1"></Accounting></Accountings></TransferData>' });
    expect(r.status).toBe(422);
    expect(keys(r)[0]).toBe('strXMLImportError');
    expect(r.body.messages[1].text).toMatch(/line \d+ position \d+/);
  });

  it('accounts and products sections, locked month', async () => {
    const data: TransferData = {
      accounts: [{ number: '411/50', description: 'Клиенти от XML', currency: 'EUR', category: 10 }, { number: '999/1', description: 'Без родител', currency: 'EUR' }],
      accountings: [{ accountingDate: '2026-06-01', vies: 1, vatTerm: 1, details: [{ accountNumber: '503', amount: '1', direction: 'Debit', vatTerm: 1 }, { accountNumber: '101', amount: '1', direction: 'Credit', vatTerm: 1 }] }],
    };
    let r = await t2.call('POST', '/exchange/xml/import', { fileName: 'a.xml', text: writeTransferXml(data) });
    expect(keys(r)).toEqual(['strAccountParentNotFound']);
    data.accounts = data.accounts!.slice(0, 1);
    const years = (await t2.call('GET', '/years')).body as { id: number; year: number }[];
    const fy = years.find((y) => y.year === 2026)!;
    expect((await t2.call('PUT', `/years/${fy.id}/locks`, { months: [6] })).status).toBe(200);
    r = await t2.call('POST', '/exchange/xml/import', { fileName: 'a.xml', text: writeTransferXml(data) });
    expect(keys(r)).toEqual(['strOperationDateInLockedMonth']);
    await t2.call('PUT', `/years/${fy.id}/locks`, { months: [] });
    await t2.reloadAccounts();
    expect(() => t2.acc('411/50')).not.toThrow(); // the accounts set was saved before the failing set
    r = await t2.call('POST', '/exchange/xml/import', { fileName: 'a.xml', text: writeTransferXml(data) });
    expect(r.status, r.text).toBe(200);
    expect(r.body.accounts).toBe(0);
  });

  it('imports a protocol without VAT (call-off stock, 04a 3.7 step 8) and exports it back', async () => {
    const data: TransferData = {
      accountings: [{
        accountingDate: '2026-06-10', vies: 5, vatTerm: 1, term: 'Изпращане към склад', document: { documentType: 1, number: '0000000610', date: '2026-06-10' },
        company: { name: 'Склад ЕС ГмбХ', vatNumber: 'DE123456789', bankAccounts: [], companyAccounts: [] },
        details: [{ accountNumber: '602', amount: '50.00', direction: 'Debit', vatTerm: 1 }, { accountNumber: '401', amount: '50.00', direction: 'Credit', vatTerm: 1 }],
        ica: { icaType: 6, vatAmount: '0.00', icaType163a: 41, term: 'Складове на изискване', document: { documentType: 13, number: '', date: '2026-06-10' } },
      }],
    };
    const r = await t2.call('POST', '/exchange/xml/import', { fileName: 'ica.xml', text: writeTransferXml(data) });
    expect(r.status, r.text).toBe(200);
    const d = await t.driver.company(t2.database);
    const rows = await queryRows<{ ica_type: number; dr: string; code: string | null; number: string }>(d, sql`
      SELECT p.ica_type, (SELECT sum(x.amount)::numeric(19,2)::text FROM accounting_details x WHERE x.accounting_id = p.id) AS dr,
        (SELECT e.vat_diary_code FROM accounting_extended_details e WHERE e.accounting_id = p.id LIMIT 1) AS code, doc.number
      FROM accountings a JOIN accountings p ON p.id = a.ica_accounting_id LEFT JOIN documents doc ON doc.id = p.document_id
      WHERE a.accounting_date = '2026-06-10'`);
    expect(rows.map((x) => [x.ica_type, x.dr, x.code])).toEqual([[6, '0.00', '41']]);
    expect(rows[0]!.number).not.toBe('');
    const exp = await raw(t2, 'POST', '/exchange/xml/export', { from: '2026-06-10', to: '2026-06-10' });
    expect(exp.status).toBe(200);
    const back = parseTransferXml(new TextDecoder().decode(exp.bytes));
    expect(back.accountings!.map((a) => [a.details.map((x) => [x.accountNumber, x.amount, x.direction]), a.ica?.icaType, a.ica?.vatAmount, a.ica?.icaType163a])).toEqual([
      [[['602', '50.00', 'Debit'], ['401', '50.00', 'Credit']], 6, '0.00', 41],
    ]);
  });

  it('reports an empty export', async () => {
    const r = await t.call('POST', '/exchange/xml/export', { from: '2026-12-30', to: '2026-12-31' });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strExportHaveNoAccountingsForSelectedCriteria']);
  });
});

// ---------------------------------------------------------------------------

describe('Excel import (04a 5)', () => {
  const opsMapping = { sheetName: 'Данни', startingRow: 2, endingRow: 100, columns: { Accounts: 'A', Sums: 'B', Date: 'C', Partner: 'D', PartnerBulstat: 'E', PartnerVatNumber: 'F', PartnerIBAN: 'G', DocumentNumber: 'H', DocumentType: 'I', DocumentDate: 'J', Term: 'K', Reference: 'L', OptionalReference: 'M', VATOperation: 'N', VIES: 'O', VIESMonth: 'P' } };

  it('imports operations with a VAT side and a partner', async () => {
    const content = await xlsx([
      ['Сметки', 'Суми', 'Дата', 'Партньор', 'ЕИК', 'ДДС', 'IBAN', 'Номер', 'Тип', 'Дата док.', 'Основание', 'Забележка', '', 'Вид сделка', 'VIES', ''],
      ['602%-401', '120.00', '20.07.2026', 'Excel Доставчик ООД', '141414141', '', 'BG80BNBG96611020345678', '0000000901', 'Ф-ра', '20.07.2026', 'Покупка услуги', 'бел.', '', '2-Получени доставки', '1-Не участва', ''],
      ['501-411', '30', '21.07.2026', 'Excel Доставчик ООД', '141414141', '', '', '', '', '', '', '', '', '1-Вътрешен оборот', '', ''],
    ]);
    const r = await call('POST', '/exchange/excel/import', { fileName: 'ops.xlsx', contentBase64: content, entity: 'operations', mapping: opsMapping });
    expect(r.status, r.text).toBe(200);
    expect(r.body.created).toBe(2);
    const tb = await balances(t, '2026-07-20', '2026-07-21');
    expect(tb['602']!.dt).toBe('100.00');
    expect(tb['453/1']!.dt).toBe('20.00');
    expect(tb['401']!.ct).toBe('120.00');
    expect(tb['501']!.dt).toBe('30.00');
    const saved = (await call('GET', '/exchange/excel/entities')).body.find((e: { entity: string }) => e.entity === 'operations');
    expect(saved.mapping.columns.Accounts).toBe('A');
  });

  it('protocols without VAT are imported: bread (type 8, code 07) and call-off stock (type 6) (04a 5.3)', async () => {
    const content = await xlsx([
      ['h'],
      ['602-401', '80', '23.07.2026', 'Хляб ЕООД', '161616161', '', '', '0000000911', 'Ф-ра', '23.07.2026', 'Хляб', '', '', '3-без ДК', '', '', '8-ВОП хляб', '7-Хляб'],
      ['602-401', '60', '23.07.2026', 'Хляб ЕООД', '161616161', '', '', '0000000912', 'Ф-ра', '23.07.2026', 'Склад', '', '', '3-без ДК', '', '', '6-Режим складиране', ''],
    ]);
    const mapping = { ...opsMapping, hasIcaColumns: true, columns: { ...opsMapping.columns, OperationType: 'Q', OperationGoodType: 'R' } };
    const r = await call('POST', '/exchange/excel/import', { fileName: 'ica.xlsx', contentBase64: content, entity: 'operations', mapping });
    expect(r.status, r.text).toBe(200);
    const rows = await queryRows<{ doc: string; ica_type: number; dr: string; code: string | null; term: string | null }>(await t.driver.company(t.companyDb), sql`
      SELECT md.number AS doc, p.ica_type, (SELECT sum(x.amount)::numeric(19,2)::text FROM accounting_details x WHERE x.accounting_id = p.id) AS dr,
        (SELECT e.vat_diary_code FROM accounting_extended_details e WHERE e.accounting_id = p.id LIMIT 1) AS code, tm.description AS term
      FROM accountings a JOIN documents md ON md.id = a.document_id JOIN accountings p ON p.id = a.ica_accounting_id LEFT JOIN terms tm ON tm.id = p.term_id
      WHERE md.number IN ('0000000911', '0000000912') ORDER BY md.number`);
    expect(rows.map((x) => [x.doc, x.ica_type, x.dr, x.code])).toEqual([['0000000911', 8, '0.00', '07'], ['0000000912', 6, '0.00', '00']]);
    expect(rows[0]!.term).toBe('Самоначисляване на ДДС при доставка на хляб');
  });

  it('the protocol number from the channel skips a number typed by hand', async () => {
    const d = await t.driver.company(t.companyDb);
    const yearId = ((await call('GET', '/years')).body as { id: number; year: number }[]).find((y) => y.year === 2026)!.id;
    const next = await peekNextNumber(d, CHANNEL.VatProtocol, yearId);
    await t.post({ date: '2026-07-24', docType: DOCUMENT_TYPE.VatProtocol, docNumber: next, dr: [['602', 1]], cr: [['401', 1]], partner: await t.partner('Ръчен протокол ООД', ['401']) });
    const content = await xlsx([['h'], ['602-401', '10', '24.07.2026', 'Хляб ЕООД', '161616161', '', '', '0000000913', 'Ф-ра', '24.07.2026', 'Хляб', '', '', '3-без ДК', '', '', '8-ВОП хляб', '7-Хляб']]);
    const r = await call('POST', '/exchange/excel/import', { fileName: 'ica.xlsx', contentBase64: content, entity: 'operations', mapping: { ...opsMapping, hasIcaColumns: true, columns: { ...opsMapping.columns, OperationType: 'Q', OperationGoodType: 'R' } } });
    expect(r.status, r.text).toBe(200);
    const [row] = await queryRows<{ number: string }>(d, sql`
      SELECT pd.number FROM accountings a JOIN documents md ON md.id = a.document_id JOIN accountings p ON p.id = a.ica_accounting_id JOIN documents pd ON pd.id = p.document_id
      WHERE md.number = '0000000913'`);
    expect(row!.number).not.toBe(next);
    expect(Number(row!.number)).toBe(Number(next) + 1);
  });

  it('one bad row: nothing is saved; mapping errors block', async () => {
    const before = await entryCount(t);
    const content = await xlsx([['h'], ['602-401', '10', '22.07.2026', 'П', '', '', '', '', '', '', 'x'], ['602-401', '10;20', '22.07.2026', 'П', '', '', '', '', '', '', 'x']]);
    let r = await call('POST', '/exchange/excel/import', { fileName: 'ops.xlsx', contentBase64: content, entity: 'operations', mapping: opsMapping });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strInvalidAccountingSumsInExcel']);
    expect(await entryCount(t)).toBe(before);
    r = await call('POST', '/exchange/excel/import', { fileName: 'ops.xlsx', contentBase64: content, entity: 'operations', mapping: { ...opsMapping, startingRow: 70000 } });
    expect(keys(r)).toContain('strInvalidColumnSetting');
    r = await call('POST', '/exchange/excel/import', { fileName: 'ops.xlsx', contentBase64: content, entity: 'operations', mapping: { ...opsMapping, columns: { ...opsMapping.columns, Term: '' } } });
    expect(keys(r)).toEqual(['strEmptyColumnSetting']);
    const purchaseNoTerm = await xlsx([['h'], ['602-401', '10', '22.07.2026', 'П', '', '', '', '', '', '', '', '', '', '2-покупка']]);
    r = await call('POST', '/exchange/excel/import', { fileName: 'ops.xlsx', contentBase64: purchaseNoTerm, entity: 'operations', mapping: opsMapping });
    expect(keys(r)).toEqual(['strInvalidTermInRowField']);
  });

  it('partners, chart and initial balances', async () => {
    const partners = await xlsx([['Име', 'Лице', 'Град', 'Адрес', 'Тел', 'ДДС', 'ЕИК', 'IBAN', 'Сметки'], ['Excel Партньор 1', 'Мария', 'Варна', 'ул. 2', '052', 'BG151515151', '151515151', '', '411;401']]);
    let r = await call('POST', '/exchange/excel/import', { fileName: 'p.xlsx', contentBase64: partners, entity: 'partners', mapping: { sheetName: 'Данни', startingRow: 2, endingRow: 10, columns: { CompanyName: 'A', ContactName: 'B', City: 'C', Address: 'D', Phone: 'E', VATNumber: 'F', Bulstat: 'G', IBAN: 'H', CompanyAccounts: 'I' } } });
    expect(r.status, r.text).toBe(200);
    expect(r.body.created).toBe(1);
    const bad = await xlsx([['h'], ['Excel Партньор 2', '', '', '', '', '', '', '', '702']]);
    r = await call('POST', '/exchange/excel/import', { fileName: 'p.xlsx', contentBase64: bad, entity: 'partners', mapping: { sheetName: 'Данни', startingRow: 2, endingRow: 10, columns: { CompanyName: 'A', ContactName: 'B', City: 'C', Address: 'D', Phone: 'E', VATNumber: 'F', Bulstat: 'G', IBAN: 'H', CompanyAccounts: 'I' } } });
    expect(keys(r)).toEqual(['strInvalidCompanyAccountCategory']);

    const chartMap = { sheetName: 'Данни', startingRow: 2, endingRow: 10, columns: { Number: 'A', Description: 'B', EnglishDescription: 'C', Currency: 'D', Category: 'E', Character: 'F' } };
    r = await call('POST', '/exchange/excel/import', { fileName: 'c.xlsx', contentBase64: await xlsx([['h'], ['413/9', 'Клиенти Excel', 'Customers', 'EUR', '10-Клиенти', '1-Активна']]), entity: 'chart', mapping: chartMap });
    expect(r.status, r.text).toBe(200);
    r = await call('POST', '/exchange/excel/import', { fileName: 'c.xlsx', contentBase64: await xlsx([['h'], ['413/9', 'Дубликат', '', 'EUR', '', '']]), entity: 'chart', mapping: chartMap });
    expect(keys(r)).toEqual(['strNotUniqueAccountNumberInExcel']);
    r = await call('POST', '/exchange/excel/import', { fileName: 'c.xlsx', contentBase64: await xlsx([['h'], ['988/9', 'Без родител', '', 'EUR', '', '']]), entity: 'chart', mapping: chartMap });
    expect(keys(r)).toEqual(['strAccountParentNotFound']);
    await t.reloadAccounts();
    expect(acc('413/9')).toBeGreaterThan(0);

    const ibMap = { sheetName: 'Данни', startingRow: 2, endingRow: 10, columns: { AccountNumber: 'A', Balance: 'B', CurrencyBalance: 'C', ExchangeRate: 'D', Quantity: 'E', SalePrice: 'F', Direction: 'G', CompanyName: 'H', DocumentNumber: 'I', DocumentType: 'J', DocumentDate: 'K', FinancialYear: 'L' } };
    r = await call('POST', '/exchange/excel/import', { fileName: 'ib.xlsx', contentBase64: await xlsx([['h'], ['101', '500', '', '', '', '', 'КТ', '', '', '', '', '2026'], ['503', '500', '', '', '', '', 'Дт', '', '', '', '', '2026']]), entity: 'initialBalances', mapping: ibMap });
    expect(r.status, r.text).toBe(200);
    const tb = await balances(t, '2026-01-01', '2026-12-31');
    expect(tb['101']!.oc).toBe('500.00');
    r = await call('POST', '/exchange/excel/import', { fileName: 'ib.xlsx', contentBase64: await xlsx([['h'], ['101', '1', '', '', '', '', 'x', '', '', '', '', '2026']]), entity: 'initialBalances', mapping: ibMap });
    expect(keys(r)).toEqual(['strInvalidDataFormatInExcelCell']);
  });

  it('conflict mode: Error leaves a matched partner as it is (only accounts are added), Update overwrites it (5.2, 3.6)', async () => {
    const pMap = (conflictMode?: string) => ({ sheetName: 'Данни', startingRow: 2, endingRow: 10, conflictMode, columns: { CompanyName: 'A', ContactName: 'B', City: 'C', Address: 'D', Phone: 'E', VATNumber: 'F', Bulstat: 'G', IBAN: 'H', CompanyAccounts: 'I' } });
    const imp = async (row: string[], conflictMode?: string) => {
      const r = await call('POST', '/exchange/excel/import', { fileName: 'p.xlsx', contentBase64: await xlsx([['h'], row]), entity: 'partners', mapping: pMap(conflictMode) });
      expect(r.status, r.text).toBe(200);
      return r.body as { created: number; updated: number };
    };
    expect(await imp(['Конфликт ООД', 'Иван', 'Русе', 'ул. 1', '082', '', '171819202', '', '411'])).toMatchObject({ created: 1, updated: 0 });
    const id = ((await call('GET', '/partners?q=Конфликт')).body as { id: number; name: string }[] | { rows: { id: number; name: string }[] });
    const pid = (Array.isArray(id) ? id : id.rows).find((x) => x.name === 'Конфликт ООД')!.id;
    // Error (default): matched by Bulstat; name, contact, address and IBAN stay; the new partner account is added.
    expect(await imp(['Конфликт Ново ООД', 'Петър', 'Плевен', 'ул. 2', '064', '', '171819202', 'BG80BNBG96611020345678', '401'], 'error')).toMatchObject({ created: 0, updated: 0 });
    let p = (await call('GET', `/partners/${pid}`)).body;
    expect([p.name, p.contactName, p.addresses.map((a: { city: string }) => a.city), p.bankAccounts.length]).toEqual(['Конфликт ООД', 'Иван', ['Русе'], 0]);
    expect(p.accounts.map((a: { number: string }) => a.number).sort()).toEqual(['401', '411']);
    // Update: the record's fields overwrite the partner and its IBAN is added.
    expect(await imp(['Конфликт Ново ООД', 'Петър', 'Плевен', 'ул. 2', '064', '', '171819202', 'BG80BNBG96611020345678', ''], 'update')).toMatchObject({ created: 0, updated: 1 });
    p = (await call('GET', `/partners/${pid}`)).body;
    expect([p.name, p.contactName, p.addresses.map((a: { city: string }) => a.city), p.bankAccounts.map((b: { account: string }) => b.account)]).toEqual(['Конфликт Ново ООД', 'Петър', ['Плевен'], ['BG80BNBG96611020345678']]);

    // Chart: Error refuses an existing number, Update renames it; the currency of an existing account cannot change.
    const chartMap = (conflictMode?: string) => ({ sheetName: 'Данни', startingRow: 2, endingRow: 10, conflictMode, columns: { Number: 'A', Description: 'B', EnglishDescription: 'C', Currency: 'D', Category: 'E', Character: 'F' } });
    const chart = async (row: string[], conflictMode?: string) => call('POST', '/exchange/excel/import', { fileName: 'c.xlsx', contentBase64: await xlsx([['h'], row]), entity: 'chart', mapping: chartMap(conflictMode) });
    expect((await chart(['413/7', 'Клиенти 7', '', 'EUR', '', ''])).status).toBe(200);
    expect(keys(await chart(['413/7', 'Клиенти седем', '', '', '', ''], 'error'))).toEqual(['strNotUniqueAccountNumberInExcel']);
    const upd = await chart(['413/7', 'Клиенти седем', 'Customers 7', '', '', '2-Пасивна'], 'update');
    expect(upd.body).toMatchObject({ created: 0, updated: 1 });
    expect(keys(await chart(['413/7', 'Клиенти седем', '', 'USD', '', ''], 'update'))).toEqual(['strInvalidDataFormatInExcelCell']);
    await t.reloadAccounts();
    const a = ((await call('GET', '/accounts')).body as { id: number; number: string; description: string; isActive: boolean | null }[]).find((x) => x.number === '413/7')!;
    expect([a.description, a.isActive]).toEqual(['Клиенти седем', false]);
  });

  it('inspects a workbook with a setup sheet and builds a template', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Данни').addRow(['a']);
    const setup = wb.addWorksheet('Настройка Операции');
    setup.addRow(['Sheet с данни', 'Данни']);
    setup.addRow(['Начален ред', 2]);
    setup.addRow(['Колона за сметки', 'a']);
    const content = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    const r = await call('POST', '/exchange/excel/inspect', { fileName: 'x.xlsx', contentBase64: content, entity: 'operations' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.sheets.map((s: { name: string }) => s.name)).toEqual(['Данни', 'Настройка Операции']);
    expect(r.body.setup).toMatchObject({ sheetName: 'Данни', startingRow: 2, columns: { Accounts: 'A' } });
    const tpl = await raw(t, 'POST', '/exchange/excel/template', { entity: 'operations', mapping: opsMapping });
    expect(tpl.status).toBe(200);
    expect(tpl.bytes[0]).toBe(0x50);
  });
});

// ---------------------------------------------------------------------------

describe('ТРЗ Pro import (04a 6)', () => {
  const feed = ['Month;Code;Name;ZaplTrudoviIDUK;DanukPoZDDFLTDiDUK;DtZaplTrudoviIDUK;KtZaplTrudoviIDUK;DtDanukPoZDDFLTDiDUK;KtDanukPoZDDFLTDiDUK',
    '08.2026;001;Администрация;10000;1000;604/1;421;421;454', '08.2026;001001;Офис;2000;200;604/1;421;421;454'].join('\n');

  it('defines missing accounts, previews and imports a month once', async () => {
    let r = await call('GET', '/exchange/trz/accounts');
    expect(r.status).toBe(200);
    if (r.body.missing.length) {
      r = await call('POST', '/exchange/trz/accounts');
      expect(r.status, r.text).toBe(200);
      expect(r.body.message).toBe('Сметките са дефинирани успешно.');
    }
    expect((await call('GET', '/exchange/trz/accounts')).body.missing).toEqual([]);
    const p = await call('POST', '/exchange/trz/preview', { fileName: 'trz.csv', text: feed, level: 0 });
    expect(p.status, p.text).toBe(200);
    expect(p.body).toMatchObject({ months: ['2026-08'], month: '2026-08', accountingDate: '2026-08-31', term: 'Заплати за м. 08.2026' });
    const rows = (p.body.grid as { itemId: number; itemName: string; amount: string; debit: string; credit: string }[]);
    expect(rows.find((x) => x.itemId === 10100)!.amount).toBe('12000.00');
    const body = { month: '2026-08', accountingDate: '2026-08-31', term: p.body.term, documentTypeId: 10, rows };
    const bad = await call('POST', '/exchange/trz/import', { ...body, accountingDate: '2026-07-31' });
    expect(keys(bad)).toEqual(['strImportTrzProIncorrectAccountingDate']);
    const sub = await call('POST', '/exchange/trz/import', { ...body, rows: rows.map((x) => (x.itemId === 10100 ? { ...x, debit: '604' } : x)) });
    expect(keys(sub)).toEqual(['strTrzProOperationsImportCantImportData', 'strSelectedAccountHasSubaccountsWithParam']);
    r = await call('POST', '/exchange/trz/import', body);
    expect(r.status, r.text).toBe(200);
    expect(r.body.accountings).toBe(2);
    expect(r.body.message).toBe('Данните за м. 08.2026 са импортирани успешно.');
    const tb = await balances(t, '2026-08-31', '2026-08-31');
    expect(tb['604/1']!.dt).toBe('12000.00');
    expect(tb['454']!.ct).toBe('1200.00');
    r = await call('POST', '/exchange/trz/import', body);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('strTrzProOperationsImportIsImportedPeriod');
    r = await call('POST', '/exchange/trz/import', { ...body, confirmReimport: true });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('bank statements (04b 1, 03a 9)', { timeout: 30_000 }, () => {
  const OWN_IBAN = 'BG80STSA93000012345678';
  const PARTNER_IBAN = 'BG11UNCR70001512345678';
  let bankAccountId: number;
  let bankId: number;
  let partnerId: number;

  beforeAll(async () => {
    const my = (await call('GET', '/my-company')).body;
    const banks = (await call('GET', '/banks')).body as { id: number; code: string }[];
    bankId = banks.find((b) => b.code === 'STSABGSF')!.id;
    const r = await call('PUT', '/my-company', { ...my, addresses: [], bankAccounts: [{ account: OWN_IBAN, bankId, bankStatementAccountId: acc('503'), isEuro: true }] });
    expect(r.status, r.text).toBe(200);
    bankAccountId = (await call('GET', '/bank-statements/accounts')).body[0].id;
    partnerId = await t.partner('Банков Клиент ООД', ['411'], { bulstat: '161616161', bankAccounts: [{ account: PARTNER_IBAN }] });
  });

  it('template editor validation and CRUD', async () => {
    let r = await call('POST', '/bank-templates/defaults', { bankId });
    expect(r.body.added).toBe(16);
    r = await call('POST', '/bank-templates', { bankId, name: '', formula: 'Reason', debitAccountId: null });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strMissingTemplateName', 'strMissingCondition', 'strMissingValidDebitOrCreditAccount']);
    r = await call('POST', '/bank-templates', { bankId, name: 'Наем', formula: 'Reason съдържа "наем"', debitAccountId: acc('602'), termText: 'наем', priority: 3 });
    expect(r.status, r.text).toBe(201);
    const id = r.body.id;
    r = await call('POST', `/bank-templates/${id}/copy`);
    expect(r.status).toBe(201);
    let list = (await call('GET', `/bank-templates?bankId=${bankId}`)).body as { id: number; name: string; debitAccountNumber: string; priority: number }[];
    expect(list.find((x) => x.id === id)).toMatchObject({ name: 'Наем', debitAccountNumber: '602', priority: 3 });
    expect(list.some((x) => x.name === 'Копие на Наем')).toBe(true);
    await call('DELETE', `/bank-templates/${r.body.id}`);
    r = await call('POST', '/bank-templates/defaults', { bankId });
    expect(r.body.added).toBe(0); // the bank already has templates
    list = (await call('GET', `/bank-templates?bankId=${bankId}`)).body;
    expect(list.filter((x) => x.name.startsWith('Копие'))).toHaveLength(0);
  });

  it('imports an MT940 statement and posts rows by the rules', async () => {
    const mt = [
      ':20:STMT1', `:25:${OWN_IBAN}`, ':28C:1/1', ':60F:C260901EUR1000,00',
      ':61:2609020902C150,50NTRFREF1//B1', `:86:Плащане по ф-ра 0000000501 ${PARTNER_IBAN}`,
      ':61:2609030903D20,00NCHGREF2', ':86:Такса за превод',
      ':61:2609040904D300,00NTRFREF3', ':86:Наем за септември',
      ':61:2609050905D1,00NTRFREF4', ':86:Нещо непознато',
      ':62F:C260905EUR829,50', '-',
    ].join('\r\n');
    const p = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: mt, bankAccountId });
    expect(p.status, p.text).toBe(200);
    expect(p.body.header).toContain(OWN_IBAN);
    const rows = p.body.rows as { index: number; templateName: string; debitAccountId: number | null; creditAccountId: number | null; companyId: number | null; term: string; postAmount: string; date: string; warnings: string[]; documents: { accountingId: number; selected: boolean }[] }[];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ debitAccountId: acc('503'), creditAccountId: acc('411'), companyId: partnerId, postAmount: '150.50' });
    expect(rows[1]!.debitAccountId).toBe(acc('629'));
    expect(rows[2]).toMatchObject({ templateName: 'Наем', debitAccountId: acc('602'), term: 'наем' });
    expect(rows[3]!.warnings).toEqual(['strNoBankTemplateWarning']);
    // Invalid rows are reported, valid ones posted.
    const before = await entryCount(t);
    const post = await call('POST', '/bank-statements/post', { rows: rows.map((r) => ({ ...r, documents: r.documents.filter((x) => x.selected).map((x) => x.accountingId) })), customDocumentNumber: '77' });
    expect(post.status, post.text).toBe(200);
    expect(post.body.posted, JSON.stringify(post.body.results)).toBe(3);
    expect(post.body.results[3].messages.map((m: { key: string }) => m.key)).toEqual(['strMissingValidDebitAccount']);
    expect(await entryCount(t)).toBe(before + 3);
    const tb = await balances(t, '2026-09-02', '2026-09-05');
    expect(tb['503']).toMatchObject({ dt: '150.50', ct: '320.00' });
    expect(tb['602']!.dt).toBe('300.00');
  });

  it('rejects a file of another year and a file without rows', async () => {
    const mt = [':20:S', `:25:${OWN_IBAN}`, ':60F:C250901EUR0,00', ':61:2509020902C1,00NTRF', ':86:x', ':62F:C250902EUR1,00'].join('\n');
    let r = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: mt, bankAccountId });
    expect(keys(r)).toEqual(['strBankStatementDatesInDifferentYear']);
    r = await call('POST', '/bank-statements/parse', { fileName: 'st.txt', text: 'nothing here', bankAccountId });
    expect(keys(r)).toEqual(['strWrongFileOrBrokenStructures']);
  });

  it('keywords are seeded and editable', async () => {
    const k = (await call('GET', '/bank-statements/keywords')).body as { id: number; word: string }[];
    expect(k.map((x) => x.word)).toContain('ф-ра');
    const add = await call('POST', '/bank-statements/keywords', { word: ' сметка ' });
    expect(add.body.word).toBe('сметка');
    await call('DELETE', `/bank-statements/keywords/${add.body.id}`);
    expect((await call('GET', '/bank-statements/keywords')).body).toHaveLength(k.length);
  });
});

// ---------------------------------------------------------------------------

describe('backup, restore, delete company (01b 2)', { timeout: 60_000 }, () => {
  it('backup -> restore as a new company gives identical data', async () => {
    const b = await call('POST', '/backups');
    expect(b.status, b.text).toBe(201);
    expect(b.body.fileName).toMatch(/^Shmelta Pro - Тест ООД - \d{2}\.\d{2}\.\d{4}_\d{2}\.\d{2}\.shbak$/);
    const file = await raw(t, 'GET', `/backups/${b.body.id}/download`);
    expect(file.status).toBe(200);
    const original = await balances(t, '2026-01-01', '2026-12-31');
    const count = await entryCount(t);
    const home = t.session.get();
    const r = await call('POST', '/backups/restore', { fileName: b.body.fileName, contentBase64: Buffer.from(file.bytes).toString('base64'), mode: 'new' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.asNew).toBe(true);
    expect(r.body.database).not.toBe(t.companyDb);
    expect((await call('GET', '/session')).status).toBe(200);
    expect(await balances(t, '2026-01-01', '2026-12-31')).toEqual(original);
    expect(await entryCount(t)).toBe(count);
    // Delete the restored copy from the original company.
    const restoredDb = r.body.database;
    t.session.set(home);
    let del = await call('POST', `/companies/${t.companyDb}/delete`, { userId: 1, password: 'secret1' });
    expect(del.status).toBe(400);
    expect(del.body.error).toBe('Не може да бъде изтрита фирмата, с която работите в момента.');
    del = await call('POST', `/companies/${restoredDb}/delete`, { userId: 1, password: 'wrong' });
    expect(del.status).toBe(401);
    del = await call('POST', `/companies/${restoredDb}/delete`, { userId: 1, password: 'secret1' });
    expect(del.status, del.text).toBe(200);
    expect((await call('GET', '/companies')).body.map((c: { name: string }) => c.name)).not.toContain(restoredDb);
    expect((await call('GET', '/backups')).body.length).toBeGreaterThanOrEqual(2); // automatic backup before deleting
  });

  it('restore into the current company replaces its data', async () => {
    const b = await call('POST', '/backups');
    const count = await entryCount(t);
    await t.post({ date: '2026-10-01', dr: [['503', '1']], cr: [['101', '1']] });
    expect(await entryCount(t)).toBe(count + 1);
    const r = await call('POST', '/backups/restore', { id: b.body.id, mode: 'current' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.message).toBe('Фирмата е възстановена успешно.');
    expect(await entryCount(t)).toBe(count);
  });

  it('restores a logical (Postgres-style) backup on PGlite', async () => {
    const db = await t.driver.company(t.companyDb);
    const payload = encodeLogicalDump(await logicalDump(db));
    const file = encodeBackup({ format: BACKUP_FORMAT_VERSION, product: 'Shmelta Pro', version: '1.01.089', companyName: 'Тест ООД', database: t.companyDb, createdAt: new Date().toISOString(), kind: 'logical-json' }, payload);
    const original = await balances(t, '2026-01-01', '2026-12-31');
    const home = t.session.get();
    const r = await call('POST', '/backups/restore', { fileName: 'x.shbak', contentBase64: Buffer.from(file).toString('base64'), mode: 'new' });
    expect(r.status, r.text).toBe(200);
    expect(await balances(t, '2026-01-01', '2026-12-31')).toEqual(original);
    // New ids continue after the restored rows.
    await t.post({ date: '2026-10-02', dr: [['503', '2']], cr: [['101', '2']] });
    t.session.set(home);
    expect((await call('POST', `/companies/${r.body.database}/delete`, { userId: 1, password: 'secret1' })).status).toBe(200);
  });

  it('refuses foreign files and newer versions', async () => {
    let r = await call('POST', '/backups/restore', { fileName: 'x.zip', text: 'PK not a backup', mode: 'new' });
    expect(keys(r)).toEqual(['strInvalidChoosenFilePathError']);
    const file = encodeBackup({ format: 1, product: 'Shmelta Pro', version: '9.99.999', companyName: 'X', database: 'x', createdAt: '', kind: 'logical-json' }, new Uint8Array([1]));
    r = await call('POST', '/backups/restore', { fileName: 'x.shbak', contentBase64: Buffer.from(file).toString('base64'), mode: 'new' });
    expect(keys(r)).toEqual(['strInconsistentDatabaseVersion']);
  });

  it('active company info', async () => {
    const r = await call('GET', '/company/active');
    expect(r.body.message).toBe('Фирмата с която работите в момента е Тест ООД, 831641791.');
  });
});

// ---------------------------------------------------------------------------

describe('euro conversion (04b 4)', { timeout: 60_000 }, () => {
  let e: Awaited<ReturnType<typeof sibling>>;
  beforeAll(async () => {
    e = await sibling('Евро ООД', 2025, '181818181');
  }, 60_000);
  afterAll(() => e.drop());

  it('needs both years', async () => {
    const r = await e.call('POST', '/euro-conversion', { differencesAccountId: 1 });
    expect(keys(r)).toEqual(['strEuroConversionNeedsYears']);
  });

  it('maps accounts, converts openings and is idempotent', async () => {
    const p = await e.partner('Евро Клиент', ['411'], { bulstat: '171717171' });
    await e.post({ date: '2025-03-01', dr: [['503', '1000']], cr: [['101', '1000']] });
    await e.post({ date: '2025-03-02', partner: p, dr: [['411', '100']], cr: [['702', '100']] });
    await e.post({ date: '2025-03-03', dr: [['503', '0.01']], cr: [['101', '0.01']] });
    expect((await e.call('POST', '/years', { year: 2026 })).status).toBe(201);
    const grid = await e.call('GET', '/euro-conversion');
    expect(grid.status, grid.text).toBe(200);
    const row503 = grid.body.rows.find((x: { number: string }) => x.number === '503');
    expect(row503.euroAccountNumber).toBe('503');
    const diff = grid.body.euroAccounts.find((x: { number: string }) => x.number === '123').id;
    let r = await e.call('POST', '/euro-conversion', { differencesAccountId: null });
    expect(keys(r)).toEqual(['strEuroConversionDifferenceAccountMissing']);
    r = await e.call('POST', '/euro-conversion', { differencesAccountId: diff, fixedAssets: true, backupFirst: true });
    expect(r.status, r.text).toBe(200);
    expect(r.body.report.fixedAssets).toBe(0);
    expect(r.body.backup.fileName).toContain('Евро ООД');
    expect((await e.call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
    const tb = await balances(e, '2026-01-01', '2026-12-31');
    expect(tb['503']!.od).toBe('511.30'); // 1000 -> 511.29 and 0.01 -> 0.01 as one balance: 1000.01 / 1.95583 = 511.30
    expect(tb['101']!.oc).toBe('511.30');
    expect(tb['411']!.od).toBe('51.13');
    expect(tb['702']!.oc).toBe('51.13');
    const again = await e.call('POST', '/euro-conversion', { differencesAccountId: diff });
    expect(again.status).toBe(200);
    expect(again.body.report.openings).toBeUndefined();
    expect(await balances(e, '2026-01-01', '2026-12-31')).toEqual(tb);
    // Partner accounts follow the euro chart.
    const partner = (await e.call('GET', `/partners/${p}`)).body;
    expect(partner.accounts.map((a: { number: string }) => a.number).filter((n: string) => n === '411')).toHaveLength(2);
  });

  it('converts fixed assets, templates and reschedules (04b 4)', async () => {
    const y = await sibling('Евро Модули ООД', 2025);
    try {
      const asset = await y.call('POST', '/assets', {
        inventoryNumber: 'E-1', name: 'Машина', personInCharge: 'Иван Петров', categoryId: 2, locationId: null, synchronized: false,
        inventoryAccountId: y.acc('203'), debitAccountId: y.acc('603'), creditAccountId: y.acc('241/2'),
        accounting: { depreciationAmount: '12000', nonDepreciableAmount: '0', acquisitionDate: '2025-03-15', startDate: '2025-03-15', calcType: 'period', activePeriodLength: 60, annualRate: null, conservation: null, note: '', serialNumber: '' },
        tax: { depreciationAmount: '12000', nonDepreciableAmount: '0', acquisitionDate: '2025-03-15', startDate: '2025-03-15', calcType: 'rate', activePeriodLength: 60, annualRate: '30', conservation: null, note: '', serialNumber: '' },
      });
      expect(asset.status, asset.text).toBe(201);
      const rent = await y.call('POST', '/templates', { name: 'Наем', debits: [{ accountId: y.acc('602'), amount: '500' }], credits: [{ accountId: y.acc('503'), amount: '500' }] });
      expect(rent.status, rent.text).toBe(201);
      // A template with a cash-in-base-currency account is skipped (04b 4 templates).
      expect((await y.call('POST', '/templates', { name: 'Каса', debits: [{ accountId: y.acc('501'), amount: '10' }], credits: [{ accountId: y.acc('702'), amount: '10' }] })).status).toBe(201);
      const card = await y.call('POST', '/reschedules', {
        name: 'Застраховка', amount: '1200', documentTypeId: 1, documentNumber: '1', documentDate: '2025-07-01',
        fromDate: '2025-07-01', toDate: '2026-06-30', isRescheduleByDays: false, debitAccountId: y.acc('609'), creditAccountId: y.acc('651'),
      });
      expect(card.status, card.text).toBe(201);

      expect((await y.call('POST', '/years', { year: 2026 })).status).toBe(201);
      const diff = (await y.call('GET', '/euro-conversion')).body.euroAccounts.find((x: { number: string }) => x.number === '123').id;
      const r = await y.call('POST', '/euro-conversion', { differencesAccountId: diff, fixedAssets: true, templates: true, reschedules: true });
      expect(r.status, r.text).toBe(200);
      expect(r.body.report).toMatchObject({ fixedAssets: 1, templates: '1 (пропуснати шаблони: 1)', reschedules: 1 });

      expect((await y.call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
      const templates = (await y.call('GET', '/templates')).body as { name: string; amount: string; debitAccounts: string }[];
      expect(templates.map((x) => [x.name, x.amount, x.debitAccounts])).toEqual([['Наем', '0.00', '602']]);
      // Six unprocessed 2026 months of 100 BGN: 600 / 1.95583 = 306.78 EUR from 2026-01-01.
      const cards = (await y.call('GET', '/reschedules')).body as { name: string; amount: string; fromDate: string; toDate: string }[];
      expect(cards.map((x) => [x.name, x.amount, x.fromDate, x.toDate])).toEqual([['Застраховка', '306.78', '2026-01-01', '2026-06-30']]);
      const assets = (await y.call('GET', '/assets')).body as { inventoryNumber: string }[] | { rows: { inventoryNumber: string }[] };
      expect((Array.isArray(assets) ? assets : assets.rows).map((a) => a.inventoryNumber)).toEqual(['E-1']);
      // A second run converts nothing twice.
      const again = await y.call('POST', '/euro-conversion', { differencesAccountId: diff, fixedAssets: true, templates: true, reschedules: true });
      expect(again.body.report).toMatchObject({ fixedAssets: 'вече конвертирани', templates: 'вече конвертирани', reschedules: 'вече конвертирани' });
    } finally {
      await y.drop();
    }
  });

  it('replaces the openings of an earlier year-end transfer instead of adding to them', async () => {
    const y = await sibling('Евро Прехвърляне ООД', 2025);
    try {
      await y.post({ date: '2025-03-01', dr: [['503', '1000']], cr: [['101', '1000']] });
      expect((await y.call('POST', '/years', { year: 2026 })).status).toBe(201);
      const y2025 = ((await y.call('GET', '/years')).body as { id: number; year: number }[]).find((x) => x.year === 2025)!.id;
      const diff = (await y.call('GET', '/euro-conversion')).body.euroAccounts.find((x: { number: string }) => x.number === '123').id;
      const closed = await y.call('POST', `/years/${y2025}/conclude`, { differencesAccountId: diff });
      expect(closed.status, closed.text).toBe(200);
      const converted = await y.call('POST', '/euro-conversion', { differencesAccountId: diff });
      expect(converted.status, converted.text).toBe(200);
      expect((await y.call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
      const tb = await balances(y, '2026-01-01', '2026-12-31');
      expect([tb['503']!.od, tb['101']!.oc]).toEqual(['511.29', '511.29']); // 1000 / 1.95583, once
    } finally {
      await y.drop();
    }
  });

  type Sib = Awaited<ReturnType<typeof sibling>>;
  const entry = async (y: Sib, e: { date: string; docType?: number; docNumber: string; partner?: number; dr: [string, string, Record<string, unknown>?][]; cr: [string, string, Record<string, unknown>?][] }) => {
    const r = await y.call('POST', '/entries', {
      accountingDate: e.date, documentDate: e.date, documentTypeId: e.docType ?? 1, documentNumber: e.docNumber, term: 'Тест', companyId: e.partner ?? null,
      debits: e.dr.map(([n, a, x]) => ({ accountId: y.acc(n), amount: a, ...x })), credits: e.cr.map(([n, a, x]) => ({ accountId: y.acc(n), amount: a, ...x })),
    });
    expect(r.status, r.text).toBe(201);
    return r.body.id as number;
  };
  /** 2026 opening legs: account, partner, document, money, currency detail. */
  const openingLegs = async (database: string) => queryRows<{ id: number; source: string; number: string; company_id: number | null; doc: string | null; dr: string; cr: string; iso: string | null; cur: string | null; rate: string | null; fixed: string | null }>(
    await t.driver.company(database), sql`
      SELECT a.id, a.source, ac.number, d.company_id, doc.number AS doc, d.amount::numeric(19,2)::text AS dr, d.ref_amount::numeric(19,2)::text AS cr,
        c.iso_code AS iso, d.currency_amount::numeric(19,2)::text AS cur, d.exchange_rate::text AS rate, d.fixed_rate::numeric(19,2)::text AS fixed
      FROM accountings a JOIN financial_years fy ON fy.id = a.financial_year_id JOIN accounting_details d ON d.accounting_id = a.id
        JOIN accounts ac ON ac.id = d.account_id LEFT JOIN documents doc ON doc.id = a.document_id LEFT JOIN currencies c ON c.id = d.currency_id
      WHERE fy.year = 2026 AND a.is_initial_balance AND (d.amount <> 0 OR d.ref_amount <> 0) ORDER BY ac.number, doc.number`);

  it('carries partner open items per document; BGN cash gets a BGN currency detail and is mapped by default (04b 4)', async () => {
    const y = await sibling('Евро Документи ООД', 2025);
    try {
      const cl = await y.partner('Клиент 2025', ['411']);
      await entry(y, { date: '2025-11-10', docNumber: 'F-77', partner: cl, dr: [['411', '1955.83']], cr: [['702', '1955.83']] });
      await entry(y, { date: '2025-12-01', docNumber: 'F-78', partner: cl, dr: [['411', '391.17']], cr: [['702', '391.17']] });
      await y.post({ date: '2025-12-02', dr: [['501', '1000']], cr: [['101', '1000']] });
      expect((await y.call('POST', '/years', { year: 2026 })).status).toBe(201);
      const diff = (await y.call('GET', '/euro-conversion')).body.euroAccounts.find((x: { number: string }) => x.number === '123').id;
      // No relations: the cash account is mapped to the EUR 501 instead of blocking.
      const r = await y.call('POST', '/euro-conversion', { differencesAccountId: diff });
      expect(r.status, r.text).toBe(200);
      const legs = await openingLegs(y.database);
      expect(legs.filter((l) => l.number === '411').map((l) => [l.company_id, l.doc, l.dr])).toEqual([[cl, 'F-77', '1000.00'], [cl, 'F-78', '200.00']]);
      expect(legs.filter((l) => l.number === '501').map((l) => [l.dr, l.iso, l.cur, l.fixed, l.rate])).toEqual([['511.29', 'BGN', '1000.00', '1.00', '0.511290']]);
      expect((await y.call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
      const d = await t.driver.company(y.database);
      const items = await openItems(d, { startDate: '2026-01-01', endDate: '2026-12-31' });
      expect(items.filter((i) => i.companyId === cl).map((i) => [i.documentNumber, i.isInitialBalance, i.open])).toEqual([['F-77', true, '1000.00'], ['F-78', true, '200.00']]);
    } finally {
      await y.drop();
    }
  });

  it('a 2026 payment bound to a year-end opening keeps its binding; foreign currency at the recalculated rate (04b 4 steps 2/9)', async () => {
    const y = await sibling('Евро Връзки ООД', 2025);
    try {
      const cl = await y.partner('Клиент Връзки', ['411']);
      expect((await y.call('POST', '/accounts', { parentId: y.acc('504'), description: 'Банка USD', accountCategoryId: 27, currencyId: 3 })).status).toBe(201);
      await y.reloadAccounts();
      const usd = ((await y.call('GET', '/accounts')).body as { number: string }[]).map((a) => a.number).find((n) => n.startsWith('504/'))!;
      await entry(y, { date: '2025-11-10', docNumber: 'F-91', partner: cl, dr: [['411', '1955.83']], cr: [['702', '1955.83']] });
      await entry(y, { date: '2025-11-11', docNumber: 'F-92', partner: cl, dr: [['411', '977.92']], cr: [['702', '977.92']] });
      // USD 100 000 at 1.80 BGN: EUR rate round(1.8 / 1.95583, 5) = 0.92033 -> 92 033.00 (not 180 000 / 1.95583 = 92 032.54).
      await entry(y, { date: '2025-12-01', docNumber: 'B-1', dr: [[usd, '180000', { currencyAmount: '100000' }]], cr: [['101', '180000']] });
      expect((await y.call('POST', '/years', { year: 2026 })).status).toBe(201);
      const years = (await y.call('GET', '/years')).body as { id: number; year: number }[];
      const diff = (await y.call('GET', '/euro-conversion')).body.euroAccounts.find((x: { number: string }) => x.number === '123').id;
      expect((await y.call('POST', `/years/${years.find((x) => x.year === 2025)!.id}/conclude`, { differencesAccountId: diff })).status).toBe(200);
      expect((await y.call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
      await y.reloadAccounts();
      const d = await t.driver.company(y.database);
      const before = await openingLegs(y.database);
      const f91 = before.find((l) => l.doc === 'F-91')!;
      const f92 = before.find((l) => l.doc === 'F-92')!;
      expect(f91.source).toBe('year-close');
      // A 2026 payment bound to the year-end opening of F-91, another one bound directly to the 2025 invoice F-92.
      const pay = await entry(y, { date: '2026-02-01', docType: 9, docNumber: 'P-1', partner: cl, dr: [['503', '400']], cr: [['411', '400']] });
      const pay2 = await entry(y, { date: '2026-02-02', docType: 9, docNumber: 'P-2', partner: cl, dr: [['503', '100']], cr: [['411', '100']] });
      const inv92 = (await queryRows<{ id: number }>(d, sql`SELECT a.id FROM accountings a JOIN documents doc ON doc.id = a.document_id WHERE doc.number = 'F-92' AND NOT a.is_initial_balance`))[0]!.id;
      await insertPaymentLinks(d, [
        { paymentAccountingId: pay, refAccountingId: f91.id, documentId: null, accountId: y.acc('411'), companyId: cl, amount: '400' },
        { paymentAccountingId: pay2, refAccountingId: inv92, documentId: null, accountId: y.acc('411'), companyId: cl, amount: '100' },
      ]);

      const r = await y.call('POST', '/euro-conversion', { differencesAccountId: diff });
      expect(r.status, r.text).toBe(200);
      const after = await openingLegs(y.database);
      const n91 = after.find((l) => l.doc === 'F-91')!;
      const n92 = after.find((l) => l.doc === 'F-92')!;
      expect([n91.source, n91.dr, n92.dr]).toEqual(['euro-conversion', '1000.00', '500.00']);
      expect(n91.id).not.toBe(f91.id);
      expect(after.filter((l) => l.number === usd).map((l) => [l.dr, l.iso, l.cur, l.rate])).toEqual([['92033.00', 'USD', '100000.00', '0.920330']]);
      // The binding follows the new opening: F-91 600 open, F-92 400 open (its 2025 link moved onto the opening).
      const links = await queryRows<{ payment_accounting_id: number; ref_accounting_id: number }>(d, sql`SELECT payment_accounting_id, ref_accounting_id FROM accounting_payment_details ORDER BY payment_accounting_id`);
      expect(links).toEqual([{ payment_accounting_id: pay, ref_accounting_id: n91.id }, { payment_accounting_id: pay2, ref_accounting_id: n92.id }]);
      const items = await openItems(d, { startDate: '2026-01-01', endDate: '2026-12-31' });
      expect(items.filter((i) => i.companyId === cl).map((i) => [i.documentNumber, i.open])).toEqual([['F-91', '600.00'], ['F-92', '400.00']]);
    } finally {
      await y.drop();
    }
  });
});

// ---------------------------------------------------------------------------

describe('report exports (04a 8.3)', () => {
  it('uploads a definition and runs it to CSV with a trailing separator', async () => {
    const def = `<ExportReport xmlns="http://schemas.microinvest.net/ExportReports" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
      <Name>Сметки</Name><Description>Списък сметки</Description>
      <Parameters><ExportReportParameter><Name>@prefix</Name><Title>Префикс</Title><Type>Text</Type></ExportReportParameter></Parameters>
      <Documents><ExportDocument i:type="CSVExportDocument"><Name>a</Name><FileNameFormat>accounts_{0}</FileNameFormat>
        <Query>select number, description from accounts where number like @prefix || '%' and is_euro order by number limit 2</Query><Separator>;</Separator></ExportDocument></Documents>
    </ExportReport>`;
    const up = await call('POST', '/exchange/report-exports', { fileName: 'accounts.xml', text: def });
    expect(up.status, up.text).toBe(201);
    let r = await call('POST', `/exchange/report-exports/${up.body.id}/run`, { parameters: {} });
    expect(keys(r)).toEqual(['strExportReportParameterNotFilled']);
    const out = await raw(t, 'POST', `/exchange/report-exports/${up.body.id}/run`, { parameters: { '@prefix': '41' } });
    expect(out.status).toBe(200);
    expect(out.headers.get('content-disposition')).toContain('accounts_41.csv');
    const text = new TextDecoder().decode(out.bytes);
    expect(text.split('\r\n')[0]).toMatch(/^41;.*;$/);
    const bad = await call('POST', '/exchange/report-exports', { fileName: 'x.xml', text: def.replace('select number', 'delete from accounts; select number') });
    expect(bad.status).toBe(201);
    r = await call('POST', `/exchange/report-exports/${bad.body.id}/run`, { parameters: { '@prefix': '4' } });
    expect(keys(r)).toEqual(['strCannotExecuteSQLQuery']);
  });

  it('needs Редакция > Администриране (UI_Edit_Administration_ReportExport, 06 1.3)', async () => {
    const list = (await call('GET', '/exchange/report-exports')).body as { id: number }[];
    const role = await call('POST', '/roles', { name: 'Без администриране' });
    expect(role.status, role.text).toBeLessThan(300);
    await call('PUT', `/roles/${role.body.id}/permissions`, { 31: false });
    const u = await call('POST', '/users', { name: 'Без експорт', password: 'secret1', roleId: role.body.id });
    expect(u.status, u.text).toBe(201);
    const adminId = (await call('GET', '/session')).body.user.id;
    expect((await call('POST', '/login', { companyDb: t.companyDb, userId: u.body.id, password: 'secret1' })).status).toBe(200);
    try {
      expect((await call('GET', '/exchange/report-exports')).status).toBe(403);
      expect((await call('POST', `/exchange/report-exports/${list[0]!.id}/run`, { parameters: { '@prefix': '4' } })).status).toBe(403);
      expect((await call('DELETE', `/exchange/report-exports/${list[0]!.id}`)).status).toBe(403);
      expect((await call('POST', '/exchange/report-exports', { fileName: 'y.xml', text: '<x/>' })).status).toBe(403);
    } finally {
      expect((await call('POST', '/login', { companyDb: t.companyDb, userId: adminId, password: 'secret1' })).status).toBe(200);
    }
    // With the permission but not an administrator: may run, may not add or remove definitions.
    const op = await call('POST', '/roles', { name: 'Оператор експорти' });
    const u2 = await call('POST', '/users', { name: 'Оператор експорти', password: 'secret1', roleId: op.body.id });
    expect(u2.status, u2.text).toBe(201);
    expect((await call('POST', '/login', { companyDb: t.companyDb, userId: u2.body.id, password: 'secret1' })).status).toBe(200);
    try {
      expect((await call('POST', `/exchange/report-exports/${list[0]!.id}/run`, { parameters: { '@prefix': '41' } })).status).toBe(200);
      expect((await call('POST', '/exchange/report-exports', { fileName: 'y.xml', text: '<x/>' })).status).toBe(403);
      expect((await call('DELETE', `/exchange/report-exports/${list[0]!.id}`)).status).toBe(403);
    } finally {
      expect((await call('POST', '/login', { companyDb: t.companyDb, userId: adminId, password: 'secret1' })).status).toBe(200);
    }
  });

  it('refuses queries on the users and other protected names', async () => {
    const def = (query: string) => `<ExportReport xmlns="http://schemas.microinvest.net/ExportReports" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
      <Name>Опасен</Name><Description>x</Description><Parameters/>
      <Documents><ExportDocument i:type="CSVExportDocument"><Name>a</Name><FileNameFormat>x</FileNameFormat><Query>${query}</Query><Separator>;</Separator></ExportDocument></Documents>
    </ExportReport>`;
    for (const q of ['select name, password_hash from users', 'select * from "Users"', 'select key, value from configuration', 'select pg_read_file(\'/etc/passwd\')', 'select usename, passwd from pg_shadow']) {
      const up = await call('POST', '/exchange/report-exports', { fileName: 'x.xml', text: def(q) });
      expect(up.status, up.text).toBe(201);
      const r = await call('POST', `/exchange/report-exports/${up.body.id}/run`, { parameters: {} });
      expect(r.status, q).toBe(422);
      expect(keys(r), q).toEqual(['strCannotExecuteSQLQuery', 'detail']);
      expect(r.text).not.toContain('scrypt');
      await call('DELETE', `/exchange/report-exports/${up.body.id}`);
    }
    // A literal that merely mentions the word is fine.
    const ok = await call('POST', '/exchange/report-exports', { fileName: 'x.xml', text: def("select 'users' as label from accounts limit 1") });
    expect((await raw(t, 'POST', `/exchange/report-exports/${ok.body.id}/run`, { parameters: {} })).status).toBe(200);
  });
});
