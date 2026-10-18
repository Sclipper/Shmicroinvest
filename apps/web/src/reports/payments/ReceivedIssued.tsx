import { useState } from 'react';
import { api, qs } from '../../api.ts';
import { PartnerPicker } from '../../components/pickers.tsx';
import { Checkbox, Field, Select, TextInput } from '../../components/ui.tsx';
import { bgDate, monthLabel } from '../../format.ts';
import { useLookups } from '../../session.tsx';
import { Amt, PeriodFields, ReportFrame, amt, periodText, sum, useReport, useYearPeriod, type Cell } from '../common.tsx';
import { DocumentTypeSelect } from './shared.tsx';

interface Row {
  accountingId: number; accountingNumber: string; accountingDate: string; debitNumber: string; creditNumber: string;
  docDate: string; docType: string; docNumber: string; company: string; taxBase: string; vatAmount: string; amount: string;
  term: string; deal: string; viesMonth: string; vatTerm: string; reference: string; optionalReference: string;
}

const SORTS: [string, string][] = [['DocumentNumber', 'Номер на документ'], ['DocumentDate', 'Дата на документ'], ['AccountingDate', 'Дата на контиране'], ['AccountingNumber', 'Номер на контиране'], ['ViesMonth', 'Месец за експорт']];

/** Получени и издадени документи (spec 05 7.7): purchases and sales by document with VAT split. */
export function ReceivedIssued() {
  const period = useYearPeriod();
  const { data: lookups } = useLookups();
  const [f, setF] = useState({ ...period, byExportMonth: false, companyId: null as number | null, companyName: '', documentTypeId: null as number | null, documentNumber: '', transactionTypeId: 0, vatTermId: 0, sort: 'DocumentNumber' });
  const report = useReport('receivedIssued', f, (x) =>
    api.get<Row[]>(`/reports/received-issued${qs({ from: x.from, to: x.to, byExportMonth: x.byExportMonth, companyId: x.companyId, documentTypeId: x.documentTypeId, documentNumber: x.documentNumber, transactionTypeId: x.transactionTypeId || null, vatTermId: x.vatTermId || null, sort: x.sort })}`),
  );
  const a = report.applied ?? f;
  const subtitle = [periodText(a), a.companyId && `партньор ${a.companyName}`].filter(Boolean).join(', ');
  const headers = ['Дата', 'Тип на документ', 'Документ №', 'Партньор', 'Данъчна основа', 'ДДС', 'Сума', 'Основание', 'Сделка', 'Операция по ДДС', 'Месец за експорт', 'Забележка', 'Втора забележка'];
  const csv = (d: Row[]): Cell[][] => [
    headers,
    ...d.map((r) => [bgDate(r.docDate), r.docType, r.docNumber, r.company, amt(r.taxBase), amt(r.vatAmount), amt(r.amount), r.term, r.deal, r.vatTerm, monthLabel(r.viesMonth), r.reference, r.optionalReference]),
    ['Общо:', '', '', '', sum(d, (r) => r.taxBase), sum(d, (r) => r.vatAmount), sum(d, (r) => r.amount)],
    [], ['Главен счетоводител: ........................................'],
  ];
  return (
    <ReportFrame<Row[]>
      title="Получени и издадени документи"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} документа`}
      csvName={`Получени и издадени_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-56" />
          </Field>
          <DocumentTypeSelect value={f.documentTypeId} onChange={(documentTypeId) => setF({ ...f, documentTypeId })} />
          <Field label="Документ №">
            <TextInput value={f.documentNumber} onChange={(e) => setF({ ...f, documentNumber: e.target.value })} className="w-28" />
          </Field>
          <Field label="Сделка">
            <Select value={f.transactionTypeId} onChange={(e) => setF({ ...f, transactionTypeId: Number(e.target.value) })} className="w-36">
              <option value={0}>Всички</option>
              {(lookups?.transactionTypes ?? []).map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}
            </Select>
          </Field>
          <Field label="Операция по ДДС">
            <Select value={f.vatTermId} onChange={(e) => setF({ ...f, vatTermId: Number(e.target.value) })} className="w-64">
              <option value={0}>Всички</option>
              <option value={19}>Всички операции по продажби</option>
              <option value={20}>Всички операции по покупки</option>
              {(lookups?.vatTerms ?? []).filter((t) => t.id > 1).map((t) => <option key={t.id} value={t.id}>{t.description}</option>)}
            </Select>
          </Field>
          <Field label="Сортиране">
            <Select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} className="w-40">
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
        </>
      }
      options={<Checkbox label="С отчитане на месец за експорт" checked={f.byExportMonth} onChange={(byExportMonth) => setF({ ...f, byExportMonth })} />}
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>
              {headers.map((h, i) => <th key={h} className={i >= 4 && i <= 6 ? 'w-28 text-right' : undefined}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {d.map((r) => (
              <tr key={r.accountingId}>
                <td className="nowrap">{bgDate(r.docDate)}</td>
                <td>{r.docType}</td>
                <td className="nowrap">{r.docNumber}</td>
                <td className="max-w-[18rem] truncate" title={r.company}>{r.company}</td>
                <Amt v={r.taxBase} />
                <Amt v={r.vatAmount} />
                <Amt v={r.amount} />
                <td className="max-w-[14rem] truncate" title={r.term}>{r.term}</td>
                <td>{r.deal}</td>
                <td className="max-w-[14rem] truncate" title={r.vatTerm}>{r.vatTerm}</td>
                <td className="nowrap">{monthLabel(r.viesMonth)}</td>
                <td className="max-w-[10rem] truncate">{r.reference}</td>
                <td className="max-w-[10rem] truncate">{r.optionalReference}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4}>Общо:</td>
              <Amt v={sum(d, (r) => r.taxBase)} />
              <Amt v={sum(d, (r) => r.vatAmount)} />
              <Amt v={sum(d, (r) => r.amount)} />
              <td colSpan={6} />
            </tr>
          </tfoot>
        </table>
      )}
    </ReportFrame>
  );
}
