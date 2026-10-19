import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createTestCompany, type TestCompany } from './helpers.ts';

/** Bank-statement import (spec 04b 1) and its posting rules (03a 9). */

let t: TestCompany;
let call: TestCompany['call'];
let acc: TestCompany['acc'];

const OWN_IBAN = 'BG80STSA93000012345678';
const USD_IBAN = 'BG18FINV91501014771636';
const PARTNER_IBAN = 'BG11UNCR70001512345678';
let bankId: number;
let finvId: number;
let partnerId: number;
let stsaAccount: number;
let usdAccount: number;
let usdLedger: number;

const keys = (r: { body: { messages?: { key: string }[] } }) => (r.body.messages ?? []).map((m) => m.key);

async function balances(from: string, to: string) {
  const r = await call('GET', `/reports/trial-balance?from=${from}&to=${to}&level=3`);
  expect(r.status, r.text).toBe(200);
  const out: Record<string, { dt: string; ct: string }> = {};
  for (const x of r.body.rows) out[x.number] = { dt: x.debitTurnover, ct: x.creditTurnover };
  return out;
}

async function entryCount() {
  return (await call('GET', '/entries?from=2026-01-01&to=2026-12-31&initial=all')).body.total as number;
}

type Row = {
  index: number; date: string; isInflow: boolean; amount: string; partnerIban: string; partnerName: string; reason: string; reference: string; props: Record<string, string>;
  templateId: number | null; templateName: string; debitAccountId: number | null; creditAccountId: number | null; companyId: number | null; companyName: string; term: string;
  postAmount: string; currencyAmount: string | null; exchangeRate: string | null; warnings: string[]; rowKeys: string[]; duplicate: boolean; ibanCompanyId: number | null;
  docReference: string; documents: { accountingId: number; amount: string; selected: boolean }[];
};
const toPost = (r: Row, extra: Record<string, unknown> = {}) => ({
  ...r, reference: r.docReference, documents: r.documents.filter((x) => x.selected).map((x) => x.accountingId), ...extra,
}) as Record<string, unknown>;

const mt940 = (lines: string[]) => [':20:STMT1', `:25:${OWN_IBAN}`, ':28C:1/1', ':60F:C260901EUR1000,00', ...lines, ':62F:C260930EUR0,00', '-'].join('\r\n');

beforeAll(async () => {
  t = await createTestCompany();
  call = t.call;
  acc = t.acc;
  const banks = (await call('GET', '/banks')).body as { id: number; code: string }[];
  bankId = banks.find((b) => b.code === 'STSABGSF')!.id;
  finvId = banks.find((b) => b.code === 'FINVBGSF')!.id;
  const usd = await call('POST', '/accounts', { parentId: acc('504'), description: 'Банка USD', accountCategoryId: 27, currencyId: 3 });
  expect(usd.status, usd.text).toBe(201);
  await t.reloadAccounts();
  usdLedger = usd.body.id;
  partnerId = await t.partner('Банков Клиент ООД', ['411'], { bulstat: '161616161', bankAccounts: [{ account: PARTNER_IBAN }] });
}, 60_000);
afterAll(() => t.close());

