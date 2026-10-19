import type { JetColumn, JetTable } from './jetWriter.ts';

/**
 * A synthetic legacy Microinvest Delta company (MAINACCT.MDB tables) for the
 * conversion pilot (04a 7): a trading company with partners (duplicates by
 * Bulstat, the 999999999 placeholder, foreign clients), two years of
 * turnover tables with VAT invoices (20 %, 9 %, 0 %, exempt, intra-EU supply,
 * purchases with full, partial and no tax credit, red-storno credit notes),
 * bank and cash payments (one receipt for several partners), currency
 * accounts with currency-amount rows, goods and materials with quantity rows,
 * fixed assets with monthly depreciation, salaries, the year-end closing of
 * the result accounts, and the next year's opening balances.
 *
 * `sourceTotals` reads the generated tables the way an auditor would query
 * the legacy database (it does not use the conversion code): trial balance
 * per account, VAT diary columns per month, partner balances, quantities.
 */

const c = (name: string, type: JetColumn['type'], size?: number): JetColumn => ({ name, type, size });
export const SYSTEM_COLUMNS = [c('Company', 'text', 100), c('Bulstat', 'text', 13), c('Partner', 'text', 50), c('VatID', 'text', 15), c('City', 'text', 30), c('Phone', 'text', 30), c('Address', 'text', 60), c('Bank', 'text', 40), c('BankAcct', 'text', 30)];
export const PRIZNACI_COLUMNS = [c('PriznakID', 'long'), c('Name', 'text', 30), c('Type', 'integer')];
export const ACCTS_COLUMNS = [c('AcctID', 'long'), c('Acct', 'long'), c('SubAcct', 'long'), c('PriznakID', 'long'), c('Name', 'text', 50), c('IsValutna', 'boolean')];
export const PART_COLUMNS = [c('ID', 'long'), c('Partner', 'text', 40), c('Town', 'text', 30), c('Addr', 'text', 60), c('Company', 'text', 60), c('DanNo', 'text', 20), c('Bulstat', 'text', 13), c('Bank', 'text', 30), c('BanAcct', 'text', 30), c('BanCode', 'text', 12), c('Tel_Fax', 'text', 20), c('IsVeryUsed', 'byte')];
export const YEAR_COLUMNS = [
  c('KonID', 'long'), c('Kon', 'long'), c('Acct', 'long'), c('SubAcct', 'long'), c('PriznakID', 'long'), c('Date', 'datetime'), c('DocDate', 'datetime'),
  c('FakNo', 'text', 10), c('DocType', 'text', 8), c('Osnovanie', 'text', 40), c('Note', 'text', 30), c('IsPokupka', 'byte'), c('VIESCol', 'byte'), c('VIESDate', 'datetime'),
  c('OperType', 'byte'), c('IsKredit', 'byte'), c('Qtty', 'currency'), c('StartDebit', 'currency'), c('StartKredit', 'currency'), c('PartnerID', 'long'),
];

/** Priznaci: 0 none, 3 "Обект" (account feature, Type 0), 7 quantity and 8 currency amount (Type 1 / 2, not converted). */
const PRIZNACI = [{ PriznakID: 0, Name: '', Type: 0 }, { PriznakID: 3, Name: 'Обект', Type: 0 }, { PriznakID: 7, Name: 'Количество', Type: 1 }, { PriznakID: 8, Name: 'Валута', Type: 2 }];
const QTY = 7;
const CUR = 8;

