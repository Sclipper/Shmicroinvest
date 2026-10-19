import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { queryRows } from '../src/db/provider.ts';
import { DataImportError, type DeltaSource } from '@shmi/core';
import { readAppLog } from '../src/services/appLog.ts';
import { readDeltaMdb, runDeltaConversion } from '../src/services/exchange/deltaConversion.ts';
import { createTestCompany, type TestCompany } from './helpers.ts';
import { writeJet, type JetColumn, type JetTable } from './jetWriter.ts';

/**
 * "Импорт от Microinvest Делта" (04a 7). The legacy MAINACCT.MDB files are
 * built by a small Jet writer (test/jetWriter.ts) and read back by the
 * server through mdb-reader, so the whole path (file, mapping, save) runs.
 */

let t: TestCompany;
let call: TestCompany['call'];

beforeAll(async () => {
  t = await createTestCompany({ year: 2026 });
  call = t.call;
}, 60_000);
afterAll(() => t.close());

const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const upload = (bytes: Uint8Array, type = 'all', fileName = 'MAINACCT.MDB') => call('POST', '/exchange/delta/import', { fileName, contentBase64: b64(bytes), type });

/** A fresh company in the same server; the session switches to it. */
let companyNo = 0;
async function freshCompany(year = 2026) {
  const r = await call('POST', '/companies', { companyName: `Делта ${++companyNo}`, adminName: 'Администратор', adminPassword: 'secret1', year, bulstat: '175074752' });
  expect(r.status, r.text).toBe(201);
  return t.driver.company(r.body.name as string);
}
type Db = Awaited<ReturnType<typeof freshCompany>>;
const rows = <T = Record<string, unknown>>(db: Db, q: ReturnType<typeof sql>) => queryRows<T>(db, q);

// ---------------------------------------------------------------------------
// Fixture: a legacy Delta database

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const col = (name: string, type: JetColumn['type'], size?: number): JetColumn => ({ name, type, size });

const SYSTEM = [col('Company', 'text', 100), col('Bulstat', 'text', 13), col('Partner', 'text', 50), col('VatID', 'text', 15), col('City', 'text', 30), col('Phone', 'text', 30), col('Address', 'text', 60), col('Bank', 'text', 40), col('BankAcct', 'text', 30)];
const PRIZNACI = [col('PriznakID', 'long'), col('Name', 'text', 30), col('Type', 'integer')];
const ACCTS = [col('AcctID', 'long'), col('Acct', 'long'), col('SubAcct', 'long'), col('PriznakID', 'long'), col('Name', 'text', 50), col('IsValutna', 'boolean')];
const PART = [col('ID', 'long'), col('Partner', 'text', 40), col('Town', 'text', 30), col('Addr', 'text', 60), col('Company', 'text', 60), col('DanNo', 'text', 20), col('Bulstat', 'text', 13), col('Bank', 'text', 30), col('BanAcct', 'text', 30), col('BanCode', 'text', 12), col('Tel_Fax', 'text', 20), col('IsVeryUsed', 'byte')];
const YEAR = [
  col('KonID', 'long'), col('Kon', 'long'), col('Acct', 'long'), col('SubAcct', 'long'), col('PriznakID', 'long'), col('Date', 'datetime'), col('DocDate', 'datetime'),
  col('FakNo', 'text', 10), col('DocType', 'text', 8), col('Osnovanie', 'text', 40), col('Note', 'text', 30), col('IsPokupka', 'byte'), col('VIESCol', 'byte'), col('VIESDate', 'datetime'),
  col('OperType', 'byte'), col('IsKredit', 'byte'), col('Qtty', 'currency'), col('StartDebit', 'currency'), col('StartKredit', 'currency'), col('PartnerID', 'long'),
];

const ACCOUNTS = [
  [1, 411, 0, 0, 'Клиенти'], [2, 411, 1, 0, 'Клиенти в страната'], [3, 401, 0, 0, 'Доставчици'], [4, 501, 0, 0, 'Каса в лева'],
  [5, 702, 0, 0, 'Приходи от продажби на стоки'], [6, 453, 0, 0, 'Разчети по ДДС'], [7, 453, 1, 0, 'ДДС покупки'], [8, 453, 2, 0, 'ДДС продажби'],
  [9, 504, 0, 0, 'Сметки във валута'], [10, 504, 1, 0, 'Сметка в евро', true], [11, 304, 0, 7, 'Стоки - количества'], [12, 602, 0, 0, 'Разходи за външни услуги'],
  [13, 304, 0, 0, 'Стоки'],
] as const;