describe('default posting rules per bank (03a 9.1, 7.2)', () => {
  it('an own bank account of a listed bank creates its rules; saving again adds none', async () => {
    const my = (await call('GET', '/my-company')).body;
    const body = {
      ...my, addresses: [],
      bankAccounts: [
        { account: OWN_IBAN, bankId, bankStatementAccountId: acc('503'), isEuro: true },
        { account: USD_IBAN, bankId: finvId, bankStatementAccountId: usdLedger, isEuro: false },
      ],
    };
    let r = await call('PUT', '/my-company', body);
    expect(r.status, r.text).toBe(200);
    expect(r.body.templatesAdded).toBe(30); // DSK 15 + Fibank 15
    r = await call('PUT', '/my-company', body);
    expect(r.body.templatesAdded).toBe(0);
    const list = (await call('GET', `/bank-templates?bankId=${bankId}`)).body as { name: string; priority: number; debitAccountNumber: string | null; creditAccountNumber: string | null; companyId: number | null }[];
    expect(list).toHaveLength(15);
    expect(list.find((x) => x.name === 'Банкова такса')).toMatchObject({ priority: 1, debitAccountNumber: '629' });
    expect(list.find((x) => x.name === 'Получаване на ПОС терминал')!.companyId).not.toBeNull();
    const fin = (await call('GET', `/bank-templates?bankId=${finvId}`)).body as { formulaText: string; name: string }[];
    expect(fin.find((x) => x.name === 'Банкова такса')!.formulaText).toContain('OPRTGS');
    const accounts = (await call('GET', '/bank-statements/accounts')).body as { id: number; account: string }[];
    stsaAccount = accounts.find((a) => a.account === OWN_IBAN)!.id;
    usdAccount = accounts.find((a) => a.account === USD_IBAN)!.id;
    // A bank without a list in Delta gets nothing automatically; the command adds the common set.
    const banks = (await call('GET', '/banks')).body as { id: number; code: string }[];
    const nasb = banks.find((b) => b.code === 'NASBBGSF')!.id;
    expect((await call('POST', '/bank-templates/defaults', { bankId: nasb })).body.added).toBe(15);
  });

  it('template editor validation and CRUD', async () => {
    let r = await call('POST', '/bank-templates/defaults', { bankId });
    expect(r.body.added).toBe(0); // the bank already has templates
    r = await call('POST', '/bank-templates', { bankId, name: '', formula: 'Reason', debitAccountId: null });
    expect(r.status).toBe(422);
    expect(keys(r)).toEqual(['strMissingTemplateName', 'strMissingCondition', 'strMissingValidDebitOrCreditAccount']);
    r = await call('POST', '/bank-templates', { bankId, name: 'Наем', formula: 'Reason съдържа "наем"', debitAccountId: acc('602'), termText: 'наем', priority: 3 });
    expect(r.status, r.text).toBe(201);
    const id = r.body.id;
    r = await call('POST', `/bank-templates/${id}/copy`);
    expect(r.status).toBe(201);
    const list = (await call('GET', `/bank-templates?bankId=${bankId}`)).body as { id: number; name: string; debitAccountNumber: string; priority: number }[];
    expect(list.find((x) => x.id === id)).toMatchObject({ name: 'Наем', debitAccountNumber: '602', priority: 3 });
    expect(list.some((x) => x.name === 'Копие на Наем')).toBe(true);
    await call('DELETE', `/bank-templates/${r.body.id}`);
  });
});