type Acc = [acct: number, sub: number, priznak: number, name: string, valutna?: boolean];
const ACCOUNTS: Acc[] = [
  [101, 0, 0, 'Основен капитал'], [122, 0, 0, 'Неразпределена печалба'], [123, 0, 0, 'Печалби и загуби от текущата година'],
  [201, 0, 0, 'Земи'], [203, 0, 0, 'Сгради'], [204, 0, 0, 'Машини и оборудване'], [205, 0, 0, 'Транспортни средства'],
  [241, 0, 0, 'Амортизация на ДМА'], [241, 1, 0, 'Амортизация на сгради'], [241, 2, 0, 'Амортизация на машини'], [241, 3, 0, 'Амортизация на транспортни средства'],
  [302, 0, 0, 'Материали'], [302, 1, 0, 'Основни материали'], [302, 1, QTY, 'Основни материали - количество'],
  [304, 0, 0, 'Стоки'], [304, 1, 0, 'Стоки - склад София'], [304, 2, 0, 'Стоки - склад Пловдив'], [304, 1, QTY, 'Стоки София - количество'], [304, 2, QTY, 'Стоки Пловдив - количество'],
  [401, 0, 0, 'Доставчици'], [401, 1, 0, 'Доставчици в страната'], [401, 2, 0, 'Доставчици от ЕС'],
  [411, 0, 0, 'Клиенти'], [411, 1, 0, 'Клиенти в страната'], [411, 2, 0, 'Клиенти от чужбина'],
  [421, 0, 0, 'Персонал'], [453, 0, 0, 'Разчети за ДДС'], [453, 1, 0, 'ДДС за покупките'], [453, 2, 0, 'ДДС за продажбите'],
  [501, 0, 0, 'Каса в лева'], [503, 0, 0, 'Разплащателни сметки'], [503, 1, 0, 'Банка ДСК'], [503, 2, 0, 'Обединена българска банка'],
  [504, 0, 0, 'Валутни сметки'], [504, 1, 0, 'Сметка в евро', true], [504, 2, 0, 'Сметка в долари', true], [504, 1, CUR, 'Сметка в евро - валута'], [504, 2, CUR, 'Сметка в долари - валута'],
  [601, 0, 0, 'Разходи за материали'], [602, 0, 0, 'Разходи за външни услуги'], [603, 0, 0, 'Разходи за амортизация'], [604, 0, 0, 'Разходи за заплати'],
  [624, 0, 0, 'Разходи от валутни операции'], [702, 0, 0, 'Приходи от продажби на стоки'], [703, 0, 0, 'Приходи от продажби на услуги'],
  [703, 0, 3, 'Приходи от услуги - обект'], [724, 0, 0, 'Приходи от валутни операции'],
];

/** Number as the new chart writes it (Acct / SubAcct / PriznakID, zero parts left out). */
const num = (acct: number, sub: number, priznak: number) => [String(acct), sub ? String(sub) : '', priznak ? String(priznak) : ''].filter(Boolean).join('/');
/** Acct / SubAcct / PriznakID of a chart number (account features such as 703/3 "Обект" are a PriznakID, not a SubAcct). */
const ACCOUNT_PARTS = new Map(ACCOUNTS.filter(([, , pr]) => pr === 0 || pr === 3).map(([a, sub, pr]) => [num(a, sub, pr), { Acct: a, SubAcct: sub, PriznakID: pr }]));
const parse = (n: string) => {
  const p = ACCOUNT_PARTS.get(n);
  if (!p) throw new Error(`pilot: no account ${n}`);
  return p;
};

/** Seeded PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Amounts in stotinki (integers), written as "123.45". */
const money = (st: number) => `${st < 0 ? '-' : ''}${Math.floor(Math.abs(st) / 100)}.${String(Math.abs(st) % 100).padStart(2, '0')}`;
const vatOf = (st: number, rate: number) => Math.round((st * rate) / 100);
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

const TOWNS = ['София', 'Пловдив', 'Варна', 'Бургас', 'Русе', 'Стара Загора', 'Плевен', 'Шумен'];
const NAMES = ['Алфа', 'Бета', 'Гама', 'Делта', 'Омега', 'Сигма', 'Вега', 'Орион', 'Нова', 'Рила', 'Пирин', 'Хемус', 'Странджа', 'Марица', 'Дунав', 'Искър'];
const FORMS = ['ООД', 'ЕООД', 'АД', 'ЕТ'];

/** A 9-digit EIK with a valid check digit. */
function eik(n: number) {
  const base = String(100000000 + (n * 7919) % 899999999).slice(0, 8);
  const ds = [...base].map(Number);
  let s = ds.reduce((acc, x, i) => acc + x * (i + 1), 0) % 11;
  if (s === 10) {
    s = ds.reduce((acc, x, i) => acc + x * (i + 3), 0) % 11;
    if (s === 10) s = 0;
  }
  return base + s;
}

export interface PilotPartner { id: number; name: string; bulstat: string; vat: string; kind: 'client' | 'foreign' | 'supplier' }

export interface PilotOptions { partners: number; entriesPerYear: number; seed?: number }

export interface Pilot { tables: JetTable[]; partners: PilotPartner[]; years: number[] }