type YearRow = Record<string, unknown>;
const line = (konId: number, kon: number, acct: number, sub: number, isKredit: 1 | 2, qtty: number | string, extra: YearRow = {}): YearRow => ({
  KonID: konId, Kon: kon, Acct: acct, SubAcct: sub, PriznakID: 0, IsKredit: isKredit, Qtty: qtty, OperType: 0, IsPokupka: 0, VIESCol: 0, PartnerID: 0, ...extra,
});

const YEAR_2009: YearRow[] = [
  // 1: sale invoice to partner 1 (OperType 16 -> VAT term 7, IsPokupka 2 -> sale).
  ...[line(1, 1, 411, 1, 2, 120), line(1, 2, 702, 0, 1, -100), line(1, 3, 453, 2, 1, -20)].map((r) => ({
    ...r, Date: d(2009, 5, 20), DocDate: d(2009, 5, 19), FakNo: '0000000101', DocType: 'Ф-ра', Osnovanie: 'Продажба на стоки', Note: 'по договор',
    IsPokupka: 2, OperType: 16, PartnerID: r.Acct === 411 ? 1 : 0, VIESDate: d(2009, 6, 15),
  })),
  // 2: cash receipt without a number: the ПКО series gives it one.
  line(2, 1, 501, 0, 2, 120, { Date: d(2009, 5, 25), DocType: 'ПКО', Osnovanie: 'Плащане', PartnerID: 1 }),
  line(2, 2, 411, 1, 1, -120, { Date: d(2009, 5, 25), DocType: 'ПКО', Osnovanie: 'Плащане', PartnerID: 1 }),
  // 3: purchase without a partner (-> Служебен партньор) and an unknown document type (-> Протокол, number 0).
  line(3, 1, 602, 0, 2, 50, { Date: d(2009, 6, 1), DocType: 'XYZ', Osnovanie: 'Услуга', IsPokupka: 1, OperType: 12 }),
  line(3, 2, 453, 1, 2, 10, { Date: d(2009, 6, 1), DocType: 'XYZ', Osnovanie: 'Услуга', IsPokupka: 1, OperType: 12 }),
  line(3, 3, 401, 0, 1, -60, { Date: d(2009, 6, 1), DocType: 'XYZ', Osnovanie: 'Услуга', IsPokupka: 1, OperType: 12 }),
  // 4: quantity rows only (feature of Type 1): not converted.
  { ...line(4, 1, 304, 0, 2, 5), PriznakID: 7 },
  // Opening balances (KonID 0).
  { KonID: 0, Kon: 0, Acct: 501, SubAcct: 0, PriznakID: 0, StartDebit: 1000, StartKredit: 0 },
  { KonID: 0, Kon: 0, Acct: 411, SubAcct: 1, PriznakID: 0, StartDebit: 300, StartKredit: 0, PartnerID: 2, FakNo: '55', DocType: 'Ф-ра', DocDate: d(2008, 12, 10) },
  { KonID: 0, Kon: 0, Acct: 504, SubAcct: 1, PriznakID: 0, StartDebit: '195.58', StartKredit: 0 },
];