describe('bank statement import (04b 1)', { timeout: 30_000 }, () => {
  it('imports an MT940 statement and posts rows by the rules', async () => {
    const file = mt940([
      ':61:2609020902C150,50NTRFREF1//B1', `:86:Плащане по ф-ра 0000000501 ${PARTNER_IBAN}`,
      ':61:2609030903D20,00NCHGREF2', ':86:Такса за превод',
      ':61:2609040904D300,00NTRFREF3', ':86:Наем за септември',
      ':61:2609050905D1,00NTRFREF4', ':86:Нещо непознато',
    ]);
    const p = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: file, bankAccountId: stsaAccount });
    expect(p.status, p.text).toBe(200);
    expect(p.body.header).toContain(OWN_IBAN);
    expect(p.body).toMatchObject({ openingBalance: '1000.00', bindingEnabled: true });
    const rows = p.body.rows as Row[];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ debitAccountId: acc('503'), creditAccountId: acc('411'), companyId: partnerId, postAmount: '150.50', ibanCompanyId: partnerId, duplicate: false });
    expect(rows[1]!.debitAccountId).toBe(acc('629'));
    expect(rows[2]).toMatchObject({ templateName: 'Наем', debitAccountId: acc('602'), term: 'наем' });
    expect(rows[3]!.warnings).toEqual(['strNoBankTemplateWarning']);
    expect(rows.every((r) => r.rowKeys.length === 1)).toBe(true);
    const before = await entryCount();
    const post = await call('POST', '/bank-statements/post', { bankAccountId: stsaAccount, rows: rows.map((r) => toPost(r)), customDocumentNumber: '77' });
    expect(post.status, post.text).toBe(200);
    expect(post.body.posted, JSON.stringify(post.body.results)).toBe(3);
    expect(post.body.results[3].messages.map((m: { key: string }) => m.key)).toEqual(['strMissingValidDebitAccount']);
    expect(await entryCount()).toBe(before + 3);
    const tb = await balances('2026-09-02', '2026-09-05');
    expect(tb['503']).toMatchObject({ dt: '150.50', ct: '320.00' });
    expect(tb['602']!.dt).toBe('300.00');

    // Re-import (corrected D-04b-6): posted rows are flagged and confirmed before posting again.
    const again = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: file, bankAccountId: stsaAccount });
    const rows2 = again.body.rows as Row[];
    expect(rows2.map((r) => r.duplicate)).toEqual([true, true, true, false]);
    expect(rows2[0]!.warnings).toContain('strBankStatementRowAlreadyImported');
    let r = await call('POST', '/bank-statements/post', { bankAccountId: stsaAccount, rows: [toPost(rows2[2]!)] });
    expect(r.status).toBe(409);
    expect(keys(r)).toEqual(['strBankStatementRowsAlreadyImported']);
    expect(r.body.messages[0].text).toContain('3');
    r = await call('POST', '/bank-statements/post', { bankAccountId: stsaAccount, force: true, rows: [toPost(rows2[2]!)] });
    expect(r.body.posted).toBe(1);
    expect((await balances('2026-09-04', '2026-09-04'))['602']!.dt).toBe('600.00');
    // Deleting the entries frees the rows again.
    for (const x of [...post.body.results, ...r.body.results].filter((x: { id?: number }) => x.id)) await call('DELETE', `/entries/${x.id}`);
    const third = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: file, bankAccountId: stsaAccount });
    expect((third.body.rows as Row[]).some((x) => x.duplicate)).toBe(false);
  });

  it('rejects a file of another year and a file without rows', async () => {
    const mt = [':20:S', `:25:${OWN_IBAN}`, ':60F:C250901EUR0,00', ':61:2509020902C1,00NTRF', ':86:x', ':62F:C250902EUR1,00'].join('\n');
    let r = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: mt, bankAccountId: stsaAccount });
    expect(keys(r)).toEqual(['strBankStatementDatesInDifferentYear']);
    r = await call('POST', '/bank-statements/parse', { fileName: 'st.txt', text: 'nothing here', bankAccountId: stsaAccount });
    expect(keys(r)).toEqual(['strWrongFileOrBrokenStructures']);
  });

  it('keywords are seeded and editable', async () => {
    const k = (await call('GET', '/bank-statements/keywords')).body as { id: number; word: string }[];
    expect(k.map((x) => x.word)).toContain('ф-ра');
    const add = await call('POST', '/bank-statements/keywords', { word: ' сметка ' });
    expect(add.body.word).toBe('сметка');
    expect((await call('POST', '/bank-statements/keywords', { word: 'x'.repeat(255) })).status).toBe(201);
    await call('DELETE', `/bank-statements/keywords/${add.body.id}`);
    expect((await call('GET', '/bank-statements/keywords')).body).toHaveLength(k.length + 1);
  });
});

