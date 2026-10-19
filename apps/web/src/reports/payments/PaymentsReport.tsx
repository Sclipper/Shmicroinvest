import { api, qs } from '../../api.ts';
import { PartnerPicker } from '../../components/pickers.tsx';
import { Field, Select, TextInput } from '../../components/ui.tsx';
import { bgDate } from '../../format.ts';
import { AccountNumberPicker, Amt, PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell, useReportFilters } from '../common.tsx';
import { DocumentTypeSelect, usePartnerAccountFilter } from './shared.tsx';

interface Row {
  id: number; accountNumber: string; partnerName: string; partnerBulstat: string;
  refAccountingNumber: string; refAccountingDate: string; refAccountingDocumentType: string; refAccountingDocumentNumber: string; refAccountingDocumentDate: string;
  refAccountingAmount: string; refAccountingReference: string; refAccountingTerm: string;
  paymentAccountingNumber: string; paymentAccountingDate: string; paymentAccountingDocumentType: string; paymentAccountingDocumentNumber: string; paymentAccountingDocumentDate: string;
  paymentAmount: string; paymentAccountingReference: string; paymentAccountingTerm: string;
}

const SORTS: [string, string][] = [['Partner', 'Партньор'], ['RefDocumentDate', 'Дата на документа'], ['RefDocumentNumber', 'Номер на документа'], ['PaymentDate', 'Дата на плащане']];

/** Разплащания и обвързани документи (spec 05 7.7): one row per payment allocation. */
export function PaymentsReport() {
  const period = useYearPeriod();
  const accFilter = usePartnerAccountFilter();
  const [f, setF] = useReportFilters('paymentsReport', { ...period, companyId: null as number | null, companyName: '', account: '', documentTypeId: null as number | null, documentNumber: '', fromAmount: '', toAmount: '', term: '', sort: 'Partner' });
  const report = useReport('paymentsReport', f, (x) =>
    api.get<Row[]>(`/reports/payments${qs({ from: x.from, to: x.to, companyId: x.companyId, account: x.account, documentTypeId: x.documentTypeId, documentNumber: x.documentNumber, fromAmount: x.fromAmount.replace(',', '.'), toAmount: x.toAmount.replace(',', '.'), term: x.term, sort: x.sort })}`),
  (x) => [x.fromAmount, x.toAmount].some((v) => v && Number.isNaN(Number(v.replace(',', '.')))) ? 'Невалидна сума.' : null);
  const a = report.applied ?? f;
  const subtitle = [periodText(a), a.account && `сметка ${a.account}`, a.companyId && `партньор ${a.companyName}`].filter(Boolean).join(', ');
  const headers = ['Док-т за задължение/вземане контиране', 'Тип на документа', 'Партньор', 'ЕИК / ДДС №', 'Документ №', 'Дата', 'Сума', 'Забележка', 'Основание', 'Док-т за плащане контиране №', 'Тип на документа', 'Документ №', 'Дата', 'Сума', 'Забележка на док-т за разплащане', 'Основание на док-т за разплащане'];
  const csv = (d: Row[]): Cell[][] => [
    headers,
    ...d.map((r) => [r.refAccountingNumber, r.refAccountingDocumentType, r.partnerName, r.partnerBulstat, r.refAccountingDocumentNumber, bgDate(r.refAccountingDocumentDate), amt(r.refAccountingAmount), r.refAccountingReference, r.refAccountingTerm,
      r.paymentAccountingNumber, r.paymentAccountingDocumentType, r.paymentAccountingDocumentNumber, bgDate(r.paymentAccountingDocumentDate), amt(r.paymentAmount), r.paymentAccountingReference, r.paymentAccountingTerm]),
  ];
  return (
    <ReportFrame<Row[]>
      title="Разплащания и обвързани документи"
      subtitle={subtitle}
      report={report}
      isEmpty={(d) => d.length === 0}
      status={(d) => `${d.length} връзки`}
      csvName={`Обвързани документи_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-56" />
          </Field>
          <Field label="Сметка">
            <AccountNumberPicker value={f.account} onChange={(account) => setF({ ...f, account })} filter={accFilter} className="w-56" />
          </Field>
          <DocumentTypeSelect value={f.documentTypeId} onChange={(documentTypeId) => setF({ ...f, documentTypeId })} />
          <Field label="Документ №">
            <TextInput value={f.documentNumber} onChange={(e) => setF({ ...f, documentNumber: e.target.value })} className="w-28" />
          </Field>
          <Field label="От сума">
            <TextInput value={f.fromAmount} onChange={(e) => setF({ ...f, fromAmount: e.target.value })} className="w-24 text-right" />
          </Field>
          <Field label="До сума">
            <TextInput value={f.toAmount} onChange={(e) => setF({ ...f, toAmount: e.target.value })} className="w-24 text-right" />
          </Field>
          <Field label="Основание">
            <TextInput value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} className="w-40" />
          </Field>
          <Field label="Сортиране">
            <Select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} className="w-40">
              {SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
        </>
      }
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr className="hdr1">
              <th colSpan={9} className="text-center">Документ за задължение/вземане</th>
              <th colSpan={7} className="text-center">Документ за плащане</th>
            </tr>
            <tr className="hdr2">
              <th>Контиране</th>
              <th>Тип</th>
              <th>Партньор</th>
              <th>ЕИК / ДДС №</th>
              <th>Документ №</th>
              <th>Дата</th>
              <th className="text-right">Сума</th>
              <th>Забележка</th>
              <th>Основание</th>
              <th>Контиране №</th>
              <th>Тип</th>
              <th>Документ №</th>
              <th>Дата</th>
              <th className="text-right">Сума</th>
              <th>Забележка</th>
              <th>Основание</th>
            </tr>
          </thead>
          <tbody>
            {d.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{r.refAccountingNumber}</td>
                <td>{r.refAccountingDocumentType}</td>
                <td className="max-w-[14rem] truncate" title={r.partnerName}>{r.partnerName}</td>
                <td className="nowrap">{r.partnerBulstat}</td>
                <td className="nowrap">{r.refAccountingDocumentNumber}</td>
                <td className="nowrap">{bgDate(r.refAccountingDocumentDate)}</td>
                <Amt v={r.refAccountingAmount} />
                <td className="max-w-[8rem] truncate">{r.refAccountingReference}</td>
                <td className="max-w-[10rem] truncate" title={r.refAccountingTerm}>{r.refAccountingTerm}</td>
                <td className="nowrap">{r.paymentAccountingNumber}</td>
                <td>{r.paymentAccountingDocumentType}</td>
                <td className="nowrap">{r.paymentAccountingDocumentNumber}</td>
                <td className="nowrap">{bgDate(r.paymentAccountingDocumentDate)}</td>
                <Amt v={r.paymentAmount} />
                <td className="max-w-[8rem] truncate">{r.paymentAccountingReference}</td>
                <td className="max-w-[10rem] truncate" title={r.paymentAccountingTerm}>{r.paymentAccountingTerm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportFrame>
  );
}
