/**
 * Volume seed: a busy VAT-registered trading company for performance work.
 *
 *   node apps/server/scripts/seed-volume.ts [--entries=100000] [--partners=2000]
 *     [--assets=300] [--products=150] [--users=4] [--name="Обемна Фирма ООД"] [--seed=1]
 *     [--data-dir=apps/server/.data-perf]
 *
 * Storage: PGlite on disk under DATA_DIR (default apps/server/.data-perf), or
 * the Postgres server of DATABASE_URL. Prints the database name at the end;
 * perf.ts takes it with --db (or uses the newest company of the data dir).
 *
 * The data goes through the application, as a user would create it:
 *  - company, users, partners, products, the USD bank account, fixed assets,
 *    monthly depreciation, stock write-offs, VAT closing, the 2025 closing of
 *    the result accounts and the euro conversion (2025 BGN -> 2026 EUR,
 *    POST /euro-conversion with the fixed assets) through the HTTP API;
 *  - the journal entries through services/journal.ts saveEntry (the editor's
 *    save path with every validation, numbering and VAT check) in batches of
 *    one transaction, and their payment allocations through
 *    services/openItems.ts insertPaymentLinks (what "Обвързване" writes).
 *
 * Mix of the ~N entries (21 months, 2025-01 .. 2026-09): sales invoices with
 * VAT (20 %, 9 %, ВОД 0 %), a third of them with goods (quantities), purchase
 * invoices (services, goods with quantities, fixed assets), bank and cash
 * payments bound to the oldest open invoice of the partner (some partial,
 * some advance payments left unbound, some invoices never paid), USD bank
 * lines with currency amounts, payroll and bank fees. On top: one
 * depreciation entry per asset and month, a write-off per product and month,
 * the monthly VAT closing.
 */
import { sql } from 'drizzle-orm';
import { dec, isValidEik, round2, type Dec } from '@shmi/core';
import { queryRows, type CompanyDb } from '../src/db/provider.ts';
import type { ActiveYear } from '../src/context.ts';
import { saveEntry, type EntryInput, type LineInput } from '../src/services/journal.ts';
import { insertPaymentLinks, openItems } from '../src/services/openItems.ts';
import { acquireTestSlot } from '../../../scripts/test-slots.ts';
import { apiClient, fmtMs, openDriver, parseArgs, rng } from './lib.ts';

const o = parseArgs();
const N = Number(o.entries ?? 100_000);
const PARTNERS = Number(o.partners ?? 2000);
const ASSETS = Number(o.assets ?? 300);
const PRODUCTS = Number(o.products ?? 150);
const USERS = Number(o.users ?? 4);
const COMPANY = o.name ?? 'Обемна Фирма ООД';
const BATCH = Number(o.batch ?? 250);
const R = rng(Number(o.seed ?? 1));
const BGN_PER_EUR = 1.95583;

const MONTHS: string[] = [];
for (let m = 1; m <= 12; m++) MONTHS.push(`2025-${String(m).padStart(2, '0')}`);
for (let m = 1; m <= 9; m++) MONTHS.push(`2026-${String(m).padStart(2, '0')}`);
const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);

const t0 = performance.now();
const log = (msg: string) => console.log(`[${fmtMs(performance.now() - t0).padStart(8)}] ${msg}`);

const release = await acquireTestSlot(`seed-volume (pid ${process.pid})`);
const driver = openDriver(o['data-dir']);
const api = apiClient(driver);

/* ------------------------------------------------------------------ */
/* Company, users, master data                                          */
/* ------------------------------------------------------------------ */

// A data dir with companies only lets a logged-in user create one: log in to an earlier seeded company.
const existing = (await api.must<{ name: string }[]>('GET', '/companies'));
for (const c of existing) {
  if ((await api.call('POST', '/login', { companyDb: c.name, userId: 1, password: 'secret1' })).status === 200) break;
}
const created = await api.must<{ name: string }>('POST', '/companies', {
  companyName: COMPANY, adminName: 'Администратор', adminPassword: 'secret1', year: 2025, chartTemplate: 'commercial', bulstat: '831641791',
});
const dbName = created.name;
const db: CompanyDb = await driver.company(dbName);
log(`company ${dbName} (${COMPANY})`);