describe('foreign-currency account: rate per date, currency differences, fees (04b 1.8, 1.10)', { timeout: 30_000 }, () => {
  const fibank = (currency = 'USD') => `<ROWSET><ROW><XML><statement><system><Version>1</Version></system>
    <header><IBAN>${USD_IBAN}</IBAN><FromDate>02.03.2026</FromDate><Currency>${currency}</Currency><OpeningBalance>500.00</OpeningBalance></header>
    <movements>
      <movement><ValueDate>02.03.2026</ValueDate><Reference>FX1</Reference><DebitTov>0</DebitTov><CreditTov>94.00</CreditTov><Amount>100.00</Amount><OperationReason><Description>Покупка на валута</Description></OperationReason></movement>
      <movement><ValueDate>03.03.2026</ValueDate><Reference>FX2</Reference><DebitTov>46.00</DebitTov><CreditTov>0</CreditTov><Amount>50.00</Amount><OperationReason><Description>Продажба на валута</Description></OperationReason></movement>
      <movement><ValueDate>04.03.2026</ValueDate><Reference>FX3</Reference><DebitTov>4.65</DebitTov><CreditTov>0</CreditTov><Amount>5.00</Amount><OperationReason><Description>Такса превод</Description></OperationReason></movement>
    </movements></statement></XML></ROW></ROWSET>`;

  it('the file currency must be the account currency', async () => {
    const r = await call('POST', '/bank-statements/parse', { fileName: 'fib.xml', text: fibank('EUR'), bankAccountId: usdAccount });
    expect(keys(r)).toEqual(['strCurrenciesAreNotTheSame']);
  });

  it('each row takes the stored rate of its date; differences go to 624/724; a fee adds 629', async () => {
    expect((await call('PUT', '/revaluation/rates', { date: '2026-03-02', rates: [{ currencyId: 3, rate: '0.92' }] })).status).toBe(200);
    expect((await call('PUT', '/revaluation/rates', { date: '2026-03-03', rates: [{ currencyId: 3, rate: '0.93' }] })).status).toBe(200);
    const p = await call('POST', '/bank-statements/parse', { fileName: 'fib.xml', text: fibank(), bankAccountId: usdAccount });
    expect(p.status, p.text).toBe(200);
    expect(p.body).toMatchObject({ format: 'Fibank XML', currency: 'USD', isForeignCurrency: true, openingBalance: '500.00' });
    const rows = p.body.rows as Row[];
    expect(rows.map((r) => [r.currencyAmount, r.exchangeRate, r.postAmount])).toEqual([['100.00', '0.92', '94.00'], ['50.00', '0.93', '46.00'], ['5.00', '0.93', '4.65']]);
    expect(rows[2]).toMatchObject({ templateName: 'Банкова такса', debitAccountId: acc('629'), creditAccountId: usdLedger });
    const post = await call('POST', '/bank-statements/post', {
      bankAccountId: usdAccount,
      rows: [
        toPost(rows[0]!, { creditAccountId: acc('503'), feeCurrencyAmount: '1' }),
        toPost(rows[1]!, { debitAccountId: acc('503') }),
        toPost(rows[2]!),
      ],
    });
    expect(post.status, post.text).toBe(200);
    expect(post.body.posted, JSON.stringify(post.body.results)).toBe(3);
    const tb = await balances('2026-03-02', '2026-03-04');
    const usdNumber = ((await call('GET', '/accounts')).body as { id: number; number: string }[]).find((a) => a.id === usdLedger)!.number;
    expect(tb[usdNumber]).toMatchObject({ dt: '92.00', ct: '52.07' });
    expect(tb['624']).toMatchObject({ dt: '2.50' });
    expect(tb['629']).toMatchObject({ dt: '5.57' });
    expect(tb['503']).toMatchObject({ dt: '46.00', ct: '94.00' });
    const e = (await call('GET', `/entries/${post.body.results[0].id}`)).body;
    const lines = (x: { debits: { accountId: number; amount: string }[]; credits: { accountId: number; amount: string }[] }) => [...x.debits, ...x.credits].map((l) => [l.accountId, l.amount]);
    expect(lines(e)).toEqual([[usdLedger, '92.00'], [acc('624'), '2.00'], [acc('503'), '94.00']]);
    // The fee is a second entry of the same statement (Dt 629 / Ct bank, 1 USD at 0.92).
    const fee = (await call('GET', `/entries/${post.body.results[0].feeId}`)).body;
    expect(lines(fee)).toEqual([[acc('629'), '0.92'], [usdLedger, '0.92']]);
    expect(fee.documentNumber ?? fee.document?.number).toBe(e.documentNumber ?? e.document?.number);
  });

  it('fee checks: a zero rate is strBankTaxZeroExchangeRate', async () => {
    const r = await call('POST', '/bank-statements/post', {
      bankAccountId: usdAccount,
      rows: [{ index: 0, date: '2026-03-05', debitAccountId: usdLedger, creditAccountId: acc('503'), companyId: null, term: 'x', postAmount: '10', currencyAmount: '10', exchangeRate: '0', feeCurrencyAmount: '1' }],
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.results[0].messages.map((m: { key: string }) => m.key)).toEqual(['strBankTaxZeroSum', 'strBankTaxZeroExchangeRate']);
  });
});

describe('rules, partners and IBANs in the preview (04b 1.5, 1.7)', { timeout: 30_000 }, () => {
  const STRANGER = 'BG50UBBS80021012345678';
  const file = mt940([':61:2609100910D80,00NTRFR10', `:86:Плащане ${STRANGER}`]);

  it('re-applies a chosen rule to one row (MapStatementToAccountingWithTemplate)', async () => {
    const p = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: file, bankAccountId: stsaAccount });
    const row = (p.body.rows as Row[])[0]!;
    expect(row.templateId).toBeNull();
    const rule = (p.body.templates as { id: number; name: string }[]).find((x) => x.name === 'Наем')!;
    const raw = { index: row.index, date: row.date, isInflow: row.isInflow, amount: row.amount, partnerIban: row.partnerIban, partnerName: row.partnerName, reason: row.reason, reference: row.reference, props: row.props };
    let r = await call('POST', '/bank-statements/apply-template', { bankAccountId: stsaAccount, templateId: rule.id, row: raw });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ templateId: rule.id, templateName: 'Наем', debitAccountId: acc('602'), creditAccountId: acc('503'), term: 'наем', warnings: [] });
    r = await call('POST', '/bank-statements/apply-template', { bankAccountId: stsaAccount, templateId: null, row: raw });
    expect(r.body).toMatchObject({ templateId: null, debitAccountId: null, warnings: ['strNoBankTemplateWarning'] });
  });

  it('binds an IBAN to a partner after the confirmation; excluded IBANs never find a partner', async () => {
    let r = await call('POST', '/bank-statements/bind-iban', { companyId: partnerId, iban: STRANGER });
    expect(r.body).toMatchObject({ added: true, message: `IBAN ${STRANGER} е обвързан с партньор Банков Клиент ООД.` });
    r = await call('POST', '/bank-statements/bind-iban', { companyId: partnerId, iban: STRANGER });
    expect(r.body.added).toBe(false);
    const p = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: file, bankAccountId: stsaAccount });
    expect((p.body.rows as Row[])[0]).toMatchObject({ ibanCompanyId: partnerId, templateName: 'Плащане към Доставчик' });

    r = await call('PUT', '/bank-statements/excluded-ibans', { ibans: [STRANGER.toLowerCase(), 'BG00XXXX'] });
    expect(r.body.ibans).toEqual([STRANGER, 'BG00XXXX']);
    expect(r.body.warnings.map((w: { key: string }) => w.key)).toEqual(['strInvalidIBAN']);
    const q = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: file, bankAccountId: stsaAccount });
    expect((q.body.rows as Row[])[0]).toMatchObject({ ibanCompanyId: null, companyId: null, ibanExcluded: true });
    expect((await call('GET', '/bank-statements/excluded-ibans')).body.ibans).toEqual([STRANGER, 'BG00XXXX']);
    await call('PUT', '/bank-statements/excluded-ibans', { ibans: [] });
  });
});

