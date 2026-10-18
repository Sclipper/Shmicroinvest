import { Fragment, useState } from 'react';
import { api, qs } from '../../api.ts';
import { Field, Select } from '../../components/ui.tsx';
import { money } from '../../format.ts';
import { Amt, LEVELS, PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell } from '../common.tsx';
import { ReportTypeSelect } from './shared.tsx';

interface Row {
  accountNumber: string; accountName: string;
  initialDebitBalance: string; initialCreditBalance: string; debitBalance: string; creditBalance: string; finalDebitBalance: string; finalCreditBalance: string;
}
interface Section { key: string; title: string; amount: string; rows: Row[] }
interface Result { myCompanyName: string; availableCash: string; ownersReceivables: string; workersReceivables: string; totalAmount: string; sections: Section[] }

const COLS = ['initialDebitBalance', 'initialCreditBalance', 'debitBalance', 'creditBalance', 'finalDebitBalance', 'finalCreditBalance'] as const;

/**
 * Касова наличност и вземания (spec 05 6.10): cr1 = fdb(501)+fdb(502),
 * cr2 = fdb(493)-fcb(493), cr3 = fdb(422)-fcb(422)+fdb(429).
 */
export function CashAndReceivables() {
  const period = useYearPeriod();
  const [f, setF] = useState({ ...period, type: 0, level: 0 });
  const report = useReport('cashAndReceivables', f, (x) => api.get<Result>(`/reports/cash-and-receivables${qs({ from: x.from, to: x.to, level: x.level })}`));
  const a = report.applied ?? f;
  const detailed = a.type === 1;
  const csv = (d: Result): Cell[][] => detailed
    ? d.sections.flatMap((s) => [[s.title, '', '', '', '', '', '', amt(s.amount)], ['Сметка', 'Наименование', 'Начално салдо Дт', 'Начално салдо Кт', 'Оборот Дт', 'Оборот Кт', 'Крайно салдо Дт', 'Крайно салдо Кт'], ...s.rows.map((r) => [r.accountNumber, r.accountName, ...COLS.map((k) => amt(r[k]))]), []]).concat([['Общо:', '', '', '', '', '', '', amt(d.totalAmount)]])
    : [...d.sections.map((s) => [s.title, amt(s.amount)]), ['Общо:', amt(d.totalAmount)]];
  return (
    <ReportFrame<Result>
      title={detailed ? 'Касова наличност и вземания(Детайлна)' : 'Касова наличност и вземания'}
      subtitle={periodText(a)}
      report={report}
      isEmpty={() => false}
      csvName={`Касова наличност и вземания_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <ReportTypeSelect value={f.type} onChange={(type) => setF({ ...f, type })} items={['Стандартна', 'Детайлна']} />
          <Field label="Ниво на справка">
            <Select value={f.level} disabled={f.type !== 1} onChange={(e) => setF({ ...f, level: Number(e.target.value) })} className="w-56">
              {LEVELS.map((l, i) => <option key={i} value={i}>{l}</option>)}
            </Select>
          </Field>
        </>
      }
    >
      {(d) => detailed ? (
        <table className="grid-table">
          <thead>
            <tr className="hdr1">
              <th rowSpan={2} className="w-24 align-bottom">Сметка</th>
              <th rowSpan={2} className="align-bottom">Наименование</th>
              <th colSpan={2} className="text-center">Начално салдо</th>
              <th colSpan={2} className="text-center">Обороти</th>
              <th colSpan={2} className="text-center">Крайно салдо</th>
            </tr>
            <tr className="hdr2">
              {[0, 1, 2].map((i) => (
                <Fragment key={i}>
                  <th className="w-28 text-right">Дебит</th>
                  <th className="w-28 text-right">Кредит</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.sections.map((s) => (
              <Fragment key={s.key}>
                <tr className="grp">
                  <td colSpan={7}>{s.title}</td>
                  <td className="num">{money(s.amount)}</td>
                </tr>
                {s.rows.map((r) => (
                  <tr key={r.accountNumber}>
                    <td className="nowrap">{r.accountNumber}</td>
                    <td className="max-w-[24rem] truncate" title={r.accountName}>{r.accountName}</td>
                    {COLS.map((k) => <Amt key={k} v={r[k]} />)}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7}>Общо:</td>
              <td className="num">{money(d.totalAmount)}</td>
            </tr>
          </tfoot>
        </table>
      ) : (
        <table className="grid-table max-w-3xl">
          <tbody>
            {d.sections.map((s) => (
              <tr key={s.key}>
                <td>{s.title}</td>
                <td className="num w-36">{money(s.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Общо:</td>
              <td className="num">{money(d.totalAmount)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}
