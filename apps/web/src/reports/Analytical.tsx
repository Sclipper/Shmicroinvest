import { useState } from 'react';
import { api, qs } from '../api.ts';
import { bgDate, money } from '../format.ts';
import { PartnerPicker } from '../components/pickers.tsx';
import { Checkbox, Field, TextInput } from '../components/ui.tsx';
import { useWorkspace } from '../shell/workspace.tsx';
import type { JournalLine } from './Chronological.tsx';
import { AccountNumberPicker, Amt, PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell } from './common.tsx';

interface Balances {
  openingDebit: string;
  openingCredit: string;
  debitTurnover: string;
  creditTurnover: string;
  closingDebit: string;
  closingCredit: string;
}
interface Line extends JournalLine {
  balanceDebit: string;
  balanceCredit: string;
}
interface Result {
  accountDescription: string;
  opening: Balances;
  lines: Line[];
  turnover: { debit: string; credit: string };
  closing: { debit: string; credit: string };
}

/** Аналитичен регистър / карта на сметка (spec 05 4.2). */
export function Analytical() {
  const ws = useWorkspace();
  const period = useYearPeriod();
  const [f, setF] = useState({ ...period, account: '', withSub: true, byExportMonth: false, companyId: null as number | null, companyName: '' as string | null, text: '' });
  const [sel, setSel] = useState<number | null>(null);
  const report = useReport(
    'analytical',
    f,
    (x) => api.get<Result>(`/reports/analytical${qs({ from: x.from, to: x.to, account: x.account, sub: x.withSub ? undefined : '0', byExportMonth: x.byExportMonth, companyId: x.companyId, text: x.text.trim() })}`),
    (x) => (x.account ? null : 'Не е избрана сметка.'),
  );
  const a = report.applied ?? f;
  const subtitle = [periodText(a), a.withSub ? 'с подсметките' : 'без подсметките', a.companyId && `партньор ${a.companyName}`].filter(Boolean).join(', ');
  const open = (l: Line) => ws.open('entry', { key: `entry:${l.accountingId}`, title: `Контиране ${l.number}`, params: { id: l.accountingId } });

  const csv = (d: Result): Cell[][] => [
    [`Сметка ${a.account} ${d.accountDescription}`],
    [],
    ['Контиране', 'Дата', 'Дебит сметка', 'Дебит', 'Кредит сметка', 'Кредит', 'Сума', 'Салдо Дебит', 'Салдо Кредит', 'Партньор', 'Док. вид', 'Док. дата', 'Документ №', 'Основание', 'Забележка'],
    ['Начално салдо', '', '', '', '', '', '', amt(d.opening.openingDebit), amt(d.opening.openingCredit)],
    ...d.lines.map((l) => [l.number, bgDate(l.accountingDate), l.debitAccount, l.debitDescription, l.creditAccount, l.creditDescription, amt(l.amount), amt(l.balanceDebit), amt(l.balanceCredit), l.companyName, l.documentType, bgDate(l.documentDate), l.documentNumber, l.term, l.reference]),
    ['Оборот', '', '', '', '', '', '', amt(d.turnover.debit), amt(d.turnover.credit)],
    ['Крайно салдо', '', '', '', '', '', '', amt(d.closing.debit), amt(d.closing.credit)],
  ];

  return (
    <ReportFrame<Result>
      title="Аналитичен регистър"
      subtitle={subtitle}
      report={report}
      // The card is meaningful even without movements (opening balance only).
      isEmpty={() => false}
      status={(d) => `${d.lines.length} записа`}
      csvName={`АРег_${a.account.replace(/\//g, '-')}_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Сметка *">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} className="w-72" />
          </Field>
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-60" />
          </Field>
          <Field label="Филтър" className="min-w-40 flex-1">
            <TextInput value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="номер, основание, документ, партньор, сума" />
          </Field>
        </>
      }
      options={
        <>
          <Checkbox label="С подсметките" checked={f.withSub} onChange={(withSub) => setF({ ...f, withSub })} />
          <Checkbox label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />
        </>
      }
    >
      {(d) => (
        <>
          <div className="border-b border-slate-200 bg-white px-3 py-1.5 text-[13px]">
            Сметка <span className="font-semibold">{a.account}</span> {d.accountDescription}
          </div>
          <table className="grid-table">
            <thead>
              <tr>
                <th>Контиране</th>
                <th>Дата</th>
                <th>Дебит</th>
                <th>Кредит</th>
                <th className="text-right">Сума</th>
                <th className="text-right">Салдо Дебит</th>
                <th className="text-right">Салдо Кредит</th>
                <th>Партньор</th>
                <th>Документ</th>
                <th>№ док.</th>
                <th>Дата док.</th>
                <th>Основание</th>
              </tr>
            </thead>
            <tbody>
              <tr className="grp">
                <td colSpan={5}>Начално салдо</td>
                <Amt v={d.opening.openingDebit} />
                <Amt v={d.opening.openingCredit} />
                <td colSpan={5} />
              </tr>
              {d.lines.map((l) => (
                <tr key={l.detailId} aria-selected={sel === l.detailId} onClick={() => setSel(l.detailId)} onDoubleClick={() => open(l)} className="cursor-default">
                  <td className="font-medium">{l.number}</td>
                  <td className="nowrap">{bgDate(l.accountingDate)}</td>
                  <td className="nowrap" title={l.debitDescription}>
                    {l.debitAccount}
                  </td>
                  <td className="nowrap" title={l.creditDescription}>
                    {l.creditAccount}
                  </td>
                  <td className="num">{money(l.amount)}</td>
                  <Amt v={l.balanceDebit} />
                  <Amt v={l.balanceCredit} />
                  <td className="max-w-56 truncate">{l.companyName}</td>
                  <td>{l.documentType}</td>
                  <td>{l.documentNumber}</td>
                  <td className="nowrap">{bgDate(l.documentDate)}</td>
                  <td className="max-w-72 truncate" title={l.reference || l.term}>
                    {l.term}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="ft1">
                <td colSpan={5}>Оборот</td>
                <Amt v={d.turnover.debit} />
                <Amt v={d.turnover.credit} />
                <td colSpan={5} />
              </tr>
              <tr className="ft1">
                <td colSpan={5}>Крайно салдо</td>
                <Amt v={d.closing.debit} />
                <Amt v={d.closing.credit} />
                <td colSpan={5} />
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </ReportFrame>
  );
}