describe('IsBindingDocumentsInBankImportEnabled (06 3.4)', { timeout: 30_000 }, () => {
  it('on: open documents are offered and bound; off: no binding in the preview', async () => {
    const inv = await t.post({ date: '2026-10-01', docType: 1, docNumber: '0000000888', partner: partnerId, dr: [['411', 120]], cr: [['702', 120]] });
    const file = mt940([':61:2610051005C50,00NTRFR20', `:86:Плащане ф-ра 888 ${PARTNER_IBAN}`]);
    let p = await call('POST', '/bank-statements/parse', { fileName: 'st.sta', text: file, bankAccountId: stsaAccount });
    let row = (p.body.rows as Row[])[0]!;
    expect(row.documents.find((d) => d.accountingId === inv.id)).toMatchObject({ amount: '120.00', selected: true });
    const docs = await call('GET', `/bank-statements/open-documents?companyId=${partnerId}&accountId=${acc('411')}`);
    expect(docs.body.map((d: { accountingId: number }) => d.accountingId)).toContain(inv.id);
    const post = await call('POST', '/bank-statements/post', { bankAccountId: stsaAccount, rows: [toPost(row, { documents: [{ accountingId: inv.id, amount: '30.00' }] })] });
    expect(post.body.posted, post.text).toBe(1);
    const open = (await call('GET', `/bank-statements/open-documents?companyId=${partnerId}&accountId=${acc('411')}`)).body as { accountingId: number; amount: string }[];
    expect(open.find((d) => d.accountingId === inv.id)!.amount).toBe('90.00');

    expect((await call('PUT', '/settings', { IsBindingDocumentsInBankImportEnabled: 'False' })).status).toBe(200);
    const settings = (await call('GET', '/settings')).body as { key: string; value: string }[];
    expect(settings.find((s) => s.key === 'IsBindingDocumentsInBankImportEnabled')!.value).toBe('False');
    p = await call('POST', '/bank-statements/parse', { fileName: 'st2.sta', text: mt940([':61:2610061006C10,00NTRFR21', `:86:ф-ра 888 ${PARTNER_IBAN}`]), bankAccountId: stsaAccount });
    row = (p.body.rows as Row[])[0]!;
    expect(p.body.bindingEnabled).toBe(false);
    expect(row.documents).toEqual([]);
    await call('PUT', '/settings', { IsBindingDocumentsInBankImportEnabled: 'True' });
  });
});

