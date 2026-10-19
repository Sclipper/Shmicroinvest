import { Fragment, type ReactNode } from 'react';
import { formatMoney, REPORT_SHORT_NAMES } from '@shmi/core';
import { api, qs } from '../api.ts';
import { PartnerMultiPicker, type PickedPartner } from '../components/pickers.tsx';
import { Checkbox, Field, Select, TextInput, cx } from '../components/ui.tsx';
import { AccountNumberPicker, Amt, LevelSelect, PeriodFields, ReportFrame, amt, periodText, sum, useReport, useReportFilters, useYearPeriod, type Cell } from './common.tsx';

interface Row {
  accountId: number;
  number: string;
  description: string;
  englishDescription: string | null;
  level: number;
  hasChildren: boolean;
  openingDebit: string;
  openingCredit: string;
  debitTurnover: string;
  creditTurnover: string;
  closingDebit: string;
  closingCredit: string;
  /** "Втора забележка" when the standard layout is filtered by it: one row per account and optional reference. */
  optionalReference?: string;
}
type Amounts = Pick<Row, 'openingDebit' | 'openingCredit' | 'debitTurnover' | 'creditTurnover' | 'closingDebit' | 'closingCredit'>;
interface ExtRow extends Row {
  isoCode: string;
  extra: Amounts | null;
}
interface MonthGroup {
  accountId: number;
  number: string;
  description: string;
  englishDescription: string | null;
  level: number;
  months: (Amounts & { month: string })[];
}
interface PartnerRow extends Amounts {
  companyId: number;
  companyName: string;
  vat: string;
}

type Result =
  | { type: 0; rows: Row[]; totals: Amounts }
  | { type: 1; rows: ExtRow[]; totals: Amounts }
  | { type: 2; rows: ExtRow[]; totals: Amounts }
  | { type: 3; rows: PartnerRow[] }
  | { type: 4; groups: MonthGroup[] };

const AMOUNTS = ['openingDebit', 'openingCredit', 'debitTurnover', 'creditTurnover', 'closingDebit', 'closingCredit'] as const;

/** "Тип справка" (strReportType2), in the order of the original combo. */
const TYPES = ['Стандартна', 'Валутна', 'Материална', 'По партньори', 'По периоди'] as const;
const R = REPORT_SHORT_NAMES;
const SHORT = [R.strTurnOverStandardShortName, R.strTurnOverForeignCurrencyShortName, R.strTurnOverMaterialShortName, R.strTurnOverCompanyShortName, R.strTurnOverMonthsShortName];
const BASE_COLUMNS: [string, string][] = [
  ['InitialDebitBalance', 'Начално салдо дебит'], ['InitialCreditBalance', 'Начално салдо кредит'],
  ['DebitTurnover', 'Обороти дебит'], ['CreditTurnover', 'Оборот кредит'],
  ['FinalDebitBalance', 'Крайно салдо дебит'], ['FinalCreditBalance', 'Крайно салдо кредит'],
];
const ACCOUNT_COLUMNS: [string, string][] = [['AccountNumber', 'Номер сметка'], ['AccountDescription', 'Име сметка']];
/** "Филтър по" items per layout (05 3.2, 3.8); "По периоди" has no filter. */
const FILTER_COLUMNS: Record<0 | 1 | 2 | 3, [string, string][]> = {
  0: [['', 'Всички'], ...ACCOUNT_COLUMNS, ...BASE_COLUMNS, ['OptionalReference', 'Втора забележка']],
  1: [['', 'Всички'], ...ACCOUNT_COLUMNS, ['ISOCode', 'Валута'], ...BASE_COLUMNS.map(([k, l]): [string, string] => [`Currency${k}`, `${l} (валута)`]), ...BASE_COLUMNS],
  2: [['', 'Всички'], ...ACCOUNT_COLUMNS, ...BASE_COLUMNS.map(([k, l]): [string, string] => [`Material${k}`, `${l} (количество)`]), ...BASE_COLUMNS],
  3: [['', 'Всички'], ['CompanyName', 'Партньор'], ...BASE_COLUMNS],
};

