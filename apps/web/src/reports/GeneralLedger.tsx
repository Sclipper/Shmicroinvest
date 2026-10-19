import { useMemo } from 'react';
import { api, qs } from '../api.ts';
import { PartnerPicker } from '../components/pickers.tsx';
import { Checkbox, Field, Select } from '../components/ui.tsx';
import { VirtualRows } from '../components/VirtualRows.tsx';
import { AccountNumberPicker, Amt, LevelSelect, PeriodFields, ReportFrame, amt, periodText, sum, useReport, useYearPeriod, type Cell, useReportFilters } from './common.tsx';

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
  englishDescription?: string;
  counters: { number: string; description: string; englishDescription?: string; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
  balances?: Balances;
}

/** Главна книга (spec 05 4.1): turnovers of every account against each corresponding account. */
export function GeneralLedger() {
  const period = useYearPeriod();
  const [f, setF] = useReportFilters('generalLedger', { ...period, account: '', level: 2, balances: false, zero: false, byExportMonth: false, english: false, companyId: null as number | null, companyName: '' as string | null });
  const report = useReport('generalLedger', f, (x) =>
    api.get<Group[]>(`/reports/general-ledger${qs({ from: x.from, to: x.to, account: x.account, level: x.level, balances: x.balances ? undefined : '0', zero: x.balances && x.zero, byExportMonth: x.byExportMonth, companyId: x.companyId })}`),
  );
  const a = report.applied ?? f;
  const withBal = a.balances;
  // "Наименование на сметки на чужд език" (standard layout): the English name where the account has one.
  const name = (r: { description: string; englishDescription?: string }) => (a.english && !a.balances && r.englishDescription ? r.englishDescription : r.description);
  const subtitle = [periodText(a), a.account && `сметка ${a.account}`, a.companyId && `партньор ${a.companyName}`].filter(Boolean).join(', ');

  const csv = (d: Group[]): Cell[][] => {
    const out: Cell[][] = [['Сметка', 'Наименование', 'Дебит', 'Кредит']];
    for (const g of d) {
      out.push([g.number, name(g)]);
      for (const c of g.counters) out.push([c.number, name(c), amt(c.debit), amt(c.credit)]);
      out.push([`Общо за ${g.number}`, '', amt(g.totalDebit), amt(g.totalCredit)]);
      if (g.balances) {
        out.push(['Начално салдо', '', amt(g.balances.openingDebit), amt(g.balances.openingCredit)]);
        out.push(['Крайно салдо', '', amt(g.balances.closingDebit), amt(g.balances.closingCredit)]);
      }
    }
    out.push(['Общо', '', amt(sum(d, (g) => g.totalDebit)), amt(sum(d, (g) => g.totalCredit))]);
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
          {!f.balances && <Checkbox label="Наименование на сметки на чужд език" checked={f.english} onChange={(english) => setF({ ...f, english })} />}
        </>
      }
    >
      {(d) => <LedgerTable d={d} name={name} />}
    </ReportFrame>
  );
}

type LedgerRow = [kind: 'group' | 'counter' | 'total' | 'opening' | 'closing', g: Group, c?: Group['counters'][number]];

/** The groups as one row list (heading, counter accounts, total, balances), windowed on screen. */
function LedgerTable({ d, name }: { d: Group[]; name: (r: { description: string; englishDescription?: string }) => string }) {
  const rows = useMemo(() => {
    const out: LedgerRow[] = [];
    for (const g of d) {
      out.push(['group', g]);
      for (const c of g.counters) out.push(['counter', g, c]);
      out.push(['total', g]);
      if (g.balances) out.push(['opening', g], ['closing', g]);
    }
    return out;
  }, [d]);
  const row = (i: number) => {
    const [kind, g, c] = rows[i]!;
    if (kind === 'group')
      return (
        <tr key={`g${g.number}`} className="grp">
          <td className="nowrap text-brand-700">{g.number}</td>
          <td colSpan={3} className="text-brand-700">
            {name(g)}
          </td>
        </tr>
      );
    if (kind === 'counter')
      return (
        <tr key={`c${g.number}:${c!.number}`}>
          <td className="nowrap pl-6!">{c!.number}</td>
          <td className="max-w-[32rem] truncate">{name(c!)}</td>
          <Amt v={c!.debit} />
          <Amt v={c!.credit} />
        </tr>
      );
    if (kind === 'total')
      return (
        <tr key={`t${g.number}`} className="font-semibold">
          <td colSpan={2} className="text-right">
            Общо за {g.number}
          </td>
          <Amt v={g.totalDebit} className="border-t border-t-slate-400" />
          <Amt v={g.totalCredit} className="border-t border-t-slate-400" />
        </tr>
      );
    const b = g.balances!;
    return (
      <tr key={`${kind}${g.number}`} className="text-slate-700">
        <td colSpan={2} className="text-right">
          {kind === 'opening' ? 'Начално салдо' : 'Крайно салдо'}
        </td>
        <Amt v={kind === 'opening' ? b.openingDebit : b.closingDebit} />
        <Amt v={kind === 'opening' ? b.openingCredit : b.closingCredit} />
      </tr>
    );
  };
  return (
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
        <VirtualRows count={rows.length} colSpan={4} row={row} />
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={2}>Общо</td>
          <Amt v={sum(d, (g) => g.totalDebit)} />
          <Amt v={sum(d, (g) => g.totalCredit)} />
        </tr>
      </tfoot>
    </table>
  );
}