describe('Excel statement header (04b 1.3, 1.4)', { timeout: 30_000 }, () => {
  async function dskWorkbook(currency: string) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Извлечение');
    const rows: unknown[][] = [
      ['Банка ДСК'], ['ОТЧЕТ ПО СМЕТКА'], ['Банка ДСК АД'], ['София'], ['STSABGSF'], ['Тест ООД'], ['831641791'], ['София'], [''], [`${OWN_IBAN} ${currency}`],
      [''], ['', '01.09.2026'], ['', '30.09.2026'], ['', '1000,00'], ['', '0'], ['', '15,00'], ['', '1015,00'],
      ['Дата', 'Дебит', 'Кредит', 'Контрагент', 'IBAN на контрагента', 'Основание'],
      ['15.09.2026', '', '15,00', 'Банков Клиент ООД', PARTNER_IBAN, 'Плащане'],
    ];
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  }
  it('reads IBAN, currency, period and balances from the header cells', async () => {
    let r = await call('POST', '/bank-statements/parse', { fileName: 'dsk.xlsx', contentBase64: await dskWorkbook('USD'), bankAccountId: stsaAccount });
    expect(keys(r)).toEqual(['strCurrenciesAreNotTheSame']);
    r = await call('POST', '/bank-statements/parse', { fileName: 'dsk.xlsx', contentBase64: await dskWorkbook('EUR'), bankAccountId: stsaAccount });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ fileIban: OWN_IBAN, currency: 'EUR', from: '2026-09-01', to: '2026-09-30', openingBalance: '1000.00', closingBalance: '1015.00' });
    expect(r.body.header).toContain('01.09.2026 - 30.09.2026');
    expect(r.body.rows).toHaveLength(1);
  });
});

describe('open documents of the active year only', { timeout: 60_000 }, () => {
  it('a 2026 document is not offered while 2027 is active', async () => {
    const inv = await t.post({ date: '2026-11-02', docType: 1, docNumber: '0000000999', partner: partnerId, dr: [['411', 70]], cr: [['702', 70]] });
    const ids = async () => ((await call('GET', `/bank-statements/open-documents?companyId=${partnerId}&accountId=${acc('411')}`)).body as { accountingId: number }[]).map((d) => d.accountingId);
    expect(await ids()).toContain(inv.id);
    expect((await call('POST', '/years', { year: 2027, force: true })).status).toBe(201);
    expect((await call('PUT', '/years/active', { year: 2027 })).status).toBe(200);
    try {
      expect(await ids()).not.toContain(inv.id);
    } finally {
      expect((await call('PUT', '/years/active', { year: 2026 })).status).toBe(200);
    }
  });
});