await api.must('PUT', '/my-company', {
  name: COMPANY, bulstat: '831641791', vatId: 'BG831641791', isVat: true, accountant: 'Мария Иванова',
  vatDeclarationSubscriberName: 'Иван Петров', vatDeclarationSubscriberEgn: '7501010010', vatDeclarationSubscriberRole: 1,
  addresses: [{ city: 'София', address: 'бул. Витоша 1', postalCode: '1000' }], bankAccounts: [],
});

const userIds = [1];
for (let i = 1; i < USERS; i++) {
  const r = await api.must<{ id: number }>('POST', '/users', { name: `Счетоводител ${i}`, password: 'secret1', roleId: 3 + ((i - 1) % 3), force: true });
  userIds.push(r.id);
}

type Acc = { id: number; number: string; productId: number | null; productAccountType?: number | null; isEuro?: boolean };
let accounts: Acc[] = [];
const reloadAccounts = async () => { accounts = await api.must('GET', '/accounts'); };
const acc = (n: string) => {
  const a = accounts.find((x) => x.number === n);
  if (!a) throw new Error(`No account ${n}`);
  return a.id;
};
await reloadAccounts();

// The commercial template attaches no category to 304/702 (01a 6.3): the user assigns them before defining goods.
for (const [n, cat] of [['304', 3], ['702', 24]] as const) await api.must('PUT', `/accounts/${acc(n)}`, { accountCategoryId: cat });
await api.must('POST', '/accounts', { parentId: acc('504'), description: 'Разплащателна сметка в USD', accountCategoryId: 27, currencyId: 3 });

const products: { id: number; cost: number; stock: number; body: Record<string, unknown> }[] = [];
for (let i = 1; i <= PRODUCTS; i++) {
  const body = { name: `Стока ${String(i).padStart(4, '0')}`, code: `P${String(i).padStart(5, '0')}`, measure: R.chance(0.7) ? 'бр.' : 'кг' };
  const r = await api.must<{ id: number }>('POST', '/products', { ...body, incrementAccountIds: [acc('304')], decrementAccountIds: [acc('702')] });
  products.push({ id: r.id, cost: R.int(200, 20_000) / 100, stock: 0, body });
}
await reloadAccounts();
log(`${USERS} users, ${PRODUCTS} products`);

/** A valid 9-digit EIK (Булстат) for partner i. */
function eik(i: number) {
  const base = String(100_000_00 + i * 37).slice(0, 8);
  for (let d = 0; d <= 9; d++) if (isValidEik(base + d)) return base + d;
  return base + '0';
}
const WORDS = ['Алфа', 'Бета', 'Гама', 'Делта', 'Витоша', 'Родопи', 'Странджа', 'Пирин', 'Дунав', 'Марица', 'Искър', 'Тракия', 'Балкан', 'Янтра', 'Черноморец', 'Струма', 'Огоста', 'Камчия'];
const KINDS = ['Трейд', 'Строй', 'Логистик', 'Консулт', 'Инвест', 'Агро', 'Мед', 'Тех', 'Транс', 'Енерджи', 'Фууд', 'Принт'];
const FORMS = ['ЕООД', 'ООД', 'АД', 'ЕТ'];
type Partner = { id: number; client: boolean; supplier: boolean; eu: boolean };
const partners: Partner[] = [];
const tp = performance.now();
for (let i = 1; i <= PARTNERS; i++) {
  const roll = R.next();
  const client = roll < 0.6 || roll >= 0.9;
  const supplier = roll >= 0.55;
  const eu = R.chance(0.04);
  const bulstat = eu ? null : eik(i);
  const isVat = eu || R.chance(0.75);
  const vatNumber = eu ? `DE${String(100_000_000 + i * 7919).slice(0, 9)}` : isVat ? `BG${bulstat}` : null;
  const accountIds = [...(client ? [acc('411')] : []), ...(supplier ? [acc('401')] : [])];
  const r = await api.must<{ id: number }>('POST', '/partners', {
    name: `${R.pick(WORDS)} ${R.pick(KINDS)} ${i} ${R.pick(FORMS)}`, bulstat, vatNumber, isVat, accountIds,
    dueDays: R.pick([0, 7, 14, 30, 60]), contactName: `Лице ${i}`,
    addresses: [{ city: R.pick(['София', 'Пловдив', 'Варна', 'Бургас', 'Русе', 'Стара Загора']), address: `ул. ${R.pick(WORDS)} ${R.int(1, 200)}`, postalCode: String(R.int(1000, 9999)), countryId: eu ? null : 1 }],
  });
  partners.push({ id: r.id, client, supplier, eu });
}
const clients = partners.filter((p) => p.client);
const suppliers = partners.filter((p) => p.supplier);
const euClients = clients.filter((p) => p.eu);
const bgClients = clients.filter((p) => !p.eu);
log(`${PARTNERS} partners (${clients.length} clients, ${suppliers.length} suppliers) in ${fmtMs(performance.now() - tp)}`);