export function buildDeltaPilot(o: PilotOptions): Pilot {
  const r = rng(o.seed ?? 20241);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const between = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

  // ---- partners (Part)
  const partners: PilotPartner[] = [];
  const part: Record<string, unknown>[] = [];
  for (let i = 1; i <= o.partners; i++) {
    const kind: PilotPartner['kind'] = i % 10 === 0 ? 'foreign' : i % 3 === 0 ? 'supplier' : 'client';
    const name = `${pick(NAMES)} ${i} ${pick(FORMS)}`;
    let bulstat = eik(i);
    let vat = `BG${bulstat}`;
    if (kind === 'foreign') {
      bulstat = '';
      vat = `DE${String(100000000 + i)}`;
    } else if (i % 17 === 0) {
      bulstat = '999999999'; // placeholder: matched by name
      vat = '';
    } else if (i % 7 === 0) vat = ''; // not VAT registered
    // A natural person: no firm name, only the person's name (Part.Partner) and no EIK.
    const person = kind === 'client' && i % 23 === 0;
    if (person) {
      bulstat = '';
      vat = '';
    }
    partners.push({ id: i, name: person ? `Иван Петров ${i}` : name, bulstat, vat, kind });
    part.push({
      ID: i, Company: person ? '' : name, Partner: person ? `Иван Петров ${i}` : `Лице ${i}`, Bulstat: bulstat, DanNo: vat, Town: pick(TOWNS), Addr: `ул. Тестова ${i}`, Tel_Fax: `02 ${100000 + i}`,
      Bank: i % 4 === 0 ? 'Банка ДСК' : '', BanAcct: i % 4 === 0 ? `BG${String(10 + (i % 89)).padStart(2, '0')}STSA9300${String(i).padStart(10, '0')}` : '', BanCode: i % 4 === 0 ? 'STSABGSF' : '',
      IsVeryUsed: i % 5,
    });
  }
  // Duplicate records of the same firm (same Bulstat and VAT number): merged by the conversion.
  const dupOf = partners.filter((p) => p.kind !== 'foreign' && p.bulstat && p.bulstat !== '999999999' && p.vat).slice(0, Math.max(2, Math.floor(o.partners / 40)));
  let nextPartId = o.partners + 1;
  const aliases = new Map<number, number>();
  for (const p of dupOf) {
    const id = nextPartId++;
    aliases.set(id, p.id);
    part.push({ ID: id, Company: `${p.name} (стар запис)`, Partner: '', Bulstat: p.bulstat, DanNo: p.vat, Town: '', Addr: '', Tel_Fax: '', Bank: '', BanAcct: '', BanCode: '', IsVeryUsed: 0 });
  }
  const clients = partners.filter((p) => p.kind === 'client');
  const foreign = partners.filter((p) => p.kind === 'foreign');
  const suppliers = partners.filter((p) => p.kind === 'supplier');
  /** A row's PartnerID: sometimes the duplicate record of the firm. */
  const partnerRef = (p: PilotPartner) => {
    for (const [alias, id] of aliases) if (id === p.id && r() < 0.3) return alias;
    return p.id;
  };

  // ---- years
  const years = [2024, 2025];
  const tables: JetTable[] = [
    { name: 'System', columns: SYSTEM_COLUMNS, rows: [{ Company: 'Пилот Търговия ООД', Bulstat: '175074752', Partner: 'Георги Георгиев', VatID: 'BG175074752', City: 'София', Phone: '02 9876543', Address: 'бул. България 100', Bank: 'Банка ДСК', BankAcct: 'BG80STSA93000012345678' }] },
    { name: 'Priznaci', columns: PRIZNACI_COLUMNS, rows: PRIZNACI },
    { name: 'Accts', columns: ACCTS_COLUMNS, rows: ACCOUNTS.map(([Acct, SubAcct, PriznakID, Name, v], i) => ({ AcctID: i + 1, Acct, SubAcct, PriznakID, Name, IsValutna: !!v })) },
    { name: 'Part', columns: PART_COLUMNS, rows: part },
    // An old year: not converted (before 2008).
    { name: 'Year2007', columns: YEAR_COLUMNS, rows: [] },
  ];

  /** Running balances per account and partner (for the next year's openings and for payments). */
  const open = new Map<string, number>();
  const bal = (account: string, partner = 0) => open.get(`${account}|${partner}`) ?? 0;
  const book = (account: string, partner: number, st: number) => open.set(`${account}|${partner}`, bal(account, partner) + st);
  /** Unpaid documents per partner (client receivables / supplier payables). */
  const receivable = new Map<number, number>();
  const payable = new Map<number, number>();

  for (const year of years) {
    const rows: Record<string, unknown>[] = [];
    let kon = 0;
    const DEBIT = 2;
    const CREDIT = 1;
    interface Leg { account: string; side: 1 | 2; st: number; partner?: number; feature?: number; qty?: number; /** PartnerID written as is (0 or a deleted partner). */ rawPartner?: number }
    const entry = (date: Date, head: { doc?: string; type: string; term: string; note?: string; isPokupka?: number; oper?: number; vies?: Date }, legs: Leg[]) => {
      const konId = ++kon;
      let k = 0;
      const sumD = legs.filter((l) => l.side === DEBIT && !l.feature).reduce((a, l) => a + l.st, 0);
      const sumC = legs.filter((l) => l.side === CREDIT && !l.feature).reduce((a, l) => a + l.st, 0);
      if (sumD !== sumC) throw new Error(`pilot entry ${konId} unbalanced ${sumD} ${sumC}`);
      for (const l of legs) {
        const { Acct, SubAcct, PriznakID } = parse(l.account);
        const feature = l.feature ?? PriznakID;
        rows.push({
          KonID: konId, Kon: ++k, Acct, SubAcct, PriznakID: feature, Date: date, DocDate: date, FakNo: head.doc ?? '', DocType: head.type,
          Osnovanie: head.term, Note: head.note ?? '', IsPokupka: head.isPokupka ?? 0, VIESCol: 0, VIESDate: head.vies ?? (head.isPokupka ? date : null),
          OperType: head.oper ?? 0, IsKredit: l.side,
          // Credit rows carry the amount negative; quantity / currency rows carry the quantity.
          Qtty: l.feature ? (l.side === CREDIT ? -(l.qty ?? 0) : (l.qty ?? 0)) : money(l.side === CREDIT ? -l.st : l.st),
          StartDebit: 0, StartKredit: 0, PartnerID: l.rawPartner ?? (l.partner ? partnerRef(partners[l.partner - 1]!) : 0),
        });
        if (!l.feature) {
          const real = l.partner ?? 0;
          book(l.account, isPartnerAccount(l.account) ? real : 0, l.side === DEBIT ? l.st : -l.st);
        }
      }
    };

    // Opening balances of the year (KonID 0).
    if (year === years[0]) {
      const start: [string, number, number, { doc?: string; date?: Date }?][] = [
        ['101', 0, -5_000_000], ['122', 0, -1_234_500], ['501', 0, 845_000], ['503/1', 0, 3_120_000], ['503/2', 0, 980_000], ['504/1', 0, 1_955_830],
        ['201', 0, 1_500_000], ['203', 0, 4_800_000], ['204', 0, 1_250_000], ['205', 0, 600_000],
        ['241/1', 0, -960_000], ['241/2', 0, -500_000], ['241/3', 0, -240_000], ['304/1', 0, 1_100_000], ['304/2', 0, 650_000], ['302/1', 0, 230_000],
      ];
      let rest = start.reduce((a, s) => a + s[2], 0);
      // Partner balances per invoice of the previous year.
      for (const p of clients.slice(0, Math.ceil(clients.length / 3))) {
        const st = between(20_000, 600_000);
        start.push(['411/1', p.id, st, { doc: String(2023000000 + p.id), date: d(2023, between(9, 12), between(1, 28)) }]);
        rest += st;
        receivable.set(p.id, (receivable.get(p.id) ?? 0) + st);
      }
      for (const p of suppliers.slice(0, Math.ceil(suppliers.length / 3))) {
        const st = between(10_000, 300_000);
        start.push(['401/1', p.id, -st, { doc: `D${p.id}`, date: d(2023, 12, between(1, 28)) }]);
        rest -= st;
        payable.set(p.id, (payable.get(p.id) ?? 0) + st);
      }
      start.push(['123', 0, -rest]);
      for (const [account, partner, st, doc] of start) {
        const { Acct, SubAcct } = parse(account);
        rows.push({
          KonID: 0, Kon: 0, Acct, SubAcct, PriznakID: 0, StartDebit: st > 0 ? money(st) : 0, StartKredit: st < 0 ? money(-st) : 0,
          PartnerID: partner ? partnerRef(partners[partner - 1]!) : 0, FakNo: doc?.doc ?? '', DocType: doc?.doc ? 'Ф-ра' : '', DocDate: doc?.date ?? null,
        });
        book(account, partner, st);
      }
      // Opening quantities of the goods (quantity feature): not converted.
      rows.push({ KonID: 0, Kon: 0, Acct: 304, SubAcct: 1, PriznakID: QTY, StartDebit: 5500, StartKredit: 0 });
    } else {
      // The next year opens with the previous year's closing balances, per account and partner.
      for (const [key, st] of [...open.entries()].sort()) {
        if (!st) continue;
        const [account, partner] = key.split('|') as [string, string];
        const { Acct, SubAcct, PriznakID } = parse(account);
        rows.push({ KonID: 0, Kon: 0, Acct, SubAcct, PriznakID, StartDebit: st > 0 ? money(st) : 0, StartKredit: st < 0 ? money(-st) : 0, PartnerID: Number(partner) || 0 });
      }
    }

    let invoiceNo = (year - 2000) * 100000;
    const nextDoc = () => String(++invoiceNo).padStart(10, '0');
    const day = (m: number) => d(year, m, between(1, 28));
    for (let i = 0; i < o.entriesPerYear; i++) {
      const m = 1 + Math.floor((i / o.entriesPerYear) * 12);
      const date = day(m);
      const roll = r();
      if (roll < 0.02) {
        // Retail sale on the clients' account without a partner (PartnerID 0) or with a deleted partner: "Служебен партньор".
        const base = between(1_000, 30_000);
        const vat = vatOf(base, 20);
        const raw = r() < 0.7 ? 0 : 99_999;
        entry(date, { doc: nextDoc(), type: 'Ф-ра', term: 'Продажба на дребно', isPokupka: 2, oper: 16 }, [
          { account: '411/1', side: DEBIT, st: base + vat, rawPartner: raw }, { account: '702', side: CREDIT, st: base }, { account: '453/2', side: CREDIT, st: vat },
        ]);
      } else if (roll < 0.30) {
        // Sale invoice: 20 % (most), 9 %, 0 %, exempt.
        const p = pick(clients);
        const base = between(5_000, 800_000);
        const kind = r();
        const [oper, rate] = kind < 0.75 ? [16, 20] : kind < 0.87 ? [20, 9] : kind < 0.94 ? [21, 0] : [26, 0];
        const vat = vatOf(base, rate);
        const service = r() < 0.3;
        const legs: Leg[] = [{ account: '411/1', side: DEBIT, st: base + vat, partner: p.id }, { account: service ? '703/3' : '702', side: CREDIT, st: base }];
        if (vat) legs.push({ account: '453/2', side: CREDIT, st: vat });
        entry(date, { doc: nextDoc(), type: 'Ф-ра', term: service ? 'Продажба на услуги' : 'Продажба на стоки', isPokupka: 2, oper }, legs);
        receivable.set(p.id, (receivable.get(p.id) ?? 0) + base + vat);
        if (!service) {
          // Cost of the goods sold, with the quantity row.
          const store = r() < 0.6 ? '304/1' : '304/2';
          const cost = Math.round(base * 0.7);
          entry(date, { type: 'МО', term: 'Изписване на стоки' }, [{ account: '702', side: DEBIT, st: cost }, { account: store, side: CREDIT, st: cost }, { account: store, side: CREDIT, st: 0, feature: QTY, qty: between(1, 40) }]);
        }
      } else if (roll < 0.34) {
        // Intra-community supply to a foreign client (no VAT).
        const p = pick(foreign);
        const base = between(50_000, 900_000);
        entry(date, { doc: nextDoc(), type: 'Ф-ра', term: 'ВОД', isPokupka: 2, oper: 22 }, [{ account: '411/2', side: DEBIT, st: base, partner: p.id }, { account: '702', side: CREDIT, st: base }]);
        receivable.set(p.id, (receivable.get(p.id) ?? 0) + base);
      } else if (roll < 0.37) {
        // Credit note as red storno (negative amounts).
        const p = pick(clients);
        const base = between(1_000, 50_000);
        const vat = vatOf(base, 20);
        entry(date, { doc: nextDoc(), type: 'КИ', term: 'Кредитно известие', isPokupka: 2, oper: 16 }, [
          { account: '411/1', side: DEBIT, st: -(base + vat), partner: p.id }, { account: '702', side: CREDIT, st: -base }, { account: '453/2', side: CREDIT, st: -vat },
        ]);
        receivable.set(p.id, (receivable.get(p.id) ?? 0) - base - vat);
      } else if (roll < 0.58) {
        // Purchase invoice: goods, materials or services; full (most), partial or no tax credit.
        const p = pick(suppliers);
        const base = between(5_000, 500_000);
        const kind = r();
        const what = r();
        const account = what < 0.45 ? (r() < 0.6 ? '304/1' : '304/2') : what < 0.65 ? '302/1' : '602';
        // Suppliers' own numbers: different suppliers may use the same number.
        const doc = r() < 0.05 ? '0000000001' : `${String(between(1, 9999999)).padStart(10, '0')}`;
        // Some purchases are declared in the next month (the next year for December).
        const vies = r() < 0.12 ? d(m === 12 ? year + 1 : year, m === 12 ? 1 : m + 1, 1) : undefined;
        if (kind < 0.85) {
          const vat = vatOf(base, 20);
          const legs: Leg[] = [{ account, side: DEBIT, st: base }, { account: '453/1', side: DEBIT, st: vat }, { account: '401/1', side: CREDIT, st: base + vat, partner: p.id }];
          if (account !== '602') legs.push({ account, side: DEBIT, st: 0, feature: QTY, qty: between(1, 100) });
          entry(date, { doc, type: 'Ф-ра', term: 'Покупка', isPokupka: 1, oper: 12, vies }, legs);
          payable.set(p.id, (payable.get(p.id) ?? 0) + base + vat);
        } else if (kind < 0.93) {
          const vat = vatOf(base, 20);
          entry(date, { doc, type: 'Ф-ра', term: 'Покупка с частичен кредит', isPokupka: 1, oper: 13, vies }, [
            { account: '602', side: DEBIT, st: base }, { account: '453/1', side: DEBIT, st: vat }, { account: '401/1', side: CREDIT, st: base + vat, partner: p.id },
          ]);
          payable.set(p.id, (payable.get(p.id) ?? 0) + base + vat);
        } else {
          const total = base + vatOf(base, 20);
          entry(date, { doc, type: 'Ф-ра', term: 'Покупка без право на кредит', isPokupka: 1, oper: 11, vies }, [{ account: '602', side: DEBIT, st: total }, { account: '401/1', side: CREDIT, st: total, partner: p.id }]);
          payable.set(p.id, (payable.get(p.id) ?? 0) + total);
        }
      } else if (roll < 0.72) {
        // Bank receipt from one client, or one receipt for several clients.
        const owing = [...receivable.entries()].filter(([id, st]) => st > 100 && partners[id - 1]!.kind === 'client');
        if (!owing.length) continue;
        const several = r() < 0.2 && owing.length > 2;
        const take = several ? [pick(owing), pick(owing)].filter((x, k, a) => a.findIndex((y) => y[0] === x[0]) === k) : [pick(owing)];
        const legs: Leg[] = take.map(([id, st]) => ({ account: '411/1', side: CREDIT, st: r() < 0.7 ? st : Math.max(1, Math.round(st / 2)), partner: id }));
        const total = legs.reduce((a, l) => a + l.st, 0);
        entry(date, { type: 'ПН', term: several ? 'Плащания по фактури' : 'Плащане по фактура' }, [{ account: r() < 0.7 ? '503/1' : '503/2', side: DEBIT, st: total }, ...legs]);
        for (const l of legs) receivable.set(l.partner!, receivable.get(l.partner!)! - l.st);
      } else if (roll < 0.82) {
        // Payment to a supplier.
        const owing = [...payable.entries()].filter(([, st]) => st > 100);
        if (!owing.length) continue;
        const [id, st] = pick(owing);
        const amount = r() < 0.8 ? st : Math.round(st / 3);
        entry(date, { type: 'ПН', term: 'Плащане към доставчик' }, [{ account: '401/1', side: DEBIT, st: amount, partner: id }, { account: '503/1', side: CREDIT, st: amount }]);
        payable.set(id, st - amount);
      } else if (roll < 0.88) {
        // Cash: receipt (ПКО without a number: the series numbers it) or payment (РКО).
        if (r() < 0.6) {
          const owing = [...receivable.entries()].filter(([id, st]) => st > 100 && partners[id - 1]!.kind === 'client');
          if (!owing.length) continue;
          const [id, st] = pick(owing);
          const amount = Math.min(st, between(1_000, 200_000));
          entry(date, { type: 'ПКО', term: 'Плащане в брой' }, [{ account: '501', side: DEBIT, st: amount }, { account: '411/1', side: CREDIT, st: amount, partner: id }]);
          receivable.set(id, st - amount);
        } else {
          const owing = [...payable.entries()].filter(([, st]) => st > 100);
          if (!owing.length) continue;
          const [id, st] = pick(owing);
          const amount = Math.min(st, between(1_000, 100_000));
          entry(date, { doc: String(between(1, 99999)), type: 'РКО', term: 'Плащане в брой' }, [{ account: '401/1', side: DEBIT, st: amount, partner: id }, { account: '501', side: CREDIT, st: amount }]);
          payable.set(id, st - amount);
        }
      } else if (roll < 0.93) {
        // Foreign client pays in euro (currency amount row), or an exchange difference.
        const owing = [...receivable.entries()].filter(([id, st]) => st > 100 && partners[id - 1]!.kind === 'foreign');
        if (owing.length && r() < 0.7) {
          const [id, st] = pick(owing);
          entry(date, { type: 'БИ', term: 'Получено плащане в евро' }, [
            { account: '504/1', side: DEBIT, st }, { account: '504/1', side: DEBIT, st: 0, feature: CUR, qty: Math.round(st / 195.583) / 100 }, { account: '411/2', side: CREDIT, st, partner: id },
          ]);
          receivable.set(id, 0);
        } else {
          const st = between(100, 20_000);
          if (r() < 0.5) entry(date, { type: 'МО', term: 'Курсова разлика' }, [{ account: '504/2', side: DEBIT, st }, { account: '724', side: CREDIT, st }]);
          else entry(date, { type: 'МО', term: 'Курсова разлика' }, [{ account: '624', side: DEBIT, st }, { account: '504/2', side: CREDIT, st }]);
        }
      } else if (roll < 0.96) {
        // Materials used in production (quantity row).
        const st = between(1_000, 80_000);
        entry(date, { type: 'МО', term: 'Вложени материали' }, [{ account: '601', side: DEBIT, st }, { account: '302/1', side: CREDIT, st }, { account: '302/1', side: CREDIT, st: 0, feature: QTY, qty: between(1, 20) }]);
      } else {
        // Fixed asset bought from a supplier.
        const p = pick(suppliers);
        const base = between(200_000, 2_000_000);
        const vat = vatOf(base, 20);
        entry(date, { doc: String(between(1, 9999999)).padStart(10, '0'), type: 'Ф-ра', term: 'Придобиване на ДМА', isPokupka: 1, oper: 12 }, [
          { account: r() < 0.6 ? '204' : '205', side: DEBIT, st: base }, { account: '453/1', side: DEBIT, st: vat }, { account: '401/1', side: CREDIT, st: base + vat, partner: p.id },
        ]);
        payable.set(p.id, (payable.get(p.id) ?? 0) + base + vat);
      }
    }
    // Monthly: depreciation (1:n) and salaries.
    for (let m = 1; m <= 12; m++) {
      const end = d(year, m, 28);
      entry(end, { type: 'МО', term: `Амортизации ${m}.${year}` }, [
        { account: '603', side: DEBIT, st: 20_000 + 10_416 + 5_000 }, { account: '241/1', side: CREDIT, st: 20_000 }, { account: '241/2', side: CREDIT, st: 10_416 }, { account: '241/3', side: CREDIT, st: 5_000 },
      ]);
      const gross = 1_850_000 + m * 1_000;
      entry(end, { type: 'ВнБ', term: `Заплати ${m}.${year}` }, [{ account: '604', side: DEBIT, st: gross }, { account: '421', side: CREDIT, st: gross }]);
      entry(end, { type: 'ПН', term: `Изплатени заплати ${m}.${year}` }, [{ account: '421', side: DEBIT, st: gross }, { account: '503/1', side: CREDIT, st: gross }]);
    }
    // Year end: the result accounts close into 123 (1:n and n:1).
    const yearEnd = d(year, 12, 31);
    const expenses = ['601', '602', '603', '604', '624'].map((a) => ({ a, st: bal(a) })).filter((x) => x.st > 0);
    const incomes = ['702', '703/3', '724'].map((a) => ({ a, st: -bal(a) })).filter((x) => x.st > 0);
    if (expenses.length) {
      const total = expenses.reduce((acc, x) => acc + x.st, 0);
      entry(yearEnd, { type: 'МО', term: 'Приключване на разходите' }, [{ account: '123', side: DEBIT, st: total }, ...expenses.map((x): Leg => ({ account: x.a, side: CREDIT, st: x.st }))]);
    }
    if (incomes.length) {
      const total = incomes.reduce((acc, x) => acc + x.st, 0);
      entry(yearEnd, { type: 'МО', term: 'Приключване на приходите' }, [...incomes.map((x): Leg => ({ account: x.a, side: DEBIT, st: x.st })), { account: '123', side: CREDIT, st: total }]);
    }
    tables.push({ name: `Year${year}`, columns: YEAR_COLUMNS, rows });
  }
  return { tables, partners, years };
}

