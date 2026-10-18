import { Fragment, useState } from 'react';
import { api, qs } from '../api.ts';
import { PartnerPicker } from '../components/pickers.tsx';
import { Checkbox, Field, Select } from '../components/ui.tsx';
import { AccountNumberPicker, Amt, LevelSelect, PeriodFields, ReportFrame, amt, periodText, sum, useReport, useYearPeriod, type Cell } from './common.tsx';

interface Balances {
  openingDebit: string;
  openingCredit: string;
  debitTurnover: string;
  creditTurnover: string;
  closingDebit: string;
  closingCredit: string;
}
interface Group {
  number: string;
  description: string;
  counters: { number: string; description: string; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
  balances?: Balances;
}

/** Главна книга (spec 05 4.1): turnovers of every account against each corresponding account. */
export function GeneralLedger() {
  const period = useYearPeriod();
  const [f, setF] = useState({ ...period, account: '', level: 2, balances: false, zero: false, byExportMonth: false, companyId: null as number | null, companyName: '' as string | null });
  const report = useReport('generalLedger', f, (x) =>
    api.get<Group[]>(`/reports/general-ledger${qs({ from: x.from, to: x.to, account: x.account, level: x.level, balances: x.balances ? undefined : '0', zero: x.balances && x.zero, byExportMonth: x.byExportMonth, companyId: x.companyId })}`),
  );
  const a = report.applied ?? f;
  const withBal = a.balances;
  const subtitle = [periodText(a), a.account && `сметка ${a.account}`, a.companyId && `партньор ${a.companyName}`].filter(Boolean).join(', ');

  const csv = (d: Group[]): Cell[][] => {
    const out: Cell[][] = [['Сметка', 'Наименование', 'Дебит', 'Кредит']];
    for (const g of d) {
      out.push([g.number, g.description]);
      for (const c of g.counters) out.push([c.number, c.description, amt(c.debit), amt(c.credit)]);
      out.push([`Общо за ${g.number}`, '', amt(g.totalDebit), amt(g.totalCredit)]);
      if (g.balances) {
        out.push(['Начално салдо', '', amt(g.balances.openingDebit), amt(g.balances.openingCredit)]);
        out.push(['Крайно салдо', '', amt(g.balances.closingDebit), amt(g.balances.closingCredit)]);
      }
    }
    out.push(['Общо', '', sum(d, (g) => g.totalDebit), sum(d, (g) => g.totalCredit)]);
    return out;
  };

  return (
    <ReportFrame<Group[]>
      title={withBal ? 'Главна книга със салда' : 'Главна книга'}
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} сметки`}
      csvName={`${withBal ? 'ГлКнига салда' : 'ГлКнига'}_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} />
          </Field>
          <Field label="Тип справка">
            <Select value={f.balances ? '1' : '0'} onChange={(e) => setF({ ...f, balances: e.target.value === '1' })} className="w-36">
              <option value="0">Стандартна</option>
              <option value="1">Със салда</option>
            </Select>
          </Field>
          <LevelSelect value={f.level} onChange={(level) => setF({ ...f, level })} />
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-60" />
          </Field>
        </>
      }
      options={
        <>
          <Checkbox label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />
          {f.balances && <Checkbox label="Включване на сметки със салда и с нулеви обороти" checked={f.zero} onChange={(zero) => setF({ ...f, zero })} />}
        </>
      }
    >
      {(d) => (
        <table className="grid-table max-w-[72rem]">
          <thead>
            <tr>
              <th className="w-28">Сметка</th>
              <th>Наименование</th>
              <th className="w-36 text-right">Дебит</th>
              <th className="w-36 text-right">Кредит</th>
            </tr>
          </thead>
          <tbody>
            {d.map((g) => (
              <Fragment key={g.number}>
                <tr className="grp">
                  <td className="nowrap text-brand-700">{g.number}</td>
                  <td colSpan={3} className="text-brand-700">
                    {g.description}
                  </td>
                </tr>
                {g.counters.map((c) => (
                  <tr key={c.number}>
                    <td className="nowrap pl-6!">{c.number}</td>
                    <td className="max-w-[32rem] truncate">{c.description}</td>
                    <Amt v={c.debit} />
                    <Amt v={c.credit} />
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td colSpan={2} className="text-right">
                    Общо за {g.number}
                  </td>
                  <Amt v={g.totalDebit} className="border-t border-t-slate-400" />
                  <Amt v={g.totalCredit} className="border-t border-t-slate-400" />
                </tr>
                {g.balances && (
                  <>
                    <tr className="text-slate-700">
                      <td colSpan={2} className="text-right">
                        Начално салдо
                      </td>
                      <Amt v={g.balances.openingDebit} />
                      <Amt v={g.balances.openingCredit} />
                    </tr>
                    <tr className="text-slate-700">
                      <td colSpan={2} className="text-right">
                        Крайно салдо
                      </td>
                      <Amt v={g.balances.closingDebit} />
                      <Amt v={g.balances.closingCredit} />
                    </tr>
                  </>
                )}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Общо</td>
              <Amt v={sum(d, (g) => g.totalDebit)} />
              <Amt v={sum(d, (g) => g.totalCredit)} />
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}