/** Оборотна ведомост (spec 05 section 3): standard, foreign currency, materials, partners and by-months layouts. */
export function TrialBalance() {
  const period = useYearPeriod();
  const [f, setF] = useReportFilters('trialBalance', {
    ...period,
    type: 0 as 0 | 1 | 2 | 3 | 4,
    account: '',
    // Commercial chart: level 2 (tree level 4) is where the synthetic accounts (501) are.
    level: 2,
    zero: false,
    withoutOffBalance: false,
    byExportMonth: false,
    // 05 3.2: "Със сумиране" is off until the user ticks it.
    withSummation: false,
    english: false,
    filterColumn: '',
    filterText: '',
    allLevels: false,
    partners: [] as PickedPartner[],
  });
  const report = useReport<typeof f, Result>(
    'trialBalance',
    f,
    async (x) => {
      const common = { from: x.from, to: x.to, account: x.account, level: x.level, zero: x.zero, byExportMonth: x.byExportMonth };
      const companyId = x.partners.map((p) => p.id).join(',') || undefined;
      const filter = x.filterText.trim() ? { filterColumn: x.filterColumn || undefined, filter: x.filterText.trim() } : {};
      const withPartner = { ...common, offBalance: x.withoutOffBalance ? '0' : undefined, companyId };
      switch (x.type) {
        case 1: return { type: 1, ...(await api.get<{ rows: ExtRow[]; totals: Amounts }>(`/reports/trial-balance-fc${qs({ ...withPartner, ...filter })}`)) };
        case 2: return { type: 2, ...(await api.get<{ rows: ExtRow[]; totals: Amounts }>(`/reports/trial-balance-mt${qs({ ...withPartner, ...filter })}`)) };
        case 3: return { type: 3, rows: await api.get<PartnerRow[]>(`/reports/partner-turnover${qs({ ...common, companyId, ...filter })}`) };
        case 4: return { type: 4, groups: await api.get<MonthGroup[]>(`/reports/trial-balance-months${qs(common)}`) };
        default: {
          const url = x.filterText.trim()
            ? `/reports/trial-balance-filtered${qs({ ...withPartner, filterColumn: x.filterColumn, filter: x.filterText.trim(), allLevels: x.allLevels && x.filterColumn === 'AccountDescription' })}`
            : `/reports/trial-balance${qs(withPartner)}`;
          return { type: 0, ...(await api.get<{ rows: Row[]; totals: Amounts }>(url)) };
        }
      }
    },
    (x) => (x.from > x.to ? 'Началната дата е след крайната дата.' : x.type === 3 && !x.account ? 'Не е избрана сметка.' : null),
  );
  const a = report.applied ?? f;
  const subtitle = [periodText(a), a.type ? TYPES[a.type].toLowerCase() : '', a.account && `сметка ${a.account}`, a.partners.length > 0 && `партньор ${a.partners.map((p) => p.name).join(', ')}`].filter(Boolean).join(', ');
  const name = (r: { description: string; englishDescription: string | null }) => (a.english && r.englishDescription ? r.englishDescription : r.description);
  const levelsApply = f.type !== 3;
  const partnerApplies = f.type !== 4;

  return (
    <ReportFrame<Result>
      title="Оборотна ведомост"
      logEntity="turnoverReport"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => (d.type === 4 ? d.groups.length === 0 : d.rows.length === 0)}
      status={(d) => (d.type === 4 ? `${d.groups.length} сметки` : `${d.rows.length} ${d.type === 3 ? 'партньора' : 'сметки'}`)}
      csvName={`${SHORT[a.type]}_${a.from}_${a.to}`}
      csv={(d) => csvRows(d, name, a.withSummation)}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Тип справка">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: Number(e.target.value) as typeof f.type, level: Number(e.target.value) === 1 && f.level < 5 ? 5 : f.level, filterColumn: '', allLevels: false })} className="w-36" aria-label="Тип справка">
              {TYPES.map((t, i) => (
                <option key={t} value={i}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} />
          </Field>
          {levelsApply && <LevelSelect value={f.level} onChange={(level) => setF({ ...f, level })} />}
          {partnerApplies && (
            <Field label="Партньор">
              <PartnerMultiPicker value={f.partners} onChange={(partners) => setF({ ...f, partners })} />
            </Field>
          )}
          {f.type !== 4 && (
            <>
              <Field label="Филтър по">
                <Select value={f.filterColumn} onChange={(e) => setF({ ...f, filterColumn: e.target.value })} className="w-52" aria-label="Филтър по">
                  {FILTER_COLUMNS[f.type].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Филтър">
                <TextInput value={f.filterText} onChange={(e) => setF({ ...f, filterText: e.target.value })} className="w-40" aria-label="Филтър" />
              </Field>
            </>
          )}
        </>
      }
      options={
        <>
          <Checkbox label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />
          <Checkbox label="Включване на редове с нулеви салда и обороти" checked={f.zero} onChange={(zero) => setF({ ...f, zero })} />
          <Checkbox label="Със сумиране" checked={f.withSummation} onChange={(withSummation) => setF({ ...f, withSummation })} />
          <Checkbox label="Наименование на сметки на чужд език" checked={f.english} onChange={(english) => setF({ ...f, english })} />
          {f.type !== 4 && f.type !== 3 && <Checkbox label="Без задбалансови сметки" checked={f.withoutOffBalance} onChange={(withoutOffBalance) => setF({ ...f, withoutOffBalance })} />}
          {f.type === 0 && f.filterColumn === 'AccountDescription' && (
            <Checkbox label="Търсене във всички нива на сметкоплана" checked={f.allLevels} onChange={(allLevels) => setF({ ...f, allLevels })} />
          )}
        </>
      }
    >
      {(d) => {
        if (d.type === 0) return <StandardTable rows={d.rows} totals={d.totals} name={name} summation={a.withSummation} />;
        if (d.type === 1 || d.type === 2) return <ExtendedTable rows={d.rows} totals={d.totals} name={name} currency={d.type === 1} summation={a.withSummation} />;
        if (d.type === 3) return <PartnersTable rows={d.rows} summation={a.withSummation} />;
        return <MonthsTable groups={d.groups} name={name} />;
      }}
    </ReportFrame>
  );
}

function csvRows(d: Result, name: (r: Row) => string, summation: boolean): Cell[][] {
  const head = ['Начално салдо Дебит', 'Начално салдо Кредит', 'Обороти Дебит', 'Обороти Кредит', 'Крайно салдо Дебит', 'Крайно салдо Кредит'];
  const six = (r: Amounts) => AMOUNTS.map((k) => amt(r[k]));
  if (d.type === 0) {
    const refs = d.rows.some((r) => r.optionalReference !== undefined);
    return [
      ['Сметка', 'Наименование', ...(refs ? ['Втора забележка'] : []), ...head],
      ...d.rows.map((r) => [r.number, name(r), ...(refs ? [r.optionalReference ?? ''] : []), ...six(r)]),
      ...(summation ? [['Общо:', '', ...(refs ? [''] : []), ...six(d.totals)]] : []),
    ];
  }
  if (d.type === 3) return [['Партньор', 'ЕИК/ДДС Номер', ...head], ...d.rows.map((r) => [r.companyName, r.vat, ...six(r)]), ...(summation ? [['Общо:', '', ...AMOUNTS.map((k) => amt(sum(d.rows, (r) => r[k])))]] : [])];
  if (d.type === 4) {
    const out: Cell[][] = [['Сметка', 'Наименование', 'Месец', ...head]];
    for (const g of d.groups) g.months.forEach((m, i) => out.push([i === 0 ? g.number : '', i === 0 ? name(g as unknown as Row) : '', m.month, ...six(m)]));
    return out;
  }
  {
    const ex = d.type === 1 ? head.map((h) => `${h} (валута)`) : head.map((h) => `${h} (количество)`);
    return [
      ['Сметка', 'Наименование', ...(d.type === 1 ? ['Валута'] : []), ...ex, ...head],
      ...d.rows.map((r) => [r.number, name(r), ...(d.type === 1 ? [r.isoCode] : []), ...(r.extra ? six(r.extra) : head.map(() => '')), ...six(r)]),
      ...(summation ? [['Общо:', '', ...(d.type === 1 ? [''] : []), ...head.map(() => ''), ...six(d.totals)]] : []),
    ];
  }
}

function Head({ first }: { first: ReactNode }) {
  return (
    <>
      <tr className="hdr1">
        {first}
        <th colSpan={2} className="text-center">Начално салдо</th>
        <th colSpan={2} className="text-center">Обороти</th>
        <th colSpan={2} className="text-center">Крайно салдо</th>
      </tr>
    </>
  );
}

function Pair() {
  return (
    <>
      <th className="w-32 text-right">Дебит</th>
      <th className="w-32 text-right">Кредит</th>
    </>
  );
}

function StandardTable({ rows, totals, name, summation }: { rows: Row[]; totals: Amounts; name: (r: Row) => string; summation: boolean }) {
  const minLevel = Math.min(...rows.map((r) => r.level));
  const refs = rows.some((r) => r.optionalReference !== undefined);
  return (
    <table className="grid-table">
      <thead>
        <Head first={<><th colSpan={2} className="text-center">Сметка</th>{refs && <th rowSpan={2}>Втора забележка</th>}</>} />
        <tr className="hdr2">
          <th className="w-28">Номер</th>
          <th>Наименование</th>
          {[0, 1, 2].map((i) => <Pair key={i} />)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const indent = (r.level - minLevel) * 14;
          return (
            <tr key={`${r.accountId}:${r.optionalReference ?? ''}`} className={cx(r.hasChildren && 'font-semibold', r.level === minLevel && r.hasChildren && 'bg-slate-100!')}>
              <td className="nowrap" style={{ paddingLeft: 8 + indent }}>{r.number}</td>
              <td className="max-w-[28rem] truncate" style={{ paddingLeft: 8 + indent }} title={name(r)}>{name(r)}</td>
              {refs && <td className="max-w-56 truncate">{r.optionalReference}</td>}
              {AMOUNTS.map((k) => <Amt key={k} v={r[k]} className="w-32" />)}
            </tr>
          );
        })}
      </tbody>
      {summation && (
        <tfoot>
          <tr>
            <td colSpan={refs ? 3 : 2}>Общо:</td>
            {AMOUNTS.map((k) => <Amt key={k} v={totals[k]} />)}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

const qty = (v: string | undefined) => (!v || Number(v) === 0 ? '' : formatMoney(v, 3));
const unitPrice = (value: string, quantity: string | undefined) => (quantity && Number(quantity) !== 0 ? formatMoney(Number(value) / Number(quantity), 2) : '');

function ExtendedTable({ rows, totals, name, currency, summation }: { rows: ExtRow[]; totals: Amounts; name: (r: Row) => string; currency: boolean; summation: boolean }) {
  const minLevel = Math.min(...rows.map((r) => r.level));
  if (currency) {
    return (
      <table className="grid-table">
        <thead>
          <tr className="hdr1">
            <th colSpan={3} className="text-center">Сметка</th>
            <th colSpan={6} className="text-center">В чужда валута</th>
            <th colSpan={6} className="text-center">В основна валута</th>
          </tr>
          <tr className="hdr2">
            <th className="w-24">Номер</th>
            <th>Име</th>
            <th className="w-14">Валута</th>
            {['Нач. Дт', 'Нач. Кт', 'Об. Дт', 'Об. Кт', 'Кр. Дт', 'Кр. Кт', 'Нач. Дт', 'Нач. Кт', 'Об. Дт', 'Об. Кт', 'Кр. Дт', 'Кр. Кт'].map((h, i) => <th key={i} className="w-24 text-right">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.accountId} className={cx(r.hasChildren && 'font-semibold')}>
              <td className="nowrap" style={{ paddingLeft: 8 + (r.level - minLevel) * 14 }}>{r.number}</td>
              <td className="max-w-[20rem] truncate" title={name(r)}>{name(r)}</td>
              <td>{r.isoCode}</td>
              {AMOUNTS.map((k) => <Amt key={`x${k}`} v={r.extra?.[k]} />)}
              {AMOUNTS.map((k) => <Amt key={k} v={r[k]} />)}
            </tr>
          ))}
        </tbody>
        {summation && (
          <tfoot>
            <tr>
              <td colSpan={9}>Общо:</td>
              {AMOUNTS.map((k) => <Amt key={k} v={totals[k]} />)}
            </tr>
          </tfoot>
        )}
      </table>
    );
  }
  return (
    <table className="grid-table">
      <thead>
        <tr className="hdr1">
          <th colSpan={2} rowSpan={2} className="text-center">Сметка</th>
          <th colSpan={6} className="text-center">Начални салда</th>
          <th colSpan={6} className="text-center">Обороти</th>
          <th colSpan={6} className="text-center">Крайни салда</th>
        </tr>
        <tr className="hdr2">
          {[0, 1, 2, 3, 4, 5].flatMap((i) => [
            <th key={`q${i}`} className="w-20 text-right">{i % 2 ? 'Кт к-во' : 'Дт к-во'}</th>,
            <th key={`p${i}`} className="w-20 text-right">Ед. цена</th>,
            <th key={`v${i}`} className="w-24 text-right">Стойност</th>,
          ]).slice(0, 18)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.accountId} className={cx(r.hasChildren && 'font-semibold')}>
            <td className="nowrap" style={{ paddingLeft: 8 + (r.level - minLevel) * 14 }}>{r.number}</td>
            <td className="max-w-[18rem] truncate" title={name(r)}>{name(r)}</td>
            {AMOUNTS.map((k) => (
              <Fragment key={k}>
                <td className="num">{qty(r.extra?.[k])}</td>
                <td className="num text-slate-500">{unitPrice(r[k], r.extra?.[k])}</td>
                <Amt v={r[k]} />
              </Fragment>
            ))}
          </tr>
        ))}
      </tbody>
      {summation && (
        <tfoot>
          <tr>
            <td colSpan={2}>Общо:</td>
            {AMOUNTS.map((k) => (
              <Fragment key={k}>
                <td />
                <td />
                <Amt v={totals[k]} />
              </Fragment>
            ))}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

function PartnersTable({ rows, summation }: { rows: PartnerRow[]; summation: boolean }) {
  return (
    <table className="grid-table">
      <thead>
        <Head first={<><th rowSpan={2}>Партньор</th><th rowSpan={2} className="w-36">ЕИК/ДДС Номер</th></>} />
        <tr className="hdr2">{[0, 1, 2].map((i) => <Pair key={i} />)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.companyId}>
            <td>{r.companyName}</td>
            <td>{r.vat}</td>
            {AMOUNTS.map((k) => <Amt key={k} v={r[k]} className="w-32" />)}
          </tr>
        ))}
      </tbody>
      {summation && (
        <tfoot>
          <tr>
            <td colSpan={2}>Общо:</td>
            {AMOUNTS.map((k) => <Amt key={k} v={sum(rows, (r) => r[k])} />)}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

function MonthsTable({ groups, name }: { groups: MonthGroup[]; name: (r: Row) => string }) {
  return (
    <table className="grid-table">
      <thead>
        <Head first={<><th colSpan={2} rowSpan={2} className="text-center">Сметка</th><th rowSpan={2} className="w-20">Месец</th></>} />
        <tr className="hdr2">{[0, 1, 2].map((i) => <Pair key={i} />)}</tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <Fragment key={g.accountId}>
            {g.months.map((m, i) => (
              <tr key={m.month} className={cx(i === 0 && 'border-t-2 border-t-slate-300')}>
                <td className="nowrap w-24 font-semibold">{i === 0 ? g.number : ''}</td>
                <td className="max-w-[24rem] truncate">{i === 0 ? name(g as unknown as Row) : ''}</td>
                <td>{m.month}</td>
                {AMOUNTS.map((k) => <Amt key={k} v={m[k]} className="w-32" />)}
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
