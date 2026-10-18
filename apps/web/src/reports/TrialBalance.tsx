import { useState } from 'react';
import { api, qs } from '../api.ts';
import { PartnerPicker } from '../components/pickers.tsx';
import { Checkbox, Field, cx } from '../components/ui.tsx';
import { AccountNumberPicker, Amt, LevelSelect, PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell } from './common.tsx';

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
}
type Totals = Pick<Row, 'openingDebit' | 'openingCredit' | 'debitTurnover' | 'creditTurnover' | 'closingDebit' | 'closingCredit'>;
interface Result {
  rows: Row[];
  totals: Totals;
}

const AMOUNTS = ['openingDebit', 'openingCredit', 'debitTurnover', 'creditTurnover', 'closingDebit', 'closingCredit'] as const;

/** Оборотна ведомост (spec 05 section 3), standard layout. */
export function TrialBalance() {
  const period = useYearPeriod();
  const [f, setF] = useState({
    ...period,
    account: '',
    // Commercial chart: level 2 (tree level 4) is where the synthetic accounts (501) are.
    level: 2,
    zero: false,
    withoutOffBalance: false,
    byExportMonth: false,
    companyId: null as number | null,
    companyName: '' as string | null,
  });
  const report = useReport('trialBalance', f, (x) =>
    api.get<Result>(
      `/reports/trial-balance${qs({ from: x.from, to: x.to, account: x.account, level: x.level, zero: x.zero, offBalance: x.withoutOffBalance ? '0' : undefined, byExportMonth: x.byExportMonth, companyId: x.companyId })}`,
    ),
  );
  const a = report.applied ?? f;
  const subtitle = [periodText(a), a.account && `сметка ${a.account}`, a.companyId && `партньор ${a.companyName}`].filter(Boolean).join(', ');

  const csv = (d: Result): Cell[][] => [
    ['Сметка', 'Наименование', 'Начално салдо Дебит', 'Начално салдо Кредит', 'Обороти Дебит', 'Обороти Кредит', 'Крайно салдо Дебит', 'Крайно салдо Кредит'],
    ...d.rows.map((r) => [r.number, r.description, ...AMOUNTS.map((k) => amt(r[k]))]),
    ['Общо:', '', ...AMOUNTS.map((k) => amt(d.totals[k]))],
  ];

  return (
    <ReportFrame<Result>
      title="Оборотна ведомост"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.rows.length === 0}
      status={(d) => `${d.rows.length} сметки`}
      csvName={`ОВ_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} />
          </Field>
          <LevelSelect value={f.level} onChange={(level) => setF({ ...f, level })} />
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-64" />
          </Field>
        </>
      }
      options={
        <>
          <Checkbox label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />
          <Checkbox label="Включване на редове с нулеви салда и обороти" checked={f.zero} onChange={(zero) => setF({ ...f, zero })} />
          <Checkbox label="Без задбалансови сметки" checked={f.withoutOffBalance} onChange={(withoutOffBalance) => setF({ ...f, withoutOffBalance })} />
        </>
      }
    >
      {(d) => <TrialBalanceTable data={d} />}
    </ReportFrame>
  );
}

function TrialBalanceTable({ data }: { data: Result }) {
  const minLevel = Math.min(...data.rows.map((r) => r.level));
  return (
    <table className="grid-table">
      <thead>
        <tr className="hdr1">
          <th colSpan={2} className="text-center">
            Сметка
          </th>
          <th colSpan={2} className="text-center">
            Начално салдо
          </th>
          <th colSpan={2} className="text-center">
            Обороти
          </th>
          <th colSpan={2} className="text-center">
            Крайно салдо
          </th>
        </tr>
        <tr className="hdr2">
          <th className="w-28">Номер</th>
          <th>Наименование</th>
          {[0, 1, 2].map((i) => (
            <Pair key={i} />
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r) => {
          const indent = (r.level - minLevel) * 14;
          return (
            <tr key={r.accountId} className={cx(r.hasChildren && 'font-semibold', r.level === minLevel && r.hasChildren && 'bg-slate-100!')}>
              <td className="nowrap" style={{ paddingLeft: 8 + indent }}>
                {r.number}
              </td>
              <td className="max-w-[28rem] truncate" style={{ paddingLeft: 8 + indent }} title={r.description}>
                {r.description}
              </td>
              {AMOUNTS.map((k) => (
                <Amt key={k} v={r[k]} className="w-32" />
              ))}
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={2}>Общо:</td>
          {AMOUNTS.map((k) => (
            <Amt key={k} v={data.totals[k]} />
          ))}
        </tr>
      </tfoot>
    </table>
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