const PARTNER_PREFIXES = ['401', '411'];
const isPartnerAccount = (n: string) => PARTNER_PREFIXES.some((p) => n === p || n.startsWith(`${p}/`));

// ---------------------------------------------------------------------------
// Source totals: queries over the legacy tables (independent of the conversion code).

export interface SourceAccountTotals { od: number; oc: number; dt: number; ct: number }
export interface SourceYear {
  year: number;
  /** Leaf accounts (stotinki): opening net debit/credit and turnovers. */
  accounts: Map<string, SourceAccountTotals>;
  /** Accountings (KonID groups with amount rows). */
  accountings: number;
  /** Sales diary columns 9..25 and purchases diary columns 9..15 per month ("2024-03"), stotinki. */
  sales: Map<string, number[]>;
  purchases: Map<string, number[]>;
  /** Closing balance (net, debit positive) per partner firm and account group ('411' / '401'), stotinki. */
  partnerClosing: Map<string, number>;
  /** Quantity / currency-amount rows (not converted): sum per account. */
  quantities: Map<string, number>;
}

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/** The Delta OperType -> VAT term table of 04a 7.2 (spec), written out here on purpose. */
const OPER_TO_TERM = (op: number) => (op <= 10 ? 1 : op === 11 ? 3 : op === 12 ? 2 : op - 9);