/* ------------------------------------------------------------------ */
/* Journal                                                              */
/* ------------------------------------------------------------------ */

async function activeYear(year: number): Promise<ActiveYear> {
  await api.must('PUT', '/years/active', { year, force: true });
  const [fy] = await queryRows<{ id: number; year: number; start_date: string; is_concluded: boolean }>(db, sql`SELECT id, year, start_date::text, is_concluded FROM financial_years WHERE year = ${year}`);
  return { id: fy!.id, year: fy!.year, startDate: fy!.start_date, isLocked: false, lockedMonths: 0, isConcluded: fy!.is_concluded };
}

/** Accounts of the year's chart by number (the EUR chart from 2026). */
async function chartOf(year: number) {
  await reloadAccounts();
  const byNumber = new Map(accounts.map((a) => [a.number, a.id]));
  const id = (n: string) => {
    const v = byNumber.get(n);
    if (!v) throw new Error(`No account ${n} in the ${year} chart`);
    return v;
  };
  const stock = new Map<number, { inc: number; dec: number }>();
  for (const a of accounts) {
    if (!a.productId) continue;
    const e = stock.get(a.productId) ?? { inc: 0, dec: 0 };
    if (a.number.startsWith('304/')) e.inc = a.id;
    if (a.number.startsWith('702/')) e.dec = a.id;
    stock.set(a.productId, e);
  }
  return { id, stock };
}

type OpenInvoice = { accountingId: number; remaining: Dec; accountId: number };
/** Open invoices per partner and side, oldest first (what the payments bind to). */
const openQueue = new Map<string, OpenInvoice[]>();
const qKey = (side: 'c' | 's', companyId: number) => `${side}:${companyId}`;
const pushOpen = (side: 'c' | 's', companyId: number, inv: OpenInvoice) => {
  const k = qKey(side, companyId);
  const list = openQueue.get(k) ?? [];
  list.push(inv);
  openQueue.set(k, list);
};

let ownInvoice = 0;
const counters = { entries: 0, links: 0, failed: 0 };
const failures = new Map<string, number>();

interface Planned { input: EntryInput; userId: number; after?: (id: number, documentId: number | null) => Promise<void> }

const money = (v: number, euro: boolean) => (euro ? v / BGN_PER_EUR : v);
const amt = (v: number | Dec) => round2(dec(v)).toFixed(2);