function deltaTables(over: { year2009?: YearRow[]; part?: YearRow[]; omit?: string[] } = {}): JetTable[] {
  const tables: JetTable[] = [
    { name: 'System', columns: SYSTEM, rows: [{ Company: 'Стара Делта ЕООД', Bulstat: '831641791', Partner: 'Иван Петров', VatID: 'BG831641791', City: 'Пловдив', Phone: '032 123456', Address: 'ул. Главна 5', Bank: 'Тестова банка', BankAcct: 'BG80BNBG96611020345678' }] },
    { name: 'Priznaci', columns: PRIZNACI, rows: [{ PriznakID: 0, Name: '', Type: 0 }, { PriznakID: 3, Name: 'Обект', Type: 0 }, { PriznakID: 7, Name: 'Количество', Type: 1 }] },
    { name: 'Accts', columns: ACCTS, rows: ACCOUNTS.map(([AcctID, Acct, SubAcct, PriznakID, Name, IsValutna]) => ({ AcctID, Acct, SubAcct, PriznakID, Name, IsValutna: !!IsValutna })) },
    {
      name: 'Part', columns: PART, rows: over.part ?? [
        { ID: 1, Company: 'Клиент АД', Partner: 'Мария Иванова', Bulstat: '200000001', DanNo: 'BG200000001', Town: 'София', Addr: 'бул. Витоша 1', Tel_Fax: '02 999', Bank: 'Обединена банка', BanAcct: 'BG11UBBS80021012345678', BanCode: 'UBBSBGSF', IsVeryUsed: 5 },
        { ID: 2, Company: 'Доставчик ООД', Partner: 'Петър', Bulstat: '999999999', DanNo: '', Town: 'Варна', IsVeryUsed: 0 },
        { ID: 3, Company: 'Клиент АД - стар запис', Bulstat: '200000001', IsVeryUsed: 0 },
      ],
    },
    { name: 'Year2007', columns: YEAR, rows: [line(1, 1, 501, 0, 2, 10, { Date: d(2007, 3, 1) }), line(1, 2, 411, 1, 1, -10, { Date: d(2007, 3, 1), PartnerID: 1 })] },
    { name: 'Year2009', columns: YEAR, rows: over.year2009 ?? YEAR_2009 },
    { name: 'Year2026', columns: YEAR, rows: [line(1, 1, 501, 0, 2, 10, { Date: d(2026, 3, 1) }), line(1, 2, 702, 0, 1, -10, { Date: d(2026, 3, 1) })] },
  ];
  return tables.filter((x) => !over.omit?.includes(x.name));
}

// ---------------------------------------------------------------------------

describe('Delta conversion: wizard data and file errors', () => {
  it('lists the import types, the warning and no blockers for an empty company', async () => {
    const r = await call('GET', '/exchange/delta');
    expect(r.status, r.text).toBe(200);
    expect(r.body.types.map((x: { label: string }) => x.label)).toEqual(['Партньори', 'Сметкоплан и партньори', 'Операции, сметкоплан и партньори']);
    expect(r.body.warning).toContain('след 31.12.2007г.');
    expect(r.body.defaultFile).toBe('C:\\MICRO\\MAINACCT.MDB');
    expect(r.body.blockers).toEqual({ partners: [], chartAndPartners: [], all: [] });
  });

  it('refuses a file that is not an Access database (strErrorMDBUnrecognizedDatabaseFormat)', async () => {
    const r = await upload(new TextEncoder().encode('Това не е база данни на Access.\n'.repeat(200)), 'all', 'notes.mdb');
    expect(r.status, r.text).toBe(422);
    expect(keys(r)).toEqual(['strErrorMDBUnrecognizedDatabaseFormat']);
    expect(r.body.error ?? r.body.message).toContain('Некоректен файлов формат!');
    const junk = new Uint8Array(4096);
    junk.set(new TextEncoder().encode('Standard Jet DB'), 4);
    junk[0x14] = 0x09;
    expect(keys(await upload(junk))).toEqual(['strErrorMDBUnrecognizedDatabaseFormat']);
    expect(keys(await upload(new Uint8Array(0)))).toEqual(['strErrorMDBFileNotFound']);
  });

  it('reports a missing table (strErrorReadingMDBFile)', async () => {
    const r = await upload(writeJet(deltaTables({ omit: ['Part'] })));
    expect(r.status, r.text).toBe(422);
    expect(keys(r)).toEqual(['strErrorReadingMDBFile']);
    expect(r.body.messages[0].text).toBe('Грешка при четене на файла на Microinvest Делта: липсва таблица Part');
  });

  it('reads Jet 4 and Jet 3 files; Jet 3 text is windows-1251', () => {
    for (const version of [3, 4] as const) {
      const src = readDeltaMdb(writeJet(deltaTables(), { version }));
      expect(src.part.map((p) => p.Company)).toEqual(['Клиент АД', 'Доставчик ООД', 'Клиент АД - стар запис']);
      expect(src.system?.City).toBe('Пловдив');
      expect(src.years.map((y) => y.table)).toEqual(['Year2009', 'Year2026']);
      expect(src.accts).toHaveLength(ACCOUNTS.length);
    }
    expect(readDeltaMdb(writeJet(deltaTables()), 'partners')).toMatchObject({ accts: [], priznaci: [], years: [] });
  });
});