/** Firm key of a Part row: Bulstat (not the placeholder), else VAT number, else the name (the de-duplication rule of 04a 7). */
export function firmKey(part: Record<string, unknown>) {
  const b = String(part.Bulstat ?? '').trim();
  const v = String(part.DanNo ?? '').trim();
  if (b && b !== '999999999') return `b:${b}`;
  if (v) return `v:${v}`;
  return `n:${String(part.Company ?? '').trim() || String(part.Partner ?? '').trim()}`;
}

export function sourceTotals(tables: JetTable[]): SourceYear[] {
  const priznaci = tables.find((t) => t.name === 'Priznaci')!.rows;
  const accountFeature = new Set(priznaci.filter((p) => Number(p.Type) === 0).map((p) => Number(p.PriznakID)));
  const part = tables.find((t) => t.name === 'Part')!.rows;
  const firmOf = new Map(part.map((p) => [Number(p.ID), firmKey(p)]));
  const out: SourceYear[] = [];
  for (const t of tables.filter((x) => /^Year\d{4}$/.test(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const year = Number(t.name.slice(4));
    if (year < 2008 || year > 2025) continue;
    const y: SourceYear = { year, accounts: new Map(), accountings: 0, sales: new Map(), purchases: new Map(), partnerClosing: new Map(), quantities: new Map() };
    const acc = (n: string) => {
      let a = y.accounts.get(n);
      if (!a) y.accounts.set(n, (a = { od: 0, oc: 0, dt: 0, ct: 0 }));
      return a;
    };
    const firm = (n: string, partnerId: number, st: number) => {
      const group = PARTNER_PREFIXES.find((p) => n === p || n.startsWith(`${p}/`));
      if (!group) return;
      // Rows without a (known) partner go to "Служебен партньор" (Bulstat 123456786).
      const key = `${firmOf.get(partnerId) ?? 'b:123456786'}|${group}`;
      y.partnerClosing.set(key, (y.partnerClosing.get(key) ?? 0) + st);
    };
    const kons = new Map<number, Record<string, unknown>[]>();
    for (const row of t.rows) {
      const pr = Number(row.PriznakID ?? 0);
      const n = num(Number(row.Acct), Number(row.SubAcct ?? 0), pr);
      if (!accountFeature.has(pr)) {
        y.quantities.set(n, (y.quantities.get(n) ?? 0) + Number(row.Qtty ?? 0) + Number(row.StartDebit ?? 0) - Number(row.StartKredit ?? 0));
        continue;
      }
      const sd = Math.abs(cents(row.StartDebit));
      const sk = Math.abs(cents(row.StartKredit));
      if (sd || sk) {
        const a = acc(n);
        if (sd > sk) a.od += sd - sk;
        else a.oc += sk - sd;
        firm(n, Number(row.PartnerID ?? 0), sd - sk);
      }
      const konId = Number(row.KonID ?? 0);
      if (konId) kons.set(konId, [...(kons.get(konId) ?? []), row]);
    }
    for (const rows of kons.values()) {
      let any = false;
      const head = rows[0]!;
      const month = (head.VIESDate instanceof Date ? head.VIESDate : (head.Date as Date)).toISOString().slice(0, 7);
      const isPokupka = Number(head.IsPokupka ?? 0);
      for (const row of rows) {
        const side = Number(row.IsKredit);
        const st = side === 2 ? cents(row.Qtty) : -cents(row.Qtty);
        if ((side !== 1 && side !== 2) || !st) continue;
        any = true;
        const n = num(Number(row.Acct), Number(row.SubAcct ?? 0), Number(row.PriznakID ?? 0));
        const a = acc(n);
        if (side === 2) a.dt += st;
        else a.ct += st;
        firm(n, Number(row.PartnerID ?? 0) || Number(rows.find((x) => Number(x.PartnerID))?.PartnerID ?? 0), side === 2 ? st : -st);
        // VAT diaries (05/02b): sales take the credit rows of a sale, purchases the debit rows of a purchase.
        const term = OPER_TO_TERM(Number(row.OperType ?? 0));
        const isVat453 = (sub: number) => Number(row.Acct) === 453 && Number(row.SubAcct) === sub;
        if (isPokupka === 2 && side === 1) {
          const cols = y.sales.get(month) ?? Array(17).fill(0);
          const vat = isVat453(2);
          const add = (col: number) => (cols[col - 9] += st);
          const special = [15, 16, 17, 18].includes(term);
          if (!vat && !special) add(9);
          if (vat && !special) add(10);
          if (term === 7) add(vat ? 12 : 11);
          if (term === 11) add(vat ? 18 : 17);
          if (term === 12 && !vat) add(19);
          if (term === 13 && !vat) add(20);
          if (term === 17 && !vat) add(24);
          y.sales.set(month, cols);
        }
        if (isPokupka === 1 && side === 2) {
          const cols = y.purchases.get(month) ?? Array(7).fill(0);
          const vat = isVat453(1);
          const add = (col: number) => (cols[col - 9] += st);
          if (term === 3) add(9);
          if (term === 2) add(vat ? 11 : 10);
          if (term === 4) add(vat ? 13 : 12);
          y.purchases.set(month, cols);
        }
      }
      if (any) y.accountings++;
    }
    out.push(y);
  }
  return out;
}

export const stotinki = (s: string | number) => Math.round(Number(s) * 100);