function planMonth(ym: string, count: number, euro: boolean, C: Awaited<ReturnType<typeof chartOf>>, assetsThisMonth: AssetPlan[]): Planned[] {
  const out: Planned[] = [];
  const day = () => `${ym}-${String(R.int(1, 28)).padStart(2, '0')}`;
  const user = () => R.pick(userIds);
  const vatTermSale = () => (R.chance(0.88) ? 7 : 11);
  const add = (p: Planned) => out.push(p);

  // Payroll: once a month, a few lines.
  const payroll = money(R.int(40_000, 60_000), euro);
  const end = lastDay(ym);
  add({ userId: 1, input: { accountingDate: end, documentTypeId: 10, documentNumber: '', term: 'Начисляване на заплати', debits: [{ accountId: C.id('604/1'), amount: amt(payroll) }], credits: [{ accountId: C.id('421'), amount: amt(payroll) }] } });
  add({ userId: 1, input: { accountingDate: end, documentTypeId: 10, documentNumber: '', term: 'Начисляване на осигуровки', debits: [{ accountId: C.id('605/1'), amount: amt(payroll * 0.19) }], credits: [{ accountId: C.id('461/1'), amount: amt(payroll * 0.19) }] } });

  // Fixed-asset purchases of the month.
  for (const a of assetsThisMonth) {
    const sup = R.pick(suppliers);
    const base = money(a.cost, euro);
    const vat = round2(dec(base).times(0.2));
    const total = round2(dec(base).plus(vat));
    add({
      userId: user(),
      input: {
        accountingDate: a.date, documentDate: a.date, documentTypeId: 1, documentNumber: `A${R.int(100000, 999999)}`, companyId: sup.id, term: `Придобиване на ${a.name}`, transactionTypeId: 2,
        debits: [{ accountId: C.id(a.inventory), amount: amt(base), vatTermId: 2 }, { accountId: C.id('453/1'), amount: amt(vat), vatTermId: 2 }],
        credits: [{ accountId: C.id('401'), amount: amt(total), companyId: sup.id, vatTermId: 2 }],
      },
      after: async (id) => pushOpen('s', sup.id, { accountingId: id, remaining: total, accountId: C.id('401') }),
    });
  }

  while (out.length < count) {
    const r = R.next();
    if (r < 0.32) {
      // Sales invoice.
      const eu = euClients.length > 0 && R.chance(0.05);
      const cli = eu ? R.pick(euClients) : R.pick(bgClients);
      const term = eu ? 13 : vatTermSale();
      const rate = term === 7 ? 0.2 : term === 11 ? 0.09 : 0;
      const credits: LineInput[] = [];
      let base = dec(0);
      const goods = R.chance(0.35);
      if (goods) {
        for (let k = R.int(1, 3); k > 0; k--) {
          const p = R.pick(products);
          const q = R.int(1, 20);
          if (p.stock < q) continue;
          p.stock -= q;
          const value = round2(dec(money(p.cost * 1.35, euro)).times(q));
          credits.push({ accountId: C.stock.get(p.id)!.dec, amount: value.toFixed(2), quantity: String(q), vatTermId: term });
          base = base.plus(value);
        }
      }
      if (!credits.length) {
        const value = round2(dec(money(R.int(5_000, 500_000) / 100, euro)));
        credits.push({ accountId: C.id('703'), amount: value.toFixed(2), vatTermId: term });
        base = value;
      }
      const vat = round2(base.times(rate));
      if (!vat.isZero()) credits.push({ accountId: C.id('453/2'), amount: vat.toFixed(2), vatTermId: term });
      const total = base.plus(vat);
      const date = day();
      add({
        userId: user(),
        input: {
          accountingDate: date, documentDate: date, documentTypeId: 1, documentNumber: String(++ownInvoice).padStart(10, '0'), companyId: cli.id,
          term: goods ? 'Продажба на стоки' : 'Продажба на услуги', transactionTypeId: 3, viesId: eu ? 2 : null,
          debits: [{ accountId: C.id('411'), amount: total.toFixed(2), companyId: cli.id, vatTermId: term }], credits,
        },
        after: async (id) => { if (R.chance(0.9)) pushOpen('c', cli.id, { accountingId: id, remaining: total, accountId: C.id('411') }); },
      });
    } else if (r < 0.54) {
      // Purchase invoice: goods with quantities or services.
      const sup = R.pick(suppliers);
      const debits: LineInput[] = [];
      let base = dec(0);
      if (R.chance(0.45)) {
        for (let k = R.int(1, 4); k > 0; k--) {
          const p = R.pick(products);
          const q = R.int(10, 80);
          p.stock += q;
          const value = round2(dec(money(p.cost, euro)).times(q));
          debits.push({ accountId: C.stock.get(p.id)!.inc, amount: value.toFixed(2), quantity: String(q), vatTermId: 2 });
          base = base.plus(value);
        }
      } else {
        const value = round2(dec(money(R.int(2_000, 300_000) / 100, euro)));
        debits.push({ accountId: C.id(R.pick(['602', '602', '601', '609'])), amount: value.toFixed(2), vatTermId: 2 });
        base = value;
      }
      const vat = round2(base.times(0.2));
      debits.push({ accountId: C.id('453/1'), amount: vat.toFixed(2), vatTermId: 2 });
      const total = base.plus(vat);
      const date = day();
      add({
        userId: user(),
        input: {
          accountingDate: date, documentDate: date, documentTypeId: 1, documentNumber: String(R.int(1, 9_999_999_999)).padStart(10, '0'), companyId: sup.id,
          term: debits.length > 2 ? 'Доставка на стоки' : 'Доставка на услуги', transactionTypeId: 2,
          debits, credits: [{ accountId: C.id('401'), amount: total.toFixed(2), companyId: sup.id, vatTermId: 2 }],
        },
        after: async (id) => { if (R.chance(0.93)) pushOpen('s', sup.id, { accountingId: id, remaining: total, accountId: C.id('401') }); },
      });
    } else if (r < 0.86) {
      // Payment by bank (75 %) or cash (25 %), client receipt or supplier payment, bound to the oldest open invoice.
      const client = R.chance(0.55);
      const cash = R.chance(0.25);
      const pool = client ? clients : suppliers;
      let partner = R.pick(pool);
      for (let k = 0; k < 8 && !(openQueue.get(qKey(client ? 'c' : 's', partner.id))?.length); k++) partner = R.pick(pool);
      const queue = openQueue.get(qKey(client ? 'c' : 's', partner.id)) ?? [];
      const inv = queue[0];
      const advance = !inv || R.chance(0.04);
      const full = !advance && R.chance(0.82);
      const value = advance ? round2(dec(money(R.int(10_000, 200_000) / 100, euro))) : full ? inv!.remaining : round2(inv!.remaining.div(2));
      if (value.lessThanOrEqualTo(0)) continue;
      const partnerAcc = C.id(client ? '411' : '401');
      const payAcc = C.id(cash ? '501' : '503');
      const partnerLine: LineInput = { accountId: partnerAcc, amount: value.toFixed(2), companyId: partner.id };
      const payLine: LineInput = { accountId: payAcc, amount: value.toFixed(2) };
      const docType = cash ? (client ? 8 : 9) : 11;
      const date = day();
      add({
        userId: user(),
        input: {
          accountingDate: date, documentDate: date, documentTypeId: docType, documentNumber: cash ? '' : `БИ${ym.replace('-', '')}${R.int(1, 31)}`, companyId: partner.id,
          term: client ? 'Плащане от клиент' : 'Плащане на доставчик', source: 'payment',
          debits: [client ? payLine : partnerLine], credits: [client ? partnerLine : payLine],
        },
        after: async (id, documentId) => {
          if (advance || !inv) return;
          await insertPaymentLinks(current!, [{ paymentAccountingId: id, refAccountingId: inv.accountingId, documentId, accountId: inv.accountId, companyId: partner.id, amount: value.toFixed(2) }]);
          counters.links++;
          inv.remaining = inv.remaining.minus(value);
          if (inv.remaining.lessThanOrEqualTo(0)) queue.shift();
        },
      });
    } else if (r < 0.92) {
      // USD bank: buying dollars, paying foreign services, fees.
      const usd = R.int(500, 20_000);
      const rate = euro ? 0.86 + R.next() * 0.04 : 1.68 + R.next() * 0.08;
      const value = round2(dec(usd).times(rate));
      const date = day();
      const usdLine: LineInput = { accountId: C.id('504/1'), amount: value.toFixed(2), currencyAmount: String(usd) };
      add({
        userId: user(),
        input: R.chance(0.5)
          ? { accountingDate: date, documentTypeId: 11, documentNumber: `USD${ym.replace('-', '')}`, term: 'Покупка на валута', debits: [usdLine], credits: [{ accountId: C.id('503'), amount: value.toFixed(2) }] }
          : { accountingDate: date, documentTypeId: 11, documentNumber: `USD${ym.replace('-', '')}`, term: 'Плащане на чуждестранна услуга', debits: [{ accountId: C.id('602'), amount: value.toFixed(2) }], credits: [usdLine] },
      });
    } else {
      // Salaries paid, social security paid, bank fees, petty cash.
      const date = day();
      const k = R.int(0, 3);
      const v = amt(money(k === 2 ? R.int(5, 80) : R.int(500, 8000), euro));
      const pair = [['421', '503', 'Изплащане на заплати', 11], ['461/1', '503', 'Внесени осигуровки', 11], ['602', '503', 'Банкови такси', 11], ['501', '503', 'Захранване на каса', 10]][k]! as [string, string, string, number];
      add({ userId: user(), input: { accountingDate: date, documentTypeId: pair[3], documentNumber: pair[3] === 11 ? `БИ${ym.replace('-', '')}` : '', term: pair[2], debits: [{ accountId: C.id(pair[0]), amount: v }], credits: [{ accountId: C.id(pair[1]), amount: v }] } });
    }
  }
  return out.sort((a, b) => (a.input.accountingDate < b.input.accountingDate ? -1 : a.input.accountingDate > b.input.accountingDate ? 1 : 0));
}