describe('Delta conversion: operations, chart and partners', () => {
  let db: Db;
  let body: any;

  beforeAll(async () => {
    db = await freshCompany(2026);
    const r = await upload(writeJet(deltaTables()));
    expect(r.status, r.text).toBe(200);
    body = r.body;
  }, 60_000);

  it('returns the summary', () => {
    expect(body).toMatchObject({
      type: 'all', myCompany: true, accounts: 12, partners: 3, partnersMatched: 1, accountings: 3, openingBalances: 3, message: 'Прехвърлянето завърши.',
      years: [{ year: 2009, table: 'Year2009', accountings: 3, openingBalances: 3, skipped: 0 }],
    });
    // The EUR chart is a copy of the converted chart; Year2007 is before 2008; Year2026 is a euro year and is skipped with a warning.
    expect(body.warnings.map((w: { key: string }) => w.key)).toEqual(['strDeltaConversionEuroChartCopied', 'strDeltaConversionEuroYearSkipped']);
    expect(body.warnings[1].text).toContain('Year2026');
  });

  it('updates the company data from System', async () => {
    const [my] = await rows<any>(db, sql`SELECT name, bulstat, contact_name, vat_id, is_vat FROM my_company`);
    expect(my).toEqual({ name: 'Стара Делта ЕООД', bulstat: '831641791', contact_name: 'Иван Петров', vat_id: 'BG831641791', is_vat: true });
    const [a] = await rows<any>(db, sql`SELECT city, address, phone FROM addresses WHERE owner_type = 'my'`);
    expect(a).toEqual({ city: 'Пловдив', address: 'ул. Главна 5', phone: '032 123456' });
    const [b] = await rows<any>(db, sql`SELECT ba.account, bk.name FROM bank_accounts ba JOIN banks bk ON bk.id = ba.bank_id WHERE ba.owner_type = 'my'`);
    expect(b).toEqual({ account: 'BG80BNBG96611020345678', name: 'Тестова банка' });
  });

  it('builds the BGN chart: numbers, parents, names, categories and the currency flag', async () => {
    const chart = await rows<any>(db, sql`
      SELECT a.number, a.description, p.number AS parent, a.account_category_id AS category, c.iso_code AS currency
      FROM accounts a JOIN accounts p ON p.id = a.parent_id JOIN currencies c ON c.id = a.currency_id
      WHERE NOT a.is_euro AND a.number <> '0' ORDER BY a.number`);
    expect(chart.map((a) => a.number)).toEqual(['304', '401', '411', '411/1', '453', '453/1', '453/2', '501', '504', '504/1', '602', '702']);
    const by = (n: string) => chart.find((a) => a.number === n);
    expect(by('411/1')).toEqual({ number: '411/1', description: 'Клиенти в страната', parent: '411', category: 10, currency: 'BGN' });
    expect(by('411')!.parent).toBe('0');
    expect(by('453/2')!.category).toBe(17);
    expect(by('504/1')!.currency).toBe('EUR');
    expect(by('504')!.currency).toBe('BGN');
    // The EUR chart (from 2026) is a copy of it, so the balances carried to 2026 keep their accounts' meaning.
    const eur = await rows<any>(db, sql`
      SELECT a.number, a.description, p.number AS parent, a.account_category_id AS category, c.iso_code AS currency
      FROM accounts a JOIN accounts p ON p.id = a.parent_id JOIN currencies c ON c.id = a.currency_id
      WHERE a.is_euro AND a.number <> '0' ORDER BY a.number`);
    expect(eur.map((a) => [a.number, a.description, a.parent, a.category])).toEqual(chart.map((a) => [a.number, a.description, a.parent, a.category]));
    expect(eur.find((a) => a.number === '411/1')!.currency).toBe('EUR');
  });

  it('converts the partners, matching duplicates by Bulstat and ignoring the placeholder Bulstat', async () => {
    const ps = await rows<any>(db, sql`SELECT name, contact_name, bulstat, vat_number, priority FROM companies ORDER BY id`);
    expect(ps).toEqual([
      { name: 'Клиент АД', contact_name: 'Мария Иванова', bulstat: '200000001', vat_number: 'BG200000001', priority: 5 },
      { name: 'Доставчик ООД', contact_name: 'Петър', bulstat: null, vat_number: null, priority: 0 },
      { name: 'Служебен партньор', contact_name: null, bulstat: '123456786', vat_number: 'BG123456786', priority: 0 },
    ]);
    const [addr] = await rows<any>(db, sql`SELECT city, address, phone FROM addresses a JOIN companies c ON c.id = a.owner_id WHERE a.owner_type = 'company' AND c.name = 'Клиент АД'`);
    expect(addr).toEqual({ city: 'София', address: 'бул. Витоша 1', phone: '02 999' });
    const [bank] = await rows<any>(db, sql`SELECT ba.account, bk.code FROM bank_accounts ba LEFT JOIN banks bk ON bk.id = ba.bank_id WHERE ba.owner_type = 'company'`);
    expect(bank.account).toBe('BG11UBBS80021012345678');
  });

  it('converts the Year2009 accountings into a new financial year 2009 with VAT terms, documents and partners', async () => {
    const years = await rows<{ year: number }>(db, sql`SELECT year FROM financial_years ORDER BY year`);
    expect(years.map((y) => y.year)).toEqual([2009, 2026]);
    const heads = await rows<any>(db, sql`
      SELECT a.accounting_date::text AS date, a.transaction_type_id AS tt, a.vies_id AS vies, a.vies_month::text AS vies_month, a.source,
        t.description AS term, r.description AS reference, doc.number AS doc_number, doc.date::text AS doc_date, dt.short_name AS doc_type
      FROM accountings a JOIN financial_years fy ON fy.id = a.financial_year_id
      LEFT JOIN terms t ON t.id = a.term_id LEFT JOIN reference_texts r ON r.id = a.reference_id
      LEFT JOIN documents doc ON doc.id = a.document_id LEFT JOIN document_types dt ON dt.id = doc.document_type_id
      WHERE fy.year = 2009 AND NOT a.is_initial_balance ORDER BY a.id`);
    expect(heads).toHaveLength(3);
    expect(heads[0]).toEqual({
      date: '2009-05-20', tt: 3, vies: 1, vies_month: '2009-06-01', source: 'import-delta', term: 'Продажба на стоки', reference: 'по договор',
      doc_number: '0000000101', doc_date: '2009-05-19', doc_type: 'Ф-ра',
    });
    expect(heads[1]).toMatchObject({ date: '2009-05-25', tt: 1, doc_type: 'ПКО', doc_date: '2009-01-01', vies_month: '2009-12-01' });
    expect(heads[1].doc_number).toMatch(/^0*1$/);
    expect(heads[2]).toMatchObject({ tt: 2, doc_type: 'Прот', doc_number: '0' });

    const legs = await rows<any>(db, sql`
      SELECT acc.number, d.sign, d.amount::text AS amount, d.ref_amount::text AS ref, d.vat_term_id AS vat, co.name AS partner
      FROM accounting_details d JOIN accounts acc ON acc.id = d.account_id JOIN accountings a ON a.id = d.accounting_id
      LEFT JOIN companies co ON co.id = d.company_id
      WHERE a.source = 'import-delta' ORDER BY a.id, d.position`);
    const sale = legs.filter((l) => ['411/1', '702', '453/2'].includes(l.number) && l.vat === 7);
    expect(sale.find((l) => l.number === '411/1' && l.sign === 1)?.partner).toBe('Клиент АД');
    expect(sale.some((l) => l.number === '702' && l.sign === -1)).toBe(true);
    const purchase = legs.filter((l) => l.number === '401');
    expect(purchase.every((l) => l.partner === 'Служебен партньор' && l.vat === 2)).toBe(true);
    // Partner accounts used are linked to the partners.
    const links = await rows<any>(db, sql`SELECT c.name, a.number FROM company_accounts ca JOIN companies c ON c.id = ca.company_id JOIN accounts a ON a.id = ca.account_id ORDER BY c.id, a.number`);
    expect(links).toEqual([{ name: 'Клиент АД', number: '411/1' }, { name: 'Доставчик ООД', number: '411/1' }, { name: 'Служебен партньор', number: '401' }]);
  });

  it('saves the opening balances of 2009 (partner accounts per partner and document)', async () => {
    const ob = await rows<any>(db, sql`
      SELECT acc.number, co.name AS partner, doc.number AS doc, sum(d.amount)::text AS debit, sum(d.currency_amount)::text AS cur
      FROM account_initial_balances ib JOIN accountings a ON a.id = ib.accounting_id JOIN accounting_details d ON d.accounting_id = a.id AND d.account_id = ib.account_id
      JOIN accounts acc ON acc.id = ib.account_id JOIN financial_years fy ON fy.id = ib.financial_year_id
      LEFT JOIN companies co ON co.id = ib.company_id LEFT JOIN documents doc ON doc.id = ib.document_id
      WHERE fy.year = 2009 GROUP BY acc.number, co.name, doc.number ORDER BY acc.number`);
    expect(ob).toEqual([
      { number: '411/1', partner: 'Доставчик ООД', doc: '55', debit: '300.000000', cur: null },
      { number: '501', partner: null, doc: null, debit: '1000.000000', cur: null },
      { number: '504/1', partner: null, doc: null, debit: '195.580000', cur: '0.000000' },
    ]);
  });

  it('refuses a second run into the non-empty company', async () => {
    const r = await upload(writeJet(deltaTables()));
    expect(r.status, r.text).toBe(422);
    expect(keys(r)).toEqual(['strAccountsAlreadyExist', 'strImportDatabaseNotEmptyError']);
    const g = await call('GET', '/exchange/delta');
    expect(g.body.blockers.partners.map((m: { key: string }) => m.key)).toEqual(['strImportDatabaseNotEmptyError']);
  });
});

