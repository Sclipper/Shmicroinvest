import { api, qs } from '../../api.ts';
import { bgDate, monthLabel } from '../../format.ts';
import { Field, Select, TextInput } from '../../components/ui.tsx';
import { AccountNumberPicker, Amt, PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell, useReportFilters } from '../../reports/common.tsx';

interface Row {
  id: number; number: string | null; name: string | null; documentName: string | null; documentNumber: string | null; documentDate: string | null;
  fromDate: string; toDate: string; amount: string; debitAccount: string; creditAccount: string; reference: string | null; term: string | null;
  lastProcessedMonth: string | null; processedAmount: string; remainingAmount: string; processedAmountByFinYear: string;
}
interface Data { rows: Row[]; totals: { amount: string; processedAmount: string; remainingAmount: string; processedAmountByFinYear: string } }

const SORTS: [string, string][] = [
  ['number', 'Номер'], ['name', 'Наименование'], ['startDate', 'Към дата'], ['documentDate', 'Дата на документа'], ['processed', 'Начислени'], ['remaining', 'Остатъчна стойност'],
];
const HEAD = ['Номер', 'Наименование', 'Тип документ', 'Документ №', 'Дата на документ', 'От дата', 'До дата', 'Стойност', 'Дебит', 'Кредит', 'Към месец', 'Начислени', 'Остатъчна стойност', 'Начислени текуща година', 'Забележка'];

/** Справка "Разсрочване на приходи и разходи" (spec 05 7.7, spAccountingReschedulesReport). */
export function ReschedulesReport() {
  const period = useYearPeriod();
  const [f, setF] = useReportFilters('reschedules', { ...period, number: '', name: '', debit: '', credit: '', reference: '', sort: 'number' });
  const report = useReport('reschedules', f, (x) => api.get<Data>(`/reports/reschedules${qs({ from: x.from, to: x.to, number: x.number.trim(), name: x.name.trim(), debit: x.debit, credit: x.credit, reference: x.reference.trim(), sort: x.sort })}`), (x) =>
    x.from > x.to ? 'Началната дата на периода е след крайната дата.' : null,
  );
  const a = report.applied ?? f;
  // "Към месец": the last processed month up to the period end, or the start date when nothing is processed (spec 05 7.7).
  const asOf = (r: Row) => monthLabel(r.lastProcessedMonth ?? r.fromDate);

  const csv = (d: Data): Cell[][] => [
    HEAD,
    ...d.rows.map((r) => [r.number, r.name, r.documentName, r.documentNumber, bgDate(r.documentDate), bgDate(r.fromDate), bgDate(r.toDate), amt(r.amount), r.debitAccount, r.creditAccount, asOf(r), amt(r.processedAmount), amt(r.remainingAmount), amt(r.processedAmountByFinYear), r.reference ?? r.term]),
    ['Общо:', '', '', '', '', '', '', amt(d.totals.amount), '', '', '', amt(d.totals.processedAmount), amt(d.totals.remainingAmount), amt(d.totals.processedAmountByFinYear), ''],
  ];

  return (
    <ReportFrame<Data>
      title="Разсрочване на приходи и разходи"
      subtitle={periodText(a)}
      report={report}
      isEmpty={(d) => d.rows.length === 0}
      status={(d) => `${d.rows.length} картона`}
      csvName={`Разсрочване_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Номер">
            <TextInput className="w-24" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
          </Field>
          <Field label="Наименование">
            <TextInput className="w-48" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Сметка дебит">
            <AccountNumberPicker value={f.debit} onChange={(debit) => setF({ ...f, debit })} className="w-56" />
          </Field>
          <Field label="Сметка кредит">
            <AccountNumberPicker value={f.credit} onChange={(credit) => setF({ ...f, credit })} className="w-56" />
          </Field>
        </>
      }
      options={
        <>
          <Field label="Забележка">
            <TextInput className="w-56" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </Field>
          <Field label="Сортиране">
            <Select className="w-44" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}>
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
        </>
      }
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>
              {HEAD.map((h, i) => <th key={h} className={[7, 11, 12, 13].includes(i) ? 'w-28 text-right' : undefined}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.number}</td>
                <td className="max-w-56 truncate" title={r.name ?? ''}>{r.name}</td>
                <td>{r.documentName}</td>
                <td>{r.documentNumber}</td>
                <td className="nowrap">{bgDate(r.documentDate)}</td>
                <td className="nowrap">{bgDate(r.fromDate)}</td>
                <td className="nowrap">{bgDate(r.toDate)}</td>
                <Amt v={r.amount} />
                <td>{r.debitAccount}</td>
                <td>{r.creditAccount}</td>
                <td className="nowrap">{asOf(r)}</td>
                <Amt v={r.processedAmount} />
                <Amt v={r.remainingAmount} />
                <Amt v={r.processedAmountByFinYear} />
                <td className="max-w-48 truncate">{r.reference ?? r.term}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7}>Общо:</td>
              <Amt v={d.totals.amount} />
              <td colSpan={3} />
              <Amt v={d.totals.processedAmount} />
              <Amt v={d.totals.remainingAmount} />
              <Amt v={d.totals.processedAmountByFinYear} />
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}