let current: Parameters<Parameters<CompanyDb['transaction']>[0]>[0] | null = null;

async function postAll(year: ActiveYear, planned: Planned[]) {
  for (let i = 0; i < planned.length; i += BATCH) {
    await db.transaction(async (tx) => {
      current = tx;
      for (const p of planned.slice(i, i + BATCH)) {
        try {
          // A savepoint per entry: a refused entry does not spoil the batch.
          await tx.transaction(async (sp) => {
            current = sp;
            const r = await saveEntry(sp, p.input, { year, userId: p.userId, force: true });
            const [{ document_id }] = await queryRows<{ document_id: number | null }>(sp, sql`SELECT document_id FROM accountings WHERE id = ${r.id}`) as [{ document_id: number | null }];
            await p.after?.(r.id, document_id);
          });
          counters.entries++;
        } catch (e) {
          counters.failed++;
          const key = (e as { messages?: { key: string }[] }).messages?.map((m) => m.key).join(',') || (e as Error).message.slice(0, 120);
          failures.set(key, (failures.get(key) ?? 0) + 1);
        } finally {
          current = tx;
        }
      }
    });
  }
  current = null;
}

/* ------------------------------------------------------------------ */
/* Fixed assets                                                         */
/* ------------------------------------------------------------------ */

interface AssetPlan { name: string; date: string; cost: number; category: number; inventory: string; depreciation: string; months: number }
const ASSET_KINDS = [
  { category: 1, inventory: '203', depreciation: '241/3', months: [300, 600], cost: [80_000, 600_000], name: 'Сграда' },
  { category: 2, inventory: '206', depreciation: '241/6', months: [60, 120], cost: [3_000, 90_000], name: 'Машина' },
  { category: 3, inventory: '205', depreciation: '241/5', months: [60, 96], cost: [20_000, 120_000], name: 'Камион' },
  { category: 4, inventory: '207', depreciation: '241/7', months: [24, 36], cost: [1_200, 6_000], name: 'Компютър' },
  { category: 7, inventory: '208', depreciation: '241/8', months: [60, 84], cost: [1_000, 15_000], name: 'Обзавеждане' },
];
const assetPlans: AssetPlan[] = [];
for (let i = 0; i < ASSETS; i++) {
  const k = R.chance(0.03) ? ASSET_KINDS[0]! : R.pick(ASSET_KINDS.slice(1));
  // Two thirds bought in 2025, the rest in the first half of 2026.
  const ym = i < (ASSETS * 2) / 3 ? `2025-${String(R.int(1, 12)).padStart(2, '0')}` : `2026-${String(R.int(1, 6)).padStart(2, '0')}`;
  assetPlans.push({ name: `${k.name} ${i + 1}`, date: `${ym}-${String(R.int(1, 28)).padStart(2, '0')}`, cost: R.int(k.cost[0]!, k.cost[1]!), category: k.category, inventory: k.inventory, depreciation: k.depreciation, months: R.int(k.months[0]!, k.months[1]!) });
}
let invNo = 0;