describe('Delta conversion: import types, Jet 3 and failures', () => {
  it('imports only the partners into a company that has a chart', async () => {
    const db = await freshCompany(2025);
    const r = await upload(writeJet(deltaTables(), { version: 3 }), 'partners');
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ type: 'partners', accounts: 0, partners: 2, partnersMatched: 1, accountings: 0 });
    const names = await rows<{ name: string }>(db, sql`SELECT name FROM companies ORDER BY id`);
    expect(names.map((n) => n.name)).toEqual(['Клиент АД', 'Доставчик ООД']);
    const [{ n }] = (await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM accountings`)) as [{ n: number }];
    expect(n).toBe(0);
  });

  it('refuses the chart into a company whose BGN chart has accounts (strAccountsAlreadyExist)', async () => {
    await freshCompany(2025);
    const r = await upload(writeJet(deltaTables()), 'chartAndPartners');
    expect(r.status, r.text).toBe(422);
    expect(keys(r)).toEqual(['strAccountsAlreadyExist']);
  });

  it('imports chart and partners without operations', async () => {
    const db = await freshCompany(2026);
    const r = await upload(writeJet(deltaTables()), 'chartAndPartners');
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ accounts: 12, partners: 2, accountings: 0, years: [] });
    const [{ n }] = (await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM financial_years`)) as [{ n: number }];
    expect(n).toBe(1);
  });

  it('aborts the whole run on an invalid account (DeltaConversionInvalidAccountError) and saves nothing', async () => {
    const db = await freshCompany(2026);
    const r = await upload(writeJet(deltaTables({ year2009: [line(7, 1, 501, 0, 2, 10, { Date: d(2009, 2, 1) }), line(7, 2, 999, 3, 1, -10, { Date: d(2009, 2, 1) })] })));
    expect(r.status, r.text).toBe(422);
    expect(keys(r)).toEqual(['strImportFromDeltaFailed', 'DeltaConversionInvalidAccountError']);
    expect(r.body.messages[1].text).toBe('Сметка 999/3 в таблица Year2009 с AccountingID = 7 е невалидна!');
    const [c] = await rows<{ a: number; p: number }>(db, sql`SELECT (SELECT count(*)::int FROM accounts WHERE number <> '0' AND NOT is_euro) AS a, (SELECT count(*)::int FROM companies) AS p`);
    expect(c).toEqual({ a: 0, p: 0 });
  });

  it('reports an unbalanced accounting', async () => {
    await freshCompany(2026);
    const r = await upload(writeJet(deltaTables({ year2009: [line(8, 1, 501, 0, 2, 10), line(8, 2, 702, 0, 1, -9)] })));
    expect(keys(r)).toEqual(['strImportFromDeltaFailed', 'strDeltaConversionUnbalanced']);
  });

  it('reports what saveEntry refuses, with the table and AccountingID (many-to-many)', async () => {
    await freshCompany(2026);
    const r = await upload(writeJet(deltaTables({
      year2009: [line(9, 1, 501, 0, 2, 10), line(9, 2, 602, 0, 2, 10), line(9, 3, 702, 0, 1, -15), line(9, 4, 304, 0, 1, -5)],
    })));
    expect(r.status, r.text).toBe(422);
    expect(keys(r).slice(0, 2)).toEqual(['strImportFromDeltaFailed', 'strDeltaConversionAccountingError']);
    expect(r.body.messages[1].text).toBe('Операцията в таблица Year2009 с AccountingID = 9 не може да бъде записана:');
    expect(keys(r)).toContain('strManyToMany');
  });

  it('converts a Jet 3 file with Cyrillic text', async () => {
    const db = await freshCompany(2026);
    const r = await upload(writeJet(deltaTables(), { version: 3 }));
    expect(r.status, r.text).toBe(200);
    expect(r.body.accountings).toBe(3);
    const [a] = await rows<{ description: string }>(db, sql`SELECT description FROM accounts WHERE number = '411/1' AND NOT is_euro`);
    expect(a!.description).toBe('Клиенти в страната');
    const [term] = await rows<{ description: string }>(db, sql`SELECT description FROM terms WHERE description = 'Продажба на стоки'`);
    expect(term).toBeTruthy();
  });

  it('a cancelled run (strCancelTransferWarning) saves nothing', async () => {
    const db = await freshCompany(2025);
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await t.app.request('/api/exchange/delta/import', {
      method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', cookie: t.session.get() },
      body: JSON.stringify({ fileName: 'MAINACCT.MDB', contentBase64: b64(writeJet(deltaTables())), type: 'partners' }),
    });
    const body = (await res.json()) as { messages: { key: string }[] };
    expect([res.status, body.messages.map((m) => m.key)]).toEqual([422, ['strImportFromDeltaFailed', 'strTransferCancelled']]);
    const [{ n }] = (await rows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM companies`)) as [{ n: number }];
    expect(n).toBe(0);
  });

  it('an unexpected failure is logged and reported as strImportFromDeltaFailedSeeErrLog', async () => {
    const db = await freshCompany(2025);
    const [fy] = await rows<{ id: number; year: number; start_date: string }>(db, sql`SELECT id, year, start_date FROM financial_years ORDER BY year LIMIT 1`);
    const year = { id: fy!.id, year: fy!.year, startDate: fy!.start_date, isLocked: false, lockedMonths: 0, isConcluded: false };
    // A broken source (no partner table) fails outside the known checks.
    const src = { system: null, accts: [], priznaci: [], part: null, years: [] } as unknown as DeltaSource;
    const err = await runDeltaConversion(db, src, 'partners', { year, userId: 1, today: '2025-06-30' }, { fileName: 'BROKEN.MDB', company: 'delta-test', user: 'Администратор' }).catch((e) => e);
    expect(err).toBeInstanceOf(DataImportError);
    expect((err as DataImportError).messages.map((m) => [m.key, m.text])).toEqual([
      ['strImportFromDeltaFailedSeeErrLog', 'Неуспешен импорт от Microinvest Делта! Подробности за грешката има в дневника на приложението.'],
    ]);
    const log = await readAppLog(20);
    expect(log.find((e) => e.company === 'delta-test')).toMatchObject({ level: 'error', user: 'Администратор' });
    expect(log.find((e) => e.company === 'delta-test')!.message).toContain('BROKEN.MDB');
  });
});
