import { Fragment, useState } from 'react';
import { DOC_CHANNEL } from '@shmi/core';
import { api } from '../../api.ts';
import { Field, Select } from '../../components/ui.tsx';
import { bgDate } from '../../format.ts';
import { Amt, PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell } from '../../reports/common.tsx';

/** "Дублирани и липсващи документи" (UI_Reporting_Validation_AccountingsValidation; spec 05 7.7, 04a 1.12). */

interface Dup {
  channel: string;
  documentNumber: string;
  rows: { accountingId: number; accountingNumber: string; documentTypeName: string; documentNumber: string; documentDate: string; partnerName: string; amount: string; transactionType: string }[];
}
interface Result {
  missing: { channel: string; documentNumber: string }[];
  duplicated: Dup[];
}

export function DocumentValidation() {
  const [f, setF] = useState({ ...useYearPeriod(), reportType: 0, channel: '' });
  const report = useReport('vatValidation', f, (x) => api.post<Result>('/vat/validation', { from: x.from, to: x.to, reportType: x.reportType, channel: x.channel || undefined }));
  const a = report.applied ?? f;
  const csv = (d: Result): Cell[][] => [
    ['Липсващи документи'], ['Тип документ', 'Номер'], ...d.missing.map((m) => [m.channel, m.documentNumber]), [],
    ['Дублирани документи'], ['Партньор', 'Номер', 'Тип документ', 'Дата', 'Контиране', 'Сума', 'Тип на сделката'],
    ...d.duplicated.flatMap((g) => g.rows.map((r) => [r.partnerName, r.documentNumber, r.documentTypeName, bgDate(r.documentDate), r.accountingNumber, amt(r.amount), r.transactionType])),
  ];
  return (
    <ReportFrame<Result>
      title="Дублирани и липсващи документи"
      subtitle={periodText(a)}
      report={report}
      isEmpty={(d) => !d.missing.length && !d.duplicated.length}
      status={(d) => `${d.missing.length} липсващи, ${d.duplicated.length} групи дублирани`}
      csvName={`ДублираниЛипсващиДок-ти_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Тип справка">
            <Select value={f.reportType} onChange={(e) => setF({ ...f, reportType: Number(e.target.value) })}>
              <option value={0}>Всички</option>
              <option value={1}>Дублирани</option>
              <option value={2}>Липсващи</option>
            </Select>
          </Field>
          <Field label="Тип документ">
            <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
              <option value="">Всички</option>
              {Object.values(DOC_CHANNEL).map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
        </>
      }
    >
      {(d) => (
        <div className="flex flex-col gap-4 p-3">
          {a.reportType !== 1 && (
            <section>
              <h3 className="mb-1 font-semibold">Липсващи документи</h3>
              <table className="grid-table max-w-xl">
                <thead><tr><th>Тип документ</th><th>Номер на документ</th></tr></thead>
                <tbody>
                  {d.missing.map((m, i) => <tr key={i}><td>{m.channel}</td><td>{m.documentNumber}</td></tr>)}
                  {!d.missing.length && <tr><td colSpan={2} className="text-center text-slate-500">Няма липсващи документи.</td></tr>}
                </tbody>
              </table>
            </section>
          )}
          {a.reportType !== 2 && (
            <section>
              <h3 className="mb-1 font-semibold">Дублирани документи</h3>
              <table className="grid-table">
                <thead><tr><th>Партньор</th><th>Номер на документ</th><th>Тип документ</th><th>Дата на документ</th><th>Номер на контиране</th><th className="text-right">Сума</th><th>Тип на сделката</th></tr></thead>
                <tbody>
                  {d.duplicated.map((g, i) => (
                    <Fragment key={i}>
                      <tr className="grp"><td colSpan={7}>{g.channel}: № {g.documentNumber}</td></tr>
                      {g.rows.map((r) => (
                        <tr key={`${i}-${r.accountingId}`}>
                          <td>{r.partnerName}</td><td>{r.documentNumber}</td><td>{r.documentTypeName}</td><td>{bgDate(r.documentDate)}</td><td>{r.accountingNumber}</td><Amt v={r.amount} /><td>{r.transactionType}</td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  {!d.duplicated.length && <tr><td colSpan={7} className="text-center text-slate-500">Няма дублирани документи.</td></tr>}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </ReportFrame>
  );
}