async function createAssets(list: AssetPlan[], euro: boolean, C: Awaited<ReturnType<typeof chartOf>>) {
  for (const a of list) {
    const cost = amt(money(a.cost, euro));
    const plan = (o: Record<string, unknown>) => ({ depreciationAmount: cost, nonDepreciableAmount: '0', acquisitionDate: a.date, startDate: a.date, calcType: 'period', activePeriodLength: a.months, annualRate: null, conservation: null, note: '', serialNumber: '', ...o });
    await api.must('POST', '/assets', {
      inventoryNumber: `ДА${String(++invNo).padStart(5, '0')}`, name: a.name, personInCharge: R.pick(['Иван Петров', 'Мария Георгиева', 'Петър Стоянов']), categoryId: a.category,
      inventoryAccountId: C.id(a.inventory), debitAccountId: C.id(a.depreciation), creditAccountId: C.id('603'), locationId: null, synchronized: false,
      accounting: plan({}), tax: plan({}), plansDifferAccepted: true,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Month-end operations through the API                                 */
/* ------------------------------------------------------------------ */

async function monthEnd(ym: string) {
  const from = `${ym}-01`, to = lastDay(ym);
  const pending = await api.must<{ rows: { id: number }[] }>('GET', `/accounting-requests?from=${from}&to=${to}`);
  if (pending.rows.length) await api.must('POST', '/accounting-requests/post', { ids: pending.rows.map((r) => r.id) });
  const wo = await api.call('POST', '/stock/write-offs', { from, to, date: to });
  if (wo.status !== 201 && wo.status !== 400) throw new Error(`write-offs ${ym}: ${wo.status} ${wo.text}`);
  const vat = await api.call<{ rows: { credit: { id: number }; debit: { id: number }; amount: string }[] }>('POST', '/vat/closing/calculate', { from, to });
  if (vat.status === 200 && vat.body.rows?.length) {
    const r = await api.call('POST', '/vat/closing', { to, rows: vat.body.rows.map((x) => ({ creditAccountId: x.credit.id, debitAccountId: x.debit.id, amount: x.amount })) });
    if (r.status !== 201) failures.set(`vat-closing ${r.status} ${r.text.slice(0, 200)}`, (failures.get(`vat-closing ${r.status} ${r.text.slice(0, 200)}`) ?? 0) + 1);
  }
  return pending.rows.length;
}

/* ------------------------------------------------------------------ */
/* Run                                                                  */
/* ------------------------------------------------------------------ */

const perMonth = Math.ceil(N / MONTHS.length);
let year = await activeYear(2025);
let C = await chartOf(2025);
await postAll(year, [{ userId: 1, input: {
  accountingDate: '2025-01-01', documentTypeId: null, term: 'Начално салдо', isInitialBalance: true,
  debits: [{ accountId: C.id('503'), amount: '900000.00' }], credits: [{ accountId: C.id('101'), amount: '900000.00' }],
} }]);
await createAssets(assetPlans.filter((a) => a.date < '2026'), false, C);
log(`${assetPlans.filter((a) => a.date < '2026').length} fixed assets (2025)`);

for (const ym of MONTHS) {
  if (ym === '2026-01') {
    // Year end of 2025: result accounts closed to 123, the 2026 year with the euro chart, euro conversion with the fixed assets.
    // Result accounts (classes 6 and 7) are concluded into 123 (Приключване, 01b 6.4).
    for (const a of accounts as (Acc & { isLeaf?: boolean })[]) {
      if (a.isLeaf && /^[67]/.test(a.number)) await api.must('PUT', `/accounts/${a.id}`, { concludeAccountId: acc('123') });
    }
    const close = await api.call('POST', '/closings/auto', { from: '2025-01-01', to: '2025-12-31' });
    log(`closing of 2025: ${close.status}${close.status === 201 ? '' : ' ' + close.text}`);
    await api.must('POST', '/years', { year: 2026, force: true });
    // The EUR chart (seeded from the template) needs the USD bank account too.
    await api.must('PUT', '/years/active', { year: 2026, force: true });
    await reloadAccounts();
    await api.must('POST', '/accounts', { parentId: acc('504'), description: 'Разплащателна сметка в USD', accountCategoryId: 27, currencyId: 3 });
    // ... and the goods: categories on 304/702 and the products' sub-accounts in the EUR chart (same numbers as in BGN).
    for (const [n, cat] of [['304', 3], ['702', 24]] as const) await api.must('PUT', `/accounts/${acc(n)}`, { accountCategoryId: cat });
    for (const p of products) await api.must('PUT', `/products/${p.id}`, { ...p.body, incrementAccountIds: [acc('304')], decrementAccountIds: [acc('702')] });
    await reloadAccounts();
    for (const a of accounts as (Acc & { isLeaf?: boolean })[]) {
      if (a.isLeaf && /^[67]/.test(a.number)) await api.must('PUT', `/accounts/${a.id}`, { concludeAccountId: acc('123') });
    }
    await api.must('PUT', '/years/active', { year: 2025, force: true });
    const grid = await api.must<{ euroAccounts: { id: number; number: string }[] }>('GET', '/euro-conversion');
    const te = performance.now();
    await api.must('POST', '/euro-conversion', { differencesAccountId: grid.euroAccounts.find((x) => x.number === '123')!.id, fixedAssets: true });
    log(`euro conversion in ${fmtMs(performance.now() - te)}`);
    year = await activeYear(2026);
    C = await chartOf(2026);
    // Open 2025 invoices continue as the 2026 openings (one per open item).
    openQueue.clear();
    for (const i of await openItems(db, { startDate: '2026-01-01', endDate: '2026-12-31', financialYearId: year.id, isEuro: true, kind: 'liability' })) {
      pushOpen(i.side === 'client' ? 'c' : 's', i.companyId, { accountingId: i.accountingId, remaining: dec(i.openAbs), accountId: i.accountId });
    }
    await createAssets(assetPlans.filter((a) => a.date >= '2026'), true, C);
    log(`${assetPlans.filter((a) => a.date >= '2026').length} fixed assets (2026)`);
  }
  const tm = performance.now();
  const before = counters.entries;
  await postAll(year, planMonth(ym, perMonth, ym >= '2026', C, assetPlans.filter((a) => a.date.startsWith(ym))));
  const dep = await monthEnd(ym);
  log(`${ym}: ${counters.entries - before} entries, ${dep} depreciation months in ${fmtMs(performance.now() - tm)} (total ${counters.entries}, links ${counters.links}, refused ${counters.failed})`);
  if (o.verbose && failures.size) console.log(Object.fromEntries(failures));
}

// Today's working date: October 2026.
await api.call('PUT', '/session/working-date', { date: '2026-10-19' });

const [stats] = await queryRows<Record<string, number>>(db, sql`
  SELECT (SELECT count(*)::int FROM accountings) AS accountings, (SELECT count(*)::int FROM accounting_details) AS details,
    (SELECT count(*)::int FROM accounting_payment_details) AS links, (SELECT count(*)::int FROM companies) AS partners,
    (SELECT count(*)::int FROM fixed_assets) AS assets, (SELECT count(*)::int FROM documents) AS documents`);
log(`done: ${JSON.stringify(stats)}`);
if (failures.size) console.log('refused entries by message:', Object.fromEntries(failures));
console.log(`\nDatabase: ${dbName}\nRun: node apps/server/scripts/perf.ts --db=${dbName}${process.env.DATABASE_URL ? '' : ` --data-dir=${process.env.DATA_DIR}`}`);
await driver.close();
release();
