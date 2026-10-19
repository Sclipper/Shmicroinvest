import { api, qs } from '../../api.ts';
import { PartnerPicker } from '../../components/pickers.tsx';
import { Field, Select, TextInput } from '../../components/ui.tsx';
import { bgDate } from '../../format.ts';
import { Amt, PeriodFields, ReportFrame, amt, periodText, useReport, useYearPeriod, type Cell, useReportFilters } from '../../reports/common.tsx';
import { useLookups } from '../../session.tsx';

/** "Протоколи по чл. 117 от ЗДДС" (UI_Reporting_ICAReport, spICAReport; spec 05 7.6). */

interface Row {
  accountingId: number;
  accountingNumber: string;
  documentDate: string;
  documentType: string;
  documentNumber: string;
  companyName: string;
  amount: string;
  term: string;
  reference: string;
  icaDate: string;
  icaNumber: string;
  icaAmount: string;
  icaTermDesc: string;
  icaRefDesc: string;
  purchaseVat: string;
  saleVat: string;
  icaType: string;
}

const TYPES: [number, string][] = [
  [0, 'Всички'], [1, 'ВОП'], [2, 'Получена услуга от ЕС'], [3, 'Туристически услуги/стоки втора употреба'], [4, 'Доставка по чл. 163а от ЗДДС'],
  [5, 'Внос по чл. 167а от ЗДДС'], [6, 'Режим складиране на стоки до поискване'], [7, 'Получена услуга от трета страна'], [8, 'ВОП - хляб и брашно'], [9, 'Доставка/внос на хляб и брашно'],
];

const HEADERS = ['Номер на контиране', 'Дата на документа', 'Тип на документа', 'Номер на документа', 'Партньор', 'Сума на документа', 'Основание на документа', 'Забележка на документа', 'Дата на протокола', 'Номер на протокола', 'Стойност на протокола', 'Тип на операцията', 'Основание на протокола', 'Забележка на протокола', 'Тип на сделката Покупка', 'Тип на сделката Продажба'];

export function IcaReport() {
  const lookups = useLookups();
  const [f, setF] = useReportFilters('icaReport', { ...useYearPeriod(), companyId: null as number | null, companyName: '' as string | null, documentTypeId: 0, documentNumber: '', icaType: 0 });
  const report = useReport('icaReport', f, (x) =>
    api.get<{ rows: Row[] }>(`/vat/ica-report${qs({ from: x.from, to: x.to, companyId: x.companyId, documentTypeId: x.documentTypeId || undefined, documentNumber: x.documentNumber, icaType: x.icaType || undefined })}`),
  );
  const a = report.applied ?? f;
  const csv = (d: { rows: Row[] }): Cell[][] => [
    HEADERS,
    ...d.rows.map((r) => [r.accountingNumber, bgDate(r.documentDate), r.documentType, r.documentNumber, r.companyName, amt(r.amount), r.term, r.reference, bgDate(r.icaDate), r.icaNumber, amt(r.icaAmount), r.icaType, r.icaTermDesc, r.icaRefDesc, r.purchaseVat, r.saleVat]),
  ];
  const docTypes = (lookups.data?.documentTypes ?? []).filter((t) => [1, 2, 3, 4].includes(t.id));
  return (
    <ReportFrame<{ rows: Row[] }>
      title="Протоколи по чл. 117 от ЗДДС"
      subtitle={periodText(a)}
      report={report}
      isEmpty={(d) => d.rows.length === 0}
      status={(d) => `${d.rows.length} протокола`}
      csvName={`ПротоколиЗДДС_${a.from}_${a.to}`}
      csv={csv}
      filters={
        <>
          <PeriodFields value={f} onChange={(p) => setF({ ...f, ...p })} />
          <Field label="Партньор">
            <PartnerPicker value={f.companyId} valueName={f.companyName} onChange={(p) => setF({ ...f, companyId: p?.id ?? null, companyName: p?.name ?? '' })} className="w-56" />
          </Field>
          <Field label="Тип документ">
            <Select value={f.documentTypeId} onChange={(e) => setF({ ...f, documentTypeId: Number(e.target.value) })}>
              <option value={0}>Всички</option>
              {docTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Документ №">
            <TextInput className="w-32" value={f.documentNumber} onChange={(e) => setF({ ...f, documentNumber: e.target.value })} />
          </Field>
          <Field label="Тип операция">
            <Select value={f.icaType} onChange={(e) => setF({ ...f, icaType: Number(e.target.value) })}>
              {TYPES.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </Select>
          </Field>
        </>
      }
    >
      {(d) => (
        <table className="grid-table">
          <thead>
            <tr>
              {HEADERS.map((h, i) => (
                <th key={h} className={[5, 10].includes(i) ? 'text-right' : undefined}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={`${r.accountingId}-${r.icaNumber}`}>
                <td>{r.accountingNumber}</td>
                <td className="nowrap">{bgDate(r.documentDate)}</td>
                <td>{r.documentType}</td>
                <td>{r.documentNumber}</td>
                <td className="max-w-[14rem] truncate">{r.companyName}</td>
                <Amt v={r.amount} />
                <td className="max-w-[12rem] truncate">{r.term}</td>
                <td>{r.reference}</td>
                <td className="nowrap">{bgDate(r.icaDate)}</td>
                <td>{r.icaNumber}</td>
                <Amt v={r.icaAmount} />
                <td>{r.icaType}</td>
                <td className="max-w-[12rem] truncate">{r.icaTermDesc}</td>
                <td>{r.icaRefDesc}</td>
                <td className="max-w-[12rem] truncate" title={r.purchaseVat}>{r.purchaseVat}</td>
                <td className="max-w-[12rem] truncate" title={r.saleVat}>{r.saleVat}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportFrame>
  );
}
